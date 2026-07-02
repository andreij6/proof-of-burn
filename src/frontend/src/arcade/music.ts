// ==========================================
// Arcade background music — original, procedurally synthesized chiptune
// loops (Web Audio square/triangle/sine/noise voices). Synthesizing in-app
// instead of bundling tracks means the music is unambiguously royalty-free
// (it's ours), adds zero asset weight, and loops seamlessly by construction.
//
// Two songs: "fairway" (Mini Golf — upbeat, lighthearted, 112 BPM) and
// "pressure" (Field Goal — tense E-minor at 150 BPM: clock-tick hats, a
// relentless bass, a heartbeat thump and sparse minor stabs).
// ==========================================

const LOOKAHEAD_MS = 30;
const SCHEDULE_AHEAD = 0.12;           // seconds scheduled in advance
const STORAGE_KEY = 'arcade_music_on'; // one mute switch for the whole arcade

interface Song {
  bpm: number;
  /** Lead voice (square), Hz per 8th-note step; 0 = rest. */
  lead: number[];
  /** Bass voice (triangle), Hz per step; 0 = rest. */
  bass: number[];
  /** Hi-hat (filtered noise) hits per step. */
  hat: number[];
  /** Optional low sine thump (heartbeat / kick drum) per step. */
  kick?: number[];
  leadVol: number;
  bassVol: number;
}

// ── Song 1: "fairway" — A-major pentatonic-ish, bright and bouncy ──
const FAIRWAY: Song = {
  bpm: 112,
  lead: [
    440, 0, 554, 0, 659, 0, 554, 659,   // A C# E C# E
    440, 0, 554, 659, 740, 0, 659, 554, // climb to F#
    494, 0, 587, 0, 740, 0, 587, 740,   // B D F# (shift)
    880, 740, 659, 0, 554, 0, 440, 0,   // tumble back home
    440, 0, 554, 0, 659, 0, 554, 659,
    440, 0, 554, 659, 740, 0, 880, 0,   // lift…
    831, 0, 740, 0, 659, 0, 587, 554,   // …and resolve down
    494, 554, 440, 0, 440, 0, 0, 0,     // land on the root, breathe
  ],
  bass: [
    110, 0, 165, 0, 110, 0, 165, 0,
    110, 0, 165, 0, 110, 0, 165, 0,
    123, 0, 185, 0, 123, 0, 185, 0,
    82, 0, 124, 0, 82, 0, 124, 0,
    110, 0, 165, 0, 110, 0, 165, 0,
    110, 0, 165, 0, 110, 0, 165, 0,
    92, 0, 139, 0, 92, 0, 139, 0,
    82, 0, 124, 0, 82, 124, 165, 0,
  ],
  hat: [
    0, 1, 0, 1, 0, 1, 0, 1,
    0, 1, 0, 1, 0, 1, 1, 1,
    0, 1, 0, 1, 0, 1, 0, 1,
    0, 1, 0, 1, 0, 1, 1, 0,
    0, 1, 0, 1, 0, 1, 0, 1,
    0, 1, 0, 1, 0, 1, 1, 1,
    0, 1, 0, 1, 0, 1, 0, 1,
    0, 1, 1, 0, 0, 1, 1, 1,
  ],
  leadVol: 0.16,
  bassVol: 0.30,
};

// ── Song 2: "pressure" — E minor, 150 BPM, clock-tick + heartbeat ──
// E2 82.4 / F#2 92.5 / G2 98 / B2 123.5; lead row E4 329.6, G4 392,
// A4 440, B4 493.9, C5 523.3, D#5 622.3 (the chromatic dread note), E5 659.3.
const PRESSURE: Song = {
  bpm: 150,
  lead: [
    // Bars 1–2: silence — just the clock and the heart.
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    // Bars 3–4: two-note dread motif, rising.
    329.6, 0, 0, 0, 392, 0, 0, 0,
    329.6, 0, 0, 0, 440, 0, 392, 0,
    // Bars 5–6: tighten — minor third hammering.
    493.9, 0, 392, 0, 493.9, 0, 392, 0,
    523.3, 0, 493.9, 0, 392, 0, 329.6, 0,
    // Bars 7–8: the leading-tone scream and fall, then hold breath.
    622.3, 0, 659.3, 0, 622.3, 0, 493.9, 0,
    392, 0, 329.6, 0, 0, 0, 0, 0,
  ],
  bass: [
    // Relentless eighth-note E pedal with semitone lifts at phrase ends.
    82.4, 82.4, 82.4, 82.4, 82.4, 82.4, 82.4, 82.4,
    82.4, 82.4, 82.4, 82.4, 82.4, 82.4, 92.5, 98,
    82.4, 82.4, 82.4, 82.4, 82.4, 82.4, 82.4, 82.4,
    82.4, 82.4, 82.4, 82.4, 98, 98, 92.5, 92.5,
    82.4, 82.4, 82.4, 82.4, 82.4, 82.4, 82.4, 82.4,
    123.5, 123.5, 123.5, 123.5, 98, 98, 92.5, 92.5,
    82.4, 82.4, 82.4, 82.4, 82.4, 82.4, 82.4, 82.4,
    82.4, 82.4, 92.5, 92.5, 98, 98, 123.5, 0,
  ],
  hat: [
    // A tick on EVERY eighth — the clock never stops.
    1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1,
  ],
  kick: [
    // Lub-dub heartbeat on beats 1 and the and-of-1.
    1, 0, 1, 0, 0, 0, 0, 0,
    1, 0, 1, 0, 0, 0, 0, 0,
    1, 0, 1, 0, 0, 0, 0, 0,
    1, 0, 1, 0, 0, 0, 0, 0,
    1, 0, 1, 0, 0, 0, 0, 0,
    1, 0, 1, 0, 0, 0, 0, 0,
    1, 0, 1, 0, 0, 0, 0, 0,
    1, 0, 1, 0, 1, 0, 1, 0, // racing at the loop turn
  ],
  leadVol: 0.13,
  bassVol: 0.26,
};

