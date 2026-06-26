# AGENTS.md

## Cursor Cloud specific instructions

This repo is a static multi-page web app ("TotalMoney AI", a Korean financial-markets
dashboard) deployed on Vercel. The root `*.html` pages are standalone and share a common
nav/shell. `api/` holds Vercel serverless functions, `scripts/` is a Node ESM data
pipeline (run by GitHub Actions cron), and `data/*.json` are committed datasets the
frontend reads. Note: `package.json`/`README.md` still describe a "simple-calculator" —
that is stale boilerplate, not the real app.

### Running the app (local dev)
- Static dev server: `npm run preview` (serves the repo on `http://localhost:3456` via
  `npx serve`). This is the practical local dev command in this environment.
- `npm run dev` runs `vercel dev`, which requires Vercel login/project linking and
  external API keys — it is not usable in a fresh cloud VM without those, so prefer
  `npm run preview`.
- Key detail: `assets/data-url.js` (`tmFetchJson`) detects `localhost`/`127.0.0.1` and
  loads committed `./data/*.json` directly (skipping `/api/repo-data`). So committed-data
  pages render fully on the static server with **no secrets**:
  `weekly-market.html`, `briefing.html`, `market.html`, and the home briefing/schedule
  widgets. `daily-market.html` filters by date and shows a "준비하고 있어요" placeholder
  when the committed JSON has no entry for today's date (expected, not a bug).
- Pages backed by live `/api/*` functions need `vercel dev` + third-party API keys and
  will show empty sections / "불러오지 못했습니다" errors on the static server:
  `realtime.html`, `crypto.html`, `us-market.html`, `world-market.html`,
  `stock-analysis.html`, plus the home ticker/KR/crypto widgets.

### Secrets (only needed for live `/api/*` and `scripts/`)
None are required to run/view the static site. For full live data you would need, per
feature: KIS (`KIS_APP_KEY`, `KIS_APP_SECRET`, `KIS_ACCESS_TOKEN`) for KR/realtime/quotes,
`CMC_API_KEY` for crypto, `FMP_API_KEY` for world market, `FINNHUB_API_KEY` for tickers,
`ANTHROPIC_API_KEY` for AI analysis. `scripts/` additionally use Telegram
(`TELEGRAM_SESSION`/`API_ID`/`API_HASH`) and `DART_API_KEY`, and are loaded via
`node --env-file=.env`. `GITHUB_TOKEN` is irrelevant locally (the data loader bypasses
`/api/repo-data` on localhost).

### Lint / test / build
There is no lint config, no test framework, and no build step (static site). `package.json`
has no `test`/`lint`/`build` scripts; data-sync `sync:*`/`cache:*` scripts require the
secrets above. Do not assume CI-style lint/test commands exist here.
