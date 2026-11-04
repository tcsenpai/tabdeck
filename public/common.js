// Shared by the pad (tablet) and the editor (Mac). Text goes through textContent only: labels are user data.
import { t } from "/assets/i18n.js";
import { radioInner, stationOut } from "/assets/radio.js";
import { vizInner, vizPreview } from "/assets/viz.js";

export const COLORS = ["slate", "red", "orange", "amber", "green", "teal", "blue", "violet", "pink"];

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// The grid is measured in units; a classic tile is SUB×SUB units, so keys resize in quarter-tile
// steps. SUB and MIN_SIZE mirror lib/config.ts (the server validates them).
export const SUB = 2;
export const MIN_SIZE = { button: [1, 1], station: [1, 1], fader: [2, 1], radio: [4, 2], viz: [2, 1] };

export function applyGrid(gridEl, page) {
  gridEl.style.gridTemplateColumns = `repeat(${page.cols * SUB}, minmax(0, 1fr))`;
  gridEl.style.gridTemplateRows = `repeat(${page.rows * SUB}, minmax(0, 1fr))`;
}

// A pad button: rendered identically on the tablet and in the editor preview.
// `btn` is either the public view (hasHold/hasLed) or the editor's full config (hold/led).
export function tileEl(btn) {
  const isFader = btn.kind === "fader";
  const isRadio = btn.kind === "radio";
  const isStation = btn.kind === "station";
  const isViz = btn.kind === "viz";
  const bare = isFader || isRadio || isStation || isViz; // no tap action of their own: no hold dot
  const hasHold = !bare && (btn.hasHold ?? btn.hold?.length > 0);
  const hasLed = isStation || (!bare && (btn.hasLed ?? (!!btn.led?.trim() || !!btn.toggle))); // a station tile's LED = "playing"
  const dot = hasHold ? h("span", { class: "hdot", title: t("tile.hold") }) : null;
  const label = btn.label ? h("span", { class: "lb" }, btn.label) : null;
  const icon = btn.icon ? h("span", { class: "ic" }, btn.icon, dot) : null;
  const track = isFader
    ? h("span", { class: "track" }, h("span", { class: "fill" }), h("span", { class: "knob" }))
    : null;
  const el = h(
    bare ? "div" : "button",
    {
      class: "tile" + (isFader ? " fader" : "") + (isRadio ? " radio" : "") + (isStation ? " station" : "") + (isViz ? " viz" : ""),
      type: bare ? undefined : "button",
      role: isFader ? "slider" : isRadio ? "group" : isStation ? "button" : isViz ? "img" : undefined,
      tabindex: isStation ? "0" : undefined,
      dataset: { color: btn.color, id: btn.id },
      "aria-label": btn.label || btn.icon || t("tile.button"),
    },
    h("span", { class: "box" },
      h("span", { class: "f front" },
        isRadio ? radioInner(h) : isViz ? vizInner(h) : h("span", { class: "in" }, icon, label, track, isFader ? h("span", { class: "val" }, "–") : null, icon ? null : dot),
        hasLed ? h("span", { class: "led" }) : null,
        isStation ? stationOut(h) : null),
      h("span", { class: "f back" }),
      h("span", { class: "f top" }),
      h("span", { class: "f bottom" }),
      h("span", { class: "f right" }),
    ),
  );
  el.classList.toggle("only-icon", !!btn.icon && !btn.label && !isFader);
  el.classList.toggle("only-label", !btn.icon);
  el.style.gridColumn = `${btn.col + 1} / span ${btn.w || SUB}`;
  el.style.gridRow = `${btn.row + 1} / span ${btn.h || SUB}`;
  if (isFader) el.style.setProperty("--v", "0.5");
  if (isViz) vizPreview(el); // a static spectrum; the pad replaces it with the live one
  return el;
}
