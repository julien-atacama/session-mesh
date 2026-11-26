// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {Dictation, configuration} from '../backend/dictation.ts';
import {createInlineDictationController} from '../static/dictation-inline.ts';
import type {InlineDictationPorts, InlineSession, InlineJob} from '../static/dictation-inline.ts';
import type {DictationChannel} from '../static/dictation.ts';
import {createDictationChannel} from '../static/dictation-channel.ts';
import {createHumanInputLease, createHumanInputScope} from '../static/pane-actions.ts';
import {assertInsertedEngineParity, assertInsertedFixtureParity} from './dictation-inserted-fixture.test.ts';

const flush = async () => {for (let i = 0; i < 50; i++) await Promise.resolve();};
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(r => {resolve = r;}); return {promise, resolve};}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status});
function fixture() {
  let now = 0, sequence = 0, timer = 0, permissionCalls = 0, recorderCalls = 0, stopped = 0, inserted = 0;
  let eligible = true, valid = true, fresh = true, claims = 0, releases = 0, retained = 0;
  const timers = new Map<number, {at: number; run: () => void}>();
  const calls: {path: string; init: RequestInit}[] = [], pastes: string[] = [];
  let job: InlineJob | null = null;
  const stream = {getTracks: () => [{stop() {stopped++;}, onended: null}]} as unknown as MediaStream;
  let permission = () => Promise.resolve(stream);
  let deliver = (text: string, done: (result: {kind: string}) => void, guard: () => boolean) => {
    assert.equal(guard(), true); pastes.push(text); done({kind: 'paste'});
  };
  let request = async (path: string, init: RequestInit): Promise<Response> => {
    if (path === '/api/transcribe/config') return response({enabled: true, max_bytes: 1024, capture_seconds: 2,
      queue_wait_seconds: 3, active_timeout_seconds: 3, result_ttl_seconds: 4});
    if (path === '/api/transcribe') {
      const headers = new Headers(init.headers);
      job = {job_id: `job-${headers.get('X-Mesh-Request-Id')}`, request_id: headers.get('X-Mesh-Request-Id')!,
        session: headers.get('X-Mesh-Session')!, created: Number(headers.get('X-Mesh-Created')),
        state: 'ready', text: 'bonjour A', error: null, outcome: null};
      return response(job);
    }
    if (path.endsWith('/settle')) {assert.equal(JSON.parse(init.body as string).outcome, 'inserted'); job = {...job!, state: 'settled', text: null, outcome: 'inserted'};}
    if (path.endsWith('/cancel')) job = {...job!, state: 'cancelled', text: null};
    return response(job);
  };
  const fakeRecorder = {
    state: 'inactive', mimeType: 'audio/webm', ondataavailable: null as null | ((event: {data: Blob}) => void),
    onstop: null as null | (() => void), onerror: null as null | ((event: ErrorEvent) => void),
    start() {this.state = 'recording';},
    stop() {this.state = 'inactive'; this.ondataavailable?.({data: new Blob(['clip'], {type: 'audio/webm'})}); this.onstop?.();},
  };
  const recorder = fakeRecorder as unknown as MediaRecorder;
  const ports: InlineDictationPorts = {
    namespace: 'test', uuid: () => `uuid-${++sequence}`, allowed: () => true, changed() {},
    eligible: () => eligible,
    retain() {retained++; return {valid: () => valid, captureFresh: () => fresh, claim() {claims++; return valid && fresh;},
      release() {releases++;}, deliver: (...args) => deliver(...args)} satisfies DictationChannel;},
    media: {supported: () => true, permission() {permissionCalls++; return permission();}, recorder() {recorderCalls++; return recorder;}},
    request(path, init = {}) {calls.push({path, init}); return request(path, init);},
    inserted() {inserted++;}, now: () => now,
    schedule(run, ms) {const id = ++timer; timers.set(id, {at: now + ms, run}); return id;},
    unschedule(id) {timers.delete(id);},
  };
  const controller = createInlineDictationController(ports), session = controller.session('A', 1);
  return {controller, session, ports, calls, pastes, recorder, stream,
    setRequest(fn: typeof request) {request = fn;}, defaultRequest: request,
    setPermission(fn: typeof permission) {permission = fn;}, setDeliver(fn: typeof deliver) {deliver = fn;},
    setEligible(value: boolean) {eligible = value;}, setValid(value: boolean) {valid = value;}, setFresh(value: boolean) {fresh = value;},
    job: () => job, counts: () => ({permissionCalls, recorderCalls, stopped, inserted, claims, releases, retained}),
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].run(); await flush();
      }
      now = end; await flush();
    },
  };
}
async function record(f: ReturnType<typeof fixture>, s: InlineSession = f.session) {
  assert.equal(await f.controller.press(s), true); f.controller.release(s); await flush();
}

