#!/usr/bin/env node
// Save-state and battery checks.
//
//   node tools/state-check.mjs [rom ...]
//
// For each ROM: run, save the state, restore it into a fresh machine, and
// check both machines produce the same frames and serial output from there.
// Then round-trip battery RAM and the MBC3 clock through a synthetic cart.

import fs from 'node:fs';
import { GameBoy } from '../src/emu/gameboy.js';
import { Cart } from '../src/emu/cart.js';
import { encode, decode } from '../src/emu/state.js';

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

for (const path of process.argv.slice(2)) {
  const rom = new Uint8Array(fs.readFileSync(path));
  const a = new GameBoy(); a.load(rom);
  for (let i = 0; i < 300; i++) { a.buttons = (i >> 4) & 0x30; a.runFrame(); }
  const text = encode(a.saveState());
  const b = new GameBoy(); b.load(rom); b.loadState(decode(text));
  const sentBefore = a.serialOut.length;            // the link-port log isn't machine state
  let same = true;
  for (let i = 0; i < 300 && same; i++) {
    a.buttons = b.buttons = (i >> 3) & 0x31;
    a.runFrame(); b.runFrame();
    same = a.frame.every((p, k) => p === b.frame[k]) && a.serialOut.slice(sentBefore) === b.serialOut;
  }
  check(same, `${path}: identical for 300 frames after restore (${(text.length / 1024).toFixed(1)} KB)`);
}

// A 64K MBC1 cart with 8K of battery RAM (type 03, RAM size 02).
const fake = (type, ramSize) => {
  const rom = new Uint8Array(0x10000);
  rom[0x147] = type; rom[0x148] = 1; rom[0x149] = ramSize;
  return rom;
};
{
  const cart = new Cart(fake(0x03, 2));
  cart.write(0x0000, 0x0A);                       // enable RAM
  cart.writeRam(0xA123, 0x5A);
  const saved = decode(encode(cart.batteryData()));
  const again = new Cart(fake(0x03, 2));
  again.loadBattery(saved);
  again.write(0x0000, 0x0A);
  check(again.readRam(0xA123) === 0x5A && cart.dirty, 'MBC1 battery RAM survives a save and reload');
}
{
  const cart = new Cart(fake(0x10, 3));           // MBC3 + clock + RAM + battery
  cart.write(0x0000, 0x0A);
  cart.write(0x4000, 0x08);                       // select the seconds register
  cart.writeRam(0xA000, 10);
  cart.rtcBase -= 65 * 1000;                      // pretend 65 seconds have passed
  cart.write(0x6000, 0); cart.write(0x6000, 1);   // latch
  const secs = cart.readRam(0xA000);
  cart.write(0x4000, 0x09);
  const mins = cart.readRam(0xA000);
  check(secs === 15 && mins === 1, `MBC3 clock advances with real time (read ${mins}m ${secs}s, expected 1m 15s)`);
}

process.exit(failed ? 1 : 0);
