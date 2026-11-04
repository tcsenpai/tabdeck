// System-audio visualizer tile: draws the spectrum the server streams (Server-Sent Events, /api/viz).
// The Mac side captures the system output, runs an FFT and sends ~20 frames/s of band levels.
// The stream is open only while a tile is on screen AND the tab is visible, so an unused or
// backgrounded tile costs nothing (the helper on the Mac stops a few seconds after the last viewer).
// Styles (like cava's): bars, mirror, blocks (DOM bars, only transform animates) and wave, ring
// (one small canvas each, drawn at ~20 fps, device pixel ratio 1 to stay light on weak tablets).
import { t } from "/assets/i18n.js";

export const STYLES = ["bars", "mirror", "blocks", "wave", "ring"];
const BANDS = 32; // matches the server helper's default
const PEAK_FALL = 0.025; // per frame
const CANVAS_STYLES = ["wave", "ring"];

// Markup shared by the pad and the editor preview. `h` is common.js's DOM helper.
export function vizInner(h, style) {
  const s = STYLES.includes(style) ? style : "bars";
  const body = CANVAS_STYLES.includes(s)
    ? h("canvas", { class: "vz-cv" })
    : h("span", { class: "vz-bars" }, ...Array.from({ length: BANDS }, () =>
        h("span", { class: "vz-col" }, h("i", { class: "vz-bar" }), h("b", { class: "vz-cap" }))));
  return h("span", { class: `in vz vz-s-${s}` }, body, h("span", { class: "vz-msg" }));
}

function makeView(el) {
  const inner = el.querySelector(".in.vz");
  const style = STYLES.find((s) => inner?.classList.contains(`vz-s-${s}`)) ?? "bars";
  const cv = el.querySelector(".vz-cv");
  return {
    el,
    style,
    bars: [...el.querySelectorAll(".vz-bar")],
    caps: [...el.querySelectorAll(".vz-cap")],
    peaks: new Float32Array(BANDS),
    smooth: new Float32Array(BANDS),
    cv,
    ctx: cv ? cv.getContext("2d") : null,
    color: "",
  };
}

function clamp01(x) {
  return Math.min(1, Math.max(0, Number(x) || 0));
}

function drawDom(v, values) {
  const mirror = v.style === "mirror";
  for (let i = 0; i < BANDS; i++) {
    const n = clamp01(values[i]);
    v.peaks[i] = Math.max(n, v.peaks[i] - PEAK_FALL);
    v.bars[i].style.transform = `scaleY(${Math.max(n, 0.02)})`;
    // mirror grows from the centre line: the caps ride the top edge of the bar
    v.caps[i].style.transform = mirror ? `translateY(${(1 - v.peaks[i]) * 50}%)` : `translateY(${(1 - v.peaks[i]) * 100}%)`;
  }
}

function fit(v) {
  const w = v.cv.clientWidth;
  const h = v.cv.clientHeight;
  if (v.cv.width !== w || v.cv.height !== h) {
    v.cv.width = w;
    v.cv.height = h;
  }
  if (!v.color) v.color = getComputedStyle(v.el).getPropertyValue("--c").trim() || "#00f0ff";
  return w > 0 && h > 0;
}

function drawWave(v, values) {
  if (!fit(v)) return;
  const { ctx, cv } = v;
  const w = cv.width;
  const h = cv.height;
  ctx.clearRect(0, 0, w, h);
  for (let i = 0; i < BANDS; i++) v.smooth[i] += (clamp01(values[i]) - v.smooth[i]) * 0.6;
  const pad = h * 0.08;
  const y = (i) => h - pad - v.smooth[i] * (h - 2 * pad);
  const x = (i) => (i / (BANDS - 1)) * w;
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(x(0), y(0));
    for (let i = 1; i < BANDS; i++) {
      const mx = (x(i - 1) + x(i)) / 2;
      const my = (y(i - 1) + y(i)) / 2;
      ctx.quadraticCurveTo(x(i - 1), y(i - 1), mx, my); // smooth curve through the band levels
    }
    ctx.lineTo(x(BANDS - 1), y(BANDS - 1));
  };
  path();
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = v.color;
  ctx.fill();
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = v.color;
  ctx.lineWidth = Math.max(5, h * 0.05);
  path();
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineWidth = Math.max(2, h * 0.018);
  ctx.strokeStyle = "#fff";
  path();
  ctx.stroke();
}