test('an interrupted initial config body retries, but a disabled reply stops discovery', async () => {
  const f = fixture();
  f.setRequest(async () => new Response(new ReadableStream({
    start(stream) { stream.error(Error('config response interrupted')); },
  })));
  await f.controller.start();
  assert.equal(f.calls.length, 1);
  f.setRequest(async () => response({enabled: false, disabled_reason: 'not_configured'}));
  await f.advance(1000);
  assert.equal(f.calls.length, 2);
  assert.equal(f.controller.disabledReason(), 'not_configured');
  await f.advance(30000);
  assert.equal(f.calls.length, 2);
  assert.equal(f.counts().permissionCalls, 0);
});

test('AC-5: inserted settlement and bounded cleanup', async t => {
  await t.test('production and strict browser fake agree on ready-only owned idempotent insertion', async () => {
    await assertInsertedEngineParity(); await assertInsertedFixtureParity();
  });
  await t.test('paste retires automatically, never reads preferences, permits a distinct fresh request', async () => {
    const f = fixture();
    Object.defineProperty(f.ports, 'preference', {get() {assert.fail('manual dictation must not access preferences');}});
    await f.controller.start(); await record(f);
    assert.deepEqual(f.pastes, ['bonjour A']); assert.equal(f.counts().inserted, 1);
    assert.equal(f.session.state, 'idle'); assert.equal(f.session.outstanding, false);
    assert.equal('text' in f.session, false); assert.equal(f.session.job, null);
    await record(f);
    const uploads = f.calls.filter(c => c.path === '/api/transcribe');
    assert.equal(uploads.length, 2);
    assert.notEqual(new Headers(uploads[0].init.headers).get('X-Mesh-Request-Id'), new Headers(uploads[1].init.headers).get('X-Mesh-Request-Id'));
    assert.equal(f.calls.filter(c => c.path.endsWith('/settle')).length, 2);
    assert.ok(f.calls.filter(c => c.path !== '/api/transcribe/config').every(c => new Headers(c.init.headers).get('X-Mesh-Dictation-Client') === 'uuid-1'));
    assert.equal(f.counts().claims, 2); assert.equal(f.counts().releases, 2);
    f.controller.dispose();
  });
  await t.test('lost inserted acknowledgement then known-job 404 never replays', async () => {
    const f = fixture(); const base = f.defaultRequest; let settled = false;
    f.setRequest(async (path, init) => {
      if (path.endsWith('/settle')) {settled = true; throw Error('lost ack');}
      if (settled) return response({}, 404);
      return base(path, init);
    });
    await f.controller.start(); await record(f); await f.advance(1000);
    assert.equal(f.session.outstanding, false); assert.deepEqual(f.pastes, ['bonjour A']); f.controller.dispose();
  });
  await t.test('hung cleanup is aborted at 30s even if request ignores abort; late response is inert', async () => {
    const f = fixture(); const base = f.defaultRequest, pending = deferred<Response>(); let signal: AbortSignal | null | undefined;
    f.setRequest(async (path, init) => {
      if (path.endsWith('/settle')) {signal = init.signal; return pending.promise;}
      return base(path, init);
    });
    await f.controller.start(); await record(f); await f.advance(29999);
    assert.notEqual(f.session.message, 'cleanupUnavailable');
    await f.advance(1);
    assert.equal(signal?.aborted, true); assert.equal(f.session.state, 'idle');
    assert.equal(f.session.message, 'cleanupUnavailable'); assert.ok(f.session.requestId);
    const count = f.calls.length; await f.advance(60000); assert.equal(f.calls.length, count);
    pending.resolve(response({...f.job()!, state: 'settled', outcome: 'inserted'})); await flush();
    assert.ok(f.session.requestId); assert.equal(f.counts().inserted, 1); f.controller.dispose();
  });
  await t.test('unknown admission 404 retains original identity, with no audio retry', async () => {
    const f = fixture(); const base = f.defaultRequest;
    f.setRequest(async (path, init) => {
      if (path === '/api/transcribe') throw Error('unknown admission');
      if (path.includes('/request/')) return response({}, 404);
      return base(path, init);
    });
    await f.controller.start(); await record(f); const id = f.session.requestId;
    await f.advance(30000);
    assert.equal(f.session.requestId, id); assert.equal(f.session.message, 'cleanupUnavailable');
    assert.equal(f.calls.filter(c => c.path === '/api/transcribe').length, 1);
    const lookups = f.calls.filter(c => c.path.includes('/request/'));
    assert.ok(lookups.length > 0); assert.ok(lookups.every(c => c.path.endsWith(`/${id}`)));
    assert.deepEqual(f.pastes, []); f.controller.dispose();
  });
  await t.test('controller settles a ready job through the production engine', productionSettlement);
});

