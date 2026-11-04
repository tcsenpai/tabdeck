// Overlay effects (CRT, scan bar, glitch, film grain, vignette, chromatic edges): full-screen layers drawn over the
// pad, chosen in the editor (config `fx`) and switched on or off per tablet. Pure CSS (see fx.css): static
// gradients whose opacity or transform is animated, no blur, no blend modes, no JS per frame, so they cost
// little on a weak tablet. The layer ignores touches.
export const FX_NAMES = ["crt", "scanbar", "glitch", "noise", "vignette", "chroma"]; // mirrors lib/config.ts FX_NAMES

let layer = null;
let key = "";

function part(name) {
  const el = document.createElement("div");
  el.className = `fx-part fx-${name}`;
  if (name === "glitch") {
    // Three thin strips and a tint flash that appear together a few times a minute.
    for (let i = 0; i < 3; i++) {
      const s = document.createElement("i");
      s.className = `fx-strip fx-strip-${i}`;
      el.append(s);
    }
    const tint = document.createElement("b");
    tint.className = "fx-tint";
    el.append(tint);
  }
  return el;
}

// Idempotent: the pad calls it on every config load and on the toggle.
export function setFx(list, on) {
  const wanted = on ? list.filter((n) => FX_NAMES.includes(n)).join(",") : "";
  if (wanted === key) return;
  key = wanted;
  layer?.remove();
  layer = null;
  if (!wanted) return;
  layer = document.createElement("div");
  layer.className = "fx-layer";
  layer.setAttribute("aria-hidden", "true");
  layer.append(...wanted.split(",").map(part));
  document.body.append(layer);
}
