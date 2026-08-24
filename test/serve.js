/* Static server for test/browser.js. Service workers need an http origin,
   and localhost counts as secure, so this is enough to exercise the real
   caching and registration paths. */
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = '/home/user/receipts';
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
                '.png':'image/png', '.webmanifest':'application/manifest+json', '.mjs':'text/javascript' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); return res.end('nope');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream',
                       'Service-Worker-Allowed': '/' });
  res.end(fs.readFileSync(f));
}).listen(8099, () => console.log('serving on 8099'));
