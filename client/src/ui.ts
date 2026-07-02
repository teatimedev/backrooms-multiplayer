// All DOM: title flow, HUD, overlays. The game talks to this through
// small imperative methods; UI never touches game state directly.
import { AVATAR_COLORS, AVATAR_COLOR_NAMES } from '@shared/protocol';
import { CHALK_SYMBOLS } from './textures';

export interface JoinIntent { mode: 'host' | 'join'; code: string; name: string; color: number; voice: boolean }

const CONTROLS_HTML = `
  <kbd>WASD</kbd> move &nbsp; <kbd>SHIFT</kbd> sprint &nbsp; <kbd>F</kbd> flashlight &nbsp; <kbd>E</kbd> interact &nbsp;
  <kbd>C</kbd> (hold) chalk &nbsp; <kbd>TAB</kbd> (hold) map &nbsp; <kbd>V</kbd> (hold) talk &nbsp;
  <kbd>ENTER</kbd> chat &nbsp; <kbd>ESC</kbd> menu`;

export class UI {
  root: HTMLElement;
  private hud!: HTMLElement;
  private staminaEl!: HTMLElement;
  private staminaFill!: HTMLElement;
  private toastEl!: HTMLElement;
  private toastTimer = 0;
  private chatlog!: HTMLElement;
  private chatinput!: HTMLInputElement;
  private pttEl!: HTMLElement;
  private radial!: HTMLElement;
  private radialSyms: HTMLElement[] = [];
  private overlay: HTMLElement | null = null;

  onIntent: ((j: JoinIntent) => void) | null = null;
  onChat: ((text: string) => void) | null = null;
  chatOpen = false;

  constructor() {
    this.root = document.getElementById('app')!;
    const ui = document.createElement('div');
    ui.id = 'ui';
    this.root.appendChild(ui);
    this.uiEl = ui;
  }
  uiEl!: HTMLElement;

  // ---------------------------------------------------------------- title

  showTitle(err = ''): void {
    this.clearScreens();
    const name = localStorage.getItem('br_name') ?? '';
    const color = Number(localStorage.getItem('br_color') ?? Math.floor(Math.random() * 8));
    const el = document.createElement('div');
    el.className = 'screen';
    el.id = 'title';
    el.innerHTML = `
      <h1>THE BACKROOMS</h1>
      <div class="sub">YOU SHOULDN'T BE HERE — AND NEITHER SHOULD THEY</div>
      <div class="panel">
        <div class="errmsg">${err}</div>
        <input id="t-name" type="text" maxlength="16" placeholder="your name" value="${name.replace(/"/g, '')}" />
        <div class="row">
          <span class="hint">suit:</span>
          <div class="swatches" id="t-swatches"></div>
        </div>
        <label class="chk"><input type="checkbox" id="t-voice" checked /> proximity voice chat (mic)</label>
        <button class="primary" id="t-host">HOST A DESCENT</button>
        <div class="row">
          <input id="t-code" type="text" maxlength="12" placeholder="CODE-0000" style="text-transform:uppercase" />
          <button id="t-join">JOIN</button>
        </div>
        <div class="hint">host gets a code · friends join with it · 2–8 wanderers<br/>
        pull 3 breakers to power the exit · leave together · the light slows it<br/>${CONTROLS_HTML}</div>
      </div>`;
    this.uiEl.appendChild(el);

    const swatches = el.querySelector('#t-swatches')!;
    let sel = color & 7;
    AVATAR_COLORS.forEach((c, i) => {
      const s = document.createElement('div');
      s.className = 'swatch' + (i === sel ? ' sel' : '');
      s.title = AVATAR_COLOR_NAMES[i];
      s.style.background = '#' + c.toString(16).padStart(6, '0');
      s.onclick = () => {
        sel = i;
        swatches.querySelectorAll('.swatch').forEach((x, j) => x.classList.toggle('sel', j === i));
      };
      swatches.appendChild(s);
    });

    const nameEl = el.querySelector('#t-name') as HTMLInputElement;
    const codeEl = el.querySelector('#t-code') as HTMLInputElement;
    const voiceEl = el.querySelector('#t-voice') as HTMLInputElement;
    const go = (mode: 'host' | 'join'): void => {
      const nm = nameEl.value.trim() || 'wanderer';
      localStorage.setItem('br_name', nm);
      localStorage.setItem('br_color', String(sel));
      this.onIntent?.({ mode, code: codeEl.value, name: nm, color: sel, voice: voiceEl.checked });
    };
    (el.querySelector('#t-host') as HTMLButtonElement).onclick = () => go('host');
    (el.querySelector('#t-join') as HTMLButtonElement).onclick = () => {
      if (codeEl.value.trim()) go('join');
      else codeEl.focus();
    };
    codeEl.onkeydown = (e) => { if (e.key === 'Enter' && codeEl.value.trim()) go('join'); };
  }

  showLoading(text: string): void {
    this.clearScreens();
    const el = document.createElement('div');
    el.className = 'screen';
    el.innerHTML = `<div id="loading">${text}</div>`;
    this.uiEl.appendChild(el);
  }

