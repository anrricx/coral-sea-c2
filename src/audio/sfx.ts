// Synthesized sound effects via the Web Audio API — no audio files required.

type Sfx = 'click' | 'select' | 'move' | 'ping' | 'confirm' | 'boom' | 'spawn' | 'error' | 'phase' | 'victory' | 'defeat' | 'hazard';

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  muted = false;

  private ensure(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, delay = 0, slideTo?: number) {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noise(dur: number, vol: number, cutoff: number, delay = 0) {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + delay;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(cutoff, t);
    f.frequency.exponentialRampToValueAtTime(60, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
  }

  play(s: Sfx) {
    switch (s) {
      case 'click':
        return this.tone(1200, 0.04, 'square', 0.05);
      case 'select':
        return this.tone(880, 0.06, 'triangle', 0.12), this.tone(1320, 0.05, 'triangle', 0.08, 0.04);
      case 'move':
        return this.tone(320, 0.18, 'sine', 0.12, 0, 520);
      case 'phase':
        return this.tone(600, 0.08, 'square', 0.06), this.tone(900, 0.1, 'square', 0.06, 0.08);
      case 'ping':
        this.tone(1500, 0.5, 'sine', 0.18, 0, 1100);
        return this.tone(1500, 0.4, 'sine', 0.06, 0.25, 1100);
      case 'confirm':
        this.tone(1000, 0.08, 'square', 0.08);
        this.tone(1000, 0.08, 'square', 0.08, 0.1);
        return this.tone(1500, 0.18, 'square', 0.08, 0.2);
      case 'boom':
        this.noise(0.9, 0.9, 1800);
        return this.tone(90, 0.6, 'sine', 0.5, 0, 35);
      case 'hazard':
        this.noise(1.4, 0.5, 600);
        return this.tone(55, 1.2, 'sawtooth', 0.12, 0, 40);
      case 'spawn':
        [440, 660, 880, 1320].forEach((f, i) => this.tone(f, 0.12, 'triangle', 0.1, i * 0.06));
        return;
      case 'error':
        return this.tone(160, 0.25, 'sawtooth', 0.12, 0, 110);
      case 'victory':
        [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.3, 'triangle', 0.15, i * 0.14));
        return;
      case 'defeat':
        [392, 311, 262, 196].forEach((f, i) => this.tone(f, 0.4, 'sawtooth', 0.08, i * 0.18));
        return;
    }
  }
}

export const sfx = new SoundEngine();
export type { Sfx };
