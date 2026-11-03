// Shared playlist API on Cloudflare Pages Functions + D1.
import { findYt } from "../_lib/yt.js";
const MAX = 5;
const SERVICES = ["spotify", "apple", "youtube", "soundcloud", "tidal", "deezer"];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
}
const fmt = t => { const d = new Date(t); return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") };
const openMonths = () => { const n = Date.now(); return new Set([fmt(n - 864e5), fmt(n), fmt(n + 864e5)]) };
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const httpsUrl = v => { try { const u = new URL(v); return u.protocol === "https:" && v.length < 600 ? u.href : null } catch { return null } };
const keyOf = s => (s.title + "|" + s.artist).toLowerCase();
const row = r => ({ ...r, links: JSON.parse(r.links || "{}") });

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare("SELECT s.*, (SELECT COUNT(*) FROM likes l WHERE l.song_id = s.id) AS likes FROM songs s ORDER BY s.created_at").all();
  const songs = results.map(row);
  const sig = await sha256(songs.map(s => s.id + s.name + ":" + s.likes).join(","));
  return json({ songs, sig });
}

async function auth(request) {
  let body;
  try { body = await request.json() } catch { return { err: json({ error: "bad request" }, 400) } }
  const token = str(body.token, 200);
  if (token.length < 32) return { err: json({ error: "bad token" }, 400) };
  const month = str(body.month, 7);
  if (!openMonths().has(month)) return { err: json({ error: "closed" }, 403) };
  return { body, month, owner: await sha256(token) };
}

export async function onRequestPost({ request, env, waitUntil }) {
  const a = await auth(request); if (a.err) return a.err;
  const { body, month, owner } = a;
  const name = str(body.name, 24) || "anon";
  const incoming = Array.isArray(body.songs) ? body.songs.slice(0, MAX) : [body];
  const songs = [];
  for (const x of incoming) {
    const title = str(x.title, 200), artist = str(x.artist, 200);
    if (!title) continue;
    const links = {};
    for (const k of SERVICES) { const u = x.links && httpsUrl(x.links[k]); if (u) links[k] = u }
    const s = { id: crypto.randomUUID(), month, name, owner_hash: owner, title, artist,
      artwork: httpsUrl(x.artwork), preview: httpsUrl(x.preview), links, created_at: new Date(Date.now() + songs.length).toISOString() };
    if (!songs.some(o => keyOf(o) === keyOf(s))) songs.push(s);
  }
  if (!songs.length) return json({ error: "missing" }, 400);

  const { results: existing } = await env.DB.prepare("SELECT title, artist, owner_hash FROM songs WHERE month = ?").bind(month).all();
  if (existing.filter(s => s.owner_hash === owner).length + songs.length > MAX) return json({ error: "limit" }, 409);
  const dup = songs.find(s => existing.some(o => keyOf(o) === keyOf(s)));
  if (dup) return json({ error: "dupe", title: dup.title }, 409);

  // One atomic batch; the guarded INSERT re-checks the 5-song cap inside the transaction.
  const stmts = songs.map(s => env.DB.prepare(
    `INSERT INTO songs (id, month, name, owner_hash, title, artist, artwork, preview, links, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
     WHERE (SELECT COUNT(*) FROM songs WHERE owner_hash = ?4 AND month = ?2) < ${MAX}`
  ).bind(s.id, s.month, s.name, s.owner_hash, s.title, s.artist, s.artwork, s.preview, JSON.stringify(s.links), s.created_at));
  stmts.push(env.DB.prepare("UPDATE songs SET name = ? WHERE owner_hash = ? AND month = ?").bind(name, owner, month));
  await env.DB.batch(stmts);
  // Look up each new song's YouTube video in the background so "Play all on YouTube" is ready.
  waitUntil(Promise.all(songs.map(s => findYt(env, s).catch(() => null))));
  return json({ songs, song: songs[0] });
}

export async function onRequestDelete({ request, env }) {
  const a = await auth(request); if (a.err) return a.err;
  const id = str(a.body.id, 64);
  await env.DB.prepare("DELETE FROM songs WHERE id = ? AND owner_hash = ? AND month = ?").bind(id, a.owner, a.month).run();
  return json({ ok: true });
}
