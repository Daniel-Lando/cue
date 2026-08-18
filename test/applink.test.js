const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { describeState, consentCopy } = require('../src/applink-state');
const { AppLinkServer, AppLinkClient } = require('../vendor/app-link');

const SETTINGS = {
  provider: 'openai',
  smart: true,
  resumeContext: 'Mann Bellani — Texas A&M, worked at …',
  apiKeys: { openai: 'sk-proj-realkeyvaluehere', anthropic: '', gemini: 'AIzaSyRealKey', nvidia: '' },
  models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } },
};

const TRANSCRIPT = [
  { channel: 'them', text: 'So what salary were you expecting?', ts: 1754300000000 },
  { channel: 'you', text: 'I was hoping for something around…', ts: 1754300005000 },
];

/**
 * A per-run appId, so a test's socket can never collide with a real cue.
 *
 * The socket path is derived from the appId: on Windows it is the named pipe
 * \\.\pipe\publik-<appId>-user, which is machine-global — pathOptions redirects
 * the instance file and the consent store, but not the pipe. Hardcoding the
 * shipping id therefore made these tests fail with EADDRINUSE whenever cue was
 * running, and the counter is a second guard for two servers in one process.
 */
let appIdCounter = 0;
function uniqueAppId() {
  appIdCounter += 1;
  return `com.cue.overlay.test-${process.pid}-${Date.now()}-${appIdCounter}`;
}

function snapshot(overrides = {}) {
  return {
    state: { capturing: true, busy: false, transcribing: { you: false, them: true } },
    transcript: TRANSCRIPT,
    settings: SETTINGS,
    sttDisabled: false,
    shortcuts: { assist: 'CommandOrControl+Return', leetcode: true, quit: true },
    windowAlive: true,
    ...overrides,
  };
}

test('reports what cue is doing', () => {
  const state = describeState(snapshot());
  assert.equal(state.capturing, true);
  assert.equal(state.transcribing.them, true);
  assert.equal(state.transcriptTurns, 2);
  assert.equal(state.lastTurnAt, new Date(1754300005000).toISOString());
  assert.equal(state.provider, 'openai');
  assert.deepEqual(state.models, { fast: 'gpt-4o-mini', smart: 'gpt-4o' });
  assert.deepEqual(state.shortcuts, { assist: 'CommandOrControl+Return', leetcode: true, quit: true });
});

/**
 * The one test in this file that matters more than the others. cue's transcript
 * is a recording of people who never agreed to share it, and the résumé and the
 * keys are the user's. If any of them ever appear in this object they are one
 * `capture_diagnostics` away from a bug report.
 */
test('never exposes transcript text, résumé or API keys', () => {
  const serialized = JSON.stringify(describeState(snapshot()));
  assert.ok(!serialized.includes('salary'), 'transcript text leaked');
  assert.ok(!serialized.includes('hoping for something'), 'transcript text leaked');
  assert.ok(!serialized.includes('Texas A&M'), 'résumé leaked');
  assert.ok(!serialized.includes('sk-proj-'), 'OpenAI key leaked');
  assert.ok(!serialized.includes('AIzaSy'), 'Gemini key leaked');
});

test('reports which keys are set without reporting them', () => {
  const state = describeState(snapshot());
  assert.deepEqual(state.hasKey, { openai: true, anthropic: false, gemini: true, nvidia: false });
  assert.equal(state.hasResumeContext, true);
});

test('surfaces transcription being silently dead', () => {
  assert.equal(describeState(snapshot({ sttDisabled: true })).transcriptionDisabled, true);
});

test('handles an empty session without inventing a timestamp', () => {
  const state = describeState(snapshot({ transcript: [] }));
  assert.equal(state.transcriptTurns, 0);
  assert.equal(state.lastTurnAt, null);
});

test('hedges the consent sheet when the caller cannot be verified', () => {
  const unverified = consentCopy({ callerName: 'Iris', scope: 'read', verification: 'token' });
  assert.match(unverified.message, /identifying itself as/);
  assert.match(unverified.detail, /cannot verify/);
  assert.equal(unverified.trusted, false);

  const verified = consentCopy({ callerName: 'Iris', scope: 'read', verification: 'code-signature' });
  assert.equal(verified.message, 'Iris wants to see what cue is doing.');
  assert.match(verified.detail, /signature has been verified/);
});

