// Editor panel "Per-app variants" of a key: "if <app> is in front, this key becomes …". The first matching
// variant wins; with no match the key is as set above. A variant replaces label, icon, colour, confirmation and
// actions (and can hide the key altogether); the LED / latching state stays with the base key.
// The helpers of edit.js are passed in (this file cannot import it).
import { COLORS, h } from "/assets/common.js";
import { t } from "/assets/i18n.js";

let presets = null;
const MAX_VARIANTS = 8; // LIMITS.variants in lib/config.ts

// ctx: { btn, api, touch, rerender, field, text, stepsSection }
export function variantsSection(ctx) {
  const { btn, api, touch, rerender, field, text, stepsSection } = ctx;
  const list = btn.variants;
  const msg = h("p", { class: "hint" });
  const say = (s) => { msg.textContent = s; };

  const add = (extra = {}) => {
    if (list.length >= MAX_VARIANTS) return say(t("edit.var.full", { max: MAX_VARIANTS }));
    list.push({
      app: "", mode: "is", url: "", title: "", hidden: false,
      label: btn.label, icon: btn.icon, color: btn.color, confirm: false, showOutput: false, steps: [], hold: [], ...extra,
    });
    touch();
    rerender();
  };
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    touch();
    rerender();
  };

  const card = (v, i) => h("div", { class: "step" },
    h("div", { class: "step-head" },
      h("strong", {}, v.app ? t("edit.var.when", { app: v.app }) : t("edit.var.new")),
      h("button", { class: "btn", type: "button", title: t("edit.var.up"), disabled: i === 0, onclick: () => move(i, -1) }, "↑"),
      h("button", { class: "btn", type: "button", title: t("edit.var.down"), disabled: i === list.length - 1, onclick: () => move(i, 1) }, "↓"),
      h("button", { class: "btn danger", type: "button", title: t("edit.var.remove"), onclick: () => { list.splice(i, 1); touch(); rerender(); } }, "✕")),
    field(t("edit.var.app"), text(v, "app", { mono: true, max: 100, placeholder: t("edit.auto.app") })),
    h("div", { class: "row" },
      field(t("edit.auto.mode"), h("select", { "aria-label": t("edit.auto.mode"), onchange: (e) => { v.mode = e.target.value; touch(); } },
        h("option", { value: "is", selected: v.mode === "is" }, t("edit.auto.is")),
        h("option", { value: "contains", selected: v.mode === "contains" }, t("edit.auto.contains")))),
      field(t("edit.auto.url"), text(v, "url", { mono: true, max: 100 })),
      field(t("edit.auto.titleHas"), text(v, "title", { mono: true, max: 100 }))),
    h("label", { class: "check" },
      h("input", { type: "checkbox", checked: v.hidden, onchange: (e) => { v.hidden = e.target.checked; touch(); rerender(); } }),
      t("edit.var.hidden")),
    ...(v.hidden ? [] : [
      field(t("edit.insp.label"), text(v, "label", { max: 40 })),
      field(t("edit.insp.icon"), text(v, "icon", { max: 12 })),
      h("div", { class: "field" }, h("span", {}, t("edit.insp.color")),
        h("div", { class: "swatches" }, ...COLORS.map((c) =>
          h("button", { class: "swatch", type: "button", dataset: { color: c }, title: c, "aria-pressed": String(v.color === c), onclick: () => { v.color = c; touch(); rerender(); } })))),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: v.confirm, onchange: (e) => { v.confirm = e.target.checked; touch(); } }), t("edit.insp.confirm")),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: v.showOutput, onchange: (e) => { v.showOutput = e.target.checked; touch(); } }), t("edit.insp.showOutput")),
      ...stepsSection(t("edit.insp.steps", { n: v.steps.length }), v.steps),
      ...stepsSection(t("edit.insp.hold", { n: v.hold.length }), v.hold, t("edit.insp.holdHint")),
    ]));

  // Known apps: one click fills the rule with the bundle id.
  const presetSel = h("select", { "aria-label": t("edit.auto.preset") }, h("option", { value: "" }, t("edit.auto.presetPick")));
  (presets ? Promise.resolve(presets) : api("/api/presets").then((p) => (presets = p)).catch(() => [])).then((all) => {
    for (const p of all) presetSel.append(h("option", { value: p.id }, p.name));
  });
  presetSel.addEventListener("change", () => {
    const p = (presets ?? []).find((x) => x.id === presetSel.value);
    if (p) add({ app: p.bundles[0] });
  });

  const detect = h("button", { class: "btn", type: "button" }, t("edit.auto.detect"));
  detect.addEventListener("click", async () => {
    detect.disabled = true;
    for (let s = 4; s > 0; s--) {
      say(t("edit.auto.detecting", { s }));
      await new Promise((r) => setTimeout(r, 1000));
    }
    try {
      const c = await api("/api/context");
      if (c.app) add({ app: c.app, url: /^https?:/i.test(c.url) ? new URL(c.url).hostname : "" });
      else say(t("edit.auto.detectNone"));
    } catch (e) {
      say(e.message);
    }
    detect.disabled = false;
  });

  return h("div", { class: "sec" },
    h("h3", {}, t("edit.var.title", { n: list.length })),
    h("p", { class: "hint" }, t("edit.var.hint")),
    ...list.map(card),
    h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: () => add() }, t("edit.var.add")), detect),
    presetSel,
    msg,
  );
}
