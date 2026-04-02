const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

/* ═══════════════════════════════════════════════════════
   YYYAS3 v3 — Piped for search, Invidious-first for audio
   ═══════════════════════════════════════════════════════ */

const PIPED = [
  'https://api.piped.projectsegfau.lt',
  'https://pipedapi.in.projectsegfau.lt',
];

const INVIDIOUS = [
  'https://invidious.materialio.us',
  'https://yewtu.be',
];

const health = new Map();
function score(u) { const h = health.get(u); if (!h) return 0.5; const t = h.ok + h.fail; return t ? h.ok / t : 0.5; }
function record(u, ok) { let h = health.get(u) || { ok: 0, fail: 0 }; ok ? h.ok++ : h.fail++; if (h.ok + h.fail > 20) { h.ok = Math.floor(h.ok * 0.7); h.fail = Math.floor(h.fail * 0.7); } health.set(u, h); }
function sorted(list) { return [...list].sort((a, b) => score(b) - score(a)); }

function httpGet(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeout);
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, { headers: { 'User-Agent': 'YYYAS3/3.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timer);
        return httpGet(res.headers.location, timeout).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { clearTimeout(timer); return reject(new Error('HTTP ' + res.statusCode)); }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { clearTimeout(timer); resolve(d); });
      res.on('error', e => { clearTimeout(timer); reject(e); });
    }).on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// ── SEARCH (Piped first — faster, then Invidious fallback) ──
async function pipedSearch(q) {
  for (const inst of sorted(PIPED)) {
    try {
      let raw;
      try { raw = await httpGet(inst + '/search?q=' + encodeURIComponent(q) + '&filter=music_songs'); }
      catch { raw = await httpGet(inst + '/search?q=' + encodeURIComponent(q) + '&filter=videos'); }
      const data = JSON.parse(raw);
      const items = (data.items || []).filter(i => i.url && i.type === 'stream').slice(0, 5)
        .map(i => ({ id: i.url.replace('/watch?v=', ''), title: i.title || '?', duration: i.duration || 0, uploader: i.uploaderName || '' }));
      if (items.length) { record(inst, true); return items; }
    } catch (e) { console.log('Piped search ' + inst + ': ' + e.message); record(inst, false); }
  }
  return null;
}

async function invSearch(q) {
  for (const inst of sorted(INVIDIOUS)) {
    try {
      const raw = await httpGet(inst + '/api/v1/search?q=' + encodeURIComponent(q) + '&type=video&sort_by=relevance');
      const data = JSON.parse(raw);
      const items = data.filter(i => i.type === 'video' && i.videoId).slice(0, 5)
        .map(i => ({ id: i.videoId, title: i.title || '?', duration: i.lengthSeconds || 0, uploader: i.author || '' }));
      if (items.length) { record(inst, true); return items; }
    } catch (e) { console.log('Inv search ' + inst + ': ' + e.message); record(inst, false); }
  }
  return null;
}

// ── AUDIO URL — Invidious FIRST (direct Google CDN URLs), Piped fallback ──
const cache = new Map();
function cached(id) { const e = cache.get(id); if (e && Date.now() - e.ts < 3600000) return e.url; cache.delete(id); return null; }

async function audioUrl(id) {
  const c = cached(id);
  if (c) return c;

  const errors = [];

  // TRY INVIDIOUS FIRST — returns direct googlevideo.com URLs
  for (const inst of sorted(INVIDIOUS)) {
    try {
      const raw = await httpGet(inst + '/api/v1/videos/' + id);
      const data = JSON.parse(raw);
      const streams = (data.adaptiveFormats || [])
        .filter(f => f.type && f.type.includes('audio'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (streams.length) {
        const url = streams[0].url;
        console.log('Audio from Invidious ' + inst + ' → ' + (new URL(url)).hostname);
        cache.set(id, { url, ts: Date.now() });
        record(inst, true);
        return url;
      }
    } catch (e) {
      errors.push('Inv ' + inst + ': ' + e.message);
      record(inst, false);
    }
  }

  // FALLBACK: Piped (audio URLs go through pipedproxy which may be down)
  for (const inst of sorted(PIPED)) {
    try {
      const raw = await httpGet(inst + '/streams/' + id);
      const data = JSON.parse(raw);
      const streams = (data.audioStreams || [])
        .filter(s => s.url && s.mimeType && s.mimeType.includes('audio'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (streams.length) {
        const url = streams[0].url;
        console.log('Audio from Piped ' + inst + ' → ' + (new URL(url)).hostname);
        cache.set(id, { url, ts: Date.now() });
        record(inst, true);
        return url;
      }
    } catch (e) {
      errors.push('Piped ' + inst + ': ' + e.message);
      record(inst, false);
    }
  }

  console.error('All audio failed:', errors.join(' | '));
  throw new Error('No audio source available');
}

/* ═══════ ROUTES ═══════ */

app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'No query' });
  try {
    let r = await pipedSearch(q);
    if (!r || !r.length) r = await invSearch(q);
    if (!r || !r.length) return res.status(404).json({ error: 'No results' });
    res.json(r);
    r.forEach(t => audioUrl(t.id).catch(() => {})); // pre-warm
  } catch (e) {
    res.status(500).json({ error: 'Search failed — try again' });
  }
});

