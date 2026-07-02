// Proximity voice chat: WebRTC mesh, signalled over the game WebSocket.
// Each remote voice runs through gain (distance) → lowpass (walls) →
// waveshaper mix (entity interference) → HRTF panner.
import * as THREE from 'three';
import { losBlocked } from '@shared/worldgen';
import type { Net } from './net';
import type { GameAudio } from './audio';
import type { Avatar } from './avatars';

const RTC_CFG: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const VOICE_RANGE = 26;

interface Peer {
  pc: RTCPeerConnection;
  gain: GainNode | null;
  lowpass: BiquadFilterNode | null;
  dry: GainNode | null;
  wet: GainNode | null;
  panner: PannerNode | null;
}

export class Voice {
  enabled = false;
  talking = false;
  private local: MediaStream | null = null;
  private peers = new Map<string, Peer>();
  private myId = '';

  constructor(private net: Net, private audio: GameAudio) {
    net.on('rtc', async (msg) => this.onSignal(msg.from, msg.data as Record<string, unknown>));
  }

  async enable(myId: string, otherIds: string[]): Promise<boolean> {
    this.myId = myId;
    try {
      this.local = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      return false;
    }
    this.setTalking(false);
    this.enabled = true;
    for (const id of otherIds) this.connectTo(id);
    return true;
  }

  setTalking(on: boolean): void {
    this.talking = on;
    this.local?.getAudioTracks().forEach((t) => { t.enabled = on; });
  }

  /** Deterministic initiator avoids offer glare: lower id calls higher id. */
  connectTo(id: string): void {
    if (!this.enabled || this.peers.has(id)) return;
    if (this.myId < id) void this.makeOffer(id);
  }

  drop(id: string): void {
    const p = this.peers.get(id);
    if (p) { p.pc.close(); this.peers.delete(id); }
  }

  private createPeer(id: string): Peer {
    const pc = new RTCPeerConnection(RTC_CFG);
    const peer: Peer = { pc, gain: null, lowpass: null, dry: null, wet: null, panner: null };
    this.peers.set(id, peer);
    this.local?.getTracks().forEach((t) => pc.addTrack(t, this.local!));
    pc.onicecandidate = (e) => {
      if (e.candidate) this.net.send({ t: 'rtc', to: id, data: { c: e.candidate.toJSON() } });
    };
    pc.ontrack = (e) => this.attachStream(peer, e.streams[0]);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.drop(id);
    };
    return peer;
  }

  private attachStream(peer: Peer, stream: MediaStream): void {
    const ctx = this.audio.ctx;
    if (!ctx) return;
    // Safari/Chrome quirk: a WebRTC stream must be attached to a muted element
    // before WebAudio will pull samples from it.
    const el = new Audio();
    el.srcObject = stream;
    el.muted = true;
    void el.play().catch(() => undefined);

    const src = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain(); gain.gain.value = 0;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass'; lowpass.frequency.value = 20000;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const x = i / 128 - 1; curve[i] = Math.tanh(x * 14) + Math.sin(x * 30) * 0.2; }
    shaper.curve = curve;
    const dry = ctx.createGain(); dry.gain.value = 1;
    const wet = ctx.createGain(); wet.gain.value = 0;
    const panner = this.audio.panner(0, 1.6, 0);

    src.connect(gain);
    gain.connect(dry).connect(lowpass);
    gain.connect(shaper).connect(wet).connect(lowpass);
    // straight to destination — voice shouldn't duck under the game compressor
    lowpass.connect(panner).connect(ctx.destination);

    peer.gain = gain; peer.lowpass = lowpass; peer.dry = dry; peer.wet = wet; peer.panner = panner;
  }

  private async makeOffer(id: string): Promise<void> {
    const peer = this.createPeer(id);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    this.net.send({ t: 'rtc', to: id, data: { sdp: peer.pc.localDescription } });
  }

  private async onSignal(from: string, data: Record<string, unknown>): Promise<void> {
    if (!this.enabled) return;
    let peer = this.peers.get(from);
    if (data.sdp) {
      const desc = data.sdp as RTCSessionDescriptionInit;
      if (desc.type === 'offer') {
        if (!peer) peer = this.createPeer(from);
        await peer.pc.setRemoteDescription(desc);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        this.net.send({ t: 'rtc', to: from, data: { sdp: peer.pc.localDescription } });
      } else if (peer) {
        await peer.pc.setRemoteDescription(desc);
      }
    } else if (data.c && peer) {
      try { await peer.pc.addIceCandidate(data.c as RTCIceCandidateInit); } catch { /* late candidate */ }
    }
  }

  /** Called every frame: distance attenuation, wall muffle, entity interference. */
  update(avatars: Map<string, Avatar>, myPos: THREE.Vector3, seed: number, danger: number, iAmAlive: boolean): void {
    const ctx = this.audio.ctx;
    if (!ctx || !this.enabled) return;
    for (const [id, peer] of this.peers) {
      if (!peer.gain || !peer.panner) continue;
      const av = avatars.get(id);
      const t = ctx.currentTime;
      // the dead don't speak, and echoes hear no one
      if (!av || !av.alive || !iAmAlive) {
        peer.gain.gain.setTargetAtTime(0, t, 0.1);
        continue;
      }
      const s = av.lastState;
      const d = Math.hypot(s[0] - myPos.x, s[2] - myPos.z);
      const vol = Math.max(0, 1 - d / VOICE_RANGE);
      peer.gain.gain.setTargetAtTime(vol * vol * 1.4, t, 0.12);
      peer.panner.positionX.setTargetAtTime(s[0], t, 0.08);
      peer.panner.positionY.setTargetAtTime(1.6, t, 0.08);
      peer.panner.positionZ.setTargetAtTime(s[2], t, 0.08);
      const blocked = losBlocked(seed, myPos.x, myPos.z, s[0], s[2]);
      peer.lowpass!.frequency.setTargetAtTime(blocked ? 700 : 20000, t, 0.15);
      // entity nearby: the channel itself corrupts
      peer.wet!.gain.setTargetAtTime(danger * 0.9, t, 0.2);
      peer.dry!.gain.setTargetAtTime(1 - danger * 0.7, t, 0.2);
    }
  }
}
