// The conductor: rendering, input, network events, sanity, the loop.
import * as THREE from 'three';
import { BREAKERS_NEEDED, losBlocked, resolveCollision } from '@shared/worldgen';
import type { PlayerInfo, S2C, StateTuple } from '@shared/protocol';
import { World, LightPool } from './world';
import { Player } from './player';
import { Avatar } from './avatars';
import { EntityView } from './entityView';
import { GameAudio } from './audio';
import { Voice } from './voice';
import { FX } from './fx';
import { ChalkSystem } from './chalk';
import { MentalMap } from './map';
import { CHALK_SYMBOLS } from './textures';
import type { Net } from './net';
import type { UI } from './ui';

type Joined = Extract<S2C, { t: 'joined' }>;

const STATE_HZ = 12.5;

export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private world: World;
  private lights: LightPool;
  private player: Player;
  private avatars = new Map<string, Avatar>();
  private stepTimers = new Map<string, number>();
  private entity: EntityView;
  private audio = new GameAudio();
  private voice: Voice;
  private fx: FX;
  private chalk: ChalkSystem;
  private map: MentalMap;
  private clock = new THREE.Clock();
  private myId: string;
  private code: string;
  private seed: number;
  private names = new Map<string, string>();
  private exitSense = 0;
  private shining = false;
  private shineToastShown = false;
  private glimpse: EntityView;
  private glimpseTimer = 30;
  private glimpseUntil = 0;
  private sparkTimer = 4;
  private radialHeld = false;
  private radialVec = { x: 0, y: 0 };
  private radialSel = 0;
  private ended = false;
  private wantLock = false;
  private stateTimer: number;
  private disposed = false;

  constructor(private net: Net, private ui: UI, joined: Joined, private voiceWanted: boolean) {
    this.myId = joined.you;
    this.code = joined.code;
    this.seed = joined.seed;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    // no shadow maps: with 15+ dynamic lights the spot-shadow pass wrecked
    // both the frame budget and (empirically) the lighting itself. The look
    // lives in fog, flicker and grain, not shadows.
    this.renderer.shadowMap.enabled = false;
    this.renderer.domElement.className = 'game';
    ui.root.prepend(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, 0.05, 90);
    this.scene.fog = new THREE.FogExp2(0x241d0e, 0.05);
    this.scene.background = new THREE.Color(0x0d0a05);
    this.scene.add(new THREE.HemisphereLight(0x8a7c4d, 0x2e2410, 0.85));

    this.world = new World(this.scene, this.seed, joined.taken, joined.breakers);
    this.lights = new LightPool(this.scene);
    this.player = new Player(this.camera, this.seed, this.scene);
    this.player.spawn(joined.spawn[0], joined.spawn[1]);
    this.player.onFootstep = (i) => {
      this.audio.footstep(this.world.surfaceAt(this.player.pos.x, this.player.pos.z), i);
    };
    this.entity = new EntityView(this.scene);
    this.glimpse = new EntityView(this.scene); // sanity's borrowed silhouette
    this.fx = new FX(this.renderer, this.scene, this.camera);
    this.chalk = new ChalkSystem(this.scene);
    this.chalk.setAll(joined.marks);
    this.voice = new Voice(net, this.audio);

    ui.buildHUD();
    this.map = new MentalMap(document.getElementById('hud')!);
    this.refreshObjective();
    ui.chatLine('', `you are in session ${this.code}`);

    for (const p of joined.players) {
      this.names.set(p.id, p.name);
      if (p.id !== this.myId) this.addAvatar(p);
    }

    this.bindNet();
    this.bindInput();

    // audio can start now — reaching this point required a click on the title
    this.audio.init();
    if (this.world.powered) this.audio.setExitBeacon(this.world.exit.x, this.world.exit.z);
    if (voiceWanted) {
      void this.voice.enable(this.myId, [...this.avatars.keys()]).then((ok) => {
        if (!ok) this.ui.toast('microphone unavailable — voice disabled', 4000);
        this.ui.setPTT(false, ok);
      });
    } else {
      this.ui.setPTT(false, false);
    }

    this.stateTimer = window.setInterval(() => this.sendState(), 1000 / STATE_HZ);
    this.requestLock();
    this.loop();
    // debug handle (used by automated verification; harmless in prod)
    (window as unknown as Record<string, unknown>).__game = this;
  }

  private refreshObjective(): void {
    const left = [...this.world.breakers.values()].filter((b) => !b.collected).length;
    if (this.world.powered) {
      this.ui.setObjective('the exit is LIVE — get everyone there, together');
    } else {
      this.ui.setObjective(`restore power: ${BREAKERS_NEEDED - left}/${BREAKERS_NEEDED} breakers pulled · stay close or split up?`);
    }
  }

  // ---------------------------------------------------------------- net

  private bindNet(): void {
    const net = this.net;
    net.on('pj', (m) => {
      this.names.set(m.p.id, m.p.name);
      this.addAvatar(m.p);
      this.voice.connectTo(m.p.id);
      this.ui.toast(`${m.p.name} noclipped in`);
    });
    net.on('pl', (m) => {
      this.avatars.get(m.id)?.dispose(this.scene);
      this.avatars.delete(m.id);
      this.voice.drop(m.id);
      this.ui.toast(`${m.name} faded out`);
    });
    net.on('s', (m) => {
      const now = performance.now() / 1000;
      for (const [id, s] of Object.entries(m.p)) {
        if (id === this.myId) continue;
        this.avatars.get(id)?.push(s as StateTuple, now);
      }
      this.entity.sync(m.e);
    });
    net.on('chalk', (m) => {
      this.chalk.add(m.m);
      if (m.m.by !== this.myId) this.audio.chalkScratch();
    });
    net.on('pickup', (m) => {
      this.world.takePickup(m.id);
      if (m.by === this.myId) {
        this.audio.pickup();
        this.player.sanity = 100;
        // the water shows you the current: nearest live breaker, or the exit
        let tx = this.world.exit.x, tz = this.world.exit.z, what = 'the way out';
        if (!this.world.powered) {
          let best = Infinity;
          for (const b of this.world.breakers.values()) {
            if (b.collected) continue;
            const d = Math.hypot(b.x - this.player.pos.x, b.z - this.player.pos.z);
            if (d < best) { best = d; tx = b.x; tz = b.z; what = 'a breaker'; }
          }
        }
        this.map.pulse = {
          angle: Math.atan2(tz - this.player.pos.z, tx - this.player.pos.x),
          until: performance.now() / 1000 + 8,
        };
        this.exitSense = 8;
        this.ui.toast(`almond water — you can feel ${what}. hold TAB.`);
      } else {
        this.ui.toast(`${this.names.get(m.by) ?? 'someone'} found almond water`);
      }
    });
    net.on('breaker', (m) => {
      this.world.collectBreaker(m.id);
      this.audio.breakerClunk();
      this.refreshObjective();
      const who = m.by === this.myId ? 'you' : this.names.get(m.by) ?? 'someone';
      if (m.left > 0) this.ui.toast(`${who} pulled a breaker — ${m.left} left`, 4000);
    });
    net.on('powered', () => {
      this.world.setPowered();
      this.audio.setExitBeacon(this.world.exit.x, this.world.exit.z);
      this.refreshObjective();
      this.player.shake = Math.max(this.player.shake, 0.03);
      this.ui.toast('THE EXIT HAS POWER. it knows. RUN.', 6000);
    });
    net.on('retreat', (m) => {
      this.audio.retreatShriek(m.x, m.z);
      this.ui.toast('it recoils from the light', 3500);
    });
    net.on('kill', (m) => {
      if (m.id === this.myId) this.die();
      else {
        const av = this.avatars.get(m.id);
        if (av) av.alive = false;
        this.audio.distantThud(this.avatars.get(m.id)?.lastState[0] ?? this.player.pos.x,
          this.avatars.get(m.id)?.lastState[2] ?? this.player.pos.z);
        this.ui.toast(`${this.names.get(m.id) ?? 'someone'} WAS TAKEN`, 4500);
      }
    });
    net.on('chat', (m) => this.ui.chatLine(m.name, m.text));
    net.on('flicker', (m) => {
      const t = this.clock.elapsedTime;
      this.world.addFlicker(m.x, m.z, m.r, t);
      if (Math.hypot(m.x - this.player.pos.x, m.z - this.player.pos.z) < m.r + 8) {
        this.audio.flickerZap(m.x, m.z);
      }
    });
    net.on('mimic', (m) => this.audio.mimic(m.x, m.z, m.kind));
    net.on('win', (m) => {
      this.ended = true;
      this.audio.winChord();
      this.fx.flash = 1.4;
      const mins = Math.floor(m.time / 60), secs = m.time % 60;
      document.exitPointerLock();
      setTimeout(() => this.ui.showEnd('win',
        `everyone stepped through together.<br/>${mins}m ${secs}s in the yellow.`,
        () => this.net.send({ t: 'restart' }), () => location.reload()), 900);
    });
    net.on('wipe', (m) => {
      this.ended = true;
      document.exitPointerLock();
      const mins = Math.floor(m.time / 60), secs = m.time % 60;
      setTimeout(() => this.ui.showEnd('wipe',
        `the backrooms kept every one of you.<br/>you lasted ${mins}m ${secs}s. only echoes remain.`,
        () => this.net.send({ t: 'restart' }), () => location.reload()), 1200);
    });
    net.on('round', (m) => this.newRound(m.seed, m.spawn));
    net.onclose = () => {
      if (!this.disposed) this.ui.showDisconnected();
    };
  }

  private newRound(seed: number, spawn: [number, number]): void {
    this.seed = seed;
    this.ended = false;
    this.ui.closeOverlay();
    // tear down the old maze
    for (const key of [...this.world.chunks.keys()]) {
      this.scene.remove(this.world.chunks.get(key)!.group);
    }
    this.world = new World(this.scene, seed, [], []);
    this.player.setSeed(seed);
    this.player.spawn(spawn[0], spawn[1]);
    this.chalk.setAll([]);
    this.map.reset();
    this.entity.sync(null);
    this.glimpse.sync(null);
    this.glimpseTimer = 30;
    this.shining = false;
    this.shineToastShown = false;
    this.exitSense = 0;
    this.stepTimers.clear();
    for (const av of this.avatars.values()) av.alive = true;
    this.fx.fade = 0;
    this.refreshObjective();
    this.ui.toast('a different maze. the same hum.', 4000);
    this.requestLock();
  }

  private addAvatar(p: PlayerInfo): void {
    if (this.avatars.has(p.id)) return;
    const av = new Avatar(p, this.scene);
    av.alive = p.alive;
    this.avatars.set(p.id, av);
    this.stepTimers.set(p.id, 0);
  }

  private sendState(): void {
    const p = this.player;
    this.net.send({
      t: 'state',
      s: [
        Number(p.pos.x.toFixed(2)), Number(p.pos.y.toFixed(2)), Number(p.pos.z.toFixed(2)),
        Number(p.yaw.toFixed(3)), Number(p.pitch.toFixed(3)), p.anim,
      ],
    });
  }

  // ---------------------------------------------------------------- input

  private requestLock(): void {
    this.wantLock = true;
    this.renderer.domElement.requestPointerLock();
  }

  private get locked(): boolean {
    return document.pointerLockElement === this.renderer.domElement;
  }

  private bindInput(): void {
    const canvas = this.renderer.domElement;
    canvas.addEventListener('click', () => {
      if (!this.locked && !this.ui.hasOverlay && !this.ended) this.requestLock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.player.frozen = !this.locked;
      if (!this.locked && this.wantLock && !this.ended && !this.ui.hasOverlay && !this.ui.chatOpen) {
        // user pressed ESC — that's the pause menu
        this.ui.showPause(this.code,
          () => { this.ui.closeOverlay(); this.requestLock(); },
          () => location.reload());
      }
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      if (this.radialHeld) {
        this.radialVec.x += e.movementX;
        this.radialVec.y += e.movementY;
        const len = Math.hypot(this.radialVec.x, this.radialVec.y);
        if (len > 18) {
          const a = Math.atan2(this.radialVec.y, this.radialVec.x) + Math.PI / 2;
          const n = CHALK_SYMBOLS.length;
          this.radialSel = ((Math.round(a / (Math.PI * 2) * n) % n) + n) % n;
        }
        this.ui.showRadial(this.radialSel);
        return;
      }
      this.player.look(e.movementX, e.movementY);
    });

    document.addEventListener('keydown', (e) => {
      if (this.ui.chatOpen) return;
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      switch (e.code) {
        case 'Tab':
          e.preventDefault();
          this.map.visible = true;
          break;
        case 'KeyF':
          if (this.player.alive) this.player.flashlightOn = !this.player.flashlightOn;
          else this.net.send({ t: 'flick' });
          break;
        case 'KeyC':
          if (this.player.alive && !this.radialHeld) {
            this.radialHeld = true;
            this.radialVec = { x: 0, y: 0 };
            this.ui.showRadial(this.radialSel);
          }
          break;
        case 'KeyE': {
          if (!this.player.alive) break;
          for (const b of this.world.breakers.values()) {
            if (!b.collected && Math.hypot(b.x - this.player.pos.x, b.z - this.player.pos.z) < 2.6) {
              this.net.send({ t: 'breaker', id: b.id });
              break;
            }
          }
          break;
        }
        case 'KeyV':
          if (this.player.alive && this.voice.enabled && !this.voice.talking) {
            this.voice.setTalking(true);
            this.ui.setPTT(true, true);
          }
          break;
        case 'Enter':
        case 'KeyT':
          if (this.player.alive) {
            e.preventDefault();
            this.ui.openChat();
          }
          break;
      }
    });
    document.addEventListener('keyup', (e) => {
      switch (e.code) {
        case 'Tab':
          this.map.visible = false;
          break;
        case 'KeyC':
          if (this.radialHeld) {
            this.radialHeld = false;
            this.ui.hideRadial();
            this.placeChalk();
          }
          break;
        case 'KeyV':
          if (this.voice.talking) {
            this.voice.setTalking(false);
            this.ui.setPTT(false, true);
          }
          break;
      }
    });
    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
      this.fx.resize(innerWidth, innerHeight);
    });

    this.ui.onChat = (text) => this.net.send({ t: 'chat', text });
  }

  private placeChalk(): void {
    const m = this.chalk.tryPlace(this.camera, this.world.raycastTargets(), this.radialSel, this.player.yaw + Math.PI / 2);
    if (m) {
      this.net.send({ t: 'chalk', m });
      this.audio.chalkScratch();
    } else {
      this.ui.toast('nothing close enough to mark');
    }
  }

  // ---------------------------------------------------------------- death

  private die(): void {
    if (!this.player.alive) return;
    this.player.alive = false;
    this.audio.deathSting();
    this.fx.flash = 1.6;
    // face it
    const e = this.entity;
    if (e.active) {
      this.player.yaw = Math.atan2(e.pos.x - this.player.pos.x, e.pos.y - this.player.pos.z) + Math.PI;
    }
    document.exitPointerLock();
    setTimeout(() => {
      if (!this.ended) {
        this.ui.showDeath();
      }
    }, 1300);
  }

  // ---------------------------------------------------------------- loop

  private loop = (): void => {
    if (this.disposed) return;
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    const time = this.clock.elapsedTime;
    const now = performance.now() / 1000;
    const p = this.player;

    p.update(dt, time);
    this.world.update(p.pos.x, p.pos.z, time);
    const hum = this.lights.update(this.world, p.pos.x, p.pos.z, time);
    this.map.visit(p.pos.x, p.pos.z);

    // remote avatars + their footsteps
    for (const [id, av] of this.avatars) {
      av.update(now, dt, this.seed, p.pos, p.alive);
      const anim = av.lastState[5];
      if (av.alive && (anim === 1 || anim === 2)) {
        const d = Math.hypot(av.lastState[0] - p.pos.x, av.lastState[2] - p.pos.z);
        if (d < 22) {
          let t = (this.stepTimers.get(id) ?? 0) - dt;
          if (t <= 0) {
            this.audio.posFootstep(av.lastState[0], av.lastState[2], anim === 2 ? 0.8 : 0.45);
            t = anim === 2 ? 0.29 : 0.48;
          }
          this.stepTimers.set(id, t);
        }
      }
    }

    // entity + danger
    let danger = this.entity.update(dt, time, p.pos);
    const glimpseDanger = this.glimpse.update(dt, time, p.pos) * 0.45;
    danger = Math.max(danger, glimpseDanger);
    this.audio.danger = p.alive ? danger : 0;
    this.fx.danger = p.alive ? danger : 0;
    if (p.alive && danger > 0.55) p.shake = Math.max(p.shake, (danger - 0.55) * 0.05);
    if (this.entity.active && this.entity.mode === 2) {
      const t = this.stepTimers.get('__entity') ?? 0;
      const nt = t - dt;
      if (nt <= 0) {
        this.audio.posFootstep(this.entity.pos.x, this.entity.pos.y, 1, true);
        const d = Math.hypot(this.entity.pos.x - p.pos.x, this.entity.pos.y - p.pos.z);
        if (d < 13) p.shake = Math.max(p.shake, 0.02 * (1 - d / 13));
        this.stepTimers.set('__entity', 0.34);
      } else this.stepTimers.set('__entity', nt);
    }

    // flashlight-on-it detection → tell the server (it hates the light)
    if (p.alive) {
      let shine = false;
      if (p.flashlightOn && this.entity.active) {
        const dx = this.entity.pos.x - p.pos.x, dz = this.entity.pos.y - p.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 15 && d > 0.5) {
          const fwd = new THREE.Vector3();
          this.camera.getWorldDirection(fwd);
          const dot = (fwd.x * dx + fwd.z * dz) / d;
          if (dot > 0.975 && !losBlocked(this.seed, p.pos.x, p.pos.z, this.entity.pos.x, this.entity.pos.y)) shine = true;
        }
      }
      if (shine !== this.shining) {
        this.shining = shine;
        this.net.send({ t: 'shine', on: shine });
        if (shine && !this.shineToastShown) {
          this.shineToastShown = true;
          this.ui.toast('it slows in your beam — hold the light on it');
        }
      }
    }

    // glimpses: between real hunts, something watches from down the hall
    if (p.alive && !this.entity.active && p.sanity < 78) {
      if (this.glimpse.active) {
        const gd = Math.hypot(this.glimpse.pos.x - p.pos.x, this.glimpse.pos.y - p.pos.z);
        if (now > this.glimpseUntil || gd < 7.5) {
          this.glimpse.sync(null);
          this.audio.whisper(this.glimpse.pos.x, this.glimpse.pos.y);
        }
      } else {
        this.glimpseTimer -= dt * (1 + (78 - p.sanity) / 50);
        if (this.glimpseTimer <= 0) {
          this.glimpseTimer = 40 + Math.random() * 55;
          const fwd = new THREE.Vector3();
          this.camera.getWorldDirection(fwd);
          const gd = 11 + Math.random() * 7;
          let gx = p.pos.x + fwd.x * gd + (Math.random() - 0.5) * 5;
          let gz = p.pos.z + fwd.z * gd + (Math.random() - 0.5) * 5;
          ({ x: gx, z: gz } = resolveCollision(this.seed, gx, gz, 0.4));
          if (!losBlocked(this.seed, p.pos.x, p.pos.z, gx, gz)) {
            this.glimpse.sync([gx, gz, 1, null]);
            this.glimpseUntil = now + 1.1 + Math.random() * 0.6;
          }
        }
      }
    } else if (this.glimpse.active && this.entity.active) {
      this.glimpse.sync(null); // the real thing displaces the imagined one
    }

    // uncollected breakers spit sparks — follow the sound
    this.sparkTimer -= dt;
    if (this.sparkTimer <= 0) {
      this.sparkTimer = 3.5 + Math.random() * 3;
      let nb: { x: number; z: number } | null = null, nd = 24;
      for (const b of this.world.breakers.values()) {
        if (b.collected) continue;
        const d = Math.hypot(b.x - p.pos.x, b.z - p.pos.z);
        if (d < nd) { nd = d; nb = b; }
      }
      if (nb) this.audio.spark(nb.x, nb.z);
    }

    // "E — pull the breaker" hint
    if (p.alive) {
      let nearBreaker = false;
      for (const b of this.world.breakers.values()) {
        if (!b.collected && Math.hypot(b.x - p.pos.x, b.z - p.pos.z) < 2.6) { nearBreaker = true; break; }
      }
      this.ui.setHint(nearBreaker ? 'E — pull the breaker' : '');
    }

    // sanity: isolation gnaws, company heals
    if (p.alive) {
      let nearest = Infinity;
      for (const av of this.avatars.values()) {
        if (!av.alive) continue;
        nearest = Math.min(nearest, Math.hypot(av.lastState[0] - p.pos.x, av.lastState[2] - p.pos.z));
      }
      const dark = this.lights.lights.every((l) => l.intensity < 0.5);
      let d = 0;
      if (nearest > 30) d += 0.9;
      if (dark) d += 0.8;
      if (danger > 0.3) d += 2.2 * danger;
      if (nearest < 10) d -= 2.0;
      p.sanity = Math.max(5, Math.min(100, p.sanity - d * dt));
    }
    this.audio.sanity = p.sanity;
    this.fx.sanity = p.sanity;

    // pickups
    if (p.alive) {
      for (const chunk of this.world.chunks.values()) {
        if (!chunk.almond) continue;
        const a = chunk.almond.mesh.position;
        if (Math.hypot(a.x - p.pos.x, a.z - p.pos.z) < 1.4) {
          this.net.send({ t: 'pickup', id: chunk.almond.id });
        }
      }
    }

    // the exit
    const ex = this.world.exit;
    const exDist = Math.hypot(ex.x - p.pos.x, ex.z - p.pos.z);
    if (exDist < 30 && !this.map.exitSeen) {
      this.map.exitSeen = { x: ex.x, z: ex.z };
      this.ui.toast(this.world.powered
        ? 'the doorway is live. bring everyone.'
        : 'a dead doorway. it wants power — find the breakers.', 5000);
    }
    if (this.exitSense > 0) this.exitSense -= dt;

    // audio housekeeping
    this.audio.setHum(hum);
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    this.audio.setListener(this.camera.position, fwd);
    this.audio.update(dt, p.pos);
    this.voice.update(this.avatars, p.pos, this.seed, danger, p.alive);

    // hud
    this.ui.setStamina(p.stamina);
    this.map.draw(this.seed, p.pos.x, p.pos.z, p.yaw, this.avatars, now, [...this.world.breakers.values()]);

    this.fx.render(dt, time);
  };

  dispose(): void {
    this.disposed = true;
    clearInterval(this.stateTimer);
    this.renderer.dispose();
  }
}
