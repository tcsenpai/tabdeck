// Runs actions on the Mac. No string interpolation into a shell:
// osascript/open get argv or stdin; only the "shell" step goes through zsh (that is its purpose).
import { keysScript, parseKeys, textScript } from "./keys.ts";
import { macScript } from "./macos.ts";
import { clickScript } from "./mouse.ts";
import type { Step } from "./config.ts";

const HOME = process.env.HOME || "/";
const expand = (p: string) => (p === "~" ? HOME : p.startsWith("~/") ? HOME + p.slice(1) : p);
const OUT_CAP = 4000;
// After the process exits we wait no longer than this for the pipes: a child in the
// background (`cmd &`) would hold them open forever.
const PIPE_GRACE_MS = 250;

export interface StepResult {
  type: Step["type"];
  ok: boolean;
  ms: number;
  out: string;
  error?: string;
  ignored?: true; // failed, but the step has continueOnError so the chain went on
  stop?: true; // a "when" guard evaluated to false: the chain ends here, without error
}
export interface RunResult {
  ok: boolean;
  ms: number;
  steps: StepResult[];
  out: string;
  error?: string;
  stopped?: true;
}

function collect(stream: ReadableStream<Uint8Array>) {
  const dec = new TextDecoder();
  let text = "";
  const done = (async () => {
    for await (const chunk of stream) if (text.length < OUT_CAP) text += dec.decode(chunk, { stream: true });
  })().catch(() => {});
  return { done, get text() { return text; } };
}

async function exec(
  cmd: string[],
  o: { stdin?: string; cwd?: string; timeoutMs: number; env?: Record<string, string> },
): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  const proc = Bun.spawn(cmd, {
    stdin: o.stdin === undefined ? "ignore" : new Blob([o.stdin]),
    stdout: "pipe",
    stderr: "pipe",
    cwd: o.cwd,
    env: { ...process.env, ...o.env },
    detached: true, // own process group: the timeout can kill the whole tree
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
  }, o.timeoutMs);

  const out = collect(proc.stdout);
  const err = collect(proc.stderr);
  const code = await proc.exited;
  clearTimeout(timer);
  await Promise.race([Promise.all([out.done, err.done]), Bun.sleep(PIPE_GRACE_MS)]);
  const text = [out.text.trimEnd(), err.text.trimEnd()].filter(Boolean).join("\n").slice(0, OUT_CAP);
  return { code, out: text, timedOut };
}

function osascriptHint(out: string): string {
  return /1002|not allowed to send keystrokes|assistive/i.test(out)
    ? `${out}\n→ Grant "Accessibility" to the process that runs the server (System Settings → Privacy & Security).`
    : out;
}

async function runStep(step: Step, env: Record<string, string>): Promise<StepResult> {
  const t0 = performance.now();
  const done = (ok: boolean, out = "", error?: string): StepResult => ({
    type: step.type,
    ok,
    ms: Math.round(performance.now() - t0),
    out,
    error,
  });
  const fromExec = (r: { code: number | null; out: string; timedOut: boolean }, timeoutS: number, osa = false) => {
    if (r.timedOut) return done(false, r.out, `Timed out after ${timeoutS}s`);
    if (r.code !== 0) {
      const msg = osa ? osascriptHint(r.out) : r.out;
      return done(false, r.out, msg || `Exited with code ${r.code}`);
    }
    return done(true, r.out);
  };

  try {
    switch (step.type) {
      case "shell":
        return fromExec(
          await exec(["/bin/zsh", "-lc", step.cmd], {
            cwd: step.cwd ? expand(step.cwd) : HOME,
            timeoutMs: step.timeout * 1000,
            env,
          }),
          step.timeout,
        );
      case "applescript":
        return fromExec(await exec(["/usr/bin/osascript", "-"], { stdin: step.script, timeoutMs: 30000, env }), 30, true);
      case "mac":
        return fromExec(
          await exec(["/usr/bin/osascript", "-"], { stdin: macScript(step.action, step.args), timeoutMs: 30000, env }),
          30,
          true,
        );
      case "when": {
        // Convention of test/grep: exit 0 = true, 1 = false, anything else (127 = not found...) is a real error.
        const r = await exec(["/bin/zsh", "-lc", step.cmd], { cwd: HOME, timeoutMs: 10000, env });
        if (r.timedOut) return done(false, r.out, "Timed out after 10s");
        if (r.code === 0) return done(true, r.out);
        if (r.code === 1) return { ...done(true, r.out), stop: true };
        return done(false, r.out, r.out || `Guard exited with code ${r.code}`);
      }
      case "keys":
        return fromExec(
          await exec(["/usr/bin/osascript", "-"], { stdin: keysScript(parseKeys(step.keys), step.repeat, step.gap), timeoutMs: 30000 }),
          30,
          true,
        );
      case "text":
        return fromExec(await exec(["/usr/bin/osascript", "-"], { stdin: textScript(step.text), timeoutMs: 30000 }), 30, true);
      case "open": {
        const args: string[] = [];
        if (step.app.trim()) args.push("-a", step.app.trim());
        if (step.target.trim()) args.push(/^[a-z][a-z0-9+.-]*:\/\//i.test(step.target) ? step.target : expand(step.target));
        return fromExec(await exec(["/usr/bin/open", ...args], { timeoutMs: 10000 }), 10);
      }
      case "http": {
        const res = await fetch(step.url, {
          method: step.method,
          headers: step.headers,
          body: step.method === "GET" || !step.body ? undefined : step.body,
          signal: AbortSignal.timeout(10000),
        });
        const body = (await res.text()).slice(0, 500);
        return res.ok ? done(true, body) : done(false, body, `HTTP ${res.status}`);
      }
      case "click":
        return fromExec(await exec(["/usr/bin/osascript", "-l", "JavaScript", "-"], { stdin: clickScript(step), timeoutMs: 10000, env }), 10, true);
      case "delay":
        await Bun.sleep(step.ms);
        return done(true);
    }
  } catch (e) {
    const err = e as Error;
    return done(false, "", err.name === "TimeoutError" ? "Timed out after 10s" : err.message);
  }
}

// State probe (LED, fader read): same shell as the steps, short timeout.
export function probe(cmd: string, timeoutMs = 3000) {
  return exec(["/bin/zsh", "-lc", cmd], { cwd: HOME, timeoutMs });
}

// Runs the steps in order. A failure stops the chain unless the step has continueOnError;
// a "when" guard that evaluates to false ends it silently. Every step sees the previous
// step's output as $PAD_OUT (also readable from AppleScript via `system attribute "PAD_OUT"`).
// `extraEnv` is added to the environment (e.g. PAD_VALUE).
export async function runSteps(steps: Step[], buttonId = "", extraEnv: Record<string, string> = {}): Promise<RunResult> {
  const t0 = performance.now();
  const results: StepResult[] = [];
  let prev = "";
  let stopped = false;
  for (const step of steps) {
    const r = await runStep(step, { PAD_BUTTON: buttonId, PAD_OUT: prev, ...extraEnv });
    if (!r.ok && step.continueOnError) r.ignored = true;
    results.push(r);
    prev = r.out;
    if (r.stop) {
      stopped = true;
      break;
    }
    if (!r.ok && !r.ignored) break;
  }
  const failed = results.find((r) => !r.ok && !r.ignored);
  const lastOut = [...results].reverse().find((r) => r.out)?.out ?? "";
  return {
    ok: !failed,
    ms: Math.round(performance.now() - t0),
    steps: results,
    out: lastOut,
    error: failed?.error,
    ...(stopped ? { stopped: true as const } : {}),
  };
}
