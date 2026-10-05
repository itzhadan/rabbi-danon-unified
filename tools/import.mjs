// Bulk import WhatsApp videos into the site.
// Usage:  node tools/import.mjs "<folder with videos>"
// Reads file names like "WhatsApp Video 2025-10-03 at 08.22.56.mp4" (WhatsApp for Mac)
// or "VID-20251003-WA0005.mp4" (Android), assigns each video to its Shabbat and uploads it.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline/promises";

const SITE = process.env.SITE || "https://rabbiyosefdanon.rabbiyosefdanon.workers.dev";
const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) {
  console.log('\nשימוש: node tools/import.mjs "<תיקיית הסרטונים>"\n');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const PW = process.env.ADMIN_PASSWORD || (await rl.question("סיסמת הניהול של האתר: ")).trim();
rl.close();

const check = await fetch(SITE + "/api/check", { method: "POST", headers: { "x-admin-password": PW } });
if (!check.ok) { console.log("✗ סיסמה שגויה"); process.exit(1); }

function parseDate(name) {
  let m = /(\d{4})-(\d{2})-(\d{2}) at (\d{1,2})\.(\d{2})\.(\d{2})/.exec(name);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  m = /VID-(\d{4})(\d{2})(\d{2})-WA(\d+)/.exec(name);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], 9, 0, Math.min(59, +m[4] % 60));
  return null;
}
function shabbatOf(d) {
  const x = new Date(d);
  if (x.getDay() === 6 && x.getHours() >= 18) x.setDate(x.getDate() + 1); // after Shabbat → next week
  x.setDate(x.getDate() + ((6 - x.getDay() + 7) % 7));
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}
function fingerprint(file, size) {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(Math.min(size, 1 << 20));
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  return size + ":" + crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16);
}

const files = fs.readdirSync(dir)
  .filter((f) => /\.(mp4|mov|m4v)$/i.test(f))
  .map((f) => {
    const full = path.join(dir, f);
    const size = fs.statSync(full).size;
    return { f, full, size, date: parseDate(f) };
  });

// videos that are already on the site as fixed files
const ALREADY = new Set([17276944, 18270279, 48839599, 47931338, 15629415, 47753867, 47800273, 29876365, 29933750]);
const noDate = files.filter((x) => !x.date);
const items = files.filter((x) => x.date).sort((a, b) => a.date - b.date);

// de-duplicate identical videos (same video forwarded to several groups)
const seen = new Set();
const unique = [];
for (const it of items) {
  it.fp = fingerprint(it.full, it.size);
  if (seen.has(it.fp) || ALREADY.has(it.size)) continue;
  seen.add(it.fp);
  unique.push(it);
}

console.log(`\nנמצאו ${files.length} סרטונים · ${unique.length} ייחודיים · ${noDate.length} בלי תאריך בשם (ידולגו)\n`);

let ok = 0, dup = 0, fail = 0, big = 0;
for (const [i, it] of unique.entries()) {
  const week = shabbatOf(it.date);
  const isAnswer = it.date.getDay() === 5 && it.date.getHours() >= 11;
  const kind = isAnswer ? "answer" : "shiur";
  const tag = `[${i + 1}/${unique.length}] ${it.f} → שבת ${week} (${isAnswer ? "תשובה" : "שיעור"})`;
  if (it.size > 95 * 1048576) { console.log("⚠ " + tag + " – גדול מ-95MB, דילגתי"); big++; continue; }
  const q = new URLSearchParams({ week, kind, taken: it.date.toISOString(), fp: it.fp });
  try {
    const r = await fetch(`${SITE}/api/upload?${q}`, {
      method: "POST",
      headers: { "x-admin-password": PW, "content-type": /\.mov$/i.test(it.f) ? "video/quicktime" : "video/mp4" },
      body: fs.readFileSync(it.full),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.duplicate) { dup++; console.log("= " + tag + " – כבר באתר"); }
    else if (r.ok) { ok++; console.log("✓ " + tag); }
    else { fail++; console.log("✗ " + tag + ` – שגיאה ${r.status}`); }
  } catch (e) { fail++; console.log("✗ " + tag + " – " + e.message); }
}
console.log(`\nסיום: הועלו ${ok} · כבר היו ${dup} · נכשלו ${fail} · גדולים מדי ${big}`);
if (fail) console.log("אפשר להריץ שוב את אותה פקודה – סרטונים שכבר עלו ידולגו.");
