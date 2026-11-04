// Editor panel "Automatic pages": the pad follows the Mac's frontmost app. The first matching rule wins.
// A rule matches the app name or bundle id (exactly, or contains), optionally narrowed by a URL or
// window-title fragment (browsers expose the tab URL). Plain DOM, no state of its own: it edits cfg.auto.
import { h } from "/assets/common.js";
import { t } from "/assets/i18n.js";
import { TEMPLATES } from "/assets/templates.js";

let presets = null;

const field = (label, control) => h("label", { class: "field" }, h("span", {}, label), control);

// ctx: { cfg, api, touch, rerender, newId, currentPage }
export function autoSection(ctx) {
  const { cfg, api, touch, rerender } = ctx;
  const auto = cfg.auto;
  const msg = h("p", { class: "hint" });
  const say = (text) => { msg.textContent = text; };

  const addRule = (rule) => {
    auto.rules.push({ app: "", mode: "is", url: "", title: "", page: ctx.currentPage().id, ...rule });
    touch();
    rerender();
  };

  const ruleRow = (r, i) => {
    const bind = (key) => (e) => { r[key] = e.target.value; touch(); };
    return h("div", { class: "step" },
      h("div", { class: "step-head" },
        h("input", { type: "text", class: "mono", value: r.app, placeholder: t("edit.auto.app"), maxLength: 100, "aria-label": t("edit.auto.app"), oninput: bind("app") }),
        h("select", { "aria-label": t("edit.auto.mode"), onchange: bind("mode") },
          h("option", { value: "is", selected: r.mode === "is" }, t("edit.auto.is")),
          h("option", { value: "contains", selected: r.mode === "contains" }, t("edit.auto.contains"))),
        h("button", { class: "btn danger", type: "button", title: t("edit.auto.remove"), onclick: () => { auto.rules.splice(i, 1); touch(); rerender(); } }, "✕")),
      h("div", { class: "row" },
        field(t("edit.auto.url"), h("input", { type: "text", class: "mono", value: r.url, maxLength: 100, oninput: bind("url") })),
        field(t("edit.auto.titleHas"), h("input", { type: "text", class: "mono", value: r.title, maxLength: 100, oninput: bind("title") }))),
      field(t("edit.auto.page"), h("select", { "aria-label": t("edit.auto.page"), onchange: bind("page") },
        ...cfg.pages.map((p) => h("option", { value: p.id, selected: r.page === p.id }, p.name)))),
    );
  };

  // "Detect": gives the user a few seconds to bring the app to the front, then asks the Mac what is there.
  const detect = h("button", { class: "btn", type: "button" }, t("edit.auto.detect"));
  detect.addEventListener("click", async () => {
    detect.disabled = true;
    for (let s = 4; s > 0; s--) {
      say(t("edit.auto.detecting", { s }));
      await new Promise((r) => setTimeout(r, 1000));
    }
    try {
      const c = await api("/api/context");
      if (!c.app) say(t("edit.auto.detectNone"));
      else {
        addRule({ app: c.app, url: /^https?:/i.test(c.url) ? new URL(c.url).hostname : "" });
        say(t("edit.auto.detected", { app: c.app }));
      }
    } catch (e) {
      say(e.message);
    }
    detect.disabled = false;
  });

  // Presets: the well-known apps. "Rule" only adds the rule; "Starter page" also builds a page of default shortcuts.
  const presetSel = h("select", { "aria-label": t("edit.auto.preset") }, h("option", { value: "" }, t("edit.auto.presetPick")));
  const load = presets
    ? Promise.resolve(presets)
    : api("/api/presets").then((p) => (presets = p)).catch(() => []);
  load.then((list) => {
    for (const p of list) presetSel.append(h("option", { value: p.id }, `${p.name}${TEMPLATES[p.id] ? " ★" : ""}`));
  });
  const chosen = () => (presets ?? []).find((p) => p.id === presetSel.value);
  const addPreset = (withPage) => {
    const p = chosen();
    if (!p) return say(t("edit.auto.presetPick"));
    let pageId = ctx.currentPage().id;
    if (withPage) {
      const tpl = TEMPLATES[p.id];
      if (!tpl) return say(t("edit.auto.noTemplate", { name: p.name }));
      const buttons = tpl.keys.map(([label, icon, color, keys], i) => ({
        id: ctx.newId(), col: (i % 4) * 2, row: Math.floor(i / 4) * 2, w: 2, h: 2, label, icon, color, kind: "button",
        confirm: false, showOutput: false, steps: [{ type: "keys", keys }], hold: [], led: "", toggle: false, fader: { get: "", set: "" }, station: "", style: "",
      }));
      pageId = ctx.newId();
      cfg.pages.push({ id: pageId, name: p.name.slice(0, 30), cols: 4, rows: Math.max(1, Math.ceil(buttons.length / 4)), profile: "", buttons });
    }
    // Several bundle ids (e.g. Teams) become one rule each, so a rename by the vendor does not break it.
    for (const b of p.bundles) auto.rules.push({ app: b, mode: "is", url: "", title: "", page: pageId });
    auto.enabled = true;
    touch();
    rerender();
  };

  return h("div", { class: "sec" },
    h("h3", {}, t("edit.auto.title")),
    h("label", { class: "check" },
      h("input", { type: "checkbox", checked: auto.enabled, onchange: (e) => { auto.enabled = e.target.checked; touch(); } }),
      t("edit.auto.enable")),
    h("p", { class: "hint" }, t("edit.auto.hint")),
    ...auto.rules.map(ruleRow),
    h("div", { class: "actions" },
      h("button", { class: "btn", type: "button", onclick: () => addRule({}) }, t("edit.auto.add")),
      detect),
    field(t("edit.auto.preset"), presetSel),
    h("div", { class: "actions" },
      h("button", { class: "btn", type: "button", onclick: () => addPreset(false) }, t("edit.auto.addPreset")),
      h("button", { class: "btn primary", type: "button", onclick: () => addPreset(true) }, t("edit.auto.addStarter"))),
    msg,
    h("p", { class: "hint" }, t("edit.auto.perm")),
  );
}
