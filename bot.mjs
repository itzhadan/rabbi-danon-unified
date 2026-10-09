process.env.TZ = "Asia/Jerusalem";
// Rabbi Yosef Danon – WhatsApp → website, fully automatic.
//
// Runs as a "linked device" of the rabbi's WhatsApp. Whenever something is
// posted in one of the lesson groups it is sent to the site:
//   • the rabbi's videos / voice recordings  → the lesson of that Shabbat
//   • members' answers (text)                → the discussion of that Shabbat
//   • members' voice notes                   → voice comments
//
// Start:  npm start      (first time: scan the QR code with the rabbi's phone)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import pino from "pino";
import qrcode from "qrcode-terminal";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  Browsers,
} from "baileys";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CFG_FILE = path.join(DIR, "config.json");
const SEEN_FILE = path.join(DIR, "seen.json");
const AUTH_DIR = path.join(DIR, "auth");

// ---------- config ----------
if (!fs.existsSync(CFG_FILE)) {
  console.log("חסר קובץ config.json – הריצו קודם:  bash setup.sh");
  process.exit(1);
}
const CFG = JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
const SITE = (CFG.site || "https://rabbiyosefdanon.rabbiyosefdanon.workers.dev").replace(/\/$/, "");
const PW = CFG.password;
// which groups to follow: a word that appears in the group's name → label on the site
const GROUPS = CFG.groups || [
  { match: "נשים", label: "קבוצת הנשים" },
  { match: "גברים", label: "קבוצת הגברים" },
  { match: "המלכה", label: "לכבוד שבת המלכה" },
  { match: "שעור", label: "קבוצת השיעור" },
  { match: "שיעור", label: "קבוצת השיעור" },
];
const MAX_AGE_DAYS = CFG.maxAgeDays ?? 6; // ignore anything older than this

const log = (...a) => console.log(new Date().toLocaleString("he-IL"), "|", ...a);

// ---------- remember what was already handled ----------
let SEEN = new Set();
try { SEEN = new Set(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"))); } catch {}
let seenDirty = false;
const markSeen = (id) => { SEEN.add(id); seenDirty = true; };
setInterval(() => {
  if (!seenDirty) return;
  seenDirty = false;
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...SEEN].slice(-5000)));
}, 5000);

// ---------- helpers shared with the site's admin page ----------
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function weekOf(d) {
  const x = new Date(d);
  if (x.getDay() === 6 && x.getHours() >= 18) x.setDate(x.getDate() + 1); // after Shabbat → next week
  x.setDate(x.getDate() + ((6 - x.getDay() + 7) % 7));
  return iso(x);
}
const isAnswerTime = (d) => d.getDay() === 5 && d.getHours() >= 11; // Friday from 11:00
const fnv = (str) => {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(str, "utf8")) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
};
const fingerprint = (buf) =>
  buf.length + ":" + crypto.createHash("sha1").update(buf.subarray(0, 1 << 20)).digest("hex").slice(0, 16);

const KW = /לדעתי|לפי דעתי|בעיני|צריך ל|צריכה ל|לא צריך|חייב|פטור|מותר|אסור|יצא ידי|לא יצא|לשלם|ישלם|לפצות|להחזיר|לכאורה|הדין|אחריות|מגיע לו|מגיע לה/;
const SKIP = /קוד האבטחה|סגולת|יום הולדתי|שומעת אותך|מזל טוב|תהנו|בלי נדר|איך מגיעים|לא מגיעים|שיעור היום|לתפילה|תהילים|לרפואת|רפואה שלמה|להעביר ל|\*.*\*/;
function cleanText(t) {
  t = t.replace(/[‎‏]/g, "");
  t = t.replace(/[\u{1F300}-\u{1FAFF}☀-➿️‍]+/gu, "").replace(/\s+/g, " ").trim();
  t = t.replace(/^(שבת שלום( ומבורך)?( ו)?תודה( רבה)?[.,!]? ?|בוקר טוב( לכולם)?[.,!]? ?|ערב טוב( לכולם)?[.,!]? ?|בקר טוב ?|צהריים טובים ?)/, "");
  t = t.replace(/^(תודה רבה,? )?(שבת שלום|חג שמח)[^.!]*[.!] ?/, "");
  const m = /[\s.,]*((חג שמח|ושבת|שבת) (שלום|מבורך|שמח)|תודה רבה)[^.]{0,40}$/.exec(t);
  if (m && m.index > 40) t = t.slice(0, m.index);
  t = t.replace(/^[\s,.]+|[\s,.]+$/g, "");
  if (t.length > 600) t = t.slice(0, 590).replace(/\s\S*$/, "") + "…";
  return t;
}

