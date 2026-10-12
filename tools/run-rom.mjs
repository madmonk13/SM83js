#!/usr/bin/env node
// Headless check: run a ROM for N frames, print what it sent out the serial
// port (Blargg's test ROMs report there), and save the screen as a PNG.
//
//   node tools/run-rom.mjs <rom> [frames=600] [out.png]
//   Optional env: DMG=1 to run a Color game in original mode; PRESS=frame:buttons
//   (e.g. PRESS=300:start,420:a) to press buttons for a few frames.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { GameBoy } from '../src/emu/gameboy.js';

const [romPath, framesArg = '600', outPath] = process.argv.slice(2);
if (!romPath) { console.error('usage: run-rom.mjs <rom> [frames] [out.png]'); process.exit(1); }

const BITS = { right: 1, left: 2, up: 4, down: 8, a: 0x10, b: 0x20, select: 0x40, start: 0x80 };
const presses = (process.env.PRESS || '').split(',').filter(Boolean).map((p) => {
  const [f, names] = p.split(':');
  return { f: +f, bits: names.split('+').reduce((m, n) => m | BITS[n], 0) };
});

const gb = new GameBoy();
gb.preferColor = !process.env.DMG;
const cart = gb.load(new Uint8Array(fs.readFileSync(romPath)));
const frames = +framesArg;
const t0 = performance.now();
for (let i = 0; i < frames; i++) {
  gb.buttons = presses.filter((p) => i >= p.f && i < p.f + 8).reduce((m, p) => m | p.bits, 0);
  gb.runFrame();
}
const ms = performance.now() - t0;
console.log(`${gb.title || romPath} [${cart.name}${gb.cgb ? ', Color' : ''}]: ${frames} frames, ${(ms / frames).toFixed(2)} ms/frame`);
if (gb.serialOut) console.log('serial:', JSON.stringify(gb.serialOut.trim()));

if (outPath) {
  const W = 160, H = 144, S = 3, f = gb.frame;
  const raw = Buffer.alloc((W * S * 3 + 1) * H * S);
  for (let y = 0; y < H * S; y++) for (let x = 0; x < W * S; x++) {
    const p = f[((y / S) | 0) * W + ((x / S) | 0)], o = y * (W * S * 3 + 1) + 1 + x * 3;
    raw[o] = p & 0xFF; raw[o + 1] = (p >> 8) & 0xFF; raw[o + 2] = (p >> 16) & 0xFF;
  }
  const chunk = (t, d) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W * S, 0); ihdr.writeUInt32BE(H * S, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(outPath, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  console.log(`wrote ${outPath}`);
}
