// The Entity, rebuilt around an AI Director.
//
// Nothing here freelances: an invisible pacing layer cycles
//   calm → build → peak → relax
// with guaranteed breathing room after every encounter. "Hunger" grows with
// round time, pulled breakers and takedowns, shortening the quiet phases and
// eventually letting it commit to hunts even against grouped players — so
// sticking together is safer, never safe. The first peak of every round is a
// scare-pass: it closes in, stares, and leaves. It teaches before it kills.
// A catch downs the target (teammates can revive); it always retreats after
// a takedown and won't re-target the same player immediately.
import { CELL, cellBlocked, losBlocked, resolveCollision, roundModifier } from '../../shared/src/worldgen.js';
import type { Room, Player } from './room.js';

type Cell = { x: number; z: number };
type Phase = 'calm' | 'build' | 'peak-scare' | 'peak-hunt' | 'relax';

function astar(seed: number, from: Cell, to: Cell, maxNodes = 1400): Cell[] | null {
  const key = (x: number, z: number) => `${x},${z}`;
  const open: { x: number; z: number; g: number; f: number }[] = [];
  const came = new Map<string, string>();
  const gScore = new Map<string, number>();
  const h = (x: number, z: number) => Math.abs(x - to.x) + Math.abs(z - to.z);
  open.push({ x: from.x, z: from.z, g: 0, f: h(from.x, from.z) });
  gScore.set(key(from.x, from.z), 0);
  let visited = 0;
  while (open.length && visited < maxNodes) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    visited++;
    if (cur.x === to.x && cur.z === to.z) {
      const path: Cell[] = [];
      let k = key(cur.x, cur.z);
      while (k !== key(from.x, from.z)) {
        const [x, z] = k.split(',').map(Number);
        path.unshift({ x, z });
        k = came.get(k)!;
      }
      return path;
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cur.x + dx, nz = cur.z + dz;
      if (cellBlocked(seed, cur.x, cur.z, nx, nz, true)) continue;
      const g = cur.g + 1;
      const nk = key(nx, nz);
      if (g < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, g);
        came.set(nk, key(cur.x, cur.z));
        open.push({ x: nx, z: nz, g, f: g + h(nx, nz) });
      }
    }
  }
  return null;
}

export class Entity {
  // wire state (what clients see)
  mode: 0 | 1 | 2 = 0;
  x = 0; z = 0;
  targetId: string | null = null;
  stunned = 0;

  private phase: Phase = 'calm';
  private phaseT = 40;
  private enraged = false;
  private scareDone = false;
  private lastVictim: string | null = null;
  private kills = 0;
  private avoidUntil = new Map<string, number>(); // recently downed/revived: off the menu
  private stareT = 0;
  private shineAccum = 0;
  private stallT = 0;
  private lastDist = Infinity;
  private path: Cell[] = [];
  private repath = 0;
  private flickerCd = 0;
  private mimicCd = 90;

  reset(): void {
    this.mode = 0; this.targetId = null; this.stunned = 0;
    this.phase = 'calm'; this.phaseT = 40;
    this.enraged = false; this.scareDone = false;
    this.lastVictim = null; this.kills = 0;
    this.avoidUntil.clear(); this.path = []; this.shineAccum = 0;
  }

  /** Power restored: the endgame. Quiet phases collapse. */
  enrage(): void {
    this.enraged = true;
    if (this.phase === 'calm' || this.phase === 'relax') this.phaseT = Math.min(this.phaseT, 6);
  }

  /** Debug hook (BR_DEBUG only): skip straight to the next encounter. */
  forceSpawn(): void {
    if (this.phase === 'calm' || this.phase === 'relax') this.phaseT = 0.1;
  }

  avoidFor(id: string, secs: number): void {
    this.avoidUntil.set(id, Date.now() + secs * 1000);
  }

  /** 0..1 appetite: round time + breakers pulled + previous takedowns + how deep you've gone. */
  private hungerOf(room: Room): number {
    let h = room.ageSec() / 480 + room.breakers.size * 0.12 + this.kills * 0.1 + room.depth * 0.22;
    if (roundModifier(room.seed) === 'hunger') h += 0.18;
    if (this.enraged) h = Math.max(h, 0.85);
    return Math.min(1, h);
  }

  private candidates(room: Room): Player[] {
    const now = Date.now();
    return [...room.players.values()].filter((p) =>
      p.alive && !p.downed && p.hasState && (this.avoidUntil.get(p.id) ?? 0) < now);
  }

