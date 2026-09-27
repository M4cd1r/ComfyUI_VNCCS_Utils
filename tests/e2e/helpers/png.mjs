import { crc32, deflateSync } from "node:zlib";

// A PNG of random opaque RGB noise (incompressible), `size` x `height` pixels.
export function noisePng(size, seed, height = size) {
  const raw = Buffer.alloc((size * 4 + 1) * height);
  let state = seed >>> 0;
  for (let i = 0; i < raw.length; i += 1) {
    if (i % (size * 4 + 1) === 0) { raw[i] = 0; continue; }
    state = (state * 1664525 + 1013904223) >>> 0;
    raw[i] = (i % 4 === 0) ? 255 : state >>> 24; // opaque alpha keeps the pixels exact through canvas
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 1 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A PNG whose pixel (x, y) is `pixel(x, y)` = [r, g, b, a]. */
export function rgbaPng(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) raw.set(pixel(x, y), row + 1 + x * 4);
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const pngDataURL = (buffer) => `data:image/png;base64,${buffer.toString("base64")}`;
