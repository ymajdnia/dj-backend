const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const app = express();

app.use(cors());

// Search YouTube and return top results
app.get('/search', (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'No query' });

  const cmd = `yt-dlp "ytsearch5:${q.replace(/"/g, '')}" --dump-json --flat-playlist --no-warnings`;

  exec(cmd, { timeout: 15000 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: 'Search failed' });
    const results = stdout.trim().split('\n').map(line => {
      try {
        const t = JSON.parse(line);
        return { id: t.id, title: t.title, duration: t.duration, uploader: t.uploader };
      } catch { return null; }
    }).filter(Boolean);
    res.json(results);
  });
});

// Get a streamable audio URL for a YouTube video ID
app.get('/audio', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'No id' });

  const url = `https://www.youtube.com/watch?v=${id}`;
  const cmd = `yt-dlp -f bestaudio --get-url "${url}" --no-warnings`;

  exec(cmd, { timeout: 20000 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: 'Could not get audio URL' });
    const audioUrl = stdout.trim().split('\n')[0];
    res.json({ url: audioUrl });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DJ backend running on port ${PORT}`));
