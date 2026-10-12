import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { openStore } from '../storage/db.mjs';
export async function createServer({ dbPath }) {
  const store = openStore(dbPath);
  const server = http.createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(body)); };
    try {
      if (req.method === 'GET' && req.url === '/api/slots') return json(200, {slots:store.listSlots().map(s => ({slot_id:s.id,label:s.label,available:true}))});
      if (req.method === 'GET' && req.url === '/api/bookings') return json(200, {bookings:[]});
      if (req.method === 'POST' && req.url === '/api/bookings') return json(501, {error:'Booking API not implemented'});
      const asset = {'/':'index.html','/app.js':'app.js','/api.mjs':'api.mjs'}[req.url];
      if (req.method === 'GET' && asset) {
        res.writeHead(200, {'content-type':asset.endsWith('.html')?'text/html':'text/javascript'});
        return res.end(await readFile(new URL('../public/'+asset, import.meta.url)));
      }
      json(404,{error:'Not found'});
    } catch { json(500,{error:'Server error'}); }
  });
  server.on('close', () => store.close());
  return server;
}
