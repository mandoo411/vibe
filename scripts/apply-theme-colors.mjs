import fs from "fs";
import path from "path";

import { fileURLToPath } from "url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files = [];
for (const name of fs.readdirSync(root)) {
  if (name.endsWith(".html") && !name.startsWith("tmp")) files.push(name);
}
for (const name of ["weekly-market.css", "site-nav.css", "hub.css", "daily-market.css"]) {
  if (fs.existsSync(path.join(root, name))) files.push(name);
}

const replacements = [
  [/#f87171/gi, "var(--up-color)"],
  [/#60a5fa/gi, "var(--down-color)"],
  [/#ef5350/gi, "var(--down-color)"],
  [/#26a69a/gi, "var(--accent)"],
  [/#2962ff/gi, "var(--accent-secondary)"],
  [/#d4af37/gi, "var(--accent)"],
  [/#c9a84c/gi, "var(--accent)"],
  [/#C9A84C/g, "var(--accent)"],
  [/#f0c75a/gi, "var(--accent-bright)"],
  [/#0d0b08/gi, "var(--bg-primary)"],
  [/#0f0d0a/gi, "var(--bg-secondary)"],
  [/#181510/gi, "var(--bg-secondary)"],
  [/#12100c/gi, "var(--bg-tertiary)"],
  [/#1a1714/gi, "var(--bg-tertiary)"],
  [/#2a2418/gi, "var(--bg-tertiary)"],
  [/#1a160f/gi, "var(--bg-secondary)"],
  [/#2f2920/gi, "var(--border)"],
  [/#4a4030/gi, "var(--border-strong)"],
  [/#f1e6cc/gi, "var(--text-primary)"],
  [/#b8a878/gi, "var(--text-secondary)"],
  [/#8b7d5a/gi, "var(--text-secondary)"],
  [/#c9a84c/gi, "var(--accent)"],
  [/conic-gradient\(#f87171/gi, "conic-gradient(var(--up-color)"],
  [/33%, #d4af37 33%/gi, "33%, var(--accent) 33%"],
  [/66%, #60a5fa 66%/gi, "66%, var(--down-color) 66%"],
  [/linear-gradient\(180deg, #f0d78c 0%, #d4af37 42%, #a67c1a 100%\)/gi, "linear-gradient(180deg, var(--accent-bright) 0%, var(--accent) 42%, var(--accent-secondary) 100%)"],
  [/linear-gradient\(145deg, #c9a84c 0%, #8b6914 100%\)/gi, "linear-gradient(145deg, var(--accent) 0%, var(--accent-secondary) 100%)"],
  [/border: 1px solid #c9a84c/gi, "border: 1px solid var(--accent)"],
  [/rgba\(12,\s*10,\s*8/gi, "color-mix(in srgb, var(--bg-primary)"],
  [/rgba\(212,\s*175,\s*55,\s*0\.62\)/gi, "var(--accent-ring)"],
  [/rgba\(212,\s*175,\s*55,\s*0\.5[0-9]?\)/gi, "var(--accent-ring)"],
  [/rgba\(212,\s*175,\s*55,\s*0\.4[0-9]?\)/gi, "var(--accent-highlight)"],
  [/rgba\(212,\s*175,\s*55,\s*0\.3[0-9]?\)/gi, "var(--accent-highlight)"],
  [/rgba\(212,\s*175,\s*55,\s*0\.2[0-9]?\)/gi, "var(--accent-highlight)"],
  [/rgba\(212,\s*175,\s*55,\s*0\.1[0-9]?\)/gi, "var(--accent-dim)"],
  [/rgba\(212,\s*175,\s*55,\s*0\.0[0-9]\)/gi, "var(--accent-dim)"],
  [/rgba\(212,\s*175,\s*55,\s*0\)/gi, "var(--accent-dim)"],
  [/inset 0 -1px 0 0 #c9a84c/gi, "inset 0 -1px 0 0 var(--accent)"],
  [/inset 0 -1px 0 0 #d4af37/gi, "inset 0 -1px 0 0 var(--accent)"],
];

const headSnippet = `    <script src="./theme.js"></script>
    <link rel="stylesheet" href="./theme.css" />
`;

for (const file of files) {
  const fp = path.join(root, file);
  let text = fs.readFileSync(fp, "utf8");
  let changed = false;

  if (file.endsWith(".html") && !text.includes("./theme.js")) {
    text = text.replace(
      /(\s*<link rel="stylesheet" href="\.\/weekly-market\.css" \/>)/,
      `${headSnippet}$1`
    );
    text = text.replace(
      /content="#0d0b08"/gi,
      'content="#131722"'
    );
    changed = true;
  }

  for (const [re, rep] of replacements) {
    const next = text.replace(re, rep);
    if (next !== text) {
      text = next;
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(fp, text);
    console.log("updated", file);
  }
}