test('AC-6: fresh recovery hold without delayed capture', async t => {
  for (const released of [false, true]) await t.test(`cleanup confirms ${released ? 'after release' : 'while same hold remains active'}`, async () => {
    const f = fixture(); const base = f.defaultRequest, cleanup = deferred<Response>(); let recovering = false;
    f.setDeliver((_text, done) => done({kind: 'uncertain'}));
    f.setRequest(async (path, init) => {
      if (path.endsWith('/cancel')) {if (recovering) return cleanup.promise; throw Error('offline');}
      if (recovering && path.includes('/job-')) return response(f.job());
      return base(path, init);
    });
    await f.controller.start(); await record(f); await f.advance(30000);
    assert.equal(f.session.message, 'cleanupUnavailable'); recovering = true;
    const press = f.controller.press(f.session); await flush();
    assert.equal(f.counts().permissionCalls, 1, 'cleanup must precede permission');
    if (released) f.controller.release(f.session);
    cleanup.resolve(response({...f.job()!, state: 'cancelled', text: null})); await flush();
    assert.equal(await press, !released); assert.equal(f.counts().permissionCalls, released ? 1 : 2);
    assert.equal(f.calls.filter(c => c.path === '/api/transcribe').length, 1);
    if (!released) f.controller.release(f.session);
    f.controller.dispose();
  });
  await t.test('permission denial and recorder errors are terminal before admission', async () => {
    const f = fixture(); await f.controller.start();
    f.setPermission(async () => {throw Error('denied');}); assert.equal(await f.controller.press(f.session), false);
    assert.equal(f.session.state, 'idle'); assert.equal(f.session.message, 'permissionDenied'); assert.equal(f.session.outstanding, false);
    f.setPermission(async () => f.stream); assert.equal(await f.controller.press(f.session), true);
    f.recorder.onerror?.({} as ErrorEvent); await flush();
    assert.equal(f.session.state, 'idle'); assert.equal(f.session.message, 'recordingError'); assert.equal(f.session.outstanding, false);
    assert.equal(f.calls.filter(c => c.path === '/api/transcribe').length, 0); assert.ok(f.counts().stopped);
    assert.equal(await f.controller.press(f.session), true); f.controller.dispose();
  });
  await t.test('release before late permission stops all late tracks, never records/uploads', async () => {
    const f = fixture(), permission = deferred<MediaStream>(); f.setPermission(() => permission.promise);
    await f.controller.start(); const press = f.controller.press(f.session); f.controller.release(f.session);
    assert.equal(await press, false); permission.resolve(f.stream); await flush();
    assert.equal(f.counts().stopped, 1); assert.equal(f.counts().recorderCalls, 0);
    assert.equal(f.session.outstanding, false); assert.equal(f.calls.filter(c => c.path === '/api/transcribe').length, 0);
    f.controller.dispose();
  });
});

test('released operations retain their original channels; unreleased hide/detach cancels', async () => {
  for (const action of ['hidden', 'detach'] as const) {
    const f = fixture(); await f.controller.start(); await f.controller.press(f.session);
    if (action === 'hidden') f.controller.hidden(); else f.controller.detach(f.session);
    f.controller.release(f.session); await flush(); assert.equal(f.session.outstanding, false); assert.deepEqual(f.pastes, []);
    assert.ok(f.counts().stopped); f.controller.dispose();
  }
  const f = fixture(), ready = deferred<Response>(); const base = f.defaultRequest;
  f.setRequest(async (path, init) => path === '/api/transcribe' ? ready.promise : base(path, init));
  await f.controller.start(); await record(f); f.controller.detach(f.session); f.controller.hidden();
  f.controller.session('C', 3);
  ready.resolve(response({job_id: 'old-job', request_id: f.session.requestId, session: 'A', created: 1,
    state: 'ready', text: 'bonjour A', error: null, outcome: null}));
  f.setRequest(async (path, init) => path.includes('old-job') ? response({job_id: 'old-job', request_id: f.session.requestId,
    session: 'A', created: 1, state: path.endsWith('/settle') ? 'settled' : 'ready', text: 'bonjour A', outcome: null, error: null}) : base(path, init));
  await flush(); assert.deepEqual(f.pastes, ['bonjour A']); assert.equal(f.counts().retained, 1); f.controller.dispose();
});

