// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Test-owned HTTP/media/WebSocket fixture; production assets are read unchanged.
// This proves browser behavior with fake devices/APIs, not phone or relay capture.
import assert from 'node:assert/strict';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {readFile, realpath} from 'node:fs/promises';
import {isAbsolute, relative, resolve} from 'node:path';
import {test as nodeTest} from 'node:test';
import {chromium, type Browser, type Page, type WebSocketRoute} from 'playwright-core';
import {chromiumLaunchOptions} from '../tests/helpers/browser-launch.ts';

// Application script-scope bindings, resolved in the page (not Node).
declare const active: any, dictation: any, dictationInventoryReady: boolean;
declare function composeDictationSession(): any;
declare function setActive(pane: any): void;

const root = resolve(import.meta.dirname, '..');
const staticRoot = resolve(root, 'static');
const executablePath = process.env.MESH_CHROMIUM || '';
const skip = !executablePath && process.env.MESH_REQUIRE_BROWSER !== '1'
  ? 'MESH_CHROMIUM not set (fake-device actual-app browser regression)' : false;
export function test(name: string, run: () => Promise<void>): ReturnType<typeof nodeTest> {
  return nodeTest(name, {skip, timeout: 30000}, run);
}

const config = {enabled: true, language: 'fr', max_bytes: 8388608, aggregate_bytes: 67108864,
  queue_size: 16, workers: 1, active_timeout_seconds: 60, queue_wait_seconds: 600,
  result_ttl_seconds: 1800, capture_seconds: 120};
type Job = {job_id: string; request_id: string; session: string; created: number;
  state: string; text: string | null; error: null; outcome: string | null};