// ---------- talking to the site ----------
async function api(pathAndQuery, { body, type } = {}) {
  const r = await fetch(SITE + pathAndQuery, {
    method: "POST",
    headers: { "x-admin-password": PW, ...(type ? { "content-type": type } : {}) },
    body,
  });
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error(`${pathAndQuery.split("?")[0]} → ${r.status} ${j.error || ""}`);
  return j;
}

function makePoster(videoBuf) {
  // needs ffmpeg; if it isn't installed we simply skip the thumbnail
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), `rabbi-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(tmp + ".mp4", videoBuf);
    execFile(
      "ffmpeg",
      ["-v", "error", "-y", "-ss", "1", "-i", tmp + ".mp4", "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "5", tmp + ".jpg"],
      { timeout: 30000 },
      (err) => {
        let jpg = null;
        try { if (!err) jpg = fs.readFileSync(tmp + ".jpg"); } catch {}
        for (const f of [tmp + ".mp4", tmp + ".jpg"]) { try { fs.unlinkSync(f); } catch {} }
        resolve(jpg);
      },
    );
  });
}

// ---------- WhatsApp ----------
const groupNames = new Map();
async function groupLabel(sock, jid) {
  if (!groupNames.has(jid)) {
    try { groupNames.set(jid, (await sock.groupMetadata(jid)).subject || ""); }
    catch { groupNames.set(jid, ""); }
  }
  const name = groupNames.get(jid);
  const g = GROUPS.find((x) => name.includes(x.match));
  return g ? g.label : null;
}

function unwrap(message) {
  // peel "ephemeral" / "view once" / "edited" wrappers
  let m = message;
  for (let i = 0; i < 4 && m; i++) {
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m || {};
}

export async function handle(sock, msg) {
  const jid = msg.key?.remoteJid || "";
  if (!jid.endsWith("@g.us")) return;
  if (!msg.message) {
    // a message this device could not decrypt (shows as "waiting for this message")
    if (msg.messageStubType === 2 || msg.messageStubParameters?.length) log(`… הודעה בקבוצה שעדיין לא נפתחה (${groupNames.get(jid) || jid}) – וואטסאפ ישלח אותה שוב`);
    return;
  }
  const id = `${jid}|${msg.key.id}`;
  if (SEEN.has(id)) return;

  const when = new Date(Number(msg.messageTimestamp || 0) * 1000);
  if (!msg.messageTimestamp || Date.now() - when.getTime() > MAX_AGE_DAYS * 864e5) return;

  const label = await groupLabel(sock, jid);
  const m = unwrap(msg.message);
  const fromRabbi = !!msg.key.fromMe; // the bot is linked to the rabbi's own WhatsApp
  const kindOf = m.videoMessage ? "סרטון" : m.audioMessage ? "הקלטה" : m.imageMessage ? "תמונה" : (m.conversation || m.extendedTextMessage) ? "טקסט" : Object.keys(m)[0];
  if (kindOf !== "טקסט" || fromRabbi) log(`📩 ${kindOf} בקבוצה "${groupNames.get(jid)}" · ${fromRabbi ? "מהרב" : "מ-" + (msg.pushName || "חבר")}${label ? "" : " · (לא קבוצת שיעור – מדלג)"}`);
  if (!label) return; // not one of the lesson groups
  const week = weekOf(when);
  const taken = when.toISOString();
  const name = fromRabbi ? "" : (msg.pushName || "").trim();
  const download = () =>
    msg._testBuf ? Promise.resolve(msg._testBuf) : // (used only by the self-test)
    downloadMediaMessage(msg, "buffer", {}, { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage });

  try {
    // ----- the rabbi's video -----
    if (fromRabbi && m.videoMessage) {
      const buf = await download();
      if (buf.length > 95 * 1048576) { log(`⚠ סרטון גדול מדי (${(buf.length / 1048576).toFixed(0)}MB) – דולג`); markSeen(id); return; }
      const secs = Number(m.videoMessage.seconds || 0);
      const kind = secs && secs < 20 ? "cvideo" : isAnswerTime(when) ? "answer" : "shiur";
      const q = new URLSearchParams({ week, kind, taken, fp: fingerprint(buf) });
      const r = await api("/api/upload?" + q, { body: buf, type: "video/mp4" });
      if (r.duplicate) log(`= סרטון כבר באתר (${label}, שבת ${week})`);
      else {
        log(`✓ סרטון הועלה: שבת ${week} · ${kind === "answer" ? "תשובת הרב" : kind === "cvideo" ? "סרטון קצר" : "שיעור"} · ${(buf.length / 1048576).toFixed(1)}MB`);
        const jpg = await makePoster(buf);
        if (jpg && r.id) await api("/api/poster?id=" + encodeURIComponent(r.id), { body: jpg, type: "image/jpeg" }).catch(() => {});
      }
    }
    // ----- the rabbi's voice recording -----
    else if (fromRabbi && m.audioMessage) {
      const buf = await download();
      const q = new URLSearchParams({ week, kind: isAnswerTime(when) ? "answer" : "shiur", taken, fp: fingerprint(buf) });
      const r = await api("/api/upload?" + q, { body: buf, type: "audio/ogg" });
      log(r.duplicate ? `= הקלטה כבר באתר (שבת ${week})` : `✓ הקלטה של הרב הועלתה: שבת ${week}`);
    }
    // ----- a member's voice note -----
    else if (!fromRabbi && m.audioMessage) {
      const buf = await download();
      if (buf.length <= 30 * 1048576) {
        const q = new URLSearchParams({ week, g: label, n: name, taken, fp: "v:" + fingerprint(buf) });
        const r = await api("/api/voice?" + q, { body: buf, type: "audio/ogg" });
        log(r.duplicate ? `= תגובה קולית כבר באתר` : `✓ תגובה קולית: ${label}, שבת ${week}`);
      }
    }
    // ----- a member's written answer -----
    else if (!fromRabbi) {
      const raw = m.conversation || m.extendedTextMessage?.text || "";
      if (raw && raw.length <= 3000) {
        const t = cleanText(raw);
        if (t.length >= 2) {
          const r = await api("/api/comments", {
            body: JSON.stringify({ items: [{ week, g: label, t, n: name, h: fnv(week + "|" + t) }] }),
            type: "application/json",
          });
          if (r.added) log(`✓ תגובה: ${label}, שבת ${week}: ${t.slice(0, 50)}…`);
        }
      }
    }
    markSeen(id);
  } catch (e) {
    log("✗ שגיאה:", e.message, "(ינסה שוב בהודעה הבאה / בהפעלה הבאה)");
  }
}

async function start() {
  // make sure the password works before connecting
  const chk = await fetch(SITE + "/api/check", { method: "POST", headers: { "x-admin-password": PW } }).catch(() => null);
  if (!chk) { log("אין חיבור לאתר – ינסה שוב בעוד דקה"); setTimeout(start, 60000); return; }
  if (!chk.ok) { console.log("✗ סיסמת הניהול ב-config.json שגויה"); process.exit(1); }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch {}
  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: "silent" }),
    browser: Browsers.ubuntu("Rabbi Danon site"),
    syncFullHistory: false,
    markOnlineOnConnect: false, // don't disturb notifications on the phone
  });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("\nסרקו את הקוד עם הוואטסאפ של הרב:  הגדרות ← מכשירים מקושרים ← קישור מכשיר\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") log("✓ מחובר לוואטסאפ – ממתין להודעות בקבוצות השיעור");
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        log("המכשיר נותק מהוואטסאפ. מחקו את התיקייה auth והפעילו מחדש כדי לסרוק שוב.");
        process.exit(1);
      }
      log("החיבור נסגר – מתחבר מחדש…");
      setTimeout(start, 5000);
    }
  });
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) await handle(sock, msg);
  });
}

if (!process.env.BOT_NO_START) start();
