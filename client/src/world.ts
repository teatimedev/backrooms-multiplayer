// Chunked infinite world. One chunk == one 8x8-cell block (32m).
// Walls/pillars/fixtures are InstancedMeshes; floors and ceilings are single
// planes per chunk. Everything derives from the shared worldgen functions.
import * as THREE from 'three';
import {
  BLOCK, CELL, WALL_H, LOW_WALL_H, WALL_HALF_T,
  blockArchetype, blockDark, landmarkKind, wallN, wallW, pillarAt, shelfAt,
  fixtureAt, fixtureDead, almondAt, exitPos, breakerSpots, roundModifier,
} from '@shared/worldgen';
import { hash2, rand01, mulberry32 } from '@shared/rng';
import * as tx from './textures';

const LOAD_R = 2;    // blocks
const UNLOAD_R = 4;

/** Visual identity per descent level. Geometry is untouched — only skin. */
export interface Theme {
  name: string;
  fixture: number;        // light colour
  fogColor: number; fogDensity: number;
  hemiSky: number; hemiGround: number; hemiIntensity: number;
  wallsAre: 'wallpaper' | 'concrete' | 'pool';
  floorsAre: 'carpet' | 'concrete' | 'pool';
}

export const THEMES: Theme[] = [
  { name: 'LEVEL 0', fixture: 0xfff0bd, fogColor: 0x241d0e, fogDensity: 0.05, hemiSky: 0x8a7c4d, hemiGround: 0x2e2410, hemiIntensity: 0.85, wallsAre: 'wallpaper', floorsAre: 'carpet' },
  { name: 'LEVEL 1 · THE GARAGE', fixture: 0xffc98a, fogColor: 0x191410, fogDensity: 0.058, hemiSky: 0x6a5a42, hemiGround: 0x1c1712, hemiIntensity: 0.7, wallsAre: 'concrete', floorsAre: 'concrete' },
  { name: 'THE POOLROOMS', fixture: 0xd8f2ff, fogColor: 0x13232a, fogDensity: 0.045, hemiSky: 0x6e8f9c, hemiGround: 0x14262c, hemiIntensity: 0.8, wallsAre: 'pool', floorsAre: 'pool' },
];

export interface Fixture { x: number; z: number; dead: boolean; phase: number; cool: boolean }
interface FlickerEvent { x: number; z: number; r: number; t0: number }

interface Chunk {
  group: THREE.Group;
  fixtures: Fixture[];
  fixtureMesh: THREE.InstancedMesh | null;
  glowMesh: THREE.InstancedMesh | null;
  almond: { id: string; mesh: THREE.Group } | null;
}

function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.28)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export interface Breaker {
  id: string;
  x: number;
  z: number;
  collected: boolean;
  lever: THREE.Mesh | null;   // null until its chunk is built
  strip: THREE.Mesh | null;
  light: THREE.PointLight | null;
}

export class World {
  scene: THREE.Scene;
  seed: number;
  chunks = new Map<string, Chunk>();
  fixturesNear: Fixture[] = [];
  flickers: FlickerEvent[] = [];
  taken = new Set<string>();
  exit: { x: number; z: number };
  exitLight: THREE.PointLight | null = null;
  exitVoid: THREE.Mesh | null = null;
  breakers = new Map<string, Breaker>();
  powered = false;
  blackoutUntil = 0;
  doors: { x: number; z: number; slab: THREE.Mesh; brick: THREE.Mesh; opened: boolean }[] = [];
  private waterMeshes: THREE.Mesh[] = [];
  private wet: boolean; // flood modifier or poolrooms: pool blocks hold water

  theme: Theme;
  depth: number;
  private mats: Record<string, THREE.Material>;
  private wallGeo = new THREE.BoxGeometry(1, 1, 1);
  private fixtureGeo = new THREE.BoxGeometry(1.7, 0.09, 0.55);
  private glowGeo = new THREE.PlaneGeometry(3.4, 3.4);
  private wallsRaycast: THREE.Object3D[] = [];
  private tmpM = new THREE.Matrix4();
  private tmpC = new THREE.Color();

