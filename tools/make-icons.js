#!/usr/bin/env node
// アイコン生成（ランドセルのオリジナル図案）。外部ライブラリなしで PNG を書き出す。
//   node tools/make-icons.js
// → docs/icons/apple-touch-icon.png (180), icon-192.png, icon-512.png
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'docs', 'icons');

// 角丸四角の符号付き距離（中心 c、半分のサイズ h、角丸 r）
function sdRoundRect(x, y, cx, cy, hx, hy, r) {
  const qx = Math.abs(x - cx) - (hx - r);
  const qy = Math.abs(y - cy) - (hy - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdEllipse(x, y, cx, cy, rx, ry) {
  return (Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * Math.min(rx, ry);
}

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

// 上に描くものほどあと。[色, 判定関数, 不透明度]
const LAYERS = [
  [hex('#ffe9a8'), () => true, 1], // 背景（全面）
  [hex('#000000'), (x, y) => sdEllipse(x, y, 0.5, 0.9, 0.27, 0.035) < 0, 0.14], // 影
  [hex('#8f2620'), (x, y) => { // 持ち手（輪）
    const o = sdRoundRect(x, y, 0.5, 0.25, 0.1, 0.07, 0.05);
    const i = sdRoundRect(x, y, 0.5, 0.25, 0.1 - 0.028, 0.07 - 0.028, 0.025);
    return o < 0 && i > 0;
  }, 1],
  [hex('#c8372d'), (x, y) => sdRoundRect(x, y, 0.5, 0.58, 0.28, 0.30, 0.09) < 0, 1], // 本体
  [hex('#a82c24'), (x, y) => sdRoundRect(x, y, 0.5, 0.47, 0.28, 0.2, 0.09) < 0, 1], // かぶせ（ふた）
  [hex('#e0574c'), (x, y) => sdRoundRect(x, y, 0.5, 0.42, 0.235, 0.145, 0.06) < 0, 1], // かぶせの面
  [hex('#f4c430'), (x, y) => sdRoundRect(x, y, 0.5, 0.605, 0.065, 0.08, 0.022) < 0, 1], // 留め金
  [hex('#a82c24'), (x, y) => sdRoundRect(x, y, 0.5, 0.612, 0.028, 0.034, 0.012) < 0, 1], // 留め金の穴
  [hex('#a82c24'), (x, y) => sdRoundRect(x, y, 0.19, 0.7, 0.04, 0.105, 0.025) < 0 || sdRoundRect(x, y, 0.81, 0.7, 0.04, 0.105, 0.025) < 0, 1], // 両脇のポケット
];

function render(size) {
  const SS = 3; // 3x3 のスーパーサンプリング
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0;
      for (let sj = 0; sj < SS; sj++) {
        for (let si = 0; si < SS; si++) {
          const x = (i + (si + 0.5) / SS) / size;
          const y = (j + (sj + 0.5) / SS) / size;
          let c = [0, 0, 0];
          for (const [col, hit, a] of LAYERS) {
            if (hit(x, y)) c = c.map((v, k) => v * (1 - a) + col[k] * a);
          }
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const n = SS * SS, o = (j * size + i) * 4;
      px[o] = Math.round(r / n); px[o + 1] = Math.round(g / n); px[o + 2] = Math.round(b / n); px[o + 3] = 255;
    }
  }
  return px;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (const v of buf) c = t[(c ^ v) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // フィルタなし
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  fs.writeFileSync(path.join(OUT, name), png(size, render(size)));
  console.log('wrote', name, size + 'px');
}
