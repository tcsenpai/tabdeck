# Macro pad

> 🇬🇧 English · 🇮🇹 [Italiano](README.it.md)

**Turn an old or weak tablet into a macro pad for your Mac.**

A touch grid of buttons that runs shortcuts, shell commands, AppleScript, URLs and
HTTP calls on your Mac. One Bun/TypeScript process, vanilla JS, no build step, no
dependencies.

- **Pad** `http://<mac-ip>:8430/` — the button grid; open it on the tablet.
- **Editor** `http://localhost:8430/edit` — Mac only. Create, move, program and test buttons.

The project is early. The author runs it on a Lenovo Duet Chromebook.

![The pad: 3D keys, a lit latching key, status LEDs, a fader](docs/screenshots/pad.jpg)

<details>
<summary>More screenshots</summary>

A key flips to show the result of the press (here a success):

![A key flipped to its result face](docs/screenshots/pad-flip.jpg)

The editor, on the Mac:

![The editor](docs/screenshots/editor.jpg)

</details>

*Screenshots were taken with a headless browser on a 960×600 (16:10) viewport, using demo buttons, not on a real tablet.*

## Why

Old Chromebooks and 4 GB Android/ChromeOS tablets are too slow for most "dashboard"
web apps, but they make fine macro pads. This one is built to stay light on them:

- No build step, no framework, **zero dependencies** (`package.json` has none).
- The pad page is about **39 KB uncompressed** in total: `pad.html`, `pad.css`,
  `pad-deco.css`, `pad.js`, `pad-deco.js`, `common.js`, `i18n.js` plus the two small pad
  locale files (measured with `wc -c`: 38,957 bytes; 14,608 bytes with each file gzipped on its own, `gzip -9`).
- Animations only use `transform` and `opacity`; no blur and no `backdrop-filter`.
  `prefers-reduced-motion` turns the page transition off.
- The tablet only displays buttons and sends presses; everything runs on the Mac.

## Quick start