test('cache suspension and authentication refusal revoke input and late callbacks', async () => {
  const f = fixture(); let done!: (result: {kind: string}) => void, guard!: () => boolean;
  f.setDeliver((_text, callback, check) => {done = callback; guard = check;});
  await f.controller.start(); await record(f); assert.equal(guard(), true);
  f.controller.suspendForPageCache(); assert.equal(guard(), false); done({kind: 'paste'});
  assert.equal(f.counts().inserted, 0); const before = f.calls.length;
  await f.advance(60000); assert.equal(f.calls.length, before);
  f.controller.resumeFromPageCache(); await flush();
  assert.equal(f.counts().retained, 1); assert.equal(f.counts().permissionCalls, 1);
  assert.equal(f.calls.filter(c => c.path === '/api/transcribe').length, 1);
  f.controller.dispose();
  const g = fixture(), pending = deferred<MediaStream>();
  await g.controller.start(); g.setPermission(() => pending.promise); const press = g.controller.press(g.session);
  g.controller.dispose(); pending.resolve(g.stream); assert.equal(await press, false); assert.equal(g.counts().stopped, 1);
  const h = fixture(); h.setRequest(async path => response({}, path === '/api/transcribe/config' ? 401 : 403));
  await h.controller.start(); assert.equal(await h.controller.press(h.session), false); await h.advance(60000); assert.equal(h.calls.length, 1);
});

test('freshness, eligibility and preflight identity are rechecked before one-shot delivery', async () => {
  for (const failure of ['revision', 'binding', 'eligibility', 'identity', 'controls'] as const) {
    const f = fixture(), admitted = deferred<Response>();
    await f.controller.start();
    f.setRequest(async path => path === '/api/transcribe' ? admitted.promise : response({job_id: 'job', request_id: f.session.requestId,
      session: failure === 'identity' && !path.endsWith('/cancel') ? 'B' : 'A', created: 1,
      state: path.endsWith('/cancel') ? 'cancelled' : 'ready', text: 'hello', outcome: null, error: null}));
    await record(f);
    if (failure === 'revision') f.setFresh(false);
    if (failure === 'binding') f.setValid(false);
    if (failure === 'eligibility') f.setEligible(false);
    admitted.resolve(response({job_id: 'job', request_id: f.session.requestId, session: 'A', created: 1,
      state: 'ready', text: failure === 'controls' ? 'hello\x85' : 'hello', outcome: null, error: null}));
    await flush(); assert.deepEqual(f.pastes, [], failure); assert.equal(f.counts().retained, 1); f.controller.dispose();
  }
});

test('controller uses production insertion channel revision semantics, preserving own dirty H', async () => {
  const f = fixture(), controls: boolean[] = [], bytes: string[] = [], scope = createHumanInputScope();
  const transport = {control(_id: string, dirty: boolean) {controls.push(dirty);},
    data(value: Uint8Array) {bytes.push(new TextDecoder().decode(value));}};
  const lease = createHumanInputLease({clientId: 'input-client', scope, ...transport});
  lease.write(new TextEncoder().encode('existing'), false);
  f.ports.retain = () => {
    let onData: (frame: string) => void = () => {};
    return createDictationChannel({insertionOnly: true, target: {} as never, socket: {send() {assert.fail('use owned transport');}},
      lease, transport, valid: () => true, release() {}, mode: {value: true, valid: true, bytes() {}, dispose() {}},
      encoder: () => ({write(_text, done) {done();}, paste(text) {onData('\x1b[200~'); onData(text); onData('\x1b[201~');},
        onData(callback) {onData = callback; return {dispose() {}};}, dispose() {}})});
  };
  await f.controller.start(); await record(f);
  assert.deepEqual(bytes, ['existing', '\x1b[200~', 'bonjour A', '\x1b[201~']);
  assert.equal(f.session.outstanding, false); assert.equal(f.counts().inserted, 1);
  lease.write(new TextEncoder().encode('\x7f'), false); await record(f);
  assert.equal(f.counts().inserted, 2); assert.equal(lease.dirty, true); assert.deepEqual(controls, [true]);
  f.controller.dispose();
});

async function productionSettlement() {
  const f = fixture(); f.ports.uuid = randomUUID;
  const config = configuration({MESH_WHISPER_URL: 'http://127.0.0.1:1/transcribe'})!;
  const engine = new Dictation(config, {infer: async () => 'bonjour A'});
  const base = f.defaultRequest;
  f.setRequest(async (path, init) => {
    if (path.endsWith('/config')) return base(path, init);
    const headers = new Headers(init.headers), identity = {principal: 'owner', client: headers.get('X-Mesh-Dictation-Client')!};
    if (path === '/api/transcribe') {
      const meta = {...identity, request: headers.get('X-Mesh-Request-Id')!, session: headers.get('X-Mesh-Session')!,
        created: Number(headers.get('X-Mesh-Created')), mime: 'audio/webm'};
      async function* audio() {yield Buffer.from('clip');}
      const prepared = await engine.prepare(meta, audio()); engine.commit(meta, prepared.job.job_id, prepared.preparation);
      return response(prepared.job);
    }
    const id = path.split('/')[3];
    if (path.endsWith('/settle')) return response(engine.settle(identity, id, JSON.parse(init.body as string).outcome));
    if (path.endsWith('/cancel')) return response(engine.cancel(identity, id));
    return response(engine.read(identity, id));
  });
  try {
    await f.controller.start(); await record(f); await f.advance(1000);
    assert.deepEqual(f.pastes, ['bonjour A']); assert.equal(f.session.outstanding, false);
    assert.equal(engine.stats().active, 0); assert.equal(engine.stats().bytes, 0);
    assert.equal(f.calls.filter(c => c.path.endsWith('/settle')).length, 1);
  } finally {f.controller.dispose(); await engine.close();}
}

