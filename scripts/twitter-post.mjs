/**
 * X(트위터) 자동 트윗 — 메인 스크립트
 * 흐름: data/daily-market.json 스냅샷 로딩 → 변경 여부 확인(중복 트윗 방지)
 *       → 280자 트윗 포맷 → OAuth1.0a 서명 → v2 트윗 발행 → 마지막 스냅샷 해시 저장
 *
 * market-data-sync.yml이 30분마다 data/daily-market.json을 갱신하므로 이 스크립트도
 * 같은 주기로 돌리되, 장이 닫혀 데이터가 그대로면 트윗을 건너뛴다(스팸 방지).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { loadLatestSnapshot } from "./promo-market-copy.mjs";
import { getOAuth1Header } from "./promo-oauth1.mjs";

const TWEET_URL = "https://api.twitter.com/2/tweets";
const LAST_HASH_FILE = "./data/.last-tweet-hash.json";

const arrow = (pct) => (pct > 0 ? "▲" : pct < 0 ? "▼" : "-");

function snapshotHash(snapshot) {
  const key = JSON.stringify({
    kospi: snapshot.indexes?.kospi,
    kosdaq: snapshot.indexes?.kosdaq,
    top1: snapshot.topGainers?.[0]?.name,
    top1pct: snapshot.topGainers?.[0]?.change,
  });
  return createHash("sha1").update(key).digest("hex");
}

function alreadyTweeted(hash) {
  if (!existsSync(LAST_HASH_FILE)) return false;
  try {
    return JSON.parse(readFileSync(LAST_HASH_FILE, "utf8")).hash === hash;
  } catch {
    return false;
  }
}

function saveHash(hash) {
  writeFileSync(LAST_HASH_FILE, JSON.stringify({ hash, at: new Date().toISOString() }, null, 2));
}

function nowKST() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function formatTweet(snapshot) {
  const { kospi, kosdaq } = snapshot.indexes || {};
  const top = (snapshot.topGainers || [])[0];
  const lines = [
    `📊 [${nowKST()} 시황]`,
    kospi ? `코스피 ${kospi.close.toLocaleString()} ${arrow(kospi.changePercent)}${Math.abs(kospi.changePercent).toFixed(2)}%` : "",
    kosdaq ? `코스닥 ${kosdaq.close.toLocaleString()} ${arrow(kosdaq.changePercent)}${Math.abs(kosdaq.changePercent).toFixed(2)}%` : "",
    "",
    top ? `🔥 지금 핫한 종목\n${top.name} ${arrow(top.change)}${Math.abs(top.change).toFixed(2)}%${top.reason ? ` — ${top.reason}` : ""}` : "",
    "",
    "전체 분석 👉 totalmoney.kr",
    "#코스피 #주식 #오늘의특징주",
  ].filter(Boolean);
  let tweet = lines.join("\n");
  if (tweet.length > 280) tweet = tweet.slice(0, 277) + "...";
  return tweet;
}

async function postTweet(text) {
  const authHeader = getOAuth1Header("POST", TWEET_URL, {});
  const res = await fetch(TWEET_URL, {
    method: "POST",
    headers: { Authorization: authHeader, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`트윗 발행 실패: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  const snapshot = await loadLatestSnapshot();
  const hash = snapshotHash(snapshot);

  if (alreadyTweeted(hash)) {
    console.log("데이터 변경 없음 — 중복 트윗 방지를 위해 건너뜀");
    return;
  }

  const tweet = formatTweet(snapshot);
  console.log("생성된 트윗:\n" + tweet);

  const result = await postTweet(tweet);
  saveHash(hash);
  console.log("✅ 발행 완료:", result?.data?.id);
}

main().catch((err) => {
  console.error("❌ 실패:", err.message);
  process.exit(1);
});
