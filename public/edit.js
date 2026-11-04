import { api, applyGrid, COLORS, h, tileEl } from "/assets/common.js";
import { applyStatic, lang, LANGS, register, setLang, t } from "/assets/i18n.js";
import en from "/assets/locale-edit-en.js";
import it from "/assets/locale-edit-it.js";

register({ en, it });
applyStatic();

const $ = (id) => document.getElementById(id);
const gridEl = $("grid");

// Language selector in the header (changing it reloads the page).
const langSel = $("lang");
langSel.replaceChildren(...Object.entries(LANGS).map(([code, name]) => h("option", { value: code, selected: code === lang }, name)));
langSel.addEventListener("change", (e) => setLang(e.target.value));

// Mac action catalog (GET /api/actions), filled at startup; the server owns the list.
let ACTIONS = [];
const actionDef = (id) => ACTIONS.find((a) => a.id === id);
const macDefaults = (def) => Object.fromEntries(def.params.map((p) => [p.key, p.type === "text" ? "" : p.default]));
// Label from the locale, or `fallback` when the server knows something this editor has no text for.
const tr = (key, fallback) => {
  const s = t(key);
  return s === key ? fallback : s;
};

const STEP_TYPES = {
  shell: t("edit.step.shell"),
  applescript: t("edit.step.applescript"),
  mac: t("edit.step.mac"),
  keys: t("edit.step.keys"),
  text: t("edit.step.text"),
  open: t("edit.step.open"),
  http: t("edit.step.http"),
  click: t("edit.step.click"),
  delay: t("edit.step.delay"),
  when: t("edit.step.when"),
};
const STEP_DEFAULTS = {
  shell: () => ({ type: "shell", cmd: "", cwd: "", timeout: 30 }),
  applescript: () => ({ type: "applescript", script: "" }),
  mac: () => (ACTIONS[0] ? { type: "mac", action: ACTIONS[0].id, args: macDefaults(ACTIONS[0]) } : { type: "mac", action: "", args: {} }),
  keys: () => ({ type: "keys", keys: "" }),
  text: () => ({ type: "text", text: "" }),
  open: () => ({ type: "open", target: "", app: "" }),
  http: () => ({ type: "http", method: "GET", url: "", headers: {}, body: "" }),
  click: () => ({ type: "click", button: "left", count: 2, at: "cursor", x: 0, y: 0 }),
  delay: () => ({ type: "delay", ms: 500 }),
  when: () => ({ type: "when", cmd: "" }),
};
const EMOJI = ["🔔", "📸", "🔇", "🔊", "🔉", "🔒", "📊", "🌐", "🚀", "🎧", "🎵", "⏯️", "⏭️", "⏮️", "💡", "🖥️", "📋", "📁", "✉️", "📅", "⚙️", "🔄", "💾", "🔍", "🎮", "📞", "🧠", "🔥", "⭐", "🏠"];
const CODE_NAMES = {
  Space: "space", Enter: "return", NumpadEnter: "enter", Tab: "tab", Escape: "escape", Backspace: "delete",
  Delete: "forwarddelete", ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
  Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown", Minus: "-", Equal: "=",
  BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Comma: ",", Period: ".",
  Slash: "/", Backslash: "\\", Backquote: "`",
};

const S = { cfg: null, pi: 0, sel: null, version: 0, savedVersion: 0, saving: false, err: "", test: null };

const page = () => S.cfg.pages[S.pi];
const selected = () => page().buttons.find((b) => b.id === S.sel);
// crypto.randomUUID() exists only in secure contexts (https/localhost); the editor is also opened over http://<lan-ip>.
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");

// ───────────── Saving ─────────────
let saveTimer;
function touch() {
  S.version++;
  setStatus();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 500);
}

async function save() {
  if (S.saving) return;
  S.saving = true;
  setStatus();
  const v = S.version;
  try {
    await api("/api/config", { method: "PUT", body: S.cfg });
    S.savedVersion = v;
    S.err = "";
  } catch (e) {
    S.err = t("edit.status.error", { msg: e.message });
  }
  S.saving = false;
  // If something else changed in the meantime (and the last save did not fail), save again.
  if (S.version !== v && !S.err) save();
  setStatus();
}