test('permission, recording and released-recorder deadlines are terminal without admission', async () => {
  for (const failure of ['permissionTimeout', 'durationLimit', 'audioLimit', 'recorderConstructor', 'recorderStart', 'stopTimeout'] as const) {
    const f = fixture(), permission = deferred<MediaStream>();
    await f.controller.start();
    if (failure === 'permissionTimeout') f.setPermission(() => permission.promise);
    if (failure === 'recorderConstructor') f.ports.media.recorder = () => {throw Error('constructor');};
    if (failure === 'recorderStart') f.recorder.start = () => {throw Error('start');};
    const press = f.controller.press(f.session);
    if (failure === 'permissionTimeout') {
      await f.advance(2000); assert.equal(await press, false); permission.resolve(f.stream); await flush();
    } else {
      const recording = await press;
      if (failure === 'recorderConstructor' || failure === 'recorderStart') assert.equal(recording, false);
      else {
        assert.equal(recording, true);
        if (failure === 'audioLimit') f.recorder.ondataavailable?.({data: new Blob(['x'.repeat(1025)])} as BlobEvent);
        else if (failure === 'stopTimeout') {
          f.recorder.stop = () => {}; f.controller.release(f.session); await f.advance(2000);
        } else await f.advance(2000);
      }
    }
    assert.equal(f.session.state, 'idle', failure); assert.equal(f.session.outstanding, false, failure);
    assert.equal(f.calls.filter(c => c.path === '/api/transcribe').length, 0, failure);
    assert.ok(f.counts().stopped, failure); f.controller.dispose();
  }
});

test('release between permission resolution and continuation still stops the resolved stream', async () => {
  const f = fixture(), permission = deferred<MediaStream>(); f.setPermission(() => permission.promise);
  await f.controller.start(); const press = f.controller.press(f.session);
  permission.resolve(f.stream); await Promise.resolve(); f.controller.release(f.session);
  assert.equal(await press, false); assert.equal(f.counts().stopped, 1); assert.equal(f.counts().recorderCalls, 0);
  f.controller.dispose();
});

test('recovery holds are cancelled by hiding/detachment and recheck eligibility after confirmed cleanup', async () => {
  for (const action of ['hidden', 'detach', 'ineligible'] as const) {
    const f = fixture(); const base = f.defaultRequest, control = deferred<Response>(); let recovering = false;
    f.setDeliver((_text, done) => done({kind: 'refused'}));
    f.setRequest(async (path, init) => {
      if (path.endsWith('/cancel')) return recovering ? control.promise : response({}, 503);
      return base(path, init);
    });
    await f.controller.start(); await record(f); await f.advance(30000); recovering = true;
    const press = f.controller.press(f.session); await flush();
    if (action === 'hidden') f.controller.hidden();
    if (action === 'detach') f.controller.detach(f.session);
    if (action === 'ineligible') f.setEligible(false);
    control.resolve(response({...f.job()!, state: 'cancelled', text: null}));
    assert.equal(await press, false); await flush(); assert.equal(f.counts().permissionCalls, 1);
    assert.equal(f.counts().retained, 1); assert.equal(f.session.outstanding, false); f.controller.dispose();
  }
});

test('cleanup bounds a hung response body; late body settlement cannot clear retained identity', async () => {
  const f = fixture(); const base = f.defaultRequest, body = deferred<unknown>();
  f.setRequest(async (path, init) => {
    if (path.endsWith('/settle')) {
      const r = response({}); r.json = () => body.promise; return r;
    }
    return base(path, init);
  });
  await f.controller.start(); await record(f); const request = f.session.requestId;
  await f.advance(30000); assert.equal(f.session.message, 'cleanupUnavailable');
  body.resolve({...f.job()!, state: 'settled', outcome: 'inserted'}); await flush();
  assert.equal(f.session.requestId, request); assert.equal(f.counts().inserted, 1); f.controller.dispose();
});

