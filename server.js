const express = require('express');
const cors = require('cors');
const path = require('path');
const { exec, spawn } = require('child_process');
const app = express();

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Search YouTube — returns top 3 results
app.get('/ytsearch', (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'No query' });
  const cmd = `yt-dlp "ytsearch3:${q.replace(/"/g, '').replace(/`/g, '')}" --dump-json --flat-playlist --no-warnings`;
  exec(cmd, { timeout: 20000 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: 'Search failed' });
    const results = stdout.trim().split('\n').map(line => {
      try { const t = JSON.parse(line); return { id: t.id, title: t.title, duration: t.duration }; }
      catch { return null; }
    }).filter(Boolean);
    res.json(results);
  });
});

// Stream audio directly through the server (avoids CORS)
app.get('/stream', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).send('No id');
  res.setHeader('Content-Type', 'audio/webm');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const ytdlp = spawn('yt-dlp', [
    '-f', 'bestaudio[ext=webm]/bestaudio',
    '--no-warnings', '-o', '-',
    `https://www.youtube.com/watch?v=${id}`
  ]);
  ytdlp.stdout.pipe(res);
  ytdlp.stderr.on('data', () => {});
  ytdlp.on('error', () => { if (!res.headersSent) res.status(500).send('Stream error'); });
  req.on('close', () => ytdlp.kill());
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`YYYAS3 running on port ${PORT}`));
