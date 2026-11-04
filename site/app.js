(() => {
  "use strict";
  const CFG = window.IDERADIO_CONFIG || {};
  const NAME = CFG.name || "Class Radio", OWNER = CFG.owner || "whoever runs the site";
  const MAX = 5;
  const $ = (s, r = document) => r.querySelector(s);

  // ---------- helpers ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style") el.style.cssText = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false && kid !== "") el.append(kid.nodeType ? kid : String(kid));
    return el;
  }
  const put = (el, ...kids) => el && el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false && k !== ""));
  const store = {
    get(k) { try { return localStorage.getItem(k) } catch { return null } },
    set(k, v) { try { localStorage.setItem(k, v) } catch {} if (PREF_KEYS.includes(k)) syncPrefs() },
    json(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } },
  };
  // Everything that makes the iPod yours. It's saved on the server too, so Safari and the home-screen app match.
  const PREF_KEYS = ["ideradio.play", "ideradio.liked", "ideradio.name", "ideradio.svc", "ideradio.model", "ideradio.edition", "ideradio.settings", "ideradio.crate", "ideradio.onboarded", "ideradio.vol", "ideradio.lists", "ideradio.hist"];
  let prefsT, prefsReady = false;
  function syncPrefs() {
    if (!prefsReady) return;
    clearTimeout(prefsT);
    prefsT = setTimeout(() => {
      const prefs = {}; for (const k of PREF_KEYS) { const v = store.get(k); if (v != null) prefs[k] = v }
      const at = Date.now(); try { localStorage.setItem("ideradio.prefsAt", at) } catch {}
      fetch("/api/prefs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, prefs, at }), keepalive: true }).catch(() => {});
    }, 1200);
  }
  async function pullPrefs() {
    try {
      const j = await (await fetch("/api/prefs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) })).json();
      const localAt = Number(store.get("ideradio.prefsAt") || 0);
      if (j.prefs && j.at > localAt) {
        const changed = PREF_KEYS.some(k => (j.prefs[k] ?? null) !== store.get(k));
        for (const k of PREF_KEYS) try { j.prefs[k] != null ? localStorage.setItem(k, j.prefs[k]) : localStorage.removeItem(k) } catch {}
        try { localStorage.setItem("ideradio.prefsAt", j.at) } catch {}
        if (changed && !sessionStorage.getItem("ideradio.pulled")) { sessionStorage.setItem("ideradio.pulled", "1"); location.reload(); return false }
      }
      prefsReady = true;
      if (!j.prefs || j.at < localAt || !localAt) syncPrefs();
    } catch { prefsReady = true }
    return true;
  }
  const monthKey = (d = new Date()) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  const toDate = k => { const [y, m] = k.split("-").map(Number); return new Date(y, m - 1, 1) };
  const monthLabel = k => toDate(k).toLocaleString("en", { month: "long", year: "numeric" });
  const monthName = k => toDate(k).toLocaleString("en", { month: "long" });
  const CURRENT = monthKey();
  const timeLeft = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth() + 1, 1) - n };
  const rand = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, "0")).join("");
  async function sha256(s) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
  }
  const PAL = ["#1f9fe6", "#ff3d6e", "#1a9a35", "#8a5cf6", "#f08a00", "#0fa79a", "#d43f7a", "#3a6fd8"];
  const colorFor = s => { let x = 0; for (const c of (s || "").toLowerCase()) x = (x * 31 + c.charCodeAt(0)) >>> 0; return PAL[x % PAL.length] };
  const safeUrl = v => { try { const u = new URL(v); return /^https?:$/.test(u.protocol) ? u.href : null } catch { return null } };
  const keyOf = s => ((s.title || "") + "|" + (s.artist || "")).toLowerCase();
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Messages work like an iPod's: a few words in the title bar for a moment. A result you can open (a saved playlist)
  // gets its own small menu screen. The big alert box is only used while the welcome cards cover the iPod.
  function toast(msg, link, face, ms) {
    if (document.querySelector(".ob")) return alertBox(msg, link, face);
    if (link) return push({ title: "Done", items: () => [{ head: true, label: msg }, { label: link.text.replace(/\s*↗$/, ""), right: "↗", hot: true, action: () => window.open(link.href, "_blank", "noopener") }, { label: "Done", right: "›", action: () => pop() }] });
    flashTitle(msg, ms);
  }

  // ---------- services ----------
  const SERVICES = {
    spotify:    { name: "Spotify",       host: /spotify\.(com|link)/, url: q => "https://open.spotify.com/search/" + encodeURIComponent(q) },
    apple:      { name: "Apple Music",   host: /music\.apple\.com|itunes\.apple\.com/, url: q => "https://music.apple.com/us/search?term=" + encodeURIComponent(q) },
    youtube:    { name: "YouTube", host: /youtube\.com|youtu\.be/, url: q => "https://music.youtube.com/search?q=" + encodeURIComponent(q) },
  };
  const serviceOf = url => { try { const host = new URL(url).hostname; for (const [k, s] of Object.entries(SERVICES)) if (s.host.test(host)) return k } catch {} return null };

  // ---------- identity: a private token on this device; the name is optional ----------
  let token = store.get("ideradio.token");
  if (!token) { token = rand(24); store.set("ideradio.token", token) }
  let myHash = null;
  let myName = store.get("ideradio.name") || "";

  const PK_NAME = /iPhone|iPad|Macintosh/.test(navigator.userAgent) && "ontouchend" in document ? "Face ID" : "a passkey";
  const PK = {
    ok: !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext),
    saved: () => !!store.get("ideradio.pk"),
    async save() {
      const label = (myName || "Listener") + " · " + NAME;
      await navigator.credentials.create({ publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)), rp: { name: NAME, id: location.hostname },
        user: { id: new TextEncoder().encode(token), name: label, displayName: label },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "preferred" }, timeout: 60000,
      } });
      store.set("ideradio.pk", "1"); syncPrefs();
    },
    async restore() {
      const c = await navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname, userVerification: "preferred", timeout: 60000 } });
      const t = new TextDecoder().decode(c.response.userHandle || new Uint8Array());
      if (!/^[0-9a-f]{32,64}$/.test(t)) throw new Error("not ours");
      try { localStorage.setItem("ideradio.token", t); localStorage.setItem("ideradio.pk", "1"); localStorage.removeItem("ideradio.prefsAt"); sessionStorage.removeItem("ideradio.pulled") } catch {}
      location.reload();
    },
  };

  // ---------- data ----------
  function apiStore() {
    const call = async (method, body) => {
      const r = await fetch("/api/songs", { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw { message: j.error || "error", title: j.title };
      return j;
    };
    let pollT, lastSig = "";
    return {
      live: true,
      async list() { const j = await call("GET"); lastSig = j.sig || ""; return j.songs || [] },
      async submit(name, songs) { return (await call("POST", { token, month: CURRENT, name, songs })).songs || [] },
      async remove(id, month) { await call("DELETE", { token, id, month }) },
      subscribe(cb) {
        const tick = async () => {
          clearTimeout(pollT);
          if (!document.hidden && !state.busy) {
            try { const j = await call("GET"); if (j.sig !== lastSig) { lastSig = j.sig; cb(j.songs) } setStatus("live") }
            catch { setStatus("reconnecting") }
          }
          pollT = setTimeout(tick, 4000);
        };
        pollT = setTimeout(tick, 4000);
        document.addEventListener("visibilitychange", () => { if (!document.hidden) tick() });
      },
    };
  }
  function demoStore() {
    const KEY = "ideradio.demo";
    const bc = "BroadcastChannel" in window ? new BroadcastChannel("ideradio") : null;
    const read = () => store.json(KEY, []);
    const write = rows => { store.set(KEY, JSON.stringify(rows)); bc && bc.postMessage("sync") };
    return {
      async list() { return read() },
      async submit(name, songs) {
        const rows = read();
        if (rows.filter(r => r.owner_hash === myHash && r.month === CURRENT).length + songs.length > MAX) throw { message: "limit" };
        const dup = songs.find(s => rows.some(r => r.month === CURRENT && keyOf(r) === keyOf(s)));
        if (dup) throw { message: "dupe", title: dup.title };
        rows.forEach(r => { if (r.owner_hash === myHash && r.month === CURRENT) r.name = name });
        const out = songs.map((s, i) => ({ ...s, id: crypto.randomUUID(), month: CURRENT, name, owner_hash: myHash, created_at: new Date(Date.now() + i).toISOString() }));
        write([...rows, ...out]); return out;
      },
      async remove(id) { write(read().filter(r => !(r.id === id && r.owner_hash === myHash))) },
      subscribe(cb) {
        bc && (bc.onmessage = () => cb(read()));
        addEventListener("storage", e => e.key === KEY && cb(read()));
      },
    };
  }
  let db = demoStore();

  // ---------- state ----------
  const state = {
    view: "mix", month: CURRENT,
    service: SERVICES[store.get("ideradio.svc")] ? store.get("ideradio.svc") : "spotify",
    songs: new Map(), loaded: false, busy: false,
    crate: store.json("ideradio.crate", []).filter(s => s && s.title),
    sheet: null, // { mode: "browse" | "crate", tab, query, results, loading, note }
  };
  const seen = new Set();
  const songsFor = k => [...state.songs.values()].filter(s => s.month === k).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const mine = () => songsFor(CURRENT).filter(s => s.owner_hash && s.owner_hash === myHash);
  const allMonths = () => [...new Set([CURRENT, ...[...state.songs.values()].map(s => s.month)])].filter(k => /^\d{4}-\d{2}$/.test(k)).sort().reverse();
  const slotsLeft = () => Math.max(0, MAX - mine().length - state.crate.length);
  const saveCrate = () => store.set("ideradio.crate", JSON.stringify(state.crate));

  // ---------- Spotify (PKCE, no server) ----------
  const SP = {
    cid: CFG.spotifyClientId,
    redirect: location.origin + "/",
    cache: store.json("ideradio.spcache", {}),
    me: store.json("ideradio.spme", null),
    lists: store.json("ideradio.sppl", {}),
    get tok() { return store.json("ideradio.sp", null) },
    set tok(v) { store.set("ideradio.sp", JSON.stringify(v)) },
    connected() { return !!(this.cid && this.tok) },
    // Spotify only lets accounts the owner has added use the app's API. Everyone else picks from playlist links instead.
    blocked() { return this.connected() && store.get("ideradio.spok") === "0" },
    disconnect() { ["ideradio.sp", "ideradio.spme", "ideradio.spcache", "ideradio.sppl", "ideradio.spok"].forEach(k => store.set(k, "null")); this.me = null; this.cache = {}; this.lists = {}; refresh() },
    async profile() {
      try {
        const r = await this.api("/me"); if (!r.ok) return null;
        const j = await r.json(); this.me = { id: j.id, name: j.display_name || j.id }; store.set("ideradio.spme", JSON.stringify(this.me)); store.set("ideradio.spok", "1"); refresh(); return this.me;
      } catch (e) { if (e && e.message === "forbidden") { store.set("ideradio.spok", "0"); refresh() } return null }
    },
    b64url(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") },
    async login(intent) {
      const verifier = rand(48);
      const challenge = this.b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
      const st = rand(8);
      sessionStorage.setItem("ideradio.pkce", JSON.stringify({ verifier, st, intent }));
      location.assign("https://accounts.spotify.com/authorize?" + new URLSearchParams({
        client_id: this.cid, response_type: "code", redirect_uri: this.redirect, state: st,
        code_challenge_method: "S256", code_challenge: challenge, scope: this.SCOPES,
      }));
    },
    SCOPES: "playlist-modify-private playlist-modify-public playlist-read-private user-library-read user-top-read user-read-recently-played user-modify-playback-state user-read-playback-state",
    canPlay() { const t = this.tok; return !!(t && t.scope && t.scope.includes("user-modify-playback-state")) && !this.blocked() },
    canRead() { const t = this.tok; return !!(t && t.scope && t.scope.includes("user-library-read")) && !this.blocked() },
    async items(path, pick) {
      const r = await this.api(path); if (!r.ok) throw new Error("sp " + r.status);
      return ((await r.json()).items || []).map(pick).filter(t => t && t.name && t.type !== "episode").map(t => ({
        title: t.name, artist: (t.artists || []).map(a => a.name).join(", "),
        artwork: ((t.album || {}).images || []).slice(-2)[0]?.url || null, preview: t.preview_url || null, links: { spotify: (t.external_urls || {}).spotify },
      }));
    },
    liked() { return this.items("/me/tracks?limit=50", x => x.track) },
    top() { return this.items("/me/top/tracks?limit=50&time_range=short_term", x => x) },
    recent() { return this.items("/me/player/recently-played?limit=50", x => x.track) },
    async playlists() {
      const r = await this.api("/me/playlists?limit=50"); if (!r.ok) throw new Error("sp " + r.status);
      // Spotify only lets apps read the songs of playlists you made or collaborate on.
      const me = this.me && this.me.id;
      return ((await r.json()).items || []).filter(p => p && (!me || p.collaborative || (p.owner && p.owner.id === me))).map(p => ({ id: p.id, name: p.name, n: (p.items || p.tracks || {}).total, art: (p.images || [])[0]?.url || null }));
    },
    async playlist(id) {
      try { return await this.items(`/playlists/${id}/items?limit=100`, x => x.item || x.track) }
      catch { return this.items(`/playlists/${id}/tracks?limit=100`, x => x.track) }
    },
    async tokenReq(body) {
      const r = await fetch("https://accounts.spotify.com/api/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: this.cid, ...body }) });
      if (!r.ok) throw new Error("spotify auth");
      const j = await r.json();
      this.tok = { access: j.access_token, refresh: j.refresh_token || (this.tok && this.tok.refresh), exp: Date.now() + (j.expires_in - 60) * 1000, scope: j.scope || (this.tok && this.tok.scope) || "" };
    },
    async callback() {
      const q = new URLSearchParams(location.search);
      if (!q.has("code") && !q.has("error")) return null;
      history.replaceState(null, "", location.pathname + location.hash);
      let saved; try { saved = JSON.parse(sessionStorage.getItem("ideradio.pkce")) } catch {}
      sessionStorage.removeItem("ideradio.pkce");
      if (q.has("error") || !saved || saved.st !== q.get("state")) { toast("Spotify didn't connect"); return null }
      // Connecting the class playlist: the server keeps this sign-in, separate from this phone's own.
      if (saved.intent && saved.intent.action === "station") {
        try {
          const j = await (await fetch("/api/station", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "connect", code: q.get("code"), verifier: saved.verifier, redirect: this.redirect, clientId: this.cid }) })).json();
          if (j.ok) { STATION = await stationInfo(); setTimeout(() => toast("Class playlist is on ✓"), 1500) }
          else setTimeout(() => toast(j.error === "not owner" ? "Run by another account" : "Couldn't connect"), 1500);
        } catch { setTimeout(() => toast("Couldn't connect"), 1500) }
        return null;
      }
      await this.tokenReq({ grant_type: "authorization_code", code: q.get("code"), redirect_uri: this.redirect, code_verifier: saved.verifier });
      await this.profile();
      return saved.intent || {};
    },
    async api(path, opts = {}) {
      let t = this.tok;
      if (!t) throw new Error("not connected");
      if (Date.now() > t.exp && t.refresh) { await this.tokenReq({ grant_type: "refresh_token", refresh_token: t.refresh }); t = this.tok }
      const r = await fetch("https://api.spotify.com/v1" + path, { ...opts, headers: { Authorization: "Bearer " + t.access, "Content-Type": "application/json", ...(opts.headers || {}) } });
      if (r.status === 401) { store.set("ideradio.sp", "null"); refresh(); throw new Error("expired") }
      if (r.status === 403) throw new Error("forbidden");
      return r;
    },
    async find(s) {
      const key = keyOf(s);
      if (key in this.cache) return this.cache[key];
      const direct = s.links && s.links.spotify && s.links.spotify.match(/track\/([A-Za-z0-9]+)/);
      let hit = null;
      if (direct) hit = { uri: "spotify:track:" + direct[1], url: s.links.spotify };
      else {
        for (const q of [`track:${s.title} artist:${s.artist}`, `${s.title} ${s.artist}`]) {
          const r = await this.api("/search?type=track&limit=1&q=" + encodeURIComponent(q));
          if (!r.ok) break;
          const it = (await r.json()).tracks?.items?.[0];
          if (it) { hit = { uri: it.uri, url: it.external_urls.spotify }; break }
        }
      }
      this.cache[key] = hit; store.set("ideradio.spcache", JSON.stringify(this.cache));
      return hit;
    },
    async createPlaylist(name) {
      const body = JSON.stringify({ name, public: false, description: "Made with " + NAME });
      let r = await this.api("/me/playlists", { method: "POST", body });
      if (!r.ok) {
        const me = await (await this.api("/me")).json();
        r = await this.api(`/users/${encodeURIComponent(me.id)}/playlists`, { method: "POST", body });
      }
      if (!r.ok) throw new Error("create");
      return r.json();
    },
    // Spotify retired the old /tracks playlist endpoints (they now always answer 403), so only /items is used.
    async replaceAll(id, uris) {
      const body = JSON.stringify({ uris: uris.slice(0, 100) });
      const r = await this.api(`/playlists/${id}/items`, { method: "PUT", body });
      if (!r.ok) throw new Error("replace " + r.status);
      if (uris.length > 100) await this.addAll(id, uris.slice(100));
    },
    async addAll(id, uris) {
      for (let i = 0; i < uris.length; i += 100) {
        const body = JSON.stringify({ uris: uris.slice(i, i + 100) });
        const r = await this.api(`/playlists/${id}/items`, { method: "POST", body });
        if (!r.ok) throw new Error("add " + r.status);
      }
    },
  };
  // One Spotify playlist per month: updated if we made it before, otherwise created. Used by Save and by Play Full Mix.
  async function spotifyPlaylist(month) {
    const tracks = songsFor(month), uris = [];
    for (const t of tracks) { const f = await SP.find(t); if (f) uris.push(f.uri) }
    const miss = tracks.length - uris.length, known = SP.lists[month];
    if (known) {
      // If last month's playlist was deleted or unfollowed in Spotify, just make a fresh one.
      try { await SP.replaceAll(known.id, uris); return { ...known, n: uris.length, miss, updated: true } }
      catch { delete SP.lists[month]; store.set("ideradio.sppl", JSON.stringify(SP.lists)) }
    }
    const pl = await SP.createPlaylist(NAME + " · " + monthLabel(month));
    await SP.addAll(pl.id, uris);
    SP.lists[month] = { id: pl.id, url: pl.external_urls.spotify }; store.set("ideradio.sppl", JSON.stringify(SP.lists));
    return { ...SP.lists[month], n: uris.length, miss };
  }
  // Only blame approval when Spotify refuses the account itself, not when one request is refused.
  async function spotifyFail(e) {
    if (e && e.message === "forbidden") {
      const me = await SP.api("/me").catch(x => ({ status: x.message === "forbidden" ? 403 : 0 }));
      if (me.status === 403) { store.set("ideradio.spok", "0"); refresh(); return toast("Can't save from here") }
    }
    toast("Couldn't save. Try again");
  }
  async function saveToSpotify(month) {
    if (!SP.connected()) return SP.login({ action: "save", month });
    if (!songsFor(month).length) return toast("Nothing to save yet");
    flashTitle("Saving…", 0);
    try {
      const p = await spotifyPlaylist(month), note = p.miss ? ` · ${p.miss} not on Spotify` : "";
      endFlash(); toast(`${p.updated ? "Updated" : "Saved"} · ${p.n} songs${note}`, { href: p.url, text: "Open in Spotify" });
    } catch (e) { endFlash(); spotifyFail(e) }
  }
  let resolving = false;
  async function resolveSpotify() {
    if (resolving || !SP.connected() || SP.blocked() || state.service !== "spotify") return;
    resolving = true;
    try { for (const s of songsFor(state.month)) { if (keyOf(s) in SP.cache) continue; await SP.find(s); refresh() } }
    catch {} finally { resolving = false }
  }
  // Apple: every song gets its exact Apple Music track (iTunes search is free and open).
  const APC = store.json("ideradio.applecache", {});
  let resolvingA = false;
  async function resolveApple() {
    if (resolvingA || state.service !== "apple") return;
    resolvingA = true;
    try {
      for (const s of songsFor(state.month)) {
        if ((s.links || {}).apple || keyOf(s) in APC) continue;
        const r = await itunes([s.artist, s.title].filter(Boolean).join(" "), 1);
        APC[keyOf(s)] = (r[0] && r[0].links.apple) || null; store.set("ideradio.applecache", JSON.stringify(APC)); refresh();
      }
    } catch {} finally { resolvingA = false }
  }
  // YouTube: the server finds each song's video once and stores it.
  let resolvingY = false;
  async function resolveYt(month = state.month, all = false) {
    if (resolvingY || !db.live) return;
    resolvingY = true;
    try {
      let missing = songsFor(month).filter(s => !s.yt).map(s => s.id);
      while (missing.length) {
        const j = await (await fetch("/api/yt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: missing.slice(0, 10) }) })).json();
        if (!j.enabled) break;
        for (const [id, yt] of Object.entries(j.found || {})) { const s = state.songs.get(id); if (s && yt) s.yt = yt }
        missing = all ? missing.slice(10) : [];
        refresh();
      }
    } catch {} finally { resolvingY = false }
  }
  function resolveLinks() {
    if (state.service === "spotify") resolveSpotify();
    if (state.service === "apple") { resolveApple(); AM.check().then(on => on && refresh()) }
    if (state.service === "youtube") { resolveYt(); YT.preload() }
  }
  const loadScript = src => new Promise((res, rej) => { const el = document.createElement("script"); el.src = src; el.async = true; el.onload = res; el.onerror = rej; document.head.append(el) });

  const YT = {
    cid: CFG.googleClientId, token: null, exp: 0, gis: null,
    preload() {},
    auth(intent) {
      if (this.token && Date.now() < this.exp) return Promise.resolve(this.token);
      const st = rand(8);
      sessionStorage.setItem("ideradio.ytauth", JSON.stringify({ st, intent: intent || { action: "connect" } }));
      location.assign("https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
        client_id: this.cid, redirect_uri: location.origin + "/", response_type: "token", state: st,
        scope: "https://www.googleapis.com/auth/youtube", include_granted_scopes: "true",
      }));
      return new Promise(() => {});
    },
    callback() {
      const q = new URLSearchParams(location.hash.slice(1));
      if (!q.has("access_token") && !q.has("error")) return null;
      history.replaceState(null, "", location.pathname + location.search);
      let saved; try { saved = JSON.parse(sessionStorage.getItem("ideradio.ytauth")) } catch {}
      sessionStorage.removeItem("ideradio.ytauth");
      if (q.has("error") || !saved || saved.st !== q.get("state")) { toast("YouTube didn't connect"); return null }
      this.token = q.get("access_token"); this.exp = Date.now() + (Number(q.get("expires_in") || 3600) - 60) * 1000;
      store.set("ideradio.yt", JSON.stringify({ t: this.token, exp: this.exp })); store.set("ideradio.ytOn", "1");
      return saved.intent || {};
    },
    // Google tokens last an hour; remember that the user connected so we can quietly ask again.
    connected() { return !!(this.cid && store.get("ideradio.ytOn")) },
    restore() { const j = store.json("ideradio.yt", null); if (j && Date.now() < j.exp) { this.token = j.t; this.exp = j.exp } },
    disconnect() { this.token = null; ["ideradio.yt", "ideradio.ytOn"].forEach(k => store.set(k, "")); refresh() },
    async get(path) {
      await this.auth();
      const r = await fetch("https://www.googleapis.com/youtube/v3/" + path, { headers: { Authorization: "Bearer " + this.token } });
      if (!r.ok) throw new Error("yt " + r.status);
      return r.json();
    },
    toSong(sn, vid) {
      let title = clean(sn.title), artist = clean(sn.videoOwnerChannelTitle || sn.channelTitle || "");
      const m = title.match(/^(.+?)\s+[-–]\s+(.+)$/); if (m) { artist = m[1]; title = m[2] }
      return { title, artist, artwork: ((sn.thumbnails || {}).medium || (sn.thumbnails || {}).default || {}).url || null, preview: null, links: { youtube: "https://music.youtube.com/watch?v=" + vid } };
    },
    async liked() { return ((await this.get("videos?part=snippet&myRating=like&maxResults=50")).items || []).map(v => this.toSong(v.snippet, v.id)) },
    async playlists() { return ((await this.get("playlists?part=snippet,contentDetails&mine=true&maxResults=50")).items || []).map(p => ({ id: p.id, name: p.snippet.title, n: p.contentDetails.itemCount, art: null })) },
    async playlist(id) { return ((await this.get("playlistItems?part=snippet&maxResults=50&playlistId=" + id)).items || []).filter(i => i.snippet.resourceId.videoId).map(i => this.toSong(i.snippet, i.snippet.resourceId.videoId)) },
    async post(path, body) {
      const r = await fetch("https://www.googleapis.com/youtube/v3/" + path, { method: "POST", headers: { Authorization: "Bearer " + this.token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error("yt " + r.status);
      return r.json();
    },
  };
  YT.restore();
  async function saveToYouTube(month) {
    if (!songsFor(month).length) return toast("Nothing to save yet");
    await YT.auth({ action: "ytsave", month });
    flashTitle("Saving…", 0);
    await resolveYt(month, true);
    const ids = songsFor(month).map(s => s.yt).filter(Boolean);
    if (!ids.length) { endFlash(); return toast("Not found on YouTube") }
    try {
      const pl = await YT.post("playlists?part=snippet,status", { snippet: { title: NAME + " · " + monthLabel(month), description: "Made with " + NAME }, status: { privacyStatus: "private" } });
      for (const v of ids) await YT.post("playlistItems?part=snippet", { snippet: { playlistId: pl.id, resourceId: { kind: "youtube#video", videoId: v } } });
      const miss = songsFor(month).length - ids.length;
      endFlash(); toast(`Saved · ${ids.length} songs${miss ? ` · ${miss} not found` : ""}`, { href: "https://music.youtube.com/playlist?list=" + pl.id, text: "Open in YouTube Music" });
    } catch { endFlash(); toast("Couldn't save. Try again") }
  }

  // ---------- the class Spotify playlist (one shared playlist per month, rebuilt every night on the server) ----------
  let STATION = { connected: false, lists: {} };
  const stationInfo = () => fetch("/api/station").then(r => r.ok ? r.json() : STATION).catch(() => STATION);
  function stationScreen() {
    return {
      title: "Class Playlist", items: () => {
        const mine = STATION.connected && SP.me && STATION.userId === SP.me.id, pl = STATION.lists[CURRENT];
        if (!STATION.connected) return [
          { head: true, label: "One shared Spotify playlist a month" },
          { label: "Everyone can follow it, and it updates itself every night.", dim: true },
          { label: "Run It From My Spotify", right: "›", hot: true, action: () => SP.login({ action: "station" }) },
        ];
        return [
          { head: true, label: `From ${STATION.user}'s Spotify · every night` },
          pl && { label: `Open ${monthName(CURRENT)} Playlist`, right: "↗", action: () => window.open(pl.url, "_blank", "noopener") },
          mine && { label: "Update Now", sub: STATION.synced ? "last updated " + new Date(STATION.synced).toLocaleString("en", { weekday: "short", hour: "numeric", minute: "2-digit" }) : null, right: "›", action: async () => {
            flashTitle("Updating…", 0);
            try {
              await SP.api("/me"); // refreshes the sign-in if it has expired
              const j = await (await fetch("/api/station", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sync", access: SP.tok.access }) })).json();
              STATION = await stationInfo(); refresh();
              const m = j.out && j.out[CURRENT];
              endFlash(); toast(j.ok ? `Updated · ${m ? m.n : 0} songs` : "Couldn't update. Try again", j.ok && m && m.url ? { href: m.url, text: "Open in Spotify" } : null);
            } catch { endFlash(); toast("Couldn't update. Try again") }
          } },
        ];
      },
    };
  }

  // ---------- Apple Music: needs an Apple Developer MusicKit key on the server; the button stays hidden until then.
  const AM = {
    enabled: false, checked: null, token: null, mk: null,
    check() {
      this.checked = this.checked || fetch("/api/apple-token").then(r => r.ok ? r.json() : {}).then(j => { this.enabled = !!j.enabled; this.token = j.token; return this.enabled }).catch(() => false);
      return this.checked;
    },
    async music() {
      if (!window.MusicKit) {
        await loadScript("https://js-cdn.music.apple.com/musickit/v3/musickit.js");
        if (!window.MusicKit) await new Promise(r => document.addEventListener("musickitloaded", r, { once: true }));
      }
      if (!this.mk) { await MusicKit.configure({ developerToken: this.token, app: { name: NAME, build: "1.2" } }); this.mk = MusicKit.getInstance() }
      return this.mk;
    },
    get connected() { return this.enabled && !!store.get("ideradio.amOn") },
    set connected(v) { store.set("ideradio.amOn", v ? "1" : "") },
    async connect() { const mk = await this.music(); await mk.authorize(); this.connected = true; refresh() },
    async disconnect() { try { (await this.music()).unauthorize() } catch {} this.connected = false; refresh() },
    async get(path) {
      const mk = await this.music(); if (!mk.isAuthorized) await mk.authorize();
      return (await mk.api.music(path)).data.data || [];
    },
    toSong(x) {
      const a = x.attributes || {};
      return { title: a.name, artist: a.artistName || "", artwork: a.artwork ? a.artwork.url.replace("{w}", "300").replace("{h}", "300") : null,
        preview: ((a.previews || [])[0] || {}).url || null, links: a.url ? { apple: a.url } : {} };
    },
    async songs(path) { return (await this.get(path)).filter(x => x.attributes && x.attributes.name).map(x => this.toSong(x)) },
    liked() { return this.songs("/v1/me/library/songs?limit=100") },
    recent() { return this.songs("/v1/me/recent/played/tracks?limit=30") },
    async playlists() { return (await this.get("/v1/me/library/playlists?limit=100")).map(p => ({ id: p.id, name: p.attributes.name, art: null })) },
    playlist(id) { return this.songs(`/v1/me/library/playlists/${id}/tracks?limit=100`) },
  };
  async function saveToApple(month) {
    if (!(await AM.check())) return;
    const tracks = songsFor(month);
    const ids = tracks.map(s => { const u = (s.links || {}).apple || APC[keyOf(s)] || ""; const m = u.match(/[?&]i=(\d+)/) || u.match(/\/song\/[^/]+\/(\d+)/); return m && m[1] }).filter(Boolean);
    if (!ids.length) return toast("Nothing to save yet");
    try {
      const mk = await AM.music();
      await mk.authorize();
      await mk.api.music("/v1/me/library/playlists", undefined, { fetchOptions: { method: "POST", body: JSON.stringify({
        attributes: { name: NAME + " · " + monthLabel(month), description: "Made with " + NAME },
        relationships: { tracks: { data: ids.map(id => ({ id, type: "songs" })) } },
      }) } });
      toast(`Saved ${ids.length} songs ✓`);
    } catch { toast("Couldn't save. Try again") }
  }

  function linkFor(s) {
    const svc = state.service, l = s.links || {};
    if (svc === "youtube" && s.yt) return "https://music.youtube.com/watch?v=" + s.yt;
    if (l[svc]) return l[svc];
    if (svc === "apple" && APC[keyOf(s)]) return APC[keyOf(s)];
    if (svc === "spotify") { const c = SP.cache[keyOf(s)]; if (c) return c.url }
    return SERVICES[svc].url(s.artist ? s.artist + " " + s.title : s.title);
  }

  // ---------- music search (iTunes, no login) ----------
  const mapIt = x => ({
    title: x.trackName, artist: x.artistName,
    artwork: x.artworkUrl100 ? x.artworkUrl100.replace("100x100bb", "300x300bb") : null,
    preview: x.previewUrl || null, links: { apple: x.trackViewUrl }, explicit: x.trackExplicitness === "explicit", clean: x.trackExplicitness === "cleaned",
  });
  // Keep one version of each song, the explicit one when Apple has both, and list explicit versions first.
  const preferExplicit = list => {
    const out = new Map();
    list.forEach((s, i) => { const k = keyOf(s), prev = out.get(k); if (!prev || (s.explicit && !prev.s.explicit)) out.set(k, { s, i: prev ? prev.i : i }) });
    return [...out.values()].sort((a, b) => (!!a.s.clean - !!b.s.clean) || (a.i - b.i)).map(v => v.s);
  };
  const itCache = new Map();
  async function itunes(q, limit = 12, signal) {
    const ck = q + "|" + limit;
    if (itCache.has(ck)) return itCache.get(ck);
    const r = await fetch(`https://itunes.apple.com/search?media=music&entity=song&explicit=Yes&limit=${Math.min(50, limit * 2)}&term=` + encodeURIComponent(q), { signal });
    const raw = ((await r.json()).results || []).filter(x => x.trackName);
    const out = preferExplicit(raw.map(mapIt)).slice(0, limit);
    itCache.set(ck, out); return out;
  }
  // Song search: Deezer first (Apple's open search only hands out clean versions now), iTunes if that fails.
  const dzCache = new Map();
  async function search(q, limit = 15, signal) {
    const ck = q + "|" + limit;
    if (dzCache.has(ck)) return dzCache.get(ck);
    try {
      const r = await fetch(`/api/search?limit=${limit}&q=` + encodeURIComponent(q), { signal });
      if (r.ok) {
        const alt = x => ALT.test(x.title || "") && !ALT.test(q) ? 1 : 0; // originals before remixes, unless you searched for one
        const out = preferExplicit((await r.json()).songs || []).sort((x, y) => alt(x) - alt(y)).slice(0, limit);
        if (out.length) { dzCache.set(ck, out); return out }
      }
    } catch (e) { if (e.name === "AbortError") throw e }
    return itunes(q, limit, signal);
  }
  const clean = s => (s || "").replace(/\s*[\(\[](official|lyric|audio|visuali[sz]er|music video|video|hd|4k)[^\)\]]*[\)\]]/gi, "").replace(/\s+-\s+topic$/i, "").replace(/vevo$/i, "").trim();
  async function readLink(url) {
    const svc = serviceOf(url);
    const oembed = async u => { const r = await fetch(u); if (!r.ok) throw 0; return r.json() };
    try {
      if (svc === "apple") {
        const u = new URL(url); const id = u.searchParams.get("i") || (u.pathname.match(/\/(\d+)(?:$|\?)/) || [])[1];
        if (id) { const j = await (await fetch("https://itunes.apple.com/lookup?entity=song&id=" + id)).json(); const x = (j.results || []).find(r => r.kind === "song"); if (x) return { exact: mapIt(x) } }
      }
      if (svc === "spotify") {
        const j = await oembed("https://open.spotify.com/oembed?url=" + encodeURIComponent(url));
        return { query: j.title, links: { spotify: url }, fallback: { title: j.title, artist: "", artwork: j.thumbnail_url, links: { spotify: url } } };
      }
      if (svc === "youtube") {
        const j = await oembed("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(url));
        let title = clean(j.title), artist = clean(j.author_name);
        const m = title.match(/^(.+?)\s+[-–]\s+(.+)$/); if (m) { artist = m[1]; title = m[2] }
        return { query: artist + " " + title, links: { youtube: url }, fallback: { title, artist, artwork: j.thumbnail_url, links: { youtube: url } } };
      }
      if (svc === "soundcloud") {
        const j = await oembed("https://soundcloud.com/oembed?format=json&url=" + encodeURIComponent(url));
        const m = (j.title || "").match(/^(.+) by (.+)$/);
        const title = m ? m[1] : j.title, artist = m ? m[2] : j.author_name;
        return { query: artist + " " + title, links: { soundcloud: url }, fallback: { title, artist, artwork: j.thumbnail_url, links: { soundcloud: url } } };
      }
    } catch {}
    return { unreadable: true };
  }

  // ---------- suggestions ----------
  const MOODS = ["new year", "love songs", "spring", "rainy day", "sunshine", "summer", "summer night", "road trip", "back to school", "autumn", "cozy", "winter"];
  function vibeLabel() {
    const d = new Date().getDate();
    return d <= 10 ? monthName(CURRENT) + " fresh" : d <= 20 ? monthName(CURRENT) + " mood" : "Last call";
  }
  const vibeQuery = () => { const d = new Date().getDate(); return MOODS[new Date().getMonth()] + (d <= 10 ? " upbeat" : d <= 20 ? "" : " chill") };
  const sugCache = {};
  const exclude = items => {
    const taken = new Set(songsFor(CURRENT).map(keyOf));
    const out = [], seenK = new Set();
    for (const it of items) { const k = keyOf(it); if (!taken.has(k) && !seenK.has(k) && it.preview) { seenK.add(k); out.push(it) } }
    return out;
  };
  function topArtists(rows, n) {
    const c = new Map();
    for (const s of rows) if (s.artist) c.set(s.artist, (c.get(s.artist) || 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  }
  const TABS = {
    foryou: { label: "For you", async load() {
      const hist = [...[...state.songs.values()].filter(s => s.owner_hash === myHash), ...store.json("ideradio.hist", [])];
      const artists = topArtists(hist, 3);
      if (!artists.length) {
        const [v, t] = await Promise.all([search(vibeQuery(), 10), loadCharts()]);
        return [{ h: "Start here", items: exclude([...t.slice(0, 5), ...v]).slice(0, 12) }];
      }
      const groups = await Promise.all(artists.map(async ([a]) => ({ h: "Because you picked " + a, items: exclude(await search(a, 12)).slice(0, 5) })));
      return groups.filter(g => g.items.length);
    } },
    trending: { label: "Trending", async load() { return [{ h: "Top songs right now", items: exclude(await loadCharts()) }] } },
    class: { label: "Class faves", async load() {
      const artists = topArtists([...state.songs.values()], 4);
      if (!artists.length) return [];
      const groups = await Promise.all(artists.map(async ([a, n]) => ({ h: `${a} · picked ${n}×`, items: exclude(await search(a, 10)).slice(0, 4) })));
      return groups.filter(g => g.items.length);
    } },
    vibes: { get label() { return vibeLabel() }, async load() { return [{ h: vibeLabel(), items: exclude(await search(vibeQuery(), 20)) }] } },
  };
  let chartsP;
  function loadCharts() {
    chartsP = chartsP || fetch("/api/charts").then(r => r.ok ? r.json() : {}).then(async j => {
      if (j.songs && j.songs.length) return j.songs;
      if (!j.ids || !j.ids.length) return [];
      const look = await (await fetch("https://itunes.apple.com/lookup?entity=song&id=" + j.ids.join(","))).json();
      const byId = new Map((look.results || []).filter(x => x.kind === "song").map(x => [String(x.trackId), mapIt(x)]));
      return j.ids.map(id => byId.get(String(id))).filter(Boolean);
    }).catch(() => []);
    return chartsP;
  }

  // ---------- one player for everything ----------
  // Three engines share one queue, shuffle, repeat and Now Playing screen:
  //   clip    = 30-second previews (Deezer / Apple), played right here
  //   youtube = full songs through the YouTube player on the iPod screen
  //   spotify = full songs on the listener's own Spotify app (phone, laptop or the speaker), remote-controlled from here
  const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const mkDeck = () => { const a = new Audio(); a.preload = "auto"; a.crossOrigin = "anonymous"; a.playsInline = true; return a };
  const decks = [mkDeck(), mkDeck()], gains = [];
  let pv = decks[0]; // the deck that's playing now
  let vol = Math.min(1, Math.max(0, Number(store.get("ideradio.vol") || 0.8)));
  pv.volume = vol;
  // Route both decks through gain controls (preview servers allow it). iPhones ignore <audio> volume, gains they obey.
  function route() {
    if (gains.length || !ac) return;
    try {
      try { if (navigator.audioSession) navigator.audioSession.type = "playback" } catch {} // play even with the silent switch on
      decks.forEach((a, i) => { const g = ac.createGain(); ac.createMediaElementSource(a).connect(g).connect(ac.destination); gains[i] = g; a.volume = 1 });
      setDeck(pv, 1);
    } catch { gains.length = 0 }
  }
  function setDeck(a, f) {
    const g = gains[decks.indexOf(a)];
    if (g) g.gain.value = vol * f; else a.volume = Math.max(0, Math.min(1, vol * f));
  }
  const otherDeck = () => decks[1 - decks.indexOf(pv)];
  const playOpts = Object.assign({ shuffle: false, repeat: "off" }, store.json("ideradio.play", {})); // repeat: off | all | one
  const savePlay = () => store.set("ideradio.play", JSON.stringify(playOpts));
  const P = {
    engine: null, list: [], order: [], pos: 0, key: null, playing: false, waiting: false,
    cur() { return this.list[this.order[this.pos]] },
    count() { return this.order.length },
  };
  const shuffled = (n, first) => {
    const a = [...Array(n).keys()].filter(i => i !== first);
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
    return first == null ? a : [first, ...a];
  };
  function playList(list, { engine = "clip", at, key = null } = {}) {
    if (!list.length) return toast("Nothing to play yet");
    if (P.engine) engineStop();
    Object.assign(P, { engine, list, key, pos: 0, playing: false, waiting: false });
    if (playOpts.shuffle && list.length > 1) P.order = shuffled(list.length, at);
    else { P.order = [...list.keys()]; P.pos = at || 0 }
    engineStart();
  }
  const previewSong = song => playList([song], { engine: "clip", key: "p:" + keyOf(song) });
  function engineStart() {
    const s = P.cur(); if (!s) return stopAll();
    P.waiting = false; cancelFade(); YTP.cancelFade();
    if (P.engine === "clip") {
      ensurePreview(s).then(() => {
        if (P.cur() !== s || P.engine !== "clip") return;
        if (!s.preview) return P.count() > 1 ? advance(1, true) : (toast("No preview"), stopAll());
        if (ac && ac.state !== "running") ac.resume().catch(() => {});
        setDeck(pv, 1); pv.src = s.preview; pv.currentTime = 0;
        pv.play().catch(() => { P.waiting = true; onPlayback(true) });
        readyNext();
      });
    } else if (P.engine === "youtube") YTP.play(s);
    else if (P.engine === "spotify") SPP.play();
    onPlayback(true);
  }
  function engineStop() {
    cancelFade();
    if (P.engine === "clip") pv.pause();
    if (P.engine === "youtube") YTP.stop();
    if (P.engine === "spotify") SPP.stop();
    P.playing = false;
  }
  function stopAll() { engineStop(); Object.assign(P, { engine: null, list: [], order: [], pos: 0, key: null, waiting: false }); onPlayback(true) }
  const engineTime = () => (P.engine === "clip" ? pv.currentTime : P.engine === "youtube" ? YTP.time() : SPP.progress);
  function advance(d, auto) {
    if (!P.engine) return;
    if (P.engine === "spotify") return SPP.skip(d);
    if (auto && (P.key || "").startsWith("p:")) return stopAll(); // a browsing preview just ends
    if (auto && playOpts.repeat === "one") { P.engine === "clip" ? (pv.currentTime = 0, pv.play().catch(() => {})) : YTP.seek0(); return }
    if (d < 0 && engineTime() > 3) { P.engine === "clip" ? (pv.currentTime = 0) : YTP.seek0(); return }
    let p = P.pos + d;
    if (p >= P.count()) {
      if (playOpts.repeat !== "all") return stopAll();
      p = 0; if (playOpts.shuffle) P.order = shuffled(P.list.length);
    }
    if (p < 0) p = playOpts.repeat === "all" ? P.count() - 1 : 0;
    P.pos = p; engineStart();
  }
  function toggle() {
    if (P.engine === "clip") { P.waiting = false; pv.paused ? pv.play().catch(() => {}) : pv.pause() }
    else if (P.engine === "youtube") YTP.toggle();
    else if (P.engine === "spotify") SPP.toggle();
  }
  // Switch a running queue to another engine (e.g. Spotify isn't open anywhere, so play here instead).
  function switchEngine(engine) {
    if (!P.engine) return;
    engineStop(); P.engine = engine; engineStart();
  }
  function setShuffle(on) {
    playOpts.shuffle = on; savePlay();
    if (P.engine && P.count() > 1) {
      const curIdx = P.order[P.pos];
      P.order = on ? shuffled(P.list.length, curIdx) : [...P.list.keys()];
      P.pos = on ? 0 : curIdx;
      if (P.engine === "spotify") SPP.play(true);
    }
    onPlayback(true);
  }
  function setRepeat(r) { playOpts.repeat = r; savePlay(); if (P.engine === "spotify") SPP.repeat(); onPlayback(true) }

  decks.forEach(a => {
    a.addEventListener("play", () => { if (a === pv && P.engine === "clip") { const hint = P.waiting; P.playing = true; P.waiting = false; onPlayback(hint) } }); // clears "Press ▶❚❚ to start"
    a.addEventListener("pause", () => { if (a === pv && P.engine === "clip" && !a.ended) { P.playing = false; onPlayback() } });
    a.addEventListener("ended", () => { if (a === pv && P.engine === "clip") advance(1, true) });
    a.addEventListener("timeupdate", () => { if (a === pv && P.engine === "clip") { setClock(a.currentTime, a.duration || 30); maybeCrossfade() } });
    // Deezer preview links expire after ~15 minutes; fetch a fresh one when an old link fails.
    a.addEventListener("error", async () => {
      const it = a === pv && P.engine === "clip" && P.cur(), dz = it && (it.links || {}).deezer;
      if (!dz || Date.now() - (it._fresh || 0) < 60000) return;
      it._fresh = Date.now();
      try {
        const j = await (await fetch("/api/search?id=" + dz.split("/").pop())).json();
        if (j.preview && P.cur() === it) { it.preview = j.preview; a.src = j.preview; a.play().catch(() => {}) }
      } catch {}
    });
  });

  // ---------- crossfade: the next song fades in as this one fades out, like Spotify ----------
  const nextPos = () => { let p = P.pos + 1; if (p >= P.count()) { if (playOpts.repeat !== "all") return null; p = 0 } return p };
  const fadeLen = () => (playOpts.repeat === "one" || (P.key || "").startsWith("p:") ? 0 : settings.crossfade || 0);
  const curve = k => [Math.cos(k * Math.PI / 2), Math.sin(k * Math.PI / 2)]; // equal-power: no dip in loudness halfway
  function readyNext() { const np = nextPos(); if (np != null) ensurePreview(P.list[P.order[np]]).then(x => warmUp(x.preview)) }
  let fade = null;
  function maybeCrossfade() {
    const len = fadeLen(), d = pv.duration;
    if (!len || fade || !d || !isFinite(d) || d - pv.currentTime > len) return;
    const np = nextPos(), next = np != null && P.list[P.order[np]];
    if (!next || !next.preview) return; // not ready: the song just ends and the next starts normally
    const out = pv, inn = otherDeck();
    route(); if (ac && ac.state !== "running") ac.resume().catch(() => {});
    setDeck(inn, 0); inn.src = next.preview; inn.currentTime = 0;
    inn.play().catch(() => {});
    pv = inn; P.pos = np; onPlayback(true);
    const ms = Math.max(400, (d - out.currentTime) * 1000), t0 = performance.now();
    fade = { out };
    const step = () => {
      if (!fade) return;
      const [o, i] = curve(Math.min(1, (performance.now() - t0) / ms));
      setDeck(out, o); setDeck(inn, i);
      if (o > 0.001) fade.t = setTimeout(step, 50); else { out.pause(); fade = null; readyNext() }
    };
    step();
  }
  function cancelFade() { if (!fade) return; clearTimeout(fade.t); fade.out.pause(); fade = null; setDeck(pv, 1) }

  const SILENT = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
  let unlocked = false;
  function unlockAudio() {
    if (unlocked) return; unlocked = true;
    try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); ac.resume() } catch {}
    if (!P.engine) decks.forEach(a => { a.muted = true; a.src = SILENT; a.play().then(() => { a.pause(); a.muted = false }).catch(() => { a.muted = false }) });
    route();
    if (ytOn) YTP.create(); // build the YouTube player during this first touch so it's allowed to play with sound later
  }

  // YouTube engine: full songs in a small player on the iPod screen. Two players take turns so songs can crossfade.
  let ytOn = false;
  const YTP = {
    p: [null, null], ready: [null, null], a: 0, api: null, timer: null, kick: null, state: -1, fade: null,
    get player() { return this.p[this.a] },
    load() {
      this.api = this.api || new Promise(res => { window.onYouTubeIframeAPIReady = res; loadScript("https://www.youtube.com/iframe_api").catch(() => res()) });
      return this.api;
    },
    create(i = this.a) {
      this.ready[i] = this.ready[i] || this.load().then(() => new Promise(res => {
        if (!window.YT || !window.YT.Player) { this.ready[i] = null; return res(false) }
        this.p[i] = new window.YT.Player(i ? "ytPlayer2" : "ytPlayer", {
          width: "100%", height: "100%",
          playerVars: { playsinline: 1, controls: 0, modestbranding: 1, rel: 0, disablekb: 1, autoplay: 1, fs: 0, iv_load_policy: 3 },
          events: {
            onReady: e => { e.target.setVolume(vol * 100); res(true) },
            onStateChange: e => this.change(i, e.data),
            onError: () => { if (i === this.a && P.engine === "youtube") advance(1, true) },
          },
        });
      }));
      return this.ready[i];
    },
    async play(s) {
      if (!s.yt && s.id) await findYtFor(s);
      if (P.cur() !== s || P.engine !== "youtube") return;
      if (!s.yt) return advance(1, true);
      if (!(await this.create())) return switchEngine("clip");
      if (P.cur() !== s) return;
      this.player.setVolume(vol * 100); this.player.loadVideoById(s.yt); this.player.playVideo();
      if (!IOS) this.create(1 - this.a); // get the other player ready for the crossfade
      // Phones sometimes refuse to start a video by themselves: show a clear "press play" instead of a frozen screen.
      clearTimeout(this.kick);
      this.kick = setTimeout(() => { if (this.state !== 1 && P.engine === "youtube" && P.cur() === s) { P.waiting = true; onPlayback(true) } }, 2500);
      clearInterval(this.timer);
      this.timer = setInterval(() => this.tick(), 250);
    },
    tick() {
      try { const t = this.player.getCurrentTime(), d = this.player.getDuration() || 0; setClock(t, d); this.maybeFade(t, d) } catch {}
    },
    maybeFade(t, d) {
      const len = fadeLen();
      if (!len || IOS || this.fade || !d || d - t > len || d - t < 0.4 || this.state !== 1) return;
      const b = 1 - this.a, np = nextPos(), next = np != null && P.list[P.order[np]];
      if (!next || !next.yt || !this.p[b] || !this.p[b].loadVideoById) return;
      const out = this.a, pin = this.p[b], pout = this.p[out];
      pin.setVolume(0); pin.loadVideoById(next.yt); pin.playVideo();
      this.a = b; P.pos = np; this.state = -1; onPlayback(true);
      const ms = (d - t) * 1000, t0 = performance.now();
      this.fade = { out };
      const step = () => {
        if (!this.fade) return;
        const [o, i] = curve(Math.min(1, (performance.now() - t0) / ms));
        try { pout.setVolume(vol * 100 * o); pin.setVolume(vol * 100 * i) } catch {}
        if (o > 0.001) this.fade.t = setTimeout(step, 100); else { try { pout.stopVideo() } catch {} this.fade = null }
      };
      step();
    },
    cancelFade() { if (!this.fade) return; clearTimeout(this.fade.t); try { this.p[this.fade.out].stopVideo() } catch {} this.fade = null; this.setVol(vol) },
    change(i, st) {
      if (i !== this.a) return; // the player that's fading out
      this.state = st; if (P.engine !== "youtube") return;
      const hint = P.waiting && st === 1;
      P.playing = st === 1; if (st === 1) P.waiting = false;
      if (st === 0) advance(1, true); else onPlayback(hint);
    },
    toggle() { if (!this.player) return; if (this.state === 1) this.player.pauseVideo(); else { P.waiting = false; this.player.playVideo() } },
    stop() { clearInterval(this.timer); clearTimeout(this.kick); this.cancelFade(); this.p.forEach(x => { try { x && x.stopVideo() } catch {} }); hideVideo() },
    time() { try { return this.player.getCurrentTime() } catch { return 0 } },
    seek0() { try { this.player.seekTo(0, true); this.player.playVideo() } catch {} },
    setVol(v) { try { this.player && this.player.setVolume(v * 100) } catch {} },
  };
  async function findYtFor(s) {
    try {
      const j = await (await fetch("/api/yt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [s.id] }) })).json();
      if (j.found && j.found[s.id]) s.yt = j.found[s.id];
    } catch {}
  }

  // Spotify engine: hands the whole queue to the listener's Spotify, then follows along (so it keeps playing with the phone locked).
  const SPP = {
    uris: [], map: [], poll: null, progress: 0, lastUri: null, volT: null,
    async play(keepPlace) {
      const songs = P.order.map(i => P.list[i]), found = [];
      for (const s of songs) { try { found.push((await SP.find(s)) || null) } catch { found.push(null) } }
      if (P.engine !== "spotify") return;
      this.map = []; this.uris = [];
      found.forEach((f, k) => { if (f) { this.map.push(k); this.uris.push(f.uri) } });
      if (!this.uris.length) return switchEngine(ytOn ? "youtube" : "clip");
      const offset = Math.max(0, this.map.findIndex(k => k >= P.pos));
      const body = { uris: this.uris, offset: { position: offset } };
      if (keepPlace && this.progress) body.position_ms = Math.floor(this.progress * 1000);
      let r;
      try { r = await SP.api("/me/player/play", { method: "PUT", body: JSON.stringify(body) }) } catch (e) { r = { status: e.message === "forbidden" ? 403 : 0 } }
      if (P.engine !== "spotify") return;
      // No Spotify open anywhere (404), no Premium (403) or anything else: play here instead. The badge shows where.
      if (!(r.status >= 200 && r.status < 300)) return switchEngine(ytOn ? "youtube" : "clip");
      await SP.api("/me/player/shuffle?state=false", { method: "PUT" }).catch(() => {}); // we shuffle the queue ourselves
      this.repeat();
      clearInterval(this.poll); this.poll = setInterval(() => this.sync(), 1500); setTimeout(() => this.sync(), 600);
    },
    repeat() { SP.api("/me/player/repeat?state=" + ({ one: "track", all: "context" }[playOpts.repeat] || "off"), { method: "PUT" }).catch(() => {}) },
    async sync() {
      if (P.engine !== "spotify" || document.hidden) return;
      try {
        const r = await SP.api("/me/player"); if (r.status === 204 || !r.ok) return;
        const j = await r.json(), uri = j.item && j.item.uri;
        this.progress = (j.progress_ms || 0) / 1000;
        const was = P.playing; P.playing = !!j.is_playing;
        const idx = this.uris.indexOf(uri);
        if (idx >= 0 && this.map[idx] !== P.pos) { P.pos = this.map[idx]; onPlayback(true) }
        else if (was !== P.playing) onPlayback();
        setClock(this.progress, (j.item && j.item.duration_ms || 0) / 1000);
        // Spotify played past our queue (or switched to something else): we're done.
        if (uri && idx < 0 && this.lastUri && this.uris.includes(this.lastUri)) { clearInterval(this.poll); Object.assign(P, { engine: null, list: [], order: [], pos: 0, key: null, playing: false }); onPlayback(true) }
        this.lastUri = uri;
      } catch {}
    },
    toggle() { const go = P.playing ? "pause" : "play"; P.playing = !P.playing; onPlayback(); SP.api("/me/player/" + go, { method: "PUT" }).catch(() => {}) },
    skip(d) { SP.api("/me/player/" + (d > 0 ? "next" : "previous"), { method: "POST" }).catch(() => {}); setTimeout(() => this.sync(), 500) },
    stop() { clearInterval(this.poll); if (P.playing) SP.api("/me/player/pause", { method: "PUT" }).catch(() => {}) },
    setVol(v) { clearTimeout(this.volT); this.volT = setTimeout(() => SP.api("/me/player/volume?volume_percent=" + Math.round(v * 100), { method: "PUT" }).catch(() => {}), 250) },
  };

  const ytHosts = [$("#ytHost"), $("#ytHost2")];
  function placeVideo() {
    const slot = lcd.querySelector(".lcd-body:not(.out) #npVideo");
    if (P.engine !== "youtube" || !slot) return hideVideo();
    const r = slot.getBoundingClientRect();
    ytHosts.forEach((el, i) => { if (!el) return; if (i === YTP.a) Object.assign(el.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" }); else el.style.left = "-9999px" });
  }
  function hideVideo() { ytHosts.forEach(el => el && (el.style.left = "-9999px")) }

  // ---------- feedback: click sound + haptics ----------
  const settings = Object.assign({ clicker: true, haptics: true, crossfade: 6 }, store.json("ideradio.settings", {}));
  const saveSettings = () => store.set("ideradio.settings", JSON.stringify(settings));
  let ac = null;
  function click() {
    if (!settings.clicker) return;
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const t = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
      o.type = "square"; o.frequency.setValueAtTime(1900, t);
      g.gain.setValueAtTime(0.03, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + 0.02);
    } catch {}
  }
  function buzz(strong) { if (settings.haptics && navigator.vibrate) navigator.vibrate(strong ? 14 : 6) }
  // iPhone only gives web pages haptics when a finger taps a real switch, so every tap target carries one.
  const SW = () => h("input", { type: "checkbox", switch: true, class: "hsw", tabindex: "-1", "aria-hidden": "true" });
  function onTap(el, fn) {
    el.addEventListener("click", e => { if (e.target.tagName === "INPUT") return; fn(e) });
    el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); fn(e) } });
    return el;
  }
  const tapLabel = (attrs, fn, ...kids) => onTap(h("label", Object.assign({ role: "button", tabindex: "0" }, attrs), settings.haptics ? SW() : null, ...kids), fn);
  const tickFx = () => { click(); buzz() };
  // ---------- the iPod itself: editions, hold switch, backlight ----------
  // Model = the shape (classic, mini, nano); finish = the colour. Both are remembered on this device.
  const MODELS = {
    classic: { name: "Classic", w: 415, h: 692, lw: 289, lh: 239, lt: 30, ww: 350, wt: 30, r: 38 },
    mini:    { name: "mini",    w: 356, h: 640, lw: 274, lh: 214, lt: 26, ww: 292, wt: 34, r: 40 },
    nano:    { name: "nano",    w: 304, h: 660, lw: 252, lh: 198, lt: 26, ww: 254, wt: 64, r: 26 },
  };
  const FINISHES = {
    white:  { name: "White", swatch: "#d9d9d9" },  black: { name: "Black", swatch: "#2c2c2e" },
    chrome: { name: "Chrome", swatch: "#b8c0c8" }, u2: { name: "U2 Special Edition", short: "U2", swatch: "#d11a2a" },
    silver: { name: "Silver", swatch: "#c4c7cb" }, blue: { name: "Blue", swatch: "#79a9d6" }, pink: { name: "Pink", swatch: "#e98fb7" },
    green:  { name: "Green", swatch: "#a5cc6b" },  gold: { name: "Gold", swatch: "#d6bd7f" },
  };
  const oldEd = (store.get("ideradio.edition") || "").replace(/^mini-/, "").replace(/^classic$/, "white");
  let model = MODELS[store.get("ideradio.model")] ? store.get("ideradio.model") : "classic";
  let finish = FINISHES[oldEd] ? oldEd : "white";
  function applyLook(animate) {
    store.set("ideradio.model", model); store.set("ideradio.edition", finish);
    const ip = $("#ipod"), m = MODELS[model], root = document.documentElement.style;
    const go = () => {
      for (const k of ["w", "h", "lw", "lh", "lt", "ww", "wt", "r"]) root.setProperty("--ip-" + k, m[k] + "px");
      ip.dataset.ed = finish; ip.dataset.model = model; fit(); refresh();
    };
    if (animate && !reduce) { ip.parentElement.animate([{ transform: "none" }, { transform: "scale(.965) rotateY(8deg)" }, { transform: "none" }], { duration: 520, easing: "cubic-bezier(.22,1,.36,1)" }); setTimeout(go, 160) }
    else go();
  }
  // Like the real thing, the backlight dims after a while and wakes on any touch.
  let wakeT;
  function wake() { document.body.classList.remove("dim"); clearTimeout(wakeT); wakeT = setTimeout(() => document.body.classList.add("dim"), 45000) }
  ["pointerdown", "keydown"].forEach(ev => addEventListener(ev, wake, { passive: true }));
  wake();

  // ---------- the screen: a stack of iPod menus ----------
  const lcd = $("#lcd"), wheel = $("#wheel"), disc = $("#disc");
  const stack = [];
  const cur = () => stack[stack.length - 1];
  const selectable = it => it && !it.head && !it.dim;
  function push(s) { s.sel = s.sel || 0; stack.push(s); render("in-r") }
  function pop() {
    if (stack.length <= 1) return false;
    if (P.key && P.key.startsWith("p:")) stopAll();
    stack.pop(); render("in-l");
    if (stack.length === 1 && state.crate.length && !state.busy) submitCrate();
    return true;
  }
  function openNP() { if (cur() && cur().kind === "np") return render(null); push({ title: "Now Playing", kind: "np" }) }
  const itemsOf = s => (typeof s.items === "function" ? s.items() : s.items || []).filter(Boolean);
  const titleOf = s => (typeof s.title === "function" ? s.title() : s.title);

  let flash = null, flashT;
  function flashTitle(msg, ms = 2200) {
    flash = msg; clearTimeout(flashT);
    paintTitle();
    if (ms) flashT = setTimeout(() => { flash = null; paintTitle() }, ms);
  }
  const endFlash = () => { clearTimeout(flashT); flash = null; paintTitle() };
  function paintTitle() {
    for (const t of lcd.querySelectorAll(".lcd-title .tt")) { t.textContent = flash || titleOf(cur()); t.classList.toggle("flash", !!flash) }
  }
  function titleBar() {
    return h("div", { class: "lcd-title" },
      h("span", { class: "st" }, isAnyPlaying() ? "▶" : nowItem() ? "❚❚" : ""),
      h("span", { class: "tt" + (flash ? " flash" : "") }, flash || titleOf(cur())),
      h("span", { class: "bat" }, h("i")),
      state.crate.length ? h("span", { class: "crate-n", "aria-label": state.crate.length + " in crate" }, state.crate.length) : null);
  }
  function clampSel(s, items) {
    if (!items.length) { s.sel = 0; return }
    s.sel = Math.max(0, Math.min(items.length - 1, s.sel));
    if (!selectable(items[s.sel])) { const j = items.findIndex(selectable); s.sel = j < 0 ? s.sel : j }
  }
  // Menu icons: one drawn set (white on a coloured tile), so every row looks the same on every phone.
  const NOTE = '<path d="M9.5 17.5V6l9-2.2v11.7" fill="none"/><circle cx="7" cy="17.5" r="2.6"/><circle cx="16" cy="15.5" r="2.6"/>';
  const ICON = {
    "+": '<path d="M12 5.5v13M5.5 12h13" fill="none"/>',
    "i": '<path d="M12 11v6.5" fill="none"/><circle cx="12" cy="7.2" r="1.4" stroke="none"/>',
    "↻": '<path d="M19 12a7 7 0 1 1-2.1-5M19 4.5v4h-4" fill="none"/>',
    "⇄": '<path d="M4 7.5h3.5c4.5 0 4.5 9 9 9H20M4 16.5h3.5c1.6 0 2.6-1.1 3.4-2.6M13.1 10.1c.8-1.5 1.8-2.6 3.4-2.6H20M17.5 5l2.5 2.5-2.5 2.5M17.5 14l2.5 2.5-2.5 2.5" fill="none"/>',
    "≋": '<path d="M4 8.5c2-2 4 2 6 0s4 2 6 0 3 1 4 0M4 12.5c2-2 4 2 6 0s4 2 6 0 3 1 4 0M4 16.5c2-2 4 2 6 0s4 2 6 0 3 1 4 0" fill="none"/>',
    "⌕": '<circle cx="10.5" cy="10.5" r="5.5" fill="none"/><path d="M14.8 14.8l4.7 4.7" fill="none"/>',
    "▤": '<path d="M4.5 9h15v10h-15zM4.5 9l2-3.5h11l2 3.5M9.5 12.5h5" fill="none"/>',
    "▶": '<path d="M8.5 5.8l10 6.2-10 6.2z" stroke-linejoin="round"/>',
    "◉": '<rect x="6.5" y="3.5" width="11" height="17" rx="2.5" fill="none"/><circle cx="12" cy="14.5" r="3" fill="none"/><circle cx="12" cy="8" r="1.2" stroke="none"/>',
    "◷": '<circle cx="12" cy="12" r="7.5" fill="none"/><path d="M12 8v4.3l3 1.8" fill="none"/>',
    "★": '<path d="M12 4l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.4l-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z" stroke-linejoin="round"/>',
    "☺": '<circle cx="12" cy="12" r="7.5" fill="none"/><path d="M9 13.8c1.6 1.7 4.4 1.7 6 0" fill="none"/><circle cx="9.5" cy="10" r="1" stroke="none"/><circle cx="14.5" cy="10" r="1" stroke="none"/>',
    "♥": '<path d="M12 19s-6.5-4.1-6.5-9.2A3.7 3.7 0 0 1 12 7.6a3.7 3.7 0 0 1 6.5 2.2C18.5 14.9 12 19 12 19z" stroke-linejoin="round"/>',
    "♪": NOTE, "♫": NOTE,
    "⚙": '<circle cx="12" cy="12" r="2.6" fill="none"/><path d="M12 3.8v2.4M12 17.8v2.4M3.8 12h2.4M17.8 12h2.4M6.2 6.2l1.7 1.7M16.1 16.1l1.7 1.7M6.2 17.8l1.7-1.7M16.1 7.9l1.7-1.7" fill="none"/><circle cx="12" cy="12" r="5.6" fill="none"/>',
    "↗": '<path d="M7 17L17 7M9.5 7H17v7.5" fill="none"/>',
    "☾": '<path d="M19 14.5A7.5 7.5 0 1 1 9.5 5a6 6 0 0 0 9.5 9.5z" stroke-linejoin="round"/>',
  };
  function icoEl(icon) {
    const el = h("span", { class: "ico", style: "--c:" + icon[1], "aria-hidden": "true" });
    if (ICON[icon[0]]) el.innerHTML = '<svg viewBox="0 0 24 24" fill="#fff" stroke="#fff" stroke-width="2.1" stroke-linecap="round">' + ICON[icon[0]] + "</svg>";
    else el.textContent = icon[0];
    return el;
  }
  function rowEl(it, i, s) {
    const cls = "mi" + (it.head ? " head" : "") + (it.dim ? " dim" : "") + (it.hot ? " hot" : "") + (it.art !== undefined ? " song" : "") + (i === s.sel ? " sel" : "") + (it.playing ? " playing" : "");
    const row = h("label", { class: cls, "data-i": i, role: it.head ? "presentation" : "option" },
      selectable(it) && settings.haptics ? SW() : null,
      it.icon ? icoEl(it.icon) : null,
      it.art !== undefined ? h("span", { class: "art", style: it.art ? `background-image:url("${encodeURI(it.art)}")` : null }) : null,
      h("span", { class: "lbl" }, it.ex ? h("span", { class: "ex", "aria-label": "explicit" }, "E") : null, it.label, it.sub ? h("span", { class: "sub" }, it.sub) : null),
      it.right ? h("span", { class: "rt" + (String(it.right).length > 2 ? " txt" : "") }, it.right) : null);
    onTap(row, () => { if (!selectable(it)) return; s.sel = i; mark(); unlockAudio(); activate() });
    return h("li", { role: "none" }, row);
  }
  function bodyFor(s, anim) {
    const body = h("div", { class: "lcd-body" + (anim ? " " + anim : "") + (s.foot ? " has-foot" : "") + (s.input ? " has-inp" : "") });
    if (s.kind === "np") body.append(npView());
    else if (s.kind === "text") body.append(h("div", { class: "txt" }, s.text));
    else if (s.kind === "boot") body.append(s.view);
    else {
      if (s.input) body.append(s.input());
      const items = itemsOf(s); s._items = items; clampSel(s, items);
      body.append(h("ul", { class: "menu", role: "listbox" }, items.map((it, i) => rowEl(it, i, s))));
    }
    if (s.foot) { const f = s.foot(); if (f) body.append(f) }
    const sb = sendBar(); if (sb) { body.querySelector(".foot")?.remove(); body.append(sb); body.classList.add("has-foot") }
    return body;
  }
  function render(anim) {
    const s = cur(); if (!s) return;
    const body = bodyFor(s, reduce ? null : anim);
    const old = lcd.querySelector(".lcd-body:not(.out)");
    if (old) {
      if (anim && !reduce) { old.classList.add("out", anim === "in-r" ? "out-l" : "out-r"); setTimeout(() => old.remove(), 340) }
      else old.remove();
    }
    const t = lcd.querySelector(".lcd-title"); if (t) t.replaceWith(titleBar()); else lcd.prepend(titleBar());
    lcd.append(body);
    scrollSel(false);
    requestAnimationFrame(() => placeVideo());
    if (s.kind === "np") setTimeout(placeVideo, 360);
    if (s.onShow) s.onShow();
    tagline(); setTint();
  }
  // The page takes a soft colour from the screen you're on, like the old iPod posters. Sub-screens keep their parent's colour.
  const TINT_OF = { [NAME]: "blue", "This Month": "pink", "Now Playing": "orange", "Add Songs": "green", "Your Crate": "orange", Archive: "yellow", Settings: "purple", "My Music": "purple" };
  const tintOf = x => x.tint || TINT_OF[titleOf(x)] || (/^My /.test(titleOf(x) || "") ? "purple" : null);
  function setTint() {
    const p = stack.slice().reverse().find(tintOf);
    const t = p ? tintOf(p) : "blue";
    if (document.body.dataset.tint === t) return;
    document.body.dataset.tint = t;
    setTimeout(() => { const c = getComputedStyle(document.body).backgroundColor; document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.content = c) }, 700);
  }
  // Repaint the current list in place (live data, playing marks) without moving the user.
  function refresh() {
    const s = cur(); if (!s) return;
    const t = lcd.querySelector(".lcd-title"); if (t) t.replaceWith(titleBar());
    tagline();
    if (s.kind === "np") return;
    const body = lcd.querySelector(".lcd-body:not(.out)"); if (!body) return;
    const ul = body.querySelector(".menu"); if (!ul) return;
    const top = ul.scrollTop, items = itemsOf(s); s._items = items; clampSel(s, items);
    put(ul, items.map((it, i) => rowEl(it, i, s)));
    ul.scrollTop = top;
    body.querySelector(".foot")?.remove(); body.querySelector(".sendbar")?.remove();
    const sb = sendBar(), f = !sb && s.foot && s.foot();
    if (sb) body.append(sb); else if (f) body.append(f);
    body.classList.toggle("has-foot", !!(sb || f));
  }
  function mark() {
    const s = cur();
    lcd.querySelectorAll(".lcd-body:not(.out) .mi").forEach(li => li.classList.toggle("sel", +li.dataset.i === s.sel));
    scrollSel(true);
    if (s.auto) autoPreview(s);
  }
  // Like an iPod: the highlight walks to the edge, then the list glides one row at a time to keep it in view.
  let glide = null;
  function scrollSel(smooth) {
    const row = lcd.querySelector(`.lcd-body:not(.out) .mi[data-i="${cur().sel}"]`); if (!row) return;
    const ul = row.closest(".menu"), top = row.offsetTop, bot = top + row.offsetHeight;
    const goal = glide && glide.ul === ul ? glide.to : ul.scrollTop;
    let to = goal;
    if (top < goal) to = Math.max(0, top);
    else if (bot > goal + ul.clientHeight) to = bot - ul.clientHeight;
    if (to === goal) return;
    if (!smooth || reduce) { glide = null; ul.scrollTop = to; return }
    const from = ul.scrollTop, t0 = performance.now(), g = glide = { ul, to };
    const step = t => {
      if (glide !== g) return;
      const k = Math.min(1, (t - t0) / 120);
      ul.scrollTop = from + (to - from) * (1 - Math.pow(1 - k, 3));
      if (k < 1) requestAnimationFrame(step); else glide = null;
    };
    requestAnimationFrame(step);
  }
  function move(d) {
    const s = cur(); if (!s) return;
    if (s.kind === "np") return volume(d);
    const items = s._items || []; let i = s.sel;
    do { i += d } while (i >= 0 && i < items.length && !selectable(items[i]));
    if (i < 0 || i >= items.length) return;
    s.sel = i; tickFx(); mark();
  }
  function activate() {
    const s = cur(); if (!s) return;
    if (s.kind === "np") { const it = nowItem(); return it && it.id ? toggleLike(it) : playPause() }
    const it = (s._items || [])[s.sel];
    if (selectable(it) && it.action) { buzz(true); click(); it.action(it) }
  }
  // Instagram-style: rest on a song for a moment and it starts playing.
  // Songs from Spotify / YouTube / Apple links have no clip of their own: borrow one from search, once per song.
  // The clip found for a song is remembered by title + artist, not on one copy of the song: the song list reloads
  // every so often with fresh copies, and a clip stuck to an old copy was lost (that's why Mimesis went quiet again).
  const pvLook = new Map();
  const pvApply = (song, x) => { if (x && x.preview && !song.preview) { song.preview = x.preview; song.artwork = song.artwork || x.artwork; song.explicit = song.explicit || x.explicit } return song };
  function ensurePreview(song) {
    if (song.preview) return Promise.resolve(song);
    const k = keyOf(song), q = [(song.artist || "").split(",")[0], song.title].filter(Boolean).join(" ");
    let job = pvLook.get(k);
    if (!job || (job.done && !job.hit && Date.now() - job.at > 60000)) { // a failed lookup is tried again a minute later
      job = { at: Date.now(), done: false, hit: null };
      job.p = (async () => {
        try { const d = bestMatch(song, await search(q, 3)); if (d && d.preview) return d } catch {}
        // Some labels block Deezer's clip for a song; Apple usually has one.
        try { const a = bestMatch(song, await itunes(q, 5)); if (a && a.preview) return a } catch {}
        return null;
      })().then(x => { job.hit = x; job.done = true; return x });
      pvLook.set(k, job);
    }
    return job.p.then(x => pvApply(song, x));
  }
  // Pick the same recording: same title and artist, and no remix / live / cover version unless that's what was asked for.
  const norm = t => (t || "").toLowerCase().replace(/\s*[\(\[][^\)\]]*[\)\]]/g, "").replace(/\s+-\s+.*$/, "").replace(/[^a-z0-9\u00c0-\uffff]+/g, " ").trim();
  const ALT = /remix|mix\)|live|acoustic|karaoke|instrumental|cover|tribute|sped up|slowed|reverb|8.?bit|lullaby|version|edit\b|demo/i;
  function bestMatch(song, list) {
    const t = norm(song.title), a = norm((song.artist || "").split(",")[0]), wantAlt = ALT.test(song.title || "");
    let best = null, top = -1;
    for (const x of list) {
      let sc = 0;
      if (norm(x.title) === t) sc += 4; else if (norm(x.title).startsWith(t)) sc += 1;
      if (a && norm(x.artist).includes(a)) sc += 3;
      if (!wantAlt && ALT.test(x.title || "")) sc -= 3;
      if (x.preview) sc += 1;
      if (sc > top) { top = sc; best = x }
    }
    return top >= 4 ? best : null; // at least the same title, or a close title by the same artist
  }
  // Keep the next few clips loading in the background so a resting finger starts music almost at once.
  const warm = new Map();
  function warmUp(url) {
    if (!url || warm.has(url)) return;
    const a = new Audio(); a.preload = "auto"; a.muted = true; a.src = url; warm.set(url, a);
    if (warm.size > 6) { const [k, old] = warm.entries().next().value; old.src = ""; warm.delete(k) }
  }
  function prefetchAround(s) {
    const items = s._items || [];
    for (let d = 0; d <= 3; d++) for (const i of d ? [s.sel + d, s.sel - d] : [s.sel]) {
      const it = items[i]; if (it && it.song) ensurePreview(it.song).then(x => warmUp(x.preview));
    }
  }
  let apT;
  function autoPreview(s) {
    clearTimeout(apT);
    prefetchAround(s);
    apT = setTimeout(() => {
      if (cur() !== s || !unlocked) return;
      if (P.engine && P.playing && !(P.key || "").startsWith("p:")) return; // don't cut into the mix
      const it = (s._items || [])[s.sel];
      if (!it || !it.song) return;
      const song = it.song;
      ensurePreview(song).then(() => {
        const now = (s._items || [])[s.sel];
        if (cur() !== s || !now || now.song !== song || !song.preview) return;
        if (P.key !== "p:" + keyOf(song)) previewSong(song);
      });
    }, 320);
  }

  let alertT;
  function alertBox(msg, link, face) {
    const old = lcd.querySelector(".alert"); if (old) old.remove();
    const a = h("div", { class: "alert", role: "alert" }, face ? h("img", { class: "smiley", src: "smileys/" + face, alt: "" }) : null, h("div", {}, msg), link ? h("a", { href: link.href, target: "_blank", rel: "noopener" }, link.text) : null);
    lcd.append(a); clearTimeout(alertT); alertT = setTimeout(() => a.remove(), link ? 6500 : 2200);
  }

  // ---------- now playing: one screen for every engine ----------
  const nowItem = () => (P.engine ? P.cur() : null);
  const isAnyPlaying = () => !!P.engine && P.playing;
  const sameSong = (a, b) => !!a && !!b && (a === b || (a.id && a.id === b.id));
  const isPlaying = s => !!P.engine && sameSong(P.cur(), s);
  const clock = t => { t = Math.max(0, Math.floor(t || 0)); return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0") };
  function setClock(c, d) {
    const bar = lcd.querySelector("#npBar"); if (!bar) return;
    bar.style.width = d ? Math.min(100, c / d * 100) + "%" : "0";
    $("#npNow").textContent = clock(c); $("#npLeft").textContent = "-" + clock(Math.max(0, d - c));
  }
  const SRC = { clip: "Preview", youtube: "YouTube", spotify: "Spotify" };
  let npShown = null;
  function npView() {
    const it = nowItem();
    setTimeout(() => { npShown = it }, 0);
    if (!it) return h("div", { class: "txt" }, "Nothing playing. Press ▶❚❚ to play this month's mix.");
    const video = P.engine === "youtube", liked = isLiked(it);
    const icon = k => { const e = h("span", { class: "mi-svg" }); e.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">' + ICON[k] + "</svg>"; return e };
    const modes = [
      tapLabel({ class: "np-mode" + (playOpts.shuffle ? " on" : ""), "aria-label": "Shuffle " + (playOpts.shuffle ? "on" : "off"), "aria-pressed": String(playOpts.shuffle) },
        () => { click(); setShuffle(!playOpts.shuffle) }, icon("⇄")),
      tapLabel({ class: "np-mode" + (playOpts.repeat !== "off" ? " on" : ""), "aria-label": "Repeat " + playOpts.repeat, "aria-pressed": String(playOpts.repeat !== "off") },
        () => { click(); setRepeat({ off: "all", all: "one", one: "off" }[playOpts.repeat]) },
        icon("↻"), playOpts.repeat === "one" ? h("b", {}, "1") : null),
    ];
    return h("div", { class: "np" + (video ? " video" : "") },
      h("div", { class: "np-count" }, h("span", {}, P.count() > 1 ? `${P.pos + 1} of ${P.count()}` : ""), h("span", { class: "np-src " + P.engine }, SRC[P.engine]), h("span", { class: "np-modes" }, modes)),
      h("div", { class: "np-mid" },
        video ? h("div", { class: "np-art np-video", id: "npVideo" }) : h("div", { class: "np-art" + (it !== npShown ? " new" : ""), style: it.artwork ? `background-image:url("${encodeURI(it.artwork)}")` : null }),
        h("div", { style: "min-width:0" },
          h("div", { class: "np-t" }, it.explicit ? h("span", { class: "ex" }, "E") : null, it.title),
          h("div", { class: "np-a" }, it.artist || ""),
          it.name ? h("div", { class: "np-by" }, "picked by " + it.name) : null,
          it.id ? h("div", { class: "np-like" + (liked ? " on" : "") }, (liked ? "♥ " : "♡ ") + likesOf(it)) : null)),
      P.waiting ? h("div", { class: "np-hint" }, "Press ▶❚❚ to start") : null,
      h("div", {}, h("div", { class: "np-bar" }, h("i", { id: "npBar" })), h("div", { class: "np-time" }, h("span", { id: "npNow" }, "0:00"), h("span", { id: "npLeft" }, "-0:00"))),
      h("div", { class: "vol", id: "vol" }, "−", h("div", { class: "np-bar" }, h("i", { style: `width:${vol * 100}%` })), "+"));
  }
  let lastNow = null, volT;
  function onPlayback(force) {
    const it = nowItem();
    if (cur() && cur().kind === "np" && (force || it !== lastNow)) render(null);
    else refresh();
    lastNow = it;
  }
  function volume(d) {
    vol = Math.max(0, Math.min(1, Math.round((vol + d * 0.05) * 100) / 100));
    if (!fade) setDeck(pv, 1); YTP.setVol(vol); if (P.engine === "spotify") SPP.setVol(vol);
    store.set("ideradio.vol", vol); tickFx();
    const v = lcd.querySelector("#vol"); if (!v) return;
    v.classList.add("show"); v.querySelector("i").style.width = vol * 100 + "%";
    clearTimeout(volT); volT = setTimeout(() => v.classList.remove("show"), 1400);
  }
  // Which engine plays full songs for this listener.
  function fullEngine() {
    if (state.service === "spotify" && SP.canPlay()) return "spotify";
    return ytOn ? "youtube" : "clip";
  }
  function playFullMix(k, at) {
    if (P.engine && P.key === "m:" + k && at == null) { if (!P.playing) toggle(); return openNP() }
    const t = songsFor(k); if (!t.length) return toast("Nothing to play yet");
    const engine = fullEngine();
    playList(t, { engine, key: "m:" + k, at }); openNP();
  }
  function startMix(k = CURRENT) { playList(songsFor(k), { engine: "clip", key: "c:" + k }); openNP() }
  function playPause() { if (P.engine) return toggle(); playFullMix(state.month) }
  function next(d) { if (P.engine) return advance(d); playFullMix(state.month) }

  // ---------- likes: ♥ a song with the centre button on Now Playing, or from the song's screen ----------
  const liked = new Set(store.json("ideradio.liked", []));
  const isLiked = s => !!s && !!s.id && liked.has(s.id);
  // The song list reloads with fresh copies, so the count is read from the newest copy.
  const likesOf = s => ((s.id && state.songs.get(s.id)) || s).likes || 0;
  async function toggleLike(s) {
    if (!s || !s.id) return;
    const on = !liked.has(s.id);
    on ? liked.add(s.id) : liked.delete(s.id); store.set("ideradio.liked", JSON.stringify([...liked]));
    s.likes = Math.max(0, (s.likes || 0) + (on ? 1 : -1));
    const live = state.songs.get(s.id); if (live && live !== s) live.likes = s.likes;
    if (on) heartBurst();
    buzz(true); paintLike(s);
    try {
      const j = await (await fetch("/api/likes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, id: s.id, like: on }) })).json();
      if (typeof j.likes === "number") { s.likes = j.likes; if (live) live.likes = j.likes; paintLike(s); refresh() }
    } catch {}
  }
  // Update the ♥ on Now Playing in place, without redrawing (and re-animating) the screen.
  function paintLike(s) {
    const el = lcd.querySelector(".lcd-body:not(.out) .np-like");
    if (el && sameSong(nowItem(), s)) { el.classList.toggle("on", isLiked(s)); el.textContent = (isLiked(s) ? "♥ " : "♡ ") + likesOf(s) }
    else refresh();
  }
  function heartBurst() {
    if (reduce) return;
    const b = h("div", { class: "heart-burst", "aria-hidden": "true" }, "♥");
    lcd.append(b); setTimeout(() => b.remove(), 900);
  }

  // ---------- menus ----------
  const svcName = () => SERVICES[state.service].name;
  function statusFoot() {
    const m = mine().length, ms = timeLeft(), days = Math.ceil(ms / 864e5), hrs = Math.ceil(ms / 36e5);
    const left = days > 1 ? `${days} days left` : `${hrs}h left`;
    return h("div", { class: "foot" + ((m === 0 || (days <= 3 && m < MAX)) ? " urgent" : "") },
      m === 0 ? `${left} · you're not in yet` : m >= MAX ? `${left} · you're in, 5 of 5` : `${left} · you're in, ${m} of 5`);
  }
  const MAIN = {
    title: NAME, items: () => [
      nowItem() && { icon: ["♪", "#ff2e88"], label: "Now Playing", right: "›", action: openNP },
      { icon: ["★", "#2f7ff0"], label: "This Month", sub: `${monthName(CURRENT)} mix · ${songsFor(CURRENT).length} song${songsFor(CURRENT).length === 1 ? "" : "s"}${mine().length ? " · you're in" : ""}`, right: "›", action: () => push(monthScreen(CURRENT)) },
      { icon: ["+", "#22b455"], label: "Add Songs", right: "›", hot: mine().length === 0, action: () => push(addScreen()) },
      myMusicItem(),
      state.crate.length && { icon: ["▤", "#ff8a00"], label: `Your Crate (${state.crate.length})`, right: "›", hot: true, action: () => push(crateScreen()) },
      { icon: ["◷", "#8a5cff"], label: "Archive", right: "›", action: () => push(archiveScreen()) },
      { icon: ["◉", "#0fb5a8"], label: "Play Full Mix", right: "▶", action: () => playFullMix(CURRENT) },
      { icon: ["⇄", "#ff8a00"], label: "Shuffle Full Mix", right: "›", action: () => {
        // Like the iPod: starts the month's mix in shuffled order.
        if (P.engine && P.key === "m:" + CURRENT) { if (!playOpts.shuffle) setShuffle(true); return openNP() }
        playOpts.shuffle = true; savePlay(); playFullMix(CURRENT);
      } },
      { icon: ["⚙", "#7a8794"], label: "Settings", right: "›", action: () => push(settingsScreen()) },
    ],
  };
  function serviceItems(k) {
    const t = songsFor(k); if (!t.length) return [];
    if (state.service === "spotify" && SP.cid) return [
      STATION.lists[k] && { icon: ["♫", "#1db954"], label: "Class Playlist on Spotify", sub: "updates every night", right: "↗", action: () => window.open(STATION.lists[k].url, "_blank", "noopener") },
      !SP.blocked() && { icon: ["♫", "#1db954"], label: !SP.connected() ? "Connect Spotify" : SP.lists[k] ? "Update My Copy" : "Save My Own Copy", right: "›", action: () => saveToSpotify(k) },
    ];
    if (state.service === "youtube") {
      const ids = t.map(s => s.yt).filter(Boolean).slice(0, 50);
      return [
        ids.length ? { label: "Play All on YouTube", right: "↗", action: () => window.open("https://www.youtube.com/watch_videos?video_ids=" + ids.join(","), "_blank", "noopener") } : null,
        YT.cid ? { label: "Save to YouTube", right: "›", action: () => saveToYouTube(k) } : null,
      ];
    }
    if (state.service === "apple" && AM.enabled) return [{ label: "Save to Apple Music", right: "›", action: () => saveToApple(k) }];
    return [];
  }
  function monthScreen(k) {
    return {
      tint: "pink", auto: true, title: () => (k === CURRENT ? "This Month" : monthLabel(k)),
      onShow: () => { state.month = k; resolveLinks() },
      items: () => {
        const t = songsFor(k), rows = [];
        if (t.length) rows.push({ icon: ["◉", "#0fb5a8"], label: "Play Full Mix", right: "▶", action: () => playFullMix(k) }, { icon: ["▶", "#ff2e88"], label: "Preview Mix (30s each)", right: "›", action: () => startMix(k) });
        rows.push(...serviceItems(k));
        if (!t.length) {
          rows.push({ label: state.loaded ? "Dead air. No songs yet" : "Tuning in…", dim: true });
          if (k === CURRENT) rows.push({ label: "Be the First", right: "›", hot: true, action: () => push(addScreen()) });
        } else {
          const dj = new Set(t.map(s => s.owner_hash)).size;
          const row = s => ({ label: s.title, sub: [s.artist, s.name || "anon", s.likes ? (isLiked(s) ? "♥ " : "♡ ") + s.likes : null].filter(Boolean).join(" · "), art: s.artwork || "", song: s, ex: s.explicit, playing: isPlaying(s), right: "›", action: () => push(songScreen(s)) });
          const yours = t.filter(s => s.owner_hash && s.owner_hash === myHash), rest = t.filter(s => !yours.includes(s));
          if (yours.length) rows.push({ head: true, label: `Your picks · ${yours.length} of ${MAX}` }, ...yours.map(row));
          if (rest.length) rows.push({ head: true, label: `${yours.length ? "Everyone else" : t.length + " songs"} · ${dj} DJ${dj === 1 ? "" : "s"}` }, ...rest.map(row));
        }
        return rows;
      },
    };
  }
  function songScreen(s) {
    return {
      title: "Song", items: () => [
        { head: true, label: s.title },
        { label: s.artist || "Unknown artist", sub: "picked by " + (s.name || "anon"), art: s.artwork || "", dim: true },
        { label: "Play From Here", right: "▶", action: () => playFullMix(s.month, songsFor(s.month).indexOf(s)) },
        { label: "Play Preview", right: "♪", action: () => { previewSong(s); openNP() } },
        { label: isLiked(s) ? "Liked" : "Like", sub: `${s.likes || 0} ${(s.likes || 0) === 1 ? "like" : "likes"}`, right: isLiked(s) ? "♥" : "♡", action: () => toggleLike(s) },
        { label: "Open in " + svcName(), right: "↗", action: () => window.open(linkFor(s), "_blank", "noopener") },
        s.month === CURRENT && s.owner_hash === myHash && { label: "Remove From Mix", right: "×", action: () => push(confirmScreen("Remove?", s.title, "Remove from the Mix", () => { removeSong(s); pop() })) },
      ],
    };
  }
  const inCrate = s => state.crate.some(c => keyOf(c) === keyOf(s));
  function pickItem(s) {
    const taken = songsFor(CURRENT).some(c => keyOf(c) === keyOf(s));
    return { label: s.title, sub: s.artist, art: s.artwork || "", song: s, ex: s.explicit, playing: P.key === "p:" + keyOf(s) && P.playing, right: taken || inCrate(s) ? "✓" : "+",
      action: () => (taken ? toast("Already in the mix") : toggleCrate(s)) };
  }
  function addScreen() {
    return {
      title: "Add Songs",
      foot: () => h("div", { class: "foot" }, `${slotsLeft()} slot${slotsLeft() === 1 ? "" : "s"} left · ${state.crate.length} in crate`),
      items: () => [
        { icon: ["⌕", "#2f7ff0"], label: "Search", right: "›", action: () => push(searchScreen()) },
        libsOn().length ? myMusicItem() : null,
        ...Object.entries(TABS).map(([k, t]) => ({ icon: { foryou: ["♥", "#ff2e88"], trending: ["↗", "#ff8a00"], class: ["★", "#e6b400"], vibes: ["☾", "#8a5cff"] }[k], label: t.label, right: "›", action: () => push(sugScreen(k)) })),
        state.crate.length && { label: `Review Crate (${state.crate.length})`, right: "›", hot: true, action: () => push(crateScreen()) },
      ],
    };
  }
  function sugScreen(k) {
    const sc = {
      title: TABS[k].label, auto: true, loading: true, groups: null,
      items: () => sc.loading ? [{ label: "Loading…", dim: true }]
        : !sc.groups || !sc.groups.some(g => g.items.length) ? [{ label: k === "class" ? "No class picks yet" : "Nothing here right now", dim: true }]
        : sc.groups.flatMap(g => [g.h ? { head: true, label: g.h } : null, ...g.items.map(pickItem)]),
    };
    (async () => {
      try { sugCache[k] = sugCache[k] || await TABS[k].load(); sc.groups = sugCache[k].map(g => ({ ...g, items: exclude(g.items) })) } catch { sc.groups = [] }
      sc.loading = false; if (cur() === sc) { refresh(); mark() }
    })();
    return sc;
  }
  let sSeq = 0, sT, sCtl;
  function searchScreen(o = {}) {
    const sc = {
      title: o.title || "Search", auto: true, q: "", results: [], loading: false, note: o.note || "Type a song or artist, or paste a link", note0: o.note,
      input: () => h("label", { class: "inp" }, "⌕", h("input", {
        id: "q", type: "search", value: sc.q, placeholder: o.placeholder || "Search or paste a link", autocomplete: "off", spellcheck: "false", enterkeyhint: "search",
        oninput: e => { sc.q = e.target.value; searchFor(sc) },
        onkeydown: e => {
          e.stopPropagation();
          if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); move(e.key === "ArrowDown" ? 1 : -1) }
          else if (e.key === "Enter") { e.preventDefault(); e.target.blur(); activate() }
          else if (e.key === "Escape") { e.target.blur(); pop() }
        },
      })),
      items: () => sc.loading ? [{ label: "Searching…", dim: true }] : sc.results.length ? sc.results.map(pickItem) : [{ label: sc.note, dim: true }],
      onShow: () => setTimeout(() => { const q = $("#q"); q && q.focus({ preventScroll: true }) }, 340),
    };
    return sc;
  }
  function searchFor(sc) {
    clearTimeout(sT);
    const v = sc.q.trim();
    if (!v) { sc.results = []; sc.loading = false; sc.note = sc.note0 || "Type a song or artist, or paste a link"; return refresh() }
    sT = setTimeout(async () => {
      const my = ++sSeq; sc.loading = true; refresh();
      let items = [];
      try {
        if (isListLink(v)) {
          const pl = await readPlaylist(v);
          items = pl.songs; sc.title = pl.name;
          if (!items.length) sc.note = "That playlist looks empty";
        } else if (/^https?:\/\//i.test(v)) {
          const r = await readLink(v);
          if (r.exact) items = [r.exact];
          else {
            const f = r.query ? await itunes(r.query, 8) : [];
            items = f.slice(0, 5).map(x => ({ ...x, links: { ...x.links, ...r.links } }));
            if (r.fallback && r.fallback.title) items.push(r.fallback);
            if (!items.length) sc.note = "Can't read that link. Type the name instead.";
          }
        } else {
          sCtl && sCtl.abort(); sCtl = new AbortController();
          items = await search(v, 15, sCtl.signal);
          if (!items.length) sc.note = "No matches";
        }
      } catch (e) { if (e.name === "AbortError") return; sc.note = e.message === "unreadable" ? "Couldn't open that playlist. Check the link is shared." : "Search is offline. Try again." }
      if (my !== sSeq) return;
      sc.results = items; sc.sel = 0; sc.loading = false;
      if (cur() === sc) { refresh(); mark() }
    }, 220);
  }
  function crateScreen() {
    return {
      title: "Your Crate", items: () => state.crate.length ? [
        ...state.crate.map(s => ({ label: s.title, sub: s.artist, art: s.artwork || "", song: s, right: "×", action: () => removeFromCrate(s) })),
        { label: "Name: " + (myName || "anon"), right: "›", action: () => push(nameScreen()) },
        { label: state.busy ? "Sending…" : `Submit ${state.crate.length} Song${state.crate.length === 1 ? "" : "s"}`, right: "›", hot: true, action: submitCrate },
      ] : [{ label: "Your crate is empty", dim: true }, { label: "Add Songs", right: "›", action: () => push(addScreen()) }],
    };
  }
  function nameScreen() {
    const save = clear => { const el = $("#nm"); myName = clear ? "" : ((el && el.value) || "").trim().slice(0, 24); store.set("ideradio.name", myName); pop() };
    return {
      title: "Your Name",
      input: () => h("label", { class: "inp" }, h("input", { id: "nm", maxlength: "24", value: myName, placeholder: "Optional", autocomplete: "nickname", enterkeyhint: "done", onkeydown: e => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); save() } } })),
      items: () => [{ label: "Save", right: "›", action: () => save() }, { label: "Stay Anonymous", right: "›", action: () => save(true) }],
      onShow: () => setTimeout(() => { const el = $("#nm"); el && el.focus({ preventScroll: true }) }, 340),
    };
  }
  function archiveScreen() {
    return {
      title: "Archive", items: () => allMonths().map(k => {
        const n = songsFor(k).length;
        return { label: monthLabel(k), sub: `${n} song${n === 1 ? "" : "s"}${k === CURRENT ? " · on air" : ""}`, right: "›", action: () => push(monthScreen(k)) };
      }),
    };
  }
  function settingsScreen() {
    return {
      title: "Settings", items: () => [
        { icon: ["▶", "#fa2d48"], label: "Listen On", right: svcName(), action: () => push(listenScreen()) },
        { icon: ["◉", "#ff8a00"], label: "Customize My iPod", right: MODELS[model].name, action: () => push(customizeScreen()) },
        SP.cid && (SP.connected()
          ? { icon: ["♫", "#1db954"], label: "Spotify", sub: "connected" + (SP.me && SP.me.name ? " as " + SP.me.name : ""), right: "✓", action: () => push(spotifyScreen()) }
          : { icon: ["♫", "#1db954"], label: "Connect Spotify", right: "›", action: () => SP.login({ action: "connect" }) }),
        YT.cid && (YT.connected()
          ? { icon: ["▶", "#ff0033"], label: "YouTube Music", sub: "connected", right: "✓", action: () => push(disconnectScreen("YouTube Music", () => YT.disconnect())) }
          : { icon: ["▶", "#ff0033"], label: "Connect YouTube Music", right: "›", action: () => connectLib("youtube") }),
        AM.enabled && (AM.connected
          ? { icon: ["♪", "#fa2d48"], label: "Apple Music", sub: "connected", right: "✓", action: () => push(disconnectScreen("Apple Music", () => AM.disconnect())) }
          : { icon: ["♪", "#fa2d48"], label: "Connect Apple Music", right: "›", action: () => connectLib("apple") }),
        PK.ok && { icon: ["☺", "#2f7ff0"], label: "Remember Me", sub: PK.saved() ? `saved with ${PK_NAME}` : `save your setup with ${PK_NAME}`, right: PK.saved() ? "✓" : "›",
          action: () => push({ title: "Remember Me", items: () => [
            { head: true, label: "Name, iPod, crate and app choice" },
            { label: PK.saved() ? "Save Again" : `Save with ${PK_NAME}`, right: "›", action: async () => { try { await PK.save(); toast("Saved ✓"); refresh() } catch {} } },
            { label: `Restore with ${PK_NAME}`, right: "›", action: async () => { try { await PK.restore() } catch { toast("Nothing saved yet") } } },
          ] }) },
        { icon: ["⇄", "#ff8a00"], label: "Shuffle", right: playOpts.shuffle ? "Songs" : "Off", action: () => { setShuffle(!playOpts.shuffle); refresh() } },
        { icon: ["↻", "#ff8a00"], label: "Repeat", right: { off: "Off", one: "One", all: "All" }[playOpts.repeat], action: () => { setRepeat({ off: "all", all: "one", one: "off" }[playOpts.repeat]); refresh() } },
        { icon: ["≋", "#0fb5a8"], label: "Crossfade", sub: state.service === "spotify" && SP.canPlay() ? "Spotify uses its own setting" : null, right: settings.crossfade ? settings.crossfade + "s" : "Off",
          action: () => { const opts = [0, 3, 6, 9, 12]; settings.crossfade = opts[(opts.indexOf(settings.crossfade) + 1) % opts.length]; saveSettings(); refresh() } },
        { icon: ["♫", "#0fb5a8"], label: "Clicker", right: settings.clicker ? "On" : "Off", action: () => { settings.clicker = !settings.clicker; saveSettings(); refresh() } },
        { icon: ["≋", "#8a5cff"], label: "Haptics", right: settings.haptics ? "On" : "Off", action: () => { settings.haptics = !settings.haptics; saveSettings(); refresh() } },
        { icon: ["☺", "#ff2e88"], label: "Replay Intro", right: "›", action: () => onboarding() },
        { icon: ["i", "#2f7ff0"], label: "About", right: "›", action: () => push({ title: "About", kind: "text", text: NAME + " is our class radio. Everyone adds 1 to 5 songs a month, and the mix plays on the class speaker." }) },
      ],
    };
  }
  function spotifyScreen() {
    return {
      title: "Spotify", items: () => [
        { head: true, label: SP.me && SP.me.name ? "Signed in as " + SP.me.name : "Connected" },
        { label: "My Spotify", right: "›", action: () => push(libScreen("spotify")) },
        (!STATION.connected || (SP.me && STATION.userId === SP.me.id)) && { label: "Class Playlist", sub: STATION.connected ? "on · updates every night" : "set up the shared playlist", right: "›", action: () => push(stationScreen()) },
        !SP.blocked() && { label: "Save This Month", right: "›", action: () => saveToSpotify(CURRENT) },
        SP.lists[CURRENT] && { label: "Open Playlist", right: "↗", action: () => window.open(SP.lists[CURRENT].url, "_blank", "noopener") },
        { label: "Disconnect", right: "×", action: () => { SP.disconnect(); pop() } },
      ],
    };
  }
  function customizeScreen() {
    return {
      title: "Customize My iPod", tint: "orange", items: () => [
        { head: true, label: "Model" },
        ...Object.entries(MODELS).map(([k, m]) => ({ label: "iPod " + m.name, right: model === k ? "✓" : "", action: () => { model = k; applyLook(true) } })),
        { head: true, label: "Finish" },
        ...Object.entries(FINISHES).map(([k, f]) => ({ icon: ["◉", f.swatch], label: f.name, right: finish === k ? "✓" : "", action: () => { finish = k; applyLook(true) } })),
      ],
    };
  }
  function disconnectScreen(name, fn) {
    return { title: name, items: () => [{ head: true, label: "Connected" }, { label: "Disconnect", right: "×", action: () => { fn(); pop() } }] };
  }
  function listenScreen() {
    return {
      title: "Listen On", items: () => Object.entries(SERVICES).map(([k, s]) => ({
        label: s.name, right: state.service === k ? "✓" : "",
        action: () => { state.service = k; store.set("ideradio.svc", k); resolveLinks(); pop() },
      })),
    };
  }
  // ---------- My Spotify / My Apple Music / My YouTube Music ----------
  const LIB = {
    spotify: { name: "My Spotify", svc: "Spotify", icon: ["♫", "#1db954"], api: SP, avail: () => !!SP.cid, on: () => SP.connected(), ready: () => SP.canRead(),
      connect: () => SP.login({ action: "mine" }),
      shelves: () => [["Liked Songs", "♥", () => SP.liked()], ["On Repeat", "↻", () => SP.top()], ["Recently Played", "◷", () => SP.recent()]] },
    apple: { name: "My Apple Music", svc: "Apple Music", icon: ["♪", "#fa2d48"], api: AM, avail: () => true,
      on: () => (AM.enabled ? AM.connected : state.service === "apple" || savedLists().some(l => l.svc === "apple")), ready: () => true,
      connect: () => AM.connect(),
      shelves: () => [["Library Songs", "♥", () => AM.liked()], ["Recently Played", "◷", () => AM.recent()]] },
    youtube: { name: "My YouTube Music", svc: "YouTube Music", icon: ["▶", "#ff0033"], api: YT, avail: () => !!YT.cid, on: () => YT.connected(), ready: () => true,
      connect: () => YT.auth({ action: "ytmine" }),
      shelves: () => [["Liked Songs", "♥", () => YT.liked()]] },
  };
  const libsAvail = () => Object.keys(LIB).filter(k => LIB[k].avail());
  const libsOn = () => libsAvail().filter(k => LIB[k].on());
  async function connectLib(k) {
    try { await LIB[k].connect(); if (LIB[k].on()) refresh() }
    catch { toast("Didn't connect. Try again") }
  }
  // The menu entry is named after whatever you've connected: one service gets its own name, two or more is "My Music".
  function myMusicItem() {
    const on = libsOn();
    if (on.length === 1) { const L = LIB[on[0]]; return { icon: L.icon, label: L.name, right: "›", action: () => push(libScreen(on[0])) } }
    if (!libsAvail().length) return null;
    return { icon: ["♥", "#ff2e88"], label: "My Music", right: "›", action: () => push(myMusicScreen()) };
  }
  function myMusicScreen() {
    return {
      title: "My Music", items: () => libsAvail().map(k => {
        const L = LIB[k];
        if (L.on() || (k === "apple" && !AM.enabled)) return { icon: L.icon, label: L.svc, right: "›", action: () => push(libScreen(k)) };
        return { icon: L.icon, label: "Connect " + L.svc, right: "›", action: () => connectLib(k) };
      }),
    };
  }
  const libErr = e => { if (e && e.message === "forbidden") SP.profile(); return "Couldn't load. Go back and try again." };
  function libScreen(k) {
    if (k === "apple" && !AM.enabled) return linksScreen("apple");
    if (k === "spotify" && SP.blocked()) return linksScreen("spotify");
    const L = LIB[k];
    const sc = {
      title: L.name, lists: null, err: null,
      items: () => !L.ready()
        ? [{ head: true, label: "One more step" }, { label: `Allow ${NAME} to see your music`, right: "›", hot: true, action: () => L.connect() }]
        : [
            ...L.shelves().map(([label, ic, fn]) => ({ icon: [ic, L.icon[1]], label, right: "›", action: () => push(songsScreen(label, fn)) })),
            { head: true, label: "Playlists" },
            ...(!sc.lists ? [{ label: sc.err || "Loading…", dim: true }]
              : sc.lists.length ? sc.lists.map(p => ({ label: p.name, sub: p.n != null ? `${p.n} song${p.n === 1 ? "" : "s"}` : null, art: p.art || "", right: "›", action: () => push(songsScreen(p.name, () => L.api.playlist(p.id))) }))
              : [{ label: "No playlists", dim: true }]),
          ],
      onShow: () => {
        if (sc.lists || sc.err || !L.ready()) return;
        L.api.playlists().then(x => { sc.lists = x }).catch(e => { sc.err = libErr(e) }).finally(() => { if (cur() === sc) refresh() });
      },
    };
    return sc;
  }
  function songsScreen(title, fn) {
    const sc = {
      title, auto: true, loading: true, songs: [], err: null,
      items: () => sc.loading ? [{ label: "Loading…", dim: true }] : sc.err ? [{ label: sc.err, dim: true }] : sc.songs.length ? sc.songs.map(pickItem) : [{ label: "Nothing here yet", dim: true }],
    };
    fn().then(x => { sc.songs = x }).catch(e => { sc.err = libErr(e) }).finally(() => { sc.loading = false; if (cur() === sc) { refresh(); mark() } });
    return sc;
  }

  // ---------- playlists shared by link: Apple Music without an Apple developer key ----------
  const savedLists = () => store.json("ideradio.lists", []);
  const isListLink = v => { try { const u = new URL(v); return (u.hostname === "spotify.link" || (u.hostname === "open.spotify.com" && /\/(playlist|album)\//.test(u.pathname))) || (/music\.apple\.com$/.test(u.hostname) && u.pathname.includes("/playlist/")) || (/youtube\.com$|youtu\.be$/.test(u.hostname) && u.searchParams.has("list")) } catch { return false } };
  async function readPlaylist(url) {
    const r = await fetch("/api/playlist?url=" + encodeURIComponent(url));
    if (!r.ok) throw new Error("unreadable");
    const j = await r.json();
    let songs;
    if (j.ids) {
      const byId = new Map();
      for (let i = 0; i < j.ids.length; i += 150) {
        const look = await (await fetch(`https://itunes.apple.com/lookup?entity=song&country=${j.country || "us"}&id=` + j.ids.slice(i, i + 150).join(","))).json();
        for (const x of look.results || []) if (x.kind === "song") byId.set(String(x.trackId), mapIt(x));
      }
      songs = j.ids.map(id => byId.get(String(id))).filter(Boolean);
    } else songs = (j.songs || []).map(x => !x.yt ? x : (x => {
      let title = clean(x.title), artist = clean(x.artist);
      const m = title.match(/^(.+?)\s+[-–]\s+(.+)$/); if (m) { artist = m[1]; title = m[2] }
      return { title, artist, artwork: x.artwork, preview: null, links: { youtube: "https://music.youtube.com/watch?v=" + x.yt } };
    })(x));
    const svc = /spotify/.test(url) ? "spotify" : /apple/.test(url) ? "apple" : "youtube";
    if (svc === "spotify") fillArt(songs);
    store.set("ideradio.lists", JSON.stringify([{ url, name: j.name, svc, n: songs.length }, ...savedLists().filter(l => l.url !== url)].slice(0, 12)));
    return { name: j.name, songs };
  }
  // Spotify's playlist links don't carry each song's cover, so those are fetched in the background.
  const artSeen = {};
  async function fillArt(songs) {
    const todo = songs.filter(s => !s.artwork && s.links && s.links.spotify);
    let i = 0, t;
    const one = async () => {
      while (i < todo.length) {
        const s = todo[i++], u = s.links.spotify;
        try { s.artwork = artSeen[u] = artSeen[u] || (await (await fetch("https://open.spotify.com/oembed?url=" + encodeURIComponent(u))).json()).thumbnail_url || null } catch {}
        clearTimeout(t); t = setTimeout(refresh, 120);
      }
    };
    await Promise.all([one(), one(), one(), one()]);
  }
  const LINKS = {
    apple: { title: "My Apple Music", icon: ["+", "#fa2d48"], has: l => l.svc !== "spotify",
      note: "In Music: open a playlist, tap ••• → Share → Copy Link, then paste it here",
      how: { label: "Share any playlist from the Music app", sub: "Your songs show up here to pick from" } },
    spotify: { title: "My Spotify", icon: ["+", "#1db954"], has: l => l.svc === "spotify",
      note: "In Spotify: open a playlist or album, tap ••• → Share → Copy link, then paste it here",
      how: { label: "Paste a playlist or album", sub: "Liked Songs can't be shared" } },
  };
  const SVC_LABEL = { apple: "Apple Music", spotify: "Spotify", youtube: "YouTube" };
  function linksScreen(svc) {
    const C = LINKS[svc];
    return {
      title: C.title, items: () => {
        const lists = savedLists().filter(C.has);
        return [
          { icon: C.icon, label: "Add a Playlist", right: "›", hot: !lists.length, action: () => push(searchScreen({ title: "Add a Playlist", note: C.note, placeholder: "Paste a playlist link" })) },
          lists.length ? { head: true, label: "Your playlists" } : { head: true, label: "How it works" },
          ...(lists.length
            ? lists.map(l => ({ label: l.name, sub: SVC_LABEL[l.svc] + (l.n ? ` · ${l.n} songs` : ""), right: "›", action: () => push(songsScreen(l.name, () => readPlaylist(l.url).then(x => x.songs))) }))
            : [{ ...C.how, dim: true }]),
        ];
      },
    };
  }

  // ---------- crate ----------
  function confirmScreen(title, what, yes, fn) {
    return { title, confirm: true, tint: tintOf(cur() || {}) || undefined, items: () => [
      { head: true, label: what },
      { label: yes, right: "×", action: () => { pop(); fn() } },
      { label: "Keep It", right: "›", action: () => pop() },
    ], sel: 2 };
  }
  // Songs in the crate send themselves: right away when the crate is full, otherwise a few seconds after the last pick.
  const SEND_IN = 10;
  let sendAt = 0, sendTick;
  function armSend() {
    clearInterval(sendTick);
    if (!state.crate.length) { sendAt = 0; return }
    sendAt = Date.now() + (slotsLeft() ? SEND_IN : 1.2) * 1000;
    sendTick = setInterval(() => {
      if (!state.crate.length || state.busy) { clearInterval(sendTick); sendAt = 0; return }
      if (cur() && cur().confirm) { sendAt += 250; return } // never send while asking a question
      if (Date.now() >= sendAt) { clearInterval(sendTick); sendAt = 0; submitCrate() } else paintSendBar();
    }, 250);
  }
  function sendBar() {
    const n = state.crate.length; if (!n) return null;
    const left = sendAt ? Math.max(0, Math.ceil((sendAt - Date.now()) / 1000)) : 0;
    return tapLabel({ class: "sendbar" + (state.busy ? " busy" : ""), "aria-label": "Send now" }, () => { if (!state.busy) submitCrate() },
      h("b", { class: "n" }, n),
      h("span", { class: "t" }, state.busy ? "Sending…" : `Send to the ${monthName(CURRENT)} mix`, h("i", {}, state.busy ? "" : left ? `sends by itself in ${left}s · tap to send now` : "tap to send")),
      h("span", { class: "go" }, "›"));
  }
  function paintSendBar() {
    const old = lcd.querySelector(".lcd-body:not(.out) .sendbar"); if (!old) return;
    const i = old.querySelector("i"), left = Math.max(0, Math.ceil((sendAt - Date.now()) / 1000));
    if (i && !state.busy) i.textContent = `sends by itself in ${left}s · tap to send now`;
  }
  function removeFromCrate(s) {
    push(confirmScreen("Remove?", s.title, "Remove from Crate", () => { state.crate = state.crate.filter(c => keyOf(c) !== keyOf(s)); saveCrate(); armSend(); refresh() }));
  }
  function toggleCrate(s) {
    const i = state.crate.findIndex(c => keyOf(c) === keyOf(s));
    if (i >= 0) return removeFromCrate(s);
    else {
      if (mine().length >= MAX) return toast("All 5 added this month");
      if (!slotsLeft()) return toast("Crate's full");
      if (songsFor(CURRENT).some(c => keyOf(c) === keyOf(s))) return toast("Already in the mix");
      state.crate.push({ title: s.title, artist: s.artist || "", artwork: s.artwork || null, preview: s.preview || null, links: s.links || {} });
      lcd.animate([{ filter: "brightness(1.12)" }, { filter: "none" }], { duration: 260 });
    }
    saveCrate(); armSend(); refresh();
  }
  async function submitCrate() {
    if (!state.crate.length || state.busy) return;
    clearInterval(sendTick); sendAt = 0;
    const songs = state.crate.map(s => ({ ...s, artwork: s.artwork ? safeUrl(s.artwork) : null, preview: s.preview ? safeUrl(s.preview) : null }));
    state.busy = true; refresh();
    await Promise.all(songs.map(async s => {
      if ((s.links || {}).apple) return;
      try { const r = await itunes([s.artist, s.title].filter(Boolean).join(" "), 5), a = bestMatch(s, r); if (a) { s.links = { ...(s.links || {}), apple: a.links.apple }; if (!s.preview && a.preview) s.preview = a.preview } } catch {}
    }));
    try {
      const rows = await db.submit(myName || "anon", songs);
      for (const r of rows) state.songs.set(r.id, r);
      const hist = store.json("ideradio.hist", []); store.set("ideradio.hist", JSON.stringify([...songs.map(s => ({ artist: s.artist })), ...hist].slice(0, 60)));
      Object.keys(sugCache).forEach(k => delete sugCache[k]);
      const n = state.crate.length; state.crate = []; saveCrate(); state.busy = false;
      if (P.key && P.key.startsWith("p:")) stopAll();
      stack.length = 1; push(monthScreen(CURRENT));
      buzz(true); toast(n === 1 ? "Sent ✓" : `Sent ${n} songs ✓`, null, null, 2600);
    } catch (e) {
      state.busy = false;
      const m = String((e && e.message) || "");
      if (m === "dupe") { state.crate = state.crate.filter(s => s.title !== e.title); saveCrate(); toast("Someone just added that") }
      else toast(m === "limit" ? `Only ${MAX - mine().length} left` : m === "closed" ? "This month is closed" : "Couldn't send. Try again");
      refresh();
    }
  }
  async function removeSong(s) {
    state.songs.delete(s.id); refresh();
    try { await db.remove(s.id, s.month) } catch { state.songs.set(s.id, s); refresh(); toast("Couldn't remove. Try again") }
  }

  // ---------- the click wheel ----------
  (() => {
    let active = false, dragging = false, last = 0, acc = 0, rot = 0, moved = 0, pid = null, wAcc = 0;
    const STEP = 20;
    const geo = () => { const r = wheel.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, R: r.width / 2 } };
    const ang = (x, y, g) => Math.atan2(y - g.cy, x - g.cx) * 180 / Math.PI;
    let g;
    wheel.addEventListener("pointerdown", e => {
      unlockAudio(); wake();
      g = geo();
      if (Math.hypot(e.clientX - g.cx, e.clientY - g.cy) < g.R * 0.15) return;
      active = true; dragging = false; moved = 0; acc = 0; pid = e.pointerId; last = ang(e.clientX, e.clientY, g);
    });
    wheel.addEventListener("pointermove", e => {
      if (!active || e.pointerId !== pid) return;
      const a = ang(e.clientX, e.clientY, g); let da = a - last; last = a;
      if (da > 180) da -= 360; if (da < -180) da += 360;
      moved += Math.abs(da);
      if (!dragging && moved > 7) { dragging = true; wheel.classList.add("dragging"); try { wheel.setPointerCapture(pid) } catch {} }
      if (!dragging) return;
      e.preventDefault();
      rot += da; disc.style.rotate = rot + "deg";
      acc += da;
      while (acc >= STEP) { acc -= STEP; move(1) }
      while (acc <= -STEP) { acc += STEP; move(-1) }
    });
    const end = () => { if (!active) return; active = false; setTimeout(() => wheel.classList.remove("dragging"), 0) };
    wheel.addEventListener("pointerup", end);
    wheel.addEventListener("pointercancel", end);
    $("#ipod").addEventListener("wheel", e => {
      if (e.target.closest(".menu") && !e.target.closest(".wheel")) return; // let the list scroll natively with a trackpad
      e.preventDefault(); wAcc += e.deltaY;
      while (wAcc > 36) { wAcc -= 36; move(1); rot += STEP; disc.style.rotate = rot + "deg" }
      while (wAcc < -36) { wAcc += 36; move(-1); rot -= STEP; disc.style.rotate = rot + "deg" }
    }, { passive: false });
    const btn = (id, fn) => onTap($(id), () => { unlockAudio(); tickFx(); fn() });
    btn("#menuBtn", () => { if (!pop()) lcd.animate([{ transform: "translateX(-4px)" }, { transform: "translateX(4px)" }, { transform: "none" }], { duration: 220 }) });
    btn("#prevBtn", () => next(-1));
    btn("#nextBtn", () => next(1));
    btn("#ppBtn", playPause);
    onTap($("#selectBtn"), () => { unlockAudio(); activate() });
    // Tap the inner ring: top half steps up, bottom half steps down (on Now Playing: volume).
    onTap($("#upZone"), () => { unlockAudio(); move(-1); rot -= STEP; disc.style.rotate = rot + "deg" });
    onTap($("#downZone"), () => { unlockAudio(); move(1); rot += STEP; disc.style.rotate = rot + "deg" });
  })();
  addEventListener("keydown", e => {
    if (/input|textarea/i.test((document.activeElement || {}).tagName || "")) return;
    const k = e.key;
    if (k === "ArrowDown") { e.preventDefault(); move(1) }
    else if (k === "ArrowUp") { e.preventDefault(); move(-1) }
    else if (k === "Enter") { e.preventDefault(); unlockAudio(); activate() }
    else if (k === "Escape" && $(".coach")) put($("#obRoot"));
    else if (k === "Escape" || k === "Backspace") { e.preventDefault(); pop() }
    else if (k === " ") { e.preventDefault(); unlockAudio(); playPause() }
    else if (k === "ArrowRight") next(1);
    else if (k === "ArrowLeft") next(-1);
  });

  // ---------- feel like a device, not a web page ----------
  // Browsers keep sound off until the first touch; start it on the very first touch anywhere, not just the wheel.
  ["pointerdown", "touchend", "keydown"].forEach(ev => addEventListener(ev, unlockAudio, { once: true, capture: true, passive: true }));
  const typing = e => /input|textarea/i.test((e.target || {}).tagName || "");
  addEventListener("contextmenu", e => { if (!typing(e)) e.preventDefault() });            // no long-press menus
  addEventListener("dragstart", e => e.preventDefault());                                   // no dragging images out
  ["gesturestart", "gesturechange"].forEach(ev => addEventListener(ev, e => e.preventDefault())); // no pinch zoom (iOS)
  addEventListener("dblclick", e => e.preventDefault(), { passive: false });              // no double-tap zoom
  addEventListener("touchmove", e => { if (!e.target.closest(".menu")) e.preventDefault() }, { passive: false }); // the page itself never moves
  if (matchMedia("(display-mode: standalone)").matches || navigator.standalone) document.documentElement.classList.add("app");

  // ---------- fit the iPod to the screen ----------
  function fit() {
    const wide = matchMedia("(min-width: 900px) and (min-height: 640px)").matches;
    const st = getComputedStyle($(".stage")), padV = parseFloat(st.paddingTop) + parseFloat(st.paddingBottom);
    const brandH = wide ? 0 : $(".brand").getBoundingClientRect().height + 8;
    const availH = innerHeight - padV - brandH - 6;
    const availW = wide ? innerWidth * 0.48 : innerWidth - 20;
    const m = MODELS[model];
    const s = Math.max(0.4, Math.min(availW / m.w, availH / m.h, 1.25));
    document.documentElement.style.setProperty("--s", s.toFixed(4));
    placeVideo();
  }
  addEventListener("resize", fit);
  if (window.visualViewport) visualViewport.addEventListener("resize", () => placeVideo());

  function tagline() {
    const el = $("#tagline"); if (!el) return;
    const m = mine().length;
    put(el, (CFG.tagline || "class radio") + " · " + monthName(CURRENT).slice(0, 3).toLowerCase(), m === 0 && state.loaded ? [" ", h("span", { class: "hot" }, "not in yet")] : null);
  }
  function setStatus() {}

  // ---------- floating aero bubbles ----------
  (() => {
    const cv = $("#fx"); if (getComputedStyle(cv).display === "none") return;
    const ctx = cv.getContext("2d");
    let W, H, bubbles = [];
    const nb = any => { const r = 8 + Math.random() * 28; return { x: Math.random() * W, y: any ? Math.random() * H : H + r + 10, r, v: .12 + Math.random() * .3, ph: Math.random() * 6.28 } };
    function seed() { const d = Math.min(2, devicePixelRatio || 1); W = innerWidth; H = innerHeight; cv.width = W * d; cv.height = H * d; ctx.setTransform(d, 0, 0, d, 0, 0); bubbles = Array.from({ length: W < 640 ? 7 : 12 }, () => nb(true)) }
    function frame(t) {
      ctx.clearRect(0, 0, W, H);
      for (const b of bubbles) {
        if (!reduce) { b.y -= b.v; b.x += Math.sin(t / 1800 + b.ph) * .25 }
        if (b.y < -b.r - 10) Object.assign(b, nb(false));
        const g = ctx.createRadialGradient(b.x - b.r * .35, b.y - b.r * .4, b.r * .05, b.x, b.y, b.r);
        g.addColorStop(0, "rgba(255,255,255,.9)"); g.addColorStop(.35, "rgba(255,255,255,.15)"); g.addColorStop(.85, "rgba(140,210,240,.2)"); g.addColorStop(1, "rgba(255,255,255,.75)");
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 6.283); ctx.fillStyle = g; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = "rgba(255,255,255,.6)"; ctx.stroke();
      }
      if (!reduce && !document.hidden) requestAnimationFrame(frame);
    }
    document.addEventListener("visibilitychange", () => { if (!document.hidden && !reduce) requestAnimationFrame(frame) });
    seed(); requestAnimationFrame(frame);
    let rz; addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { seed(); if (reduce) frame(0) }, 150) });
  })();

  // ---------- onboarding: name, app, connect (skippable) ----------
  const SMILE = { hi: "big/hi.png", name: "big/i_am_so_happy.png", spotify: "big/music.png", apple: "big/cool.png", youtube: "big/dance2.png", pick: "dntknw.png", done: "big/congratulate.png" };
  const SVC_COLOR = { spotify: "#46ad62", apple: "#e5596f", youtube: "#df5a52" };
  const face = (k, cls) => h("div", { class: "bubble " + (cls || "") }, h("img", { class: "smiley", src: "smileys/" + SMILE[k], alt: "" }));
  function onboarding() {
    const root = $("#obRoot");
    let step = 0, pick = store.get("ideradio.svc") ? state.service : null;
    const ob = h("div", { class: "ob", role: "dialog", "aria-modal": "true", "aria-label": "Welcome to " + NAME });
    const card = h("div", { class: "ob-card" });
    ob.append(tapLabel({ class: "ob-skip" }, () => close(), "Skip"), card);
    put(root, ob);
    const close = then => {
      store.set("ideradio.onboarded", "1");
      ob.classList.add("out"); setTimeout(() => put(root), 450);
      refresh(); tagline(); then && then();
    };
    const btn = (cls, label, fn) => tapLabel({ class: "ob-btn " + cls }, () => { buzz(true); fn() }, label);
    const go = n => { step = n; paint() };
    const saveName = () => { const el = $("#obName"); myName = ((el && el.value) || "").trim().slice(0, 24); store.set("ideradio.name", myName); go(2) };
    function connectBtn() {
      if (pick === "spotify" && SP.cid) return SP.connected()
        ? h("div", { class: "ob-btn", style: "opacity:.85" }, "✓ Spotify connected" + (SP.me && SP.me.name ? " as " + SP.me.name : ""))
        : btn("ok", "Connect Spotify", () => { store.set("ideradio.onboarded", "1"); SP.login({ action: "connect" }) });
      if (pick === "youtube" && YT.cid) return YT.connected()
        ? h("div", { class: "ob-btn", style: "opacity:.85" }, "✓ YouTube connected")
        : btn("ok", "Connect YouTube Music", () => { store.set("ideradio.onboarded", "1"); YT.auth({ action: "connect" }) });
      if (pick === "apple" && AM.enabled) return AM.connected
        ? h("div", { class: "ob-btn", style: "opacity:.85" }, "✓ Apple Music connected")
        : btn("ok", "Connect Apple Music", async () => { try { await AM.connect(); paint() } catch { toast("Apple Music didn't connect") } });
      if (pick === "apple") return h("p", { style: "font-size:14px" }, "Every song opens right in Apple Music. Share a playlist link from the Music app to pick from your own songs.");
      if (pick) return h("p", { style: "font-size:14px" }, `Every song opens right in ${SERVICES[pick].name}.`);
      return null;
    }
    function paint() {
      const colors = ["#5b9be0", "#e46aa3", pick ? SVC_COLOR[pick] : "#a079dc", "#a079dc"];
      ob.style.setProperty("--obc", colors[step]);
      let body;
      if (step === 0) body = [face("hi", "ob-char"), h("h2", {}, "Welcome to " + NAME), h("p", {}, "Our class radio. Everyone drops 1 to 5 songs a month, and it all plays on the class speaker."),
        h("div", { class: "ob-actions" }, btn("", "Let's go →", () => go(1)),
          PK.ok ? btn("ghost", `Been here before? Use ${PK_NAME}`, async () => { try { await PK.restore() } catch { toast(`No saved setup found with ${PK_NAME}`) } }) : null)];
      if (step === 1) body = [face("name", "ob-char"), h("h2", {}, "What should we call you?"), h("p", {}, "It shows next to your picks. Leave it blank to stay anon."),
        h("input", { class: "ob-input", id: "obName", maxlength: "24", placeholder: "Your name", value: myName, autocomplete: "nickname", enterkeyhint: "next", onkeydown: e => { e.stopPropagation(); if (e.key === "Enter") saveName() } }),
        h("div", { class: "ob-actions" }, btn("", "Next →", saveName), btn("ghost", "Stay anon", () => { myName = ""; store.set("ideradio.name", ""); go(2) }))];
      if (step === 2) body = [face(pick || "pick", "ob-char"), h("h2", {}, "Where do you listen?"), h("p", {}, "Pick your app. Songs open straight in it."),
        h("div", { class: "ob-picks" }, ["spotify", "apple", "youtube"].map((k, i) => {
          const el = tapLabel({ class: "ob-pick", "aria-pressed": String(pick === k), style: `animation-delay:${0.1 + i * 0.06}s` },
            () => { pick = k; state.service = k; store.set("ideradio.svc", k); if (k === "youtube") YT.preload(); if (k === "apple") AM.check(); buzz(true); paint() },
            face(k), SERVICES[k].name);
          return el;
        })),
        h("div", { class: "ob-actions" }, connectBtn(), btn("ghost", pick ? "Next →" : "Decide later →", () => go(3)))];
      if (step === 3) body = [face("done", "ob-char"), h("h2", {}, myName ? `You're tuned in, ${myName}` : "You're tuned in"),
        h("p", {}, mine().length ? "Your songs are already in this month's mix." : `${Math.ceil(timeLeft() / 864e5)} days left to add your songs this month.`),
        h("div", { class: "ob-actions" }, btn("ok", "Add my songs", () => close(() => { stack.length = 1; push(addScreen()) })),
          PK.ok && !PK.saved() ? btn("ghost", `Remember me with ${PK_NAME}`, async () => { try { await PK.save(); toast("Saved. Your iPod follows you to the home screen and new phones.", null, "big/good.png"); paint() } catch {} }) : null,
          btn("ghost", "Just look around", () => close()))];
      ob.scrollTop = 0;
      put(card, body, h("div", { class: "ob-dots", "aria-hidden": "true" }, [0, 1, 2, 3].map(i => h("i", { class: i === step ? "on" : "" }))));
      if (step === 1) setTimeout(() => { const i = $("#obName"); i && i.focus({ preventScroll: true }) }, 350);
    }
    paint();
  }

  // ---------- help: what the iPod controls do ----------
  // Labels sit right on top of each control, so you see what a button does where it is.
  function help() {
    const root = $("#obRoot");
    const w = wheel.getBoundingClientRect(), l = lcd.getBoundingClientRect();
    const cx = w.left + w.width / 2, cy = w.top + w.height / 2, R = w.width / 2;
    const tips = [
      [l.left + l.width / 2, l.top + l.height * 0.55, "☝", "Tap a row, or swipe to scroll"],
      [cx, w.top + R * 0.2, "menu", "Back"],
      [w.left + R * 0.24, cy, "⏮", "Previous"],
      [w.right - R * 0.24, cy, "⏭", "Next"],
      [cx, w.bottom - R * 0.2, "▶❚❚", "Play / Pause"],
      [cx, cy, "●", "Select · ♥ on Now Playing"],
      [cx + R * 0.58, cy - R * 0.43, "↻", "Slide around, or tap ▲ ▼"],
    ];
    const close = () => { removeEventListener("resize", close); put(root) };
    const layer = h("div", { class: "coach", role: "dialog", "aria-modal": "true", "aria-label": "How the iPod works", onclick: close },
      tips.filter(Boolean).map(([x, y, k, t], i) => h("div", { class: "tip", style: `left:${x}px;top:${y}px;animation-delay:${i * 0.05}s` }, h("b", {}, k), t)),
      h("div", { class: "coach-x" }, "Tap anywhere to close"));
    put(root, layer);
    // keep every label on screen
    layer.querySelectorAll(".tip").forEach(el => {
      const r = el.getBoundingClientRect(), pad = 8;
      if (r.left < pad) el.style.left = parseFloat(el.style.left) + (pad - r.left) + "px";
      else if (r.right > innerWidth - pad) el.style.left = parseFloat(el.style.left) - (r.right - innerWidth + pad) + "px";
    });
    addEventListener("resize", close);
  }
  onTap($("#helpBtn"), () => { buzz(); help() });

  // ---------- boot: the iPod powers on ----------
  let afterBoot = null;
  const whenBooted = fn => { if (stack.length && stack[0].kind !== "boot") fn(); else afterBoot = fn };
  function boot() {
    document.title = NAME; const wm = $(".wordmark"); if (wm) wm.textContent = NAME;
    applyLook(false);
    const bar = h("i");
    const view = h("div", { class: "boot" }, h("img", { class: "smiley", src: "smileys/big/music.png", alt: "" }), h("div", { class: "np-bar" }, bar));
    stack.length = 0; stack.push({ title: NAME, kind: "boot", view, sel: 0 }); render(null);
    let p = 0;
    const step = () => { p = Math.min(100, p + 9 + Math.random() * 14); bar.style.width = p + "%"; if (p < 100) setTimeout(step, reduce ? 0 : 70); else setTimeout(() => { stack.length = 0; push(Object.assign({}, MAIN)); if (afterBoot) { afterBoot(); afterBoot = null } }, reduce ? 0 : 180) };
    setTimeout(step, reduce ? 0 : 450);
    if (!store.get("ideradio.onboarded") && !/[?&](code|error)=/.test(location.search) && !/access_token=|error=/.test(location.hash)) setTimeout(onboarding, reduce ? 0 : 700);
  }
  boot();
  setInterval(() => refresh(), 60000);

  function applyRows(rows) {
    const had = new Map(state.songs);
    state.songs = new Map(rows.map(r => [r.id, r]));
    for (const [id, s] of had) if (s.yt && state.songs.has(id) && !state.songs.get(id).yt) state.songs.get(id).yt = s.yt;
    state.loaded = true;
    for (const x of P.list) if (x && x.id && state.songs.has(x.id)) x.likes = state.songs.get(x.id).likes;
    refresh();
  }
  async function load() {
    try { applyRows(await db.list()) }
    catch { setTimeout(load, 4000); return }
    resolveLinks();
  }
  (async () => {
    myHash = await sha256(token);
    if (!(await pullPrefs())) return;
    const ytIntent = YT.callback();
    if (ytIntent) {
      if (ytIntent.action === "ytsave") setTimeout(() => saveToYouTube(ytIntent.month || CURRENT), 1500);
      if (ytIntent.action === "ytmine") whenBooted(() => { stack.length = 1; push(libScreen("youtube")) });
    }
    try {
      const r = await fetch("/api/songs", { cache: "no-store" });
      if (r.ok && (r.headers.get("content-type") || "").includes("json")) db = apiStore();
    } catch {}
    fetch("/api/yt").then(r => r.ok ? r.json() : {}).then(j => { ytOn = !!j.enabled; if (ytOn) YTP.load(); refresh() }).catch(() => {});
    AM.check().then(() => refresh());
    stationInfo().then(j => { STATION = j; refresh() });
    YT.preload(); // Google's sign-in script has to be ready before the tap, or the popup gets blocked
    if (SP.connected() && (!SP.me || SP.blocked())) SP.profile(); // also notices when someone gets approved later
    try {
      const intent = await SP.callback();
      if (intent) { state.service = "spotify"; store.set("ideradio.svc", "spotify") }
      await load();
      if (intent && intent.action === "save") saveToSpotify(intent.month || CURRENT);
      if (intent && intent.action === "mine") whenBooted(() => { stack.length = 1; push(libScreen("spotify")) });
    } catch { await load() }
    db.subscribe(applyRows);
    armSend(); // a crate left from last time sends itself
    // Closing the page with songs still in the crate sends them anyway.
    addEventListener("pagehide", () => {
      if (!state.crate.length || state.busy || !db.live) return;
      try { fetch("/api/songs", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, month: CURRENT, name: myName || "anon", songs: state.crate }) }); state.crate = []; saveCrate() } catch {}
    });
  })();
})();
