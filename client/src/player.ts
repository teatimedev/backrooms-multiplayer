// First-person body: weighty movement, stamina, head bob, flashlight.
import * as THREE from 'three';
import { PLAYER_R, resolveCollision } from '@shared/worldgen';
import type { Anim } from '@shared/protocol';

const EYE = 1.62;
const WALK = 3.7, RUN = 6.6, ECHO_FLY = 8.5;
const ACCEL = 24, FRICTION = 11;

export class Player {
  pos = new THREE.Vector3(0, EYE, 0);
  vel = new THREE.Vector3();
  yaw = 0; pitch = 0;
  stamina = 1;
  sanity = 100;
  alive = true;
  frozen = true; // no movement until pointer locked & spawned
  anim: Anim = 0;
  flashlightOn = true;
  shake = 0;

  flashlight: THREE.SpotLight;
  private keys = new Set<string>();
  private bobT = 0;
  onFootstep: ((intensity: number) => void) | null = null;
  private sprinting = false;
  fovKick = 0;

  constructor(public camera: THREE.PerspectiveCamera, private seed: number, scene: THREE.Scene) {
    this.flashlight = new THREE.SpotLight(0xfff6e0, 42, 32, 0.42, 0.45, 1.5);
    scene.add(this.flashlight, this.flashlight.target);

    addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  setSeed(seed: number): void { this.seed = seed; }

  spawn(x: number, z: number): void {
    this.pos.set(x, EYE, z);
    this.vel.set(0, 0, 0);
    this.alive = true;
    this.sanity = 100;
    this.stamina = 1;
  }

  look(dx: number, dy: number): void {
    this.yaw -= dx * 0.0023;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - dy * 0.0023));
  }

  update(dt: number, time: number): void {
    const k = this.keys;
    let fx = 0, fz = 0;
    if (!this.frozen) {
      if (k.has('KeyW') || k.has('ArrowUp')) fz -= 1;
      if (k.has('KeyS') || k.has('ArrowDown')) fz += 1;
      if (k.has('KeyA') || k.has('ArrowLeft')) fx -= 1;
      if (k.has('KeyD') || k.has('ArrowRight')) fx += 1;
    }
    const moving = fx !== 0 || fz !== 0;
    const wantRun = k.has('ShiftLeft') || k.has('ShiftRight');
    this.sprinting = this.alive && moving && wantRun && this.stamina > 0.02;
    this.stamina = Math.max(0, Math.min(1, this.stamina + (this.sprinting ? -dt / 6.5 : dt / 5.5)));

    const speed = !this.alive ? ECHO_FLY : this.sprinting ? RUN : WALK;
    // world-space wish direction from yaw (forward is -Z rotated by yaw)
    const f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const r = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = new THREE.Vector3().addScaledVector(f, -fz).addScaledVector(r, fx);
    if (wish.lengthSq() > 0) wish.normalize();

    this.vel.x += (wish.x * speed - this.vel.x) * Math.min(1, ACCEL * dt / speed * (moving ? 1 : 0.5));
    this.vel.z += (wish.z * speed - this.vel.z) * Math.min(1, ACCEL * dt / speed * (moving ? 1 : 0.5));
    if (!moving) {
      const damp = Math.max(0, 1 - FRICTION * dt);
      this.vel.x *= damp; this.vel.z *= damp;
    }

    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    if (this.alive) {
      const solved = resolveCollision(this.seed, this.pos.x, this.pos.z, PLAYER_R);
      this.pos.x = solved.x; this.pos.z = solved.z;
    } else {
      // echoes drift: pitch controls vertical
      this.pos.y = Math.max(0.4, Math.min(2.9, this.pos.y + (k.has('Space') ? 2 : k.has('KeyQ') ? -2 : 0) * dt));
    }

    // head bob + breathing
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    const prevPhase = this.bobT;
    this.bobT += dt * (4 + hSpeed * 1.35);
    const bobAmp = this.alive ? Math.min(0.05, hSpeed * 0.011) : 0;
    const bob = Math.sin(this.bobT) * bobAmp;
    const breathe = Math.sin(time * 1.4) * 0.008 * (this.alive ? 1 : 0);
    if (this.alive && hSpeed > 0.6 && Math.sin(prevPhase) > 0 && Math.sin(this.bobT) <= 0) {
      this.onFootstep?.(this.sprinting ? 1 : 0.55);
    }

    this.anim = !this.alive ? 3 : hSpeed > 4.2 ? 2 : hSpeed > 0.4 ? 1 : 0;

    // camera
    const cam = this.camera;
    cam.position.set(this.pos.x, (this.alive ? EYE : this.pos.y) + bob + breathe, this.pos.z);
    cam.rotation.set(0, 0, 0);
    cam.rotateY(this.yaw);
    cam.rotateX(this.pitch);
    cam.rotateZ(Math.sin(this.bobT * 0.5) * bobAmp * 0.4);
    // proximity terror: the world judders
    this.shake = Math.max(0, this.shake - dt * 0.12);
    if (this.shake > 0.0005) {
      cam.rotateX((Math.random() - 0.5) * this.shake);
      cam.rotateZ((Math.random() - 0.5) * this.shake);
    }

    // sprint FOV kick
    this.fovKick += ((this.sprinting ? 1 : 0) - this.fovKick) * Math.min(1, dt * 5);
    cam.fov = 74 + this.fovKick * 8;
    cam.updateProjectionMatrix();

    // flashlight follows view with a soft lag
    const fl = this.flashlight;
    fl.visible = this.flashlightOn && this.alive;
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    fl.position.copy(cam.position).addScaledVector(r, 0.18).add(new THREE.Vector3(0, -0.12, 0));
    const targetPos = cam.position.clone().addScaledVector(dir, 12);
    fl.target.position.lerp(targetPos, Math.min(1, dt * 14));
  }
}
