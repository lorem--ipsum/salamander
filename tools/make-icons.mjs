// Generates the app icons as PNGs with no dependencies: rasterise by hand, compress
// with Node's built-in zlib. Run once, or after changing the design:
//
//   node tools/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [96, 180, 192, 512];

const BG = [0x0a, 0x0c, 0x10];
const ACCENT = [0xff, 0x8a, 0x3d];

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  // rows are prefixed with filter type 0; the image is tiny, so no filtering is needed
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const src = y * size * 4;
    const dst = y * (size * 4 + 1);
    raw[dst] = 0;
    rgba.copy(raw, dst + 1, src, src + size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const smoothstep = (edge, width, x) => {
  const t = Math.min(1, Math.max(0, (edge + width - x) / (2 * width)));
  return t * t * (3 - 2 * t);
};

/** Sound radiating outward: a solid core with three concentric rings. */
function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const aa = size / 96; // keep edges equally soft at every export size
  const rings = [
    { r: 0.2, alpha: 0.95 },
    { r: 0.305, alpha: 0.62 },
    { r: 0.41, alpha: 0.34 },
  ];
  const core = 0.088 * size;
  const thickness = 0.031 * size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      const dist = Math.hypot(dx, dy);

      let r = BG[0];
      let g = BG[1];
      let b = BG[2];

      // Warm glow so the icon does not read as a flat black square.
      const falloff = dist / (0.34 * size);
      const glow = 0.16 * Math.exp(-(falloff * falloff));
      const blend = (base, over, a) => base + (over - base) * a;
      r = blend(r, ACCENT[0], glow);
      g = blend(g, ACCENT[1], glow);
      b = blend(b, ACCENT[2], glow);

      let ink = smoothstep(core, aa, dist);
      for (const ring of rings) {
        const rr = ring.r * size;
        const band =
          smoothstep(rr + thickness / 2, aa, dist) * (1 - smoothstep(rr - thickness / 2, aa, dist));
        ink = Math.max(ink, band * ring.alpha);
      }

      r = blend(r, ACCENT[0], ink);
      g = blend(g, ACCENT[1], ink);
      b = blend(b, ACCENT[2], ink);

      const i = (y * size + x) * 4;
      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

for (const size of SIZES) {
  const file = join(OUT, `icon-${size}.png`);
  writeFileSync(file, encodePng(size, draw(size)));
  console.log(`wrote icon-${size}.png`);
}
