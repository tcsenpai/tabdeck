// "Car stereo" widget: a Nightride FM player (https://nightride.fm), 2–4 cells wide.
// Output is switchable on the widget: the Mac (default; the server runs mpv/ffplay) or this tablet
// (one <audio> element on the station's public MP3 stream). The chosen station and output live on
// the server, so every tablet sees the same thing. Now-playing titles come from Nightride's public
// server-sent-events feed (/meta) and are read directly by the browser.
// Playback survives page changes; only the play/pause key stops it (and drops the download).
import { t } from "/assets/i18n.js";

export const STATIONS = [
  { id: "nightride", name: "Nightride", color: "pink" },
  { id: "chillsynth", name: "Chillsynth", color: "teal" },
  { id: "datawave", name: "Datawave", color: "blue" },
  { id: "spacesynth", name: "Spacesynth", color: "violet" },
  { id: "darksynth", name: "Darksynth", color: "red" },
  { id: "horrorsynth", name: "Horrorsynth", color: "orange" },
  { id: "ebsm", name: "EBSM", color: "slate" },
  { id: "rekt", name: "Rekt", color: "amber" },
  { id: "rektory", name: "Rektory", color: "amber" },
  { id: "rektify", name: "Rektify", color: "green" },
  { id: "d-notive", name: "D-Notive", color: "green" },
];
const STREAM = (id) => `https://stream.nightride.fm/${id}.mp3`;
const META = "https://nightride.fm/meta";

// Markup of the radio face, shared by the pad and the editor preview. `h` is common.js's DOM helper.
export function radioInner(h) {
  const btn = (cls, label, glyph) => h("button", { class: cls, type: "button", "aria-label": label }, glyph);
  return h("span", { class: "in rd" },
    btn("rd-play", t("pad.radio.play"), h("span", { class: "rd-ic" })),
    h("span", { class: "rd-lcd" },
      h("span", { class: "rd-top" },
        h("span", { class: "rd-st" }, `${STATIONS[0].name} FM`),
        h("button", { class: "rd-out", type: "button", title: t("pad.radio.out") }, "MAC"),
        h("span", { class: "rd-eq" }, h("i"), h("i"), h("i"), h("i"), h("i"))),
      h("span", { class: "rd-now" }, "—"),
      h("span", { class: "rd-tune" }, ...STATIONS.map(() => h("i")))),
    h("span", { class: "rd-nav" },
      btn("rd-prev", t("pad.radio.prev"), "‹"),
      btn("rd-next", t("pad.radio.next"), "›")),
  );
}

// ───────────── Player (one per page load) ─────────────
const S = { idx: 0, output: "mac", status: "idle", error: "", tabletWants: false, meta: {}, root: null };
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
  const i = STATIONS.findIndex((s) => s.id === r.station);
  if (i >= 0) S.idx = i;
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
  a.src = STREAM(STATIONS[S.idx].id); // reloading on every play also jumps back to the live edge
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

async function toggle() {
  if (S.output === "tablet") return S.tabletWants && S.status !== "error" ? stopTablet() : ((S.tabletWants = true), tuneTablet());
  if (S.status !== "idle" && S.status !== "error") set("loading"); // optimistic: the answer arrives in a moment
  else set("loading");
  try {
    syncRadio(await post({ toggle: true }));
  } catch (e) {
    fail(e);
  }
}

async function step(d) {
  S.idx = (S.idx + d + STATIONS.length) % STATIONS.length;
  if (S.output === "tablet" && S.tabletWants) tuneTablet();
  paint();
  try {
    const r = await post({ station: STATIONS[S.idx].id });
    if (S.output === "mac") syncRadio(r);
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
  const st = STATIONS[S.idx];
  const m = S.meta[st.id];
  const track = m && (m.artist || m.title) ? [m.artist, m.title].filter(Boolean).join(" — ") : "";
  const now = S.status === "error" ? S.error || t("pad.radio.error") : S.status === "loading" ? t("pad.radio.tuning") : track || t("pad.radio.idle");
  const playing = S.status === "playing" || S.status === "loading";
  const r = S.root;
  if (r) {
    r.dataset.color = st.color;
    r.dataset.rd = S.status;
    r.querySelector(".rd-st").textContent = `${st.name} FM`;
    r.querySelector(".rd-now").textContent = now;
    r.querySelector(".rd-now").title = now;
    r.querySelectorAll(".rd-tune i").forEach((el, i) => el.classList.toggle("on", i === S.idx));
    r.querySelector(".rd-play").setAttribute("aria-label", playing ? t("pad.radio.pause") : t("pad.radio.play"));
    const out = r.querySelector(".rd-out");
    out.textContent = S.output === "mac" ? "MAC" : "TAB";
    out.title = S.output === "mac" ? t("pad.radio.out.mac") : t("pad.radio.out.tablet");
  }
  if ("mediaSession" in navigator && S.output === "tablet") {
    navigator.mediaSession.metadata = playing && m ? new MediaMetadata({ title: m.title || "", artist: m.artist || "", album: `${st.name} FM` }) : null;
  }
}

// Binds the player to the freshly rendered tile (the pad rebuilds its grid on page changes).
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
