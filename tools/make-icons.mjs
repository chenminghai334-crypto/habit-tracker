/* tools/make-icons.mjs — 用 Node 内置 zlib 生成 PNG 图标（无需任何依赖）
 * 用法：node tools/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'icons');

/* ---------- PNG 编码 ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 绘制 ---------- */

const clamp01 = (v) => Math.min(1, Math.max(0, v));

function sdRoundRect(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp01(((px - x1) * dx + (py - y1) * dy) / len2);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** 圆角蓝底 + 白色对勾；radius=0 时是纯方形（给 iOS 用） */
function drawIcon(size, { radius = 112, scaleAll = 1 } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const k = (size / 512) * scaleAll;
  const r = radius * k;
  const strokeHalf = (52 * k) / 2;
  const p1 = [150 * k, 268 * k];
  const p2 = [226 * k, 344 * k];
  const p3 = [366 * k, 176 * k];
  const center = size / 2;
  const from = [0x4f, 0x8c, 0xff];
  const to = [0x2f, 0x6d, 0xf6];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const bgAlpha = clamp01(0.5 - sdRoundRect(px, py, center, center, size / 2, size / 2, r));
      const t = (px + py) / (2 * size);
      let red = from[0] + (to[0] - from[0]) * t;
      let green = from[1] + (to[1] - from[1]) * t;
      let blue = from[2] + (to[2] - from[2]) * t;

      const d = Math.min(
        distToSegment(px, py, p1[0], p1[1], p2[0], p2[1]),
        distToSegment(px, py, p2[0], p2[1], p3[0], p3[1]),
      );
      const mark = clamp01(0.5 + (strokeHalf - d));
      red += (255 - red) * mark;
      green += (255 - green) * mark;
      blue += (255 - blue) * mark;

      const i = (y * size + x) * 4;
      buf[i] = Math.round(red);
      buf[i + 1] = Math.round(green);
      buf[i + 2] = Math.round(blue);
      buf[i + 3] = Math.round(bgAlpha * 255);
    }
  }
  return buf;
}

/* ---------- 输出 ---------- */

mkdirSync(OUT_DIR, { recursive: true });

const outputs = [
  ['icon-192.png', 192, { radius: 112 }],
  ['icon-512.png', 512, { radius: 112 }],
  ['apple-touch-icon.png', 180, { radius: 0 }],
];

for (const [name, size, options] of outputs) {
  const file = join(OUT_DIR, name);
  writeFileSync(file, encodePNG(size, drawIcon(size, options)));
  console.log(`生成 ${name} (${size}x${size})`);
}

console.log(`图标已输出到 ${OUT_DIR}`);
