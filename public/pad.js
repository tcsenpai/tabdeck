import { api, applyGrid, h, tileEl } from "/assets/common.js";
import { t, register, applyStatic } from "/assets/i18n.js";
import { mountRadio, mountStation, resetTiles, setFavs, syncRadio } from "/assets/radio.js";
import { mountViz, resetViz } from "/assets/viz.js";
import { setBar } from "/assets/bar.js";
import { setGlow } from "/assets/glow.js";
import { setCorners } from "/assets/corners.js";
import en from "/assets/locale-pad-en.js";
import it from "/assets/locale-pad-it.js";

register({ en, it });
applyStatic();

const $ = (id) => document.getElementById(id);
const gridEl = $("grid");
const tabsEl = $("tabs");
const toastEl = $("toast");
const state = {
  cfg: null,
  rev: null,
  pageId: localStorage.getItem("pad.page"),
  online: true,
  live: false, // the current page has LEDs or faders to keep updated
  data: { leds: {}, faders: {}, variants: {} },
};

const POLL_MS = 2500;
const POLL_OFFLINE_MS = 5000;
const ARM_MS = 3000;
const HOLD_MS = 550; // = duration of the bar in .tile.holding .front::after
const SWIPE_PX = 70;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Which profile this tablet is: `?profile=<id>` once, then remembered (`?profile=` clears it).
const profile = (() => {
  const q = new URLSearchParams(location.search).get("profile");
  if (q !== null) {
    if (q) localStorage.setItem("pad.profile", q);
    else localStorage.removeItem("pad.profile");
  }
  return localStorage.getItem("pad.profile") || "";
})();
// Pages for this tablet: its own plus the shared ones; an unknown profile just sees the shared ones.
const visiblePages = (pages) => {
  const mine = pages.filter((p) => !p.profile || p.profile === profile);
  return mine.length ? mine : pages;
};

function page() {
  return state.cfg.pages.find((p) => p.id === state.pageId) || state.cfg.pages[0];
}
const pageIndex = () => state.cfg.pages.indexOf(page());

// The key tilts toward the touched point (fake 3D); it straightens on release.
function tilt(el) {
  const set = (e) => {
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    el.style.setProperty("--rx", `${(-y * 18).toFixed(1)}deg`);
    el.style.setProperty("--ry", `${(x * 18).toFixed(1)}deg`);
  };
  const reset = () => {
    el.style.removeProperty("--rx");
    el.style.removeProperty("--ry");
  };
  el.addEventListener("pointerdown", set);
  el.addEventListener("pointermove", set);
  for (const t of ["pointerup", "pointercancel", "pointerleave"]) el.addEventListener(t, reset);
}

// ───────────── Buttons ─────────────
function wireButton(b, el) {
  tilt(el);
  if (b.hasHold) {
    let timer = 0;
    let sx = 0;
    let sy = 0;
    const clear = () => {
      clearTimeout(timer);
      timer = 0;
      el.classList.remove("holding");
    };
    el.addEventListener("pointerdown", (e) => {
      delete el.dataset.held;
      if (el.dataset.state === "running") return;
      sx = e.clientX;
      sy = e.clientY;
      el.classList.add("holding");
      timer = setTimeout(() => {
        clear();
        el.dataset.held = "1"; // the click that follows the release must not also trigger the normal action
        press(b, el, "hold");
      }, HOLD_MS);
    });
    el.addEventListener("pointermove", (e) => {
      if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 12) clear();
    });
    for (const t of ["pointerup", "pointercancel", "pointerleave"]) el.addEventListener(t, clear);
  }
  el.addEventListener("click", () => {
    if (el.dataset.held) return void delete el.dataset.held;
    press(b, el, "run");
  });
}

