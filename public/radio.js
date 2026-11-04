// Radio on the pad: a car-stereo widget for Nightride FM (2–4 cells wide) and 1-cell "station" tiles
// (play/stop on one station, e.g. Virgin Radio). They share one player and one output:
// the Mac (default; the server runs mpv/ffplay) or this tablet (one <audio> element on the public
// stream). The chosen station and output live on the server, so every tablet sees the same thing.
// Nightride titles come from its public server-sent-events feed (/meta), read by the browser.
// Playback survives page changes; only a play/stop tap stops it (and drops the download).
// The station list mirrors lib/stations.ts, which is the server's whitelist.
import { t } from "/assets/i18n.js";

const nr = (id, name, color) => ({ id, name, color, group: "nightride", url: `https://stream.nightride.fm/${id}.mp3` });
export const STATIONS = [
  nr("nightride", "Nightride", "pink"),
  nr("chillsynth", "Chillsynth", "teal"),
  nr("datawave", "Datawave", "blue"),
  nr("spacesynth", "Spacesynth", "violet"),
  nr("darksynth", "Darksynth", "red"),
  nr("horrorsynth", "Horrorsynth", "orange"),
  nr("ebsm", "EBSM", "slate"),
  nr("rekt", "Rekt", "amber"),
  nr("rektory", "Rektory", "amber"),
  nr("rektify", "Rektify", "green"),
  nr("d-notive", "D-Notive", "green"),
  { id: "virgin", name: "Virgin Radio", color: "red", group: "virgin", url: "https://icecast.unitedradio.it/Virgin.aac" },
];
// What the widget's ‹ › cycle: every station.
const stationLabel = (s) => (s.group === "nightride" ? `${s.name} FM` : s.name);
const byId = (id) => STATIONS.find((s) => s.id === id) ?? STATIONS[0];
const META = "https://nightride.fm/meta";

// Markup of the radio face, shared by the pad and the editor preview. `h` is common.js's DOM helper.
export function radioInner(h) {
  const btn = (cls, label, glyph) => h("button", { class: cls, type: "button", "aria-label": label }, glyph);
  return h("span", { class: "in rd" },
    btn("rd-play", t("pad.radio.play"), h("span", { class: "rd-ic" })),
    h("span", { class: "rd-lcd" },
      h("span", { class: "rd-top" },
        h("span", { class: "rd-st" }, stationLabel(STATIONS[0])),
        h("button", { class: "rd-out", type: "button", title: t("pad.radio.out") }, "MAC"),
        h("span", { class: "rd-eq" }, h("i"), h("i"), h("i"), h("i"), h("i"))),
      h("span", { class: "rd-now" }, "—"),
      h("span", { class: "rd-tune" }, ...STATIONS.map(() => h("i")))),
    h("span", { class: "rd-nav" },
      btn("rd-prev", t("pad.radio.prev"), "‹"),
      btn("rd-next", t("pad.radio.next"), "›")),
  );
}

// The little MAC/TAB badge of a station tile (shared with the editor preview).
export const stationOut = (h) => h("button", { class: "st-out", type: "button", title: t("pad.radio.out") }, "MAC");

// ───────────── Player (one per page load) ─────────────
const S = { id: STATIONS[0].id, output: "mac", status: "idle", error: "", tabletWants: false, meta: {}, root: null, tiles: [] };
let audio = null;
let feed = null;

const post = (body) =>
  fetch("/api/radio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    });

// The server owns station, output and (for the Mac output) the playback status.
export function syncRadio(r) {
  if (STATIONS.some((s) => s.id === r.station)) S.id = r.station;
  S.output = r.output;
  if (r.output === "mac") {
    S.status = r.status;
    S.error = r.error || "";
  } else if (!S.tabletWants) {
    S.status = "idle"; // the Mac's "playing" must not linger once the output is the tablet
    S.error = "";
  }
  paint();
}

function fail(e) {
  S.status = "error";
  S.error = e instanceof TypeError ? t("pad.offline") : e.message;
  paint();
}

function ensureAudio() {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = "none";
  audio.addEventListener("playing", () => S.output === "tablet" && set("playing"));
  audio.addEventListener("waiting", () => S.output === "tablet" && S.tabletWants && set("loading"));
  audio.addEventListener("stalled", () => S.output === "tablet" && S.tabletWants && set("loading"));
  audio.addEventListener("error", () => { if (S.output === "tablet" && S.tabletWants) { S.error = ""; set("error"); } });
  return audio;
}

function set(status) {
  S.status = status;
  paint();
}

function tuneTablet() {
  const a = ensureAudio();
  a.src = byId(S.id).url; // reloading on every play also jumps back to the live edge
  S.error = "";
  set("loading");
  a.play().catch(() => S.tabletWants && set("error"));
}

function stopTablet() {
  S.tabletWants = false;
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load(); // really drops the connection: a paused stream would keep buffering
  }
  set("idle");
}

const active = () => S.status === "playing" || S.status === "loading";

