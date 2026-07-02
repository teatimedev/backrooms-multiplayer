import type { WebSocket } from 'ws';
import { fnv } from '../../shared/src/rng.js';
import { exitPos, hubPos, spawnPoint, almondAt, breakerSpots, BREAKERS_NEEDED } from '../../shared/src/worldgen.js';
import { REVIVE_TIME, REVIVE_RANGE, BLEED_OUT_HELPED, BLEED_OUT_SOLO } from '../../shared/src/protocol.js';
import type { Canister, Mark, PlayerInfo, S2C, StateTuple } from '../../shared/src/protocol.js';

const VALVE_HOLD_SECS = 6;
const VALVE_RANGE = 3.5;
import { Entity } from './entity.js';

const TICK_MS = 100;         // 10Hz sim + state broadcast
const MAX_PLAYERS = 8;
const MAX_MARKS = 250;
const EXIT_RADIUS = 5.5;
const ECHO_FLICK_CD = 25;    // seconds between echo light-flickers

export interface Player {
  id: string;
  ws: WebSocket;
  name: string;
  color: number;
  alive: boolean;
  spawnIndex: number;
  state: StateTuple;
  hasState: boolean;
  lastFlick: number;
  shining: boolean;
  downed: boolean;
  downedAt: number;
  reviveProgress: number;
  revivers: Set<string>;
  selfSaved: boolean;
}

export class Room {
  seed: number;
  round = 1;
  depth = 0; // 0 lobby · 1 garage · 2 poolrooms (escape there = out)
  players = new Map<string, Player>();
  marks: Mark[] = [];
  taken = new Set<string>();
  breakers = new Set<string>();
  intel = new Set<string>();
  powered = false;
  // level 1: fuel canisters → generator. level 2: twin drain valves.
  canisters = new Map<string, Canister>();
  valveHolders = new Map<string, Set<string>>();
  valveP = 0;
  deaths: { x: number; z: number; name: string; color: number; round: number }[] = [];
  entity = new Entity();
  status: 'playing' | 'won' | 'wiped' = 'playing';
  private createdAt = Date.now();
  private roundStart = Date.now();
  private nextSpawn = 0;
  private timer: ReturnType<typeof setInterval>;
  emptySince: number | null = null;