export class ArcadeMusic {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextStepTime = 0;
  private step = 0;

  private song: Song;

  constructor(song: Song) {
    this.song = song;
  }

  get enabled(): boolean {
    try { return localStorage.getItem(STORAGE_KEY) !== '0'; } catch { return true; }
  }

  get playing(): boolean {
    return this.timer !== null;
  }

  /** Lazily create the AudioContext + master gain + shared noise buffer.
   *  Returns false (silently) without WebAudio (old browser / test env). */
  private ensureCtx(): boolean {
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.16;
        this.master.connect(this.ctx.destination);
        const len = Math.floor(this.ctx.sampleRate * 0.06);
        this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const data = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Call from a user gesture (autoplay policy). No-op if muted or running. */
  start(): void {
    if (!this.enabled || this.timer) return;
    if (!this.ensureCtx()) return;
    try {
      void this.ctx!.resume();
      this.step = 0;
      this.nextStepTime = this.ctx!.currentTime + 0.05;
      this.timer = setInterval(() => this.schedule(), LOOKAHEAD_MS);
    } catch {
      // No WebAudio (old browser / test env) — stay silent.
    }
  }

  /**
   * One-shot "jar opening" pop for tunnel teleports: a fast upward pitch-bent
   * sine thump (the lid's suction release) plus a sliver of band-passed noise
   * (the click). Respects the mute toggle; safe to call any time — lazily
   * creates audio, never throws, and stays silent without WebAudio.
   */
  playPop(): void {
    if (!this.enabled || !this.ensureCtx()) return;
    try {
      const ctx = this.ctx!;
      void ctx.resume();
      const at = ctx.currentTime;
      // Thump: 160 → 320 Hz in 60 ms, gone by 150 ms.
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(160, at);
      osc.frequency.exponentialRampToValueAtTime(320, at + 0.06);
      gain.gain.setValueAtTime(0.55, at);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.15);
      osc.connect(gain).connect(this.master!);
      osc.start(at);
      osc.stop(at + 0.17);
      // Click transient right at the front.
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1800;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.30, at);
      ng.gain.exponentialRampToValueAtTime(0.001, at + 0.035);
      src.connect(bp).connect(ng).connect(this.master!);
      src.start(at);
    } catch {
      // No WebAudio — stay silent.
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    void this.ctx?.suspend();
  }

  /** Flip the persisted preference; returns the new "on" state. */
  toggle(): boolean {
    const next = !this.enabled;
    try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch { /* private mode */ }
    if (next) this.start(); else this.stop();
    return next;
  }

  private get eighth(): number {
    return 60 / this.song.bpm / 2;
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const s = this.song;
    const steps = s.lead.length;
    while (this.nextStepTime < ctx.currentTime + SCHEDULE_AHEAD) {
      const i = this.step % steps;
      const t = this.nextStepTime;
      if (s.lead[i]) this.voice('square', s.lead[i], t, this.eighth * 0.9, s.leadVol);
      if (s.bass[i]) this.voice('triangle', s.bass[i], t, this.eighth * 0.95, s.bassVol);
      if (s.hat[i]) this.hat(t);
      if (s.kick && s.kick[i]) this.thump(t);
      this.nextStepTime += this.eighth;
      this.step++;
    }
  }

  private voice(type: OscillatorType, freq: number, at: number, dur: number, vol: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    // Chip-style envelope: instant attack, quick decay tail.
    gain.gain.setValueAtTime(vol, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + dur);
    osc.connect(gain).connect(this.master!);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  private hat(at: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6000;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.10, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.05);
    src.connect(hp).connect(gain).connect(this.master!);
    src.start(at);
  }

  /** Low sine thump — the heartbeat under the pressure track. */
  private thump(at: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(95, at);
    osc.frequency.exponentialRampToValueAtTime(45, at + 0.10);
    gain.gain.setValueAtTime(0.5, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.14);
    osc.connect(gain).connect(this.master!);
    osc.start(at);
    osc.stop(at + 0.16);
  }
}

/** Mini Golf's lighthearted loop. */
export const arcadeMusic = new ArcadeMusic(FAIRWAY);
/** Field Goal's high-pressure loop. */
export const pressureMusic = new ArcadeMusic(PRESSURE);
