// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
// Private native host + real server/worker/assets/auth/CSP. No real microphone or model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, type ChildProcess} from 'node:child_process';
import {createServer, type ServerResponse} from 'node:http';
import {test as nodeTest} from 'node:test';
import {chromium, type Browser, type BrowserContext, type CDPSession, type Page} from 'playwright-core';
import {scratchHome, runServer, stopServer, removeScratch, REPO, type Mesh} from '../tests/mesh-server-lib.ts';
import {request, waitFor} from '../tests/ptyhost-wire-lib.ts';
import {chromiumLaunchOptions} from '../tests/helpers/browser-launch.ts';
import type {EditorObservation, EditorSnapshot, Submission} from './dictation-native-editor.ts';

declare const active: any, inlineDictation: any, dictationInventoryReady: boolean, meshContext: any;
declare const pendingClientVersion: string;
declare function refresh(): Promise<unknown>;
declare function setActive(pane: any): void;
declare const MeshI18n: {ready: Promise<void>};
const chrome = process.env.MESH_CHROMIUM || '';
const skip = !chrome && process.env.MESH_REQUIRE_BROWSER !== '1' ? 'MESH_CHROMIUM not set (controlled native editor)' : false;
const quote = (text: string): string => "'" + text.replaceAll("'", "'\\''") + "'";
export function nativeTest(name: string, run: () => Promise<void>): ReturnType<typeof nodeTest> {
  return nodeTest(name, {skip, timeout: 90000}, run);
}
type WireSocket = {id: string; url: string; isClosed(): boolean; closedAt: number | null;
  sent: (string | Buffer)[]; received: (string | Buffer)[]; resizes: {at: number; rows: number; cols: number}[]};
type EditorProbe = {name: string; created: number; snapshot(): EditorSnapshot; raw(): Buffer; submissions(): Submission[];
  observations(): EditorObservation[]};
export type NativeFixture = {
  name: string; created: number; page: Page; context: BrowserContext; mesh: Mesh; touch: boolean;
  preferenceKey: string; sockets: WireSocket[];
  uploads: {requestId: string; session: string; created: number}[];
  settlements: {outcome: string}[];
  snapshot(): EditorSnapshot; submissions(): Submission[]; raw(): Buffer; binary(): Buffer[];
  wireDiagnostics(): unknown;
  wait(what: string, done: () => boolean | Promise<boolean>): Promise<number>;
  mode(enabled: boolean): Promise<void>; replace(): Promise<number>;
  addEditor(name: string): Promise<EditorProbe>; select(name: string): Promise<void>;
  initialAttachState(): Promise<unknown>; settleInitialAttach(name: string): Promise<void>;
  resizeTrace(name: string): unknown;
  upstream: {pending: ServerResponse[]; calls: number};
};

