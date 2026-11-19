// Copies third-party browser assets into the Flask static folder so the app never
// depends on a CDN (works on closed networks and under a strict Content-Security-Policy).
const fs = require("fs");
const path = require("path");
const out = path.join(__dirname, "..", "app", "static");
const copy = (from, to) => fs.copyFileSync(path.join(__dirname, "node_modules", from), path.join(out, to));

fs.mkdirSync(path.join(out, "vendor"), { recursive: true });
fs.mkdirSync(path.join(out, "fonts"), { recursive: true });
copy("lucide/dist/umd/lucide.min.js", "vendor/lucide.min.js");
copy("canvas-confetti/dist/confetti.browser.js", "vendor/confetti.browser.js");
for (const w of [400, 500, 600, 700, 800]) {
  const f = `plus-jakarta-sans-latin-${w}-normal.woff2`;
  copy(`@fontsource/plus-jakarta-sans/files/${f}`, `fonts/${f}`);
}
console.log("vendor assets copied");