  private isolationOf(room: Room, p: Player): number {
    let nearest = Infinity;
    for (const q of room.players.values()) {
      if (q === p || !q.alive || q.downed || !q.hasState) continue;
      nearest = Math.min(nearest, Math.hypot(q.state[0] - p.state[0], q.state[2] - p.state[2]));
    }
    return nearest === Infinity ? 999 : nearest;
  }

  private pickTarget(room: Room): Player | null {
    const cands = this.candidates(room);
    if (!cands.length) return null;
    if (cands.length === 1) return cands[0];
    const carriers = room.carrierIds();
    const valvers = room.valveHolderIds();
    let best: Player | null = null, bestScore = -1;
    for (const p of cands) {
      const score = Math.min(40, this.isolationOf(room, p))
        + (p.id !== this.lastVictim ? 18 : 0)
        + (p.state[6] ?? 0) * 12          // it hears you
        + (carriers.has(p.id) ? 14 : 0)   // the fuel sloshes
        + (valvers.has(p.id) ? 16 : 0)    // holding still, holding a valve
        + Math.random() * 8;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best;
  }

  update(room: Room, dt: number): void {
    if (this.stunned > 0) { this.stunned -= dt; return; }
    const hunger = this.hungerOf(room);

    // ------------------------------------------------ quiet phases
    if (this.phase === 'calm' || this.phase === 'relax') {
      this.mode = 0;
      this.phaseT -= dt;
      this.mimicCd -= dt;
      if (this.mimicCd <= 0 && room.ageSec() > 180) {
        this.mimicCd = 50 + Math.random() * 80;
        const cands = this.candidates(room);
        if (cands.length) {
          const v = cands[Math.floor(Math.random() * cands.length)];
          const a = Math.random() * Math.PI * 2;
          room.sendTo(v.id, { t: 'mimic', x: v.state[0] + Math.cos(a) * 9, z: v.state[2] + Math.sin(a) * 9, kind: Math.random() < 0.6 ? 'steps' : 'voice' });
        }
      }
      if (this.phaseT <= 0) this.enterBuild(room, hunger);
      return;
    }

    const target = this.targetId ? room.players.get(this.targetId) : null;
    if (!target || !target.alive || target.downed) { this.enterRelax(hunger); return; }
    const tx = target.state[0], tz = target.state[2];
    const dist = Math.hypot(tx - this.x, tz - this.z);
    this.phaseT -= dt;

    // shine: lights held on it slow it; sustained light during a hunt repels it
    let shined = false;
    for (const q of room.players.values()) {
      if (!q.shining || !q.alive || q.downed || !q.hasState) continue;
      const qd = Math.hypot(q.state[0] - this.x, q.state[2] - this.z);
      if (qd < 16 && !losBlocked(room.seed, q.state[0], q.state[2], this.x, this.z)) { shined = true; break; }
    }
    if (shined && this.phase === 'peak-hunt') {
      this.shineAccum += dt;
      if (this.shineAccum > 2.5) {
        room.broadcast({ t: 'retreat', x: this.x, z: this.z });
        this.enterRelax(hunger, 14 + Math.random() * 10);
        return;
      }
    } else {
      this.shineAccum = Math.max(0, this.shineAccum - dt * 0.5);
    }

    // ambient terror while manifested
    this.flickerCd -= dt;
    if (this.flickerCd <= 0) {
      this.flickerCd = this.phase === 'peak-hunt' ? 1.2 : 2.5;
      room.broadcast({ t: 'flicker', x: this.x, z: this.z, r: this.phase === 'peak-hunt' ? 22 : 15 });
    }

    // ------------------------------------------------ build: shadow them
    if (this.phase === 'build') {
      this.mode = 1;
      if (dist > 15) this.moveToward(room, tx, tz, 2.6, dt, shined);
      if (this.phaseT <= 0) {
        const isolation = this.isolationOf(room, target);
        const commit = this.enraged || isolation > 20 || hunger > 0.55;
        if (!this.scareDone || !commit) {
          this.phase = 'peak-scare';
          this.phaseT = 20;
          this.stareT = 2.6;
          this.scareDone = true;
        } else {
          this.phase = 'peak-hunt';
          this.phaseT = 32;
          if (Math.random() < 0.25 + hunger * 0.3) room.blackout(7000 + Math.random() * 5000);
        }
      }
      return;
    }

    // ------------------------------------------------ peak: the scare pass
    if (this.phase === 'peak-scare') {
      this.mode = 1;
      if (dist > 7.5) {
        this.moveToward(room, tx, tz, 4.0, dt, shined);
      } else {
        // stand there. let them see. let them wonder.
        this.stareT -= dt;
        if (dist < 2.5) { this.takedown(room, target, hunger); return; } // they touched it
        if (this.stareT <= 0) { this.enterRelax(hunger); return; }
      }
      if (this.phaseT <= 0) this.enterRelax(hunger);
      return;
    }

    // ------------------------------------------------ peak: the hunt
    this.mode = 2;
    const speed = (4.6 + hunger * 1.2 + room.depth * 0.25) * (shined ? 0.5 : 1);
    this.moveToward(room, tx, tz, speed, dt, shined);
    if (dist < 1.5) { this.takedown(room, target, hunger); return; }
    // no progress? it doesn't walk around obstacles — it stops being where it was
    if (dist > this.lastDist - 0.15) this.stallT += dt; else this.stallT = 0;
    this.lastDist = dist;
    if (this.stallT > 6 && !shined) {
      this.stallT = 0;
      const a = Math.random() * Math.PI * 2;
      const gx = Math.round((tx + Math.cos(a) * 11) / (8 * CELL)) * 8;
      this.x = gx * CELL + CELL / 2;
      this.z = tz + Math.sin(a) * 11;
      this.path = [];
      room.broadcast({ t: 'flicker', x: this.x, z: this.z, r: 25 });
    }
    if (dist > 45 || this.phaseT <= 0) this.enterRelax(hunger);
  }

  private takedown(room: Room, target: Player, hunger: number): void {
    room.downPlayer(target.id);
    this.lastVictim = target.id;
    this.kills++;
    this.avoidFor(target.id, 35); // it plays with its food, one at a time
    this.enterRelax(hunger, 16 + Math.random() * 12);
  }

  private enterBuild(room: Room, hunger: number): void {
    const target = this.pickTarget(room);
    if (!target) { this.phaseT = 8; return; }
    this.targetId = target.id;
    // manifest ~38m out, snapped to a hall line so it always has a way in
    const a = Math.random() * Math.PI * 2;
    const gx = Math.round((target.state[0] + Math.cos(a) * 38) / (8 * CELL)) * 8;
    this.x = gx * CELL + CELL / 2;
    this.z = target.state[2] + Math.sin(a) * 38;
    this.phase = 'build';
    this.phaseT = (12 + Math.random() * 10) * (1 - hunger * 0.5);
    this.path = [];
    this.shineAccum = 0;
    this.stallT = 0;
    this.lastDist = Infinity;
    this.mode = 1;
  }

  private enterRelax(hunger: number, dur?: number): void {
    this.mode = 0;
    this.targetId = null;
    this.path = [];
    // guaranteed breathing room, shrinking as it gets hungrier
    this.phase = 'relax';
    this.phaseT = dur ?? Math.max(9, (26 + Math.random() * 16) * (1 - hunger * 0.6));
  }

  private moveToward(room: Room, tx: number, tz: number, speed: number, dt: number, _shined: boolean): void {
    this.repath -= dt;
    if (this.repath <= 0 || !this.path.length) {
      this.repath = this.phase === 'peak-hunt' ? 0.8 : 2.0;
      const p = astar(room.seed,
        { x: Math.floor(this.x / CELL), z: Math.floor(this.z / CELL) },
        { x: Math.floor(tx / CELL), z: Math.floor(tz / CELL) });
      this.path = p ?? [];
      if (!p && Math.hypot(tx - this.x, tz - this.z) > 3) { this.enterRelax(0.3); return; }
    }
    let wp = this.path[0];
    while (wp) {
      const wx = wp.x * CELL + CELL / 2, wz = wp.z * CELL + CELL / 2;
      if (Math.hypot(wx - this.x, wz - this.z) < 0.9) { this.path.shift(); wp = this.path[0]; continue; }
      break;
    }
    const gx = wp ? wp.x * CELL + CELL / 2 : tx;
    const gz = wp ? wp.z * CELL + CELL / 2 : tz;
    const d = Math.hypot(gx - this.x, gz - this.z) || 1;
    this.x += ((gx - this.x) / d) * speed * dt;
    this.z += ((gz - this.z) / d) * speed * dt;
    const solved = resolveCollision(room.seed, this.x, this.z, 0.3);
    this.x = solved.x; this.z = solved.z;
  }
}
