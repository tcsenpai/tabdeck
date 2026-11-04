// Editor panel "Radio favourites": search the radio-browser.info directory (through the Mac's server) and keep
// a few stations as favourites. A favourite then shows up in the radio widget's ‹ › cycle and in the station
// tile's picker. Only the id and the name are saved; the stream URL is resolved on every play.
import { h } from "/assets/common.js";
import { setFavs } from "/assets/radio.js";
import { t } from "/assets/i18n.js";

const MAX_FAVS = 24; // LIMITS.radioFavs in lib/config.ts

const usedBy = (cfg, uuid) => cfg.pages.some((p) => p.buttons.some((b) => b.kind === "station" && b.station === `rb:${uuid}`));

// ctx: { cfg, api, touch, rerender }
export function radioSection(ctx) {
  const { cfg, api, touch, rerender } = ctx;
  const msg = h("p", { class: "hint" });
  const results = h("div", { class: "rb-results" });
  const q = h("input", { type: "text", maxLength: 60, placeholder: t("edit.rb.q"), "aria-label": t("edit.rb.q") });
  const tag = h("input", { type: "text", maxLength: 40, placeholder: t("edit.rb.tag"), "aria-label": t("edit.rb.tag") });
  const go = h("button", { class: "btn", type: "button" }, t("edit.rb.search"));

  const add = (s) => {
    if (cfg.radioFavs.some((f) => f.uuid === s.uuid)) return;
    if (cfg.radioFavs.length >= MAX_FAVS) { msg.textContent = t("edit.rb.full", { max: MAX_FAVS }); return; }
    cfg.radioFavs.push({ uuid: s.uuid, name: s.name });
    setFavs(cfg.radioFavs);
    touch();
    rerender();
  };
  const remove = (f) => {
    if (usedBy(cfg, f.uuid)) { msg.textContent = t("edit.rb.used", { name: f.name }); return; }
    cfg.radioFavs = cfg.radioFavs.filter((x) => x !== f);
    setFavs(cfg.radioFavs);
    touch();
    rerender();
  };

  const row = (s) => {
    const have = cfg.radioFavs.some((f) => f.uuid === s.uuid);
    const meta = [s.country, s.codec && `${s.codec}${s.bitrate ? ` ${s.bitrate}k` : ""}`, s.tags && s.tags.split(",").slice(0, 3).join(", ")].filter(Boolean).join(" · ");
    return h("div", { class: "step" },
      h("div", { class: "step-head" },
        h("strong", {}, s.name),
        h("button", { class: "btn", type: "button", disabled: have, onclick: () => add(s) }, have ? t("edit.rb.added") : t("edit.rb.add"))),
      h("small", { class: "hint" }, meta));
  };

  async function search() {
    const params = new URLSearchParams({ q: q.value.trim() });
    if (tag.value.trim()) params.set("tag", tag.value.trim());
    go.disabled = true;
    msg.textContent = t("edit.rb.searching");
    results.replaceChildren();
    try {
      const list = await api(`/api/radio/search?${params}`);
      msg.textContent = list.length ? "" : t("edit.rb.none");
      results.replaceChildren(...list.map(row));
    } catch (e) {
      msg.textContent = e.message;
    }
    go.disabled = false;
  }
  go.addEventListener("click", search);
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });

  return h("div", { class: "sec" },
    h("h3", {}, t("edit.rb.title")),
    h("p", { class: "hint" }, t("edit.rb.hint")),
    ...cfg.radioFavs.map((f) => h("div", { class: "step" },
      h("div", { class: "step-head" },
        h("strong", {}, f.name),
        h("button", { class: "btn danger", type: "button", title: t("edit.rb.remove"), onclick: () => remove(f) }, "✕")))),
    h("div", { class: "row" }, q, tag),
    h("div", { class: "actions" }, go),
    msg,
    results,
    h("p", { class: "hint" }, t("edit.rb.credit")),
  );
}