app.get('/stream', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).send('No id');
  try {
    const url = await audioUrl(id);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Transfer-Encoding', 'chunked');

    const proxy = (u, depth) => {
      if (depth > 5) { if (!res.headersSent) res.status(500).send('Too many redirects'); return; }
      const p = u.startsWith('https') ? https : http;
      const pr = p.get(u, { headers: { 'User-Agent': 'YYYAS3/3.0', 'Accept': '*/*' } }, r => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return proxy(r.headers.location, depth + 1);
        if (r.statusCode !== 200) {
          console.error('Proxy got HTTP ' + r.statusCode + ' from ' + (new URL(u)).hostname);
          if (!res.headersSent) res.status(502).send('Upstream returned ' + r.statusCode);
          return;
        }
        if (r.headers['content-type']) res.setHeader('Content-Type', r.headers['content-type']);
        if (r.headers['content-length']) res.setHeader('Content-Length', r.headers['content-length']);
        r.pipe(res);
      });
      pr.on('error', (e) => {
        console.error('Proxy error:', e.message);
        if (!res.headersSent) res.status(500).send('Stream error: ' + e.message);
      });
      req.on('close', () => pr.destroy());
    };
    proxy(url, 0);
  } catch (e) {
    console.error('Stream failed:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.get('/prefetch', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ ok: false });
  try { await audioUrl(id); res.json({ ok: true }); } catch { res.json({ ok: false }); }
});

// ── DEBUG: /test-stream?id=VIDEO_ID — shows what audio URLs resolve to ──
app.get('/test-stream', async (req, res) => {
  const id = req.query.id || 'dQw4w9WgXcQ'; // default: never gonna give you up
  const out = { id, invidious: [], piped: [] };

  for (const inst of INVIDIOUS) {
    try {
      const raw = await httpGet(inst + '/api/v1/videos/' + id, 12000);
      const data = JSON.parse(raw);
      const streams = (data.adaptiveFormats || []).filter(f => f.type && f.type.includes('audio'));
      out.invidious.push({
        instance: inst,
        status: 'OK',
        audioStreams: streams.slice(0, 2).map(s => ({
          type: s.type,
          bitrate: s.bitrate,
          urlHost: s.url ? new URL(s.url).hostname : 'none',
          urlStart: s.url ? s.url.substring(0, 80) + '...' : 'none'
        }))
      });
    } catch (e) {
      out.invidious.push({ instance: inst, status: 'FAIL', error: e.message });
    }
  }

  for (const inst of PIPED) {
    try {
      const raw = await httpGet(inst + '/streams/' + id, 12000);
      const data = JSON.parse(raw);
      const streams = (data.audioStreams || []).filter(s => s.url && s.mimeType && s.mimeType.includes('audio'));
      out.piped.push({
        instance: inst,
        status: 'OK',
        audioStreams: streams.slice(0, 2).map(s => ({
          mimeType: s.mimeType,
          bitrate: s.bitrate,
          urlHost: new URL(s.url).hostname,
          urlStart: s.url.substring(0, 80) + '...'
        }))
      });
    } catch (e) {
      out.piped.push({ instance: inst, status: 'FAIL', error: e.message });
    }
  }

  res.json(out);
});

// Standard test
app.get('/test', async (req, res) => {
  const out = { piped: [], invidious: [], cache: cache.size };
  for (const inst of PIPED) {
    const t = Date.now();
    try { await httpGet(inst + '/search?q=drake&filter=videos', 10000); out.piped.push({ url: inst, status: 'OK', ms: Date.now() - t }); }
    catch (e) { out.piped.push({ url: inst, status: 'FAIL', err: e.message, ms: Date.now() - t }); }
  }
  for (const inst of INVIDIOUS) {
    const t = Date.now();
    try { await httpGet(inst + '/api/v1/search?q=drake&type=video', 10000); out.invidious.push({ url: inst, status: 'OK', ms: Date.now() - t }); }
    catch (e) { out.invidious.push({ url: inst, status: 'FAIL', err: e.message, ms: Date.now() - t }); }
  }
  res.json(out);
});

app.get('/health', (req, res) => {
  const h = {}; health.forEach((v, k) => h[k] = v);
  res.json({ status: 'ok', cache: cache.size, health: h });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('YYYAS3 v3 on port ' + PORT));