  constructor(scene: THREE.Scene, seed: number, taken: string[], collectedBreakers: string[] = [], depth = 0) {
    this.scene = scene;
    this.seed = seed;
    this.depth = depth;
    this.theme = THEMES[Math.min(depth, THEMES.length - 1)];
    this.taken = new Set(taken);
    this.exit = exitPos(seed);
    this.wet = depth >= 2 || roundModifier(seed) === 'flood';
    const collected = new Set(collectedBreakers);
    for (const b of breakerSpots(seed)) {
      this.breakers.set(b.id, { id: b.id, x: b.x, z: b.z, collected: collected.has(b.id), lever: null, strip: null, light: null });
    }
    this.powered = collected.size >= 3;
    const wallpaper = new THREE.MeshStandardMaterial({ map: tx.wallpaperTex(), roughness: 0.92 });
    const concrete = new THREE.MeshStandardMaterial({ map: tx.concreteTex(), roughness: 0.85 });
    const pool = new THREE.MeshStandardMaterial({ map: tx.poolTileTex(), roughness: 0.3, metalness: 0.06 });
    const carpet = new THREE.MeshStandardMaterial({ map: tx.carpetTex(), roughness: 1 });
    const t = this.theme;
    this.mats = {
      wall: t.wallsAre === 'wallpaper' ? wallpaper : t.wallsAre === 'concrete' ? concrete : pool,
      carpet: t.floorsAre === 'carpet' ? carpet : t.floorsAre === 'concrete' ? concrete : pool,
      ceiling: t.wallsAre === 'pool' ? pool : t.wallsAre === 'concrete'
        ? new THREE.MeshStandardMaterial({ map: tx.concreteTex(), roughness: 0.9, color: 0x9a9a9a })
        : new THREE.MeshStandardMaterial({ map: tx.ceilingTex(), roughness: 0.95 }),
      concrete,
      pool,
      cubicle: t.wallsAre === 'wallpaper'
        ? new THREE.MeshStandardMaterial({ map: tx.cubicleTex(), roughness: 1 })
        : concrete,
      fixture: new THREE.MeshBasicMaterial({ color: 0xffffff }),
      glow: new THREE.MeshBasicMaterial({
        map: glowTexture(), transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide,
      }),
      dark: new THREE.MeshStandardMaterial({ color: 0x14120c, roughness: 0.9 }),
      base: new THREE.MeshStandardMaterial({ color: 0x2a2317, roughness: 0.85 }),
      junk: new THREE.MeshStandardMaterial({ color: 0x5c4f38, roughness: 0.95 }),
      desk: new THREE.MeshStandardMaterial({ color: 0x4a4034, roughness: 0.7 }),
    };
  }

  /** All meshes a chalk raycast may hit (walls + floors + ceilings). */
  raycastTargets(): THREE.Object3D[] { return this.wallsRaycast; }

  surfaceAt(x: number, z: number): 'carpet' | 'tile' | 'concrete' | 'water' {
    const bx = Math.floor(x / (BLOCK * CELL)), bz = Math.floor(z / (BLOCK * CELL));
    const a = blockArchetype(this.seed, bx, bz);
    if (a === 'pool') return this.wet ? 'water' : 'tile';
    if (a === 'landmark') return 'concrete';
    if (this.theme.floorsAre === 'concrete') return 'concrete';
    if (this.theme.floorsAre === 'pool') return 'tile';
    return 'carpet';
  }

