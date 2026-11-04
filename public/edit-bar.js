// Editor panel "Info bar": which system chips the pad shows in its bottom bar (cfg.bar, in the order ticked).
import { h } from "/assets/common.js";
import { t } from "/assets/i18n.js";

// Keep in sync with INFO_KINDS in lib/info.ts and MAX in LIMITS.bar of lib/config.ts.
const KINDS = ["cpu", "mem", "battery", "disk", "volume", "uptime", "load", "clock"];
const MAX = 6;

export function barSection({ cfg, touch, rerender }) {
  const toggle = (kind, on) => {
    cfg.bar = cfg.bar.filter((k) => k !== kind);
    if (on) cfg.bar.push(kind);
    touch();
    rerender();
  };
  return h("div", { class: "sec" },
    h("h3", {}, t("edit.bar.title")),
    h("p", { class: "hint" }, t("edit.bar.hint", { max: MAX })),
    ...KINDS.map((k) => {
      const on = cfg.bar.includes(k);
      return h("label", { class: "check" },
        h("input", { type: "checkbox", checked: on, disabled: !on && cfg.bar.length >= MAX, onchange: (e) => toggle(k, e.target.checked) }),
        t(`edit.bar.${k}`));
    }),
  );
}

// "Ambient glow": lets tablets switch on an edge glow that follows the Mac's audio (the ✦ bar button).
export function glowSection({ cfg, touch }) {
  return h("div", { class: "sec" },
    h("h3", {}, t("edit.glow.title")),
    h("label", { class: "check" },
      h("input", { type: "checkbox", checked: cfg.glow, onchange: (e) => { cfg.glow = e.target.checked; touch(); } }),
      t("edit.glow.enable")),
    h("p", { class: "hint" }, t("edit.glow.hint")),
    h("label", { class: "check" },
      h("input", { type: "checkbox", checked: cfg.micCorners, onchange: (e) => { cfg.micCorners = e.target.checked; touch(); } }),
      t("edit.mic.enable")),
    h("p", { class: "hint" }, t("edit.mic.hint")),
  );
}
