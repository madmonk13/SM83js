// The Game Boy's sound: two square-wave channels (the first with a frequency
// sweep), a wave channel playing 32 4-bit samples from FF30-FF3F, and a noise
// channel from a 15- or 7-bit shift register. A frame sequencer at 512 Hz
// clocks the length counters (256 Hz), the sweep (128 Hz) and the volume
// envelopes (64 Hz). NR50/NR51 set each channel's left/right routing and the
// master volume; here the two sides are mixed to mono.
//
// Registers FF10-FF26, wave RAM FF30-FF3F. Output goes into a ring buffer at
// SAMPLE_RATE for the browser's audio output.

import { capture, apply } from './state.js';

export const SAMPLE_RATE = 48000;
const CLOCK = 4194304;                       // dots per second (the normal-speed clock)
const DUTY = [0x01, 0x81, 0x87, 0x7E];       // 12.5%, 25%, 50%, 75%, one bit per step
const NOISE_DIV = [8, 16, 32, 48, 64, 80, 96, 112];
// Bits that always read back as 1, per register FF10-FF2F.
const READ_OR = [0x80, 0x3F, 0x00, 0xFF, 0xBF, 0xFF, 0x3F, 0x00, 0xFF, 0xBF, 0x7F, 0xFF, 0x9F, 0xFF, 0xBF, 0xFF,
  0xFF, 0x00, 0x00, 0xBF, 0x00, 0x00, 0x70, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF];

const STATE = ['regs', 'wave', 'on', 'seq', 'seqClock', 'sampleClock', 'ch', 'lfsr', 'dcIn', 'dcOut'];

const channel = () => ({
  on: false, length: 0, timer: 0, pos: 0, vol: 0, envTimer: 0, envOn: false,
  sweepTimer: 0, sweepOn: false, shadow: 0, freq: 0,
});

export class APU {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  constructor() {
    this.buffer = new Float32Array(1 << 15);
    this.writePos = this.readPos = 0;
    this.reset();
  }

  reset() {
    this.regs = new Uint8Array(0x30);          // FF10-FF3F (wave RAM kept separately)
    this.wave = new Uint8Array(16);
    this.on = false;
    this.seq = 0; this.seqClock = 0; this.sampleClock = 0;
    this.ch = [channel(), channel(), channel(), channel()];
    this.lfsr = 0x7FFF;
    this.dcIn = this.dcOut = 0;
  }

  // ---------------------------------------------------------------- registers

  read(a) {
    if (a >= 0xFF30) return this.wave[a - 0xFF30];
    const r = a - 0xFF10;
    if (a === 0xFF26) return (this.on ? 0x80 : 0) | 0x70 | this.ch.reduce((m, c, i) => m | (c.on ? 1 << i : 0), 0);
    return this.regs[r] | READ_OR[r];
  }

  write(a, v) {
    if (a >= 0xFF30) { this.wave[a - 0xFF30] = v; return; }
    const r = a - 0xFF10;
    if (a === 0xFF26) {
      const on = !!(v & 0x80);
      if (this.on && !on) {                    // power off clears every register
        this.regs.fill(0, 0, 0x16);
        for (const c of this.ch) c.on = false;
      }
      if (!this.on && on) this.seq = 0;
      this.on = on;
      return;
    }
    if (!this.on && r !== 0x01 && r !== 0x06 && r !== 0x0B && r !== 0x10) return;   // only lengths are writable while off
    this.regs[r] = v;
    switch (a) {
      case 0xFF11: this.ch[0].length = 64 - (v & 0x3F); break;
      case 0xFF16: this.ch[1].length = 64 - (v & 0x3F); break;
      case 0xFF1B: this.ch[2].length = 256 - v; break;
      case 0xFF20: this.ch[3].length = 64 - (v & 0x3F); break;
      case 0xFF12: if (!(v & 0xF8)) this.ch[0].on = false; break;    // DAC off
      case 0xFF17: if (!(v & 0xF8)) this.ch[1].on = false; break;
      case 0xFF1A: if (!(v & 0x80)) this.ch[2].on = false; break;
      case 0xFF21: if (!(v & 0xF8)) this.ch[3].on = false; break;
      case 0xFF14: if (v & 0x80) this.trigger(0); break;
      case 0xFF19: if (v & 0x80) this.trigger(1); break;
      case 0xFF1E: if (v & 0x80) this.trigger(2); break;
      case 0xFF23: if (v & 0x80) this.trigger(3); break;
    }
  }

  freq(n) { const b = n === 0 ? 0 : n === 1 ? 5 : 10; return this.regs[b + 3] | ((this.regs[b + 4] & 7) << 8); }
  period(n) {
    if (n === 2) return (2048 - this.freq(2)) * 2;
    if (n === 3) { const r = this.regs[0x12]; return NOISE_DIV[r & 7] << (r >> 4); }
    return (2048 - this.freq(n)) * 4;
  }

  trigger(n) {
    const c = this.ch[n], R = this.regs;
    const dacOn = n === 2 ? !!(R[0x0A] & 0x80) : !!(R[[0x02, 0x07, 0, 0x11][n]] & 0xF8);
    c.on = dacOn;
    if (!c.length) c.length = n === 2 ? 256 : 64;
    c.timer = this.period(n);
    c.pos = 0;
    if (n !== 2) {
      const env = R[[0x02, 0x07, 0, 0x11][n]];
      c.vol = env >> 4; c.envTimer = env & 7; c.envOn = true;
    }
    if (n === 3) this.lfsr = 0x7FFF;
    if (n === 0) {
      const s = R[0x00];
      c.shadow = this.freq(0);
      c.sweepTimer = ((s >> 4) & 7) || 8;
      c.sweepOn = !!((s >> 4) & 7) || !!(s & 7);
      if (s & 7) this.sweepCalc(true);
    }
  }

