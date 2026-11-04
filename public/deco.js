// Decorative, display-only tiles ("deco"): cyberpunk filler for the pad. Nothing here talks to the server.
// Everything is DOM + CSS animated with transform/opacity only (see deco.css); the only JS that keeps running
// is one shared 1 s ticker for the clock tiles, which stops by itself when none is on screen.
// `h` is common.js's DOM helper; user text goes through textContent only.
export const DECO_STYLES = ["clock", "hex", "radar", "pulse", "banner", "leds", "hexmic", "rackmic"]; // mirrors lib/config.ts DECO_STYLES

const rnd = (n) => Math.floor(Math.random() * n);
const hexByte = () => rnd(256).toString(16).toUpperCase().padStart(2, "0");

function hexLines(count) {
  return Array.from({ length: count }, () => Array.from({ length: 6 }, hexByte).join(" ")).join("\n");
}

let clockTimer = 0;
function clockTick() {
  const times = document.querySelectorAll(".dc-time");
  if (!times.length) {
    clockTimer = 0;
    return;
  }
  if (!document.hidden) {
    const now = new Date();
    const hms = now.toLocaleTimeString([], { hour12: false });
    const date = now.toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short" }).toUpperCase();
    for (const el of times) {
      el.textContent = hms;
      const d = el.nextElementSibling;
      if (d) d.textContent = date;
    }
  }
  clockTimer = setTimeout(clockTick, 1000 - (Date.now() % 1000)); // stay aligned to the wall-clock second
}

export function decoInner(h, style, label) {
  const full = DECO_STYLES.includes(style) ? style : "clock";
  const s = full.replace(/mic$/, ""); // hexmic / rackmic draw like hex / leds, then react to sound once mounted
  let body;
  if (s === "clock") {
    body = [h("span", { class: "dc-time" }, "--:--:--"), h("span", { class: "dc-date" })];
    if (!clockTimer) clockTimer = setTimeout(clockTick, 0);
  } else if (s === "hex") {
    const text = hexLines(40);
    // The same block twice, so a translateY of -50% loops seamlessly.
    body = [h("span", { class: "dc-hexwrap" }, h("span", { class: "dc-hexcol" }, text), h("span", { class: "dc-hexcol" }, text))];
  } else if (s === "radar") {
    body = [
      h("span", { class: "dc-rings" }),
      h("span", { class: "dc-sweep" }),
      ...Array.from({ length: 4 }, (_, i) => {
        const blip = h("i", { class: "dc-blip" });
        blip.style.setProperty("--x", `${20 + rnd(60)}%`);
        blip.style.setProperty("--y", `${20 + rnd(60)}%`);
        blip.style.setProperty("--d", `${(i * 1.1).toFixed(1)}s`);
        return blip;
      }),
    ];
  } else if (s === "pulse") {
    body = [h("span", { class: "dc-track" })];
  } else if (s === "banner") {
    const text = label || "TABDECK";
    const word = h("span", { class: "dc-word" }, text);
    word.dataset.text = text;
    body = [word, h("span", { class: "dc-line" })];
  } else {
    body = [
      h("span", { class: "dc-grid" }, ...Array.from({ length: 20 }, () => {
        const led = h("i");
        led.style.setProperty("--dur", `${(0.8 + Math.random() * 2.4).toFixed(2)}s`);
        led.style.setProperty("--del", `-${(Math.random() * 3).toFixed(2)}s`);
        return led;
      })),
    ];
  }
  return h("span", { class: `in dc dc-${s}${full !== s ? " dc-mic" : ""}` }, ...body);
}

// ── Sound-reactive tiles (hexmic, rackmic) ──
// Mounted by the pad only: the editor preview shows them as plain hex / rack. They listen to the same microphone
// frames as the mic corners ([level, onset], 0..1) and settle when the microphone is off.
const unsubs = [];

export function resetDeco() {
  for (const u of unsubs.splice(0)) u();
}

export function mountDeco(el, subscribe) {
  const inner = el.querySelector(".dc-mic");
  if (!inner) return;
  inner.classList.add("live");
  const clamp = (x) => Math.min(1, Math.max(0, x));
  if (inner.classList.contains("dc-hex")) {
    // Scroll speed follows the level and a click surges it; the text brightens with the level (CSS --lvl).
    const wrap = inner.querySelector(".dc-hexwrap");
    let anim = null; // the CSS animation only exists once the tile is in the document: look it up on the first frame
    let rate = 0.25;
    let surge = 0;
    unsubs.push(subscribe((level, onset) => {
      surge = Math.max(surge * 0.8, onset);
      const goal = 0.25 + level * 3 + surge * 4;
      rate += (goal - rate) * 0.35;
      anim ??= wrap?.getAnimations()[0];
      if (anim) anim.playbackRate = rate;
      inner.style.setProperty("--lvl", clamp(level + surge * 0.5).toFixed(2));
    }));
  } else {
    // Rack: five columns, each a VU-style stack of four lights; a click kicks every column up.
    const leds = [...inner.querySelectorAll(".dc-grid i")];
    const weights = Array.from({ length: 5 }, (_, c) => 0.55 + 0.45 * Math.abs(Math.sin(c * 1.7 + 0.6)));
    const peak = new Float32Array(5);
    const shown = new Array(leds.length).fill(-1);
    unsubs.push(subscribe((level, onset) => {
      for (let c = 0; c < 5; c++) {
        const v = clamp(level * weights[c] * (0.85 + 0.3 * Math.random()) + onset * 0.4);
        peak[c] = Math.max(v, peak[c] * 0.86);
        const rows = Math.round(peak[c] * 4);
        for (let r = 0; r < 4; r++) {
          const i = r * 5 + c;
          const on = 3 - r < rows ? 1 : 0;
          if (shown[i] !== on) {
            shown[i] = on;
            leds[i].style.opacity = on ? "1" : "0.12";
          }
        }
      }
    }));
  }
}
