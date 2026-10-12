// Game Boy cartridges: the header, and the memory bank controllers that page
// ROM into 4000-7FFF and battery-backed RAM into A000-BFFF.
//
// Header (0100-014F): title 0134-0143, color flag 0143 (80 = works on both,
// C0 = Color only), type 0147, ROM size 0148 (32K << n), RAM size 0149.
//
//   none   32K of ROM, maybe 8K of RAM
//   MBC1   up to 2M ROM / 32K RAM; a mode bit picks whether the upper two bank
//          bits go to ROM or RAM
//   MBC2   up to 256K ROM, 512 x 4-bit RAM built in
//   MBC3   up to 2M ROM / 32K RAM, plus a real-time clock on some
//   MBC5   up to 8M ROM / 128K RAM (and a rumble motor on some)

import { capture, apply } from './state.js';

const TYPES = {
  0x00: ['none', 0], 0x08: ['none', 0], 0x09: ['none', 1],
  0x01: ['MBC1', 0], 0x02: ['MBC1', 0], 0x03: ['MBC1', 1],
  0x05: ['MBC2', 0], 0x06: ['MBC2', 1],
  0x0F: ['MBC3', 1, true], 0x10: ['MBC3', 1, true], 0x11: ['MBC3', 0], 0x12: ['MBC3', 0], 0x13: ['MBC3', 1],
  0x19: ['MBC5', 0], 0x1A: ['MBC5', 0], 0x1B: ['MBC5', 1], 0x1C: ['MBC5', 0], 0x1D: ['MBC5', 0], 0x1E: ['MBC5', 1],
};
const RAM_SIZES = [0, 0x800, 0x2000, 0x8000, 0x20000, 0x10000];

export function readHeader(rom) {
  if (rom.length < 0x150) throw new Error('too small to be a Game Boy ROM');
  let title = '';
  for (let i = 0x134; i < 0x144; i++) {
    const ch = rom[i];
    if (!ch || (i >= 0x13F && rom[0x143] & 0x80)) break;   // newer carts use the end for codes and the color flag
    if (ch >= 0x20 && ch < 0x7F) title += String.fromCharCode(ch);
  }
  return {
    title: title.trim(),
    color: rom[0x143] & 0x80 ? (rom[0x143] === 0xC0 ? 'only' : 'yes') : 'no',
    type: rom[0x147],
    ramSize: rom[0x147] === 0x05 || rom[0x147] === 0x06 ? 0x200 : RAM_SIZES[rom[0x149]] || 0,
  };
}

const STATE = ['ram', 'romBank', 'ramBank', 'ramOn', 'mode', 'rtc', 'rtcLatched', 'latchArm', 'rtcBase'];

export class Cart {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  constructor(rom) {
    const hdr = readHeader(rom);
    const kind = TYPES[hdr.type];
    if (!kind) throw new Error(`this cartridge type isn't supported (type ${hdr.type.toString(16).padStart(2, '0')})`);
    [this.mbc, this.battery, this.hasClock] = [kind[0], !!kind[1], !!kind[2]];
    this.header = hdr;
    // Pad the ROM to a power of two so bank numbers wrap cleanly.
    let size = 0x8000;
    while (size < rom.length) size <<= 1;
    this.rom = new Uint8Array(size);
    this.rom.set(rom);
    this.romBanks = size >> 14;
    this.ram = new Uint8Array(Math.max(hdr.ramSize, this.mbc === 'MBC2' ? 0x200 : 0));
    this.ramBanks = Math.max(1, this.ram.length >> 13);
    this.name = this.mbc === 'none' ? 'ROM' : this.mbc;
    this.reset();
  }

  reset() {
    this.romBank = 1; this.ramBank = 0; this.ramOn = false; this.mode = 0;
    // MBC3 clock: seconds, minutes, hours, day low, day high/halt/carry.
    this.rtc = this.rtc || new Uint8Array(5);
    this.rtcLatched = new Uint8Array(5);
    this.latchArm = false;
    this.rtcBase = this.rtcBase || Date.now();
  }

  // ---------------------------------------------------------------- ROM

  read(a) {
    if (a < 0x4000) {
      // MBC1 in mode 1 also pages the lower area by the upper bank bits.
      if (this.mbc === 'MBC1' && this.mode) return this.rom[(((this.ramBank << 5) % this.romBanks) << 14) | a];
      return this.rom[a];
    }
    return this.rom[((this.currentRomBank() % this.romBanks) << 14) | (a & 0x3FFF)];
  }

