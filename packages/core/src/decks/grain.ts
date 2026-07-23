import { deflateSync } from 'node:zlib';

/**
 * Paper-grain tile generator for `backgroundTexture` slides.
 * Spec: docs/architecture/features/deck-generation.md → "Texture".
 * [COMP:decks/grain]
 *
 * This lives in core, not in the shared layout module, because encoding a PNG
 * needs `node:zlib` and `Buffer` — and app-web bundles `@use-brian/shared` for
 * the browser. It is the reason texture is a slide-level surface flag rather
 * than a layout primitive: each renderer realises it with what it has.
 *
 * OOXML has no noise fill, so the grain has to be a real raster. It is
 * deliberately small and low-amplitude: 320x180 at +/-3/255 reads as paper at
 * slide size while staying ~28KB. That cost is per slide, not per deck —
 * pptxgenjs dedupes media by file path and these are data URIs, so every
 * placement re-embeds the whole tile: measured, a 50-slide deck grows from
 * ~435KB to ~1.85MB. That is why texture is opt-in.
 */

const GRAIN_W = 320;
const GRAIN_H = 180;
const GRAIN_AMPLITUDE = 3;

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

let CRC_TABLE: Uint32Array | undefined;
function crc32(buf: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A grain tile over `hex`, as a data URI. Deterministic: the same surface
 * colour always yields byte-identical output, so a rebuilt deck does not
 * churn (and callers can cache by colour).
 */
export function grainDataUri(hex: string): string {
  const base = hex.replace(/^#/, '').toUpperCase();
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(base.slice(i, i + 2), 16));
  // Fixed seed — see the determinism note above.
  let seed = 0x9e3779b9;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  const raw = Buffer.alloc((GRAIN_W * 3 + 1) * GRAIN_H);
  let p = 0;
  for (let y = 0; y < GRAIN_H; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < GRAIN_W; x++) {
      const jitter = Math.round((rand() - 0.5) * 2 * GRAIN_AMPLITUDE);
      raw[p++] = Math.max(0, Math.min(255, r + jitter));
      raw[p++] = Math.max(0, Math.min(255, g + jitter));
      raw[p++] = Math.max(0, Math.min(255, b + jitter));
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(GRAIN_W, 0);
  ihdr.writeUInt32BE(GRAIN_H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}
