// Macro pad: a single Bun process running on the Mac.
//   /        touch pad for the tablet (anyone on the LAN: can only press already-defined buttons)
//   /edit    editor (Mac only, via localhost)
import { ConfigError, createStore, faderValue, publicView, validateStep, validateSteps, type Step } from "./lib/config.ts";
import { createState } from "./lib/state.ts";
import { catalog, macScript } from "./lib/macos.ts";
import { APP_PRESETS, createContext, matchRule } from "./lib/context.ts";
import { createInfo } from "./lib/info.ts";
import { createRadio, radioCommand } from "./lib/radio.ts";
import { createViz, sseResponse } from "./lib/viz.ts";
import { editorAllowed, sameOriginOk } from "./lib/guard.ts";
import { runSteps } from "./lib/run.ts";
import { networkInterfaces } from "node:os";

const PORT = Number(process.env.PORT) || 8430;
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || `${import.meta.dir}/data`;
const PUBLIC_DIR = `${import.meta.dir}/public`;
const MAX_BODY = 512 * 1024;

const store = createStore(`${DATA_DIR}/pad.json`);
const state = createState(() => store.config, () => store.rev, `${DATA_DIR}/toggles.json`);
const radio = createRadio(DATA_DIR);
const hasRadio = () => store.config.pages.some((p) => p.buttons.some((b) => b.kind === "radio" || b.kind === "station"));
// System-audio visualizer: the helper only runs while a browser is watching. VIZ_HELPER="cmd args"
// replaces it (tests / `tools/sysaudio --test-tone`).
const viz = createViz({ dir: DATA_DIR, helper: process.env.VIZ_HELPER?.trim() ? process.env.VIZ_HELPER.trim().split(/\s+/) : undefined });
const hasViz = () => store.config.pages.some((p) => p.buttons.some((b) => b.kind === "viz"));
const frontmost = createContext(); // which app is in front on the Mac (automatic pages, editor "detect")
const info = createInfo();
// Where the pad's dashboard button goes. "" = the same host on port 8420; "off" hides the button.
// Only http(s) URLs are accepted: the value ends up in window.open() on the tablet.
const KIOSK_URL = (() => {
  const v = (process.env.KIOSK_URL ?? "").trim();
  return v === "off" || /^https?:\/\//i.test(v) ? v : "";
})();
const running: Record<string, true> = {};

const noCache = { "Cache-Control": "no-store" };
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: noCache });

// The Mac's IPv4 addresses (re-read on every request: DHCP can change them).
const localIps = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i!.address);

// Addresses the tablet uses to reach the Mac (shown in the editor).
const lanUrls = () => localIps().map((ip) => `http://${ip}:${PORT}/`);

async function serveFile(name: string): Promise<Response> {
  const file = Bun.file(`${PUBLIC_DIR}/${name}`);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file, { headers: noCache });
}

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new ConfigError("Request too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new ConfigError("Invalid JSON");
  }
}

