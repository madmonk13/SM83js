// The Game Boy and Game Boy Color: CPU, memory map, timer, joypad, serial
// port, the picture processor and sound.
//
//   0000-7FFF cartridge ROM      A000-BFFF cartridge RAM
//   8000-9FFF video RAM          C000-DFFF work RAM (Color: D000 banked, 7 x 4K)
//   E000-FDFF echo of C000       FE00-FE9F sprite table (OAM)
//   FF00-FF7F I/O                FF80-FFFE high RAM     FFFF interrupt enable
//
// Interrupts (IF FF0F / IE FFFF): 0 vertical blank, 1 LCD status, 2 timer,
// 3 serial, 4 joypad.
//
// There's no boot ROM here: the machine starts in the state the boot ROM
// leaves behind. Color games (header 0143 bit 7) run in Color mode.

import { SM83 } from './sm83.js';
import { PPU, DMG_PALETTES } from './ppu.js';
import { APU } from './apu.js';
import { Cart } from './cart.js';
import { capture, apply } from './state.js';

export const FPS = 4194304 / 70224;              // about 59.73
const TIMER_BIT = [9, 3, 5, 7];                  // TAC speed -> which counter bit clocks TIMA

const STATE = ['cpu', 'ppu', 'apu', 'cart', 'wram', 'hram', 'ie', 'iflag', 'div', 'tima', 'tma', 'tac', 'timaReload',
  'joypSel', 'sb', 'sc', 'serialClock', 'wbank', 'doubleSpeed', 'speedArmed', 'hdma', 'hdmaActive', 'hdmaLen', 'cgb', 'lastButtons'];

