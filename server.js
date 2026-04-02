const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

/* ═══════════════════════════════════════════════════════
   MULTI-PROVIDER YOUTUBE AUDIO — Piped + Invidious
   Falls back through many instances automatically
   ═══════════════════════════════════════════════════════ */

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi-libre.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.nosebs.ru',
  'https://piped-api.privacy.com.de',
  'https://api.piped.yt',
  'https://pipedapi.drgns.space',
  'https://pipedapi.in.projectsegfau.lt',
  'https://api.piped.projectsegfau.lt',
  'https://pipedapi.darkness.services'
];

const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://invidious.materialio.us',
  'https://invidious.privacyredirect.com',
  'https://iv.nbohr.de',
  'https://invidious.protokolla.fi',
  'https://invidious.perennialte.ch',
  'https://yt.artemislena.eu',
  'https://invidious.lunar.icu'
];

// Track instance health
const instanceHealth = new Map();

function getHealthScore(url) {
  const h = instanceHealth.get(url);
  if (!h) return 0.5;
  const total = h.ok + h.fail;
  if (total === 0) return 0.5;
  return h.ok / total;
}

function recordResult(url, success) {
  let h = instanceHealth.get(url) || { ok: 0, fail: 0 };
  if (success) h.ok++; else h.fail++;
  if (h.ok + h.fail > 20) { h.ok = Math.floor(h.ok * 0.7); h.fail = Math.floor(h.fail * 0.7); }
  instanceHealth.set(url, h);
}

function sortedInstances(list) {
  return [...list].sort((a, b) => getHealthScore(b) - getHealthScore(a));
}

// HTTP fetch with redirect following
function httpFetch(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeout);
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, { headers: { 'User-Agent': 'YYYAS3/2.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timer);
        return httpFetch(res.headers.location, timeout).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { clearTimeout(timer); resolve(data); });
      res.on('error', e => { clearTimeout(timer); reject(e); });
    }).on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// ── PIPED SEARCH ──
async function pipedSearch(query) {
  const sorted = sortedInstances(PIPED_INSTANCES);
  for (const inst of sorted) {
    try {
      let raw;
      try {
        raw = await httpFetch(inst + '/search?q=' + encodeURIComponent(query) + '&filter=music_songs');
      } catch {
        raw = await httpFetch(inst + '/search?q=' + encodeURIComponent(query) + '&filter=videos');
      }
      const data = JSON.parse(raw);
      const items = (data.items || [])
        .filter(i => i.url && i.type === 'stream')
        .slice(0, 5)
        .map(i => ({
          id: i.url.replace('/watch?v=', ''),
          title: i.title || 'Unknown',
          duration: i.duration || 0,
          uploader: i.uploaderName || '',
          source: 'piped',
          instance: inst
        }));
      if (items.length > 0) { recordResult(inst, true); return items; }
    } catch (e) {
      console.log('Piped ' + inst + ': ' + e.message);
      recordResult(inst, false);
    }
  }
  return null;
}

// ── INVIDIOUS SEARCH ──
async function invidiousSearch(query) {
  const sorted = sortedInstances(INVIDIOUS_INSTANCES);
  for (const inst of sorted) {
    try {
      const raw = await httpFetch(inst + '/api/v1/search?q=' + encodeURIComponent(query) + '&type=video&sort_by=relevance');
      const data = JSON.parse(raw);
      const items = data
        .filter(i => i.type === 'video' && i.videoId)
        .slice(0, 5)
        .map(i => ({
          id: i.videoId,
          title: i.title || 'Unknown',
          duration: i.lengthSeconds || 0,
          uploader: i.author || '',
          source: 'invidious',
          instance: inst
        }));
      if (items.length > 0) { recordResult(inst, true); return items; }
    } catch (e) {
      console.log('Invidious ' + inst + ': ' + e.message);
      recordResult(inst, false);
    }
  }
  return null;
}

// ── AUDIO URL RESOLUTION ──
const audioCache = new Map();
function getCached(id) {
  const e = audioCache.get(id);
  if (e && Date.now() - e.ts < 3600000) return e.url;
  audioCache.delete(id);
  return null;
}

