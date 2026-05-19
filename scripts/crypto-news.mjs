#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { collectTelegramMessages, telegramRowsForData } from "./telegram-channel-news.mjs";

const OUTPUT_PATH = path.resolve(process.env.CRYPTO_NEWS_PATH || "data/crypto-news.json");

async function main() {
  const messages = await collectTelegramMessages({
    hours: 3,
    channelLimit: 60,
    keywords: ["크립토", "코인", "비트", "bitcoin", "crypto", "이더", "리플", "알트", "defi", "web3"],
  });
  const rows = telegramRowsForData(
    messages.filter((message) => message.tag === "crypto" || /크립토|코인|비트|bitcoin|crypto|이더|리플|알트|defi|web3/i.test(message.text)),
    20
  );
  const data = {
    updatedAt: new Date().toISOString(),
    news: rows,
  };
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`Wrote ${OUTPUT_PATH} (${rows.length} rows)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
