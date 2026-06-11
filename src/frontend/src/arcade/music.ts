// ==========================================
// Arcade background music — an original, procedurally synthesized chiptune
// loop (Web Audio square/triangle/noise voices). Synthesizing in-app instead
// of bundling a track means the music is unambiguously royalty-free (it's
// ours), adds zero asset weight, and loops seamlessly by construction.
// Upbeat, lighthearted — classic arcade vibes at 112 BPM.
// ==========================================

const BPM = 112;
const EIGHTH = 60 / BPM / 2;           // seconds per 8th note
const BARS = 8;
const STEPS = BARS * 8;                // 8th-note grid, 64 steps per loop
const LOOKAHEAD_MS = 30;
const SCHEDULE_AHEAD = 0.12;           // seconds scheduled in advance

// A-major pentatonic-ish, bright and bouncy. 0 = rest.
// Lead (square) — two 4-bar phrases, question/answer.
const LEAD: number[] = [
  440, 0, 554, 0, 659, 0, 554, 659,   // A C# E C# E
  440, 0, 554, 659, 740, 0, 659, 554, // climb to F#
  494, 0, 587, 0, 740, 0, 587, 740,   // B D F# (shift)
  880, 740, 659, 0, 554, 0, 440, 0,   // tumble back home
  440, 0, 554, 0, 659, 0, 554, 659,
  440, 0, 554, 659, 740, 0, 880, 0,   // lift…
  831, 0, 740, 0, 659, 0, 587, 554,   // …and resolve down
  494, 554, 440, 0, 440, 0, 0, 0,     // land on the root, breathe
];

// Bass (triangle) — root/fifth bounce following A / A / B / E, A / A / F#m / E.
const BASS: number[] = [
  110, 0, 165, 0, 110, 0, 165, 0,
  110, 0, 165, 0, 110, 0, 165, 0,
  123, 0, 185, 0, 123, 0, 185, 0,
  82, 0, 124, 0, 82, 0, 124, 0,
  110, 0, 165, 0, 110, 0, 165, 0,
  110, 0, 165, 0, 110, 0, 165, 0,
  92, 0, 139, 0, 92, 0, 139, 0,
  82, 0, 124, 0, 82, 124, 165, 0,
];

// Hat (noise) — off-beat tick with a few doubles for swing.
const HAT: number[] = [
  0, 1, 0, 1, 0, 1, 0, 1,
  0, 1, 0, 1, 0, 1, 1, 1,
  0, 1, 0, 1, 0, 1, 0, 1,
  0, 1, 0, 1, 0, 1, 1, 0,
  0, 1, 0, 1, 0, 1, 0, 1,
  0, 1, 0, 1, 0, 1, 1, 1,
  0, 1, 0, 1, 0, 1, 0, 1,
  0, 1, 1, 0, 0, 1, 1, 1,
];

const STORAGE_KEY = 'arcade_music_on';

export class ArcadeMusic {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextStepTime = 0;
  private step = 0;

  get enabled(): boolean {
    try { return localStorage.getItem(STORAGE_KEY) !== '0'; } catch { return true; }
  }

  get playing(): boolean {
    return this.timer !== null;
  }

  /** Call from a user gesture (autoplay policy). No-op if muted or running. */
  start(): void {
    if (!this.enabled || this.timer) return;
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
      void this.ctx.resume();
      this.step = 0;
      this.nextStepTime = this.ctx.currentTime + 0.05;
      this.timer = setInterval(() => this.schedule(), LOOKAHEAD_MS);
    } catch {
      // No WebAudio (old browser / test env) — stay silent.
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

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    while (this.nextStepTime < ctx.currentTime + SCHEDULE_AHEAD) {
      const i = this.step % STEPS;
      const t = this.nextStepTime;
      if (LEAD[i]) this.voice('square', LEAD[i], t, EIGHTH * 0.9, 0.16);
      if (BASS[i]) this.voice('triangle', BASS[i], t, EIGHTH * 0.95, 0.30);
      if (HAT[i]) this.hat(t);
      this.nextStepTime += EIGHTH;
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
}

export const arcadeMusic = new ArcadeMusic();
