// The Game Boy's picture processor: a 160x144 screen drawn a line at a time
// from a scrolling background map, a window layer over it, and up to 40
// sprites (ten a line) of 8x8 or 8x16, all made of 8x8 2-bit tiles in VRAM.
//
// Each line takes 456 dots: OAM scan (mode 2, 80 dots), drawing (mode 3,
// about 172), then horizontal blank (mode 0). Lines 144-153 are vertical
// blank (mode 1). The line is drawn here all at once at the end of mode 3,
// from the registers as they stand then.
//
// Game Boy Color mode adds a second VRAM bank (tile attributes: palette,
// bank, flips, priority), eight 4-color background and sprite palettes of
// 15-bit color, and OAM-order sprite priority.

import { capture, apply } from './state.js';

export const WIDTH = 160, HEIGHT = 144;
const LINE_DOTS = 456, FRAME_DOTS = 70224;

const rgba = (r, g, b) => (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;

// Original-Game-Boy shades for each look, lightest first.
export const DMG_PALETTES = {
  green: [rgba(0xC4, 0xCF, 0xA1), rgba(0x8B, 0x95, 0x6D), rgba(0x4D, 0x53, 0x3C), rgba(0x1F, 0x1F, 0x1F)],
  gray: [rgba(0xE8, 0xE8, 0xE8), rgba(0xA0, 0xA0, 0xA0), rgba(0x58, 0x58, 0x58), rgba(0x10, 0x10, 0x10)],
  pocket: [rgba(0xD8, 0xD8, 0xC0), rgba(0xA8, 0xA8, 0x90), rgba(0x60, 0x60, 0x4B), rgba(0x20, 0x20, 0x18)],
};

// 15-bit color to RGBA: each 5-bit level spread to 8 bits.
const LEVEL = Uint8Array.from({ length: 32 }, (_, i) => (i * 255 / 31) | 0);
const color15 = (lo, hi) => {
  const c = lo | (hi << 8);
  return rgba(LEVEL[c & 31], LEVEL[(c >> 5) & 31], LEVEL[(c >> 10) & 31]);
};

const STATE = ['vram', 'oam', 'lcdc', 'stat', 'scy', 'scx', 'ly', 'lyc', 'bgp', 'obp0', 'obp1', 'wy', 'wx',
  'vbank', 'bgPal', 'objPal', 'bcps', 'ocps', 'dot', 'mode', 'windowLine', 'wyHit', 'statLine', 'offDots'];

export class PPU {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // sys: { irq(bit), hblank() } - interrupts, and the Color's HBlank DMA.
  constructor(sys) {
    this.sys = sys;
    this.cgb = false;
    this.shades = DMG_PALETTES.green;
    this.frame = new Uint32Array(WIDTH * HEIGHT);
    this.lineIdx = new Uint8Array(WIDTH);     // background color index per pixel (0-3)
    this.linePri = new Uint8Array(WIDTH);     // Color: background tile's priority bit per pixel
    this.reset();
  }

  reset() {
    this.vram = new Uint8Array(0x4000);
    this.oam = new Uint8Array(0xA0);
    this.lcdc = 0x91; this.stat = 0; this.scy = 0; this.scx = 0; this.ly = 0; this.lyc = 0;
    this.bgp = 0xFC; this.obp0 = 0xFF; this.obp1 = 0xFF; this.wy = 0; this.wx = 0;
    this.vbank = 0;
    this.bgPal = new Uint8Array(64).fill(0xFF);
    this.objPal = new Uint8Array(64).fill(0xFF);
    this.bcps = 0; this.ocps = 0;
    this.dot = 0; this.mode = 2; this.windowLine = 0; this.wyHit = false; this.statLine = false; this.offDots = 0;
    this.frameReady = false;
    this.frame.fill(this.cgb ? 0xFFFFFFFF : this.shades[0]);
  }

  // ---------------------------------------------------------------- registers

  read(a) {
    switch (a) {
      case 0xFF40: return this.lcdc;
      case 0xFF41: return 0x80 | (this.stat & 0x78) | (this.ly === this.lyc ? 4 : 0) | (this.lcdc & 0x80 ? this.mode : 0);
      case 0xFF42: return this.scy;
      case 0xFF43: return this.scx;
      case 0xFF44: return this.ly;
      case 0xFF45: return this.lyc;
      case 0xFF47: return this.bgp;
      case 0xFF48: return this.obp0;
      case 0xFF49: return this.obp1;
      case 0xFF4A: return this.wy;
      case 0xFF4B: return this.wx;
      case 0xFF4F: return this.cgb ? 0xFE | this.vbank : 0xFF;
      case 0xFF68: return this.cgb ? 0x40 | this.bcps : 0xFF;
      case 0xFF69: return this.cgb ? this.bgPal[this.bcps & 0x3F] : 0xFF;
      case 0xFF6A: return this.cgb ? 0x40 | this.ocps : 0xFF;
      case 0xFF6B: return this.cgb ? this.objPal[this.ocps & 0x3F] : 0xFF;
    }
    return 0xFF;
  }

  write(a, v) {
    switch (a) {
      case 0xFF40: {
        const was = this.lcdc & 0x80;
        this.lcdc = v;
        if (was && !(v & 0x80)) { this.ly = 0; this.dot = 0; this.mode = 0; this.offDots = 0; }      // off: the line counter stops at 0
        else if (!was && (v & 0x80)) { this.ly = 0; this.dot = 0; this.mode = 2; this.windowLine = 0; this.wyHit = false; }
        this.updateStat();
        return;
      }
      case 0xFF41: this.stat = v & 0x78; this.updateStat(); return;
      case 0xFF42: this.scy = v; return;
      case 0xFF43: this.scx = v; return;
      case 0xFF45: this.lyc = v; this.updateStat(); return;
      case 0xFF47: this.bgp = v; return;
      case 0xFF48: this.obp0 = v; return;
      case 0xFF49: this.obp1 = v; return;
      case 0xFF4A: this.wy = v; return;
      case 0xFF4B: this.wx = v; return;
      case 0xFF4F: if (this.cgb) this.vbank = v & 1; return;
      case 0xFF68: this.bcps = v & 0xBF; return;
      case 0xFF69: if (this.cgb) { this.bgPal[this.bcps & 0x3F] = v; if (this.bcps & 0x80) this.bcps = 0x80 | ((this.bcps + 1) & 0x3F); } return;
      case 0xFF6A: this.ocps = v & 0xBF; return;
      case 0xFF6B: if (this.cgb) { this.objPal[this.ocps & 0x3F] = v; if (this.ocps & 0x80) this.ocps = 0x80 | ((this.ocps + 1) & 0x3F); } return;
    }
  }

  readVram(a) { return this.vram[(this.vbank << 13) | (a & 0x1FFF)]; }
  writeVram(a, v) { this.vram[(this.vbank << 13) | (a & 0x1FFF)] = v; }

  // The STAT interrupt fires when any enabled condition becomes true
  // (conditions are ORed into one line; only its rising edge counts).
  updateStat() {
    const on = !!(this.lcdc & 0x80) && (
      ((this.stat & 0x40) && this.ly === this.lyc)
      || ((this.stat & 0x08) && this.mode === 0)
      || ((this.stat & 0x10) && this.mode === 1)
      || ((this.stat & 0x20) && this.mode === 2));
    if (on && !this.statLine) this.sys.irq(1);
    this.statLine = on;
  }

  // ---------------------------------------------------------------- timing

  tick(dots) {
    if (!(this.lcdc & 0x80)) {
      // With the screen off, frames still come round on time (blank).
      this.offDots += dots;
      if (this.offDots >= FRAME_DOTS) {
        this.offDots -= FRAME_DOTS;
        this.frame.fill(this.cgb ? 0xFFFFFFFF : this.shades[0]);
        this.frameReady = true;
      }
      return;
    }
    this.dot += dots;
    for (;;) {
      if (this.ly < 144) {
        if (this.mode === 2 && this.dot >= 80) { this.mode = 3; this.updateStat(); }
        else if (this.mode === 3 && this.dot >= 252) { this.renderLine(); this.mode = 0; this.updateStat(); this.sys.hblank(); }
        else if (this.dot >= LINE_DOTS) { this.dot -= LINE_DOTS; this.nextLine(); }
        else break;
      } else if (this.dot >= LINE_DOTS) { this.dot -= LINE_DOTS; this.nextLine(); }
      else break;
    }
  }

  nextLine() {
    this.ly++;
    if (this.ly === 144) {
      this.mode = 1;
      this.sys.irq(0);
      this.frameReady = true;
    } else if (this.ly > 153) {
      this.ly = 0;
      this.windowLine = 0;
      this.wyHit = false;
      this.mode = 2;
    } else if (this.ly < 144) this.mode = 2;
    if (this.mode === 2 && this.ly === this.wy) this.wyHit = true;
    this.updateStat();
  }

  // ---------------------------------------------------------------- drawing

  renderLine() {
    const y = this.ly, lcdc = this.lcdc, vram = this.vram, cgb = this.cgb;
    const out = this.frame, row = y * WIDTH, idx = this.lineIdx, pri = this.linePri;
    if (this.ly === this.wy) this.wyHit = true;
    const bgOn = cgb || (lcdc & 1);
    idx.fill(0); pri.fill(0);

    if (!bgOn) {
      for (let x = 0; x < WIDTH; x++) out[row + x] = this.shades[0];
    } else {
      // Background, then the window over it from WX-7 rightward.
      const winOn = (lcdc & 0x20) && this.wyHit && this.wx <= 166;
      const winStart = winOn ? this.wx - 7 : WIDTH;
      this.drawTiles(row, 0, Math.min(WIDTH, Math.max(0, winStart)), lcdc & 0x08 ? 0x1C00 : 0x1800, this.scx, (y + this.scy) & 0xFF, true);
      if (winOn) {
        this.drawTiles(row, Math.max(0, winStart), WIDTH, lcdc & 0x40 ? 0x1C00 : 0x1800, -winStart, this.windowLine, false);
        this.windowLine++;
      }
    }
    if (lcdc & 0x02) this.drawSprites(row, y);
  }

  // Tiles from `map` for screen pixels [x0, x1): map x = screen x + dx (mod
  // 256), map row py. Records each pixel's color index (and Color priority).
  drawTiles(row, x0, x1, map, dx, py, wrap) {
    const vram = this.vram, cgb = this.cgb, out = this.frame, idx = this.lineIdx, pri = this.linePri;
    const unsignedTiles = this.lcdc & 0x10;
    for (let x = x0; x < x1; x++) {
      const px = wrap ? (x + dx) & 0xFF : x + dx;
      const m = map + ((py >> 3) << 5) + ((px >> 3) & 31);
      const tile = vram[m];
      const attr = cgb ? vram[0x2000 + m] : 0;
      let ty = py & 7, tx = px & 7;
      if (attr & 0x40) ty = 7 - ty;
      if (attr & 0x20) tx = 7 - tx;
      const base = (attr & 0x08 ? 0x2000 : 0) + (unsignedTiles ? tile << 4 : 0x1000 + ((tile << 24 >> 24) << 4)) + ty * 2;
      const bit = 7 - tx;
      const c = ((vram[base] >> bit) & 1) | (((vram[base + 1] >> bit) & 1) << 1);
      idx[x] = c;
      if (cgb) {
        pri[x] = attr >> 7;
        const p = ((attr & 7) << 3) + c * 2;
        out[row + x] = color15(this.bgPal[p], this.bgPal[p + 1]);
      } else out[row + x] = this.shades[(this.bgp >> (c * 2)) & 3];
    }
  }

  drawSprites(row, y) {
    const oam = this.oam, vram = this.vram, cgb = this.cgb, out = this.frame, idx = this.lineIdx, pri = this.linePri;
    const tall = this.lcdc & 0x04, h = tall ? 16 : 8;
    // The first ten sprites in OAM that cross this line.
    const list = [];
    for (let i = 0; i < 40 && list.length < 10; i++) {
      const sy = oam[i * 4] - 16;
      if (y >= sy && y < sy + h) list.push(i);
    }
    // Priority: on the Color, OAM order; on the original, smaller X first (then OAM order).
    if (!cgb) list.sort((a, b) => (oam[a * 4 + 1] - oam[b * 4 + 1]) || a - b);
    // Each pixel goes to the highest-priority sprite opaque there; only then is
    // that sprite's behind-the-background bit checked (so a hidden sprite still
    // hides the ones below it).
    const masterPri = cgb ? (this.lcdc & 1) : 1, taken = this.spriteTaken || (this.spriteTaken = new Uint8Array(WIDTH));
    taken.fill(0);
    for (let k = 0; k < list.length; k++) {
      const i = list[k] * 4, sy = oam[i] - 16, sx = oam[i + 1] - 8, attr = oam[i + 3];
      let tile = oam[i + 2], ty = y - sy;
      if (tall) tile &= 0xFE;
      if (attr & 0x40) ty = h - 1 - ty;
      const base = (cgb && (attr & 0x08) ? 0x2000 : 0) + (tile << 4) + ty * 2;
      const lo = vram[base], hi = vram[base + 1];
      for (let tx = 0; tx < 8; tx++) {
        const x = sx + tx;
        if (x < 0 || x >= WIDTH || taken[x]) continue;
        const bit = attr & 0x20 ? tx : 7 - tx;
        const c = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
        if (!c) continue;
        taken[x] = 1;
        // Behind the background's colors 1-3 if the sprite (or, on the Color, the tile) says so.
        if (masterPri && idx[x] && ((attr & 0x80) || pri[x])) continue;
        if (cgb) {
          const p = ((attr & 7) << 3) + c * 2;
          out[row + x] = color15(this.objPal[p], this.objPal[p + 1]);
        } else {
          const pal = attr & 0x10 ? this.obp1 : this.obp0;
          out[row + x] = this.shades[(pal >> (c * 2)) & 3];
        }
      }
    }
  }
}
