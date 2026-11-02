// Each device's settings (name, iPod look, crate, app choice...) saved against its private token,
// so the same person sees the same iPod in Safari and in the home-screen app.
let ready = false;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
}
async function setup(env) {
  if (ready) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS prefs (owner_hash TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)").run();
  ready = true;
}

export async function onRequestPost({ request, env }) {
  const b = await request.json().catch(() => ({}));
  if (typeof b.token !== "string" || !/^[0-9a-f]{32,64}$/.test(b.token)) return json({ error: "bad token" }, 400);
  await setup(env);
  const owner = await sha256(b.token);
  if (b.prefs) {
    const data = JSON.stringify(b.prefs);
    if (data.length > 30000) return json({ error: "too big" }, 413);
    const at = Number(b.at) || Date.now();
    await env.DB.prepare("INSERT INTO prefs (owner_hash, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(owner_hash) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at WHERE excluded.updated_at >= prefs.updated_at")
      .bind(owner, data, at).run();
    return json({ ok: true, at });
  }
  const row = await env.DB.prepare("SELECT data, updated_at FROM prefs WHERE owner_hash = ?").bind(owner).first();
  return json(row ? { prefs: JSON.parse(row.data), at: row.updated_at } : { prefs: null, at: 0 });
}
