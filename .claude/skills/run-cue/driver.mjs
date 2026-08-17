// REPL driver for the cue Electron overlay. Drives the real app via Playwright.
//
// Designed for agents: pipe commands on stdin, read results on stdout. Works on
// Windows/macOS/Linux against the actual Electron runtime (no test-suite mocks).
//
// Two gotchas this driver handles for you:
//   1. postinstall renames electron.exe -> MicrosoftEdgeUpdate.exe (cue's stealth
//      disguise). We read node_modules/electron/path.txt to find the real binary.
//   2. Harnesses often set ELECTRON_RUN_AS_NODE=1, which makes the Electron binary
//      run as plain Node (app === undefined -> crash in src/store.js). We strip it.
//
// The main window uses setContentProtection (excluded from OS screen capture), so
// screenshots are taken at the DOM level via Playwright — which bypasses that.
//
// Requires playwright-core. If it is not a project dep, install it anywhere and run
//   NODE_PATH=/path/to/node_modules node .claude/skills/run-cue/driver.mjs
//
// Commands: launch, ss [name], click <sel>, click-text <text>, type <text>,
//           press <key>, wait <sel>, eval <js>, text [sel], windows, quit, help
import { _electron as electron } from 'playwright-core';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '../../..');
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.tmp-shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

// postinstall renames electron.exe; path.txt records the current name.
const distDir = path.join(APP_DIR, 'node_modules/electron/dist');
const pathTxt = path.join(APP_DIR, 'node_modules/electron/path.txt');
const exeName = fs.existsSync(pathTxt)
  ? fs.readFileSync(pathTxt, 'utf8').trim()
  : (process.platform === 'win32' ? 'electron.exe' : 'electron');
const electronBin = path.join(distDir, exeName);

let app = null;
let page = null;

const COMMANDS = {
  async launch() {
    if (app) return console.log('already launched');
    if (!fs.existsSync(electronBin)) {
      return console.log('ERROR: electron binary missing at', electronBin, '— run `npm install` first');
    }
    // Strip ELECTRON_RUN_AS_NODE so the real Electron runtime starts (not plain node).
    const env = { ...process.env, CUE_NO_PROTECT: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath: electronBin,
      args: ['--no-sandbox', APP_DIR],
      cwd: APP_DIR,
      env,
      timeout: 45_000,
    });
    // Wait for the main window (renderer/index.html) — not a splash or the perm gate.
    for (let i = 0; i < 40 && !page; i++) {
      page = app.windows().find((w) => w.url().endsWith('index.html')) || null;
      if (!page) await new Promise((r) => setTimeout(r, 500));
    }
    if (!page) page = await app.firstWindow();
    try { await page.waitForSelector('#quit-btn', { timeout: 15_000 }); } catch {}
    await new Promise((r) => setTimeout(r, 1000)); // let icons paint
    console.log('launched.', app.windows().length, 'window(s):');
    for (const w of app.windows()) console.log(' ', w.url());
  },

  async ss(name) {
    if (!page) return console.log('ERROR: launch first');
    const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + '.png');
    await page.screenshot({ path: f });
    console.log('screenshot:', f);
  },

  // DOM click, not locator.click(): cue's transparent frameless window confuses
  // coordinate-based clicks. el.click() bypasses coordinates entirely.
  async click(sel) {
    if (!page) return console.log('ERROR: launch first');
    const r = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return 'NOT_FOUND';
      el.click(); return 'OK';
    }, sel);
    console.log('click', sel, '->', r);
  },

  async 'click-text'(text) {
    if (!page) return console.log('ERROR: launch first');
    const r = await page.evaluate((t) => {
      const els = [...document.querySelectorAll('button, a, [role="button"]')];
      const el = els.find((e) => e.textContent?.trim() === t) ?? els.find((e) => e.textContent?.includes(t));
      if (!el) return 'NOT_FOUND';
      el.click(); return 'OK: ' + el.tagName;
    }, text);
    console.log('click-text', JSON.stringify(text), '->', r);
  },

  async type(text) { if (page) await page.keyboard.type(text, { delay: 30 }); },
  async press(key) { if (page) await page.keyboard.press(key); },

  async wait(sel) {
    if (!page) return console.log('ERROR: launch first');
    try { await page.waitForSelector(sel, { timeout: 10_000 }); console.log('found:', sel); }
    catch { console.log('TIMEOUT:', sel); }
  },

  async eval(expr) {
    if (!page) return console.log('ERROR: launch first');
    try { console.log(JSON.stringify(await page.evaluate(expr))); }
    catch (e) { console.log('ERROR:', e.message); }
  },

  async text(sel) {
    if (!page) return console.log('ERROR: launch first');
    console.log(await page.evaluate((s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)', sel || null));
  },

  async windows() {
    if (!app) return console.log('ERROR: launch first');
    for (const w of app.windows()) console.log(' ', w.url());
  },

  async quit() { if (app) await app.close().catch(() => {}); app = null; page = null; },
  help() { console.log('commands:', Object.keys(COMMANDS).join(', ')); },
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'driver> ' });

// Serialize commands: readline fires 'line' for every buffered line at once, but
// commands are async (launch takes seconds). A queue keeps piped/batch input from
// racing ahead of a still-running command. Shutdown (explicit `quit`, or stdin EOF
// on piped input) waits for the queue to drain instead of exiting mid-command.
const queue = [];
let draining = false;
let stopAfterDrain = false;

async function shutdown() {
  await COMMANDS.quit();
  process.exitCode = 0;
  rl.close();
}

async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const line = queue.shift();
    const [cmd, ...rest] = line.trim().split(/\s+/);
    if (!cmd) continue;
    if (cmd === 'quit') { stopAfterDrain = true; break; }
    const fn = COMMANDS[cmd];
    if (!fn) { console.log('unknown:', cmd, '- try: help'); continue; }
    try { await fn(rest.join(' ')); } catch (e) { console.log('ERROR:', e.message); }
  }
  draining = false;
  if (stopAfterDrain) return void shutdown();
  rl.prompt();
}
rl.on('line', (line) => { queue.push(line); drain(); });
// EOF on piped input: finish whatever is queued, then shut down.
rl.on('SIGINT', () => { stopAfterDrain = true; });
process.stdin.on('end', () => { stopAfterDrain = true; drain(); });

console.log('cue driver — "help" for commands, "launch" to start');
rl.prompt();
