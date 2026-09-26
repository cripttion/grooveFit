// Zero-dependency static server:  node server.js  →  http://localhost:5173
// (Camera access requires a secure context — localhost counts.)
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = +process.env.PORT || 5173;
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  // Dev convenience: the app can save an analyzed choreography into ./choreographies/
  const save = req.method === 'PUT' && url.match(/^\/choreographies\/([\w-]+)\.json$/);
  if (save) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        if (JSON.parse(body).format !== 'groovefit-choreo') throw new Error('bad format');
        fs.mkdirSync(path.join(root, 'choreographies'), { recursive: true });
        fs.writeFileSync(path.join(root, 'choreographies', `${save[1]}.json`), body);
        res.writeHead(200); res.end('saved');
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });
    return;
  }
  let file = path.normalize(path.join(root, url));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (url.endsWith('/')) file = path.join(file, 'index.html');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const type = types[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) { // needed for seeking in local videos
      const [s, e] = range.replace('bytes=', '').split('-');
      const start = +s, end = e ? +e : st.size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}).listen(port, '127.0.0.1', () => console.log(`Groove Fit → http://localhost:${port}`));
