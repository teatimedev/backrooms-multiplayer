// Post-processing: bloom on the fluorescents, then a single grade pass doing
// film grain, sickly grading, vignette, chromatic aberration and VHS tearing
// that all scale with danger and crumbling sanity.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    danger: { value: 0 },
    sanity: { value: 1 },   // 0..1
    wound: { value: 0 },    // 0..1 downed / bleeding out
    flash: { value: 0 },    // death/win white-out
    fade: { value: 1 },     // scene fade-in
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float time, danger, sanity, wound, flash, fade;
    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    void main() {
      vec2 uv = vUv;
      float unease = danger + (1.0 - sanity) * 0.5;

      // VHS horizontal tearing under threat
      float tear = step(0.996 - danger * 0.012, hash(vec2(floor(uv.y * 90.0), floor(time * 18.0))));
      uv.x += tear * (hash(vec2(time, uv.y)) - 0.5) * 0.08 * unease;
      uv.x += sin(uv.y * 700.0 + time * 30.0) * 0.0012 * danger;

      // chromatic aberration from centre
      vec2 c = uv - 0.5;
      float ab = 0.0016 + unease * 0.006;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + c * ab).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c * ab).b;

      // sickly yellow-green grade, lifted blacks
      col = pow(col, vec3(0.96, 0.93, 1.05));
      col *= vec3(1.06, 1.02, 0.86);
      col = col * 0.94 + 0.015;

      // vignette tightens as sanity drops
      float vig = smoothstep(0.95, 0.28 - (1.0 - sanity) * 0.15, length(c));
      col *= mix(0.35, 1.0, vig);

      // film grain + scanlines
      float g = hash(uv * vec2(1920.0, 1080.0) + fract(time) * 100.0);
      col += (g - 0.5) * (0.05 + unease * 0.09);
      col *= 1.0 - 0.06 * sin(uv.y * 800.0);

      // danger pulse at the edges
      col.r += (1.0 - vig) * danger * 0.12 * (0.6 + 0.4 * sin(time * 9.0));

      // downed: the world drains and bleeds at the rim, pulsing with a slow heart
      float wpulse = 0.7 + 0.3 * sin(time * 3.2);
      col = mix(col, vec3(dot(col, vec3(0.35, 0.5, 0.15))), wound * 0.55);
      col.r += (1.0 - vig) * wound * 0.35 * wpulse;
      col *= 1.0 - wound * 0.25;

      col = mix(col, vec3(1.0), clamp(flash, 0.0, 1.0));
      col *= fade;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export class FX {
  composer: EffectComposer;
  private grade: ShaderPass;
  danger = 0;
  sanity = 100;
  wound = 0;
  flash = 0;
  fade = 0;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.6, 0.82);
    this.composer.addPass(bloom);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
  }

  resize(w: number, h: number): void { this.composer.setSize(w, h); }

  render(dt: number, time: number): void {
    const u = this.grade.uniforms;
    u.time.value = time;
    u.danger.value += (this.danger - u.danger.value) * Math.min(1, dt * 3);
    u.sanity.value = this.sanity / 100;
    u.wound.value += (this.wound - u.wound.value) * Math.min(1, dt * 2.5);
    this.flash = Math.max(0, this.flash - dt * 1.2);
    u.flash.value = this.flash;
    this.fade = Math.min(1, this.fade + dt * 0.4);
    u.fade.value = this.fade;
    this.composer.render();
  }
}