// Fader: drag along the track; sending runs at ~10/s and the last value always wins.
function wireFader(b, el) {
  const track = el.querySelector(".track");
  const val = el.querySelector(".val");
  let dragging = false;
  let inflight = false;
  let pending = null;
  let timer = 0;
  let lastTouch = 0;

  const show = (v) => {
    el.style.setProperty("--v", String(v / 100));
    val.textContent = `${v}%`;
    el.setAttribute("aria-valuenow", String(v));
  };
  const valueAt = (e) => {
    const r = track.getBoundingClientRect();
    return Math.max(0, Math.min(100, Math.round(((e.clientX - r.left) / r.width) * 100)));
  };
  async function flush() {
    if (inflight || pending === null) return;
    const value = pending;
    pending = null;
    inflight = true;
    try {
      await api(`/api/fader/${encodeURIComponent(b.id)}`, { method: "POST", body: { value } });
    } catch (e) {
      toast(e instanceof TypeError ? t("pad.offline") : e.message, true);
    }
    inflight = false;
    if (pending !== null) flush();
  }
  const move = (e) => {
    const v = valueAt(e);
    show(v);
    pending = v;
    if (!timer) timer = setTimeout(() => { timer = 0; flush(); }, 90);
  };
  const end = () => {
    if (!dragging) return;
    dragging = false;
    lastTouch = Date.now();
    clearTimeout(timer);
    timer = 0;
    flush();
  };
  el.addEventListener("pointerdown", (e) => {
    dragging = true;
    el.setPointerCapture(e.pointerId);
    navigator.vibrate?.(6);
    move(e);
  });
  el.addEventListener("pointermove", (e) => dragging && move(e));
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  // The Mac's real value must not override the finger (nor its last gesture).
  el._fader = {
    sync(v) {
      if (dragging || inflight || pending !== null || Date.now() - lastTouch < 1500) return;
      show(v);
    },
  };
}

// ───────────── Keys that change with the app in front ─────────────
// The server sends, per key with variants, the index of the one that matches the app in front (-1 = the base key).
// Only presentation is here; the commands stay on the Mac.
const variantOf = (b) => {
  const i = state.data.variants?.[b.id];
  return Number.isInteger(i) && b.variants?.[i] ? i : -1;
};
function viewOf(b) {
  const i = variantOf(b);
  if (i < 0) return { ...b, _vi: -1 };
  const { label, icon, color, confirm, showOutput, hasHold, hidden } = b.variants[i];
  return { ...b, label, icon, color, confirm, showOutput, hasHold, hidden, _vi: i };
}

function buildTile(b) {
  const v = viewOf(b);
  const el = tileEl(v);
  if (b.kind === "radio") mountRadio(el);
  else if (b.kind === "station") mountStation(el, b.station);
  else if (b.kind === "viz") mountViz(el);
  else if (b.kind === "fader") wireFader(v, el);
  else if (b.kind === "button") wireButton(v, el);
  el._vi = v._vi;
  el.classList.toggle("gone", !!v.hidden); // hidden for this app: the cell stays empty
  return el;
}

// Rebuilds only the keys whose variant changed.
function swapVariants() {
  for (const b of page().buttons) {
    if (!b.variants?.length) continue;
    const el = gridEl.querySelector(`.tile[data-id="${CSS.escape(b.id)}"]`);
    // A tile that is running a press keeps its node: the result flash and toast belong to it. The next state refresh swaps it.
    if (el && el.dataset.state !== "running" && el._vi !== variantOf(b)) el.replaceWith(buildTile(b));
  }
}
function render() {
  const p = page();
  state.pageId = p.id;
  state.live = autoOn() || p.buttons.some((b) => b.hasLed || b.variants?.length || b.kind === "fader" || b.kind === "radio" || b.kind === "station");
  applyGrid(gridEl, p);
  resetTiles(); // the previous page's station tiles are about to be replaced
  resetViz();
  const tiles = p.buttons.map(buildTile);
  gridEl.replaceChildren(
    ...(tiles.length
      ? tiles
      : [h("div", { class: "empty" }, t("pad.empty", { url: `http://localhost:${location.port}/edit` }))]),
  );
  tabsEl.replaceChildren(
    ...(state.cfg.pages.length > 1
      ? state.cfg.pages.map((q, i) =>
          h("button", {
            class: "tab",
            type: "button",
            role: "tab",
            "aria-selected": String(q.id === p.id),
            onclick: () => goPage(q.id, i > pageIndex() ? 1 : -1),
          }, q.name),
        )
      : []),
  );
  applyState();
}

// "Cube" page change: the board rotates around an axis behind the screen.
// Two phases on the same element (exit, swap content, enter): one animation at a time, no double DOM.
let switching = false;
async function goPage(id, dir) {
  if (switching || id === state.pageId) return;
  switching = true;
  localStorage.setItem("pad.page", id);
  if (reduceMotion) {
    state.pageId = id;
    render();
    switching = false;
    return;
  }
  const frame = (angle, opacity) => ({
    transform: `perspective(1500px) rotateX(4deg) translateZ(-45vw) rotateY(${angle}deg) translateZ(45vw)`,
    opacity,
  });
  const out = gridEl.animate([frame(0, 1), frame(-dir * 55, 0)], { duration: 160, easing: "ease-in", fill: "forwards" });
  await out.finished.catch(() => {});
  state.pageId = id;
  render();
  const inn = gridEl.animate([frame(dir * 55, 0), frame(0, 1)], { duration: 220, easing: "ease-out" });
  out.cancel();
  await inn.finished.catch(() => {});
  switching = false;
  refreshState();
}