async function toggle() {
  if (S.output === "tablet") return S.tabletWants && S.status !== "error" ? stopTablet() : ((S.tabletWants = true), tuneTablet());
  set("loading"); // optimistic: the answer arrives in a moment
  try {
    syncRadio(await post({ toggle: true }));
  } catch (e) {
    fail(e);
  }
}

async function step(d) {
  const i = STATIONS.findIndex((s) => s.id === S.id);
  S.id = STATIONS[(i + d + STATIONS.length) % STATIONS.length].id;
  if (S.output === "tablet" && S.tabletWants) tuneTablet();
  paint();
  try {
    const r = await post({ station: S.id });
    if (S.output === "mac") syncRadio(r);
  } catch (e) {
    fail(e);
  }
}

// A station tile: one tap plays that station, a second tap on the same one stops it.
async function tune(id) {
  if (S.output === "tablet") {
    if (S.tabletWants && S.id === id && S.status !== "error") stopTablet();
    else {
      S.id = id;
      S.tabletWants = true;
      tuneTablet();
      post({ station: id }).catch(() => {}); // remember it on the server
    }
    return;
  }
  if (S.id !== id || !active()) {
    S.id = id;
    set("loading");
  }
  try {
    syncRadio(await post({ tune: id }));
  } catch (e) {
    fail(e);
  }
}

async function switchOutput() {
  const next = S.output === "mac" ? "tablet" : "mac";
  if (S.tabletWants) stopTablet();
  try {
    syncRadio(await post({ output: next }));
  } catch (e) {
    fail(e);
  }
}

function startFeed() {
  if (feed || typeof EventSource === "undefined") return;
  feed = new EventSource(META); // reconnects by itself
  feed.onmessage = (e) => {
    try {
      for (const m of JSON.parse(e.data)) if (m && m.station) S.meta[m.station] = { title: m.title, artist: m.artist };
      paint();
    } catch {}
  };
}

function paint() {
  const st = byId(S.id);
  const m = S.meta[st.id];
  const track = m && (m.artist || m.title) ? [m.artist, m.title].filter(Boolean).join(" — ") : "";
  const idle = t("pad.radio.idle");
  const now = S.status === "error" ? S.error || t("pad.radio.error")
    : S.status === "loading" ? t("pad.radio.tuning")
    : track || (S.status === "playing" ? t("pad.radio.live") : idle);
  const r = S.root;
  if (r) {
    r.dataset.color = st.color;
    r.dataset.rd = S.status;
    r.querySelector(".rd-st").textContent = stationLabel(st);
    r.querySelector(".rd-now").textContent = now;
    r.querySelector(".rd-now").title = now;
    const idx = STATIONS.findIndex((s) => s.id === st.id);
    r.querySelectorAll(".rd-tune i").forEach((el, i) => el.classList.toggle("on", i === idx));
    r.querySelector(".rd-play").setAttribute("aria-label", active() ? t("pad.radio.pause") : t("pad.radio.play"));
    const out = r.querySelector(".rd-out");
    out.textContent = S.output === "mac" ? "MAC" : "TAB";
    out.title = S.output === "mac" ? t("pad.radio.out.mac") : t("pad.radio.out.tablet");
  }
  for (const tile of S.tiles) {
    const mine = S.id === tile.station;
    tile.el.dataset.on = mine && active() ? "1" : "0"; // lit = this station is playing
    tile.el.dataset.rd = mine ? S.status : "idle";
    const out = tile.el.querySelector(".st-out");
    if (out) out.textContent = S.output === "mac" ? "MAC" : "TAB";
  }
  if ("mediaSession" in navigator && S.output === "tablet") {
    navigator.mediaSession.metadata = active() && m ? new MediaMetadata({ title: m.title || "", artist: m.artist || "", album: st.name }) : null;
  }
}

// Binds the widget to the freshly rendered tile (the pad rebuilds its grid on page changes).
export function mountRadio(el) {
  S.root = el;
  el.querySelector(".rd-play").addEventListener("click", toggle);
  el.querySelector(".rd-prev").addEventListener("click", () => step(-1));
  el.querySelector(".rd-next").addEventListener("click", () => step(1));
  el.querySelector(".rd-out").addEventListener("click", switchOutput);
  startFeed();
  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", () => { if (S.output === "tablet" && !S.tabletWants) toggle(); });
    navigator.mediaSession.setActionHandler("pause", () => { if (S.output === "tablet" && S.tabletWants) toggle(); });
    navigator.mediaSession.setActionHandler("previoustrack", () => step(-1));
    navigator.mediaSession.setActionHandler("nexttrack", () => step(1));
  }
  paint();
}

// Binds a 1-cell station tile. Call before the pad renders a new grid with `resetTiles()`.
export function resetTiles() {
  S.tiles = [];
  S.root = null;
}
export function mountStation(el, stationId) {
  S.tiles.push({ el, station: stationId });
  el.addEventListener("click", () => tune(stationId));
  el.querySelector(".st-out")?.addEventListener("click", (e) => {
    e.stopPropagation(); // switching output must not also play/stop
    switchOutput();
  });
  paint();
}
