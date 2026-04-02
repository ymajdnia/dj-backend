const express = require('express');
const cors = require('cors');
const path = require('path');
const { exec } = require('child_process');
const app = express();

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory cache for audio URLs (1 hour TTL)
const cache = new Map();
const TTL = 1000 * 60 * 60;

function cached(id) {
  const e = cache.get(id);
  if (!e) return null;
  if (Date.now() - e.ts > TTL) { cache.delete(id); return null; }
  return e.url;
}

// Search YouTube — returns top 5 results
app.get('/search', (req, res) => {
  const q = (req.query.q || '').replace(/["`]/g, '').trim();
  if (!q) return res.status(400).json({ error: 'no query' });
  const cmd = `yt-dlp "ytsearch5:${q}" --dump-json --flat-playlist --no-warnings --no-check-certificate`;
  exec(cmd, { timeout: 20000 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: 'search failed' });
    const results = stdout.trim().split('\n').flatMap(line => {
      try {
        const t = JSON.parse(line);
        return [{ id: t.id, title: t.title, duration: t.duration || 0, uploader: t.uploader || '' }];
      } catch { return []; }
    });
    res.json(results);
    // Pre-cache audio URLs in background
    results.slice(0, 3).forEach(t => {
      if (!cached(t.id)) fetchUrl(t.id).catch(() => {});
    });
  });
});

// Fetch and cache direct audio URL
function fetchUrl(id) {
  return new Promise((resolve, reject) => {
    const hit = cached(id);
    if (hit) return resolve(hit);
    const cmd = `yt-dlp -f "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio" --get-url --no-warnings --no-check-certificate "https://www.youtube.com/watch?v=${id}"`;
    exec(cmd, { timeout: 25000 }, (err, stdout) => {
      if (err) return reject(err);
      const url = stdout.trim().split('\n')[0];
      if (!url) return reject(new Error('empty url'));
      cache.set(id, { url, ts: Date.now() });
      resolve(url);
    });
  });
}

// Proxy audio through server — avoids CORS, enables full Web Audio decoding
app.get('/audio', async (req, res) => {
  const id = (req.query.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id) return res.status(400).send('no id');
  try {
    const url = await fetchUrl(id);
    const https = require('https');
    const http = require('http');
    const client = url.startsWith('https') ? https : http;
    const proxyReq = client.get(url, proxyRes => {
      res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'audio/webm');
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (proxyRes.headers['content-length']) {
        res.setHeader('Content-Length', proxyRes.headers['content-length']);
      }
      proxyRes.pipe(res);
      proxyRes.on('error', () => res.end());
    });
    proxyReq.on('error', () => {
      if (!res.headersSent) res.status(500).send('proxy error');
    });
    req.on('close', () => proxyReq.destroy());
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`YYYAS3 on port ${PORT}`));