const FORBIDDEN_HTML = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<body style="font:16px system-ui;background:#0f1115;color:#e6e8ee;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:30em;padding:1.5em"><h2>Editor only reachable from this Mac</h2>
<p>The editor defines commands that run on the Mac, so it only opens from the Mac itself, at
<code>http://localhost:${PORT}/edit</code>.</p><p><a style="color:#7aa2ff" href="/">← Back to the pad</a></p></div>`;

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 60,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const host = req.headers.get("host");

    if (method !== "GET" && method !== "HEAD" && !sameOriginOk(req.headers.get("origin"), host)) {
      return json({ error: "Origin not allowed" }, 403);
    }

    try {
      if (path === "/healthz") return json({ ok: true });

      if (method === "GET" && path === "/") return serveFile("pad.html");
      if (method === "GET" && path === "/manifest.webmanifest") {
        const f = Bun.file(`${PUBLIC_DIR}/manifest.webmanifest`);
        return new Response(f, { headers: { ...noCache, "Content-Type": "application/manifest+json" } });
      }

      if (path === "/edit" || path === "/api/actions" || path === "/api/macscript" || path === "/api/presets" || path === "/api/context" || path.startsWith("/api/config") || path === "/api/test") {
        if (!editorAllowed(host, srv.requestIP(req)?.address, localIps())) {
          return path === "/edit"
            ? new Response(FORBIDDEN_HTML, { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } })
            : json({ error: "Editor only reachable from this Mac" }, 403);
        }
        if (method === "GET" && path === "/edit") return serveFile("edit.html");
        if (method === "GET" && path === "/api/config") return json({ rev: store.rev, config: store.config, lan: lanUrls() });
        if (method === "PUT" && path === "/api/config") {
          const cfg = store.save(await readJson(req));
          if (!hasRadio()) radio.stop(); // the widget was removed: stop the Mac player too
          return json({ rev: store.rev, config: cfg });
        }
        if (method === "GET" && path === "/api/actions") return json(catalog());
        if (method === "GET" && path === "/api/presets") return json(APP_PRESETS);
        if (method === "GET" && path === "/api/context") return json(await frontmost.get());
        if (method === "POST" && path === "/api/macscript") {
          // The AppleScript a "mac" step generates, so the editor can show/convert it.
          const body = await readJson(req);
          const step = validateStep(body && typeof body === "object" && "step" in body ? body.step : undefined, "step");
          if (step.type !== "mac") throw new ConfigError("step: not a mac action");
          return json({ script: macScript(step.action, step.args) });
        }
        if (method === "POST" && path === "/api/test") {
          const body = (await readJson(req)) as { steps?: unknown };
          return json(await runSteps(validateSteps(body?.steps ?? [])));
        }
      }

      if (method === "GET" && path.startsWith("/assets/")) {
        const name = path.slice("/assets/".length);
        if (name.includes("..") || name.includes("/")) return json({ error: "Invalid path" }, 400);
        return serveFile(name);
      }

      if (method === "GET" && path === "/api/pad") return json({ rev: store.rev, kiosk: KIOSK_URL, ...publicView(store.config) });
      if (method === "GET" && path === "/api/rev") return json({ rev: store.rev });
      // The chips come from pad.json, never from the request: a client cannot choose what the server runs.
      if (method === "GET" && path === "/api/info") return json(await info.read(store.config.bar));
      if (method === "GET" && path === "/api/state") {
        const s = await state.get();
        const out: Record<string, unknown> = hasRadio() ? { ...s, radio: radio.get() } : { ...s };
        const { enabled, rules } = store.config.auto;
        if (enabled && rules.length) {
          // Only the page id goes to the tablet: the app name, window title or URL stay on the Mac.
          out.auto = { page: matchRule(rules, await frontmost.get())?.page ?? "" };
        }
        return json(out);
      }
      if (method === "GET" && path === "/api/viz") {
        if (!hasViz()) return json({ error: "No visualizer on this pad" }, 404);
        srv.timeout(req, 0); // a long-lived stream: the default idle timeout would cut it
        return sseResponse(viz, req.signal);
      }
      if (method === "POST" && path === "/api/radio") {
        if (!hasRadio()) return json({ error: "No radio on this pad" }, 404);
        return json(radio.apply(radioCommand(await readJson(req))));
      }

      const act = path.match(/^\/api\/(run|hold|fader)\/([a-z0-9_-]{1,40})$/);
      if (method === "POST" && act) {
        const [, kind, id] = act;
        const btn = store.findButton(id);
        if (!btn) return json({ error: "No such button" }, 404);
        if ((kind === "fader") !== (btn.kind === "fader")) return json({ error: "Wrong button type" }, 422);

        let steps: Step[];
        let env: Record<string, string> = {};
        if (kind === "fader") {
          const body = (await readJson(req)) as { value?: unknown };
          env = { PAD_VALUE: String(faderValue(body?.value)) };
          steps = [{ type: "shell", cmd: btn.fader.set, cwd: "", timeout: 10 }];
        } else {
          steps = kind === "hold" ? btn.hold : btn.steps;
        }
        if (!steps.length) return json({ error: "The button has no actions" }, 422);

        const key = `${kind}:${btn.id}`;
        if (running[key]) return json({ error: "Already running" }, 409);
        running[key] = true;
        try {
          const r = await runSteps(steps, btn.id, env);
          // Latching button: flip only when the chain really ran to the end (a false "only if" guard is not a press).
          if (kind === "run" && r.ok && !r.stopped && btn.toggle && !btn.led.trim()) state.flip(btn.id);
          state.invalidate();
          return json({ ok: r.ok, ms: r.ms, out: r.out, error: r.error });
        } finally {
          delete running[key];
        }
      }
    } catch (e) {
      if (e instanceof ConfigError) return json({ error: e.message }, 400);
      console.error(e);
      return json({ error: "Internal error" }, 500);
    }

    return json({ error: "Not found" }, 404);
  },
});

console.log(`Macro pad:  http://localhost:${server.port}/   (editor: /edit)`);

// Never leave a player running behind us.
process.on("exit", () => {
  radio.stop();
  viz.stop();
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));