test('lost inserted acknowledgement reconciles settled status and never repeats terminal delivery', async () => {
  const f = fixture(); const base = f.defaultRequest; let settled = false;
  f.setRequest(async (path, init) => {
    if (path.endsWith('/settle')) {await base(path, init); settled = true; throw Error('lost');}
    return base(path, init);
  });
  await f.controller.start(); await record(f); await f.advance(1000);
  assert.equal(settled, true); assert.equal(f.session.outstanding, false); assert.equal(f.counts().inserted, 1);
  assert.deepEqual(f.pastes, ['bonjour A']); f.controller.dispose();
});

test('authentication refusal during an admitted operation stops all controls and input', async () => {
  for (const status of [401, 403]) {
    const f = fixture(); const base = f.defaultRequest;
    f.setRequest(async (path, init) => path.includes('/job-') ? response({}, status) : base(path, init));
    await f.controller.start(); await record(f); const count = f.calls.length;
    await f.advance(60000); assert.equal(f.calls.length, count); assert.deepEqual(f.pastes, []);
    assert.equal(await f.controller.press(f.session), false); assert.ok(f.counts().stopped);
    assert.equal(f.counts().releases, 1);
  }
});

test('suspension aborts an uncertain upload; authenticated resume only cancels its original request', async () => {
  const f = fixture(); const base = f.defaultRequest, upload = deferred<Response>(); let signal: AbortSignal | null | undefined;
  f.setRequest(async (path, init) => {
    if (path === '/api/transcribe') {signal = init.signal; return upload.promise;}
    return base(path, init);
  });
  await f.controller.start(); await record(f); const id = f.session.requestId;
  f.controller.suspendForPageCache(); assert.equal(signal?.aborted, true);
  f.setRequest(async path => {
    if (path.includes('/request/')) return response({job_id: 'old-job', request_id: id, session: 'A', created: 1,
      state: 'processing', text: null, error: null, outcome: null});
    if (path.endsWith('/cancel')) return response({job_id: 'old-job', request_id: id, session: 'A', created: 1,
      state: 'cancelled', text: null, error: null, outcome: null});
    assert.fail(`unexpected request after resume: ${path}`);
  });
  upload.resolve(response({job_id: 'old-job', request_id: id, session: 'A', created: 1,
    state: 'ready', text: 'must not insert', error: null, outcome: null})); await flush();
  f.controller.resumeFromPageCache(); await flush();
  assert.equal(f.session.outstanding, false); assert.deepEqual(f.pastes, []);
  assert.equal(f.counts().permissionCalls, 1); assert.equal(f.counts().retained, 1);
  assert.ok(f.calls.some(c => c.path === `/api/transcribe/request/${id}`)); f.controller.dispose();
});

test('polling and a missing delivery callback are bounded, without renewing TTL or replaying', async () => {
  for (const missing of ['result', 'callback'] as const) {
    const f = fixture(); const base = f.defaultRequest;
    if (missing === 'callback') f.setDeliver((text, _done, guard) => {assert.equal(guard(), true); f.pastes.push(text);});
    else f.setRequest(async (path, init) => {
      const r = await base(path, init);
      return path.endsWith('/config') || path.endsWith('/cancel') ? r : response({...f.job()!, state: 'processing', text: null});
    });
    await f.controller.start(); await record(f); await f.advance(10000);
    assert.equal(f.session.outstanding, false); const count = f.calls.length;
    await f.advance(60000); assert.equal(f.calls.length, count);
    assert.equal(f.pastes.length, missing === 'callback' ? 1 : 0);
    assert.ok(f.calls.some(c => c.path.endsWith('/cancel'))); f.controller.dispose();
  }
});

test('released A and B complete once on original retained channels while C is active', async () => {
  const f = fixture(), b = f.controller.session('B', 2), c = f.controller.session('C', 3);
  const base = f.defaultRequest, jobs = new Map<string, InlineJob>(), uploads: {job: InlineJob; pending: ReturnType<typeof deferred<Response>>}[] = [];
  const inserted: string[] = [], captured: string[] = [];
  f.ports.retain = s => {
    captured.push(s.name); let released = false;
    return {valid: () => !released, captureFresh: () => !released, claim: () => !released, release() {released = true;},
      deliver(text, done, guard) {assert.equal(guard(), true); inserted.push(`${s.name}:${text}`); done({kind: 'paste'});}};
  };
  f.setRequest(async (path, init) => {
    if (path.endsWith('/config')) return base(path, init);
    if (path === '/api/transcribe') {
      const h = new Headers(init.headers), request = h.get('X-Mesh-Request-Id')!;
      const job: InlineJob = {job_id: `job-${request}`, request_id: request, session: h.get('X-Mesh-Session')!,
        created: Number(h.get('X-Mesh-Created')), state: 'ready', text: `hello ${h.get('X-Mesh-Session')}`, error: null, outcome: null};
      const pending = deferred<Response>(); jobs.set(job.job_id, job); uploads.push({job, pending}); return pending.promise;
    }
    const job = jobs.get(path.split('/')[3])!;
    return response(path.endsWith('/settle') ? {...job, state: 'settled', outcome: 'inserted', text: null} : job);
  });
  await f.controller.start(); await record(f); f.controller.detach(f.session);
  await record(f, b); f.controller.detach(b); f.controller.hidden();
  assert.equal(f.controller.peekSession('C', 3), c); assert.equal(c.outstanding, false);
  uploads[1].pending.resolve(response(uploads[1].job)); await flush();
  uploads[0].pending.resolve(response(uploads[0].job)); await flush();
  assert.deepEqual(captured, ['A', 'B']); assert.deepEqual(inserted, ['B:hello B', 'A:hello A']);
  assert.equal(c.outstanding, false); assert.equal(f.controller.holds().length, 0); f.controller.dispose();
});

