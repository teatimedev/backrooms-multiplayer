// Headless test player: joins a room, walks in circles near its spawn,
// drops a chalk mark, and logs everything the server tells it.
import WebSocket from 'ws';
import { spawnPoint, resolveCollision, PLAYER_R } from '../../shared/src/worldgen.js';

const code = process.argv[2];
const secs = Number(process.argv[3] ?? 70);
const ws = new WebSocket('ws://localhost:8471/ws');

let seed = 0, me = '', x = 0, z = 0, t0 = Date.now();
let gotStates = 0, sawPlayers = new Set<string>(), sawEntity = 0;

ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'join', code, name: 'testbot', color: 2 }));
});
ws.on('message', (raw: Buffer) => {
  const m = JSON.parse(String(raw));
  if (m.t === 'joined') {
    seed = m.seed; me = m.you;
    [x, z] = m.spawn;
    console.log(`[bot] joined ${m.code} as ${me}, seed=${seed}, spawn=(${x.toFixed(1)},${z.toFixed(1)})`);
    console.log(`[bot] players in room: ${m.players.map((p: { name: string }) => p.name).join(', ')}`);
    const sp = spawnPoint(seed, m.players.find((p: { id: string }) => p.id === me).spawnIndex);
    console.log(`[bot] deterministic spawn check: server=(${x},${z}) local=(${sp.x},${sp.z}) match=${sp.x === x && sp.z === z}`);
    setInterval(() => {
      const t = (Date.now() - t0) / 1000;
      x += Math.cos(t * 0.8) * 0.12;
      z += Math.sin(t * 0.8) * 0.12;
      const s = resolveCollision(seed, x, z, PLAYER_R);
      x = s.x; z = s.z;
      ws.send(JSON.stringify({ t: 'state', s: [x, 1.6, z, t * 0.3, 0, 1] }));
    }, 80);
    setTimeout(() => {
      ws.send(JSON.stringify({ t: 'chalk', m: { x, y: 1.2, z: z - 1, nx: 0, ny: 0, nz: 1, rot: 0, sym: 1 } }));
      ws.send(JSON.stringify({ t: 'chat', text: 'hello from the bot' }));
    }, 2000);
  }
  if (m.t === 's') {
    gotStates++;
    for (const id of Object.keys(m.p)) if (id !== me) sawPlayers.add(id);
    if (m.e) { sawEntity++; if (sawEntity === 1) console.log(`[bot] ENTITY ACTIVE at (${m.e[0].toFixed(1)},${m.e[1].toFixed(1)}) mode=${m.e[2]} target=${m.e[3]}`); }
  }
  if (m.t === 'chalk') console.log(`[bot] chalk synced back (by=${m.m.by === me ? 'me' : m.m.by})`);
  if (m.t === 'chat') console.log(`[bot] chat from ${m.name}: ${m.text}`);
  if (m.t === 'pj') console.log(`[bot] player joined: ${m.p.name}`);
  if (m.t === 'flicker') console.log(`[bot] flicker event at (${m.x.toFixed(1)},${m.z.toFixed(1)}) r=${m.r}`);
  if (m.t === 'kill') console.log(`[bot] KILL: ${m.id}${m.id === me ? ' (me!)' : ''}`);
  if (m.t === 'mimic') console.log(`[bot] mimic event`);
});
setTimeout(() => {
  console.log(`[bot] summary: state packets=${gotStates}, other players seen=${sawPlayers.size}, entity packets=${sawEntity}`);
  process.exit(0);
}, secs * 1000);
