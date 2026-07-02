// Deterministic infinite Level 0 generator.
// The world is a grid of 4m cells grouped into 8x8-cell "blocks" (32m).
// Cells on block boundary lines (x%8==0 or z%8==0) are always-open halls,
// guaranteeing a connected lattice through the infinite maze. Each block
// interior is filled by an archetype. Everything is a pure function of
// (seed, coords) so every client and the server agree exactly.

import { hash2, r2, rand01 } from './rng';

export const CELL = 4;            // metres per cell
export const BLOCK = 8;           // cells per block
export const WALL_H = 3.1;        // ceiling height
export const LOW_WALL_H = 1.35;   // cubicle partitions
export const WALL_HALF_T = 0.14;
export const PLAYER_R = 0.35;

export type Archetype = 'plain' | 'rooms' | 'pillars' | 'cubicles' | 'pool' | 'landmark';
export type LandmarkKind = 'chair' | 'cabinets' | 'writing' | 'shrine' | 'vending' | 'door' | 'breaker' | 'exit';

/** Breaker panels that must all be pulled before the exit has power. */
export const BREAKERS_NEEDED = 3;

export const mod = (n: number, m: number): number => ((n % m) + m) % m;
export const isHall = (x: number, z: number): boolean => mod(x, BLOCK) === 0 || mod(z, BLOCK) === 0;

// ---------------------------------------------------------------- layout
// The macro layout (exit + breakers) is computed once per seed and memoised —
// blockArchetype is called in every inner worldgen loop.

export interface Layout {
  exit: { bx: number; bz: number };
  breakers: { bx: number; bz: number; id: string }[];
}

const layoutCache = new Map<number, Layout>();

export function layout(seed: number): Layout {
  let l = layoutCache.get(seed);
  if (l) return l;
  const a = r2(seed, 11, 17, 99) * Math.PI * 2;
  const d = 5 + Math.floor(r2(seed, 23, 5, 98) * 3); // 5..7 blocks out (~170-230m)
  let ebx = Math.round(Math.cos(a) * d);
  let ebz = Math.round(Math.sin(a) * d);
  if (ebx === 0 && ebz === 0) ebx = d;

  // three breakers fanned in distinct directions, closer than the exit
  const breakers: Layout['breakers'] = [];
  const base = r2(seed, 3, 9, 97) * Math.PI * 2;
  for (let i = 0; i < BREAKERS_NEEDED; i++) {
    const ba = base + (i * Math.PI * 2) / BREAKERS_NEEDED + (r2(seed, i, 4, 96) - 0.5) * 0.8;
    const bd = 3 + Math.floor(r2(seed, i, 5, 95) * 3); // 3..5 blocks (~100-160m)
    let bx = Math.round(Math.cos(ba) * bd);
    let bz = Math.round(Math.sin(ba) * bd);
    if ((bx === ebx && bz === ebz) || (bx === 0 && bz === 0)) bx += 1;
    while (breakers.some((o) => o.bx === bx && o.bz === bz)) bx += 1;
    breakers.push({ bx, bz, id: `${bx}:${bz}` });
  }
  l = { exit: { bx: ebx, bz: ebz }, breakers };
  layoutCache.set(seed, l);
  return l;
}

export function exitBlock(seed: number): { bx: number; bz: number } {
  return layout(seed).exit;
}

/** World-space centre of each breaker panel. */
export function breakerSpots(seed: number): { id: string; x: number; z: number }[] {
  return layout(seed).breakers.map((b) => ({
    id: b.id,
    x: (b.bx * BLOCK + 4) * CELL + CELL / 2,
    z: (b.bz * BLOCK + 4) * CELL + CELL / 2,
  }));
}

/** World-space centre of the exit doorway. */
export function exitPos(seed: number): { x: number; z: number } {
  const { bx, bz } = exitBlock(seed);
  return { x: (bx * BLOCK + 4) * CELL + CELL / 2, z: (bz * BLOCK + 4) * CELL + CELL / 2 };
}

// ---------------------------------------------------------------- blocks

export function blockArchetype(seed: number, bx: number, bz: number): Archetype {
  const l = layout(seed);
  if (bx === l.exit.bx && bz === l.exit.bz) return 'landmark';
  if (l.breakers.some((b) => b.bx === bx && b.bz === bz)) return 'landmark';
  const r = r2(seed, bx, bz, 7);
  if (r < 0.30) return 'plain';
  if (r < 0.60) return 'rooms';
  if (r < 0.76) return 'pillars';
  if (r < 0.87) return 'cubicles';
  if (r < 0.945) return 'pool';
  return 'landmark';
}

