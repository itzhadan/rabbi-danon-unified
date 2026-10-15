// Rabbi Yosef Danon site – API + video storage (R2)
// Static files are served from ./public ; this worker handles /api/* and /v/*

const INDEX_KEY = "index/clips.json";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

async function readIndex(env) {
  const obj = await env.VIDEOS.get(INDEX_KEY);
  if (!obj) return { clips: [], topics: {}, comments: {} };
  const data = await obj.json();
  data.clips ||= [];
  data.topics ||= {};
  data.comments ||= {};
  return data;
}
const writeIndex = (env, data) =>
  env.VIDEOS.put(INDEX_KEY, JSON.stringify(data), { httpMetadata: { contentType: "application/json" } });

function authorized(request, env) {
  const pw = request.headers.get("x-admin-password") || "";
  return env.ADMIN_PASSWORD && pw === env.ADMIN_PASSWORD;
}

async function serveVideo(request, env, key) {
  const range = request.headers.get("range");
  let opts = {};
  let head = null;
  if (range) {
    head = await env.VIDEOS.head(key);
    if (!head) return new Response("Not found", { status: 404 });
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const size = head.size;
      let start = m[1] === "" ? size - Number(m[2]) : Number(m[1]);
      let end = m[1] !== "" && m[2] !== "" ? Number(m[2]) : size - 1;
      end = Math.min(end, size - 1);
      if (start > end || start < 0) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
      opts.range = { offset: start, length: end - start + 1 };
    }
  }
  const obj = await env.VIDEOS.get(key, opts);
  if (!obj) return new Response("Not found", { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("accept-ranges", "bytes");
  h.set("cache-control", "public, max-age=604800");
  if (opts.range) {
    const { offset, length } = opts.range;
    h.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    h.set("content-length", String(length));
    return new Response(obj.body, { status: 206, headers: h });
  }
  h.set("content-length", String(obj.size));
  return new Response(obj.body, { headers: h });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/v/")) return serveVideo(request, env, decodeURIComponent(path.slice(3)));

    if (path === "/api/clips" && request.method === "GET") return json(await readIndex(env));

    if (path === "/api/check" && request.method === "POST")
      return authorized(request, env) ? json({ ok: true }) : json({ ok: false }, 401);

    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (!authorized(request, env)) return json({ error: "סיסמה שגויה" }, 401);

    // POST /api/upload?week=YYYY-MM-DD&kind=shiur|question|answer&label=...&taken=ISO&size=&name=
    if (path === "/api/upload" && request.method === "POST") {
      const week = url.searchParams.get("week") || "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) return json({ error: "שבת לא תקינה" }, 400);
      const kind = ["shiur", "question", "answer", "cvideo", "kolhalashon"].includes(url.searchParams.get("kind")) ? url.searchParams.get("kind") : "shiur";
      const label = (url.searchParams.get("label") || "").slice(0, 80);
      const taken = url.searchParams.get("taken") || new Date().toISOString();
      const fingerprint = url.searchParams.get("fp") || "";
      const idx = await readIndex(env);
      if (fingerprint && idx.clips.some((c) => c.fp === fingerprint))
        return json({ ok: true, duplicate: true });
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const type = request.headers.get("content-type") || "video/mp4";
      const ext = type.includes("quicktime") ? "mov" : /audio\/(ogg|opus)/.test(type) ? "ogg" : /audio\/(mp4|m4a|aac|x-m4a)/.test(type) ? "m4a" : /audio\/mpeg/.test(type) ? "mp3" : /audio/.test(type) ? "ogg" : "mp4";
      const key = `clips/${week}/${id}.${ext}`;
      await env.VIDEOS.put(key, request.body, { httpMetadata: { contentType: type } });
      const fresh = await readIndex(env); // re-read to reduce lost updates
      const sourceId = url.searchParams.get("sourceId") || "";
      const source = kind === "kolhalashon" && /^\d{1,12}$/.test(sourceId)
        ? { sourceId, sourceUrl: `https://www.kolhalashon.com/he/regularSite/playShiur/${sourceId}/-1/0/false`,
            part: Math.max(1, Number(url.searchParams.get("part")) || 1),
            parts: Math.max(1, Number(url.searchParams.get("parts")) || 1) } : {};
      fresh.clips.push({ id, week, kind, label, key, taken, fp: fingerprint, ...source, added: new Date().toISOString() });
      await writeIndex(env, fresh);
      return json({ ok: true, id });
    }

    // POST /api/poster?id=   body = jpeg thumbnail for a clip
    if (path === "/api/poster" && request.method === "POST") {
      const id = url.searchParams.get("id") || "";
      const idx = await readIndex(env);
      const clip = idx.clips.find((c) => c.id === id);
      if (!clip) return json({ error: "לא נמצא" }, 404);
      const key = clip.key.replace(/\.[a-z0-9]+$/i, "") + ".jpg";
      await env.VIDEOS.put(key, request.body, { httpMetadata: { contentType: "image/jpeg" } });
      const fresh = await readIndex(env);
      const c2 = fresh.clips.find((c) => c.id === id);
      if (c2) c2.poster = key;
      await writeIndex(env, fresh);
      return json({ ok: true, poster: key });
    }

    // POST /api/delete {id}
    if (path === "/api/delete" && request.method === "POST") {
      const { id } = await request.json();
      const idx = await readIndex(env);
      const clip = idx.clips.find((c) => c.id === id);
      if (!clip) return json({ error: "לא נמצא" }, 404);
      await env.VIDEOS.delete(clip.key);
      if (clip.poster) await env.VIDEOS.delete(clip.poster);
      idx.clips = idx.clips.filter((c) => c.id !== id);
      await writeIndex(env, idx);
      return json({ ok: true });
    }

    // POST /api/update {id, kind?, label?, week?}
    if (path === "/api/update" && request.method === "POST") {
      const body = await request.json();
      const idx = await readIndex(env);
      const clip = idx.clips.find((c) => c.id === body.id);
      if (!clip) return json({ error: "לא נמצא" }, 404);
      if (body.kind) clip.kind = body.kind;
      if (typeof body.label === "string") clip.label = body.label.slice(0, 80);
      if (body.week && /^\d{4}-\d{2}-\d{2}$/.test(body.week)) clip.week = body.week;
      await writeIndex(env, idx);
      return json({ ok: true });
    }

    // POST /api/topic {week, topic}
    if (path === "/api/topic" && request.method === "POST") {
      const { week, topic } = await request.json();
      const idx = await readIndex(env);
      idx.topics[week] = String(topic || "").slice(0, 200);
      await writeIndex(env, idx);
      return json({ ok: true });
    }

    // POST /api/voice?week=&g=&taken=&fp=   body = audio file  → voice comment
    if (path === "/api/voice" && request.method === "POST") {
      const week = url.searchParams.get("week") || "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) return json({ error: "שבת לא תקינה" }, 400);
      const g = (url.searchParams.get("g") || "").slice(0, 40);
      const fp = (url.searchParams.get("fp") || "").slice(0, 60);
      const taken = url.searchParams.get("taken") || "";
      const idx0 = await readIndex(env);
      if (fp && Object.values(idx0.comments).some((l) => l.some((c) => c.h === fp))) return json({ ok: true, duplicate: true });
      const type = request.headers.get("content-type") || "audio/ogg";
      if (!/^(audio|video)\//.test(type)) return json({error:"סוג מדיה לא נתמך"}, 415);
      if (Number(request.headers.get("content-length")) > 95_000_000) return json({error:"יש לפצל לחלקים עד 95 מגה"}, 413);
      const isVideo = type.startsWith("video/");
      const ext = isVideo ? "mp4" : /mp4|m4a|aac/.test(type) ? "m4a" : /mpeg|mp3/.test(type) ? "mp3" : "ogg";
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const key = `voice/${week}/${id}.${ext}`;
      const part = Math.max(1, Number(url.searchParams.get("part")) || 1);
      const parts = Math.max(part, Number(url.searchParams.get("parts")) || 1);
      await env.VIDEOS.put(key, request.body, { httpMetadata: { contentType: type } });
      const idx = await readIndex(env);
      (idx.comments[week] ||= []).push({ g, t: "", a: key, media: isVideo ? "video" : "audio", part, parts, h: fp || id, taken, n: (url.searchParams.get("n") || "").slice(0, 60) });
      await writeIndex(env, idx);
      return json({ ok: true, id });
    }

    // POST /api/comments {items:[{week,g,t,h}]}  – merge, skipping existing
    if (path === "/api/comments" && request.method === "POST") {
      const { items } = await request.json();
      const idx = await readIndex(env);
      let added = 0;
      for (const it of (items || []).slice(0, 5000)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(it.week) || !it.t || !it.h) continue;
        const list = (idx.comments[it.week] ||= []);
        if (list.some((c) => c.h === it.h)) continue;
        list.push({ g: String(it.g || "").slice(0, 40), t: String(it.t).slice(0, 1600), h: String(it.h).slice(0, 40), n: String(it.n || "").slice(0, 60) });
        added++;
      }
      await writeIndex(env, idx);
      return json({ ok: true, added });
    }

    // POST /api/names {names:{raw:display}}  – how commenter names appear on the site
    if (path === "/api/names" && request.method === "POST") {
      const { names } = await request.json();
      const idx = await readIndex(env);
      idx.names = { ...(idx.names || {}) };
      for (const [k, v] of Object.entries(names || {})) idx.names[String(k).slice(0, 60)] = String(v ?? "").slice(0, 60);
      await writeIndex(env, idx);
      return json({ ok: true });
    }

    // POST /api/comment-delete {week,h}
    if (path === "/api/comment-delete" && request.method === "POST") {
      const { week, h } = await request.json();
      const idx = await readIndex(env);
      const list = idx.comments[week] || [];
      const hidden = (idx.hidden ||= []);
      if (!hidden.includes(h)) hidden.push(h);
      const gone = list.find((c) => c.h === h);
      if (gone && gone.a) await env.VIDEOS.delete(gone.a);
      idx.comments[week] = list.filter((c) => c.h !== h);
      await writeIndex(env, idx);
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  },
};
