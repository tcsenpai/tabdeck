// "Record" button for a step list: the Mac listens to the keys and clicks you make and the editor appends
// them as steps. Needs the macOS Input Monitoring permission for the process running the server.
// The inspector is rebuilt on every edit, so the recording state lives at module level and the most recently
// built control for the recording list is the one that gets repainted.
import { h } from "/assets/common.js";
import { t } from "/assets/i18n.js";

const POLL_MS = 700;
let active = null; // the step list being recorded into; the other lists' buttons stay disabled
let view = null; // { paint, msg, touch, rerender, api } of the control showing `active`
let timer = 0;

// A click on Stop made on the Mac itself is itself recorded: the editor drops that last click.
const onThisMac = () => ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

async function poll() {
  clearTimeout(timer);
  if (!active || !view) return;
  try {
    const st = await view.api("/api/record");
    if (!active) return;
    view.paint(st);
    if (st.state !== "recording" && st.state !== "starting") return finish(st.error ?? t("edit.rec.failed"));
  } catch (e) {
    return finish(e.message);
  }
  timer = setTimeout(poll, POLL_MS);
}

// Ends the recording on the server and appends what was captured (also after the hard time limit).
async function finish(problem) {
  clearTimeout(timer);
  const list = active;
  const v = view;
  if (!list || !v) return;
  active = null;
  let steps = [];
  try {
    ({ steps } = await v.api("/api/record/stop", { method: "POST" }));
  } catch (e) {
    problem ||= e.message;
  }
  if (onThisMac() && steps.at(-1)?.type === "click") steps.pop();
  list.push(...steps);
  v.msg.textContent = problem || t("edit.rec.done", { n: steps.length });
  if (steps.length) v.touch();
  v.rerender();
}

export function recordControl({ list, api, touch, rerender }) {
  const msg = h("p", { class: "hint" });
  const btn = h("button", { class: "btn", type: "button" });

  const paint = (st) => {
    const mine = active === list;
    btn.disabled = active !== null && !mine;
    btn.classList.toggle("danger", mine);
    btn.textContent = mine ? t("edit.rec.stop", { n: st?.events ?? 0 }) : t("edit.rec.start");
  };

  btn.addEventListener("click", async () => {
    if (active === list) return finish("");
    if (active) return;
    msg.textContent = "";
    try {
      const st = await api("/api/record/start", { method: "POST" });
      if (st.state === "error") throw new Error(st.error);
      active = list;
      view = { paint, msg, touch, rerender, api };
      paint(st);
      msg.textContent = t("edit.rec.hint");
      poll();
    } catch (e) {
      await api("/api/record/cancel", { method: "POST" }).catch(() => {});
      msg.textContent = e.message;
    }
  });

  if (active === list) {
    view = { paint, msg, touch, rerender, api };
    msg.textContent = t("edit.rec.hint");
  }
  paint(null);
  return h("div", { class: "actions" }, btn, msg);
}