// Horizontal swipe = previous/next page (not on faders, which use dragging).
let swipe = null;
gridEl.addEventListener("touchstart", (e) => {
  swipe = e.touches.length === 1 && !e.target.closest(".fader, .radio") ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
}, { passive: true });
gridEl.addEventListener("touchend", (e) => {
  if (!swipe) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - swipe.x;
  const dy = t.clientY - swipe.y;
  swipe = null;
  if (Math.abs(dx) < SWIPE_PX || Math.abs(dy) > Math.abs(dx) / 2) return;
  const next = state.cfg.pages[pageIndex() + (dx < 0 ? 1 : -1)];
  if (next) goPage(next.id, dx < 0 ? 1 : -1);
}, { passive: true });

// ───────────── Live state ─────────────
function applyState() {
  swapVariants();
  const { leds, faders } = state.data;
  for (const el of gridEl.querySelectorAll(".tile")) {
    const id = el.dataset.id;
    if (Object.hasOwn(leds, id)) el.dataset.on = leds[id] ? "1" : "0";
    if (el._fader && Object.hasOwn(faders, id)) el._fader.sync(faders[id]);
  }
  if (state.data.radio) syncRadio(state.data.radio);
  followAuto();
}

// ───────────── Automatic pages ─────────────
// The server says which page the Mac's frontmost app maps to. The pad moves only when that answer
// CHANGES, so a manual page tap sticks until the app in front changes.
let lastAutoPage = null;
const autoOn = () => !!state.cfg?.auto && localStorage.getItem("pad.auto") !== "off";
function followAuto() {
  const a = state.data.auto;
  if (!autoOn() || !a || switching || a.page === lastAutoPage) return;
  lastAutoPage = a.page;
  const target = state.cfg.pages.find((p) => p.id === a.page); // a page of another tablet's profile is not here
  if (target && target.id !== state.pageId) goPage(target.id, state.cfg.pages.indexOf(target) > pageIndex() ? 1 : -1);
}
function paintAuto() {
  const btn = $("auto");
  btn.hidden = !state.cfg?.auto;
  btn.classList.toggle("on", autoOn());
}
$("auto").addEventListener("click", () => {
  if (autoOn()) localStorage.setItem("pad.auto", "off");
  else localStorage.removeItem("pad.auto");
  lastAutoPage = null; // turning it on follows the current app right away
  paintAuto();
  state.live = autoOn() || state.live;
  refreshState();
});

// Ambient glow: offered when the config allows it, switched on per tablet (it costs battery and CPU).
const glowOn = () => !!state.cfg?.glow && localStorage.getItem("pad.glow") === "on";
// Mic corners: only the corners react to noise, like a mechanical keyboard's lights. Instead of the glow, not
// with it. The tap cycles off → this tablet's microphone → the Mac's microphone → off.
const micMode = () => {
  const m = localStorage.getItem("pad.mic");
  return state.cfg?.micCorners && !glowOn() && (m === "tablet" || m === "mac") ? m : "";
};
function paintGlow() {
  $("glow").hidden = !state.cfg?.glow;
  $("glow").classList.toggle("on", glowOn());
  setGlow(glowOn());
  $("mic").hidden = !state.cfg?.micCorners;
  $("mic").classList.toggle("on", !!micMode());
  $("mic").dataset.src = micMode();
  setCorners(micMode(), (code) => {
    localStorage.removeItem("pad.mic");
    paintGlow();
    toast(t(code === "no-mic-api" ? "pad.mic.insecure" : "pad.mic.denied"), true);
  });
}
$("glow").addEventListener("click", () => {
  if (glowOn()) localStorage.removeItem("pad.glow");
  else {
    localStorage.setItem("pad.glow", "on");
    localStorage.removeItem("pad.mic");
  }
  paintGlow();
});
$("mic").addEventListener("click", () => {
  const cur = micMode();
  let nextMode = { "": "tablet", tablet: "mac", mac: "" }[cur];
  if (nextMode === "tablet" && !navigator.mediaDevices?.getUserMedia) {
    nextMode = "mac"; // insecure origin: the browser hides the microphone, so go straight to the Mac's
    toast(t("pad.mic.insecure"));
  }
  if (nextMode) localStorage.setItem("pad.mic", nextMode);
  else localStorage.removeItem("pad.mic");
  if (nextMode) localStorage.removeItem("pad.glow");
  paintGlow();
});