function setStatus() {
  const el = $("status");
  const dirty = S.version !== S.savedVersion;
  el.className = "status " + (S.err ? "err" : !dirty && !S.saving ? "ok" : "");
  el.textContent = S.err ? `⚠ ${S.err}` : S.saving ? t("edit.status.saving") : dirty ? t("edit.status.dirty") : t("edit.status.saved");
  el.title = S.err;
}
window.addEventListener("beforeunload", (e) => {
  if (S.version !== S.savedVersion) e.preventDefault();
});


// ───────────── Pages ─────────────
function renderPagebar() {
  $("pagebar").replaceChildren(
    ...S.cfg.pages.map((p, i) =>
      h("button", { class: "tab", type: "button", "aria-selected": String(i === S.pi), onclick: () => { S.pi = i; S.sel = null; renderAll(); } }, p.name),
    ),
    S.cfg.pages.length < 12
      ? h("button", { class: "tab", type: "button", title: t("edit.page.new"), onclick: addPage }, "+")
      : null,
  );
}

function addPage() {
  S.cfg.pages.push({ id: newId(), name: t("edit.page.default", { n: S.cfg.pages.length + 1 }), cols: 4, rows: 3, buttons: [] });
  S.pi = S.cfg.pages.length - 1;
  S.sel = null;
  touch();
  renderAll();
}

function stepper(label, value, min, max, onChange) {
  return h("span", { class: "stepper" }, label,
    h("button", { class: "btn sm", type: "button", disabled: value <= min, onclick: () => onChange(value - 1) }, "−"),
    h("b", {}, String(value)),
    h("button", { class: "btn sm", type: "button", disabled: value >= max, onclick: () => onChange(value + 1) }, "+"),
  );
}

// Columns a key covers: 1, except a radio (2–4).
const spanOf = (b) => (b.w > 1 ? b.w : 1);
// The key covering a cell (its own or an extra one of a wide key), ignoring `except`.
const buttonAt = (p, col, row, except) => p.buttons.find((x) => x !== except && x.row === row && col >= x.col && col < x.col + spanOf(x));

function resize(dim, value) {
  const p = page();
  if (p.buttons.some((b) => (dim === "cols" ? b.col + spanOf(b) > value : b.row >= value))) {
    S.err = t(dim === "cols" ? "edit.page.shrinkCols" : "edit.page.shrinkRows");
    setStatus();
    return;
  }
  S.err = "";
  p[dim] = value;
  touch();
  renderAll();
}

function renderPageCfg() {
  const p = page();
  const move = (d) => {
    const j = S.pi + d;
    [S.cfg.pages[S.pi], S.cfg.pages[j]] = [S.cfg.pages[j], S.cfg.pages[S.pi]];
    S.pi = j;
    touch();
    renderAll();
  };
  $("pagecfg").replaceChildren(
    h("input", { type: "text", value: p.name, maxLength: 30, "aria-label": t("edit.page.name"), oninput: (e) => { p.name = e.target.value; touch(); renderPagebar(); } }),
    stepper(t("edit.page.cols"), p.cols, 1, 8, (v) => resize("cols", v)),
    stepper(t("edit.page.rows"), p.rows, 1, 6, (v) => resize("rows", v)),
    h("button", { class: "btn sm", type: "button", disabled: S.pi === 0, title: t("edit.page.moveLeft"), onclick: () => move(-1) }, "◀"),
    h("button", { class: "btn sm", type: "button", disabled: S.pi === S.cfg.pages.length - 1, title: t("edit.page.moveRight"), onclick: () => move(1) }, "▶"),
    h("button", {
      class: "btn sm danger",
      type: "button",
      disabled: S.cfg.pages.length === 1,
      onclick: () => {
        if (!confirm(t("edit.page.confirmDelete", { name: p.name, n: p.buttons.length }))) return;
        S.cfg.pages.splice(S.pi, 1);
        S.pi = Math.max(0, S.pi - 1);
        S.sel = null;
        touch();
        renderAll();
      },
    }, t("edit.page.delete")),
  );
}

// ───────────── Grid ─────────────
function select(id) {
  S.sel = id;
  S.test = null;
  renderGrid();
  renderInspector();
  // Narrow window (<= 900px): the inspector sits below the grid and would stay off screen.
  if (matchMedia("(max-width: 900px)").matches) $("insp").scrollIntoView({ behavior: "smooth", block: "start" });
}

