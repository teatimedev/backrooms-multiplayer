import type { C2S, S2C } from '@shared/protocol';

type Handler = (msg: Extract<S2C, { t: string }>) => void;

export class Net {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Handler[]>();
  connected = false;
  onclose: (() => void) | null = null;

  connect(): Promise<void> {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // VITE_WS_URL lets the static client (e.g. on Vercel) point at a game
    // server hosted elsewhere; default is same-origin (dev proxy / Fly).
    const url = (import.meta.env.VITE_WS_URL as string | undefined) ?? `${proto}://${location.host}/ws`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => { this.connected = true; resolve(); };
      ws.onerror = () => reject(new Error('Could not reach the server.'));
      ws.onclose = () => {
        const was = this.connected;
        this.connected = false;
        if (was) this.onclose?.();
      };
      ws.onmessage = (ev) => {
        let msg: S2C;
        try { msg = JSON.parse(ev.data); } catch { return; }
        for (const h of this.handlers.get(msg.t) ?? []) h(msg as never);
      };
    });
  }

  on<T extends S2C['t']>(t: T, fn: (msg: Extract<S2C, { t: T }>) => void): void {
    const list = this.handlers.get(t) ?? [];
    list.push(fn as Handler);
    this.handlers.set(t, list);
  }

  send(msg: C2S): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