async function refreshState() {
  if (!state.live) return;
  try {
    state.data = await api("/api/state");
    applyState();
  } catch {
    // the connection dot already signals the Mac is absent
  }
}

// ───────────── Notices ─────────────
let toastTimer;
function toast(msg, isErr = false) {
  toastEl.textContent = msg.length > 400 ? `${msg.slice(0, 400)}…` : msg;
  toastEl.classList.toggle("err", isErr);
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), isErr ? 6000 : 3500);
}

function flash(el, s) {
  el.dataset.state = s;
  setTimeout(() => {
    if (el.dataset.state === s) delete el.dataset.state;
  }, s === "ok" ? 700 : 1200);
}

// "Confirm" buttons: the first tap arms (3 s), the second runs.
function arm(el) {
  const lb = el.querySelector(".lb");
  const original = lb?.textContent ?? "";
  if (lb) lb.textContent = t("pad.armed");
  el.dataset.state = "armed";
  el.armTimer = setTimeout(() => disarm(el, original), ARM_MS);
  el.armOriginal = original;
}
function disarm(el, original = el.armOriginal) {
  clearTimeout(el.armTimer);
  const lb = el.querySelector(".lb");
  if (lb && original !== undefined) lb.textContent = original;
  if (el.dataset.state === "armed") delete el.dataset.state;
}

// mode: "run" (tap) or "hold" (long press; asks no confirmation: it is already a deliberate gesture).
async function press(b, el, mode) {
  const st = el.dataset.state;
  if (st === "running") return;
  if (mode === "run" && b.confirm && st !== "armed") return arm(el);
  disarm(el);
  navigator.vibrate?.(mode === "hold" ? [12, 40, 12] : 12);
  el.dataset.state = "running";
  try {
    // A key with variants says which one it is showing; the server refuses if the app in front changed since.
    const body = b.variants?.length ? JSON.stringify({ variant: b._vi ?? -1 }) : undefined;
    const r = await api(`/api/${mode}/${encodeURIComponent(b.id)}`, { method: "POST", body });
    if (r.ok) {
      flash(el, "ok");
      if (b.showOutput && r.out) toast(r.out);
    } else {
      flash(el, "err");
      toast(r.error || t("pad.error"), true);
    }
  } catch (e) {
    flash(el, "err");
    toast(e instanceof TypeError ? t("pad.offline") : e.message, true);
  }
  refreshState(); // an action can change the state of other LEDs (e.g. mute/volume)
}

// ───────────── Loading and polling ─────────────
async function load() {
  const d = await api("/api/pad");
  d.pages = visiblePages(d.pages);
  state.cfg = d;
  setFavs(d.radioFavs);
  kioskBtn.hidden = d.kiosk === "off";
  paintAuto();
  paintGlow();
  setBar($("chips"), d.bar);
  state.rev = d.rev;
  render();
  refreshState();
}

function setOnline(on) {
  state.online = on;
  $("dot").classList.toggle("off", !on);
}

// Light polling: reload only when the revision changes (edit from the Mac), then refresh LEDs/faders.
async function poll() {
  if (!document.hidden && !switching) {
    try {
      const { rev } = await api("/api/rev");
      setOnline(true);
      if (rev !== state.rev) await load();
      else await refreshState();
    } catch {
      setOnline(false);
    }
  }
  setTimeout(poll, state.online ? POLL_MS : POLL_OFFLINE_MS);
}

const fsBtn = $("fs");
if (document.documentElement.requestFullscreen) {
  fsBtn.addEventListener("click", () =>
    document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {}),
  );
} else {
  fsBtn.hidden = true;
}

$("reload").addEventListener("click", () => location.reload());

// Opens the dashboard kiosk in its own tab (the same tab is reused next time), so nobody has to type
// the address on the tablet. Default: the Mac's port 8420; the server can override it with
// KIOSK_URL, and KIOSK_URL=off hides the button.
const kioskBtn = $("kiosk");
const kioskUrl = () => state.cfg?.kiosk || `${location.protocol}//${location.hostname}:8420/kiosk`;
kioskBtn.addEventListener("click", () => window.open(kioskUrl(), "tabdeck-kiosk"));

// Wake lock only exists in secure contexts (https/localhost): on http://LAN-IP it simply isn't there.
async function keepAwake() {
  try {
    await navigator.wakeLock?.request("screen");
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) keepAwake();
});

load().catch(() => setOnline(false)).finally(poll);
keepAwake();
