// GET: the class playlists. POST: connect the station's Spotify, or rebuild the playlists now.
import { stationInfo, syncStation, tokenFromCode, sget } from "../_lib/station.js";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function onRequestGet({ env }) { return json(await stationInfo(env)) }

export async function onRequestPost({ request, env }) {
  const b = await request.json().catch(() => ({}));
  try {
    if (b.action === "connect") {
      if (!b.code || !b.verifier || !b.redirect || !b.clientId) return json({ error: "bad request" }, 400);
      const u = await tokenFromCode(env, b);
      return json({ ok: true, user: u, sync: await syncStation(env) });
    }
    if (b.action === "sync") {
      // Allowed for the nightly job (shared key) or the station's own Spotify account.
      let ok = env.CRON_KEY && b.key === env.CRON_KEY;
      if (!ok && b.access) {
        const owner = await sget(env, "sp_user");
        const me = await (await fetch("https://api.spotify.com/v1/me", { headers: { authorization: "Bearer " + b.access } })).json().catch(() => ({}));
        ok = !!(owner && me.id === owner.id);
      }
      if (!ok) return json({ error: "not allowed" }, 403);
      return json(await syncStation(env));
    }
  } catch (e) { return json({ error: String(e.message || e) }, e.message === "not owner" ? 403 : 500) }
  return json({ error: "unknown action" }, 400);
}
