#!/usr/bin/env node
/** 헤더 로고 박스(TM AI) → 인스타 프로필 PNG/JPG (1080×1080) */
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "assets", "instagram-profile.svg");
const size = 1080;

const outputs = [
  { file: "assets/instagram-profile.png", format: "png" },
  { file: "assets/instagram-profile.jpg", format: "jpeg", quality: 92 },
];

for (const { file, format, quality } of outputs) {
  const out = path.join(root, file);
  let pipeline = sharp(src, { density: 300 }).resize(size, size);
  if (format === "jpeg") {
    pipeline = pipeline.jpeg({ quality, mozjpeg: true });
  } else {
    pipeline = pipeline.png();
  }
  await pipeline.toFile(out);
  console.log(`Wrote ${file} (${size}px)`);
}

console.log("OK instagram profile assets");
