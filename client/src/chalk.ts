// Chalk marks: hold C, flick the mouse toward a symbol, release to scrawl it
// on whatever surface you're looking at. Synced and persistent per session.
import * as THREE from 'three';
import type { Mark } from '@shared/protocol';
import { chalkTex, CHALK_SYMBOLS } from './textures';

export { CHALK_SYMBOLS };

export class ChalkSystem {
  private textures: THREE.CanvasTexture[] = [];
  private meshes: THREE.Mesh[] = [];
  private ray = new THREE.Raycaster();

  constructor(private scene: THREE.Scene) {
    for (let i = 0; i < CHALK_SYMBOLS.length; i++) this.textures.push(chalkTex(i));
  }

  /** Raycast from camera; returns mark data to send, or null if no surface near. */
  tryPlace(camera: THREE.Camera, targets: THREE.Object3D[], sym: number, yaw: number): Omit<Mark, 'by'> | null {
    this.ray.setFromCamera(new THREE.Vector2(0, 0), camera);
    this.ray.far = 3.6;
    const hits = this.ray.intersectObjects(targets, false);
    const hit = hits[0];
    if (!hit || !hit.face) return null;
    const n = hit.face.normal.clone();
    // instanced meshes / rotated planes: bring normal into world space
    n.transformDirection(hit.object.matrixWorld);
    // floor/ceiling marks rotate to the player's facing so arrows mean something
    const rot = Math.abs(n.y) > 0.7 ? yaw : 0;
    return {
      x: hit.point.x, y: hit.point.y, z: hit.point.z,
      nx: n.x, ny: n.y, nz: n.z, rot, sym,
    };
  }

  add(m: Mark): void {
    const mat = new THREE.MeshBasicMaterial({
      map: this.textures[m.sym % this.textures.length],
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.55), mat);
    const n = new THREE.Vector3(m.nx, m.ny, m.nz).normalize();
    const pos = new THREE.Vector3(m.x, m.y, m.z).addScaledVector(n, 0.015);
    mesh.position.copy(pos);
    if (Math.abs(n.y) > 0.7) {
      mesh.rotation.x = n.y > 0 ? -Math.PI / 2 : Math.PI / 2;
      mesh.rotation.z = n.y > 0 ? m.rot : -m.rot;
    } else {
      mesh.lookAt(pos.clone().add(n));
    }
    this.scene.add(mesh);
    this.meshes.push(mesh);
  }

  setAll(marks: Mark[]): void {
    for (const mesh of this.meshes) this.scene.remove(mesh);
    this.meshes = [];
    for (const m of marks) this.add(m);
  }
}
