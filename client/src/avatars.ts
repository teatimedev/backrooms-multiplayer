// Remote players: deliberately low-poly explorers with headlamps you can see
// sweeping down a distant hallway. Interpolated 150ms behind the network.
import * as THREE from 'three';
import { losBlocked } from '@shared/worldgen';
import { AVATAR_COLORS, type PlayerInfo, type StateTuple } from '@shared/protocol';

const INTERP_DELAY = 0.15;

interface Snap { t: number; s: StateTuple }

function makeNameTag(name: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.font = '28px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  const w = ctx.measureText(name).width + 24;
  ctx.fillRect(128 - w / 2, 12, w, 40);
  ctx.fillStyle = '#e8e0c8';
  ctx.fillText(name, 128, 40);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(1.6, 0.4, 1);
  sp.position.y = 2.05;
  return sp;
}

export class Avatar {
  group = new THREE.Group();
  headlamp: THREE.SpotLight;
  alive = true;
  carrying = false; // level 1: hauling a fuel canister
  private can: THREE.Mesh;
  private snaps: Snap[] = [];
  private head: THREE.Group;
  private legL: THREE.Mesh; private legR: THREE.Mesh;
  private armL: THREE.Mesh; private armR: THREE.Mesh;
  private tag: THREE.Sprite;
  private swingT = 0;
  private losTimer = 0;
  private tagOpacity = 0;
  lastState: StateTuple = [0, 1.6, 0, 0, 0, 0, 0];

