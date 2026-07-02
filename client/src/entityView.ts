// Client-side rendering of the server-authoritative entity: a too-tall
// silhouette that is wrong in ways you notice before you can name them.
import * as THREE from 'three';
import type { EntityTuple } from '@shared/protocol';

export class EntityView {
  group = new THREE.Group();
  active = false;
  mode = 0;
  pos = new THREE.Vector2();
  private target = new THREE.Vector2();
  private eyeL: THREE.Mesh;
  private eyeR: THREE.Mesh;
  private limbs: THREE.Mesh[] = [];
  private twitch = 0;

  constructor(scene: THREE.Scene) {
    const flesh = new THREE.MeshStandardMaterial({ color: 0x0b0a0a, roughness: 0.55 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.26, 1.7, 7), flesh);
    body.position.y = 1.55;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 7), flesh);
    head.position.y = 2.5;
    head.scale.set(0.9, 1.4, 0.9);

    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffefaf });
    this.eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.022, 6, 6), eyeMat);
    this.eyeR = new THREE.Mesh(new THREE.SphereGeometry(0.022, 6, 6), eyeMat);
    this.eyeL.position.set(-0.055, 2.55, -0.13);
    this.eyeR.position.set(0.055, 2.55, -0.13);

    const armGeo = new THREE.CylinderGeometry(0.035, 0.05, 1.5, 5);
    armGeo.translate(0, -0.75, 0);
    for (const s of [-1, 1]) {
      const arm = new THREE.Mesh(armGeo, flesh);
      arm.position.set(s * 0.3, 2.25, 0);
      arm.rotation.z = s * 0.18;
      this.limbs.push(arm);
      this.group.add(arm);
    }
    const legGeo = new THREE.CylinderGeometry(0.05, 0.06, 1.1, 5);
    legGeo.translate(0, -0.55, 0);
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, flesh);
      leg.position.set(s * 0.12, 1.1, 0);
      this.limbs.push(leg);
      this.group.add(leg);
    }

    this.group.add(body, head, this.eyeL, this.eyeR);
    this.group.visible = false;
    scene.add(this.group);
  }

  sync(e: EntityTuple | null): void {
    if (!e) {
      if (this.active) this.active = false;
      return;
    }
    if (!this.active) {
      this.pos.set(e[0], e[1]); // snap on spawn — it was never "coming", it was already there
      this.active = true;
    }
    this.target.set(e[0], e[1]);
    this.mode = e[2];
  }

  update(dt: number, time: number, myPos: THREE.Vector3): number {
    this.group.visible = this.active;
    if (!this.active) return 0;
    // smooth follow of server position
    this.pos.lerp(this.target, Math.min(1, dt * 8));
    this.group.position.set(this.pos.x, 0, this.pos.y);
    // face movement direction / the player when close
    const dx = myPos.x - this.pos.x, dz = myPos.z - this.pos.y;
    const dist = Math.hypot(dx, dz);
    if (dist < 20) this.group.rotation.y = Math.atan2(dx, dz);

    // wrong-twitch
    this.twitch += dt * (this.mode === 2 ? 26 : 9);
    const j = Math.sin(this.twitch * 3.1) * Math.sin(this.twitch * 1.7);
    this.group.scale.y = 1 + j * 0.02;
    this.group.rotation.z = j * 0.03;
    this.limbs.forEach((l, i) => {
      l.rotation.x = Math.sin(this.twitch + i * 2.1) * (this.mode === 2 ? 0.7 : 0.2);
    });
    const blink = Math.sin(time * 0.7) > -0.96;
    this.eyeL.visible = this.eyeR.visible = blink;

    // danger 0..1 for post-fx / audio
    return Math.max(0, Math.min(1, 1 - dist / 28)) * (this.mode === 2 ? 1 : 0.6);
  }
}
