// System-audio visualizer tile: draws the spectrum the server streams (Server-Sent Events, /api/viz).
// The Mac side captures the system output, runs an FFT and sends ~20 frames/s of band levels.
// The stream is open only while a tile is on screen AND the tab is visible, so an unused or
// backgrounded tile costs nothing (the helper on the Mac stops a few seconds after the last viewer).
// Only transform is animated: bars are scaled, peak caps are translated.
import { t } from "/assets/i18n.js";

const BANDS = 32; // matches the server helper's default
const PEAK_FALL = 0.025; // per frame

// Markup shared by the pad and the editor preview. `h` is common.js's DOM helper.
export function vizInner(h) {
  const cols = Array.from({ length: BANDS }, () =>
    h("span", { class: "vz-col" }, h("i", { class: "vz-bar" }), h("b", { class: "vz-cap" })));
  return h("span", { class: "in vz" }, h("span", { class: "vz-bars" }, ...cols), h("span", { class: "vz-msg" }));
}

function draw(bars, caps, peaks, values) {
  for (let i = 0; i < BANDS; i++) {
    const v = Math.min(1, Math.max(0, Number(values[i]) || 0));
    peaks[i] = Math.max(v, peaks[i] - PEAK_FALL);
    bars[i].style.transform = `scaleY(${Math.max(v, 0.02)})`;
    caps[i].style.transform = `translateY(${(1 - peaks[i]) * 100}%)`;
  }
}

// A fixed, pleasant-looking spectrum for the editor preview (no audio there).
export function vizPreview(el) {
  const bars = [...el.querySelectorAll(".vz-bar")];
  const caps = [...el.querySelectorAll(".vz-cap")];
  const peaks = new Float32Array(BANDS);
  draw(bars, caps, peaks, Array.from({ length: BANDS }, (_, i) => 0.25 + 0.55 * Math.abs(Math.sin(i * 0.5)) * (1 - i / (BANDS * 1.6))));
}

// ───────────── Live connection ─────────────
const views = []; // every visualizer tile on the current page; one stream feeds them all
let source = null;

function close() {
  source?.close();
  source = null;
}

function open() {
  if (!views.length || source || document.hidden || typeof EventSource === "undefined") return;
  source = new EventSource("/api/viz"); // reconnects by itself
  source.onmessage = (e) => {
    try {
      const values = JSON.parse(e.data);
      for (const v of views) draw(v.bars, v.caps, v.peaks, values);
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
  close();
  views.length = 0;
}

export function mountViz(el) {
  views.push({ el, bars: [...el.querySelectorAll(".vz-bar")], caps: [...el.querySelectorAll(".vz-cap")], peaks: new Float32Array(BANDS) });
  open();
}

document.addEventListener("visibilitychange", () => (document.hidden ? close() : open()));
