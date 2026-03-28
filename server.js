const express = require('express');
const cors = require('cors');
const path = require('path');
const { exec, spawn } = require('child_process');
const app = express();

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const audioCache = new Map();
const CACHE_TTL = 1000 * 60 * 50;

function getCached(id) {
  const e = audioCache.get(id);
  if (!e) return null;
  if (Date.now() - e.fetchedAt > CACHE_TTL) { audioCache.delete(id); return null; }
  return e.url;
}

function fetchAudioUrl(id) {
  return new Promise((resolve, reject) => {
    const cached = getCached(id);
    if (cached) return resolve(cached);
    const cmd = `yt-dlp -f bestaudio[ext=webm]/bestaudio --get-url "https://www.youtube.com/watch?v=${id}" --no-warnings`;
    exec(cmd, { timeout: 25000 }, (err, stdout) => {
      if (err) return reject(err);
      const url = stdout.trim().split('\n')[0];
      if (!url) return reject(new Error('empty url'));
      audioCache.set(id, { url, fetchedAt: Date.now() });
      resolve(url);
    });
  });
}

// Search
app.get('/search', (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'No query' });
  const cmd = `yt-dlp "ytsearch5:${q.replace(/"/g, '').replace(/`/g, '')}" --dump-json --flat-playlist --no-warnings`;
  exec(cmd, { timeout: 20000 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: 'Search failed' });
    const results = stdout.trim().split('\n').map(line => {
      try {
        const t = JSON.parse(line);
        return { id: t.id, title: t.title, duration: t.duration, uploader: t.uploader };
      } catch { return null; }
    }).filter(Boolean);
    res.json(results);
    results.forEach(t => { if (!getCached(t.id)) fetchAudioUrl(t.id).catch(() => {}); });
  });
});

// Prefetch
app.get('/prefetch', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'No id' });
  fetchAudioUrl(id).then(() => res.json({ ok: true })).catch(() => res.json({ ok: false }));
});

// Stream audio through the server (fixes CORS)
app.get('/stream', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).send('No id');

  let audioUrl;
  try {
    audioUrl = await fetchAudioUrl(id);
  } catch (e) {
    return res.status(500).send('Could not resolve audio URL');
  }

  // Use yt-dlp to pipe audio directly to the response
  res.setHeader('Content-Type', 'audio/webm');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const ytdlp = spawn('yt-dlp', [
    '-f', 'bestaudio[ext=webm]/bestaudio',
    '--no-warnings',
    '-o', '-',
    `https://www.youtube.com/watch?v=${id}`
  ]);

  ytdlp.stdout.pipe(res);

  ytdlp.stderr.on('data', () => {});

  ytdlp.on('error', () => {
    if (!res.headersSent) res.status(500).send('Stream error');
  });

  req.on('close', () => ytdlp.kill());
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DJ backend running on port ${PORT}`));
