// The class Spotify playlist: one shared playlist per month, owned by the station's Spotify account and rebuilt
// from the mix every night (and on demand). Uses its own Spotify sign-in, separate from anyone's personal one.
const ACC = "https://accounts.spotify.com/api/token", API = "https://api.spotify.com/v1";
let ready = false;
async function setup(env) {
  if (ready) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS station (k TEXT PRIMARY KEY, v TEXT NOT NULL)").run();
  ready = true;
}
export async function sget(env, k) { await setup(env); const r = await env.DB.prepare("SELECT v FROM station WHERE k = ?").bind(k).first(); return r ? JSON.parse(r.v) : null }
export async function sset(env, k, v) { await setup(env); await env.DB.prepare("INSERT INTO station (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, JSON.stringify(v)).run() }

export async function tokenFromCode(env, { code, verifier, redirect, clientId }) {
  const r = await fetch(ACC, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier, client_id: clientId }) });
  if (!r.ok) throw new Error("spotify code " + r.status);
  const j = await r.json();
  const me = await (await fetch(API + "/me", { headers: { authorization: "Bearer " + j.access_token } })).json();
  const owner = await sget(env, "sp_user");
  if (owner && owner.id !== me.id) throw new Error("not owner");
  await sset(env, "sp_auth", { refresh: j.refresh_token, clientId });
  await sset(env, "sp_user", { id: me.id, name: me.display_name || me.id });
  return { id: me.id, name: me.display_name || me.id };
}

async function access(env) {
  const a = await sget(env, "sp_auth"); if (!a) return null;
  const r = await fetch(ACC, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: a.refresh, client_id: a.clientId }) });
  if (!r.ok) throw new Error("spotify refresh " + r.status);
  const j = await r.json();
  if (j.refresh_token && j.refresh_token !== a.refresh) await sset(env, "sp_auth", { ...a, refresh: j.refresh_token }); // Spotify rotates these
  return j.access_token;
}

const monthKey = d => d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
const monthLabel = k => { const [y, m] = k.split("-").map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en", { month: "long", year: "numeric", timeZone: "UTC" }) };

export async function syncStation(env) {
  const tok = await access(env); if (!tok) return { ok: false, error: "not connected" };
  const call = (p, o = {}) => fetch(API + p, { ...o, headers: { authorization: "Bearer " + tok, "content-type": "application/json", ...(o.headers || {}) } });
  const now = new Date(), months = [monthKey(now)];
  if (now.getUTCDate() === 1) months.push(monthKey(new Date(now - 864e5))); // finish last month's playlist on the 1st
  const out = {};
  for (const month of months) {
    const { results } = await env.DB.prepare("SELECT id, title, artist, links FROM songs WHERE month = ? ORDER BY created_at").bind(month).all();
    const uris = [];
    for (const s of results) {
      let uri = await sget(env, "uri:" + s.id);
      if (uri == null) {
        const direct = (JSON.parse(s.links || "{}").spotify || "").match(/track\/([A-Za-z0-9]+)/);
        if (direct) uri = "spotify:track:" + direct[1];
        else for (const q of [`track:${s.title} artist:${(s.artist || "").split(",")[0]}`, `${s.title} ${s.artist}`]) {
          const r = await call("/search?type=track&limit=1&q=" + encodeURIComponent(q));
          const it = r.ok ? ((await r.json()).tracks || {}).items?.[0] : null;
          if (it) { uri = it.uri; break }
        }
        await sset(env, "uri:" + s.id, uri || "");
      }
      if (uri) uris.push(uri);
    }
    let pl = await sget(env, "pl:" + month);
    if (pl) {
      const r = await call(`/playlists/${pl.id}/items`, { method: "PUT", body: JSON.stringify({ uris: uris.slice(0, 100) }) });
      if (!r.ok) pl = null; // deleted in Spotify: make a new one
    }
    if (!pl) {
      if (!uris.length) { out[month] = { n: 0 }; continue }
      const name = (env.STATION_NAME || "Class Radio") + " · " + monthLabel(month);
      const r = await call("/me/playlists", { method: "POST", body: JSON.stringify({ name, public: true, description: "The class mix. Updates every night." }) });
      if (!r.ok) { out[month] = { error: "create " + r.status }; continue }
      const j = await r.json(); pl = { id: j.id, url: j.external_urls.spotify };
      await call(`/playlists/${pl.id}/items`, { method: "PUT", body: JSON.stringify({ uris: uris.slice(0, 100) }) });
      await sset(env, "pl:" + month, pl);
    }
    for (let i = 100; i < uris.length; i += 100) await call(`/playlists/${pl.id}/items`, { method: "POST", body: JSON.stringify({ uris: uris.slice(i, i + 100) }) });
    out[month] = { ...pl, n: uris.length, missing: results.length - uris.length };
  }
  await sset(env, "synced", { at: new Date().toISOString(), out });
  return { ok: true, out };
}

export async function stationInfo(env) {
  await setup(env);
  const { results } = await env.DB.prepare("SELECT k, v FROM station WHERE k LIKE 'pl:%' OR k IN ('sp_user', 'synced')").all();
  const lists = {}; let user = null, synced = null;
  for (const r of results) {
    const v = JSON.parse(r.v);
    if (r.k.startsWith("pl:")) lists[r.k.slice(3)] = v; else if (r.k === "sp_user") user = v; else synced = v.at;
  }
  return { connected: !!user, user: user && user.name, userId: user && user.id, lists, synced };
}