async function getAudioUrl(id) {
  const cached = getCached(id);
  if (cached) return cached;

  // Try Piped
  for (const inst of sortedInstances(PIPED_INSTANCES)) {
    try {
      const raw = await httpFetch(inst + '/streams/' + id);
      const data = JSON.parse(raw);
      const streams = (data.audioStreams || [])
        .filter(s => s.url && s.mimeType && s.mimeType.includes('audio'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (streams.length > 0) {
        audioCache.set(id, { url: streams[0].url, ts: Date.now() });
        recordResult(inst, true);
        return streams[0].url;
      }
    } catch (e) {
      recordResult(inst, false);
    }
  }

  // Fallback: Invidious
  for (const inst of sortedInstances(INVIDIOUS_INSTANCES)) {
    try {
      const raw = await httpFetch(inst + '/api/v1/videos/' + id);
      const data = JSON.parse(raw);
      const streams = (data.adaptiveFormats || [])
        .filter(f => f.type && f.type.includes('audio'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (streams.length > 0) {
        audioCache.set(id, { url: streams[0].url, ts: Date.now() });
        recordResult(inst, true);
        return streams[0].url;
      }
    } catch (e) {
      recordResult(inst, false);
    }
  }

  throw new Error('No audio from any instance');
}

/* ═══════ ROUTES ═══════ */

app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'No query' });
  try {
    let results = await pipedSearch(q);
    if (!results || results.length === 0) results = await invidiousSearch(q);
    if (!results || results.length === 0) return res.status(404).json({ error: 'No results' });
    res.json(results);
    results.forEach(t => { getAudioUrl(t.id).catch(() => {}); });
  } catch (e) {
    console.error('Search error:', e.message);
    res.status(500).json({ error: 'All instances down — try again in a moment' });
  }
});

app.get('/stream', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).send('No id');
  try {
    const audioUrl = await getAudioUrl(id);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Transfer-Encoding', 'chunked');

    const doProxy = (url, depth) => {
      if (depth > 5) { if (!res.headersSent) res.status(500).send('Too many redirects'); return; }
      const proto = url.startsWith('https') ? https : http;
      const proxyReq = proto.get(url, { headers: { 'User-Agent': 'YYYAS3/2.0' } }, (proxyRes) => {
        if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
          return doProxy(proxyRes.headers.location, depth + 1);
        }
        if (proxyRes.headers['content-type']) res.setHeader('Content-Type', proxyRes.headers['content-type']);
        proxyRes.pipe(res);
      });
      proxyReq.on('error', () => { if (!res.headersSent) res.status(500).send('Stream error'); });
      req.on('close', () => proxyReq.destroy());
    };
    doProxy(audioUrl, 0);
  } catch (e) {
    console.error('Stream error:', e.message);
    if (!res.headersSent) res.status(500).send('Could not load audio');
  }
});

app.get('/prefetch', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ ok: false });
  try { await getAudioUrl(id); res.json({ ok: true }); } catch { res.json({ ok: false }); }
});

// ── DEBUG: visit /test to see which instances work from Render ──
app.get('/test', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const out = { piped: [], invidious: [], cacheSize: audioCache.size };
  const q = 'drake';

  for (const inst of PIPED_INSTANCES) {
    const t = Date.now();
    try {
      await httpFetch(inst + '/search?q=' + q + '&filter=videos', 10000);
      out.piped.push({ url: inst, status: 'OK', ms: Date.now() - t });
    } catch (e) {
      out.piped.push({ url: inst, status: 'FAIL', err: e.message, ms: Date.now() - t });
    }
  }
  for (const inst of INVIDIOUS_INSTANCES) {
    const t = Date.now();
    try {
      await httpFetch(inst + '/api/v1/search?q=' + q + '&type=video', 10000);
      out.invidious.push({ url: inst, status: 'OK', ms: Date.now() - t });
    } catch (e) {
      out.invidious.push({ url: inst, status: 'FAIL', err: e.message, ms: Date.now() - t });
    }
  }
  res.json(out);
});

app.get('/health', (req, res) => {
  const h = {};
  instanceHealth.forEach((v, k) => { h[k] = v; });
  res.json({ status: 'ok', cache: audioCache.size, instances: h });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('YYYAS3 v2 running on port ' + PORT));
