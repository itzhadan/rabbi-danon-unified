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
import { execFile, spawn } from "node:child_process";
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


const MEDIA_LIMIT = 95_000_000;
const runMediaTool = (tool, args) => new Promise((resolve, reject) => {
  execFile(tool, args, { timeout: 600000, maxBuffer: 1024 * 1024 }, (err, stdout) => err ? reject(err) : resolve(stdout));
});
export async function splitMedia(buf, video, type = "audio/ogg") {
  if (buf.length <= MEDIA_LIMIT) return [buf];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbi-parts-"));
  const input = path.join(dir, "source");
  fs.writeFileSync(input, buf);
  try {
    const duration = Number((await runMediaTool("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", input])).trim());
    if (!(duration > 0)) throw new Error("לא ניתן לקבוע את אורך המדיה לצורך פיצול");
    let fps = 0;
    if (video) { const rate = (await runMediaTool("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate", "-of", "default=nw=1:nk=1", input])).trim().split("/").map(Number); fps = rate[0] / (rate[1] || 1); }
    const result = [];
    let serial = 0;
    const cut = async (start, length, depth = 0) => {
      if (fps > 0) { const end = Math.round((start + length) * fps) / fps; start = Math.round(start * fps) / fps; length = end - start; }
      const output = path.join(dir, "part-" + (++serial) + (video ? ".mp4" : /ogg|opus/.test(type) ? ".ogg" : /mpeg|mp3/.test(type) ? ".mp3" : ".m4a"));
      await runMediaTool("ffmpeg", ["-v", "error", "-y", "-i", input, "-ss", String(start), "-t", String(length), "-map", video ? "0:v:0" : "0:a:0", ...(video ? ["-map", "0:a:0?"] : []), ...(video ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac"] : ["-c", "copy"]), "-avoid_negative_ts", "make_zero", ...(video ? ["-movflags", "+faststart"] : []), output]);
      const part = fs.readFileSync(output);
      fs.unlinkSync(output);
      if (!part.length) throw new Error("נוצר חלק מדיה ריק");
      if (part.length > MEDIA_LIMIT) {
        if (depth >= 12 || length < 1) throw new Error("לא ניתן לפצל חלק מתחת ל־95 מגה");
        await cut(start, length / 2, depth + 1);
        await cut(start + length / 2, length / 2, depth + 1);
      } else result.push(part);
    };
    const count = Math.ceil(buf.length / 75_000_000);
    for (let i = 0; i < count; i++) await cut(i * duration / count, duration / count);
    return result;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
  if (!jid.endsWith("@g.us") || !msg.message) return;
  const initial = unwrap(msg.message);
  const retryStudentMedia = initial.videoMessage || initial.ptvMessage || initial.audioMessage || /^(video|audio)\//.test(initial.documentMessage?.mimetype || "");
  const id = `${jid}|${msg.key.id}` + (retryStudentMedia ? "|media-v2" : "");
  if (SEEN.has(id)) return;

  const when = new Date(Number(msg.messageTimestamp || 0) * 1000);
  if (!msg.messageTimestamp || Date.now() - when.getTime() > MAX_AGE_DAYS * 864e5) return;

  const label = await groupLabel(sock, jid);
  log("📩", groupNames.get(jid), msg.key.fromMe ? "מהרב" : (msg.pushName || "חבר"), Object.keys(msg.message || {}).join(","));
  if (!label) return; // not one of the lesson groups

  const m = unwrap(msg.message);
  const memberVideo = m.videoMessage || m.ptvMessage || (m.documentMessage?.mimetype?.startsWith("video/") ? m.documentMessage : null);
  const memberAudio = m.audioMessage || (m.documentMessage?.mimetype?.startsWith("audio/") ? m.documentMessage : null);
  const RID = (j) => String(j || "").split("@")[0].split(":")[0];
  const ids = [msg.key.participant, msg.key.participantAlt, msg.key.participantPn, msg.participant].filter(Boolean).map(RID);
  const fromRabbi = CFG.rabbi ? ids.some((x) => CFG.rabbi.map(String).includes(x)) : !!msg.key.fromMe;
  log("👤", msg.pushName || "", ids.join(" / "), fromRabbi ? "(הרב)" : "");
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
    // ----- a member's video or voice note -----
    else if (!fromRabbi && (memberVideo || memberAudio)) {
      const video = !!memberVideo;
      const mediaType = video ? "video/mp4" : (memberAudio.mimetype || "audio/ogg").split(";")[0];
      const original = await download();
      const parts = await splitMedia(original, video, mediaType);
      const fp = (video ? "sv:" : "v:") + fingerprint(original);
      for (let i = 0; i < parts.length; i++) {
        const q = new URLSearchParams({ week, g: label, n: name, taken,
          fp: parts.length === 1 ? fp : fp + ":" + (i + 1),
          part: String(i + 1), parts: String(parts.length) });
        await api("/api/voice?" + q, { body: parts[i], type: mediaType });
        log("✓ תגובת " + (video ? "וידאו" : "קול") + ": " + label + ", שבת " + week + " · חלק " + (i + 1) + "/" + parts.length);
      }
    }
    // ----- a member's written answer -----
    else {
      const raw = m.conversation || m.extendedTextMessage?.text || "";
      if (raw && raw.length <= 3000) {
        const t = cleanText(raw);
        if (t.length >= 2) {
          const r = await api("/api/comments", {
            body: JSON.stringify({ items: [{ week, g: label, t, n: fromRabbi ? "הרב" : name, h: fnv(week + "|" + t) }] }),
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
    syncFullHistory: true,
    shouldSyncHistoryMessage: () => true,
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
  // Serialize live and historical messages so SEEN can prevent duplicates.
  let messageQueue = Promise.resolve();
  const enqueueMessages = (messages = []) => {
    const cutoff = Date.now() - MAX_AGE_DAYS * 864e5;
    const candidates = messages.filter((msg) =>
      msg.key?.remoteJid?.endsWith("@g.us") && msg.message &&
      Number(msg.messageTimestamp || 0) * 1000 >= cutoff
    ).sort((a, b) => Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0));
    messageQueue = messageQueue.then(async () => {
      for (const msg of candidates) await handle(sock, msg);
    }).catch((e) => log("שגיאה בתור ההודעות:", e.message));
    return messageQueue;
  };
  sock.ev.on("messaging-history.set", ({ messages = [] }) => {
    log("סנכרון היסטוריה: התקבלו", messages.length, "הודעות; מסנן לפי קבוצות השיעור ומגבלת הימים");
    void enqueueMessages(messages);
  });
  sock.ev.on("messages.upsert", ({ messages = [] }) => {
    void enqueueMessages(messages);
  });
}

// The existing always-on service supervises the archive worker too. This is
// independent of WhatsApp reconnects and of the user's desktop.
function startKolHalashon() {
  const worker = spawn("python3", ["-u", path.join(DIR, "kolhalashon_sync.py"), "--all", "--loop"], {
    cwd: DIR, stdio: "inherit",
  });
  const stop = () => worker.kill("SIGTERM");
  process.once("exit", stop);
  worker.once("error", () => log("קול הלשון: לא ניתן להפעיל תהליך ייבוא"));
  worker.once("close", () => {
    process.removeListener("exit", stop);
    log("קול הלשון: התהליך הסתיים; ניסיון חוזר בעוד 30 דקות");
    setTimeout(startKolHalashon, 30 * 60 * 1000);
  });
}
if (!process.env.BOT_NO_START) {
  startKolHalashon();
  start();
}