export class GameBoy {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); this.ppu.cgb = this.cgb; }

  constructor() {
    this.cpu = new SM83(this);
    this.ppu = new PPU({ irq: (b) => this.irq(b), hblank: () => this.hblankDma() });
    this.apu = new APU();
    this.cart = null;
    this.buttons = 0;          // pressed: 01 right, 02 left, 04 up, 08 down, 10 A, 20 B, 40 select, 80 start
    this.preferColor = true;   // run Color games in Color mode
    this.serialOut = '';       // bytes sent out the link port (test ROMs print results there)
    this.lastButtons = 0;
  }

  // ---------------------------------------------------------------- cartridge

  load(rom) {
    this.cart = new Cart(rom);
    this.reset();
    return this.cart;
  }

  get title() { return this.cart ? this.cart.header.title : ''; }

  reset() {
    const color = this.cart ? this.cart.header.color : 'no';
    this.cgb = color === 'only' || (color === 'yes' && this.preferColor);
    this.ppu.cgb = this.cgb;
    this.ppu.reset();
    this.apu.reset();
    this.cart && this.cart.reset();
    this.wram = new Uint8Array(0x8000);
    this.hram = new Uint8Array(0x7F);
    this.ie = 0; this.iflag = 0xE1;
    this.div = 0xABCC; this.tima = 0; this.tma = 0; this.tac = 0xF8; this.timaReload = 0;
    this.joypSel = 0x30; this.sb = 0; this.sc = 0; this.serialClock = 0;
    this.wbank = 1; this.doubleSpeed = false; this.speedArmed = false;
    this.hdma = new Uint8Array(4); this.hdmaActive = false; this.hdmaLen = 0;
    this.serialOut = '';
    // The registers as the boot ROM leaves them.
    const c = this.cpu;
    c.reset();
    if (this.cgb) { c.a = 0x11; c.f = 0x80; c.b = 0x00; c.c = 0x00; c.d = 0xFF; c.e = 0x56; c.h = 0x00; c.l = 0x0D; }
    else { c.a = 0x01; c.f = 0xB0; c.b = 0x00; c.c = 0x13; c.d = 0x00; c.e = 0xD8; c.h = 0x01; c.l = 0x4D; }
    // Sound as the boot ROM leaves it (on, with its jingle's settings).
    this.apu.write(0xFF26, 0x80);
    for (const [a, v] of [[0xFF10, 0x80], [0xFF11, 0xBF], [0xFF12, 0xF3], [0xFF14, 0x3F], [0xFF16, 0x3F], [0xFF19, 0x3F],
      [0xFF1A, 0x7F], [0xFF1B, 0xFF], [0xFF1C, 0x9F], [0xFF1E, 0x3F], [0xFF20, 0xFF], [0xFF23, 0x3F], [0xFF24, 0x77], [0xFF25, 0xF3]]) {
      this.apu.write(a, v);
    }
  }

  setShades(name) { this.ppu.shades = DMG_PALETTES[name] || DMG_PALETTES.green; }

  // ---------------------------------------------------------------- CPU bus

  irq(bit) { this.iflag |= 1 << bit; }
  pending() { return this.ie & this.iflag & 0x1F; }
  ack(bit) { this.iflag &= ~(1 << bit); }

  // STOP: on the Color with KEY1 armed, switch CPU speed; otherwise it's a
  // low-power wait for a button, treated here as an immediate wake.
  stop() {
    if (this.cgb && this.speedArmed) { this.doubleSpeed = !this.doubleSpeed; this.speedArmed = false; this.div = 0; }
    this.cpu.stopped = false;
  }

  read(a) {
    if (a < 0x8000) return this.cart.read(a);
    if (a < 0xA000) return this.ppu.readVram(a);
    if (a < 0xC000) return this.cart.readRam(a);
    if (a < 0xD000) return this.wram[a & 0x0FFF];
    if (a < 0xE000) return this.wram[(this.wbank << 12) | (a & 0x0FFF)];
    if (a < 0xFE00) return this.read(a - 0x2000);
    if (a < 0xFEA0) return this.ppu.oam[a - 0xFE00];
    if (a < 0xFF00) return 0xFF;
    if (a >= 0xFF80) return a === 0xFFFF ? this.ie : this.hram[a - 0xFF80];
    return this.readIo(a);
  }

  write(a, v) {
    if (a < 0x8000) { this.cart.write(a, v); return; }
    if (a < 0xA000) { this.ppu.writeVram(a, v); return; }
    if (a < 0xC000) { this.cart.writeRam(a, v); return; }
    if (a < 0xD000) { this.wram[a & 0x0FFF] = v; return; }
    if (a < 0xE000) { this.wram[(this.wbank << 12) | (a & 0x0FFF)] = v; return; }
    if (a < 0xFE00) { this.write(a - 0x2000, v); return; }
    if (a < 0xFEA0) { this.ppu.oam[a - 0xFE00] = v; return; }
    if (a < 0xFF00) return;
    if (a >= 0xFF80) { if (a === 0xFFFF) this.ie = v; else this.hram[a - 0xFF80] = v; return; }
    this.writeIo(a, v);
  }

  readIo(a) {
    if (a >= 0xFF10 && a < 0xFF40) return this.apu.read(a);
    switch (a) {
      case 0xFF00: {                                        // joypad: selected half, active low
        let n = 0x0F;
        if (!(this.joypSel & 0x10)) n &= ~(this.buttons & 0x0F);
        if (!(this.joypSel & 0x20)) n &= ~(this.buttons >> 4);
        return 0xC0 | this.joypSel | n;
      }
      case 0xFF01: return this.sb;
      case 0xFF02: return this.sc | (this.cgb ? 0x7C : 0x7E);
      case 0xFF04: return (this.div >> 8) & 0xFF;
      case 0xFF05: return this.tima;
      case 0xFF06: return this.tma;
      case 0xFF07: return this.tac | 0xF8;
      case 0xFF0F: return this.iflag | 0xE0;
      case 0xFF4D: return this.cgb ? 0x7E | (this.doubleSpeed ? 0x80 : 0) | (this.speedArmed ? 1 : 0) : 0xFF;
      case 0xFF55: return this.cgb ? (this.hdmaActive ? this.hdmaLen : 0x80 | this.hdmaLen) : 0xFF;
      case 0xFF70: return this.cgb ? 0xF8 | this.wbank : 0xFF;
    }
    if (a >= 0xFF40 && a < 0xFF70) return this.ppu.read(a);
    return 0xFF;
  }

  writeIo(a, v) {
    if (a >= 0xFF10 && a < 0xFF40) { this.apu.write(a, v); return; }
    switch (a) {
      case 0xFF00: this.joypSel = v & 0x30; return;
      case 0xFF01: this.sb = v; return;
      case 0xFF02:
        this.sc = v & 0x83;
        // Internal clock: send the byte now (nobody's on the other end, so 1s come back).
        if ((v & 0x81) === 0x81) { this.serialOut += String.fromCharCode(this.sb); this.serialClock = 4096; }
        return;
      case 0xFF04: this.setDiv(0); return;
      case 0xFF05: if (this.timaReload) this.timaReload = 0; this.tima = v; return;
      case 0xFF06: this.tma = v; return;
      case 0xFF07: {
        const was = this.timerInput();
        this.tac = v & 7;
        if (was && !this.timerInput()) this.incTima();     // a falling edge from the switch counts
        return;
      }
      case 0xFF0F: this.iflag = v & 0x1F; return;
      case 0xFF46: this.oamDma(v); return;
      case 0xFF4D: if (this.cgb) this.speedArmed = !!(v & 1); return;
      case 0xFF51: case 0xFF52: case 0xFF53: case 0xFF54: this.hdma[a - 0xFF51] = v; return;
      case 0xFF55: this.startHdma(v); return;
      case 0xFF70: if (this.cgb) this.wbank = (v & 7) || 1; return;
    }
    if (a >= 0xFF40 && a < 0xFF70) this.ppu.write(a, v);
  }

  // ---------------------------------------------------------------- timer

  // TIMA counts on falling edges of (TAC enabled AND the chosen DIV-counter bit).
  timerInput() { return (this.tac & 4) && ((this.div >> TIMER_BIT[this.tac & 3]) & 1); }

  setDiv(v) {
    const was = this.timerInput();
    this.div = v & 0xFFFF;
    if (was && !this.timerInput()) this.incTima();
  }

  incTima() {
    this.tima = (this.tima + 1) & 0xFF;
    if (!this.tima) this.timaReload = 4;                  // TMA is loaded (and the interrupt raised) a cycle later
  }

  // ---------------------------------------------------------------- DMA

  // OAM DMA: 160 bytes from XX00 into the sprite table (done at once).
  oamDma(v) {
    const src = v << 8;
    for (let i = 0; i < 0xA0; i++) this.ppu.oam[i] = this.read(src + i);
  }

  hdmaSrc() { return ((this.hdma[0] << 8) | this.hdma[1]) & 0xFFF0; }
  hdmaDst() { return 0x8000 | (((this.hdma[2] << 8) | this.hdma[3]) & 0x1FF0); }

  copyBlock() {
    const src = this.hdmaSrc(), dst = this.hdmaDst();
    for (let i = 0; i < 16; i++) this.ppu.writeVram(dst + i, this.read(src + i));
    const s = src + 16, d = dst + 16;
    this.hdma[0] = s >> 8; this.hdma[1] = s & 0xF0; this.hdma[2] = (d >> 8) & 0x1F; this.hdma[3] = d & 0xF0;
  }

  // FF55: bit 7 clear copies (n+1) x 16 bytes now; set copies 16 bytes each
  // horizontal blank. Writing bit 7 clear during an HBlank copy stops it.
  startHdma(v) {
    if (!this.cgb) return;
    if (this.hdmaActive && !(v & 0x80)) { this.hdmaActive = false; this.hdmaLen = v & 0x7F; return; }
    if (v & 0x80) { this.hdmaActive = true; this.hdmaLen = v & 0x7F; return; }
    const blocks = (v & 0x7F) + 1;
    for (let n = 0; n < blocks; n++) { this.copyBlock(); for (let k = 0; k < (this.doubleSpeed ? 16 : 8); k++) this.tick(4); }
    this.hdmaLen = 0x7F;
  }

  hblankDma() {
    if (!this.hdmaActive) return;
    this.copyBlock();
    if (this.hdmaLen === 0) { this.hdmaActive = false; this.hdmaLen = 0x7F; } else this.hdmaLen--;
  }

  // ---------------------------------------------------------------- clock

  // Called by the CPU before each memory access or internal cycle: 4 CPU
  // clocks, which is 4 dots at normal speed and 2 at double speed.
  tick(clocks) {
    if (this.timaReload) {
      this.timaReload = 0;
      this.tima = this.tma;
      this.irq(2);
    }
    this.setDiv(this.div + clocks);
    if (this.serialClock > 0 && (this.serialClock -= clocks) <= 0) {
      this.sb = 0xFF; this.sc &= 0x7F; this.irq(3);
    }
    const dots = this.doubleSpeed ? clocks >> 1 : clocks;
    this.ppu.tick(dots);
    this.apu.tick(dots);
    this.frameDots += dots;
  }

  // Run until the next frame is complete (vertical blank, or a frame's worth
  // of time with the screen off).
  runFrame() {
    if (!this.cart) return;
    this.ppu.frameReady = false;
    this.frameDots = 0;
    if (this.buttons & ~this.lastButtons) this.irq(4);         // a new press raises the joypad interrupt
    this.lastButtons = this.buttons;
    while (!this.ppu.frameReady && this.frameDots < 80000) this.cpu.step();
  }

  get frame() { return this.ppu.frame; }
}
