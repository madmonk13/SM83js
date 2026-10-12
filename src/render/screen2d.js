// Draws the 160x144 Game Boy frame (RGBA pixels) to a canvas at native size;
// CSS scales it up with crisp pixels.

import { WIDTH, HEIGHT } from '../emu/ppu.js';

export class Screen2D {
  constructor(canvas) {
    this.canvas = canvas;
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    this.ctx = canvas.getContext('2d');
    this.image = this.ctx.createImageData(WIDTH, HEIGHT);
    this.pixels = new Uint32Array(this.image.data.buffer);
  }

  draw(frame) {
    this.pixels.set(frame);
    this.ctx.putImageData(this.image, 0, 0);
  }
}
