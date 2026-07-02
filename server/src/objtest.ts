// Full-campaign verification: two bots play all three levels end to end.
//  L0: pull 3 breakers → group exit → DESCEND
//  L1: grab 3 fuel canisters, carry to the generator → exit → DESCEND
//  L2: hold both drain valves simultaneously → exit → FINAL WIN
// Usage: tsx server/src/objtest.ts [ws://localhost:8471/ws]
import WebSocket from 'ws';
import { breakerSpots, exitPos, hubPos } from '../../shared/src/worldgen.js';

const URL = process.argv[2] ?? 'ws://localhost:8471/ws';
const t0 = Date.now();
const log = (s: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);

interface Bot { ws: WebSocket; id: string; x: number; z: number }
const send = (b: Bot, o: object): void => { if (b.ws.readyState === 1) b.ws.send(JSON.stringify(o)); };

const a: Bot = { ws: new WebSocket(URL), id: '', x: 0, z: 0 };
const b: Bot = { ws: new WebSocket(URL), id: '', x: 0, z: 0 };
let code = '', seed = 0, depth = 0, powered = false;

function stateLoop(): void {
  setInterval(() => {
    send(a, { t: 'state', s: [a.x, 1.6, a.z, 0, 0, 0, 0.2] });
    send(b, { t: 'state', s: [b.x, 1.6, b.z, 0, 0, 0, 0.2] });
  }, 90);
}

function runLevel(): void {
  powered = false;
  const spots = breakerSpots(seed);
  const ex = exitPos(seed);
  log(`--- LEVEL ${depth} (seed ${seed}) ---`);
  if (depth === 0) {
    // alpha pulls two, bravo pulls one
    const pull = (bot: Bot, i: number, delay: number): void => {
      setTimeout(() => {
        bot.x = spots[i].x; bot.z = spots[i].z;
        setTimeout(() => { send(bot, { t: 'breaker', id: spots[i].id }); log(`pull breaker ${i}`); }, 400);
      }, delay);
    };
    pull(a, 0, 500); pull(a, 1, 1600); pull(b, 2, 2700);
  } else if (depth === 1) {
    const hub = hubPos(seed);
    // relay the three cans: grab (teleport to spot), then walk it to the hub
    const haul = (bot: Bot, i: number, delay: number): void => {
      setTimeout(() => {
        bot.x = spots[i].x; bot.z = spots[i].z;
        setTimeout(() => {
          send(bot, { t: 'grab', id: spots[i].id });
          log(`grab can ${i}`);
          setTimeout(() => { bot.x = hub.x + 1; bot.z = hub.z; log(`deliver can ${i}`); }, 700);
        }, 500);
      }, delay);
    };
    haul(a, 0, 500); haul(b, 1, 2200); haul(a, 2, 4200);
  } else {
    // both valves, held at once
    setTimeout(() => {
      a.x = spots[0].x; a.z = spots[0].z;
      b.x = spots[1].x; b.z = spots[1].z;
      setTimeout(() => {
        send(a, { t: 'valve', id: spots[0].id, on: true });
        send(b, { t: 'valve', id: spots[1].id, on: true });
        log('both bots holding valves…');
      }, 600);
    }, 500);
  }
  // when powered fires, both walk into the exit (handled in message handler)
  const gotoExit = setInterval(() => {
    if (powered) {
      clearInterval(gotoExit);
      a.x = ex.x; a.z = ex.z;
      b.x = ex.x + 0.5; b.z = ex.z;
      log('both in the exit…');
    }
  }, 200);
}

function handle(bot: Bot, other: Bot, raw: WebSocket.RawData): void {
  const m = JSON.parse(String(raw));
  if (m.t === 'joined') {
    bot.id = m.you; code = m.code; seed = m.seed; depth = m.depth;
    [bot.x, bot.z] = m.spawn;
    if (bot === a) {
      log(`alpha hosted ${code}`);
      other.ws.on('open', () => send(other, { t: 'join', code, name: 'bravo', color: 3 }));
      if (other.ws.readyState === 1) send(other, { t: 'join', code, name: 'bravo', color: 3 });
    } else {
      log('bravo joined — starting campaign');
      stateLoop();
      setTimeout(runLevel, 800);
    }
  }
  if (bot !== a) return; // only alpha narrates from here
  if (m.t === 'fuel') log(`fuel delivered (${m.left} left)`);
  if (m.t === 'vp' && m.p > 0 && m.p < 0.2) log(`valves turning… p=${m.p.toFixed(2)}`);
  if (m.t === 'powered') { powered = true; log(`POWERED at level ${depth}`); }
  if (m.t === 'win') {
    log(`WIN level ${depth} (final=${m.final})`);
    if (m.final) { log('CAMPAIGN COMPLETE — ALL THREE LEVELS PASS'); process.exit(0); }
    setTimeout(() => send(a, { t: 'descend' }), 800);
  }
  if (m.t === 'round') {
    seed = m.seed; depth = m.depth;
    [a.x, a.z] = m.spawn;
    setTimeout(runLevel, 800);
  }
  if (m.t === 'dead' || m.t === 'wipe') log(`unexpected: ${m.t}`);
}

a.ws.on('open', () => send(a, { t: 'host', name: 'alpha', color: 0 }));
a.ws.on('message', (raw) => handle(a, b, raw));
b.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.t === 'joined') handle(b, a, raw);
  if (m.t === 'round') { [b.x, b.z] = m.spawn; }
});

setTimeout(() => { log(`TIMEOUT at depth=${depth} powered=${powered}`); process.exit(1); }, 120000);
