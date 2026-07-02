import type { WebSocket } from 'ws';
import { fnv } from '../../shared/src/rng.js';
import { exitPos, spawnPoint, almondAt, BLOCK, CELL } from '../../shared/src/worldgen.js';
import type { Mark, PlayerInfo, S2C, StateTuple } from '../../shared/src/protocol.js';
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
}

export class Room {
  seed: number;
  round = 1;
  players = new Map<string, Player>();
  marks: Mark[] = [];
  taken = new Set<string>();
  entity = new Entity();
  status: 'playing' | 'won' | 'wiped' = 'playing';
  private createdAt = Date.now();
  private roundStart = Date.now();
  private nextSpawn = 0;
  private timer: ReturnType<typeof setInterval>;
  emptySince: number | null = null;

  constructor(public code: string) {
    this.seed = fnv(`${code}:1`);
    this.timer = setInterval(() => this.tick(), TICK_MS);
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
      state: [sp.x, 1.6, sp.z, 0, 0, 0], hasState: false, lastFlick: 0,
    };
    this.players.set(id, p);
    this.emptySince = null;
    const info = (q: Player): PlayerInfo => ({ id: q.id, name: q.name, color: q.color, alive: q.alive, spawnIndex: q.spawnIndex });
    this.sendTo(id, {
      t: 'joined', you: id, code: this.code, seed: this.seed, round: this.round,
      spawn: [sp.x, sp.z], players: [...this.players.values()].map(info),
      marks: this.marks, taken: [...this.taken],
    });
    this.broadcast({ t: 'pj', p: info(p) }, id);
    return p;
  }

  removePlayer(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    if (this.entity.targetId === id) this.entity.despawn(5);
    this.broadcast({ t: 'pl', id, name: p.name });
    if (this.players.size === 0) this.emptySince = Date.now();
    else this.checkEndConditions();
  }

  handle(p: Player, msg: Record<string, unknown>): void {
    switch (msg.t) {
      case 'state': {
        const s = msg.s as StateTuple;
        if (!Array.isArray(s) || s.length !== 6 || s.some((v) => typeof v !== 'number' || !isFinite(v))) return;
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
      case 'restart': {
        if (this.status === 'playing' && this.ageSec() < 15) return;
        this.newRound();
        break;
      }
      case 'ping':
        this.sendTo(p.id, { t: 'pong', n: Number(msg.n) });
        break;
    }
  }

  killPlayer(id: string): void {
    const p = this.players.get(id);
    if (!p || !p.alive) return;
    p.alive = false;
    this.broadcast({ t: 'kill', id });
    this.checkEndConditions();
  }

  private checkEndConditions(): void {
    if (this.status !== 'playing') return;
    const withState = [...this.players.values()].filter((p) => p.hasState);
    if (!withState.length) return;
    if (withState.every((p) => !p.alive)) {
      this.status = 'wiped';
      this.broadcast({ t: 'wipe' });
    }
  }

  private tick(): void {
    if (this.status === 'playing') {
      this.entity.update(this, TICK_MS / 1000);
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
    const alive = [...this.players.values()].filter((p) => p.alive && p.hasState);
    if (!alive.length) return;
    const ex = exitPos(this.seed);
    const allIn = alive.every((p) => Math.hypot(p.state[0] - ex.x, p.state[2] - ex.z) < EXIT_RADIUS);
    if (allIn) {
      this.status = 'won';
      this.broadcast({ t: 'win', time: Math.round(this.ageSec()) });
    }
  }

  private newRound(): void {
    this.round++;
    this.seed = fnv(`${this.code}:${this.round}`);
    this.marks = [];
    this.taken.clear();
    this.entity.reset();
    this.status = 'playing';
    this.roundStart = Date.now();
    let i = 0;
    for (const p of this.players.values()) {
      p.alive = true;
      p.hasState = false;
      p.spawnIndex = i++;
      const sp = spawnPoint(this.seed, p.spawnIndex);
      p.state = [sp.x, 1.6, sp.z, 0, 0, 0];
      this.sendTo(p.id, { t: 'round', seed: this.seed, round: this.round, spawn: [sp.x, sp.z] });
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