  // ---------------------------------------------------------------- HUD

  buildHUD(): void {
    this.clearScreens();
    const hud = document.createElement('div');
    hud.id = 'hud';
    hud.innerHTML = `
      <div id="crosshair"></div>
      <div id="objective"></div>
      <div id="pips"></div>
      <div id="rtimer"></div>
      <div id="team"></div>
      <div id="hint"></div>
      <div id="bleed"></div>
      <div id="revivebar"><div class="label"></div><div class="track"><div class="fill"></div></div></div>
      <div id="downarrow"><div class="tri"></div><div class="dlabel"></div></div>
      <div id="sanitybar"><div class="fill"></div></div>
      <div id="stamina"><div class="fill"></div></div>
      <div id="ptt">V — talk</div>
      <div id="toast"></div>
      <div id="chatlog"></div>
      <input id="chatinput" type="text" maxlength="140" placeholder="say something (they must be close)..." />
      <div id="radial"></div>`;
    this.uiEl.appendChild(hud);
    this.hud = hud;
    hud.style.display = 'block';
    this.staminaEl = hud.querySelector('#stamina')!;
    this.staminaFill = hud.querySelector('#stamina .fill')!;
    this.toastEl = hud.querySelector('#toast')!;
    this.chatlog = hud.querySelector('#chatlog')!;
    this.chatinput = hud.querySelector('#chatinput')!;
    this.pttEl = hud.querySelector('#ptt')!;
    this.radial = hud.querySelector('#radial')!;
    CHALK_SYMBOLS.forEach((sym, i) => {
      const a = (i / CHALK_SYMBOLS.length) * Math.PI * 2 - Math.PI / 2;
      const s = document.createElement('div');
      s.className = 'sym';
      s.textContent = sym;
      s.style.left = `${50 + Math.cos(a) * 40}%`;
      s.style.top = `${50 + Math.sin(a) * 40}%`;
      this.radial.appendChild(s);
      this.radialSyms.push(s);
    });

    this.chatinput.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = this.chatinput.value.trim();
        if (text) this.onChat?.(text);
        this.closeChat();
      } else if (e.key === 'Escape') this.closeChat();
    };
  }

  setStamina(v: number): void {
    this.staminaEl.style.opacity = v < 0.98 ? '1' : '0';
    this.staminaFill.style.width = `${v * 100}%`;
  }

  setPTT(on: boolean, available: boolean): void {
    this.pttEl.textContent = available ? (on ? '● transmitting' : 'V — talk') : 'voice off';
    this.pttEl.classList.toggle('on', on);
  }

  setObjective(text: string): void {
    const el = this.hud?.querySelector('#objective');
    if (el) el.textContent = text;
  }

  setHint(text: string): void {
    const el = this.hud?.querySelector('#hint');
    if (el && el.textContent !== text) el.textContent = text;
  }

  setPips(collected: number, total: number): void {
    const el = this.hud?.querySelector('#pips');
    if (!el) return;
    const html = Array.from({ length: total }, (_, i) =>
      `<span class="pip${i < collected ? ' on' : ''}"></span>`).join('');
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  setTimer(secs: number): void {
    const el = this.hud?.querySelector('#rtimer');
    if (!el) return;
    const t = `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
    if (el.textContent !== t) el.textContent = t;
  }

  setTeam(list: { name: string; color: string; state: 'alive' | 'down' | 'echo' }[]): void {
    const el = this.hud?.querySelector('#team');
    if (!el) return;
    const html = list.map((p) =>
      `<div class="tm ${p.state}"><span class="dot" style="background:${p.color}"></span>${p.name}${p.state === 'down' ? ' — DOWN' : p.state === 'echo' ? ' — echo' : ''}</div>`).join('');
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  setSanity(v: number): void {
    const bar = this.hud?.querySelector('#sanitybar') as HTMLElement | null;
    if (!bar) return;
    bar.style.opacity = v < 70 ? '1' : '0';
    (bar.querySelector('.fill') as HTMLElement).style.width = `${v}%`;
  }

  setBleed(secsLeft: number | null): void {
    const el = this.hud?.querySelector('#bleed') as HTMLElement | null;
    if (!el) return;
    el.style.display = secsLeft === null ? 'none' : 'block';
    if (secsLeft !== null) el.textContent = `BLEEDING OUT — ${Math.max(0, Math.ceil(secsLeft))}s — a friend can still bring you back`;
  }

  setReviveBar(label: string | null, p: number): void {
    const el = this.hud?.querySelector('#revivebar') as HTMLElement | null;
    if (!el) return;
    el.style.display = label === null ? 'none' : 'block';
    if (label !== null) {
      (el.querySelector('.label') as HTMLElement).textContent = label;
      (el.querySelector('.fill') as HTMLElement).style.width = `${Math.round(p * 100)}%`;
    }
  }

  /** Screen-edge arrow toward a downed teammate. angleRad is screen-space. */
  setDownArrow(show: boolean, angleRad = 0, label = ''): void {
    const el = this.hud?.querySelector('#downarrow') as HTMLElement | null;
    if (!el) return;
    el.style.display = show ? 'flex' : 'none';
    if (show) {
      (el.querySelector('.tri') as HTMLElement).style.transform = `rotate(${angleRad}rad)`;
      (el.querySelector('.dlabel') as HTMLElement).textContent = label;
    }
  }

  toast(text: string, ms = 3200): void {
    this.toastEl.textContent = text;
    this.toastEl.style.opacity = '1';
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { this.toastEl.style.opacity = '0'; }, ms);
  }

  chatLine(who: string, text: string): void {
    const line = document.createElement('div');
    line.className = 'line';
    const w = document.createElement('span');
    w.className = 'who';
    w.textContent = who ? `${who}: ` : '';
    line.appendChild(w);
    line.appendChild(document.createTextNode(text));
    this.chatlog.appendChild(line);
    while (this.chatlog.children.length > 7) this.chatlog.firstChild?.remove();
    setTimeout(() => { line.style.transition = 'opacity 1.5s'; line.style.opacity = '0'; }, 9000);
  }

  openChat(): void {
    this.chatOpen = true;
    this.chatinput.style.display = 'block';
    this.chatinput.focus();
  }

  closeChat(): void {
    this.chatOpen = false;
    this.chatinput.value = '';
    this.chatinput.style.display = 'none';
    this.chatinput.blur();
  }

  showRadial(sel: number): void {
    this.radial.style.display = 'block';
    this.radialSyms.forEach((s, i) => s.classList.toggle('sel', i === sel));
  }

  hideRadial(): void { this.radial.style.display = 'none'; }

  // ---------------------------------------------------------------- overlays

  showPause(code: string, onResume: () => void, onLeave: () => void): void {
    this.closeOverlay();
    const el = document.createElement('div');
    el.className = 'screen overlay';
    el.innerHTML = `
      <h2>PAUSED*</h2>
      <p>*the backrooms do not pause. your body is still in there.</p>
      <div class="codechip" title="click to copy">${code}</div>
      <p>${CONTROLS_HTML}</p>
      <div class="panel">
        <button class="primary" id="p-resume">RETURN TO YOUR BODY</button>
        <button id="p-leave">ABANDON (leave session)</button>
      </div>`;
    this.uiEl.appendChild(el);
    this.overlay = el;
    (el.querySelector('.codechip') as HTMLElement).onclick = () => {
      void navigator.clipboard?.writeText(code);
      this.toast('code copied');
    };
    (el.querySelector('#p-resume') as HTMLButtonElement).onclick = onResume;
    (el.querySelector('#p-leave') as HTMLButtonElement).onclick = onLeave;
  }

  showDeath(): void {
    this.closeOverlay();
    const el = document.createElement('div');
    el.className = 'screen overlay';
    el.innerHTML = `
      <h2 class="big-death">TAKEN</h2>
      <p>you are an echo now.<br/>
      drift. watch. you cannot speak — but once in a while,<br/>
      press <kbd>F</kbd> to make the lights stutter. guide them. or don't.</p>
      <div class="panel"><button class="primary" id="d-ok">DRIFT</button></div>`;
    this.uiEl.appendChild(el);
    this.overlay = el;
    (el.querySelector('#d-ok') as HTMLButtonElement).onclick = () => this.closeOverlay();
  }

  showEnd(kind: 'win' | 'wipe', detail: string, onAgain: () => void, onLeave: () => void): void {
    this.closeOverlay();
    const el = document.createElement('div');
    el.className = 'screen overlay';
    el.innerHTML = `
      <h2 class="${kind === 'win' ? 'big-win' : 'big-death'}">${kind === 'win' ? 'NOCLIPPED OUT' : 'NO ONE LEFT'}</h2>
      <p>${detail}</p>
      <div class="panel">
        <button class="primary" id="e-again">GO BACK IN (new maze, same crew)</button>
        <button id="e-leave">LEAVE</button>
      </div>`;
    this.uiEl.appendChild(el);
    this.overlay = el;
    (el.querySelector('#e-again') as HTMLButtonElement).onclick = onAgain;
    (el.querySelector('#e-leave') as HTMLButtonElement).onclick = onLeave;
  }

  showDisconnected(): void {
    this.closeOverlay();
    const el = document.createElement('div');
    el.className = 'screen overlay';
    el.innerHTML = `
      <h2 class="big-death">SIGNAL LOST</h2>
      <p>the connection to the others is gone.</p>
      <div class="panel"><button class="primary" id="dc-ok">BACK TO TITLE</button></div>`;
    this.uiEl.appendChild(el);
    this.overlay = el;
    (el.querySelector('#dc-ok') as HTMLButtonElement).onclick = () => location.reload();
  }

  closeOverlay(): void {
    this.overlay?.remove();
    this.overlay = null;
  }

  get hasOverlay(): boolean { return !!this.overlay; }

  private clearScreens(): void {
    this.uiEl.innerHTML = '';
    this.overlay = null;
  }
}