export type Writes = Map<string, (string | Buffer)[]>;
export type Sockets = Map<string, WebSocketRoute[]>;
export type ReplayGeometry = {rows: number; cols: number};
export function sendReplay(socket: Pick<WebSocketRoute, 'send'>, geometry: ReplayGeometry | null = null,
  replay = Buffer.alloc(0)): void {
  // server.py sends optional {t:"g"} before the host's first D frame. Even an
  // empty native replay is a binary frame, not an absent replay acknowledgement.
  if (geometry) socket.send(JSON.stringify({t: 'g', ...geometry}));
  socket.send(replay);
}
function json(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}).end(JSON.stringify(value));
}
async function indexPolicy(): Promise<string> {
  // Read the real public policy as data, without importing/running the backend.
  const server = await readFile(resolve(root, 'server.py'), 'utf8');
  const declaration = server.match(/^INDEX_CSP = \(([\s\S]*?)\)/m);
  assert.ok(declaration, 'public INDEX_CSP declaration must be present');
  return [...declaration[1]!.matchAll(/"(?:[^"\\]|\\.)*"/g)].map(match => JSON.parse(match[0])).join('');
}
async function serveStatic(path: string, res: ServerResponse, skipEntry: boolean): Promise<void> {
  try {
    const decoded = decodeURIComponent(path);
    const name = decoded === '/' ? 'index.html' : decoded === '/sw.js' ? 'sw.js'
      : decoded.startsWith('/static/') ? decoded.slice('/static/'.length) : null;
    if (!name || name.includes('\\') || name.includes('\0')) {res.writeHead(404).end(); return;}
    const file = await realpath(resolve(staticRoot, name));
    const within = relative(staticRoot, file);
    if (isAbsolute(within) || within === '..' || within.startsWith('../')) {res.writeHead(404).end(); return;}
    let data = await readFile(file);
    if (skipEntry && name === 'index.html') {
      const entry = '<script src="/static/local-entry.js"></script>';
      assert.equal(data.toString().split(entry).length, 2, 'omit exactly the actual external local entry');
      data = Buffer.from(data.toString().replace(entry, ''));
    }
    if (name === 'index.html') res.setHeader('Content-Security-Policy', await indexPolicy());
    res.setHeader('Content-Type', name.endsWith('.js') ? 'application/javascript'
      : name.endsWith('.css') ? 'text/css' : name.endsWith('.json') ? 'application/json' : 'text/html');
    res.setHeader('Cache-Control', 'no-store');
    res.end(data);
  } catch {res.writeHead(404).end();}
}
class FakeDictationApi {
  readonly jobs: Job[] = []; readonly seen: string[] = [];
  readonly uploads: {headers: IncomingMessage['headers']; bytes: number}[] = [];
  readonly inventory = {mesh: ['A', 'B', 'C'].map((name, i) => ({id: name, name, created: i + 1,
    kind: 'mesh', cwd: '/tmp', cmd: 'bash', host: 'local', tty: '', updated: 1,
    agent: {type: 'claude', foreground: true, status: 'idle'}})),
    external: [], home: '/tmp', management: {state: 'observed', sessions: []}};
  private readonly owners = new Map<string, string>();
  private readonly acknowledgements = new Map<string, () => void>();
  private readonly skipEntry: boolean;
  private lost = false; private enabled = true;
  private pauseRead = false; private resumeRead: (() => void) | null = null;
  missing = false; loseSettle = false;
  constructor(skipEntry: boolean) {this.skipEntry = skipEntry;}
  ack(name: string): void {this.acknowledgements.get(name)?.();}
  lose(): void {this.lost = true;}
  disable(): void {this.enabled = false;}
  holdRead(): void {this.pauseRead = true;}
  get readHeld(): boolean {return this.resumeRead !== null;}
  releaseRead(): void {this.resumeRead?.(); this.resumeRead = null;}
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url!, 'http://localhost').pathname;
    if (path.startsWith('/api/')) this.seen.push(path);
    if (path === '/api/sessions') return json(res, this.inventory);
    if (path === '/api/transcribe/config') return json(res, this.enabled ? config : {enabled: false});
    if (path === '/api/transcribe') return this.admit(req, res);
    if (path.startsWith('/api/transcribe/')) return this.job(req, res);
    if (path.startsWith('/api/')) return json(res, {available: false, items: [], sessions: []});
    return serveStatic(path, res, this.skipEntry);
  }
  private async admit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let bytes = 0; for await (const chunk of req) bytes += chunk.length;
    this.uploads.push({headers: req.headers, bytes});
    const j: Job = {job_id: crypto.randomUUID(), request_id: String(req.headers['x-mesh-request-id']),
      session: String(req.headers['x-mesh-session']), created: Number(req.headers['x-mesh-created']),
      state: 'queued', text: null, error: null, outcome: null}; this.jobs.push(j);
    this.owners.set(j.job_id, String(req.headers['x-mesh-dictation-client']));
    if (this.lost) {this.lost = false; json(res, {error: {code: 'unavailable', message: 'Acknowledgement lost'}}, 503); return;}
    this.acknowledgements.set(j.session, () => json(res, j, 202));
  }
  private async job(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const bits = new URL(req.url!, 'http://localhost').pathname.split('/'), id = bits[3];
    const j = this.jobs.find(j => id === 'request' ? j.request_id === bits[4] : j.job_id === id);
    if (!j || this.missing || this.owners.get(j.job_id) !== String(req.headers['x-mesh-dictation-client']))
      return json(res, {error: {code: 'not_found', message: 'Not found'}}, 404);
    if (bits[4] === 'cancel' && !['cancelled', 'settled'].includes(j.state)) {j.state = 'cancelled'; j.text = null;}
    if (bits[4] === 'settle') {
      let body = ''; for await (const chunk of req) body += chunk;
      let value;
      try {value = JSON.parse(body);} catch {return json(res, {error: {code: 'invalid_request'}}, 400);}
      if (!value || Array.isArray(value) || Object.keys(value).length !== 1
          || !['inserted', 'submitted', 'discarded'].includes(value.outcome))
        return json(res, {error: {code: 'invalid_request'}}, 400);
      if (j.state === 'settled' ? j.outcome !== value.outcome
        : ['inserted', 'submitted'].includes(value.outcome) && j.state !== 'ready')
        return json(res, {error: {code: 'invalid_state'}}, 400);
      j.state = 'settled'; j.outcome = value.outcome; j.text = null;
      if (this.loseSettle) return json(res, {error: {code: 'unavailable', message: 'Acknowledgement lost'}}, 503);
    }
    if (this.pauseRead && req.method === 'GET' && id !== 'request') {
      this.pauseRead = false; this.resumeRead = () => json(res, j); return;
    }
    json(res, j);
  }
}
export function apiFixture(skipEntry = false): FakeDictationApi {return new FakeDictationApi(skipEntry);}
export async function withFixtureServer(run: (base: string, api: FakeDictationApi) => Promise<void>, pending = false): Promise<void> {
  const api = apiFixture(pending), failures: unknown[] = [];
  const server = createServer((req, res) => {
    res.setTimeout(20000, () => res.destroy());
    void api.handle(req, res).catch(error => {failures.push(error); res.destroy();});
  });
  server.requestTimeout = 20000;
  await new Promise<void>((done, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', done);});
  try {
    await run(`http://127.0.0.1:${(server.address() as {port: number}).port}`, api);
    assert.deepEqual(failures, [], 'owned HTTP fixture errors');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  }
}
async function setupMedia(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    (window as any).micStreams = []; (window as any).micCalls = 0;
    navigator.mediaDevices.getUserMedia = async constraints => {
      (window as any).micCalls++; const stream = await gum(constraints);
      (window as any).micStreams.push(stream); return stream;
    };
  });
}
export type BrowserContextOptions = {hasTouch?: boolean; isMobile?: boolean; viewport?: {width: number; height: number}};
export async function harness(run: (page: Page, api: FakeDictationApi, sockets: Sockets, writes: Writes) => Promise<void>, pending = false, locale = 'fr', geometry: ReplayGeometry | null = {rows: 24, cols: 80}, browserContext: BrowserContextOptions = {}): Promise<void> {
  assert.ok(executablePath, 'MESH_CHROMIUM must name an executable when browser tests are required');
  await withFixtureServer(async (base, api) => {
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch(chromiumLaunchOptions(executablePath,
        ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], {headless: true}));
      const page = await browser.newPage({locale, ...browserContext}), sockets: Sockets = new Map(), writes: Writes = new Map();
      page.setDefaultTimeout(7000); page.setDefaultNavigationTimeout(7000);
      const errors: string[] = []; page.on('pageerror', e => errors.push(e.stack || e.message));
      const violations: string[] = [];
      await page.exposeFunction('__dictationCspViolation', (directive: string) => violations.push(directive));
      await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => {
        (window as any).__dictationCspViolation(event.effectiveDirective);
      }));
      await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      await page.routeWebSocket('**/ws/*', ws => {
        const url = new URL(ws.url()), name = url.pathname.split('/').pop()!;
        const key = `${name}:${sockets.get(name)?.length || 0}`;
        sockets.set(name, [...sockets.get(name) || [], ws]); writes.set(key, []);
        ws.onMessage(data => writes.get(key)!.push(data));
        const expected = url.searchParams.getAll('created');
        if (expected.length) {
          const session = api.inventory.mesh.find(session => session.name === name);
          const created = Number(expected[0]);
          if (expected.length !== 1 || !session || !Number.isFinite(created) || created <= 0 || session.created !== created) {
            ws.close({code: 1008, reason: 'Fixture incarnation refused'}); return;
          }
          ws.send(JSON.stringify({t: 'bound', name, created}));
        }
        sendReplay(ws, url.searchParams.get('replay_geometry') === '1' ? geometry : null);
      });
      await setupMedia(page);
      await page.goto(`${base}/#A`);
      await page.evaluate(() => (MeshI18n.ready));
      if (!pending) await page.waitForFunction(() => active?.conn?.terminal?.isOpen() && dictationInventoryReady
        && !active.conn.replayPending && !active.conn.replaying && !active.conn.draining);
      await run(page, api, sockets, writes);
      assert.deepEqual(errors, [], 'actual application emitted a page error');
      assert.deepEqual(violations, [], 'actual application violated the public CSP');
    } finally {await browser?.close();}
  }, pending);
}
export async function select(page: Page, name: string, parsed = true): Promise<void> {
  await page.evaluate(name => {active.show(name); setActive(active);}, name);
  await page.waitForFunction(({name, parsed}) => active?.id === name && active.conn?.terminal?.isOpen()
    && !active.conn.replayPending && (!parsed || !active.conn.replaying && !active.conn.draining), {name, parsed});
}
// Read-only observation of real socket delivery; Mesh has no terminal.observe API.
export async function observeOutput(page: Page, counter: string, stop: string): Promise<void> {
  await page.evaluate(({counter, stop}) => {
    const root = window as any, socket = active.conn.ws;
    root[counter] = 0;
    const listener = () => {root[counter]++;};
    socket.addEventListener('message', listener);
    root[stop] = () => socket.removeEventListener('message', listener);
  }, {counter, stop});
}
export async function open(page: Page): Promise<void> {
  await page.locator('.pane.active [data-act="more"]').click();
  await page.locator('.pane.active [data-menu-action="compose"]').click();
}
export async function closeCompose(page: Page): Promise<void> {await page.locator('#dlg-compose [data-close-dialog]').click();}
export function dataFrames(writes: Writes): (string | Buffer)[] {
  return [...writes.values()].flat().filter(value => typeof value !== 'string');
}
export function wire(writes: Writes, key: string): string[] {
  return (writes.get(key) || []).filter(v => typeof v !== 'string').map(v => v.toString());
}
export async function typeNative(page: Page, text: string): Promise<void> {
  await page.locator('.pane.active .xterm-helper-textarea').evaluate(e => (e as HTMLElement).focus());
  await page.keyboard.type(text);
}
export async function holdEnter(page: Page): Promise<void> {
  await page.evaluate(() => {window.voiceEnter=[]; window.realTimer=window.setTimeout;
    window.setTimeout=(fn,ms,...args)=>ms===60?(window.voiceEnter.push(fn),0):window.realTimer(fn,ms,...args)});
}
export async function runEnter(page: Page): Promise<void> {
  await page.evaluate(() => {window.voiceEnter.shift()(); window.setTimeout=window.realTimer});
}
