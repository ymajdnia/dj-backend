const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

/* ═══════════════════════════════════════════
   PIPED API — Open-source YouTube proxy
   No yt-dlp, no IP blocking, no cookies needed
   ═══════════════════════════════════════════ */

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.in.projectsegfau.lt',
  'https://api.piped.projectsegfau.lt',
  'https://pipedapi.darkness.services'
];

// Simple fetch wrapper that follows redirects
function pipedFetch(url, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeout);
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, { headers: { 'User-Agent': 'YYYAS3/1.0' } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timer);
        return pipedFetch(res.headers.location, timeout).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { clearTimeout(timer); resolve(data); });
      res.on('error', e => { clearTimeout(timer); reject(e); });
    }).on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// Try each Piped instance until one works
async function pipedRequest(endpoint) {
  for (const instance of PIPED_INSTANCES) {
    try {
      const data = await pipedFetch(`${instance}${endpoint}`);
      return JSON.parse(data);
    } catch (e) {
      console.log(`Piped instance ${instance} failed: ${e.message}, trying next...`);
      continue;
    }
  }
  throw new Error('All Piped instances failed');
}

// Audio URL cache (1hr TTL)
const audioCache = new Map();
function getCached(id) {
  const entry = audioCache.get(id);
  if (entry && Date.now() - entry.fetchedAt < 3600000) return entry;
  audioCache.delete(id);
  return null;
}

/* ── SEARCH ── */
app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'No query' });

  try {
    const data = await pipedRequest(`/search?q=${encodeURIComponent(q)}&filter=music_songs`);
    const results = (data.items || [])
      .filter(item => item.url && item.type === 'stream')
      .slice(0, 5)
      .map(item => ({
        id: item.url.replace('/watch?v=', ''),
        title: item.title || 'Unknown',
        duration: item.duration || 0,
        uploader: item.uploaderName || ''
      }));

    // If music_songs filter returns nothing, try without filter
    if (results.length === 0) {
      const fallback = await pipedRequest(`/search?q=${encodeURIComponent(q)}&filter=videos`);
      const fallbackResults = (fallback.items || [])
        .filter(item => item.url && item.type === 'stream')
        .slice(0, 5)
        .map(item => ({
          id: item.url.replace('/watch?v=', ''),
          title: item.title || 'Unknown',
          duration: item.duration || 0,
          uploader: item.uploaderName || ''
        }));
      return res.json(fallbackResults);
    }

    res.json(results);
  } catch (e) {
    console.error('Search error:', e.message);
    res.status(500).json({ error: 'Search failed — trying again may help' });
  }
});

/* ── GET AUDIO STREAM INFO ── */
async function getAudioUrl(id) {
  const cached = getCached(id);
  if (cached) return cached.url;

  const data = await pipedRequest(`/streams/${id}`);

  // Find best audio stream
  const audioStreams = (data.audioStreams || [])
    .filter(s => s.url && s.mimeType && s.mimeType.includes('audio'))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  if (audioStreams.length === 0) throw new Error('No audio streams found');

  const best = audioStreams[0];
  audioCache.set(id, { url: best.url, fetchedAt: Date.now() });
  return best.url;
}

/* ── STREAM AUDIO (proxy through server to avoid CORS) ── */
app.get('/stream', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).send('No id');

  try {
    const audioUrl = await getAudioUrl(id);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'audio/webm');
    res.setHeader('Transfer-Encoding', 'chunked');

    const proto = audioUrl.startsWith('https') ? https : http;

    const proxyReq = proto.get(audioUrl, {
      headers: { 'User-Agent': 'YYYAS3/1.0' }
    }, (proxyRes) => {
      // Follow redirects
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        const redirectProto = proxyRes.headers.location.startsWith('https') ? https : http;
        redirectProto.get(proxyRes.headers.location, {
          headers: { 'User-Agent': 'YYYAS3/1.0' }
        }, (finalRes) => {
          if (finalRes.headers['content-type']) res.setHeader('Content-Type', finalRes.headers['content-type']);
          finalRes.pipe(res);
        }).on('error', () => {
          if (!res.headersSent) res.status(500).send('Stream redirect error');
        });
        return;
      }

      if (proxyRes.headers['content-type']) res.setHeader('Content-Type', proxyRes.headers['content-type']);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', () => {
      if (!res.headersSent) res.status(500).send('Stream error');
    });

    req.on('close', () => proxyReq.destroy());

  } catch (e) {
    console.error('Stream error:', e.message);
    if (!res.headersSent) res.status(500).send('Could not load audio');
  }
});

/* ── PREFETCH (background warm-up) ── */
app.get('/prefetch', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ ok: false });
  try {
    await getAudioUrl(id);
    res.json({ ok: true });
  } catch {
    res.json({ ok: false });
  }
});

/* ── HEALTH CHECK ── */
app.get('/health', (req, res) => res.json({ status: 'ok', cache: audioCache.size }));

/* ── SERVE FRONTEND ── */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`YYYAS3 backend running on port ${PORT}`));
