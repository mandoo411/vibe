import fs from "fs";
import path from "path";

const files = [
  "daily-market.html",
  "briefing.html",
  "realtime.html",
  "weekly-market.html",
  "us-market.html",
  "crypto.html",
  "world-market.html",
  "stock-analysis.html",
];

const root = path.resolve(import.meta.dirname, "..");

for (const file of files) {
  let html = fs.readFileSync(path.join(root, file), "utf8");
  html = html.replace(/<div class="tm-wrap">\s*<div class="tm-wrap">/g, '<div class="tm-wrap">');
  html = html.replace(/<\/main>\s*<\/main>/g, "</main>");
  html = html.replace(
    /(\s*)<\/div>\s*<\/main>\s*<footer class="home-footer">/,
    "\n    </div>\n      </main>\n\n      <footer class=\"home-footer\">"
  );
  fs.writeFileSync(path.join(root, file), html, "utf8");
  console.log("fixed", file);
}
