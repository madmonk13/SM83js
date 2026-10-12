// Sharp SM83: the Game Boy's CPU (inside the LR35902 / CGB CPU chips). An
// 8080-family core with some Z80-style additions (the CB bit operations,
// relative jumps) and its own changes: no IX/IY or shadow registers, LDH and
// (HL+)/(HL-) addressing, SWAP, STOP and HALT, and four flags (Z N H C) in the
// top bits of F.
//
// Timing is per memory access: every read or write, and every internal
// machine cycle, advances the system by 4 clocks before it happens (bus.tick),
// so timers, video and sound see accesses at the right moment.

import { capture, apply } from './state.js';

const Z = 0x80, N = 0x40, H = 0x20, C = 0x10;
const STATE = ['a', 'f', 'b', 'c', 'd', 'e', 'h', 'l', 'sp', 'pc', 'ime', 'eiDelay', 'halted', 'haltBug', 'stopped', 'locked'];

export class SM83 {
  // bus: { read(addr), write(addr, v), tick(clocks), pending() -> IE & IF & 0x1F, ack(bit) }
  constructor(bus) { this.bus = bus; this.reset(); }
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  reset() {
    this.a = this.f = this.b = this.c = this.d = this.e = this.h = this.l = 0;
    this.sp = 0xFFFE; this.pc = 0x0100;
    this.ime = false; this.eiDelay = false;
    this.halted = false; this.haltBug = false; this.stopped = false; this.locked = false;
  }

  // ---------------------------------------------------------------- bus

