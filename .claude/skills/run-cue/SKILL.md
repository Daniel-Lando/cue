---
name: run-cue
description: Build, run, and drive the cue Electron overlay app. Use when asked to start cue, take a screenshot of its UI, click a button, or otherwise confirm a change works in the real running app (not just the test suite).
---

cue is a frameless, transparent, always-on-top Electron overlay. There is no
meaningful headless "does it start" check — the whole point is the UI — so drive
it via the Playwright REPL at `.claude/skills/run-cue/driver.mjs`, which launches
the actual Electron runtime, clicks/types into the renderer, and screenshots it.

All commands run from the repo root (`c:\Users\user\cue-1`).

## Prerequisites

```bash
npm install     # installs deps incl. playwright-core (devDep) and Electron.
                # postinstall renames electron.exe -> MicrosoftEdgeUpdate.exe (cue's
                # stealth disguise); the driver finds it via node_modules/electron/path.txt.
```

No display server setup is needed — this is a real Windows desktop. On headless
Linux you'd need `xvfb-run`, but that is not the primary environment here.

## Run (agent path)

Pipe commands to the driver; each line is one action. Screenshots go to
`.tmp-shots/` (override with `SCREENSHOT_DIR`).

```bash
printf 'launch\nss before\nclick #quit-btn\nquit\n' | node .claude/skills/run-cue/driver.mjs
```

For interactive poking, wrap in tmux and `send-keys` one command per line, or just
run `node .claude/skills/run-cue/driver.mjs` and type at the `driver>` prompt.

### Commands

| command | what it does |
|---|---|
| `launch` | start cue, wait for the main window (`renderer/index.html`) |
| `ss [name]` | screenshot the renderer → `.tmp-shots/<name>.png` |
| `click <css-sel>` | click an element (via DOM `.click()`, not coordinates) |
| `click-text <text>` | click the button/link containing this text |
| `type <text>` / `press <key>` | keyboard input to the focused element |
| `wait <css-sel>` | wait up to 10s for a selector |
| `eval <js>` | evaluate raw JS in the renderer, print JSON (no surrounding quotes) |
| `text [css-sel]` | print innerText of a selector (or the whole body) |
| `windows` | list open window URLs |
| `quit` | close the app and exit the driver |

Useful selectors in the top toolbar: `#quit-btn` (close/✕), `#hide-btn` (Hide),
`#stop-btn` (start/stop listening), `#logo-btn`. Settings open via `#more-btn`.

## Run (human path)

```bash
npm start   # opens the overlay window; Ctrl-C in the terminal to quit
```

## Gotchas

- **`ELECTRON_RUN_AS_NODE=1` in the environment breaks launch.** Some harnesses
  set it; it makes the Electron binary run as plain Node, so `app` is `undefined`
  and the app crashes at `src/store.js:7` (`app.getPath` on undefined). The driver
  strips this var before launching. If you launch Electron by hand, `unset` it.
- **The exe is renamed.** postinstall turns `electron.exe` into
  `MicrosoftEdgeUpdate.exe`. Don't hardcode `electron.exe`; read
  `node_modules/electron/path.txt`. The driver does this.
- **OS screenshots come back blank.** The main window uses `setContentProtection`
  (WDA_EXCLUDEFROMCAPTURE), so it's excluded from OS-level screen capture. The
  driver's `ss` takes a DOM-level Playwright screenshot, which bypasses that. It
  also launches with `CUE_NO_PROTECT=1` for good measure.
- **On Windows the permissions gate is skipped** — `launchApp()` loads the main
  window directly, so `launch` reaches the real UI without a consent step. (On
  macOS an unpermitted first run shows `permissions.html` first.)

## Troubleshooting

- **`Process failed to launch!` / crash at store.js** → `ELECTRON_RUN_AS_NODE` is
  set; the driver clears it, so this means you launched Electron another way.
- **`electron binary missing`** → run `npm install` (Electron didn't download).
- **`Cannot find package 'playwright-core'`** → run `npm install`; it's a devDep.
- **Commands print `ERROR: launch first`** → send `launch` first and let it finish
  (it takes a few seconds); the driver serializes commands so piped input is fine.
