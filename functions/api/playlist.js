// Reads a shared playlist link so people can pick from their own music without connecting an account.
// Apple Music: the public playlist page lists its songs (we return the song ids; the browser looks them up on iTunes).
// Spotify: the public embed page of a playlist or album (no sign-in, so it works for everyone, approved or not).
// YouTube / YouTube Music: the Data API with our key.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const json = (body, status = 200, cache = 0) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": cache ? `public, max-age=${cache}` : "no-store" } });

async function apple(u) {
  const r = await fetch(u.href, { headers: { "user-agent": UA, accept: "text/html" } });
  if (!r.ok) return null;
  const html = await r.text();
  // Preferred: the page's own data, which lists every track (personal playlists included) with artist and artwork.
  try {
    const i = html.indexOf('id="serialized-server-data"');
    if (i >= 0) {
      const a = html.indexOf(">", i) + 1, b = html.indexOf("</script>", a);
      const data = JSON.parse(html.slice(a, b));
      const sections = (((data.data || [])[0] || {}).data || {}).sections || [];
      const list = sections.find(x => String(x.id || "").startsWith("track-list"));
      if (list && list.items && list.items.length) {
        const head = (sections[0] && sections[0].items && sections[0].items[0]) || {};
        const songs = list.items.filter(t => t.title && t.contentDescriptor && t.contentDescriptor.kind === "song").map(t => ({
          title: t.title,
          artist: (t.subtitleLinks || []).map(x => x.title).filter(Boolean).join(", "),
          artwork: t.artwork && t.artwork.dictionary && t.artwork.dictionary.url ? t.artwork.dictionary.url.replace("{w}", "300").replace("{h}", "300").replace("{f}", "jpg") : null,
          explicit: !!t.showExplicitBadge, preview: null,
          links: t.contentDescriptor.url ? { apple: t.contentDescriptor.url } : {},
        }));
        if (songs.length) return { name: head.title || "Playlist", songs };
      }
    }
  } catch {}
  // Backup: the search-engine summary (first 50 songs, ids only).
  const i = html.indexOf("schema:music-playlist");
  if (i < 0) return null;
  const a = html.indexOf(">", i) + 1, b = html.indexOf("</script>", a);
  const j = JSON.parse(html.slice(a, b));
  const ids = (j.track || []).map(t => (String(t.url || "").match(/\/song\/[^/]+\/(\d+)/) || String(t.url || "").match(/[?&]i=(\d+)/) || [])[1]).filter(Boolean);
  return { name: j.name || "Playlist", ids, country: (u.pathname.match(/^\/([a-z]{2})\//) || [])[1] || "us" };
}

async function spotify(u) {
  // Short share links (spotify.link/...) redirect to the real open.spotify.com address.
  if (!/open\.spotify\.com$/.test(u.hostname)) { const r = await fetch(u.href, { headers: { "user-agent": UA }, redirect: "follow" }); u = new URL(r.url) }
  const m = u.pathname.match(/(playlist|album)\/([A-Za-z0-9]+)/);
  if (!m) return null;
  const r = await fetch(`https://open.spotify.com/embed/${m[1]}/${m[2]}`, { headers: { "user-agent": UA, accept: "text/html" } });
  if (!r.ok) return null;
  const html = await r.text(), i = html.indexOf('id="__NEXT_DATA__"');
  if (i < 0) return null;
  const a = html.indexOf(">", i) + 1, b = html.indexOf("</script>", a);
  const e = ((((JSON.parse(html.slice(a, b)).props || {}).pageProps || {}).state || {}).data || {}).entity;
  if (!e || !e.trackList) return null;
  const cover = (((e.coverArt || {}).sources || []).find(x => x.width >= 300) || ((e.coverArt || {}).sources || [])[0] || {}).url || null;
  const songs = e.trackList.filter(t => t.title && t.entityType !== "episode" && /^spotify:track:/.test(t.uri || "")).map(t => ({
    title: t.title, artist: t.subtitle || "", artwork: m[1] === "album" ? cover : null, explicit: !!t.isExplicit,
    preview: t.audioPreview && t.audioPreview.url || null, links: { spotify: "https://open.spotify.com/track/" + t.uri.split(":")[2] },
  }));
  return { name: e.name || e.title || "Playlist", songs, cover };
}

async function youtube(list, key) {
  const base = "https://www.googleapis.com/youtube/v3/";
  const [p, items] = await Promise.all([
    fetch(`${base}playlists?part=snippet&id=${encodeURIComponent(list)}&key=${key}`).then(r => r.json()),
    fetch(`${base}playlistItems?part=snippet&maxResults=50&playlistId=${encodeURIComponent(list)}&key=${key}`).then(r => r.json()),
  ]);
  if (!items.items) return null;
  const songs = items.items.map(i => i.snippet).filter(s => s.resourceId && s.resourceId.videoId && s.title !== "Private video" && s.title !== "Deleted video").map(s => ({
    title: s.title, artist: (s.videoOwnerChannelTitle || "").replace(/\s+-\s+topic$/i, ""), artwork: ((s.thumbnails || {}).medium || {}).url || null, yt: s.resourceId.videoId,
  }));
  return { name: (p.items && p.items[0] && p.items[0].snippet.title) || "Playlist", songs };
}

export async function onRequestGet({ request, env, waitUntil }) {
  let u;
  try { u = new URL(new URL(request.url).searchParams.get("url") || "") } catch { return json({ error: "bad url" }, 400) }
  const cache = caches.default, key = new Request("https://cache.idefm/playlist?" + encodeURIComponent(u.href));
  const hit = await cache.match(key); if (hit) return hit;
  let out = null;
  try {
    if (/(^|\.)music\.apple\.com$/.test(u.hostname) && u.pathname.includes("/playlist/")) out = await apple(u);
    else if (/^(open\.spotify\.com|spotify\.link)$/.test(u.hostname)) out = await spotify(u);
    else if (/(^|\.)(youtube\.com|youtu\.be)$/.test(u.hostname) && u.searchParams.get("list") && env.YT_KEY) out = await youtube(u.searchParams.get("list"), env.YT_KEY);
    else return json({ error: "unsupported" }, 400);
  } catch {}
  if (!out) return json({ error: "unreadable" }, 404);
  const res = json(out, 200, 600);
  waitUntil(cache.put(key, res.clone()));
  return res;
}