  rd(a) { this.bus.tick(4); return this.bus.read(a & 0xFFFF); }
  wr(a, v) { this.bus.tick(4); this.bus.write(a & 0xFFFF, v & 0xFF); }
  idle() { this.bus.tick(4); }
  imm8() { const v = this.rd(this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; }
  imm16() { const lo = this.imm8(); return lo | (this.imm8() << 8); }
  push(v) { this.sp = (this.sp - 1) & 0xFFFF; this.wr(this.sp, v >> 8); this.sp = (this.sp - 1) & 0xFFFF; this.wr(this.sp, v); }
  pop() { const lo = this.rd(this.sp); this.sp = (this.sp + 1) & 0xFFFF; const hi = this.rd(this.sp); this.sp = (this.sp + 1) & 0xFFFF; return lo | (hi << 8); }

  get bc() { return (this.b << 8) | this.c; }
  set bc(v) { this.b = (v >> 8) & 0xFF; this.c = v & 0xFF; }
  get de() { return (this.d << 8) | this.e; }
  set de(v) { this.d = (v >> 8) & 0xFF; this.e = v & 0xFF; }
  get hl() { return (this.h << 8) | this.l; }
  set hl(v) { this.h = (v >> 8) & 0xFF; this.l = v & 0xFF; }

  // Registers by their 3-bit code: B C D E H L (HL) A.
  getR(r) {
    switch (r) {
      case 0: return this.b; case 1: return this.c; case 2: return this.d; case 3: return this.e;
      case 4: return this.h; case 5: return this.l; case 6: return this.rd(this.hl); default: return this.a;
    }
  }
  setR(r, v) {
    v &= 0xFF;
    switch (r) {
      case 0: this.b = v; break; case 1: this.c = v; break; case 2: this.d = v; break; case 3: this.e = v; break;
      case 4: this.h = v; break; case 5: this.l = v; break; case 6: this.wr(this.hl, v); break; default: this.a = v;
    }
  }
  // Register pairs by their 2-bit code: BC DE HL SP (or AF for PUSH/POP).
  getRR(p) { return p === 0 ? this.bc : p === 1 ? this.de : p === 2 ? this.hl : this.sp; }
  setRR(p, v) { v &= 0xFFFF; if (p === 0) this.bc = v; else if (p === 1) this.de = v; else if (p === 2) this.hl = v; else this.sp = v; }

  cond(cc) {
    switch (cc) {
      case 0: return !(this.f & Z); case 1: return !!(this.f & Z);
      case 2: return !(this.f & C); default: return !!(this.f & C);
    }
  }

  // ---------------------------------------------------------------- ALU

  alu(op, v) {
    const a = this.a;
    let r;
    switch (op) {
      case 0: r = a + v; this.f = ((r & 0xFF) ? 0 : Z) | (((a & 15) + (v & 15)) > 15 ? H : 0) | (r > 0xFF ? C : 0); break;   // ADD
      case 1: { const cy = (this.f & C) ? 1 : 0; r = a + v + cy;                                                              // ADC
        this.f = ((r & 0xFF) ? 0 : Z) | (((a & 15) + (v & 15) + cy) > 15 ? H : 0) | (r > 0xFF ? C : 0); break; }
      case 2: case 7: r = a - v; this.f = ((r & 0xFF) ? 0 : Z) | N | ((a & 15) < (v & 15) ? H : 0) | (r < 0 ? C : 0);       // SUB, CP
        if (op === 7) return; break;
      case 3: { const cy = (this.f & C) ? 1 : 0; r = a - v - cy;                                                              // SBC
        this.f = ((r & 0xFF) ? 0 : Z) | N | ((a & 15) - (v & 15) - cy < 0 ? H : 0) | (r < 0 ? C : 0); break; }
      case 4: r = a & v; this.f = (r ? 0 : Z) | H; break;                                                                     // AND
      case 5: r = a ^ v; this.f = (r & 0xFF) ? 0 : Z; break;                                                                  // XOR
      default: r = a | v; this.f = (r & 0xFF) ? 0 : Z;                                                                       // OR
    }
    this.a = r & 0xFF;
  }

  inc8(v) { const r = (v + 1) & 0xFF; this.f = (this.f & C) | (r ? 0 : Z) | ((v & 15) === 15 ? H : 0); return r; }
  dec8(v) { const r = (v - 1) & 0xFF; this.f = (this.f & C) | (r ? 0 : Z) | N | ((v & 15) === 0 ? H : 0); return r; }

  // SP plus a signed byte, with H and C from the low byte's unsigned add (ADD SP,e and LD HL,SP+e).
  spOffset(e) {
    const sp = this.sp, s = e & 0x80 ? e - 256 : e;
    this.f = (((sp & 15) + (e & 15)) > 15 ? H : 0) | (((sp & 0xFF) + e) > 0xFF ? C : 0);
    return (sp + s) & 0xFFFF;
  }

  // CB-prefixed rotate and shift group.
  rot(op, v) {
    let r, c;
    switch (op) {
      case 0: c = v >> 7; r = (v << 1) | c; break;                              // RLC
      case 1: c = v & 1; r = (v >> 1) | (c << 7); break;                        // RRC
      case 2: c = v >> 7; r = (v << 1) | ((this.f & C) ? 1 : 0); break;         // RL
      case 3: c = v & 1; r = (v >> 1) | ((this.f & C) ? 0x80 : 0); break;      // RR
      case 4: c = v >> 7; r = v << 1; break;                                    // SLA
      case 5: c = v & 1; r = (v >> 1) | (v & 0x80); break;                      // SRA
      case 6: c = 0; r = ((v << 4) | (v >> 4)); break;                          // SWAP
      default: c = v & 1; r = v >> 1;                                           // SRL
    }
    r &= 0xFF;
    this.f = (r ? 0 : Z) | (c ? C : 0);
    return r;
  }

  // ---------------------------------------------------------------- execution

  // One instruction (or interrupt dispatch, or one machine cycle of HALT).
  step() {
    if (this.locked) { this.idle(); return; }           // an undefined opcode hangs the CPU
    const pending = this.bus.pending();
    if (this.halted) {
      if (!pending) { this.idle(); return; }
      this.halted = false;
    }
    if (this.ime && pending) { this.interrupt(pending); return; }
    const enable = this.eiDelay;
    this.eiDelay = false;
    let op = this.rd(this.pc);
    if (this.haltBug) this.haltBug = false;            // the byte after HALT is read twice
    else this.pc = (this.pc + 1) & 0xFFFF;
    this.exec(op);
    if (enable) this.ime = true;                        // EI takes effect after the next instruction
  }

  // Push PC and jump to the highest-priority pending interrupt's vector.
  interrupt(pending) {
    this.ime = false;
    this.idle(); this.idle();
    this.sp = (this.sp - 1) & 0xFFFF; this.wr(this.sp, this.pc >> 8);
    // The low byte's push can land on IE and cancel the dispatch (then PC goes to 0).
    const now = this.bus.pending() || pending;
    this.sp = (this.sp - 1) & 0xFFFF; this.wr(this.sp, this.pc & 0xFF);
    let bit = 0;
    while (bit < 5 && !(now & (1 << bit))) bit++;
    if (bit === 5) { this.pc = 0; this.idle(); return; }
    this.bus.ack(bit);
    this.pc = 0x40 + bit * 8;
    this.idle();
  }

  exec(op) {
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7;
    if (x === 1) {                                      // LD r,r' (and HALT)
      if (op === 0x76) {
        if (!this.ime && this.bus.pending()) this.haltBug = true;
        else this.halted = true;
        return;
      }
      this.setR(y, this.getR(z));
      return;
    }
    if (x === 2) { this.alu(y, this.getR(z)); return; }  // ALU A,r

    switch (op) {
      case 0x00: return;                                                        // NOP
      case 0x10: this.imm8(); this.stopped = true; this.bus.stop(); return;      // STOP (speed switch on CGB)
      case 0x08: { const a = this.imm16(); this.wr(a, this.sp); this.wr(a + 1, this.sp >> 8); return; }   // LD (a16),SP
      case 0x18: { const e = this.imm8(); this.idle(); this.pc = (this.pc + (e & 0x80 ? e - 256 : e)) & 0xFFFF; return; }   // JR e
      case 0x20: case 0x28: case 0x30: case 0x38: {                            // JR cc,e
        const e = this.imm8();
        if (this.cond(y - 4)) { this.idle(); this.pc = (this.pc + (e & 0x80 ? e - 256 : e)) & 0xFFFF; }
        return;
      }
      case 0x02: this.wr(this.bc, this.a); return;
      case 0x12: this.wr(this.de, this.a); return;
      case 0x22: this.wr(this.hl, this.a); this.hl = this.hl + 1; return;
      case 0x32: this.wr(this.hl, this.a); this.hl = this.hl - 1; return;
      case 0x0A: this.a = this.rd(this.bc); return;
      case 0x1A: this.a = this.rd(this.de); return;
      case 0x2A: this.a = this.rd(this.hl); this.hl = this.hl + 1; return;
      case 0x3A: this.a = this.rd(this.hl); this.hl = this.hl - 1; return;
      case 0x07: { const c = this.a >> 7; this.a = ((this.a << 1) | c) & 0xFF; this.f = c ? C : 0; return; }            // RLCA
      case 0x0F: { const c = this.a & 1; this.a = (this.a >> 1) | (c << 7); this.f = c ? C : 0; return; }               // RRCA
      case 0x17: { const c = this.a >> 7; this.a = ((this.a << 1) | ((this.f & C) ? 1 : 0)) & 0xFF; this.f = c ? C : 0; return; }   // RLA
      case 0x1F: { const c = this.a & 1; this.a = (this.a >> 1) | ((this.f & C) ? 0x80 : 0); this.f = c ? C : 0; return; }        // RRA
      case 0x27: {                                                              // DAA
        let a = this.a, f = this.f;
        if (!(f & N)) {
          if ((f & C) || a > 0x99) { a += 0x60; f |= C; }
          if ((f & H) || (a & 15) > 9) a += 0x06;
        } else {
          if (f & C) a -= 0x60;
          if (f & H) a -= 0x06;
        }
        this.a = a & 0xFF;
        this.f = (f & (N | C)) | (this.a ? 0 : Z);
        return;
      }
      case 0x2F: this.a ^= 0xFF; this.f |= N | H; return;                       // CPL
      case 0x37: this.f = (this.f & Z) | C; return;                              // SCF
      case 0x3F: this.f = (this.f & Z) | ((this.f & C) ? 0 : C); return;         // CCF

      case 0xC3: { const a = this.imm16(); this.idle(); this.pc = a; return; }   // JP a16
      case 0xE9: this.pc = this.hl; return;                                      // JP HL
      case 0xCD: { const a = this.imm16(); this.idle(); this.push(this.pc); this.pc = a; return; }   // CALL a16
      case 0xC9: this.pc = this.pop(); this.idle(); return;                      // RET
      case 0xD9: this.pc = this.pop(); this.idle(); this.ime = true; return;     // RETI
      case 0xCB: this.cb(this.imm8()); return;
      case 0xE0: this.wr(0xFF00 | this.imm8(), this.a); return;                  // LDH (a8),A
      case 0xF0: this.a = this.rd(0xFF00 | this.imm8()); return;                 // LDH A,(a8)
      case 0xE2: this.wr(0xFF00 | this.c, this.a); return;                       // LD (C),A
      case 0xF2: this.a = this.rd(0xFF00 | this.c); return;                      // LD A,(C)
      case 0xEA: this.wr(this.imm16(), this.a); return;                          // LD (a16),A
      case 0xFA: this.a = this.rd(this.imm16()); return;                         // LD A,(a16)
      case 0xE8: { const e = this.imm8(); this.sp = this.spOffset(e); this.idle(); this.idle(); return; }   // ADD SP,e
      case 0xF8: { const e = this.imm8(); this.hl = this.spOffset(e); this.idle(); return; }                // LD HL,SP+e
      case 0xF9: this.sp = this.hl; this.idle(); return;                         // LD SP,HL
      case 0xF3: this.ime = false; this.eiDelay = false; return;                 // DI
      case 0xFB: this.eiDelay = true; return;                                    // EI
    }

    if (x === 0) {
      switch (z) {
        case 1:
          if (y & 1) {                                                           // ADD HL,rr
            const hl = this.hl, v = this.getRR(y >> 1), r = hl + v;
            this.f = (this.f & Z) | (((hl & 0xFFF) + (v & 0xFFF)) > 0xFFF ? H : 0) | (r > 0xFFFF ? C : 0);
            this.hl = r; this.idle();
          } else this.setRR(y >> 1, this.imm16());                              // LD rr,d16
          return;
        case 3: this.setRR(y >> 1, this.getRR(y >> 1) + ((y & 1) ? -1 : 1)); this.idle(); return;   // INC/DEC rr
        case 4: this.setR(y, this.inc8(this.getR(y))); return;                  // INC r
        case 5: this.setR(y, this.dec8(this.getR(y))); return;                  // DEC r
        case 6: this.setR(y, this.imm8()); return;                              // LD r,d8
      }
    }

    // x === 3
    switch (z) {
      case 0: if (y < 4) { this.idle(); if (this.cond(y)) { this.pc = this.pop(); this.idle(); } return; } break;   // RET cc
      case 1:                                                                    // POP rr
        if (y & 1) break;
        if ((y >> 1) === 3) { const v = this.pop(); this.a = v >> 8; this.f = v & 0xF0; }
        else this.setRR(y >> 1, this.pop());
        return;
      case 2: if (y < 4) { const a = this.imm16(); if (this.cond(y)) { this.idle(); this.pc = a; } return; } break;  // JP cc
      case 4: if (y < 4) { const a = this.imm16(); if (this.cond(y)) { this.idle(); this.push(this.pc); this.pc = a; } return; } break;   // CALL cc
      case 5:                                                                    // PUSH rr
        if (y & 1) break;
        this.idle();
        this.push((y >> 1) === 3 ? (this.a << 8) | this.f : this.getRR(y >> 1));
        return;
      case 6: this.alu(y, this.imm8()); return;                                  // ALU A,d8
      case 7: this.idle(); this.push(this.pc); this.pc = y * 8; return;          // RST
    }
    this.locked = true;                                                          // undefined opcode
  }

  cb(op) {
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7;
    const v = this.getR(z);
    switch (x) {
      case 0: this.setR(z, this.rot(y, v)); return;
      case 1: this.f = (this.f & C) | H | ((v >> y) & 1 ? 0 : Z); return;        // BIT
      case 2: this.setR(z, v & ~(1 << y)); return;                              // RES
      default: this.setR(z, v | (1 << y));                                      // SET
    }
  }
}