export async function withNativeEditor(run: (f: NativeFixture) => Promise<void>, options: {touch?: boolean} = {}): Promise<void> {
  assert.ok(chrome, 'MESH_CHROMIUM must be set when MESH_REQUIRE_BROWSER=1');
  assert.ok(process.env.MESH_PTYHOST_CMD, 'MESH_PTYHOST_CMD must select this tree\'s fresh native build explicitly');
  const argv = [process.env.MESH_PTYHOST_CMD];
  assert.equal(argv.length, 1); assert.ok(path.isAbsolute(argv[0]!)); fs.accessSync(argv[0]!, fs.constants.X_OK);
  const upstream = {pending: [] as ServerResponse[], calls: 0};
  const upstreamErrors: unknown[] = [];
  const http = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/transcriptions');
      assert.match(req.headers['content-type'] || '', /^multipart\/form-data; boundary=/);
      let bytes = 0; for await (const part of req) bytes += part.length;
      assert.ok(bytes > 0, 'real worker uploads fake-device audio multipart');
      upstream.calls++; upstream.pending.push(res);
    } catch (error) {upstreamErrors.push(error); res.writeHead(500).end();}
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  let host: ChildProcess | undefined, browser: Browser | undefined;
  let drainRoutes: (() => Promise<void>) | undefined;
  let where: Awaited<ReturnType<typeof scratchHome>> | undefined;
  let server: Awaited<ReturnType<typeof runServer>> | undefined;
  let socket = '', hostErrors = '';
  const name = 'native-editor';
  try {
    where = await scratchHome('inline-native-', {
      SHELL: '/bin/sh', MESH_WHISPER_URL: `http://127.0.0.1:${(http.address() as {port: number}).port}/transcriptions`,
      MESH_NODE: process.execPath, MESH_PTYHOST_CMD: argv[0]!, PYTHONDONTWRITEBYTECODE: '1',
    });
    fs.chmodSync(where.scratch, 0o700);
    socket = path.join(where.env.XDG_RUNTIME_DIR!, 'session-mesh', 'ptyhost.sock');
    host = spawn(argv[0]!, [], {cwd: REPO, env: where.env, stdio: ['ignore', 'ignore', 'pipe']});
    host.stderr!.on('data', bytes => {hostErrors = (hostErrors + bytes).slice(-8192);});
    host.on('error', error => {hostErrors = error.message;});
    await waitFor('private native host', 7000, async () => {
      assert.equal(host!.exitCode, null, hostErrors);
      return request(socket, {op: 'list'}).then(() => true, () => false);
    });
    const oracle = path.join(where.home, 'oracle'); fs.mkdirSync(oracle, {mode: 0o700});
    const state = path.join(oracle, 'buffer.json');
    const snapshot = (): EditorSnapshot => JSON.parse(fs.readFileSync(state, 'utf8'));
    const controlled = new Map<string, number>();
    const createAt = async (target: string, directory: string): Promise<number> => {
      const file = path.join(directory, 'buffer.json');
      if (fs.existsSync(file)) fs.unlinkSync(file);
      assert.deepEqual(await request(socket, {op: 'new', name: target, cwd: where!.home,
        command: `exec ${quote(process.execPath)} --experimental-strip-types ${quote(path.join(REPO, 'checks/dictation-native-editor.ts'))} ${quote(directory)}`}), {ok: true, name: target});
      await waitFor('controlled raw-mode native editor', 7000, () => fs.existsSync(file));
      const rows = await request(socket, {op: 'list'}) as {name: string; created: number}[];
      const session = rows.find(row => row.name === target)!;
      assert.ok(session && Number.isFinite(session.created) && session.created > 0);
      controlled.set(target, session.created);
      return session.created;
    };
    const create = (): Promise<number> => createAt(name, oracle);
    const created = await create();
    server = await runServer(where); assert.equal(server.result.listened, true, server.output());
    const token = () => fs.readFileSync(path.join(where!.confDir, 'token'), 'utf8').trim();
    const base = `http://127.0.0.1:${where.port}`;
    const mesh: Mesh = {scratch: where.scratch, home: where.home, confDir: where.confDir, base, port: where.port,
      output: server.output, token, halt: async () => stopServer(server!.child), stop: async () => stopServer(server!.child)};
    assert.equal((await fetch(base + '/api/transcribe/config')).status, 401, 'real relay requires authentication');
    browser = await chromium.launch(chromiumLaunchOptions(chrome,
      ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], {headless: true}));
    const context = await browser.newContext({locale: 'en', viewport: options.touch ? {width: 390, height: 844} : {width: 1280, height: 900},
      hasTouch: options.touch === true, isMobile: options.touch === true, serviceWorkers: 'block'});
    const violations: string[] = [], errors: string[] = [];
    await context.exposeBinding('__nativeCspViolation', (_source, directive: string) => violations.push(directive));
    await context.addInitScript(() => {
      const root = window as any; root.micStreams = []; root.micCalls = 0;
      if (navigator.mediaDevices) {
        const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async constraints => {
          root.micCalls++; const stream = await gum(constraints); root.micStreams.push(stream); return stream;
        };
      }
      document.addEventListener('securitypolicyviolation', event => root.__nativeCspViolation(event.effectiveDirective));
    });
    const page = await context.newPage(); page.setDefaultTimeout(7000); page.setDefaultNavigationTimeout(7000);
    drainRoutes = () => page.isClosed() ? Promise.resolve() : page.unrouteAll({behavior: 'wait'});
    page.on('pageerror', error => errors.push(error.message));
    // ONLY fixture identity substitution. No names/created/state/attachment or relay bytes are synthesized.
    await page.route('**/api/sessions*', async route => {
      assert.equal(route.request().method(), 'GET');
      const response = await route.fetch(), body = await response.json();
      for (const row of body.mesh) if (controlled.get(row.name) === row.created) row.agent = {type: 'claude', foreground: true, status: 'idle'};
      await route.fulfill({response, json: body});
    });
    const sockets: WireSocket[] = [], allSockets: WireSocket[] = [];
    const byId = new Map<string, WireSocket>(), openIds = new Set<string>();
    const wireObserver = await context.newCDPSession(page);
    await wireObserver.send('Network.enable');
    const uploads: NativeFixture['uploads'] = [], settlements: NativeFixture['settlements'] = [];
    let established = false;
    wireObserver.on('Network.webSocketCreated', event => {
      const trace: WireSocket = {id: event.requestId, url: event.url, isClosed: () => trace.closedAt !== null,
        closedAt: null, sent: [], received: [], resizes: []};
      allSockets.push(trace); byId.set(event.requestId, trace);
      if (established) sockets.push(trace);
    });
    wireObserver.on('Network.webSocketHandshakeResponseReceived', event => {
      if (event.response.status === 101) openIds.add(event.requestId);
    });
    const observeFrame = (requestId: string, frame: {opcode: number; payloadData: string}, sent: boolean): void => {
      const trace = byId.get(requestId); assert.ok(trace, 'CDP frame has an observed connection identity');
      if (frame.opcode !== 1 && frame.opcode !== 2) return;
      const payload = frame.opcode === 2 ? Buffer.from(frame.payloadData, 'base64') : frame.payloadData;
      (sent ? trace.sent : trace.received).push(payload);
      if (sent && typeof payload === 'string') {
        const body = JSON.parse(payload);
        if (body.t === 'r') trace.resizes.push({at: Date.now(), rows: body.rows, cols: body.cols});
      }
    };
    wireObserver.on('Network.webSocketFrameSent', event => observeFrame(event.requestId, event.response, true));
    wireObserver.on('Network.webSocketFrameReceived', event => observeFrame(event.requestId, event.response, false));
    wireObserver.on('Network.webSocketClosed', event => {
      openIds.delete(event.requestId);
      const trace = byId.get(event.requestId); if (trace) trace.closedAt = performance.now();
    });
    page.on('request', req => {
      const url = new URL(req.url());
      if (url.pathname === '/api/transcribe' && req.method() === 'POST') {
        const headers = req.headers(); uploads.push({requestId: headers['x-mesh-request-id']!,
          session: headers['x-mesh-session']!, created: Number(headers['x-mesh-created'])});
      }
      if (url.pathname.endsWith('/settle')) settlements.push(req.postDataJSON());
    });
    await page.goto(base + '/login'); await page.locator('input[name="token"]').fill(token());
    await Promise.all([page.waitForURL(base + '/'), page.getByRole('button').click()]);
    const preferenceKey = await page.evaluate(() => `${meshContext.storagePrefix}.dictation-auto-send`);
    await page.evaluate(key => localStorage.setItem(key, 'true'), preferenceKey);
    await page.goto(`${base}/#${name}`); await page.reload();
    await page.evaluate(() => MeshI18n.ready);
    await page.waitForFunction(name => active?.id === name && active.conn?.terminal?.isOpen() && dictationInventoryReady
      && !active.conn.replayPending && !active.conn.replaying && !active.conn.draining, name);
    const policy = (await context.request.get(base)).headers()['content-security-policy'] || '';
    assert.equal(policy.split(';').find(s => s.trim().startsWith('script-src'))?.trim(), "script-src 'self'");
    // Fail immediately on the in-progress UI seam rather than waiting through repeated capture timeouts.
    assert.equal(await page.locator('.pane.active [data-act="dictate"]').count(), 1,
      'BLOCKED PRODUCER: actual main-pane dictate button is not wired');
    assert.equal(await page.evaluate(() => typeof inlineDictation !== 'undefined' && !!inlineDictation), true,
      'BLOCKED PRODUCER: actual inlineDictation controller is not wired');
    await page.waitForFunction(({name, created}) => active.conn.terminal.isBound(name, created), {name, created});
    const f: NativeFixture = {
      name, created, page, context, mesh, touch: options.touch === true, preferenceKey, sockets, uploads, settlements, upstream,
      snapshot, submissions: () => fs.readFileSync(path.join(oracle, 'submissions.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)),
      raw: () => fs.readFileSync(path.join(oracle, 'input.bin')),
      binary: () => sockets.filter(ws => new URL(ws.url).pathname === '/ws/' + name).flatMap(ws => ws.sent.filter(Buffer.isBuffer)),
      wireDiagnostics: () => allSockets.map(ws => ({id: ws.id, path: new URL(ws.url).pathname,
        created: new URL(ws.url).searchParams.get('created'), measured: sockets.includes(ws), closed: ws.isClosed(),
        closeObserved: ws.closedAt !== null, sentTypes: ws.sent.map(value => Buffer.isBuffer(value) ? 'binary:' + value.length : 'text'),
        receivedTypes: ws.received.map(value => Buffer.isBuffer(value) ? 'binary:' + value.length : 'text')})),
      resizeTrace: target => sockets.filter(ws => new URL(ws.url).pathname === '/ws/' + target)
        .map(ws => ({socket: ws.id, resizes: ws.resizes})),
      wait: (what, done) => waitFor(what, 7000, done),
      mode: async enabled => {
        if (snapshot().mode !== enabled) process.kill(snapshot().pid, 'SIGUSR1');
        await waitFor('native paste-mode signal', 5000, () => snapshot().mode === enabled);
      },
      replace: async () => {
        assert.deepEqual(await request(socket, {op: 'kill', name}), {ok: true});
        await waitFor('old private incarnation reaped', 7000, async () => !(await request(socket, {op: 'list'}) as {name: string}[]).some(s => s.name === name));
        return create();
      },
      addEditor: async target => {
        assert.match(target, /^[a-zA-Z0-9_-]+$/); assert.equal(controlled.has(target), false);
        const directory = path.join(oracle, target); fs.mkdirSync(directory, {mode: 0o700});
        const incarnation = await createAt(target, directory);
        await page.evaluate(() => refresh());
        return {name: target, created: incarnation,
          snapshot: () => JSON.parse(fs.readFileSync(path.join(directory, 'buffer.json'), 'utf8')),
          raw: () => fs.readFileSync(path.join(directory, 'input.bin')),
          observations: () => fs.readFileSync(path.join(directory, 'observations.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)),
          submissions: () => fs.readFileSync(path.join(directory, 'submissions.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))};
      },
      select: async target => {
        const incarnation = controlled.get(target); assert.ok(incarnation);
        await page.evaluate(target => {active.show(target); setActive(active);}, target);
        await page.waitForFunction(({target, incarnation}) => active?.id === target && active.conn?.terminal?.isBound(target, incarnation)
          && active.conn.terminal.dictationMode.valid && active.conn.terminal.dictationMode.value
          && !active.conn.replayPending && !active.conn.replaying && !active.conn.draining, {target, incarnation});
      },
      initialAttachState: () => page.evaluate(() => {
        const c = active?.conn, bar = document.getElementById('update-bar');
        return {at: Date.now(), name: active?.id, rows: active?.term?.rows, cols: active?.term?.cols,
          autoRedraw: c?.autoRedraw ? {deadline: c.autoRedraw.deadline, timerActive: !!c.autoRedraw.timer} : null,
          initialFollow: c?.initialFollow ? {deadline: c.initialFollow.deadline, notBefore: c.initialFollow.notBefore,
            timerActive: !!c.initialFollow.timer} : null,
          replayPending: !!c?.replayPending, replaying: !!c?.replaying, draining: !!c?.draining,
          pendingClientVersion: typeof pendingClientVersion === 'string' ? pendingClientVersion : null,
          updateBarHidden: bar?.hidden ?? null};
      }),
      settleInitialAttach: async target => {
        const incarnation = controlled.get(target); assert.ok(incarnation);
        // Initial attachment deliberately redraws rows-1 then restores them.
        // A late-result baseline must follow BOTH this redraw and initial follow,
        // not merely a moment when the native dimensions happen to match.
        await page.waitForFunction(({target, incarnation}) => active?.id === target
          && active.conn?.terminal?.isBound(target, incarnation) && active.conn.autoRedraw == null
          && active.conn.initialFollow == null && !active.conn.replayPending && !active.conn.replaying
          && !active.conn.draining, {target, incarnation});
      },
    };
    await waitMode(f, true);
    // URL equality alone cannot distinguish login/reload connections. Wait for
    // one actually live observer with the expected native bound/replay evidence.
    const currentUrl = await page.evaluate(() => active.conn.ws.url);
    const candidates = (): WireSocket[] => [...openIds].map(id => byId.get(id)!).filter(s => s.url === currentUrl
      && s.received.some(value => typeof value === 'string' && JSON.parse(value).t === 'bound'
        && JSON.parse(value).name === name && JSON.parse(value).created === created));
    await f.wait('one live original WebSocket observer with native bound and replay', () => {
      const live = candidates();
       return live.length === 1 && live[0]!.received.some(value => Buffer.isBuffer(value));
    });
    const [current] = candidates(); assert.ok(current);
    sockets.push(current); established = true;
    await run(f);
    assert.deepEqual(errors, [], 'actual application page errors');
    assert.deepEqual(violations, [], 'actual main-page strict CSP violations');
    assert.deepEqual(upstreamErrors, [], 'fake HTTP inference errors');
  } finally {
    const cleanupErrors: unknown[] = [];
    const clean = async (task: () => Promise<unknown>): Promise<void> => {try {await task();} catch (error) {cleanupErrors.push(error);}};
    // Run all cleanups even if another cleanup fails. Every PID/path belongs to this fixture.
    // route.fetch must finish before browser closure disposes its request context.
    await clean(async () => drainRoutes?.());
    await clean(async () => browser?.close());
    for (const response of upstream.pending) response.destroy();
    await clean(async () => {if (server) await stopServer(server.child);});
    await clean(async () => {
      if (!host || host.exitCode !== null || host.signalCode !== null) return;
      try {
        const sessions = await request(socket, {op: 'list'}) as {name: string}[];
        for (const session of sessions) await request(socket, {op: 'kill', name: session.name});
        await waitFor('private editor reaped', 7000, async () => (await request(socket, {op: 'list'}) as unknown[]).length === 0);
      } finally {
        host.kill('SIGTERM');
        try {await waitFor('private native host exit', 4000, () => host!.exitCode !== null || host!.signalCode !== null);}
        catch {host.kill('SIGKILL'); await waitFor('private native host kill', 2000, () => host!.exitCode !== null || host!.signalCode !== null);}
      }
    });
    await clean(async () => {http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));});
    if (where) await clean(async () => removeScratch(where!.scratch));
    assert.deepEqual(cleanupErrors, [], 'all private native fixture resources cleaned up');
  }
}

export async function waitMode(f: NativeFixture, value: boolean): Promise<void> {
  await f.page.waitForFunction(({value}) => active?.conn?.terminal?.dictationMode?.valid === true
    && active.conn.terminal.dictationMode.value === value && !active.conn.replayPending && !active.conn.replaying && !active.conn.draining, {value});
}
export async function waitRetired(f: NativeFixture): Promise<void> {
  await f.page.waitForFunction(({name, created}) => {
    const s = inlineDictation.peekSession?.(name, created) ?? inlineDictation.session(name, created);
    return s.state === 'idle' && !s.outstanding;
  }, {name: f.name, created: f.created});
}
export async function record(f: NativeFixture, text: string, options: {gesture?: 'Space' | 'Enter' | 'pointer'; beforeResult?: () => Promise<void>} = {}): Promise<void> {
  const count = f.upstream.calls;
  const mic = f.page.locator('.pane.active [data-act="dictate"]');
  await f.page.waitForFunction(({name, created}) => {
    const s = inlineDictation.peekSession?.(name, created) ?? inlineDictation.session(name, created);
    return !inlineDictation.reason(s);
  }, {name: f.name, created: f.created});
  const gesture = options.gesture || 'Space';
  let touchInput: CDPSession | undefined;
  if (gesture === 'pointer') {
    await mic.scrollIntoViewIfNeeded();
    const box = await mic.boundingBox(); assert.ok(box);
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    if (f.touch) {
      touchInput = await f.context.newCDPSession(f.page);
      await touchInput.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y, id: 1}]});
    } else {await f.page.mouse.move(x, y); await f.page.mouse.down();}
  } else {await mic.focus(); await f.page.keyboard.down(gesture);}
  await f.page.waitForFunction(({name, created}) => inlineDictation.session(name, created).state === 'recording', {name: f.name, created: f.created});
  const status = f.page.locator('.pane.active .p-inline-dictation-status');
  assert.ok((await status.textContent())?.trim(), 'visible recording status');
  // Existing fake-media capture stability allowance, never an attachment/mode/readiness sleep.
  await f.page.waitForTimeout(350);
  if (touchInput) {await touchInput.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []}); await touchInput.detach();}
  else if (gesture === 'pointer') await f.page.mouse.up();
  else await f.page.keyboard.up(gesture);
  await f.wait('real worker reaches fake HTTP upstream', () => f.upstream.calls === count + 1);
  assert.equal(await f.page.evaluate(() => (window as any).micStreams.length > 0 && (window as any).micStreams.every((s: MediaStream) =>
    s.getTracks().every(t => t.readyState === 'ended'))), true, 'release stopped every owned fake-media track');
  assert.equal(f.uploads.length, count + 1);
  assert.deepEqual({session: f.uploads[count]!.session, created: f.uploads[count]!.created}, {session: f.name, created: f.created});
  assert.ok(f.uploads[count]!.requestId);
  await options.beforeResult?.();
  const response = f.upstream.pending.shift(); assert.ok(response);
  response.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({text}));
}
export async function expectBuffer(f: NativeFixture, text: string): Promise<void> {
  await f.wait('exact private native editable buffer: ' + JSON.stringify(text), () => f.snapshot().text === text && !f.snapshot().paste);
  assert.equal(f.snapshot().text, text);
}
export function expectNoSubmission(f: NativeFixture): void {assert.deepEqual(f.submissions(), [], 'separate submission JSONL remains empty');}
export async function expectPaste(f: NativeFixture, text: string): Promise<void> {
  // Pinned xterm's paste encoder converts logical LF to CR inside the bracketed payload.
  const expected = Buffer.from('\x1b[200~' + text.replace(/\n/g, '\r') + '\x1b[201~');
  assert.deepEqual(f.raw(), expected, 'native raw input independently agrees with browser wire bytes');
  const before = Buffer.concat(f.binary()).length;
  if (before < expected.length) {
    console.log('Native wire observer pending after exact native bytes:', JSON.stringify(f.wireDiagnostics()));
    try {await f.wait('actual original WebSocket binary-frame observation', () => Buffer.concat(f.binary()).length >= expected.length);}
    catch (error) {throw new Error('Native wire observer did not catch up: ' + JSON.stringify(f.wireDiagnostics()), {cause: error});}
    console.log('Native wire observer caught up:', JSON.stringify(f.wireDiagnostics()));
  }
  assert.deepEqual(Buffer.concat(f.binary()), expected, 'actual browser binary frames contain exactly one framed paste and no automatic submit');
  assert.equal(f.snapshot().cursor, Array.from(text).length);
}
export function expectDirtyWithoutClean(f: NativeFixture): void {
  const controls = f.sockets.flatMap(s => s.sent).filter(v => typeof v === 'string').map(v => JSON.parse(v));
  const h = controls.filter(c => c.t === 'h');
  assert.ok(h.some(c => c.dirty === true), 'own H becomes dirty');
  const first = h.findIndex(c => c.dirty === true);
  assert.equal(h.slice(first).some(c => c.dirty === false), false, 'job retirement/native deletion never invents clean H');
}
async function focusEditor(f: NativeFixture): Promise<void> {
  if (f.touch) await f.page.locator('#line-text').focus();
  else await f.page.locator('.pane.active .xterm-helper-textarea').evaluate(e => (e as HTMLElement).focus());
}
export async function manualKey(f: NativeFixture, key: string): Promise<void> {
  await focusEditor(f);
  const bar: Record<string, string> = {ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down'};
  if (f.touch && bar[key]) await f.page.locator(`#keys [data-k="${bar[key]}"]`).tap();
  else if (f.touch && key === 'Delete') {
    // The existing mobile key bar has no forward Delete; native DEL is Backspace.
    await f.page.locator('#keys [data-k="right"]').tap();
    await focusEditor(f); await f.page.keyboard.press('Backspace');
  } else await f.page.keyboard.press(key);
}
export async function typeNative(f: NativeFixture, text: string): Promise<void> {
  await focusEditor(f); await f.page.keyboard.type(text);
  if (f.touch) assert.equal(await f.page.locator('#line-text').inputValue(), '', 'Direct adapter keeps no second draft');
}
