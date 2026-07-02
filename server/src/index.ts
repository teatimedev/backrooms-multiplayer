// One Node process serves the built client AND hosts all game rooms over
// WebSocket. Server-authoritative: there is no privileged "host" client, so
// the session survives anyone leaving — no host migration needed.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Room } from './room.js';
import type { Player } from './room.js';
import { makeCode, normalizeCode } from './codes.js';

const PORT = Number(process.env.GAME_PORT ?? process.env.PORT) || 8471;
const DIST = fileURLToPath(new URL('../../client/dist', import.meta.url));
const rooms = new Map<string, Room>();

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
};

const http = createServer(async (req, res) => {
  try {
    if (req.url === '/healthz') { res.writeHead(200).end('ok'); return; }
    let p = normalize((req.url ?? '/').split('?')[0]).replace(/^(\.\.[/\\])+/, '');
    if (p === '/' || p === '\\') p = '/index.html';
    let file = join(DIST, p);
    try { await stat(file); } catch { file = join(DIST, 'index.html'); } // SPA fallback
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found — run `npm run build` first?');
  }
});

const wss = new WebSocketServer({ server: http, path: '/ws' });

interface Session { room: Room | null; player: Player | null; hb: boolean }

wss.on('connection', (ws: WebSocket) => {
  const sess: Session = { room: null, player: null, hb: true };
  ws.on('pong', () => { sess.hb = true; });

  ws.on('message', (raw) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(String(raw)); } catch { return; }

    if (msg.t === 'host' || msg.t === 'join') {
      if (sess.room) return;
      let room: Room;
      if (msg.t === 'host') {
        const code = makeCode((c) => rooms.has(c));
        room = new Room(code);
        rooms.set(code, room);
        console.log(`[room] ${code} created (${rooms.size} rooms)`);
      } else {
        const code = normalizeCode(String(msg.code ?? ''));
        const found = rooms.get(code);
        if (!found) { ws.send(JSON.stringify({ t: 'err', msg: 'No session with that code. Check it and try again.' })); return; }
        room = found;
      }
      const player = room.addPlayer(ws, String(msg.name ?? ''), Number(msg.color) || 0);
      if (!player) { ws.send(JSON.stringify({ t: 'err', msg: 'That session is full (8 players max).' })); return; }
      sess.room = room; sess.player = player;
      console.log(`[room] ${room.code} += ${player.name} (${room.players.size} players)`);
      return;
    }

    if (sess.room && sess.player) sess.room.handle(sess.player, msg);
  });

  ws.on('close', () => {
    if (sess.room && sess.player) {
      console.log(`[room] ${sess.room.code} -= ${sess.player.name}`);
      sess.room.removePlayer(sess.player.id);
    }
  });
});

// heartbeat: cull dead sockets so rooms don't fill with ghosts (the bad kind)
setInterval(() => {
  const clients = wss.clients as Set<WebSocket & { _hb?: boolean }>;
  for (const ws of clients) {
    if (ws._hb === false) { ws.terminate(); continue; }
    ws._hb = false;
    ws.ping();
    ws.once('pong', () => { ws._hb = true; });
  }
}, 15000);

// garbage-collect rooms empty for >5 minutes
setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.emptySince && Date.now() - room.emptySince > 5 * 60 * 1000) {
      room.destroy();
      rooms.delete(code);
      console.log(`[room] ${code} expired`);
    }
  }
}, 60000);

http.listen(PORT, () => console.log(`backrooms server humming on :${PORT}`));
