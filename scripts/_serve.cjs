'use strict';
// Tiny dependency-free static server for local browser testing of the game.
// Binds to every interface by default (not just loopback) so a phone on the same
// Wi-Fi can open the game at the LAN URL this prints on startup.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 8788);
const host = process.argv[4] || '0.0.0.0';
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach((name) => {
    (ifaces[name] || []).forEach((a) => {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    });
  });
  return out;
}

http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}).listen(port, host, () => {
  console.log('serving ' + root + ' on http://localhost:' + port);
  lanAddresses().forEach((a) => console.log('  phone/tablet on the same Wi-Fi: http://' + a.address + ':' + port + '  (' + a.name + ')'));
  if (!lanAddresses().length) console.log('  (no LAN interface found — connect to Wi-Fi to play on another device)');
});
