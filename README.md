# SM83js

A touch-first Game Boy and Game Boy Color emulator for phones and desktop, in
plain JavaScript with no dependencies. It's a sibling of
[6502js](../2600touch) (Atari 2600) and shares its app shell: gesture
controls, a saved cartridge library, pause and resume, save states and an
installable web app.

Named for the Sharp SM83, the CPU core inside the Game Boy's LR35902 and the
Game Boy Color's CPU.

**Play it:** [madmonk13.github.io/SM83js](https://madmonk13.github.io/SM83js/)

## Offline and install

The app is a PWA: open it once while online and a service worker (`sw.js`) caches it, so it then
starts and plays without a network, from the browser or installed to the home screen ("Add to Home
Screen" on iOS, "Install app" in Chrome). Games you've added stay available offline. When online it
always loads the current version from the network first, and the cache follows.

**Install** (in Settings, next to the title) installs it as an app where the browser allows that
from a page (Chrome, Edge and other Chromium browsers, on computers and Android). Safari can't be
asked by a page, so there the button says how: Share › Add to Home Screen on iPhone and iPad, or
File › Add to Dock on a Mac. It's hidden in browsers that can't install apps (Firefox) and once
the app is installed.

Service workers only run on **https** or **localhost**: serving the folder over plain http to a
phone on the LAN works, but without offline support. `sw.js` is generated: `npm start` rebuilds it,
or run `npm run sw` after changing files, and commit it with them.

## Running

```bash
npm start
```

Then open http://localhost:2602 and add a `.gb` or `.gbc` ROM (zipped is
fine). No ROMs are included.

## What it emulates

- **CPU:** the SM83, timed per memory access (every read, write and internal
  cycle advances the rest of the machine), with the HALT bug, delayed EI and
  interrupt dispatch.
- **Picture:** background, window and sprites (8x8 and 8x16, ten a line, with
  the original's X-order priority), drawn a line at a time. The original Game
  Boy's four shades can be green, Pocket or gray.
- **Game Boy Color:** both VRAM banks and tile attributes (palette, bank,
  flips, priority), 8 + 8 color palettes, banked work RAM, HDMA (general and
  per-HBlank), and double speed. Color games run in color; games made for both
  can run in original mode from Settings.
- **Sound:** both square channels (with sweep), the wave channel and noise,
  with length counters, envelopes and the frame sequencer, mixed to mono.
- **Timer, joypad and serial:** the timer counts on the real falling-edge
  logic; the link port sends with nobody on the other end.
- **Cartridges:** ROM only, MBC1, MBC2, MBC3 (with its real-time clock, kept
  in step with real time) and MBC5. Battery-backed saves are kept per game on
  the device, separately from the resume state.

## Controls

- **Touch:** the left half is a d-pad that appears where your finger lands.
  The right half is A stacked over B (A sits higher on the Game Boy too).
  Select and Start are in the top bar. Left-handed mode swaps the sides.
- **Control zones** (as in z80js): faint outlines show each control's area,
  with adjustable opacity. The zone overlap slider sets how far the zones
  reach over the picture: in portrait they sit in the band below it, starting
  that share of the picture's height up from its bottom edge, with A over B;
  in landscape A takes the top half and B the bottom, and the outlines stop
  short of the middle by that share of the picture's width.
- **Keyboard:** arrows or WASD; X or K for A; Z or J for B; Return for
  Start; Shift or Backspace for Select; P to pause.
- **Gamepad:** d-pad or left stick; the right face button is A and the bottom
  one B (Nintendo layout); Start and Back/Select.
- **Hints follow how you play.** On a phone or tablet the control zones show; on a computer, or as
  soon as you press a key or a gamepad button, they're replaced by a card listing the keys (or
  gamepad buttons), shown as a game starts and while it's paused, and the same list is in
  Settings › Controls. Touching the screen brings the zones back. **Hints for** in Settings fixes
  it to Touch, Keys or Pad instead of Auto. A gamepad's Start button also resumes a paused game.

## Testing

```bash
node tools/run-rom.mjs <rom> [frames] [out.png]   # run headless; prints serial output, saves the screen
node tools/state-check.mjs <rom ...>              # save/restore round trips, battery RAM, MBC3 clock
```

Results with the standard test ROMs (kept in `roms/test`, not committed):

| Test | Result |
|---|---|
| Blargg cpu_instrs (all 11) | Passed |
| Blargg instr_timing | Passed |
| Blargg mem_timing | Passed |
| dmg-acid2 | Matches the reference picture |
| cgb-acid2 | Matches the reference picture |
| Save state round trips | Identical for 300 frames after restore |

## Known gaps

- No boot ROM: the machine starts in the state the boot ROM leaves.
  Original Game Boy games on the Color mode don't get the Color's automatic
  colorization; they use the chosen original-screen shades.
- Lines are drawn whole at the end of each line's drawing period, so effects
  that change registers partway along a line aren't reproduced.
- Not yet supported: MBC6, MBC7, MMM01, HuC1/HuC3, the Game Boy Camera,
  Super Game Boy borders, and two-player link cable.
- Sound hasn't been checked against real games yet.

## More emulators

SM83js is one of a family of touch-first emulators, all plain JavaScript web apps with no
dependencies that install and work offline:

| App | Plays |
|---|---|
| [z80js](https://github.com/madmonk13/z80js) | Arcade games: 212 of them, on Z80, 6809, 68000 and other boards |
| [6502js](https://github.com/madmonk13/2600touch) | Atari 2600 |
| [2A03js](https://github.com/madmonk13/2A03js) | NES / Famicom |
| [P8js](https://github.com/madmonk13/P8js) | PICO-8 carts |
| [5124js](https://github.com/madmonk13/5124js) | Sega Master System and Game Gear |
| [68Kjs](https://github.com/madmonk13/68Kjs) | Sega Mega Drive / Genesis |
