// Decorative, display-only tiles ("deco"): cyberpunk filler for the pad. Nothing here talks to the server.
// Everything is DOM + CSS animated with transform/opacity only (see deco.css); the only JS that keeps running
// is one shared 1 s ticker for the clock tiles, which stops by itself when none is on screen.
// `h` is common.js's DOM helper; user text goes through textContent only.
export const DECO_STYLES = ["clock", "hex", "radar", "pulse", "banner", "leds"]; // mirrors lib/config.ts DECO_STYLES

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
  const s = DECO_STYLES.includes(style) ? style : "clock";
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
  return h("span", { class: `in dc dc-${s}` }, ...body);
}
