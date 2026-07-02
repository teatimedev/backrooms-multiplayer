// Entirely procedural Web Audio. The hum is the room tone of purgatory;
// everything else is noise bursts, filtered and placed in 3D.
import * as THREE from 'three';

type Surface = 'carpet' | 'tile' | 'concrete';

export class GameAudio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private humGain!: GainNode;
  private droneGain!: GainNode;
  private noiseBuf!: AudioBuffer;
  private eventTimer = 12;
  private heartTimer = 0;
  private whisperTimer = 20;
  danger = 0;
  sanity = 100;

  init(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    this.master = ctx.createGain();
    this.master.gain.value = 0.85;
    this.master.connect(comp).connect(ctx.destination);

    // shared noise buffer
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // ---- fluorescent hum: 120Hz + harmonics + hissy noise band
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0;
    for (const [freq, amp] of [[120, 0.5], [240, 0.22], [360, 0.08]] as const) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      const g = ctx.createGain(); g.gain.value = amp * 0.06;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
      o.connect(g).connect(f).connect(this.humGain);
      o.start();
    }
    const hiss = ctx.createBufferSource();
    hiss.buffer = this.noiseBuf; hiss.loop = true;
    const hf = ctx.createBiquadFilter(); hf.type = 'bandpass'; hf.frequency.value = 6000; hf.Q.value = 2;
    const hg = ctx.createGain(); hg.gain.value = 0.006;
    hiss.connect(hf).connect(hg).connect(this.humGain);
    hiss.start();
    this.humGain.connect(this.master);

    // ---- entity drone: detuned low oscillators, gain driven by danger
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;
    for (const det of [0, 3.5, -4.7]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = 38 + det;
      const g = ctx.createGain(); g.gain.value = 0.33;
      o.connect(g).connect(this.droneGain);
      o.start();
    }
    const sub = ctx.createOscillator();
    sub.type = 'triangle'; sub.frequency.value = 19;
    const sg = ctx.createGain(); sg.gain.value = 0.4;
    sub.connect(sg).connect(this.droneGain);
    sub.start();
    this.droneGain.connect(this.master);
  }

  get ready(): boolean { return !!this.ctx; }

  setListener(pos: THREE.Vector3, fwd: THREE.Vector3): void {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    if (l.positionX) {
      const t = this.ctx.currentTime;
      l.positionX.setTargetAtTime(pos.x, t, 0.05);
      l.positionY.setTargetAtTime(pos.y, t, 0.05);
      l.positionZ.setTargetAtTime(pos.z, t, 0.05);
      l.forwardX.setTargetAtTime(fwd.x, t, 0.05);
      l.forwardY.setTargetAtTime(fwd.y, t, 0.05);
      l.forwardZ.setTargetAtTime(fwd.z, t, 0.05);
      l.upX.setTargetAtTime(0, t, 0.05); l.upY.setTargetAtTime(1, t, 0.05); l.upZ.setTargetAtTime(0, t, 0.05);
    }
  }

  panner(x: number, y: number, z: number): PannerNode {
    const p = this.ctx!.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 1.2;
    p.maxDistance = 70;
    p.rolloffFactor = 1.4;
    p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z;
    return p;
  }

  setHum(level: number): void {
    if (!this.ctx) return;
    this.humGain.gain.setTargetAtTime(0.35 + level * 0.65, this.ctx.currentTime, 0.4);
  }

  update(dt: number, playerPos: THREE.Vector3): void {
    if (!this.ctx) return;
    this.droneGain.gain.setTargetAtTime(this.danger * 0.5, this.ctx.currentTime, 0.6);

    // heartbeat under threat
    if (this.danger > 0.25) {
      this.heartTimer -= dt;
      if (this.heartTimer <= 0) {
        this.heartTimer = 1.05 - this.danger * 0.55;
        this.thump(0.14 * this.danger);
        setTimeout(() => this.thump(0.09 * this.danger), 180);
      }
    }

    // distant, positioned dread on a slow random clock
    this.eventTimer -= dt;
    if (this.eventTimer <= 0) {
      this.eventTimer = 18 + Math.random() * 35;
      const a = Math.random() * Math.PI * 2, r = 18 + Math.random() * 25;
      const x = playerPos.x + Math.cos(a) * r, z = playerPos.z + Math.sin(a) * r;
      const pick = Math.random();
      if (pick < 0.4) this.distantThud(x, z);
      else if (pick < 0.7) this.scrape(x, z);
      else this.doorSlam(x, z);
    }

    // whispers when sanity crumbles
    if (this.sanity < 40) {
      this.whisperTimer -= dt * (1 + (40 - this.sanity) / 25);
      if (this.whisperTimer <= 0) {
        this.whisperTimer = 9 + Math.random() * 14;
        const a = Math.random() * Math.PI * 2;
        this.whisper(playerPos.x + Math.cos(a) * 3, playerPos.z + Math.sin(a) * 3);
      }
    }
  }

  private burst(dest: AudioNode, dur: number, filterType: BiquadFilterType, freq: number, q: number, gain: number, decay: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filterType; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random());
    src.stop(t + dur);
  }

  footstep(surface: Surface, intensity: number): void {
    if (!this.ctx) return;
    const cfg = {
      carpet: { f: 320, q: 0.8, g: 0.10, d: 0.11 },
      tile: { f: 1900, q: 2.5, g: 0.09, d: 0.09 },
      concrete: { f: 800, q: 1.4, g: 0.11, d: 0.13 },
    }[surface];
    this.burst(this.master, 0.25, 'bandpass', cfg.f * (0.9 + Math.random() * 0.2), cfg.q, cfg.g * intensity, cfg.d);
  }

  posFootstep(x: number, z: number, intensity: number, heavy = false): void {
    if (!this.ctx) return;
    const p = this.panner(x, 0.2, z);
    p.connect(this.master);
    this.burst(p, 0.3, 'bandpass', heavy ? 180 : 500, 1.2, (heavy ? 0.7 : 0.35) * intensity, heavy ? 0.22 : 0.12);
  }

  private thump(g: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(58, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(38, ctx.currentTime + 0.12);
    const gg = ctx.createGain();
    gg.gain.setValueAtTime(g, ctx.currentTime);
    gg.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16);
    o.connect(gg).connect(this.master);
    o.start(); o.stop(ctx.currentTime + 0.2);
  }

  distantThud(x: number, z: number): void {
    if (!this.ctx) return;
    const p = this.panner(x, 1, z); p.connect(this.master);
    this.burst(p, 0.5, 'lowpass', 130, 0.7, 1.6, 0.4);
  }

  scrape(x: number, z: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const p = this.panner(x, 1.5, z); p.connect(this.master);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 9;
    const t = ctx.currentTime;
    f.frequency.setValueAtTime(700, t);
    f.frequency.linearRampToValueAtTime(1600, t + 1.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.3);
    g.gain.linearRampToValueAtTime(0, t + 1.5);
    src.connect(f).connect(g).connect(p);
    src.start(t, Math.random()); src.stop(t + 1.6);
  }

  doorSlam(x: number, z: number): void {
    if (!this.ctx) return;
    const p = this.panner(x, 1, z); p.connect(this.master);
    this.burst(p, 0.3, 'lowpass', 400, 1, 1.8, 0.12);
    this.burst(p, 0.5, 'bandpass', 2400, 3, 0.4, 0.3);
  }

  /** The entity borrowing someone's footsteps — or their voice. */
  mimic(x: number, z: number, kind: 'steps' | 'voice'): void {
    if (!this.ctx) return;
    if (kind === 'steps') {
      let i = 0;
      const step = (): void => {
        this.posFootstep(x, z, 0.9);
        if (++i < 5) setTimeout(step, 380 + Math.random() * 80);
      };
      step();
    } else {
      // a voice-shaped thing: formant-ish filtered noise, wrong cadence
      const ctx = this.ctx;
      const p = this.panner(x, 1.6, z); p.connect(this.master);
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf; src.loop = true;
      const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 480; f1.Q.value = 6;
      const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 1200; f2.Q.value = 7;
      const g = ctx.createGain();
      const t = ctx.currentTime;
      g.gain.setValueAtTime(0, t);
      for (let i = 0; i < 6; i++) {
        g.gain.linearRampToValueAtTime(Math.random() * 0.4, t + 0.1 + i * 0.22);
        g.gain.linearRampToValueAtTime(0.02, t + 0.2 + i * 0.22);
      }
      g.gain.linearRampToValueAtTime(0, t + 1.6);
      src.connect(f1).connect(g);
      src.connect(f2).connect(g);
      g.connect(p);
      src.start(t, Math.random()); src.stop(t + 1.7);
    }
  }

  whisper(x: number, z: number): void {
    if (!this.ctx) return;
    const p = this.panner(x, 1.6, z); p.connect(this.master);
    this.burst(p, 1.2, 'bandpass', 3000 + Math.random() * 2000, 8, 0.12, 1.0);
  }

  /** Electrical spitting from an unpulled breaker — an audio beacon. */
  spark(x: number, z: number): void {
    if (!this.ctx) return;
    const p = this.panner(x, 1.2, z); p.connect(this.master);
    for (let i = 0; i < 3; i++) {
      setTimeout(() => this.burst(p, 0.12, 'highpass', 5200, 1.5, 0.3, 0.05), i * (60 + Math.random() * 90));
    }
  }

  breakerClunk(): void {
    if (!this.ctx) return;
    this.thump(0.35);
    this.burst(this.master, 0.3, 'bandpass', 2600, 3, 0.35, 0.18);
    setTimeout(() => this.burst(this.master, 0.6, 'lowpass', 300, 1, 0.6, 0.4), 130);
  }

  /** The entity driven off by light: a shriek falling away into the maze. */
  retreatShriek(x: number, z: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const p = this.panner(x, 1.8, z); p.connect(this.master);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const t = ctx.currentTime;
    o.frequency.setValueAtTime(900, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 1.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.4, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.7);
    o.connect(g).connect(p);
    o.start(); o.stop(t + 1.8);
    this.burst(p, 1.0, 'highpass', 2000, 1, 0.3, 0.8);
  }

  /** Continuous cold drone at the powered exit — audible from ~35m. */
  setExitBeacon(x: number, z: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const p = this.panner(x, 1.6, z);
    p.maxDistance = 80; p.rolloffFactor = 1.1;
    p.connect(this.master);
    for (const [f, a] of [[110, 0.05], [165, 0.03], [220, 0.02]] as const) {
      const o = ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f;
      const g = ctx.createGain(); g.gain.value = a;
      o.connect(g).connect(p);
      o.start();
    }
  }

  flickerZap(x: number, z: number): void {
    if (!this.ctx) return;
    const p = this.panner(x, 2.8, z); p.connect(this.master);
    this.burst(p, 0.2, 'highpass', 4000, 1, 0.25, 0.15);
  }

  pickup(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    const t = ctx.currentTime;
    o.frequency.setValueAtTime(520, t);
    o.frequency.linearRampToValueAtTime(780, t + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    o.connect(g).connect(this.master);
    o.start(); o.stop(t + 0.55);
  }

  chalkScratch(): void {
    if (!this.ctx) return;
    this.burst(this.master, 0.25, 'bandpass', 3400, 4, 0.12, 0.2);
  }

  deathSting(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    // shriek: FM pitch dive + noise wall
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(1400, t);
    o.frequency.exponentialRampToValueAtTime(90, t + 1.1);
    const dist = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const x = (i / 128) - 1; curve[i] = Math.tanh(x * 6); }
    dist.curve = curve;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.3);
    o.connect(dist).connect(g).connect(this.master);
    o.start(); o.stop(t + 1.4);
    this.burst(this.master, 1.2, 'highpass', 900, 0.7, 0.65, 0.9);
  }

  winChord(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    [220, 277, 330, 440].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + i * 0.12);
      g.gain.linearRampToValueAtTime(0.09, t + i * 0.12 + 0.3);
      g.gain.exponentialRampToValueAtTime(0.001, t + 4);
      o.connect(g).connect(this.master);
      o.start(t + i * 0.12); o.stop(t + 4.2);
    });
  }
}
