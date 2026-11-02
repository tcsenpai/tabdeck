// Shared by the pad (tablet) and the editor (Mac). Text goes through textContent only: labels are user data.
import { t } from "/assets/i18n.js";

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

export function applyGrid(gridEl, page) {
  gridEl.style.gridTemplateColumns = `repeat(${page.cols}, minmax(0, 1fr))`;
  gridEl.style.gridTemplateRows = `repeat(${page.rows}, minmax(0, 1fr))`;
}

// A pad button: rendered identically on the tablet and in the editor preview.
// `btn` is either the public view (hasHold/hasLed) or the editor's full config (hold/led).
export function tileEl(btn) {
  const isFader = btn.kind === "fader";
  const hasHold = !isFader && (btn.hasHold ?? btn.hold?.length > 0);
  const hasLed = !isFader && (btn.hasLed ?? (!!btn.led?.trim() || !!btn.toggle));
  const dot = hasHold ? h("span", { class: "hdot", title: t("tile.hold") }) : null;
  const label = btn.label ? h("span", { class: "lb" }, btn.label) : null;
  const icon = btn.icon ? h("span", { class: "ic" }, btn.icon, dot) : null;
  const track = isFader
    ? h("span", { class: "track" }, h("span", { class: "fill" }), h("span", { class: "knob" }))
    : null;
  const el = h(
    isFader ? "div" : "button",
    {
      class: "tile" + (isFader ? " fader" : ""),
      type: isFader ? undefined : "button",
      role: isFader ? "slider" : undefined,
      dataset: { color: btn.color, id: btn.id },
      "aria-label": btn.label || btn.icon || t("tile.button"),
    },
    h("span", { class: "box" },
      h("span", { class: "f front" },
        h("span", { class: "in" }, icon, label, track, isFader ? h("span", { class: "val" }, "–") : null, icon ? null : dot),
        hasLed ? h("span", { class: "led" }) : null),
      h("span", { class: "f back" }),
      h("span", { class: "f top" }),
      h("span", { class: "f bottom" }),
      h("span", { class: "f right" }),
    ),
  );
  el.classList.toggle("only-icon", !!btn.icon && !btn.label && !isFader);
  el.classList.toggle("only-label", !btn.icon);
  el.style.gridColumn = String(btn.col + 1);
  el.style.gridRow = String(btn.row + 1);
  if (isFader) el.style.setProperty("--v", "0.5");
  return el;
}
