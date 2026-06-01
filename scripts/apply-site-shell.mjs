import fs from "fs";
import path from "path";
import { shellHeader, shellFooter } from "./tm-shell-snippet.mjs";

const root = path.resolve(import.meta.dirname, "..");

const PAGES = [
  { file: "daily-market.html", active: "./daily-market.html", tab: "" },
  { file: "briefing.html", active: "./briefing.html", tab: "" },
  { file: "realtime.html", active: "./realtime.html", tab: "realtime" },
  { file: "weekly-market.html", active: "./weekly-market.html", tab: "schedule" },
  { file: "us-market.html", active: "./us-market.html", tab: "" },
  { file: "crypto.html", active: "./crypto.html", tab: "crypto" },
  { file: "world-market.html", active: "./world-market.html", tab: "" },
  { file: "stock-analysis.html", active: "./stock-analysis.html", tab: "analysis" },
];

function patchHead(html) {
  let out = html;
  out = out.replace(/<link rel="stylesheet" href="\.\/site-nav\.css" \/>\s*/g, "");
  if (!out.includes("site-shell.css")) {
    out = out.replace(
      /<link rel="stylesheet" href="\.\/theme\.css" \/>/,
      '<link rel="stylesheet" href="./theme.css" />\n    <link rel="stylesheet" href="./site-shell.css" />'
    );
  }
  out = out.replace(/<script src="\.\/site-nav\.js" defer><\/script>\s*/g, "");
  if (!out.includes("site-shell.js")) {
    out = out.replace(
      /(<script src="\.\/theme\.js"><\/script>)/,
      '$1\n    <script src="./site-shell.js" defer></script>'
    );
  }
  return out;
}

function patchBody(html, active, tab) {
  if (html.includes("class=\"home-footer\"")) return html;

  const tabAttr = tab ? ` data-tm-tab="${tab}"` : "";
  let out = html.replace(/<body[^>]*>/i, `<body class="page-tm-v2"${tabAttr}>`);
  out = out.replace(/<header class="tm-site-header">[\s\S]*?<\/header>\s*/i, "");

  const pageOpen = out.match(/<div[^>]*class="[^"]*\bpage\b[^"]*"[^>]*>/i);
  if (!pageOpen) {
    console.warn("  no .page div");
    return null;
  }

  const wrapStart = `<div class="tm-wrap">\n${shellHeader(active)}\n    `;
  out = out.replace(/<div[^>]*class="[^"]*\bpage\b[^"]*"[^>]*>/i, (m) => `${wrapStart}${m}`);

  const closeRe = /\n(\s*)<\/div>\s*\n\s*<script/i;
  if (!closeRe.test(out)) {
    console.warn("  no close before script");
    return null;
  }
  out = out.replace(closeRe, `\n$1</div>\n      </main>\n${shellFooter}\n\n    <script`);

  return out;
}

for (const { file, active, tab } of PAGES) {
  const fp = path.join(root, file);
  let html = fs.readFileSync(fp, "utf8");
  html = patchHead(html);
  const patched = patchBody(html, active, tab);
  if (!patched) {
    console.error("FAIL", file);
    process.exitCode = 1;
    continue;
  }
  fs.writeFileSync(fp, patched, "utf8");
  console.log("OK", file);
}
