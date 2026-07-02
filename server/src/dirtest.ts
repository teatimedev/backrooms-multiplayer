// Director verification (dev server with BR_DEBUG=1):
//  1. first peak must be a SCARE PASS — entity manifests, closes, leaves, no one downed
//  2. second peak must HUNT — target goes down
//  3. bravo revives alpha — revived event completes the loop
import WebSocket from 'ws';

const URL = process.env.BOT_WS ?? 'ws://localhost:8471/ws';
const t0 = Date.now();
const log = (s: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);

interface Bot { ws: WebSocket; id: string; x: number; z: number }
const mk = (): Bot => ({ ws: new WebSocket(URL), id: '', x: 0, z: 0 });
const send = (b: Bot, o: object): void => b.ws.send(JSON.stringify(o));

const alpha = mk();
const bravo = mk();
let code = '';
let sawEntity = false, entityGone = false, scareClean = true;
let stage: 'scare' | 'hunt' | 'revive' | 'done' = 'scare';
let downId = '';

alpha.ws.on('open', () => send(alpha, { t: 'host', name: 'alpha', color: 0 }));
alpha.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.t === 'joined') {
    alpha.id = m.you; code = m.code;
    [alpha.x, alpha.z] = m.spawn;
    log(`alpha hosted ${code} at (${alpha.x},${alpha.z})`);
    bravo.ws.on('open', () => send(bravo, { t: 'join', code, name: 'bravo', color: 2 }));
    if (bravo.ws.readyState === 1) send(bravo, { t: 'join', code, name: 'bravo', color: 2 });
    setInterval(() => {
      send(alpha, { t: 'state', s: [alpha.x, 1.6, alpha.z, 0, 0, downId === alpha.id ? 4 : 0] });
      send(bravo, { t: 'state', s: [bravo.x, 1.6, bravo.z, 0, 0, 0] });
    }, 90);
  }
  if (m.t === 's') {
    if (m.e && !sawEntity) { sawEntity = true; log(`entity manifested: mode=${m.e[2]} target=${m.e[3]} (stage=${stage})`); }
    if (m.e && m.e[2] === 2 && stage === 'scare') { scareClean = false; log('WARN: entity went to HUNT during first peak'); }
    if (!m.e && sawEntity && !entityGone) {
      entityGone = true;
      if (stage === 'scare') {
        log(`scare pass complete — no takedown: ${scareClean && !downId ? 'PASS' : 'FAIL'}`);
        stage = 'hunt';
        sawEntity = false; entityGone = false;
        setTimeout(() => { log('forcing second encounter (expect HUNT)'); send(alpha, { t: 'dbg', cmd: 'spawn' }); }, 1500);
      }
    }
  }
  if (m.t === 'down') {
    downId = m.id;
    log(`DOWN: ${m.id === alpha.id ? 'alpha' : 'bravo'} (stage=${stage}) — ${stage === 'hunt' ? 'PASS' : 'unexpected'}`);
    stage = 'revive';
    // the other bot walks over and revives
    const downed = m.id === alpha.id ? alpha : bravo;
    const helper = m.id === alpha.id ? bravo : alpha;
    helper.x = downed.x + 1; helper.z = downed.z;
    setTimeout(() => { log('helper holding E…'); send(helper, { t: 'revive', id: m.id, on: true }); }, 800);
  }
  if (m.t === 'revived') {
    log(`REVIVED: ${m.id === alpha.id ? 'alpha' : 'bravo'} by ${m.by} — PASS`);
    downId = '';
    log('ALL STAGES PASSED');
    process.exit(0);
  }
  if (m.t === 'dead') log(`DEAD: ${m.id} (bleed-out?)`);
  if (m.t === 'blackout') log(`blackout event ${m.ms}ms`);
});

bravo.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.t === 'joined') {
    bravo.id = m.you;
    [bravo.x, bravo.z] = m.spawn;
    log(`bravo joined at (${bravo.x},${bravo.z})`);
    setTimeout(() => { log('forcing first encounter (expect SCARE PASS)'); send(alpha, { t: 'dbg', cmd: 'spawn' }); }, 2000);
  }
});

setTimeout(() => { log(`TIMEOUT at stage=${stage}`); process.exit(1); }, 150000);