export function landmarkKind(seed: number, bx: number, bz: number): LandmarkKind {
  const l = layout(seed);
  if (bx === l.exit.bx && bz === l.exit.bz) return 'exit';
  if (l.breakers.some((b) => b.bx === bx && b.bz === bz)) return 'breaker';
  const kinds: LandmarkKind[] = ['chair', 'cabinets', 'writing', 'shrine', 'vending', 'door'];
  return kinds[hash2(seed, bx, bz, 31) % kinds.length];
}

/** Blocks whose lights are dead — pools of true dark. */
export function blockDark(seed: number, bx: number, bz: number): boolean {
  if (blockArchetype(seed, bx, bz) === 'landmark') return false;
  return r2(seed, bx, bz, 8) < 0.07;
}

// ---------------------------------------------------------------- walls
// 0 = none, 1 = low (cubicle), 2 = full height.

/** Wall on the north edge of cell (x,z) — between (x,z) and (x,z-1). */
export function wallN(seed: number, x: number, z: number): number {
  if (isHall(x, z) || isHall(x, z - 1)) return 0;
  const bx = Math.floor(x / BLOCK), bz = Math.floor(z / BLOCK);
  const a = blockArchetype(seed, bx, bz);
  if (a === 'rooms') return r2(seed, x, z, 1) < 0.44 ? 2 : 0;
  if (a === 'cubicles') return r2(seed, x, z, 1) < 0.52 ? 1 : 0;
  return 0;
}

/** Wall on the west edge of cell (x,z) — between (x,z) and (x-1,z). */
export function wallW(seed: number, x: number, z: number): number {
  if (isHall(x, z) || isHall(x - 1, z)) return 0;
  const bx = Math.floor(x / BLOCK), bz = Math.floor(z / BLOCK);
  const a = blockArchetype(seed, bx, bz);
  if (a === 'rooms') return r2(seed, x, z, 2) < 0.44 ? 2 : 0;
  if (a === 'cubicles') return r2(seed, x, z, 2) < 0.52 ? 1 : 0;
  return 0;
}

export function pillarAt(seed: number, x: number, z: number): boolean {
  if (isHall(x, z)) return false;
  const bx = Math.floor(x / BLOCK), bz = Math.floor(z / BLOCK);
  const a = blockArchetype(seed, bx, bz);
  if (a === 'pillars') return mod(x, 2) === 1 && mod(z, 2) === 1 && r2(seed, x, z, 3) < 0.85;
  if (a === 'pool') return mod(x, 4) === 2 && mod(z, 4) === 2;
  return false;
}

// Ceiling light fixtures. Hall lines get their own cadence.
export function fixtureAt(seed: number, x: number, z: number): boolean {
  const inner = mod(x, 2) === 1 && mod(z, 2) === 1;
  const hallX = mod(x, BLOCK) === 0 && mod(z, 2) === 1;
  const hallZ = mod(z, BLOCK) === 0 && mod(x, 2) === 1;
  return inner || hallX || hallZ;
}

export function fixtureDead(seed: number, x: number, z: number): boolean {
  const bx = Math.floor(x / BLOCK), bz = Math.floor(z / BLOCK);
  if (blockDark(seed, bx, bz)) return r2(seed, x, z, 5) > 0.12; // dark blocks: nearly all dead
  return r2(seed, x, z, 5) < 0.08;
}

// ---------------------------------------------------------------- pickups

/** Almond water spawn for a block, or null. id is "bx:bz". */
export function almondAt(seed: number, bx: number, bz: number): { id: string; x: number; z: number } | null {
  const a = blockArchetype(seed, bx, bz);
  const isShrine = a === 'landmark' && landmarkKind(seed, bx, bz) === 'shrine';
  if (!isShrine && r2(seed, bx, bz, 21) > 0.28) return null;
  const ox = 1 + (hash2(seed, bx, bz, 22) % 6);
  const oz = 1 + (hash2(seed, bx, bz, 23) % 6);
  const cx = isShrine ? bx * BLOCK + 4 : bx * BLOCK + ox;
  const cz = isShrine ? bz * BLOCK + 4 : bz * BLOCK + oz;
  return { id: `${bx}:${bz}`, x: cx * CELL + CELL / 2, z: cz * CELL + CELL / 2 };
}

// ---------------------------------------------------------------- spawns

