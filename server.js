import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import createPix from './api/pix.js';
import status from './api/status.js';

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/checkout.js', ['checkout.js', 'text/javascript; charset=utf-8']],
  ['/logo-delta.png', ['logo-delta.png', 'image/png']]
]);
const config = JSON.parse(await readFile(new URL('./vercel.json', import.meta.url)));
const server = createServer(async (req, res) => {
  for (const header of config.headers[0].headers) res.setHeader(header.key, header.value);
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/api/pix') return createPix(req, res);
  if (path === '/api/status') return status(req, res);
  if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
  const file = files.get(path);
  if (!file) { res.writeHead(404); return res.end('Página não encontrada'); }
  try {
    const data = await readFile(new URL(`./public/${file[0]}`, import.meta.url));
    res.setHeader('Content-Type', file[1]);
    res.setHeader('Cache-Control', 'no-cache');
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(500); res.end('Não foi possível carregar a página.'); }
});
server.listen(Number(process.env.PORT) || 3000, '127.0.0.1', () => console.log(`Checkout: http://localhost:${server.address().port}`));
