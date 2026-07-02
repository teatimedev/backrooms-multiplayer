// The Entity. Server-authoritative so every player shares one nightmare.
// It targets the most isolated living player, stalks, then commits.
import { CELL, cellBlocked, resolveCollision } from '../../shared/src/worldgen.js';
import type { Room, Player } from './room.js';

const SPAWN_GRACE = 45;         // seconds before the first stalk
const STALK_TIME = 55;          // give up after this long without a kill window

type Cell = { x: number; z: number };

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
  mode: 0 | 1 | 2 = 0;
  x = 0; z = 0;
  targetId: string | null = null;
  timer = SPAWN_GRACE;
  aggression = 0;
  stunned = 0;
  private path: Cell[] = [];
  private repath = 0;
  private flickerCd = 0;
  private mimicCd = 120;

  reset(): void {
    this.mode = 0; this.targetId = null; this.timer = SPAWN_GRACE; this.aggression = 0; this.path = [];
  }

  /** Isolation score: distance to the nearest OTHER living player. Solo players are maximally isolated. */
  private pickTarget(room: Room): Player | null {
    const alive = [...room.players.values()].filter((p) => p.alive && p.hasState);
    if (!alive.length) return null;
    let best: Player | null = null, bestScore = -1;
    for (const p of alive) {
      let nearest = Infinity;
      for (const q of alive) {
        if (q === p) continue;
        nearest = Math.min(nearest, Math.hypot(q.state[0] - p.state[0], q.state[2] - p.state[2]));
      }
      const score = alive.length === 1 ? 9999 : nearest;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best;
  }

  update(room: Room, dt: number): void {
    if (this.stunned > 0) { this.stunned -= dt; return; }
    this.mimicCd -= dt;

    if (this.mode === 0) {
      this.timer -= dt;
      // audio mimicry: the maze whispers with borrowed footsteps
      if (this.mimicCd <= 0 && room.ageSec() > 240) {
        this.mimicCd = 60 + Math.random() * 90;
        const alive = [...room.players.values()].filter((p) => p.alive && p.hasState);
        if (alive.length) {
          const v = alive[Math.floor(Math.random() * alive.length)];
          const a = Math.random() * Math.PI * 2;
          room.sendTo(v.id, { t: 'mimic', x: v.state[0] + Math.cos(a) * 9, z: v.state[2] + Math.sin(a) * 9, kind: Math.random() < 0.6 ? 'steps' : 'voice' });
        }
      }
      if (this.timer <= 0) {
        const target = this.pickTarget(room);
        if (!target) { this.timer = 10; return; }
        this.targetId = target.id;
        // materialise ~35m from the target, snapped to a hall line
        const a = Math.random() * Math.PI * 2;
        const gx = Math.round((target.state[0] + Math.cos(a) * 35) / (8 * CELL)) * 8;
        this.x = gx * CELL + CELL / 2;
        this.z = target.state[2] + Math.sin(a) * 35;
        this.mode = 1;
        this.timer = STALK_TIME;
        this.path = [];
      }
      return;
    }

    const target = this.targetId ? room.players.get(this.targetId) : null;
    if (!target || !target.alive) { this.despawn(); return; }
    const tx = target.state[0], tz = target.state[2];
    const dist = Math.hypot(tx - this.x, tz - this.z);

    // pathfind toward the target
    this.repath -= dt;
    if (this.repath <= 0 || !this.path.length) {
      this.repath = this.mode === 2 ? 0.8 : 2.0;
      const p = astar(room.seed,
        { x: Math.floor(this.x / CELL), z: Math.floor(this.z / CELL) },
        { x: Math.floor(tx / CELL), z: Math.floor(tz / CELL) });
      this.path = p ?? [];
      if (!p && dist > 3) { this.despawn(); return; } // sealed off — melt back into the walls
    }

    const speed = this.mode === 2 ? 4.7 + this.aggression * 0.35 : 2.3 + this.aggression * 0.2;
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

    // lights die around it
    this.flickerCd -= dt;
    if (this.flickerCd <= 0) {
      this.flickerCd = this.mode === 2 ? 1.2 : 2.5;
      room.broadcast({ t: 'flicker', x: this.x, z: this.z, r: this.mode === 2 ? 22 : 15 });
    }

    if (this.mode === 1) {
      this.timer -= dt;
      const isolation = this.isolationOf(room, target);
      if ((dist < 15 && isolation > 22) || dist < 6 || this.aggression >= 3) this.mode = 2;
      if (this.timer <= 0) { this.despawn(); return; }
    } else {
      if (dist > 45) { this.mode = 1; this.timer = STALK_TIME * 0.6; }
      if (dist < 1.4) {
        room.killPlayer(target.id);
        this.aggression++;
        this.despawn(8 + Math.random() * 10);
      }
    }
  }

  private isolationOf(room: Room, p: Player): number {
    let nearest = Infinity;
    for (const q of room.players.values()) {
      if (q === p || !q.alive || !q.hasState) continue;
      nearest = Math.min(nearest, Math.hypot(q.state[0] - p.state[0], q.state[2] - p.state[2]));
    }
    return nearest;
  }

  despawn(cooldown?: number): void {
    this.mode = 0;
    this.targetId = null;
    this.timer = cooldown ?? Math.max(14, 35 - this.aggression * 5) + Math.random() * 15;
    this.path = [];
  }
}