  // The next swept frequency; turns the channel off if it overflows.
  sweepCalc(checkOnly) {
    const c = this.ch[0], s = this.regs[0x00];
    const delta = c.shadow >> (s & 7);
    const f = s & 0x08 ? c.shadow - delta : c.shadow + delta;
    if (f > 2047) { c.on = false; return; }
    if (checkOnly || !(s & 7)) return;
    c.shadow = f;
    this.regs[0x03] = f & 0xFF;
    this.regs[0x04] = (this.regs[0x04] & 0xF8) | (f >> 8);
    this.sweepCalc(true);
  }

  // ---------------------------------------------------------------- frame sequencer

  step() {
    const R = this.regs, s = this.seq;
    if (!(s & 1)) {                                            // lengths: 256 Hz
      for (let n = 0; n < 4; n++) {
        const enabled = R[[0x04, 0x09, 0x0E, 0x13][n]] & 0x40;
        const c = this.ch[n];
        if (enabled && c.length > 0 && --c.length === 0) c.on = false;
      }
    }
    if (s === 2 || s === 6) {                                  // sweep: 128 Hz
      const c = this.ch[0];
      if (--c.sweepTimer <= 0) {
        const p = (R[0x00] >> 4) & 7;
        c.sweepTimer = p || 8;
        if (c.sweepOn && p) this.sweepCalc(false);
      }
    }
    if (s === 7) {                                             // envelopes: 64 Hz
      for (const n of [0, 1, 3]) {
        const c = this.ch[n], env = R[[0x02, 0x07, 0, 0x11][n]], p = env & 7;
        if (!p || !c.envOn) continue;
        if (--c.envTimer <= 0) {
          c.envTimer = p;
          const nv = c.vol + (env & 0x08 ? 1 : -1);
          if (nv >= 0 && nv <= 15) c.vol = nv; else c.envOn = false;
        }
      }
    }
    this.seq = (s + 1) & 7;
  }

  // ---------------------------------------------------------------- running

  // Advance by `dots` (normal-speed clocks), making samples as they fall due.
  tick(dots) {
    if (this.on) {
      for (let n = 0; n < 4; n++) {
        const c = this.ch[n];
        c.timer -= dots;
        while (c.timer <= 0) {
          c.timer += this.period(n);
          if (n === 3) {
            const bit = (this.lfsr ^ (this.lfsr >> 1)) & 1;
            this.lfsr = (this.lfsr >> 1) | (bit << 14);
            if (this.regs[0x12] & 0x08) this.lfsr = (this.lfsr & ~0x40) | (bit << 6);
          } else c.pos = (c.pos + 1) & (n === 2 ? 31 : 7);
        }
      }
      this.seqClock += dots;
      while (this.seqClock >= 8192) { this.seqClock -= 8192; this.step(); }
    }
    this.sampleClock += dots * SAMPLE_RATE;
    while (this.sampleClock >= CLOCK) { this.sampleClock -= CLOCK; this.sample(); }
  }

  // Each channel's output level now: 0-15 (0 when off).
  level(n) {
    const c = this.ch[n], R = this.regs;
    if (!c.on) return 0;
    switch (n) {
      case 0: case 1: return (DUTY[R[n === 0 ? 0x01 : 0x06] >> 6] >> (7 - c.pos)) & 1 ? c.vol : 0;
      case 2: {
        const shift = (R[0x0C] >> 5) & 3;
        if (!shift) return 0;
        const b = this.wave[c.pos >> 1], s = c.pos & 1 ? b & 15 : b >> 4;
        return s >> (shift - 1);
      }
      default: return this.lfsr & 1 ? 0 : c.vol;
    }
  }

  sample() {
    let s = 0;
    if (this.on) {
      const pan = this.regs[0x15], vol = this.regs[0x14];
      const lv = ((vol >> 4) & 7) + 1, rv = (vol & 7) + 1;
      for (let n = 0; n < 4; n++) {
        const l = this.level(n);
        if (!l) continue;
        if (pan & (0x10 << n)) s += l * lv;
        if (pan & (1 << n)) s += l * rv;
      }
      s /= 15 * 8 * 2 * 4;                    // to roughly -1..1 for all four channels at full volume
      s *= 1.6;
    }
    // DC-blocking high-pass: the channels only ever add positive levels.
    const out = s - this.dcIn + 0.996 * this.dcOut;
    this.dcIn = s; this.dcOut = out;
    const buf = this.buffer, mask = buf.length - 1;
    buf[this.writePos] = out;
    this.writePos = (this.writePos + 1) & mask;
    if (this.writePos === this.readPos) this.readPos = (this.readPos + 1) & mask;
  }

  available() { return (this.writePos - this.readPos) & (this.buffer.length - 1); }

  // Fallback output path (ScriptProcessor): resample into `out` at `outRate`.
  pull(out, outRate) {
    const buf = this.buffer, mask = buf.length - 1, step = SAMPLE_RATE / outRate;
    if (this.available() > SAMPLE_RATE * 0.075) this.readPos = (this.writePos - Math.floor(SAMPLE_RATE * 0.035)) & mask;
    let pos = this.frac || 0, last = this.last || 0;
    for (let i = 0; i < out.length; i++) {
      if (this.available() < 2) { out[i] = last *= 0.995; continue; }
      const s0 = buf[this.readPos], s1 = buf[(this.readPos + 1) & mask];
      last = out[i] = s0 + (s1 - s0) * pos;
      pos += step;
      while (pos >= 1 && this.available() > 1) { pos -= 1; this.readPos = (this.readPos + 1) & mask; }
    }
    this.frac = pos; this.last = last;
  }
}
