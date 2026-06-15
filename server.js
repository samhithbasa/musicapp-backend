const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execFile, execSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Dynamically ensure yt-dlp binary exists on startup for both Windows and Linux (Render)
function ensureYtdlp() {
  const isWindows = process.platform === 'win32';
  const binaryName = isWindows ? 'yt-dlp.exe' : 'yt-dlp';
  const localPath = path.join(__dirname, binaryName);

  if (fs.existsSync(localPath)) {
    return localPath;
  }

  console.log(`yt-dlp not found. Downloading latest binary for ${process.platform}...`);
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${binaryName}`;
  
  try {
    if (isWindows) {
      execSync(`powershell -Command "Invoke-WebRequest -Uri '${url}' -OutFile '${localPath}' -UseBasicParsing"`);
    } else {
      execSync(`curl -L "${url}" -o "${localPath}" && chmod +x "${localPath}"`);
    }
    console.log(`Successfully downloaded yt-dlp to: ${localPath}`);
  } catch (err) {
    console.error('Failed to download yt-dlp automatically:', err.message);
  }
  return localPath;
}

const ytdlpPath = ensureYtdlp();

// Track active merge jobs to prevent concurrent merges of the same video
const activeJobs = new Map();

// GET /status?videoId=xxx
app.get('/status', (req, res) => {
  const { videoId } = req.query;
  if (!videoId) {
    return res.status(400).json({ error: 'Missing videoId' });
  }

  const finalPath = path.join(TEMP_DIR, `${videoId}_1080p.mp4`);
  if (fs.existsSync(finalPath)) {
    return res.json({ status: 'ready', url: `/stream?videoId=${videoId}` });
  }

  if (activeJobs.has(videoId)) {
    const job = activeJobs.get(videoId);
    if (job.error) {
      return res.json({ status: 'error', error: job.error });
    }
    return res.json({ status: 'preparing', progress: job.progress });
  }

  return res.json({ status: 'idle' });
});

// POST /prepare
app.post('/prepare', async (req, res) => {
  const { videoId } = req.body;
  if (!videoId) {
    return res.status(400).json({ error: 'Missing videoId' });
  }

  const finalPath = path.join(TEMP_DIR, `${videoId}_1080p.mp4`);
  if (fs.existsSync(finalPath)) {
    return res.json({ status: 'ready', url: `/stream?videoId=${videoId}` });
  }

  if (activeJobs.has(videoId)) {
    const job = activeJobs.get(videoId);
    if (job.error) {
      // Retry if previous attempt failed
      activeJobs.delete(videoId);
    } else {
      return res.json({ status: 'preparing' });
    }
  }

  // Check yt-dlp binary exists
  if (!fs.existsSync(ytdlpPath)) {
    return res.status(500).json({ error: 'yt-dlp binary not found. Place yt-dlp.exe in the backend directory.' });
  }

  // Start merge in background
  activeJobs.set(videoId, { progress: 'Starting download...', error: null });
  
  res.json({ status: 'preparing' });

  // Run the merging task in background
  runMergeJob(videoId).catch(err => {
    console.error(`Error in merge job for ${videoId}:`, err);
    activeJobs.set(videoId, { progress: 'Error', error: err.message });
  });
});

function runYtdlp(args) {
  return new Promise((resolve, reject) => {
    console.log(`Running yt-dlp with args: ${args.join(' ')}`);
    execFile(ytdlpPath, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        console.error('yt-dlp stderr:', stderr);
        return reject(new Error(`yt-dlp failed: ${stderr || err.message}`));
      }
      resolve(stdout);
    });
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log(`Running ffmpeg with args: ${args.join(' ')}`);
    execFile(ffmpegPath, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        console.error('ffmpeg stderr:', stderr);
        return reject(new Error(`ffmpeg failed: ${stderr || err.message}`));
      }
      resolve(stdout);
    });
  });
}

async function runMergeJob(videoId) {
  const videoTemp = path.join(TEMP_DIR, `${videoId}_video.mp4`);
  const audioTemp = path.join(TEMP_DIR, `${videoId}_audio.m4a`);
  const mergeTemp = path.join(TEMP_DIR, `${videoId}_1080p.mp4.tmp`);
  const finalPath = path.join(TEMP_DIR, `${videoId}_1080p.mp4`);

  try {
    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    
    // Step 1: Download best 1080p (or lower) video-only stream
    activeJobs.set(videoId, { progress: 'Downloading HD video stream...', error: null });
    console.log(`Downloading video for ${videoId}...`);
    
    await runYtdlp([
      '-f', 'bestvideo[height<=1080][ext=mp4]/bestvideo[height<=1080]/bestvideo[ext=mp4]/bestvideo',
      '-o', videoTemp,
      '--no-playlist',
      '--no-warnings',
      '--extractor-args', 'youtube:player_client=ios,android',
      youtubeUrl
    ]);

    // Step 2: Download best audio stream
    activeJobs.set(videoId, { progress: 'Downloading audio stream...', error: null });
    console.log(`Downloading audio for ${videoId}...`);

    await runYtdlp([
      '-f', 'bestaudio[ext=m4a]/bestaudio',
      '-o', audioTemp,
      '--no-playlist',
      '--no-warnings',
      '--extractor-args', 'youtube:player_client=ios,android',
      youtubeUrl
    ]);

    // Step 3: Merge using ffmpeg
    activeJobs.set(videoId, { progress: 'Merging streams with ffmpeg...', error: null });
    console.log(`Merging video and audio for ${videoId}...`);
    
    await runFfmpeg([
      '-y',
      '-i', videoTemp,
      '-i', audioTemp,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      mergeTemp
    ]);

    // Rename to final path only when completely finished and flushed to disk
    if (fs.existsSync(mergeTemp)) {
      fs.renameSync(mergeTemp, finalPath);
    } else {
      throw new Error('Merged output file not found after ffmpeg finished');
    }

    console.log(`Merge completed successfully for ${videoId}!`);
    activeJobs.delete(videoId);
  } catch (err) {
    console.error(`Failed to download/merge ${videoId}:`, err.message);
    activeJobs.set(videoId, { progress: 'Error', error: err.message });
    throw err;
  } finally {
    // Clean up temporary files
    try {
      if (fs.existsSync(videoTemp)) fs.unlinkSync(videoTemp);
      if (fs.existsSync(audioTemp)) fs.unlinkSync(audioTemp);
      if (fs.existsSync(mergeTemp)) fs.unlinkSync(mergeTemp);
    } catch (_) {}
  }
}

// GET /stream?videoId=xxx — serve the merged HD file with range support
app.get('/stream', (req, res) => {
  const { videoId } = req.query;
  if (!videoId) {
    return res.status(400).json({ error: 'Missing videoId' });
  }

  const finalPath = path.join(TEMP_DIR, `${videoId}_1080p.mp4`);
  if (!fs.existsSync(finalPath)) {
    return res.status(404).json({ error: 'HD video not ready or not found' });
  }

  const stat = fs.statSync(finalPath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    let start = parseInt(parts[0], 10);
    let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    // Check if start is valid
    if (isNaN(start) || start < 0) {
      start = 0;
    }
    if (isNaN(end) || end >= fileSize) {
      end = fileSize - 1;
    }

    if (start >= fileSize) {
      res.writeHead(416, {
        'Content-Range': `bytes */${fileSize}`,
        'Content-Type': 'video/mp4'
      });
      return res.end();
    }

    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    });
    
    const stream = fs.createReadStream(finalPath, { start, end });
    stream.on('error', (err) => {
      console.error('ReadStream error:', err);
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
    });
    const stream = fs.createReadStream(finalPath);
    stream.on('error', (err) => {
      console.error('ReadStream error:', err);
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
    stream.pipe(res);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`HD Video Merging Backend listening on port ${PORT}`);
  console.log(`Using yt-dlp at: ${ytdlpPath}`);
  console.log(`Using ffmpeg at: ${ffmpegPath}`);
});