function drawRing(v, values) {
  if (!fit(v)) return;
  const { ctx, cv } = v;
  const w = cv.width;
  const h = cv.height;
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h / 2;
  const r0 = Math.min(w, h) * 0.24;
  const rMax = Math.min(w, h) * 0.46 - r0;
  let bass = 0;
  for (let i = 0; i < 4; i++) bass += clamp01(values[i]) / 4;
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(2, (Math.PI * 2 * r0) / (BANDS * 2 * 1.9));
  ctx.strokeStyle = v.color;
  for (let k = 0; k < BANDS * 2; k++) {
    const i = k < BANDS ? k : BANDS * 2 - 1 - k; // low bands at the top, mirrored down both sides
    const n = clamp01(values[i]);
    const a = (k / (BANDS * 2)) * Math.PI * 2 - Math.PI / 2;
    const len = 2 + n * rMax;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
    ctx.stroke();
  }
  ctx.globalAlpha = 0.25 + bass * 0.6; // the inner ring pulses with the bass
  ctx.lineWidth = Math.max(2, r0 * 0.08);
  ctx.strokeStyle = "#fff";
  ctx.beginPath();
  ctx.arc(cx, cy, r0 * (0.9 + bass * 0.12), 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function draw(v, values) {
  if (v.style === "wave") drawWave(v, values);
  else if (v.style === "ring") drawRing(v, values);
  else drawDom(v, values);
}

// A fixed, pleasant-looking spectrum for the editor preview (no audio there).
const DEMO = Array.from({ length: BANDS }, (_, i) => 0.25 + 0.55 * Math.abs(Math.sin(i * 0.5)) * (1 - i / (BANDS * 1.6)));
export function vizPreview(el) {
  const v = makeView(el);
  // a canvas has no size until the tile is attached to the page
  if (v.cv) requestAnimationFrame(() => draw(v, DEMO));
  else draw(v, DEMO);
}

// ───────────── Live connection ─────────────
const views = []; // every visualizer tile on the current page; one stream feeds them all
const subs = new Set(); // plain listeners of the band levels (the ambient glow), independent of the page
let source = null;

function close() {
  source?.close();
  source = null;
}

function open() {
  if ((!views.length && !subs.size) || source || document.hidden || typeof EventSource === "undefined") return;
  source = new EventSource("/api/viz"); // reconnects by itself
  source.onmessage = (e) => {
    try {
      const values = JSON.parse(e.data);
      for (const v of views) draw(v, values);
      for (const fn of subs) fn(values);
    } catch {}
  };
  source.addEventListener("status", (e) => {
    try {
      const s = JSON.parse(e.data);
      const text = s.state === "starting" ? t("pad.viz.starting") : s.state === "silent" ? t("pad.viz.silent") : s.state === "error" ? s.error || t("pad.radio.error") : "";
      for (const v of views) {
        v.el.dataset.vz = s.state;
        v.el.querySelector(".vz-msg").textContent = text;
      }
    } catch {}
  });
}

// The pad rebuilds its grid on page changes: call before rendering, so the old stream is dropped.
export function resetViz() {
  views.length = 0;
  if (!subs.size) close(); // a glow listener keeps the stream across page changes
}

// Band levels (0..1) for something that is not a tile; returns the unsubscribe function.
export function subscribeViz(fn) {
  subs.add(fn);
  open();
  return () => {
    subs.delete(fn);
    if (!subs.size && !views.length) close();
  };
}

export function mountViz(el) {
  views.push(makeView(el));
  open();
}

document.addEventListener("visibilitychange", () => (document.hidden ? close() : open()));
