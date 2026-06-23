const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execFile, execSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const spotifyUrlInfo = require('spotify-url-info');
const { getTracks } = spotifyUrlInfo(fetch);

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
  const finalPath = path.join(TEMP_DIR, `${videoId}_1080p.mp4`);
  const ytdlpOutput = path.join(TEMP_DIR, `${videoId}_merged.mp4`);

  try {
    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const cookiesPath = path.join(__dirname, 'cookies.txt');
    const useCookies = fs.existsSync(cookiesPath);
    
    if (useCookies) {
      console.log('Using cookies.txt for YouTube authentication');
    }

    // Single-step: let yt-dlp download best video+audio and merge into mp4
    activeJobs.set(videoId, { progress: 'Downloading HD video & audio...', error: null });
    console.log(`Downloading and merging for ${videoId}...`);
    
    // Use yt-dlp's built-in merge — it picks the best available formats
    // and uses ffmpeg internally to mux them into mp4
    const args = [
      '-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
      '--merge-output-format', 'mp4',
      '-o', ytdlpOutput,
      '--no-playlist',
      '--no-warnings',
      '--js-runtimes', `node:${process.execPath}`,
      '--ffmpeg-location', ffmpegPath
    ];

    if (useCookies) {
      args.push('--cookies', cookiesPath);
    } else {
      // Only use mobile client when we don't have browser cookies
      args.push('--extractor-args', 'youtube:player_client=ios,android');
    }
    args.push(youtubeUrl);

    try {
      await runYtdlp(args);
    } catch (downloadErr) {
      // On format error, log available formats for debugging then retry with 'best'
      console.error(`First attempt failed for ${videoId}: ${downloadErr.message}`);
      console.log(`Listing available formats for ${videoId}...`);
      
      try {
        const listArgs = ['--list-formats', '--no-warnings'];
        if (useCookies) listArgs.push('--cookies', cookiesPath);
        listArgs.push(youtubeUrl);
        const formatList = await runYtdlp(listArgs);
        console.log(`Available formats for ${videoId}:\n${formatList}`);
      } catch (_) {
        console.log('Could not list formats');
      }

      // Retry with the most permissive format selector
      console.log(`Retrying ${videoId} with fallback format selector...`);
      activeJobs.set(videoId, { progress: 'Retrying with fallback format...', error: null });
      
      const fallbackArgs = [
        '-f', 'best[height<=1080]/best',
        '-o', ytdlpOutput,
        '--no-playlist',
        '--no-warnings',
        '--js-runtimes', `node:${process.execPath}`
      ];
      if (useCookies) {
        fallbackArgs.push('--cookies', cookiesPath);
      }
      fallbackArgs.push(youtubeUrl);
      
      await runYtdlp(fallbackArgs);
    }

    // yt-dlp might add .mp4 extension or the file might be at ytdlpOutput directly
    // Check for the output file
    let outputFile = null;
    if (fs.existsSync(ytdlpOutput)) {
      outputFile = ytdlpOutput;
    } else if (fs.existsSync(ytdlpOutput + '.mp4')) {
      outputFile = ytdlpOutput + '.mp4';
    } else {
      // Search for any file matching the pattern
      const tempFiles = fs.readdirSync(TEMP_DIR);
      const match = tempFiles.find(f => f.startsWith(`${videoId}_merged`));
      if (match) {
        outputFile = path.join(TEMP_DIR, match);
      }
    }

    if (!outputFile) {
      throw new Error('Downloaded file not found after yt-dlp completed');
    }

    // If the output isn't already mp4, re-mux with ffmpeg
    if (outputFile !== finalPath) {
      if (outputFile.endsWith('.mp4')) {
        // Already mp4, just rename
        fs.renameSync(outputFile, finalPath);
      } else {
        // Re-mux to mp4
        activeJobs.set(videoId, { progress: 'Converting to mp4...', error: null });
        console.log(`Re-muxing ${outputFile} to mp4...`);
        await runFfmpeg([
          '-y',
          '-i', outputFile,
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-movflags', '+faststart',
          finalPath
        ]);
        try { fs.unlinkSync(outputFile); } catch (_) {}
      }
    }

    console.log(`Merge completed successfully for ${videoId}!`);
    activeJobs.delete(videoId);
  } catch (err) {
    console.error(`Failed to download/merge ${videoId}:`, err.message);
    activeJobs.set(videoId, { progress: 'Error', error: err.message });
    throw err;
  } finally {
    // Clean up any leftover temp files for this videoId
    try {
      const tempFiles = fs.readdirSync(TEMP_DIR);
      for (const f of tempFiles) {
        if (f.startsWith(videoId) && !f.endsWith('_1080p.mp4')) {
          try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch (_) {}
        }
      }
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

// GET /spotify-playlist?url=xxx
app.get('/spotify-playlist', async (req, res) => {
  let { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  // Extract the actual URL from the text if a description is present
  const match = url.match(/(https?:\/\/[^\s]+)/);
  if (match) {
    url = match[1];
  }

  try {
    console.log(`Fetching Spotify playlist tracks for URL: ${url}`);
    const tracks = await getTracks(url);
    const mappedTracks = tracks.map(t => ({
      title: t.name || 'Unknown',
      artists: t.artist || 'Unknown Artist',
      durationMs: t.duration || 0
    }));
    res.json({ tracks: mappedTracks });
  } catch (err) {
    console.error(`Failed to fetch Spotify playlist:`, err.message);
    res.status(500).json({ error: `Failed to fetch Spotify playlist: ${err.message}` });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`HD Video Merging Backend listening on port ${PORT}`);
  console.log(`Using yt-dlp at: ${ytdlpPath}`);
  console.log(`Using ffmpeg at: ${ffmpegPath}`);
});