  currentRomBank() {
    if (this.mbc === 'MBC1') return (this.romBank & 0x1F) | (this.ramBank << 5);
    return this.romBank;
  }

  write(a, v) {
    switch (this.mbc) {
      case 'none': return;
      case 'MBC1':
        if (a < 0x2000) this.ramOn = (v & 0x0F) === 0x0A;
        else if (a < 0x4000) this.romBank = (v & 0x1F) || 1;
        else if (a < 0x6000) this.ramBank = v & 3;
        else this.mode = v & 1;
        return;
      case 'MBC2':
        if (a < 0x4000) {
          if (a & 0x100) this.romBank = (v & 0x0F) || 1;
          else this.ramOn = (v & 0x0F) === 0x0A;
        }
        return;
      case 'MBC3':
        if (a < 0x2000) this.ramOn = (v & 0x0F) === 0x0A;
        else if (a < 0x4000) this.romBank = (v & 0x7F) || 1;
        else if (a < 0x6000) this.ramBank = v & 0x0F;
        else {
          // Writing 0 then 1 latches the clock into the readable registers.
          if (this.latchArm && v === 1) { this.tickClock(); this.rtcLatched.set(this.rtc); }
          this.latchArm = v === 0;
        }
        return;
      case 'MBC5':
        if (a < 0x2000) this.ramOn = (v & 0x0F) === 0x0A;
        else if (a < 0x3000) this.romBank = (this.romBank & 0x100) | v;
        else if (a < 0x4000) this.romBank = (this.romBank & 0xFF) | ((v & 1) << 8);
        else if (a < 0x6000) this.ramBank = v & 0x0F;
        return;
    }
  }

  // ---------------------------------------------------------------- RAM (A000-BFFF)

  ramIndex(a) {
    if (this.mbc === 'MBC2') return a & 0x1FF;
    const bank = this.mbc === 'MBC1' ? (this.mode ? this.ramBank : 0) : this.ramBank;
    return ((bank % this.ramBanks) << 13) | (a & 0x1FFF);
  }

  readRam(a) {
    if (!this.ramOn) return 0xFF;
    if (this.mbc === 'MBC3' && this.ramBank >= 8) return this.ramBank <= 0x0C ? this.rtcLatched[this.ramBank - 8] : 0xFF;
    if (!this.ram.length) return 0xFF;
    const v = this.ram[this.ramIndex(a)];
    return this.mbc === 'MBC2' ? v | 0xF0 : v;
  }

  writeRam(a, v) {
    if (!this.ramOn) return;
    if (this.mbc === 'MBC3' && this.ramBank >= 8) {
      if (this.ramBank <= 0x0C) { this.tickClock(); this.rtc[this.ramBank - 8] = v; this.rtcBase = Date.now(); }
      return;
    }
    if (!this.ram.length) return;
    this.ram[this.ramIndex(a)] = this.mbc === 'MBC2' ? v & 0x0F : v;
    this.dirty = true;
  }

  // ---------------------------------------------------------------- MBC3 clock

  // Advance the clock registers by the real time since they were last brought
  // up to date (unless the halt bit is set).
  tickClock() {
    const now = Date.now();
    let secs = Math.floor((now - this.rtcBase) / 1000);
    if (secs <= 0) return;
    this.rtcBase += secs * 1000;
    const r = this.rtc;
    if (r[4] & 0x40) return;
    let total = r[0] + secs, m = r[1], h = r[2], day = r[3] | ((r[4] & 1) << 8);
    m += Math.floor(total / 60); total %= 60;
    h += Math.floor(m / 60); m %= 60;
    day += Math.floor(h / 24); h %= 24;
    if (day > 511) { day &= 511; r[4] |= 0x80; }
    r[0] = total; r[1] = m; r[2] = h; r[3] = day & 0xFF; r[4] = (r[4] & 0xFE) | (day >> 8);
    this.dirty = true;
  }

  // Battery data: RAM, plus the clock and when it was last brought up to date.
  batteryData() {
    if (!this.battery) return null;
    if (this.hasClock) this.tickClock();
    return { ram: this.ram.slice(), rtc: this.hasClock ? this.rtc.slice() : null, rtcBase: this.rtcBase };
  }
  loadBattery(d) {
    if (!d || !d.ram) return;
    if (d.ram.length === this.ram.length) this.ram.set(d.ram);
    if (this.hasClock && d.rtc) { this.rtc.set(d.rtc); this.rtcBase = d.rtcBase || Date.now(); }
  }
}
