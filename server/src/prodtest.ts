// Full production round-trip: two clients host+join a real room, pull all
// three breakers between them, stand in the exit together, expect a win.
// Usage: tsx server/src/prodtest.ts [wss://host/ws]
import WebSocket from 'ws';
import { breakerSpots, exitPos } from '../../shared/src/worldgen.js';

const URL = process.argv[2] ?? 'wss://backrooms-mp.fly.dev/ws';
const t0 = Date.now();
const log = (s: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);

function client(name: string): WebSocket & { sendJ: (o: object) => void } {
  const w = new WebSocket(URL) as ReturnType<typeof client>;
  w.sendJ = (o) => w.send(JSON.stringify(o));
  return w;
}

const a = client('alpha');
let code = '', seed = 0;
let aliveA = '', aliveB = '';
let done = false;

a.on('open', () => { log('alpha connected'); a.sendJ({ t: 'host', name: 'alpha', color: 0 }); });
a.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.t === 'joined') {
    code = m.code; seed = m.seed; aliveA = m.you;
    log(`alpha hosted ${code} (seed ${seed})`);
    startB();
  }
  if (m.t === 'powered') log('alpha sees POWERED');
  if (m.t === 'win') { log(`WIN broadcast after ${m.time}s — PRODUCTION ROUND COMPLETE`); done = true; process.exit(0); }
});

function startB(): void {
  const b = client('bravo');
  b.on('open', () => b.sendJ({ t: 'join', code, name: 'bravo', color: 3 }));
  b.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.t === 'joined') {
      aliveB = m.you;
      log(`bravo joined ${code}, players: ${m.players.map((p: { name: string }) => p.name).join(', ')}, seed match: ${m.seed === seed}`);
      const spots = breakerSpots(seed);
      const ex = exitPos(seed);
      // alpha takes breakers 0+1, bravo takes 2; then both to the exit
      const moveAndPull = (ws: typeof b, spot: { id: string; x: number; z: number }, delay: number): void => {
        setTimeout(() => {
          ws.sendJ({ t: 'state', s: [spot.x, 1.6, spot.z, 0, 0, 0] });
          setTimeout(() => { ws.sendJ({ t: 'breaker', id: spot.id }); log(`pull ${spot.id}`); }, 400);
        }, delay);
      };
      moveAndPull(a as never, spots[0], 500);
      moveAndPull(a as never, spots[1], 1600);
      moveAndPull(b, spots[2], 2700);
      // keep state fresh + converge on the exit
      setTimeout(() => {
        setInterval(() => {
          a.sendJ({ t: 'state', s: [ex.x, 1.6, ex.z, 0, 0, 0] });
          b.sendJ({ t: 'state', s: [ex.x + 0.5, 1.6, ex.z, 0, 0, 0] });
        }, 150);
        log('both standing in the exit, awaiting win…');
      }, 4000);
    }
    if (m.t === 'breaker') log(`bravo sees breaker ${m.id} pulled, ${m.left} left`);
    if (m.t === 'powered') log('bravo sees POWERED');
  });
}

setTimeout(() => { if (!done) { log('TIMEOUT — round did not complete'); process.exit(1); } }, 40000);