/** Scattered spawn points on hall lines, 40-75m from origin. */
export function spawnPoint(seed: number, index: number): { x: number; z: number } {
  const golden = 2.399963;
  const a = rand01(hash2(seed, 41, 43, 50)) * Math.PI * 2 + index * golden;
  const r = 40 + rand01(hash2(seed, index, 91, 51)) * 35;
  // snap to the nearest hall column so nobody spawns inside a wall
  const cx = Math.round((Math.cos(a) * r) / (BLOCK * CELL)) * BLOCK;
  const cz = Math.round((Math.sin(a) * r) / CELL);
  return { x: cx * CELL + CELL / 2, z: cz * CELL + CELL / 2 };
}

// ---------------------------------------------------------------- physics

function pushCircleAABB(px: number, pz: number, r: number, x0: number, z0: number, x1: number, z1: number): [number, number] {
  const cx = Math.max(x0, Math.min(px, x1));
  const cz = Math.max(z0, Math.min(pz, z1));
  let dx = px - cx, dz = pz - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 > r * r) return [px, pz];
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    return [cx + (dx / d) * r, cz + (dz / d) * r];
  }
  // centre is inside the box: push out along the shallowest axis
  const lx = Math.min(px - x0, x1 - px), lz = Math.min(pz - z0, z1 - pz);
  if (lx < lz) return [px < (x0 + x1) / 2 ? x0 - r : x1 + r, pz];
  return [px, pz < (z0 + z1) / 2 ? z0 - r : z1 + r];
}

/** Slide a circle of radius r out of all nearby walls/pillars. */
export function resolveCollision(seed: number, px: number, pz: number, r: number): { x: number; z: number } {
  const t = WALL_HALF_T;
  for (let pass = 0; pass < 2; pass++) {
    const cx = Math.floor(px / CELL), cz = Math.floor(pz / CELL);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const gx = cx + dx, gz = cz + dz;
        if (wallN(seed, gx, gz) > 0) {
          [px, pz] = pushCircleAABB(px, pz, r, gx * CELL - t, gz * CELL - t, (gx + 1) * CELL + t, gz * CELL + t);
        }
        if (wallW(seed, gx, gz) > 0) {
          [px, pz] = pushCircleAABB(px, pz, r, gx * CELL - t, gz * CELL - t, gx * CELL + t, (gz + 1) * CELL + t);
        }
        if (pillarAt(seed, gx, gz)) {
          const mx = gx * CELL + CELL / 2, mz = gz * CELL + CELL / 2;
          [px, pz] = pushCircleAABB(px, pz, r, mx - 0.35, mz - 0.35, mx + 0.35, mz + 0.35);
        }
      }
    }
  }
  return { x: px, z: pz };
}

/** True if a full-height wall crosses the segment between two world points. */
export function losBlocked(seed: number, ax: number, az: number, bx: number, bz: number): boolean {
  const dx = bx - ax, dz = bz - az;
  const dist = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(dist / 0.5));
  let cxPrev = Math.floor(ax / CELL), czPrev = Math.floor(az / CELL);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = ax + dx * t, z = az + dz * t;
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    if (cx !== cxPrev) {
      const wx = Math.max(cx, cxPrev);
      if (wallW(seed, wx, czPrev) === 2) return true;
    }
    if (cz !== czPrev) {
      const wz = Math.max(cz, czPrev);
      if (wallN(seed, cxPrev, wz) === 2) return true;
    }
    // diagonal corner-cut: also check the second edge of the corner
    if (cx !== cxPrev && cz !== czPrev) {
      const wx = Math.max(cx, cxPrev), wz = Math.max(cz, czPrev);
      if (wallW(seed, wx, cz) === 2 || wallN(seed, cx, wz) === 2) return true;
    }
    cxPrev = cx; czPrev = cz;
  }
  return false;
}

/** Can an agent step from cell a to adjacent cell b? Full walls block; low walls block players but the entity climbs them (pass entity=true). */
export function cellBlocked(seed: number, ax: number, az: number, bx: number, bz: number, entity = false): boolean {
  const min = entity ? 2 : 1; // wall level that blocks
  if (bz === az - 1 && bx === ax) return wallN(seed, ax, az) >= min;
  if (bz === az + 1 && bx === ax) return wallN(seed, ax, az + 1) >= min;
  if (bx === ax - 1 && bz === az) return wallW(seed, ax, az) >= min;
  if (bx === ax + 1 && bz === az) return wallW(seed, ax + 1, az) >= min;
  return true;
}
