// Info chips in the pad's bottom bar (CPU, RAM, battery...). The chip list comes from the saved config;
// values are polled from /api/info every few seconds, only while the tab is visible. Plain textContent;
// the gauge is a scaleX transform (cheap on a weak tablet).
import { t } from "/assets/i18n.js";

const POLL_MS = 5000;
let box = null;
let kinds = [];
let timer = 0;
const chips = new Map();

function chip(kind) {
  const el = document.createElement("span");
  el.className = "chip";
  el.dataset.kind = kind;
  const label = document.createElement("small");
  const value = document.createElement("b");
  const gauge = document.createElement("i");
  el.append(label, value, gauge);
  return { el, label, value, gauge };
}

async function poll() {
  clearTimeout(timer);
  if (box && kinds.length && !document.hidden) {
    try {
      const res = await fetch("/api/info", { cache: "no-store" });
      if (res.ok) {
        for (const v of await res.json()) {
          const c = chips.get(v.kind);
          if (!c) continue;
          c.label.textContent = t(`bar.${v.kind}`);
          c.value.textContent = v.text;
          c.el.classList.toggle("warn", !!v.warn);
          c.gauge.style.transform = `scaleX(${v.level === null ? 0 : Math.min(1, Math.max(0, v.level))})`;
          c.gauge.hidden = v.level === null;
        }
      }
    } catch {
      // the connection dot already says the Mac is away
    }
  }
  if (box && kinds.length) timer = setTimeout(poll, POLL_MS);
}

// Rebuilds the chips when the saved list changes (the pad reloads its config on every edit).
export function setBar(container, list) {
  const same = box === container && list.length === kinds.length && list.every((k, i) => k === kinds[i]);
  if (same) return;
  box = container;
  kinds = list;
  chips.clear();
  container.replaceChildren();
  for (const k of kinds) {
    const c = chip(k);
    c.label.textContent = t(`bar.${k}`);
    c.value.textContent = "—";
    chips.set(k, c);
    container.append(c.el);
  }
  container.hidden = !kinds.length;
  poll();
}

document.addEventListener("visibilitychange", () => !document.hidden && poll());
