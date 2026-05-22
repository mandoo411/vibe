#!/usr/bin/env node
/** krIPO만 재수집해 weekly-schedule.json 갱신 (Finnhub/Claude 불필요) */
import fs from "node:fs/promises";
import path from "node:path";
import { fetchKRIPO, seoulYmd, addDaysYmd } from "./weekly-schedule.mjs";

const OUTPUT = path.resolve("data/weekly-schedule.json");

function seoulStamp() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date())
    .replace(",", "")
    .concat(" KST");
}

async function main() {
  const today = seoulYmd();
  const to = addDaysYmd(today, 45);
  const krIPO = await fetchKRIPO(today, to);

  let data = { meta: {}, krIPO: [] };
  try {
    data = JSON.parse(await fs.readFile(OUTPUT, "utf8"));
  } catch {
    /* fresh */
  }
  data.krIPO = krIPO;
  data.meta = {
    ...(data.meta || {}),
    lastUpdatedKst: seoulStamp(),
    from: data.meta?.from || today,
    to,
    ipoSource: "38-detail-listing-date",
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`Wrote ${OUTPUT} — krIPO ${krIPO.length} rows`);
  for (const row of krIPO) {
    console.log(`  ${row.date} ${row.market} ${row.name} ${row.offeringPrice ?? ""}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