  constructor(public code: string) {
    this.seed = fnv(`${code}:1`);
    this.initObjective();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private initObjective(): void {
    this.powered = false;
    this.breakers.clear();
    this.canisters.clear();
    this.valveHolders.clear();
    this.valveP = 0;
    const spots = breakerSpots(this.seed);
    if (this.depth === 1) {
      for (const s of spots) this.canisters.set(s.id, { id: s.id, x: s.x, z: s.z, holder: null, delivered: false });
    } else if (this.depth === 2) {
      this.valveHolders.set(spots[0].id, new Set());
      this.valveHolders.set(spots[1].id, new Set());
    }
  }

  private setPowered(): void {
    if (this.powered) return;
    this.powered = true;
    const ex = exitPos(this.seed);
    this.broadcast({ t: 'powered' });
    this.broadcast({ t: 'flicker', x: ex.x, z: ex.z, r: 45 });
    this.entity.enrage();
  }

  carrierIds(): Set<string> {
    const s = new Set<string>();
    for (const c of this.canisters.values()) if (c.holder) s.add(c.holder);
    return s;
  }

  valveHolderIds(): Set<string> {
    const s = new Set<string>();
    for (const hs of this.valveHolders.values()) for (const id of hs) s.add(id);
    return s;
  }

  ageSec(): number { return (Date.now() - this.roundStart) / 1000; }

  addPlayer(ws: WebSocket, name: string, color: number): Player | null {
    if (this.players.size >= MAX_PLAYERS) return null;
    const id = Math.random().toString(36).slice(2, 8);
    const spawnIndex = this.nextSpawn++;
    const sp = spawnPoint(this.seed, spawnIndex);
    const p: Player = {
      id, ws, name: name.slice(0, 16) || 'anon', color: color & 7,
      alive: this.status === 'playing', spawnIndex,
      state: [sp.x, 1.6, sp.z, 0, 0, 0, 0], hasState: false, lastFlick: 0, shining: false,
      downed: false, downedAt: 0, reviveProgress: 0, revivers: new Set(), selfSaved: false,
    };
    this.players.set(id, p);
    this.emptySince = null;
    const info = (q: Player): PlayerInfo => ({ id: q.id, name: q.name, color: q.color, alive: q.alive, spawnIndex: q.spawnIndex });
    this.sendTo(id, {
      t: 'joined', you: id, code: this.code, seed: this.seed, round: this.round, depth: this.depth,
      spawn: [sp.x, sp.z], players: [...this.players.values()].map(info),
      marks: this.marks, taken: [...this.taken], breakers: [...this.breakers],
      canisters: [...this.canisters.values()], powered: this.powered, deaths: this.deaths,
    });
    this.broadcast({ t: 'pj', p: info(p) }, id);
    return p;
  }

  removePlayer(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    this.dropCarried(id);
    for (const hs of this.valveHolders.values()) hs.delete(id);
    this.players.delete(id);
    for (const q of this.players.values()) q.revivers.delete(id);
    this.broadcast({ t: 'pl', id, name: p.name });
    if (this.players.size === 0) this.emptySince = Date.now();
    else this.checkEndConditions();
  }

  handle(p: Player, msg: Record<string, unknown>): void {
    switch (msg.t) {
      case 'state': {
        const s = msg.s as StateTuple;
        const arr = s as unknown as number[];
        if (!Array.isArray(arr) || arr.length < 6 || arr.length > 7 || arr.some((v) => typeof v !== 'number' || !isFinite(v))) return;
        if (arr.length === 6) arr.push(0); // legacy clients: silent
        p.state = s;
        p.hasState = true;
        break;
      }
      case 'chalk': {
        if (this.marks.length >= MAX_MARKS) this.marks.shift();
        const m = { ...(msg.m as Omit<Mark, 'by'>), by: p.id };
        this.marks.push(m);
        this.broadcast({ t: 'chalk', m });
        break;
      }
      case 'pickup': {
        const id = String(msg.id);
        if (this.taken.has(id)) return;
        // validate the pickup exists and the player is near it
        const [bx, bz] = id.split(':').map(Number);
        const a = almondAt(this.seed, bx, bz);
        if (!a || Math.hypot(a.x - p.state[0], a.z - p.state[2]) > 4) return;
        this.taken.add(id);
        this.broadcast({ t: 'pickup', id, by: p.id });
        break;
      }
      case 'breaker': {
        if (this.depth !== 0) return;
        const id = String(msg.id);
        if (this.breakers.has(id) || !p.alive || this.status !== 'playing') return;
        const spot = breakerSpots(this.seed).find((b) => b.id === id);
        if (!spot || Math.hypot(spot.x - p.state[0], spot.z - p.state[2]) > 4.5) return;
        this.breakers.add(id);
        this.broadcast({ t: 'breaker', id, by: p.id, left: BREAKERS_NEEDED - this.breakers.size });
        if (this.breakers.size >= BREAKERS_NEEDED) this.setPowered();
        break;
      }
      case 'grab': {
        if (this.depth !== 1 || this.status !== 'playing' || !p.alive || p.downed) return;
        const c = this.canisters.get(String(msg.id));
        if (!c || c.delivered || c.holder) return;
        if (this.carrierIds().has(p.id)) return; // one can at a time
        if (Math.hypot(c.x - p.state[0], c.z - p.state[2]) > 3.2) return;
        c.holder = p.id;
        this.broadcast({ t: 'grab', id: c.id, by: p.id });
        break;
      }
      case 'dropfuel': {
        this.dropCarried(p.id);
        break;
      }
      case 'valve': {
        if (this.depth !== 2 || this.status !== 'playing') return;
        const hs = this.valveHolders.get(String(msg.id));
        if (!hs) return;
        if (msg.on === true && p.alive && !p.downed) hs.add(p.id);
        else hs.delete(p.id);
        break;
      }
      case 'shine': {
        p.shining = msg.on === true;
        break;
      }
      case 'chat': {
        const text = String(msg.text).slice(0, 140);
        if (!text.trim() || !p.alive) return;
        for (const q of this.players.values()) {
          const near = Math.hypot(q.state[0] - p.state[0], q.state[2] - p.state[2]) < 45;
          if (q.id === p.id || near || !q.alive) this.sendTo(q.id, { t: 'chat', from: p.id, name: p.name, text });
        }
        break;
      }
      case 'rtc': {
        const to = String(msg.to);
        if (this.players.has(to)) this.sendTo(to, { t: 'rtc', from: p.id, data: msg.data });
        break;
      }
      case 'flick': {
        // echoes only: flicker lights near themselves, maybe stun the entity
        if (p.alive) return;
        const now = Date.now() / 1000;
        if (now - p.lastFlick < ECHO_FLICK_CD) return;
        p.lastFlick = now;
        this.broadcast({ t: 'flicker', x: p.state[0], z: p.state[2], r: 12 });
        if (this.entity.mode > 0 && Math.hypot(this.entity.x - p.state[0], this.entity.z - p.state[2]) < 12) {
          this.entity.stunned = 2.5;
        }
        break;
      }
      case 'revive': {
        const target = this.players.get(String(msg.id));
        if (!target || !target.downed) return;
        if (msg.on === true && p.alive && !p.downed) target.revivers.add(p.id);
        else target.revivers.delete(p.id);
        break;
      }
      case 'mark': {
        // shared intel: first player near a breaker/exit marks it for the crew
        const kind = msg.kind === 'exit' ? 'exit' : 'breaker';
        const id = String(msg.id);
        const key = `${kind}:${id}`;
        if (this.intel.has(key)) return;
        if (kind === 'breaker' && !breakerSpots(this.seed).some((b) => b.id === id)) return;
        this.intel.add(key);
        this.broadcast({ t: 'marked', kind, id, by: p.id });
        break;
      }
      case 'drink': {
        // almond water while bleeding out stabilises you — once per down
        if (p.downed && !p.selfSaved) {
          p.selfSaved = true;
          p.downedAt = Date.now();
        }
        break;
      }
      case 'descend': {
        if (this.status !== 'won' || this.depth >= 2) return;
        this.depth++;
        this.newRound();
        break;
      }
      case 'restart': {
        if (this.status === 'playing' && this.ageSec() < 15) return;
        this.depth = 0;
        this.newRound();
        break;
      }
      case 'dbg': {
        if (!process.env.BR_DEBUG) return;
        if (msg.cmd === 'spawn') this.entity.forceSpawn();
        if (msg.cmd === 'down') this.downPlayer(String(msg.id ?? p.id));
        if (msg.cmd === 'win') {
          this.status = 'won';
          this.broadcast({ t: 'win', time: Math.round(this.ageSec()), final: this.depth >= 2 });
        }
        break;
      }
      case 'ping':
        this.sendTo(p.id, { t: 'pong', n: Number(msg.n) });
        break;
    }
  }

  /** Downed or disconnected carriers spill their fuel where they fall. */
  private dropCarried(pid: string): void {
    for (const c of this.canisters.values()) {
      if (c.holder !== pid) continue;
      const p = this.players.get(pid);
      c.holder = null;
      if (p) { c.x = p.state[0]; c.z = p.state[2]; }
      this.broadcast({ t: 'fueldrop', id: c.id, x: c.x, z: c.z });
    }
  }

  /** The entity caught someone: downed, not dead. Teammates can revive. */
  downPlayer(id: string): void {
    const p = this.players.get(id);
    if (!p || !p.alive || p.downed) return;
    this.dropCarried(id);
    for (const hs of this.valveHolders.values()) hs.delete(id);
    p.downed = true;
    p.downedAt = Date.now();
    p.reviveProgress = 0;
    p.selfSaved = false;
    p.revivers.clear();
    this.broadcast({ t: 'down', id });
  }

  private diePlayer(id: string): void {
    const p = this.players.get(id);
    if (!p || !p.alive) return;
    p.alive = false;
    p.downed = false;
    // the backrooms keep what they take: this body is findable next round
    this.deaths.push({ x: p.state[0], z: p.state[2], name: p.name, color: p.color, round: this.round });
    if (this.deaths.length > 30) this.deaths.shift();
    this.broadcast({ t: 'dead', id });
    this.checkEndConditions();
  }

  blackout(ms: number): void {
    this.broadcast({ t: 'blackout', ms: Math.round(ms) });
  }

  /** Bleed-outs and revives, run every tick. */
  private updateDowned(): void {
    for (const p of this.players.values()) {
      if (!p.alive || !p.downed) continue;
      const helpers = [...this.players.values()].some((q) => q !== p && q.alive && !q.downed && q.hasState);
      const limit = helpers ? BLEED_OUT_HELPED : BLEED_OUT_SOLO;
      // validate revivers by distance every tick
      let reviving = false;
      let by = '';
      for (const rid of p.revivers) {
        const q = this.players.get(rid);
        if (!q || !q.alive || q.downed) { p.revivers.delete(rid); continue; }
        if (Math.hypot(q.state[0] - p.state[0], q.state[2] - p.state[2]) > REVIVE_RANGE) continue;
        reviving = true; by = rid;
      }
      if (reviving) {
        p.reviveProgress += TICK_MS / 1000;
        if (p.reviveProgress >= REVIVE_TIME) {
          p.downed = false;
          p.reviveProgress = 0;
          p.revivers.clear();
          this.broadcast({ t: 'revived', id: p.id, by });
          this.entity.avoidFor(p.id, 25);
          continue;
        }
        this.broadcast({ t: 'rp', id: p.id, p: p.reviveProgress / REVIVE_TIME });
      } else if (p.reviveProgress > 0) {
        p.reviveProgress = Math.max(0, p.reviveProgress - (TICK_MS / 1000) * 0.7);
      }
      if ((Date.now() - p.downedAt) / 1000 > limit) this.diePlayer(p.id);
    }
  }

  private checkEndConditions(): void {
    if (this.status !== 'playing') return;
    const withState = [...this.players.values()].filter((p) => p.hasState);
    if (!withState.length) return;
    if (withState.every((p) => !p.alive)) {
      this.status = 'wiped';
      this.broadcast({ t: 'wipe', time: Math.round(this.ageSec()) });
    }
  }

  /** Level-specific objective progress, run every tick. */
  private updateObjective(): void {
    if (this.powered) return;
    if (this.depth === 1) {
      const hub = hubPos(this.seed);
      let delivered = 0;
      for (const c of this.canisters.values()) {
        if (c.delivered) { delivered++; continue; }
        if (!c.holder) continue;
        const carrier = this.players.get(c.holder);
        if (!carrier || !carrier.alive || carrier.downed) { this.dropCarried(c.holder); continue; }
        c.x = carrier.state[0]; c.z = carrier.state[2]; // fuel travels with its carrier
        if (Math.hypot(c.x - hub.x, c.z - hub.z) < 4.5) {
          c.delivered = true;
          c.holder = null;
          delivered++;
          this.broadcast({ t: 'fuel', id: c.id, by: carrier.id, left: this.canisters.size - delivered });
        }
      }
      if (delivered >= this.canisters.size && this.canisters.size > 0) this.setPowered();
    } else if (this.depth === 2) {
      const spots = breakerSpots(this.seed);
      const alive = [...this.players.values()].filter((q) => q.alive && !q.downed && q.hasState);
      const required = alive.length >= 2 ? 2 : 1;
      let held = 0, holders = 0;
      for (const [id, hs] of this.valveHolders) {
        const spot = spots.find((s) => s.id === id);
        if (!spot) continue;
        for (const pid of hs) {
          const q = this.players.get(pid);
          if (!q || !q.alive || q.downed || Math.hypot(spot.x - q.state[0], spot.z - q.state[2]) > VALVE_RANGE) hs.delete(pid);
        }
        if (hs.size > 0) { held++; holders += hs.size; }
      }
      const prev = this.valveP;
      if (held >= required) this.valveP = Math.min(1, this.valveP + (TICK_MS / 1000) / VALVE_HOLD_SECS);
      else this.valveP = Math.max(0, this.valveP - (TICK_MS / 1000) / (VALVE_HOLD_SECS * 2));
      if (this.valveP !== prev) this.broadcast({ t: 'vp', p: this.valveP, holders });
      if (this.valveP >= 1) this.setPowered();
    }
  }

  private tick(): void {
    if (this.status === 'playing') {
      this.entity.update(this, TICK_MS / 1000);
      this.updateDowned();
      this.updateObjective();
      this.checkWin();
    }
    // state broadcast
    if (this.players.size) {
      const p: Record<string, StateTuple> = {};
      for (const q of this.players.values()) if (q.hasState) p[q.id] = q.state;
      const e = this.entity.mode > 0
        ? ([this.entity.x, this.entity.z, this.entity.mode, this.entity.targetId] as [number, number, number, string | null])
        : null;
      this.broadcast({ t: 's', p, e });
    }
  }

  private checkWin(): void {
    if (!this.powered) return; // no power, no exit
    const alive = [...this.players.values()].filter((p) => p.alive && p.hasState);
    if (!alive.length) return;
    const ex = exitPos(this.seed);
    const allIn = alive.every((p) => Math.hypot(p.state[0] - ex.x, p.state[2] - ex.z) < EXIT_RADIUS);
    if (allIn) {
      this.status = 'won';
      this.broadcast({ t: 'win', time: Math.round(this.ageSec()), final: this.depth >= 2 });
    }
  }

  private newRound(): void {
    this.round++;
    this.seed = fnv(`${this.code}:${this.round}`);
    this.marks = [];
    this.taken.clear();
    this.intel.clear();
    this.initObjective();
    this.entity.reset();
    this.status = 'playing';
    this.roundStart = Date.now();
    let i = 0;
    for (const p of this.players.values()) {
      p.alive = true;
      p.downed = false;
      p.reviveProgress = 0;
      p.revivers.clear();
      p.hasState = false;
      p.spawnIndex = i++;
      const sp = spawnPoint(this.seed, p.spawnIndex);
      p.state = [sp.x, 1.6, sp.z, 0, 0, 0, 0];
      this.sendTo(p.id, { t: 'round', seed: this.seed, round: this.round, depth: this.depth, spawn: [sp.x, sp.z], deaths: this.deaths });
    }
  }

  sendTo(id: string, msg: S2C): void {
    const p = this.players.get(id);
    if (p && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  }

  broadcast(msg: S2C, exceptId?: string): void {
    const s = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.id !== exceptId && p.ws.readyState === 1) p.ws.send(s);
    }
  }

  destroy(): void { clearInterval(this.timer); }
}
