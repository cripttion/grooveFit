// Tiny WebAudio synth: game SFX and an optional 4-on-the-floor beat for the demo routine.

export class Sound {
  constructor() { this.ctx = null; this.beatTimer = null; }

  ensure() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  tone(freq, dur, { type = 'sine', gain = 0.3, at = 0, slide = 0 } = {}) {
    const ctx = this.ensure(), t = ctx.currentTime + at;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + dur + 0.02);
  }

  perfect() { [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, 0.18, { type: 'triangle', gain: 0.18, at: i * 0.045 })); }
  good() { [659, 880].forEach((f, i) => this.tone(f, 0.14, { type: 'triangle', gain: 0.15, at: i * 0.05 })); }
  ok() { this.tone(523, 0.12, { type: 'triangle', gain: 0.12 }); }
  miss() { this.tone(160, 0.22, { type: 'sawtooth', gain: 0.08, slide: 0.6 }); }
  count() { this.tone(660, 0.15, { type: 'square', gain: 0.1 }); }
  go() { this.tone(1320, 0.35, { type: 'square', gain: 0.12 }); }
  fever() { [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.2, { type: 'square', gain: 0.07, at: i * 0.06 })); }

  /** Start a beat whose beat 0 lands `offset` seconds from now. */
  startBeat(bpm, offset = 0) {
    const ctx = this.ensure();
    this.stopBeat();
    const spb = 60 / bpm, t0 = ctx.currentTime + offset;
    let n = Math.max(0, Math.ceil(-offset / (spb / 2)));
    const bassNotes = [55, 55, 65.4, 73.4];
    const tick = () => {
      while (t0 + n * (spb / 2) < ctx.currentTime + 0.15) {
        const t = t0 + n * (spb / 2), beat = n / 2, onBeat = n % 2 === 0;
        if (onBeat) {
          this.kick(t);
          if (beat % 2 === 1) this.clap(t);
          this.bass(t, bassNotes[Math.floor(beat / 4) % 4], spb * 0.9);
        } else {
          this.hat(t);
        }
        n++;
      }
    };
    tick();
    this.beatTimer = setInterval(tick, 25);
  }
  stopBeat() { clearInterval(this.beatTimer); this.beatTimer = null; }
  pause() { this.ctx?.suspend(); }
  resume() { this.ctx?.resume(); }

  kick(t) {
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.32);
  }
  noise(t, dur, hp, gain) {
    const ctx = this.ctx;
    this.nbuf ??= (() => { const b = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; return b; })();
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = this.nbuf; f.type = 'highpass'; f.frequency.value = hp;
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f).connect(g).connect(this.master); s.start(t); s.stop(t + dur);
  }
  hat(t) { this.noise(t, 0.05, 7000, 0.18); }
  clap(t) { this.noise(t, 0.15, 1500, 0.35); }
  bass(t, f, dur) {
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
    o.type = 'sawtooth'; o.frequency.value = f; lp.type = 'lowpass'; lp.frequency.value = 400;
    g.gain.setValueAtTime(0.16, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(lp).connect(g).connect(this.master); o.start(t); o.stop(t + dur);
  }
}
