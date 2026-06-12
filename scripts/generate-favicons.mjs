#!/usr/bin/env node
/** favicon-master.svg → PNG/ICO (모바일·파비콘) */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const master = path.join(root, "assets", "favicon-master.svg");
const svg32 = path.join(root, "assets", "favicon.svg");

const outputs = [
  { size: 32, file: "assets/icon-t-32.png" },
  { size: 180, file: "assets/icon-t-180.png" },
  { size: 192, file: "assets/icon-t-192.png" },
  { size: 512, file: "assets/icon-t-512.png" },
  /* iOS·Safari 루트 자동 탐색 경로 (assets만 갱신하면 모바일에 구 아이콘 남음) */
  { size: 180, file: "icon-t-180.png" },
  { size: 180, file: "apple-touch-icon.png" },
  { size: 180, file: "apple-touch-icon-precomposed.png" },
  { size: 180, file: "assets/apple-touch-icon.png" },
];

const input = await fs.readFile(master);
const written = new Set();
for (const { size, file } of outputs) {
  const out = path.join(root, file);
  const key = `${file}@${size}`;
  if (written.has(key)) continue;
  written.add(key);
  await sharp(input, { density: 320 }).resize(size, size).png().toFile(out);
  console.log(`Wrote ${file} (${size}px)`);
}

await sharp(input, { density: 320 }).resize(32, 32).png().toFile(path.join(root, "favicon.ico"));
await sharp(input, { density: 320 }).resize(32, 32).png().toFile(path.join(root, "assets", "favicon.ico"));
console.log("Wrote favicon.ico + assets/favicon.ico");

await fs.copyFile(svg32, path.join(root, "assets", "favicon.svg"));
console.log("OK favicon assets");