test('stale preflight GET after suspension cannot claim or recreate an input channel', async () => {
  const f = fixture(), preflight = deferred<Response>(); const base = f.defaultRequest;
  f.setRequest(async (path, init) => path.includes('/job-') && !path.endsWith('/cancel') ? preflight.promise : base(path, init));
  await f.controller.start(); await record(f); const old = f.job();
  assert.equal(f.counts().claims, 0); f.controller.suspendForPageCache();
  f.controller.resumeFromPageCache(); await flush();
  preflight.resolve(response(old)); await flush();
  assert.equal(f.counts().claims, 0); assert.equal(f.counts().retained, 1); assert.deepEqual(f.pastes, []);
  assert.equal(f.session.outstanding, false); f.controller.dispose();
});

test('known admission rejection is terminal and later recording uses a fresh request', async () => {
  const f = fixture(); const base = f.defaultRequest; let reject = true;
  f.setRequest(async (path, init) => path === '/api/transcribe' && reject ? response({error: {code: 'queue_full'}}, 429) : base(path, init));
  await f.controller.start(); await record(f);
  assert.equal(f.session.outstanding, false); assert.equal(f.session.state, 'idle');
  reject = false; await record(f); assert.deepEqual(f.pastes, ['bonjour A']);
  assert.equal(f.calls.filter(call => call.path.includes('/request/')).length, 0); f.controller.dispose();
});

test('retired refusal retains its inline diagnostic but never an error-state or hidden ready lock', async () => {
  const f = fixture(); await f.controller.start();
  f.setDeliver((_text, done) => done({kind: 'refused'})); await record(f);
  assert.equal(f.session.state, 'idle'); assert.equal(f.session.outstanding, false);
  assert.equal(f.session.message, 'contextChanged'); assert.equal(f.controller.reason(f.session), '');
  assert.equal(f.session.job, null); assert.equal(await f.controller.press(f.session), true);
  assert.equal(f.session.message, ''); f.controller.dispose();
});

test('disabled service reasons are closed, terminal and take precedence over local eligibility', async () => {
  const codes = ['not_configured', 'invalid_configuration', 'runtime_unavailable', 'startup_timeout', 'worker_failed'];
  for (const code of [...codes, undefined, 'unknown', '__proto__', '<img onerror=alert(1)>', {}, ['worker_failed'], null]) {
    const f = fixture();
    f.setRequest(async () => response({enabled: false, disabled_reason: code, message: 'never display this'}));
    f.setEligible(false); f.ports.media.supported = () => false;
    await f.controller.start();
    const expected = typeof code === 'string' && codes.includes(code) ? code : 'unavailable';
    assert.equal(f.controller.disabledReason(), expected);
    assert.equal(f.controller.reason(f.session), expected);
    assert.equal(await f.controller.press(f.session), false);
    await f.advance(120000); f.controller.suspendForPageCache(); f.controller.resumeFromPageCache(); await flush();
    assert.equal(f.calls.length, 1, 'permanent disable never retries or asks for media');
    assert.equal(f.counts().permissionCalls, 0); assert.equal(f.counts().retained, 0);
    f.controller.dispose();
  }
});

test('healthy configuration ignores both automatic and explicit language metadata', async () => {
  for (const language of [null, 'fr']) {
    const f = fixture(), base = f.defaultRequest;
    f.setRequest(async (path, init) => path.endsWith('/config')
      ? response({enabled: true, language, max_bytes: 1024, capture_seconds: 2}) : base(path, init));
    await f.controller.start();
    assert.equal(f.controller.disabledReason(), null); await record(f);
    assert.deepEqual(f.pastes, ['bonjour A']); f.controller.dispose();
  }
});

