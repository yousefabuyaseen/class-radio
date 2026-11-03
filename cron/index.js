// Nightly: ask the site to rebuild the class Spotify playlist (23:55 London time, winter and summer).
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetch(env.SITE + "/api/station", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "sync", key: env.CRON_KEY }) }));
  },
};