Requires [Bun](https://bun.sh) on a Mac.

```bash
git clone <this repo> macrocenter
cd macrocenter
bun start          # or: bun run dev (restarts on server changes)
```

Open the address shown at the top right of the editor on the tablet (click = copy).
Fullscreen: the ⛶ button at the bottom right.

Environment variables: `PORT` (8430), `HOST` (0.0.0.0), `DATA_DIR` (`./data`).

The first time, macOS asks whether `bun` may accept incoming connections: allow it.

### Always on (launchd)

Docker/Compose does not fit: a container is a Linux VM and cannot run `osascript` or
`open` on the Mac, and the whole point is to act on the Mac. Use a LaunchAgent instead;
it starts at login and is restarted if it dies:

```bash
scripts/launchd.sh install     # status | uninstall
```

Log: `~/Library/Logs/macrocenter.log`. The path to `bun` is fixed at install time
(version included): if your version manager updates it and removes the old one, run
`install` again. Grant the Accessibility permission to the `bun` binary (not the
Terminal), because launchd starts the process.

## Features

- **Grid and pages:** swipe horizontally or use the tabs; the board rotates like a cube.
  Swipe does not act on faders.
- **Buttons with step chains:** a button is an ordered list of steps; it stops at the
  first error (unless the step has `continueOnError`).
- **Confirm** option: the first tap arms the button for 3 s, the second runs it.
  **Show output** option: the output appears as a toast on the tablet (errors always do).
- **Long press:** holding ~0.55 s runs the button's "long press" steps instead of the tap
  (no confirm: it is already a deliberate gesture). A **dot on the icon** shows that a
  button has one, and a bar fills while you hold.
- **LED state:** one shell command per button, polled about every 2.5 s and after each
  action. Exit 0 = on (the key lights up). Timeout (3 s) = unknown, the LED does not change.
  The tablet never sees the command, only whether the LED exists.
- **Remember on/off (latching):** for state the Mac cannot report (e.g. a Discord mic mute you
  toggle with a hotkey), tick *Remember on/off*. Each tap that completes (an "only if" guard that
  stops the chain does not count) flips the key between on and off: on = sunk in with a green LED.
  Stored in `data/toggles.json`, survives restarts. It does not see changes made elsewhere: if
  you toggle the mic by hand it will drift, and a button with a status-LED command uses that instead.
- **Faders:** drag along the track; the integer value 0–100 reaches your commands in
  `$PAD_VALUE` (an environment variable, never interpolated into the string) about 10
  times per second. A "read value" command must print a number 0–100; the fader then
  follows the Mac's real value, without overriding your finger or your last gesture (1.5 s).
- **Mac actions catalog:** typed templates that generate AppleScript (see below).
- **`when` guard** and **`continueOnError`** (see below).
- **Language:** English or Italian (see below).

### Step types

| Step | What it does | Notes |
|---|---|---|
| `shell` | `zsh -lc "<cmd>"`, working directory and timeout (default 30 s, max 300) | The timeout kills child processes too. A background `cmd &` does not block the button |
| `applescript` | `osascript` from stdin (30 s timeout) | |
| `mac` | An action from the catalog below; generates the AppleScript | Some need *Accessibility* |
| `keys` | `cmd+shift+4`, `ctrl+left`, `f5`… A lone modifier (`opt`, `cmd+shift`) is tapped. Optional **Presses** (1–10) and a gap (ms) for quick repeats, e.g. a double tap of Option | **Record** button in the editor. Needs *Accessibility* |
| `text` | Types the text (newline = Return) | Needs *Accessibility* |
| `open` | URL, file, folder and/or app (`open`) | |
| `http` | GET/POST/PUT/PATCH/DELETE with headers and body, 10 s timeout | `http(s)://` only |
| `click` | Mouse click: left/right/middle, 1–3 clicks (double click = 2), at the pointer or at fixed screen coordinates | Needs *Accessibility*. Digits in `keys` are sent as top-row key codes |
| `delay` | 0–60000 ms | Between two steps |
| `when` | Shell guard (10 s timeout) | Exit 0 = continue, exit 1 = stop the chain silently, anything else = error |

### Mac actions

Defined in `lib/macos.ts`. Arguments are validated and escaped on the server. The
editor lists the catalog (`GET /api/actions`) and can show the generated AppleScript
(`POST /api/macscript`).

| Group | Actions |
|---|---|
| `music` | `music.playpause`, `music.next`, `music.previous`, `music.volume` (level 0–100) |
| `spotify` | `spotify.playpause`, `spotify.next`, `spotify.previous`, `spotify.volume` (level 0–100) |
| `system` | `system.volume` (0–100), `system.volumeStep` (delta −100…100), `system.mute` (toggle/on/off), `system.notify` (title, message), `system.darkMode` (toggle/dark/light), `system.sleepDisplay`, `system.lock` |
| `app` | `app.open`, `app.quit`, `app.hide` (app name) |
| `ui` | `ui.menu` (app, menu, menu item) |
| `window` | `window.move` (x, y), `window.resize` (width, height), `window.fullscreen` |

`app.hide`, `ui.menu`, `window.*`, `system.darkMode` and `system.lock` go through System
Events and so need the Accessibility permission.

### Guards, ignored errors and passing data between steps

- **`when`**: `{ "type": "when", "cmd": "…" }`. If it evaluates to false (exit 1) the chain
  ends without error: the result stays `ok` and carries `stopped: true`.
- **`continueOnError: true`** (on any step except `when`): if the step fails, the chain
  goes on and the step is marked `ignored: true`.
- **`$PAD_OUT`**: the previous step's output, as an environment variable for `shell`,
  `applescript`, `mac` and `when` steps (in AppleScript: `system attribute "PAD_OUT"`).
- **`$PAD_BUTTON`**: the button id, available to the same steps. **`$PAD_VALUE`**: the fader
  value, for faders.

### Accessibility permission

Needed for `keys`, `text` and the Mac actions that use System Events: System Settings →
Privacy & Security → Accessibility → add the program that launches `bun` (e.g. Terminal;
with launchd, the `bun` binary). Without it the button fails and the toast explains why.

## Language

English is the default. Open `/?lang=it` for Italian; the choice is remembered in the
browser. Without a choice, the browser language is detected. The editor has a language
selector. Server messages (errors, results) are English only and not localized.

## Security model

The server listens on the LAN and a button can run commands on your Mac. So:

- The tablet can **only press buttons that already exist**: `GET /api/pad` never contains
  the commands, and `POST /api/run/<id>` only runs what is in `data/pad.json`.
- **Editor, save, test and action-catalog endpoints** (`/edit`, `/api/config`, `/api/test`,
  `/api/actions`, `/api/macscript`) answer only when the connection comes from the Mac
  itself (loopback or one of its own LAN IPs) **and** the `Host` header is `localhost` or
  one of the Mac's IPs (blocks DNS rebinding). From the tablet or any other device: 403.
- POST/PUT requests with an `Origin` from another site are rejected (CSRF).
- **The pad has no authentication**: anyone on your LAN can press the buttons. Use
  *confirm* for dangerous buttons, and put a firewall in front if the network is untrusted.

## Data

`data/pad.json` is the single source of truth (gitignored; on first start it holds an
example pad with harmless actions). Every save is atomic and keeps the previous copy in
`pad.json.bak`. If the file is invalid the server does not start and does not overwrite it.
You can edit it by hand: the tablet updates itself (it polls `/api/rev` every 2.5 s; the
revision changes on every save from the editor).

## Project layout

```
server.ts          Bun.serve: routing, guards, limits
lib/config.ts      schema, validation, seed, atomic store
lib/run.ts         step execution (timeouts, process tree, output)
lib/macos.ts       Mac actions catalog (generated AppleScript)
lib/keys.ts        "cmd+shift+4" → System Events AppleScript
lib/guard.ts       loopback / Host / Origin checks
lib/state.ts       LED and fader state probes
public/pad.*       the pad for the tablet
public/edit.*      the editor
public/common.js   DOM helper + tile shared by pad and editor
public/i18n.js     translations (en/it)
tests/             bun test
```

## Known limits

- Over `http://<LAN-IP>` Chrome does not expose the Wake Lock API (it needs https or
  localhost): to keep the tablet's screen on, adjust the ChromeOS screen lock settings.
- If the Mac sleeps, the pad shows a red dot at the bottom and retries every 5 s.
- One editor at a time: the last save wins.
- macOS only (it relies on `osascript`, `open` and `zsh`).

## Tested on

Honestly: the server was run on a Mac as host and the pad and editor were exercised with
the Mac's Chrome (headless) at desktop viewport sizes. The tablet side is **designed
for** old/weak tablets such as the Lenovo Duet Chromebook the author uses; no other
tablets have been tested.
