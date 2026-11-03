// ♥ a song: one like per device per song. Counts come back with the song list.
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
}

export async function onRequestPost({ request, env }) {
  const b = await request.json().catch(() => ({}));
  if (typeof b.token !== "string" || b.token.length < 32 || typeof b.id !== "string" || b.id.length > 64) return json({ error: "bad request" }, 400);
  const owner = await sha256(b.token);
  const song = await env.DB.prepare("SELECT id FROM songs WHERE id = ?").bind(b.id).first();
  if (!song) return json({ error: "gone" }, 404);
  if (b.like) await env.DB.prepare("INSERT OR IGNORE INTO likes (song_id, owner_hash, created_at) VALUES (?, ?, ?)").bind(b.id, owner, new Date().toISOString()).run();
  else await env.DB.prepare("DELETE FROM likes WHERE song_id = ? AND owner_hash = ?").bind(b.id, owner).run();
  const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM likes WHERE song_id = ?").bind(b.id).first();
  return json({ id: b.id, likes: c.n, liked: !!b.like });
}