  constructor(public info: PlayerInfo, scene: THREE.Scene) {
    const col = AVATAR_COLORS[info.color % AVATAR_COLORS.length];
    const suit = new THREE.MeshStandardMaterial({ color: col, roughness: 0.8 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x22201c, roughness: 0.9 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xc8a685, roughness: 0.85 });

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.55, 0.24), suit);
    torso.position.y = 1.12;
    const hips = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.16, 0.22), dark);
    hips.position.y = 0.78;

    this.head = new THREE.Group();
    const skull = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.28, 0.26), skin);
    const lampBody = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.07, 0.08), dark);
    lampBody.position.set(0, 0.08, -0.15);
    const lampLens = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.05, 0.02),
      new THREE.MeshBasicMaterial({ color: 0xfff3c9 }));
    lampLens.position.set(0, 0.08, -0.2);
    this.head.add(skull, lampBody, lampLens);
    this.head.position.y = 1.56;

    const legGeo = new THREE.BoxGeometry(0.15, 0.7, 0.16);
    legGeo.translate(0, -0.35, 0);
    this.legL = new THREE.Mesh(legGeo, dark); this.legL.position.set(-0.11, 0.7, 0);
    this.legR = new THREE.Mesh(legGeo, dark); this.legR.position.set(0.11, 0.7, 0);
    const armGeo = new THREE.BoxGeometry(0.11, 0.55, 0.12);
    armGeo.translate(0, -0.24, 0);
    this.armL = new THREE.Mesh(armGeo, suit); this.armL.position.set(-0.28, 1.38, 0);
    this.armR = new THREE.Mesh(armGeo, suit); this.armR.position.set(0.28, 1.38, 0);

    this.tag = makeNameTag(info.name);
    this.group.add(torso, hips, this.head, this.legL, this.legR, this.armL, this.armR, this.tag);
    this.group.traverse((o) => { (o as THREE.Mesh).castShadow = true; });

    this.headlamp = new THREE.SpotLight(0xfff3c9, 24, 28, 0.38, 0.5, 1.6);
    this.headlamp.position.y = 1.62;
    this.group.add(this.headlamp, this.headlamp.target);
    this.headlamp.target.position.set(0, 1.3, -8);
    // their beam, visible from across a dark hall — the emotional beacon
    const beamGeo = new THREE.ConeGeometry(2.0, 9, 10, 1, true);
    beamGeo.translate(0, -4.5, 0);
    beamGeo.rotateX(-Math.PI / 2);
    const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
      color: 0xfff3c9, transparent: true, opacity: 0.03,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false,
    }));
    beam.position.set(0, 1.62, -0.2);
    this.headlamp.add(beam); // inherits visibility with the lamp

    this.can = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.42, 0.22),
      new THREE.MeshStandardMaterial({ color: 0xa8281e, roughness: 0.5, metalness: 0.3 }));
    this.can.position.set(0, 1.05, 0.28); // strapped to their back
    this.can.visible = false;
    this.group.add(this.can);

    scene.add(this.group);
  }

  push(s: StateTuple, now: number): void {
    this.snaps.push({ t: now, s });
    if (this.snaps.length > 30) this.snaps.shift();
    this.lastState = s;
  }

  update(now: number, dt: number, seed: number, myPos: THREE.Vector3, iAmAlive: boolean): void {
    // echoes are invisible to the living
    this.group.visible = this.alive || !iAmAlive;

    const t = now - INTERP_DELAY;
    let a = this.snaps[0], b = this.snaps[0];
    for (let i = 1; i < this.snaps.length; i++) {
      if (this.snaps[i].t >= t) { b = this.snaps[i]; a = this.snaps[i - 1]; break; }
      a = b = this.snaps[i];
    }
    if (!a) return;
    const span = Math.max(1e-4, b.t - a.t);
    const k = Math.max(0, Math.min(1, (t - a.t) / span));
    const lerpA = (x: number, y: number): number => x + (y - x) * k;
    let yaw = a.s[3] + shortestAngle(a.s[3], b.s[3]) * k;

    const x = lerpA(a.s[0], b.s[0]);
    const y = lerpA(a.s[1], b.s[1]);
    const z = lerpA(a.s[2], b.s[2]);
    const pitch = lerpA(a.s[4], b.s[4]);
    const anim = b.s[5];

    this.group.position.set(x, anim === 3 ? y - 1.3 : anim === 4 ? 0.12 : 0, z);
    this.group.rotation.y = yaw;
    // downed: pitch the whole body onto the carpet
    this.group.rotation.x += ((anim === 4 ? -1.25 : 0) - this.group.rotation.x) * Math.min(1, dt * 5);
    this.head.rotation.x = -pitch * 0.8;

    // limb swing scaled to gait (downed: weak drag)
    const rate = anim === 4 ? 2.5 : anim === 2 ? 11 : anim === 1 ? 6.5 : 0;
    const amp = anim === 4 ? 0.3 : anim === 2 ? 0.85 : anim === 1 ? 0.5 : 0;
    this.swingT += dt * rate;
    const s = Math.sin(this.swingT) * amp;
    this.legL.rotation.x = s; this.legR.rotation.x = -s;
    this.armL.rotation.x = -s * 0.8; this.armR.rotation.x = s * 0.8;
    if (anim === 0) {
      this.legL.rotation.x *= 0.9; this.legR.rotation.x *= 0.9;
      this.armL.rotation.x = Math.sin(now * 1.3) * 0.04;
      this.armR.rotation.x = Math.sin(now * 1.3 + 1) * 0.04;
    }

    // name tag: proximity fade + wall occlusion (checked at 6Hz)
    this.losTimer -= dt;
    const dist = Math.hypot(x - myPos.x, z - myPos.z);
    if (this.losTimer <= 0) {
      this.losTimer = 0.16;
      const blocked = losBlocked(seed, myPos.x, myPos.z, x, z);
      const target = blocked || dist > 18 ? 0 : Math.min(1, (18 - dist) / 6);
      this.tagOpacity = target;
    }
    const mat = this.tag.material as THREE.SpriteMaterial;
    mat.opacity += (this.tagOpacity - mat.opacity) * Math.min(1, dt * 6);
    this.headlamp.visible = this.alive && anim !== 4;
    this.can.visible = this.carrying && this.alive;
    // sprites ignore group rotation, so keep the tag above a downed body
    this.tag.position.y = anim === 4 ? 0.9 : 2.05;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
  }
}

function shortestAngle(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