function addButton(col, row) {
  const b = { id: newId(), col, row, label: t("edit.grid.newButton"), icon: "⭐", color: "slate", kind: "button", confirm: false, showOutput: false, steps: [], hold: [], led: "", toggle: false, fader: { get: "", set: "" }, w: 1 };
  page().buttons.push(b);
  touch();
  select(b.id);
}

function moveTo(id, col, row) {
  const p = page();
  const b = p.buttons.find((x) => x.id === id);
  if (!b) return;
  const span = spanOf(b);
  const c = Math.min(col, p.cols - span); // a wide key snaps back inside the grid
  if (b.col === c && b.row === row) return;
  const covered = [];
  for (let i = c; i < c + span; i++) {
    const o = buttonAt(p, i, row, b);
    if (o && !covered.includes(o)) covered.push(o);
  }
  if (covered.length === 0) {
    b.col = c;
    b.row = row;
  } else if (span === 1 && covered.length === 1 && spanOf(covered[0]) === 1) {
    const other = covered[0]; // two plain keys swap places
    [other.col, other.row] = [b.col, b.row];
    [b.col, b.row] = [c, row];
  } else {
    S.err = t("edit.move.blocked");
    return setStatus();
  }
  S.err = "";
  touch();
  renderGrid();
}

function renderGrid() {
  const p = page();
  applyGrid(gridEl, p);
  const slots = [];
  for (let row = 0; row < p.rows; row++) {
    for (let col = 0; col < p.cols; col++) {
      const b = buttonAt(p, col, row);
      if (b && b.col !== col) continue; // covered by a wide key to its left
      const slot = h("div", { class: "slot" + (b && b.id === S.sel ? " sel" : "") });
      slot.style.gridColumn = b && spanOf(b) > 1 ? `${col + 1} / span ${spanOf(b)}` : String(col + 1);
      slot.style.gridRow = String(row + 1);
      if (b) {
        const tile = tileEl(b);
        tile.draggable = true;
        tile.addEventListener("dragstart", (e) => {
          e.dataTransfer.setData("text/plain", b.id);
          e.dataTransfer.effectAllowed = "move";
        });
        tile.addEventListener("click", () => select(b.id));
        slot.append(tile);
      } else {
        slot.append(h("button", { class: "add", type: "button", "aria-label": t("edit.grid.add"), onclick: () => addButton(col, row) }, "+"));
      }
      slot.addEventListener("dragover", (e) => { e.preventDefault(); slot.classList.add("over"); });
      slot.addEventListener("dragleave", () => slot.classList.remove("over"));
      slot.addEventListener("drop", (e) => {
        e.preventDefault();
        slot.classList.remove("over");
        moveTo(e.dataTransfer.getData("text/plain"), col, row);
      });
      slots.push(slot);
    }
  }
  gridEl.replaceChildren(...slots);
}

// ───────────── Inspector ─────────────
const field = (label, control) => h("label", { class: "field" }, h("span", {}, label), control);

// Text field bound to obj[key]; `after` drives the live preview.
function text(obj, key, { placeholder = "", mono = false, after, max } = {}) {
  return h("input", {
    type: "text", value: obj[key] ?? "", placeholder, maxLength: max,
    class: mono ? "mono" : "",
    oninput: (e) => { obj[key] = e.target.value; touch(); after?.(); },
  });
}
function area(obj, key, { placeholder = "", rows = 4 } = {}) {
  return h("textarea", { value: obj[key] ?? "", placeholder, rows, spellcheck: false, oninput: (e) => { obj[key] = e.target.value; touch(); } });
}

function keyName(e) {
  const c = e.code;
  let m = /^Key([A-Z])$/.exec(c);
  if (m) return m[1].toLowerCase();
  m = /^Digit(\d)$/.exec(c);
  if (m) return m[1];
  if (/^F([1-9]|1[0-2])$/.test(c)) return c.toLowerCase();
  return Object.hasOwn(CODE_NAMES, c) ? CODE_NAMES[c] : undefined;
}

