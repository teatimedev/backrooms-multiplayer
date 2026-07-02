// Wire protocol. JSON messages over a single WebSocket.
// Player state tuples are [x, y, z, yaw, pitch, anim] to keep packets small.
// anim: 0 idle, 1 walk, 2 run, 3 echo(dead, flying), 4 downed(crawl).

export type Anim = 0 | 1 | 2 | 3 | 4;

export const REVIVE_TIME = 4;        // seconds holding E to pick someone up
export const REVIVE_RANGE = 3.5;     // metres
export const BLEED_OUT_HELPED = 60;  // downed with living teammates
export const BLEED_OUT_SOLO = 12;    // downed with nobody left to help
export type StateTuple = [number, number, number, number, number, Anim];

export interface PlayerInfo {
  id: string;
  name: string;
  color: number;      // palette index
  alive: boolean;
  spawnIndex: number;
}

export interface Mark {
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;  // surface normal
  rot: number;                          // rotation around normal
  sym: number;                          // symbol index
  by: string;
}

// entity mode: 0 dormant, 1 stalking, 2 hunting
export type EntityTuple = [number, number, number, string | null];

export type C2S =
  | { t: 'host'; name: string; color: number }
  | { t: 'join'; code: string; name: string; color: number }
  | { t: 'state'; s: StateTuple }
  | { t: 'chalk'; m: Omit<Mark, 'by'> }
  | { t: 'pickup'; id: string }
  | { t: 'breaker'; id: string }
  | { t: 'shine'; on: boolean }
  | { t: 'chat'; text: string }
  | { t: 'rtc'; to: string; data: unknown }
  | { t: 'flick' }
  | { t: 'revive'; id: string; on: boolean }
  | { t: 'drink' }
  | { t: 'descend' }
  | { t: 'restart' }
  | { t: 'dbg'; cmd: string; id?: string }
  | { t: 'ping'; n: number };

export type S2C =
  | { t: 'joined'; you: string; code: string; seed: number; round: number; depth: number; spawn: [number, number]; players: PlayerInfo[]; marks: Mark[]; taken: string[]; breakers: string[] }
  | { t: 'err'; msg: string }
  | { t: 'pj'; p: PlayerInfo }
  | { t: 'pl'; id: string; name: string }
  | { t: 's'; p: Record<string, StateTuple>; e: EntityTuple | null }
  | { t: 'chalk'; m: Mark }
  | { t: 'pickup'; id: string; by: string }
  | { t: 'breaker'; id: string; by: string; left: number }
  | { t: 'powered' }
  | { t: 'retreat'; x: number; z: number }
  | { t: 'down'; id: string }
  | { t: 'dead'; id: string }
  | { t: 'revived'; id: string; by: string }
  | { t: 'rp'; id: string; p: number }
  | { t: 'blackout'; ms: number }
  | { t: 'chat'; from: string; name: string; text: string }
  | { t: 'flicker'; x: number; z: number; r: number }
  | { t: 'mimic'; x: number; z: number; kind: 'steps' | 'voice' }
  | { t: 'win'; time: number; final: boolean }
  | { t: 'wipe'; time: number }
  | { t: 'round'; seed: number; round: number; depth: number; spawn: [number, number] }
  | { t: 'rtc'; from: string; data: unknown }
  | { t: 'pong'; n: number };

export const AVATAR_COLORS = [0xd9553b, 0x3f7fbf, 0x53a35a, 0xc9a13f, 0x9a5fc9, 0x3fbfb4, 0xc95f8e, 0x8a8f98];
export const AVATAR_COLOR_NAMES = ['rust', 'cobalt', 'moss', 'ochre', 'violet', 'teal', 'rose', 'ash'];