test('observed worker loss stops another unreleased microphone but retains its admitted original job', async () => {
  const f = fixture(), base = f.defaultRequest, b = f.controller.session('B', 2); let lost = false;
  f.setRequest(async (path, init) => {
    if (lost) return path.endsWith('/config') ? response({enabled: false, disabled_reason: 'worker_failed'})
      : response({error: {code: 'disabled'}}, 503);
    const r = await base(path, init);
    return path === '/api/transcribe' ? response({...f.job()!, state: 'processing', text: null}) : r;
  });
  await f.controller.start(); await record(f); const id = f.session.requestId;
  assert.equal(await f.controller.press(b), true);
  lost = true; await f.advance(1000); f.controller.release(b);
  assert.equal(b.state, 'idle'); assert.equal(b.outstanding, false);
  assert.equal(f.session.requestId, id); assert.deepEqual(f.controller.holds(), [f.session]);
  assert.equal(f.controller.reason(b), 'worker_failed');
  assert.equal(f.calls.filter(call => call.path === '/api/transcribe').length, 1);
  assert.equal(f.counts().stopped, 2); assert.deepEqual(f.pastes, []); f.controller.dispose();
});

test('worker loss during polling explains the cause without clearing uncertainty or replaying audio', async () => {
  const f = fixture(), base = f.defaultRequest; let lost = false;
  f.setRequest(async (path, init) => {
    if (lost) return path.endsWith('/config') ? response({enabled: false, disabled_reason: 'worker_failed'})
      : response({error: {code: 'disabled', message: 'private diagnostic must not escape'}}, 503);
    const r = await base(path, init);
    return path === '/api/transcribe' ? response({...f.job()!, state: 'processing', text: null}) : r;
  });
  await f.controller.start(); await record(f); const id = f.session.requestId;
  lost = true; await f.advance(1000);
  assert.equal(f.controller.disabledReason(), 'worker_failed');
  assert.equal(f.controller.reason(f.session), 'worker_failed');
  assert.ok(['unavailable', 'worker_failed'].includes(f.session.message));
  assert.equal(f.session.requestId, id); assert.ok(f.session.outstanding);
  assert.deepEqual(f.controller.holds(), [f.session]);
  assert.equal(await f.controller.press(f.controller.session('B', 2)), false);
  await f.advance(120000);
  assert.equal(f.session.requestId, id, 'unconfirmed cancellation must retain identity');
  assert.equal(f.calls.filter(c => c.path.endsWith('/config')).length, 2, 'one bounded diagnostic refresh');
  assert.equal(f.calls.filter(c => c.path === '/api/transcribe').length, 1);
  assert.equal(f.counts().permissionCalls, 1); assert.deepEqual(f.pastes, []); f.controller.dispose();
});

test('a stalled disable-cause refresh cannot extend the original result and cleanup bounds', async () => {
  const f = fixture(), base = f.defaultRequest, pending = deferred<Response>(); let lost = false;
  f.setRequest(async (path, init) => {
    if (lost) return path.endsWith('/config') ? pending.promise : response({error: {code: 'disabled'}}, 503);
    const r = await base(path, init);
    return path === '/api/transcribe' ? response({...f.job()!, state: 'processing', text: null}) : r;
  });
  await f.controller.start(); await record(f); const id = f.session.requestId;
  lost = true; await f.advance(1000);
  assert.equal(f.controller.disabledReason(), 'unavailable');
  await f.advance(39000);
  assert.equal(f.session.state, 'idle'); assert.equal(f.session.message, 'cleanupUnavailable');
  assert.equal(f.session.requestId, id); const calls = f.calls.length;
  await f.advance(120000); assert.equal(f.calls.length, calls);
  pending.resolve(response({enabled: true, max_bytes: 1024, capture_seconds: 2})); await flush();
  assert.equal(await f.controller.press(f.session), false, 'late diagnostics cannot reopen capture');
  assert.deepEqual(f.pastes, []); f.controller.dispose();
});

test('inline transcript filtering covers every forbidden control, trim and length boundaries', async () => {
  const controls = Array.from({length: 160}, (_, code) => code)
    .filter(code => code < 32 && code !== 9 && code !== 10 || code >= 127);
  const invalid = [...controls.map(code => `hello${String.fromCharCode(code)}`), '', ' \t\n', 'x'.repeat(32769)];
  for (const text of [...invalid, 'é\t\nhello', '~\u00a0\u2028', 'é'.repeat(32768)]) {
    const f = fixture(), base = f.defaultRequest;
    f.setRequest(async (path, init) => {
      const r = await base(path, init);
      return path.endsWith('/config') || path.endsWith('/settle') || path.endsWith('/cancel')
        ? r : response({...f.job()!, text});
    });
    await f.controller.start(); await record(f);
    assert.deepEqual(f.pastes, invalid.includes(text) ? [] : [text], JSON.stringify(text.slice(0, 20)));
    if (invalid.includes(text)) assert.equal(f.counts().claims, 0);
    f.controller.dispose();
  }
});