function keysField(step) {
  const input = text(step, "keys", { placeholder: "cmd+shift+4", mono: true });
  const rec = h("button", { class: "btn sm", type: "button" }, t("edit.keys.record"));
  let on = false;
  const stop = () => {
    on = false;
    rec.textContent = t("edit.keys.record");
    window.removeEventListener("keydown", onKey, true);
  };
  function onKey(e) {
    if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const name = keyName(e);
    if (!name) return;
    const mods = [e.metaKey && "cmd", e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift"].filter(Boolean);
    step.keys = [...mods, name].join("+");
    input.value = step.keys;
    touch();
    stop();
  }
  rec.addEventListener("click", () => {
    if (on) return stop();
    on = true;
    rec.textContent = t("edit.keys.recording");
    window.addEventListener("keydown", onKey, true);
  });
  return h("div", {}, h("div", { class: "row" }, input, rec), h("p", { class: "hint" }, t("edit.keys.hint")));
}

function headersText(headers) {
  return Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\n");
}

// POST /api/macscript: the AppleScript a "mac" step generates.
async function macScript(step) {
  return (await api("/api/macscript", { method: "POST", body: { step } })).script;
}

function macFields(step, list, i) {
  const def = actionDef(step.action);
  const args = (step.args ??= {});
  const scriptBox = h("div");
  const groups = [...new Set(ACTIONS.map((a) => a.group))];
  const picker = h("select", {
    "aria-label": t("edit.mac.action"),
    onchange: (e) => {
      const next = actionDef(e.target.value);
      step.action = next.id;
      step.args = macDefaults(next);
      touch();
      renderInspector();
    },
  },
    def ? null : h("option", { value: step.action, selected: true }, step.action),
    ...groups.map((g) =>
      h("optgroup", { label: tr(`edit.mac.group.${g}`, g) },
        ...ACTIONS.filter((a) => a.group === g).map((a) => h("option", { value: a.id, selected: a.id === step.action }, tr(`edit.mac.${a.id}`, a.id))))));
  const params = (def?.params ?? []).map((p) => {
    const name = tr(`edit.mac.param.${p.key}`, p.key);
    if (p.type === "int") {
      return field(name, h("input", {
        type: "number", min: p.min, max: p.max, value: args[p.key] ?? p.default,
        oninput: (e) => { args[p.key] = Number(e.target.value); touch(); },
      }));
    }
    if (p.type === "select") {
      return field(name, h("select", { onchange: (e) => { args[p.key] = e.target.value; touch(); } },
        ...p.options.map((o) => h("option", { value: o, selected: o === (args[p.key] ?? p.default) }, tr(`edit.mac.opt.${o}`, o)))));
    }
    return field(name, text(args, p.key, { max: p.max }));
  });
  const show = async () => {
    try {
      scriptBox.replaceChildren(h("pre", { class: "macscript" }, await macScript(step)));
    } catch (e) {
      scriptBox.replaceChildren(h("pre", { class: "macscript err" }, e.message));
    }
  };
  const convert = async () => {
    try {
      list[i] = { type: "applescript", script: await macScript(step) };
      touch();
      renderInspector();
    } catch (e) {
      scriptBox.replaceChildren(h("pre", { class: "macscript err" }, e.message));
    }
  };
  return [
    field(t("edit.mac.action"), picker),
    ...params,
    h("div", { class: "row" },
      h("button", { class: "btn sm", type: "button", disabled: !def, onclick: show }, t("edit.mac.show")),
      h("button", { class: "btn sm", type: "button", disabled: !def, onclick: convert }, t("edit.mac.convert"))),
    h("p", { class: "hint" }, t("edit.mac.hint")),
    scriptBox,
  ];
}

function stepFields(step, list, i) {
  switch (step.type) {
    case "shell":
      return [
        field(t("edit.shell.cmd"), area(step, "cmd", { placeholder: t("edit.shell.cmd.ph"), rows: 5 })),
        h("p", { class: "hint" }, t("edit.hint.padOut")),
        h("div", { class: "row" },
          field(t("edit.shell.cwd"), text(step, "cwd", { placeholder: "~", mono: true })),
          field(t("edit.shell.timeout"), h("input", { type: "number", min: 1, max: 300, value: step.timeout, oninput: (e) => { step.timeout = Number(e.target.value); touch(); } })),
        ),
      ];
    case "applescript":
      return [
        field(t("edit.applescript.script"), area(step, "script", { placeholder: 'tell application "Music" to playpause', rows: 5 })),
        h("p", { class: "hint" }, t("edit.hint.padOutAs")),
      ];
    case "mac":
      return macFields(step, list, i);
    case "when":
      return [
        field(t("edit.when.cmd"), area(step, "cmd", { placeholder: "pgrep -x Music", rows: 3 })),
        h("p", { class: "hint" }, t("edit.when.hint")),
      ];
    case "keys":
      return [
        field(t("edit.keys.combo"), keysField(step)),
        h("div", { class: "row" },
          field(t("edit.keys.repeat"), h("input", {
            type: "number", min: 1, max: 10, value: step.repeat ?? 1,
            oninput: (e) => {
              const n = Math.max(1, Math.min(10, Number(e.target.value) || 1));
              if (n === 1) { delete step.repeat; delete step.gap; } else { step.repeat = n; step.gap ??= 80; }
              touch();
            },
          })),
          field(t("edit.keys.gap"), h("input", {
            type: "number", min: 0, max: 1000, step: 10, value: step.gap ?? 80,
            oninput: (e) => { if (step.repeat > 1) { step.gap = Number(e.target.value); touch(); } },
          }))),
        h("p", { class: "hint" }, t("edit.keys.repeat.hint")),
      ];
    case "text":
      return [field(t("edit.text.text"), area(step, "text", { rows: 3 }))];
    case "open":
      return [
        field(t("edit.open.target"), text(step, "target", { placeholder: t("edit.open.target.ph"), mono: true })),
        field(t("edit.open.app"), text(step, "app", { placeholder: "Safari" })),
      ];
    case "http":
      return [
        h("div", { class: "row" },
          h("select", { onchange: (e) => { step.method = e.target.value; touch(); } },
            ...["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => h("option", { value: m, selected: m === step.method }, m))),
          text(step, "url", { placeholder: "https://…", mono: true }),
        ),
        field(t("edit.http.headers"), h("textarea", {
          value: headersText(step.headers), rows: 2, spellcheck: false,
          oninput: (e) => {
            step.headers = Object.fromEntries(
              e.target.value.split("\n").map((l) => l.split(/:(.*)/s)).filter((p) => p[0].trim()).map((p) => [p[0].trim(), (p[1] ?? "").trim()]),
            );
            touch();
          },
        })),
        field(t("edit.http.body"), area(step, "body", { rows: 3 })),
      ];
    case "click": {
      const num = (key, min, max) =>
        h("input", { type: "number", min, max, value: step[key], oninput: (e) => { step[key] = Number(e.target.value); touch(); } });
      const pick = (key, values, labelKey) =>
        h("select", { onchange: (e) => { step[key] = key === "count" ? Number(e.target.value) : e.target.value; touch(); renderInspector(); } },
          ...values.map((v) => h("option", { value: String(v), selected: step[key] === v }, t(`${labelKey}.${v}`))));
      return [
        h("div", { class: "row" },
          field(t("edit.click.button"), pick("button", ["left", "right", "middle"], "edit.click.btn")),
          field(t("edit.click.count"), pick("count", [1, 2, 3], "edit.click.n"))),
        field(t("edit.click.at"), pick("at", ["cursor", "point"], "edit.click.pos")),
        ...(step.at === "point"
          ? [h("div", { class: "row" }, field("X", num("x", 0, 20000)), field("Y", num("y", 0, 20000)))]
          : []),
        h("p", { class: "hint" }, t("edit.click.hint")),
      ];
    }
    case "delay":
      return [field(t("edit.delay.ms"), h("input", { type: "number", min: 0, max: 60000, step: 100, value: step.ms, oninput: (e) => { step.ms = Number(e.target.value); touch(); } }))];
  }
}

function stepCard(list, step, i) {
  const swap = (j) => {
    [list[i], list[j]] = [list[j], list[i]];
    touch();
    renderInspector();
  };
  return h("div", { class: "step" },
    h("div", { class: "step-head" },
      h("select", { "aria-label": t("edit.step.type"), onchange: (e) => { list[i] = STEP_DEFAULTS[e.target.value](); touch(); renderInspector(); } },
        ...Object.entries(STEP_TYPES).map(([type, name]) => h("option", { value: type, selected: type === step.type }, name))),
      h("button", { class: "btn", type: "button", disabled: i === 0, title: t("edit.step.up"), onclick: () => swap(i - 1) }, "↑"),
      h("button", { class: "btn", type: "button", disabled: i === list.length - 1, title: t("edit.step.down"), onclick: () => swap(i + 1) }, "↓"),
      h("button", { class: "btn danger", type: "button", title: t("edit.step.remove"), onclick: () => { list.splice(i, 1); touch(); renderInspector(); } }, "✕"),
    ),
    ...stepFields(step, list, i),
    step.type === "when"
      ? null
      : h("label", { class: "check" },
          h("input", {
            type: "checkbox", checked: !!step.continueOnError,
            onchange: (e) => {
              if (e.target.checked) step.continueOnError = true;
              else delete step.continueOnError;
              touch();
            },
          }),
          t("edit.step.keepGoing")),
  );
}

async function runTest(steps, box, trigger, ask) {
  if (ask && !confirm(t("edit.run.confirm"))) return;
  trigger.disabled = true;
  box.replaceChildren(h("div", { class: "result" }, t("edit.run.running")));
  let r;
  try {
    r = await api("/api/test", { method: "POST", body: { steps } });
  } catch (e) {
    r = { ok: false, ms: 0, steps: [], error: e.message };
  }
  trigger.disabled = false;
  const mark = (s) => (s.ok ? "✓" : s.ignored ? `✕ (${t("edit.run.ignored")})` : "✕");
  box.replaceChildren(
    h("div", { class: `result ${r.ok ? "ok" : "err"}` },
      `${r.ok ? t("edit.run.ok") : t("edit.run.fail")}${r.ms ? ` · ${r.ms} ms` : ""}`,
      ...r.steps.map((s, i) => h("pre", {}, `${i + 1}. ${STEP_TYPES[s.type] ?? s.type} ${mark(s)} ${s.ms} ms${s.error ? `\n${s.error}` : s.out ? `\n${s.out}` : ""}`)),
      r.stopped ? h("pre", {}, t("edit.run.stopped")) : null,
      !r.steps.length && r.error ? h("pre", {}, r.error) : null,
    ),
  );
}

// Runs a single shell command (LED, fader read/set); `fmt` turns the result into text.
async function shellTest(cmd, box, fmt, prefix = "") {
  box.replaceChildren(h("div", { class: "result" }, "…"));
  let r;
  try {
    r = await api("/api/test", { method: "POST", body: { steps: [{ type: "shell", cmd: prefix + cmd, cwd: "", timeout: 5 }] } });
  } catch (e) {
    r = { ok: false, steps: [], out: "", error: e.message };
  }
  const o = fmt(r);
  box.replaceChildren(h("div", { class: `result ${o.ok ? "ok" : "err"}` }, o.text));
}
const fmtLed = (r) =>
  r.ok ? { ok: true, text: t("edit.led.on") }
  : /code \d+/.test(r.error ?? "") ? { ok: true, text: t("edit.led.off") }
  : { ok: false, text: r.error ?? t("edit.err") };
const fmtGet = (r) => {
  const n = Number.parseFloat(/-?\d+(\.\d+)?/.exec(r.out ?? "")?.[0] ?? "");
  return r.ok && Number.isFinite(n) ? { ok: true, text: t("edit.fader.read", { n }) } : { ok: false, text: r.error || t("edit.fader.notNumber") };
};
const fmtSet = (r) => (r.ok ? { ok: true, text: t("edit.fader.setOk") } : { ok: false, text: r.error ?? t("edit.err") });

const VOL_GET = "osascript -e 'output volume of (get volume settings)'";
const VOL_SET = 'osascript -e "set volume output volume $PAD_VALUE"';

// Free columns for a wide key on its row (ignoring the key itself): { col, w } or null.
function fitWide(p, btn, widths) {
  for (const w of widths) {
    for (let col = Math.min(btn.col, p.cols - w); col >= Math.max(0, btn.col - (w - 1)); col--) {
      let free = true;
      for (let i = col; i < col + w; i++) if (buttonAt(p, i, btn.row, btn)) free = false;
      if (free) return { col, w };
    }
  }
  return null;
}

function failWith(key) {
  S.err = t(key);
  setStatus();
  renderInspector(); // puts the kind selector back to the real value
}

function setKind(btn, kind) {
  if (kind === "radio") {
    // One radio per pad: a single <audio> element on the tablet and one player on the Mac.
    if (S.cfg.pages.some((pg) => pg.buttons.some((x) => x !== btn && x.kind === "radio"))) return failWith("edit.radio.one");
    const fit = fitWide(page(), btn, [3, 2]);
    if (!fit) return failWith("edit.radio.noRoom");
    btn.col = fit.col;
    btn.w = fit.w;
  } else {
    btn.w = 1;
  }
  btn.kind = kind;
  S.err = "";
  // A new fader starts out with the Mac's volume: it is the most common use case.
  if (kind === "fader" && !btn.fader.set.trim()) btn.fader = { get: VOL_GET, set: VOL_SET };
  touch();
  renderGrid();
  renderInspector();
}

function setWidth(btn, w) {
  const fit = fitWide(page(), btn, [w]);
  if (!fit) return failWith("edit.radio.noRoom");
  btn.col = fit.col;
  btn.w = w;
  S.err = "";
  touch();
  renderGrid();
  renderInspector();
}

const stepsSection = (title, list, hint) => [
  h("h3", {}, title),
  hint ? h("p", { class: "hint" }, hint) : null,
  ...list.map((s, i) => stepCard(list, s, i)),
  h("select", {
    "aria-label": t("edit.step.add"),
    onchange: (e) => { if (!e.target.value) return; list.push(STEP_DEFAULTS[e.target.value]()); touch(); renderInspector(); },
  }, h("option", { value: "" }, t("edit.step.addOption")), ...Object.entries(STEP_TYPES).map(([type, name]) => h("option", { value: type }, name))),
];

function renderInspector() {
  const insp = $("insp");
  const btn = selected();
  if (!btn) {
    insp.replaceChildren(h("p", { class: "insp-empty" }, t("edit.insp.empty")));
    return;
  }
  const isFader = btn.kind === "fader";
  const isRadio = btn.kind === "radio";
  const preview = () => renderGrid();
  const [mainBox, holdBox, ledBox, getBox, setBox] = [h("div"), h("div"), h("div"), h("div"), h("div")];
  const testBtn = h("button", { class: "btn primary", type: "button", disabled: !btn.steps.length, onclick: () => runTest(btn.steps, mainBox, testBtn, btn.confirm) }, t("edit.insp.test"));
  const holdTest = h("button", { class: "btn", type: "button", disabled: !btn.hold.length, onclick: () => runTest(btn.hold, holdBox, holdTest, false) }, t("edit.insp.testHold"));
  const ledTest = h("button", { class: "btn", type: "button", disabled: !btn.led.trim(), onclick: () => shellTest(btn.led, ledBox, fmtLed) }, t("edit.insp.ledCheck"));
  const getTest = h("button", { class: "btn", type: "button", onclick: () => shellTest(btn.fader.get, getBox, fmtGet) }, t("edit.insp.readNow"));
  const setTest = h("button", { class: "btn", type: "button", onclick: () => shellTest(btn.fader.set, setBox, fmtSet, "export PAD_VALUE=50\n") }, t("edit.insp.setTest"));
  const common = h("div", { class: "actions" },
    h("button", { class: "btn", type: "button", onclick: () => duplicate(btn) }, t("edit.insp.duplicate")),
    h("button", { class: "btn danger", type: "button", onclick: () => remove(btn) }, t("edit.insp.delete")),
  );

  const radioSec = () => h("div", { class: "sec" },
    h("h3", {}, t("edit.insp.radio")),
    h("p", { class: "hint" }, t("edit.radio.hint")),
    field(t("edit.radio.width"), h("select", { "aria-label": t("edit.radio.width"), onchange: (e) => setWidth(btn, Number(e.target.value)) },
      ...[2, 3, 4].filter((n) => n <= page().cols).map((n) => h("option", { value: String(n), selected: btn.w === n }, String(n))))),
    common,
  );
  insp.replaceChildren(
    ...(isRadio ? [] : [h("div", { class: "sec" },
      h("h3", {}, t("edit.insp.appearance")),
      field(t("edit.insp.label"), text(btn, "label", { after: preview, max: 40 })),
      field(t("edit.insp.icon"), (() => {
        const input = text(btn, "icon", { after: preview, max: 12 });
        return h("div", {}, input,
          h("div", { class: "emoji" }, ...EMOJI.map((em) => h("button", { type: "button", onclick: () => { btn.icon = em; input.value = em; touch(); preview(); } }, em))));
      })()),
      h("div", { class: "field" }, h("span", {}, t("edit.insp.color")),
        h("div", { class: "swatches" }, ...COLORS.map((c) =>
          h("button", { class: "swatch", type: "button", dataset: { color: c }, title: c, "aria-pressed": String(btn.color === c), onclick: () => { btn.color = c; touch(); preview(); renderInspector(); } })))),
    )]),
    h("div", { class: "sec" },
      h("h3", {}, t("edit.insp.behavior")),
      field(t("edit.insp.kind"), h("select", { "aria-label": t("edit.insp.kind"), onchange: (e) => setKind(btn, e.target.value) },
        h("option", { value: "button", selected: !isFader && !isRadio }, t("edit.insp.kind.button")),
        h("option", { value: "fader", selected: isFader }, t("edit.insp.kind.fader")),
        h("option", { value: "radio", selected: isRadio }, t("edit.insp.kind.radio")))),
      ...(isFader || isRadio ? [] : [
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: btn.confirm, onchange: (e) => { btn.confirm = e.target.checked; touch(); } }), `${t("edit.insp.confirm")} `, h("small", {}, t("edit.insp.confirmHint"))),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: btn.showOutput, onchange: (e) => { btn.showOutput = e.target.checked; touch(); } }), t("edit.insp.showOutput")),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: btn.toggle, onchange: (e) => { btn.toggle = e.target.checked; touch(); preview(); } }), `${t("edit.insp.toggle")} `, h("small", {}, t("edit.insp.toggleHint"))),
      ]),
    ),
    ...(isRadio ? [radioSec()] : isFader
      ? [
          h("div", { class: "sec" },
            h("h3", {}, t("edit.insp.fader")),
            h("p", { class: "hint" }, t("edit.insp.faderHint")),
            field(t("edit.insp.faderGet"), text(btn.fader, "get", { mono: true })),
            getTest, getBox,
            field(t("edit.insp.faderSet"), text(btn.fader, "set", { mono: true })),
            setTest, setBox,
            common,
          ),
        ]
      : [
          h("div", { class: "sec" },
            ...stepsSection(t("edit.insp.steps", { n: btn.steps.length }), btn.steps),
            h("div", { class: "actions" }, testBtn),
            mainBox,
            common,
          ),
          h("div", { class: "sec" },
            ...stepsSection(t("edit.insp.hold", { n: btn.hold.length }), btn.hold,
              t("edit.insp.holdHint")),
            holdTest, holdBox,
          ),
          h("div", { class: "sec" },
            h("h3", {}, t("edit.insp.led")),
            h("p", { class: "hint" }, t("edit.insp.ledHint")),
            field(t("edit.insp.ledCmd"), text(btn, "led", { mono: true, after: preview, placeholder: 'pgrep -x Music' })),
            ledTest, ledBox,
          ),
        ]),
  );
}