  update(px: number, pz: number, time: number): void {
    const pbx = Math.floor(px / (BLOCK * CELL)), pbz = Math.floor(pz / (BLOCK * CELL));
    for (let dz = -LOAD_R; dz <= LOAD_R; dz++) {
      for (let dx = -LOAD_R; dx <= LOAD_R; dx++) {
        const key = `${pbx + dx},${pbz + dz}`;
        if (!this.chunks.has(key)) this.buildChunk(pbx + dx, pbz + dz);
      }
    }
    for (const [key, chunk] of this.chunks) {
      const [bx, bz] = key.split(',').map(Number);
      if (Math.max(Math.abs(bx - pbx), Math.abs(bz - pbz)) > UNLOAD_R) {
        this.scene.remove(chunk.group);
        chunk.group.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.geometry && m.geometry !== this.wallGeo && m.geometry !== this.fixtureGeo) m.geometry.dispose();
        });
        this.wallsRaycast = this.wallsRaycast.filter((o) => !chunk.group.children.includes(o));
        this.waterMeshes = this.waterMeshes.filter((w) => w.parent);
        this.doors = this.doors.filter((d) => d.slab.parent);
        this.chunks.delete(key);
      }
    }
    // refresh nearby fixture list + animate fixture emissive tint
    this.fixturesNear = [];
    this.flickers = this.flickers.filter((f) => time - f.t0 < 1.4);
    for (const [key, chunk] of this.chunks) {
      const [bx, bz] = key.split(',').map(Number);
      if (Math.max(Math.abs(bx - pbx), Math.abs(bz - pbz)) > 1) continue;
      for (const f of chunk.fixtures) if (!f.dead) this.fixturesNear.push(f);
      if (chunk.fixtureMesh) {
        const base = new THREE.Color(this.theme.fixture);
        const cool = new THREE.Color(0xd8f2ff);
        chunk.fixtures.forEach((f, i) => {
          const lvl = f.dead ? 0.02 : this.lightLevel(f, time);
          this.tmpC.copy(f.cool ? cool : base).multiplyScalar(lvl);
          chunk.fixtureMesh!.setColorAt(i, this.tmpC);
          if (chunk.glowMesh) {
            this.tmpC.multiplyScalar(lvl * 0.85);
            chunk.glowMesh.setColorAt(i, this.tmpC);
          }
        });
        chunk.fixtureMesh.instanceColor!.needsUpdate = true;
        if (chunk.glowMesh) chunk.glowMesh.instanceColor!.needsUpdate = true;
      }
    }
    if (this.exitLight) {
      this.exitLight.intensity = this.powered ? 2.6 + Math.sin(time * 1.7) * 0.7 : 0;
    }
    for (const w of this.waterMeshes) {
      const m = w.material as THREE.MeshStandardMaterial;
      m.opacity = 0.32 + Math.sin(time * 0.9 + w.position.x * 0.13) * 0.05;
      if (m.map) { m.map.offset.x = Math.sin(time * 0.12) * 0.02; m.map.offset.y = time * 0.004; }
    }
    for (const b of this.breakers.values()) {
      if (!b.light) continue;
      // uncollected: nervous amber sparking · collected: steady green
      b.light.intensity = b.collected ? 2.0 : (Math.random() < 0.08 ? 4.5 : 1.3 + Math.random() * 0.8);
    }
  }

  /** The red door. It opens exactly once, onto bricks. Returns true first time. */
  tryOpenDoor(px: number, pz: number): boolean {
    for (const d of this.doors) {
      if (d.opened || Math.hypot(d.x - px, d.z - pz) > 2.4) continue;
      d.opened = true;
      d.slab.rotation.y = -1.9;
      d.slab.position.x += 0.35;
      d.slab.position.z -= 0.45;
      d.brick.visible = true;
      return true;
    }
    return false;
  }

  nearUnopenedDoor(px: number, pz: number): boolean {
    return this.doors.some((d) => !d.opened && Math.hypot(d.x - px, d.z - pz) < 2.4);
  }

  collectBreaker(id: string): void {
    const b = this.breakers.get(id);
    if (!b) return;
    b.collected = true;
    if (b.lever) b.lever.rotation.x = 0.9;
    if (b.strip) (b.strip.material as THREE.MeshBasicMaterial).color.setHex(0x4dff88);
    if (b.light) b.light.color.setHex(0x4dff88);
  }

  setPowered(): void {
    this.powered = true;
    if (this.exitVoid) {
      (this.exitVoid.material as THREE.MeshBasicMaterial).color.setHex(0x0e1c22);
    }
  }

  /** 0..1 brightness of a fixture right now — buzzy, occasionally dropping out. */
  lightLevel(f: Fixture, time: number): number {
    if (time < this.blackoutUntil) {
      // total blackout: a few fixtures gutter at a few percent
      return f.phase > 0.85 ? 0.05 + 0.03 * Math.sin(time * 31 + f.phase * 40) : 0.005;
    }
    let lvl = 0.92 + 0.08 * Math.sin(time * 47 + f.phase * 20);
    const drop = Math.sin(time * 1.9 + f.phase * 37) * Math.sin(time * 4.7 + f.phase * 91);
    if (drop > 0.985) lvl *= 0.15;
    for (const ev of this.flickers) {
      const d = Math.hypot(f.x - ev.x, f.z - ev.z);
      if (d < ev.r) {
        const age = time - ev.t0;
        lvl *= 0.15 + 0.85 * Math.abs(Math.sin(age * 31 + f.phase * 10)) * Math.min(1, age * 3);
      }
    }
    return lvl;
  }

  addFlicker(x: number, z: number, r: number, time: number): void {
    this.flickers.push({ x, z, r, t0: time });
  }

  takePickup(id: string): { x: number; z: number } | null {
    this.taken.add(id);
    for (const chunk of this.chunks.values()) {
      if (chunk.almond?.id === id) {
        const p = chunk.almond.mesh.position;
        chunk.group.remove(chunk.almond.mesh);
        chunk.almond = null;
        return { x: p.x, z: p.z };
      }
    }
    return null;
  }

  // ------------------------------------------------------------ building

  private buildChunk(bx: number, bz: number): void {
    const seed = this.seed;
    const group = new THREE.Group();
    const arch = blockArchetype(seed, bx, bz);
    const ox = bx * BLOCK * CELL, oz = bz * BLOCK * CELL;
    const size = BLOCK * CELL;

    // per-chunk tint clones kill the texture-repeat shimmer
    const tint = 0.9 + rand01(hash2(seed, bx, bz, 51)) * 0.2;
    const floorBase = arch === 'pool' ? this.mats.pool : arch === 'landmark' ? this.mats.concrete : this.mats.carpet;
    const floorMat = (floorBase as THREE.MeshStandardMaterial).clone();
    floorMat.color.multiplyScalar(tint);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(size, size), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(ox + size / 2, 0, oz + size / 2);
    floor.receiveShadow = true;
    group.add(floor);
    this.wallsRaycast.push(floor);

    const ceilBase = arch === 'pool' ? this.mats.pool : this.mats.ceiling;
    const ceilMat = (ceilBase as THREE.MeshStandardMaterial).clone();
    ceilMat.color.multiplyScalar(0.85 + rand01(hash2(seed, bx, bz, 52)) * 0.2);
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(size, size), ceilMat);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(ox + size / 2, WALL_H, oz + size / 2);
    group.add(ceil);
    this.wallsRaycast.push(ceil);

    // gather geometry instances
    const full: THREE.Matrix4[] = [];
    const low: THREE.Matrix4[] = [];
    const pillars: THREE.Matrix4[] = [];
    const shelves: THREE.Matrix4[] = [];
    const bases: THREE.Matrix4[] = [];
    const fixtures: Fixture[] = [];
    const t2 = WALL_HALF_T * 2;
    const isCool = arch === 'pool';

    for (let lz = 0; lz < BLOCK; lz++) {
      for (let lx = 0; lx < BLOCK; lx++) {
        const x = bx * BLOCK + lx, z = bz * BLOCK + lz;
        const wn = wallN(seed, x, z);
        if (wn > 0) {
          const h = wn === 2 ? WALL_H : LOW_WALL_H;
          const m = new THREE.Matrix4().compose(
            new THREE.Vector3(x * CELL + CELL / 2, h / 2, z * CELL),
            new THREE.Quaternion(),
            new THREE.Vector3(CELL + t2, h, t2));
          (wn === 2 ? full : low).push(m);
          if (wn === 2) bases.push(new THREE.Matrix4().compose(
            new THREE.Vector3(x * CELL + CELL / 2, 0.07, z * CELL),
            new THREE.Quaternion(),
            new THREE.Vector3(CELL + t2, 0.14, t2 + 0.05)));
        }
        const ww = wallW(seed, x, z);
        if (ww > 0) {
          const h = ww === 2 ? WALL_H : LOW_WALL_H;
          const m = new THREE.Matrix4().compose(
            new THREE.Vector3(x * CELL, h / 2, z * CELL + CELL / 2),
            new THREE.Quaternion(),
            new THREE.Vector3(t2, h, CELL + t2));
          (ww === 2 ? full : low).push(m);
          if (ww === 2) bases.push(new THREE.Matrix4().compose(
            new THREE.Vector3(x * CELL, 0.07, z * CELL + CELL / 2),
            new THREE.Quaternion(),
            new THREE.Vector3(t2 + 0.05, 0.14, CELL + t2)));
        }
        if (pillarAt(seed, x, z)) {
          pillars.push(new THREE.Matrix4().compose(
            new THREE.Vector3(x * CELL + CELL / 2, WALL_H / 2, z * CELL + CELL / 2),
            new THREE.Quaternion(),
            new THREE.Vector3(0.7, WALL_H, 0.7)));
        }
        if (shelfAt(seed, x, z)) {
          shelves.push(new THREE.Matrix4().compose(
            new THREE.Vector3(x * CELL + CELL / 2, 1.1, z * CELL + CELL / 2),
            new THREE.Quaternion(),
            new THREE.Vector3(3.7, 2.2, 0.8)));
        }
        if (fixtureAt(seed, x, z)) {
          fixtures.push({
            x: x * CELL + CELL / 2, z: z * CELL + CELL / 2,
            dead: fixtureDead(seed, x, z),
            phase: rand01(hash2(seed, x, z, 6)),
            cool: isCool,
          });
        }
      }
    }

    const addInstanced = (mats: THREE.Matrix4[], material: THREE.Material, raycast: boolean, shadow = true): THREE.InstancedMesh | null => {
      if (!mats.length) return null;
      const im = new THREE.InstancedMesh(this.wallGeo, material, mats.length);
      mats.forEach((m, i) => im.setMatrixAt(i, m));
      im.castShadow = shadow; im.receiveShadow = true;
      group.add(im);
      if (raycast) this.wallsRaycast.push(im);
      return im;
    };
    addInstanced(full, this.mats.wall, true);
    addInstanced(low, this.mats.cubicle, true);
    addInstanced(pillars, arch === 'pool' ? this.mats.pool : this.mats.wall, true);
    addInstanced(shelves, this.mats.cubicle, true);
    addInstanced(bases, this.mats.base, false, false);

    let fixtureMesh: THREE.InstancedMesh | null = null;
    let glowMesh: THREE.InstancedMesh | null = null;
    if (fixtures.length) {
      fixtureMesh = new THREE.InstancedMesh(this.fixtureGeo, this.mats.fixture, fixtures.length);
      glowMesh = new THREE.InstancedMesh(this.glowGeo, this.mats.glow, fixtures.length);
      const flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
      fixtures.forEach((f, i) => {
        this.tmpM.makeTranslation(f.x, WALL_H - 0.05, f.z);
        fixtureMesh!.setMatrixAt(i, this.tmpM);
        fixtureMesh!.setColorAt(i, this.tmpC.setRGB(0.9, 0.86, 0.7));
        // additive halo hugging the ceiling under the tube
        this.tmpM.compose(new THREE.Vector3(f.x, WALL_H - 0.12, f.z), flat, new THREE.Vector3(1, 1, 1));
        glowMesh!.setMatrixAt(i, this.tmpM);
        glowMesh!.setColorAt(i, this.tmpC.setRGB(0.5, 0.47, 0.35));
      });
      group.add(fixtureMesh, glowMesh);
    }

    // scattered junk: the backrooms are abandoned, not empty
    const junkRnd = mulberry32(hash2(seed, bx, bz, 60));
    if (arch !== 'landmark' && arch !== 'storage') {
      const clutter = roundModifier(seed) === 'clutter' ? 3 : 0;
      const n = 1 + Math.floor(junkRnd() * 3) + clutter;
      for (let i = 0; i < n; i++) {
        const lx = 1 + Math.floor(junkRnd() * 6), lz = 1 + Math.floor(junkRnd() * 6);
        const jx = (bx * BLOCK + lx) * CELL + 0.8 + junkRnd() * 2.4;
        const jz = (bz * BLOCK + lz) * CELL + 0.8 + junkRnd() * 2.4;
        const kind = junkRnd();
        if (kind < 0.5) {
          // cardboard boxes, sagging
          const stack = 1 + Math.floor(junkRnd() * 2);
          for (let b = 0; b < stack; b++) {
            const s = 0.45 + junkRnd() * 0.25;
            const box = new THREE.Mesh(this.wallGeo, this.mats.junk);
            box.scale.set(s, s * 0.8, s);
            box.position.set(jx + (junkRnd() - 0.5) * 0.2, s * 0.4 + b * s * 0.78, jz + (junkRnd() - 0.5) * 0.2);
            box.rotation.y = junkRnd() * Math.PI;
            group.add(box);
          }
        } else if (kind < 0.62) {
          // papers on the damp carpet
          const paper = new THREE.Mesh(new THREE.PlaneGeometry(0.7 + junkRnd() * 0.7, 0.5 + junkRnd() * 0.5),
            new THREE.MeshStandardMaterial({ color: 0xb5ad95, roughness: 1 }));
          paper.rotation.set(-Math.PI / 2, 0, junkRnd() * Math.PI);
          paper.position.set(jx, 0.012, jz);
          group.add(paper);
        } else if (kind < 0.78) {
          // a chair, knocked over long ago
          const chair = new THREE.Mesh(this.wallGeo, this.mats.desk);
          chair.scale.set(0.45, 0.08, 0.5);
          chair.position.set(jx, 0.25, jz);
          chair.rotation.set(junkRnd() * 0.6 + 1.2, junkRnd() * Math.PI, 0);
          group.add(chair);
        } else if (kind < 0.9) {
          // a dead office plant, still in its pot
          const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.12, 0.28, 8),
            new THREE.MeshStandardMaterial({ color: 0x6e4a32, roughness: 0.9 }));
          pot.position.set(jx, 0.14, jz);
          group.add(pot);
          for (let s = 0; s < 4; s++) {
            const stem = new THREE.Mesh(this.wallGeo,
              new THREE.MeshStandardMaterial({ color: 0x4a422a, roughness: 1 }));
            stem.scale.set(0.02, 0.4 + junkRnd() * 0.25, 0.02);
            stem.position.set(jx + (junkRnd() - 0.5) * 0.1, 0.45, jz + (junkRnd() - 0.5) * 0.1);
            stem.rotation.set((junkRnd() - 0.5) * 0.9, 0, (junkRnd() - 0.5) * 0.9);
            group.add(stem);
          }
        } else {
          // a water cooler. empty, obviously.
          const base = new THREE.Mesh(this.wallGeo, this.mats.desk);
          base.scale.set(0.34, 1.0, 0.34);
          base.position.set(jx, 0.5, jz);
          group.add(base);
          const jug = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.4, 10),
            new THREE.MeshStandardMaterial({ color: 0x9fc8d8, roughness: 0.2, transparent: true, opacity: 0.7 }));
          jug.position.set(jx, 1.2, jz);
          group.add(jug);
        }
      }
    }

    // cubicle farms get desks against some partitions
    if (arch === 'cubicles') {
      for (let i = 0; i < 5; i++) {
        const lx = 1 + Math.floor(junkRnd() * 6), lz = 1 + Math.floor(junkRnd() * 6);
        const x = bx * BLOCK + lx, z = bz * BLOCK + lz;
        if (wallN(seed, x, z) !== 1) continue;
        const desk = new THREE.Mesh(this.wallGeo, this.mats.desk);
        desk.scale.set(1.7, 0.06, 0.75);
        desk.position.set(x * CELL + CELL / 2, 0.74, z * CELL + 0.55);
        group.add(desk);
        if (junkRnd() < 0.5) {
          const monitor = new THREE.Mesh(this.wallGeo, this.mats.dark);
          monitor.scale.set(0.45, 0.35, 0.12);
          monitor.position.set(x * CELL + CELL / 2 + (junkRnd() - 0.5), 0.98, z * CELL + 0.5);
          monitor.rotation.y = (junkRnd() - 0.5) * 0.6;
          group.add(monitor);
        }
      }
    }

    // dead blocks get one red emergency lamp — a colour that means wrong
    if (blockDark(seed, bx, bz)) {
      const cx = ox + size / 2, cz = oz + size / 2;
      const lamp = new THREE.PointLight(0xff2a1a, 2.2, 17, 1.5);
      lamp.position.set(cx, WALL_H - 0.4, cz);
      group.add(lamp);
      const lens = new THREE.Mesh(this.wallGeo, new THREE.MeshBasicMaterial({ color: 0xff3020 }));
      lens.scale.set(0.22, 0.12, 0.22);
      lens.position.set(cx, WALL_H - 0.1, cz);
      group.add(lens);
    }

    let almond: Chunk['almond'] = null;
    const aw = almondAt(seed, bx, bz);
    if (aw && !this.taken.has(aw.id)) {
      const bottle = this.buildBottle();
      bottle.position.set(aw.x, 0, aw.z);
      group.add(bottle);
      almond = { id: aw.id, mesh: bottle };
    }

    // pool blocks hold standing water in the poolrooms and during THE FLOOD
    if (arch === 'pool' && this.wet) {
      const waterTex = tx.poolTileTex();
      waterTex.repeat.set(3, 3);
      const water = new THREE.Mesh(new THREE.PlaneGeometry(size, size),
        new THREE.MeshStandardMaterial({
          map: waterTex, color: 0x3e7a8a, transparent: true, opacity: 0.34,
          roughness: 0.05, metalness: 0.4,
        }));
      water.rotation.x = -Math.PI / 2;
      water.position.set(ox + size / 2, 0.07, oz + size / 2);
      group.add(water);
      this.waterMeshes.push(water);
    }

    // faded posters on room walls — someone tried to keep morale up
    if (arch === 'rooms') {
      let posters = junkRnd() < 0.5 ? 1 : 0;
      for (let lz = 1; lz < BLOCK && posters > 0; lz++) {
        for (let lx = 1; lx < BLOCK && posters > 0; lx++) {
          const x = bx * BLOCK + lx, z = bz * BLOCK + lz;
          if (wallN(seed, x, z) === 2 && junkRnd() < 0.12) {
            const poster = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 1.05),
              new THREE.MeshStandardMaterial({ map: tx.posterTex(), roughness: 0.95 }));
            poster.position.set(x * CELL + CELL / 2, 1.6, z * CELL + WALL_HALF_T + 0.02);
            poster.rotation.z = (junkRnd() - 0.5) * 0.12; // hung crooked, of course
            group.add(poster);
            posters--;
          }
        }
      }
    }

    if (arch === 'landmark') this.buildLandmark(group, bx, bz);

    this.scene.add(group);
    this.chunks.set(`${bx},${bz}`, { group, fixtures, fixtureMesh, glowMesh, almond });
  }

  private buildBottle(): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.09, 0.3, 10),
      new THREE.MeshStandardMaterial({ color: 0xd8d2c0, roughness: 0.3, emissive: 0x554e33, emissiveIntensity: 0.5 }));
    body.position.y = 0.15;
    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 0.06, 8),
      new THREE.MeshStandardMaterial({ color: 0x333333 }));
    cap.position.y = 0.33;
    g.add(body, cap);
    return g;
  }

  private buildLandmark(group: THREE.Group, bx: number, bz: number): void {
    const kind = landmarkKind(this.seed, bx, bz);
    const cx = (bx * BLOCK + 4) * CELL + CELL / 2;
    const cz = (bz * BLOCK + 4) * CELL + CELL / 2;
    const rnd = mulberry32(hash2(this.seed, bx, bz, 40));

    if (kind === 'exit') {
      // the way out: a doorway of wrong-black with a cold light above.
      // dead until every breaker is pulled.
      const jambMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0f, roughness: 0.2 });
      for (const s of [-1, 1]) {
        const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.6, 0.3), jambMat);
        jamb.position.set(cx + s * 0.9, 1.3, cz);
        group.add(jamb);
      }
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.3, 0.3), jambMat);
      lintel.position.set(cx, 2.6, cz);
      group.add(lintel);
      const void_ = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 2.5),
        new THREE.MeshBasicMaterial({ color: this.powered ? 0x0e1c22 : 0x000000, side: THREE.DoubleSide }));
      void_.position.set(cx, 1.25, cz);
      group.add(void_);
      this.exitVoid = void_;
      this.exitLight = new THREE.PointLight(0xbfe8ff, this.powered ? 2.6 : 0, 18, 1.6);
      this.exitLight.position.set(cx, 2.9, cz);
      group.add(this.exitLight);
      return;
    }
    if (kind === 'breaker') {
      const id = `${bx}:${bz}`;
      const reg = this.breakers.get(id);
      const box = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.7, 0.45),
        new THREE.MeshStandardMaterial({ color: 0x37413a, roughness: 0.5, metalness: 0.6 }));
      box.position.set(cx, 0.85, cz);
      box.castShadow = true;
      group.add(box);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.3, 0.05),
        new THREE.MeshBasicMaterial({ color: reg?.collected ? 0x4dff88 : 0xffb347 }));
      strip.position.set(cx - 0.3, 0.9, cz + 0.24);
      group.add(strip);
      const leverGeo = new THREE.BoxGeometry(0.12, 0.5, 0.12);
      leverGeo.translate(0, 0.25, 0);
      const lever = new THREE.Mesh(leverGeo,
        new THREE.MeshStandardMaterial({ color: 0xb03a2e, roughness: 0.4 }));
      lever.position.set(cx + 0.2, 1.0, cz + 0.22);
      lever.rotation.x = reg?.collected ? 0.9 : -0.6;
      group.add(lever);
      const light = new THREE.PointLight(reg?.collected ? 0x4dff88 : 0xffb347, 1.4, 14, 1.6);
      light.position.set(cx, 2.0, cz + 0.5);
      group.add(light);
      // beacon shaft: an amber column of charged air, visible through the fog
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55, 0.85, WALL_H, 10, 1, true),
        new THREE.MeshBasicMaterial({
          color: reg?.collected ? 0x2a6644 : 0xffb347, transparent: true, opacity: 0.06,
          blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false,
        }));
      shaft.position.set(cx, WALL_H / 2, cz);
      group.add(shaft);
      if (reg) { reg.lever = lever; reg.strip = strip; reg.light = light; }
      return;
    }
    if (kind === 'vending') {
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.9, 0.75),
        new THREE.MeshStandardMaterial({ color: 0x27313d, roughness: 0.4, metalness: 0.3 }));
      body.position.set(cx, 0.95, cz);
      body.rotation.y = Math.floor(rnd() * 4) * (Math.PI / 2);
      body.castShadow = true;
      group.add(body);
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 1.3),
        new THREE.MeshBasicMaterial({ color: 0x9fd8e8 }));
      panel.position.set(cx, 1.05, cz).add(new THREE.Vector3(Math.sin(body.rotation.y) * 0.39, 0, Math.cos(body.rotation.y) * 0.39));
      panel.rotation.y = body.rotation.y;
      group.add(panel);
      const glow = new THREE.PointLight(0x9fd8e8, 2.4, 10, 1.6);
      glow.position.set(cx, 1.4, cz);
      group.add(glow);
      return;
    }
    if (kind === 'door') {
      // a red door. it does not open. it should not be here either.
      const frameMat = new THREE.MeshStandardMaterial({ color: 0x241d14, roughness: 0.8 });
      for (const s of [-1, 1]) {
        const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.2, 0.25), frameMat);
        jamb.position.set(cx + s * 0.55, 1.1, cz);
        group.add(jamb);
      }
      const top = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.18, 0.25), frameMat);
      top.position.set(cx, 2.2, cz);
      group.add(top);
      const slab = new THREE.Mesh(new THREE.BoxGeometry(0.95, 2.1, 0.09),
        new THREE.MeshStandardMaterial({ color: 0x7e1f16, roughness: 0.55 }));
      slab.position.set(cx, 1.05, cz);
      slab.castShadow = true;
      group.add(slab);
      // scrawled straight onto the door
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.85),
        new THREE.MeshBasicMaterial({ map: tx.chalkWriting('NOT AN EXIT'), transparent: true, depthWrite: false }));
      sign.position.set(cx, 1.35, cz + 0.06);
      group.add(sign);
      // behind it: bricks. it warned you.
      const brick = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 2.2),
        new THREE.MeshStandardMaterial({ map: tx.brickTex(), roughness: 0.95, side: THREE.DoubleSide }));
      brick.position.set(cx, 1.05, cz - 0.06);
      brick.visible = false;
      group.add(brick);
      this.wallsRaycast.push(slab);
      this.doors.push({ x: cx, z: cz, slab, brick, opened: false });
      return;
    }
    if (kind === 'chair') {
      const mat = new THREE.MeshStandardMaterial({ color: 0x3a3128, roughness: 0.9 });
      const chair = new THREE.Group();
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.06, 0.45), mat); seat.position.y = 0.45;
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.5, 0.06), mat); back.position.set(0, 0.72, -0.2);
      chair.add(seat, back);
      for (const [sx, sz] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.45, 0.05), mat);
        leg.position.set(sx, 0.22, sz);
        chair.add(leg);
      }
      chair.position.set(cx, 0, cz);
      chair.rotation.y = rnd() * Math.PI * 2;
      chair.castShadow = true;
      group.add(chair);
      return;
    }
    if (kind === 'cabinets') {
      const mat = new THREE.MeshStandardMaterial({ color: 0x6e6f66, roughness: 0.6, metalness: 0.4 });
      for (let i = 0; i < 6; i++) {
        const cab = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.5, 0.5), mat);
        cab.position.set(cx - 2 + i * 0.7, 0.75, cz - 1.5);
        cab.rotation.y = (rnd() - 0.5) * 0.1;
        cab.castShadow = true;
        group.add(cab);
      }
      return;
    }
    if (kind === 'writing') {
      const msgs = [
        ['STAY', 'TOGETHER'], ['IT HEARS', 'YOU'], ['DONT', 'TRUST THE', 'FOOTSTEPS'],
        ['THE EXIT', 'IS REAL'], ['I WAS', 'HERE', 'YESTERDAY?'], ['KEEP', 'WALKING'],
      ];
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(3.2, WALL_H, 0.3),
        [this.mats.wall, this.mats.wall,
          this.mats.wall, this.mats.wall,
          new THREE.MeshStandardMaterial({ map: tx.writingTex(msgs[Math.floor(rnd() * msgs.length)]), roughness: 0.92 }),
          this.mats.wall]);
      slab.position.set(cx, WALL_H / 2, cz);
      slab.rotation.y = Math.floor(rnd() * 4) * (Math.PI / 2);
      slab.castShadow = true;
      group.add(slab);
      this.wallsRaycast.push(slab);
      return;
    }
    // shrine: a pallet of almond water, one bottle still full (spawned via almondAt)
    const pallet = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.12, 1.0),
      new THREE.MeshStandardMaterial({ color: 0x6b5836, roughness: 1 }));
    pallet.position.set(cx, 0.06, cz);
    group.add(pallet);
    for (let i = 0; i < 8; i++) {
      const b = this.buildBottle();
      b.position.set(cx - 0.5 + rnd() * 1.0, 0.12, cz - 0.35 + rnd() * 0.7);
      b.rotation.z = rnd() < 0.4 ? Math.PI / 2 : 0;
      b.scale.setScalar(0.9);
      (b.children[0] as THREE.Mesh).material = new THREE.MeshStandardMaterial({ color: 0x9a927e, roughness: 0.5 });
      group.add(b);
    }
  }
}

/** A pool of real PointLights assigned each frame to the nearest live fixtures. */
export class LightPool {
  lights: THREE.PointLight[] = [];
  constructor(scene: THREE.Scene, count = 10) {
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xfff0bd, 0, 19, 1.3);
      l.position.y = WALL_H - 0.3;
      scene.add(l);
      this.lights.push(l);
    }
  }

  update(world: World, px: number, pz: number, time: number): number {
    const sorted = world.fixturesNear
      .map((f) => ({ f, d: Math.hypot(f.x - px, f.z - pz) }))
      .filter((e) => e.d < 30)
      .sort((a, b) => a.d - b.d);
    const base = new THREE.Color(world.theme.fixture);
    const cool = new THREE.Color(0xd8f2ff);
    let hum = 0;
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      const e = sorted[i];
      if (!e) { l.intensity = 0; continue; }
      const lvl = world.lightLevel(e.f, time);
      l.color.copy(e.f.cool ? cool : base);
      l.position.set(e.f.x, WALL_H - 0.3, e.f.z);
      l.intensity = 9.5 * lvl;
      hum += Math.max(0, 1 - e.d / 20) * lvl;
    }
    return Math.min(1, hum / 4);
  }
}