test('asks separately, and differently, for control', () => {
  const copy = consentCopy({ callerName: 'Iris', scope: 'action', verification: 'token' });
  assert.match(copy.message, /wants to control cue/);
  assert.equal(copy.allowLabel, 'Allow control');
});

/**
 * End to end over a real socket, without Electron: discovery, consent, and the
 * three questions Iris actually asks when someone says cue is broken.
 */
test('answers Iris over the link', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-applink-'));
  const pathOptions = { homedir: home, env: { ...process.env, LOCALAPPDATA: path.join(home, 'Local') } };
  // Unique per run: on Windows the socket is a named pipe whose name comes from
  // the appId alone, so pathOptions does not isolate it. With the real id this
  // test fails with EADDRINUSE whenever a cue instance — or a leftover process
  // from one — happens to be running, which read as random flakiness.
  const appId = uniqueAppId();

  let asked = 0;
  const link = new AppLinkServer({
    appId,
    appSlug: 'cue',
    appName: 'cue',
    appVersion: '0.2.1',
    pathOptions,
    stateProvider: () => describeState(snapshot({ sttDisabled: true })),
    onConsentRequest: () => { asked += 1; return true; },
  });
  await link.start();
  t.after(() => link.stop());

  link.record({ level: 'error', event: 'stt_rejected', code: 'http_403', msg: 'no access to a speech model', frame: 'handleSttError' });

  const found = AppLinkClient.discover(pathOptions).find((entry) => entry.appId === appId);
  assert.ok(found, 'cue did not announce itself');

  const client = await AppLinkClient.open(found, { client: { id: 'com.publikhq.iris', name: 'Iris' }, scopes: ['read'] });
  t.after(() => client.close());

  assert.equal(asked, 1);

  const { state } = await client.getState();
  assert.equal(state.transcriptionDisabled, true);
  assert.equal(state.capturing, true);

  const { event } = await client.getLastError();
  assert.equal(event.code, 'http_403');
  assert.equal(event.frame, 'handleSttError');

  const bundle = await client.captureDiagnostics();
  assert.equal(bundle.app.slug, 'cue');
  assert.equal(bundle.lastError.msg, 'no access to a speech model');
  // Same guarantee as above, now through the wire rather than the function.
  const wire = JSON.stringify(bundle);
  assert.ok(!wire.includes('salary') && !wire.includes('sk-proj-'), 'diagnostics bundle leaked private data');
});

/**
 * A second server on the same socket must fail in a way the caller can catch,
 * not by throwing an uncaught 'error' event. Before this was guarded, a second
 * cue instance crashed the whole app with an "Uncaught Exception: EADDRINUSE"
 * dialog — the socket's error re-emitted with no listener, which Node turns
 * into a throw. src/applink.js relies on start() rejecting so a link that will
 * not start never stops cue from starting.
 */
test('a second server on a busy socket rejects instead of throwing uncaught', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-applink-busy-'));
  const pathOptions = { homedir: home, env: { ...process.env, LOCALAPPDATA: path.join(home, 'Local') } };
  // Both servers share one id so they collide with each other — the collision
  // under test — while staying isolated from any cue running on the machine.
  const appId = uniqueAppId();
  const make = () => new AppLinkServer({ appId, appSlug: 'cue', appName: 'cue', appVersion: '0.2.1', pathOptions });

  const first = make();
  await first.start();
  t.after(() => first.stop());

  const second = make();
  t.after(() => second.stop().catch(() => {}));

  let uncaught = null;
  const onUncaught = (error) => { uncaught = error; };
  process.once('uncaughtException', onUncaught);
  t.after(() => process.removeListener('uncaughtException', onUncaught));

  await assert.rejects(() => second.start(), (error) => error.code === 'EADDRINUSE');
  // Let any stray asynchronous throw surface before we assert none did.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(uncaught, null, 'a busy socket produced an uncaught exception');
});