function duplicate(btn) {
  const p = page();
  if (btn.kind === "radio") {
    S.err = t("edit.radio.one");
    return setStatus();
  }
  const free = [];
  for (let row = 0; row < p.rows; row++) for (let col = 0; col < p.cols; col++) if (!buttonAt(p, col, row)) free.push({ col, row });
  if (!free.length) {
    S.err = t("edit.dup.noFree");
    return setStatus();
  }
  const copy = { ...structuredClone(btn), id: newId(), ...free[0] };
  p.buttons.push(copy);
  S.err = "";
  touch();
  select(copy.id);
}

function remove(btn) {
  const p = page();
  p.buttons.splice(p.buttons.indexOf(btn), 1);
  S.sel = null;
  touch();
  renderGrid();
  renderInspector();
}

function renderAll() {
  renderPagebar();
  renderPageCfg();
  renderGrid();
  renderInspector();
}

// ───────────── Startup ─────────────
try {
  const d = await api("/api/config");
  S.cfg = d.config;
  const lan = d.lan[0];
  if (lan) {
    $("lan").textContent = t("edit.lan", { lan });
    $("lan").addEventListener("click", () => navigator.clipboard?.writeText(lan));
  }
  try {
    ACTIONS = await api("/api/actions");
  } catch (e) {
    S.err = e.message;
  }
  renderAll();
  setStatus();
} catch (e) {
  document.body.replaceChildren(h("p", { style: "padding:2em" }, t("edit.loadError", { msg: e.message })));
}
