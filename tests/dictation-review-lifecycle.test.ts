// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDictationChannel} from '../static/dictation-channel.ts';
import {createInlineDictationController} from '../static/dictation-inline.ts';
import {createHumanInputLease} from '../static/pane-actions.ts';

const flush = async () => {for (let i = 0; i < 60; i++) await Promise.resolve();};
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(r => {resolve = r;}); return {promise, resolve};}
const config = {enabled: true, max_bytes: 1024, capture_seconds: 2};

for (const insertionOnly of [true]) for (const failure of ['retain', 'encoder', 'listener', 'dispose'] as const) {
  test(`${insertionOnly ? 'insertion' : 'compose'} channel rolls back ${failure} failure exactly once`, () => {
    let retained = 0, leaseReleased = 0, released = 0, disposed = 0, listenerDisposed = 0;
    const lease = createHumanInputLease({clientId: 'test-client', control() {}, data() {}});
    lease.retain = () => {retained++; if (failure === 'retain') throw Error('retain'); return () => {leaseReleased++;};};
    const make = () => createDictationChannel({insertionOnly, lease, target: {} as never, socket: {send() {}},
      mode: {value: true, valid: true, bytes() {}, dispose() {}}, transport: {control() {}, data() {}}, valid: () => true,
      release() {released++; if (failure === 'dispose') throw Error('target release');},
      encoder() {
        if (failure === 'encoder') throw Error('encoder');
        return {write(_text, done) {done();}, paste() {},
          onData() {if (failure === 'listener') throw Error('listener'); return {dispose() {listenerDisposed++; throw Error('listener dispose');}};},
          dispose() {disposed++; if (failure === 'dispose') throw Error('encoder dispose');}};
      }});
    if (failure === 'dispose') {const channel = make(); assert.doesNotThrow(() => channel.release()); channel.release();}
    else assert.throws(make);
    assert.equal(retained, 1); assert.equal(leaseReleased, failure === 'retain' ? 0 : 1);
    assert.equal(released, 1); assert.equal(disposed, ['listener', 'dispose'].includes(failure) ? 1 : 0);
    assert.equal(listenerDisposed, failure === 'dispose' ? 1 : 0);
  });
}

function fixture(inline: boolean) {
  let now = 0, sequence = 0, timer = 0, permissions = 0, releases = 0, delivered = 0;
  const timers = new Map<number, {at: number; run(): void}>(), calls: {path: string; init: RequestInit}[] = [];
  let request = async (path: string, _init: RequestInit): Promise<Response> => path.endsWith('/config')
    ? Response.json(config) : Response.json({}, {status: 404});
  const recorder: any = {state: 'inactive', mimeType: 'audio/webm', start() {this.state = 'recording';},
    stop() {this.state = 'inactive'; queueMicrotask(() => {
      this.ondataavailable({data: new Blob(['audio'], {type: 'audio/webm'})}); this.onstop();
    });}};
  const ports = {namespace: 'test', uuid: () => `uuid-${++sequence}`, allowed: () => true, changed() {}, eligible: () => true,
    retain: () => ({valid: () => true, captureFresh: () => true, claim: () => true, release() {releases++;},
      deliver(_text: string, done: (result: {kind: string}) => void) {delivered++; done({kind: inline ? 'paste' : 'submitted'});}}),
    media: {supported: () => true, permission: async () => {permissions++; return {getTracks: () => [{stop() {}}]} as any;}, recorder: () => recorder},
    request(path: string, init: RequestInit = {}) {calls.push({path, init}); return request(path, init);}, now: () => now,
    schedule(run: () => void, ms: number) {timers.set(++timer, {at: now + ms, run}); return timer;}, unschedule(id: number) {timers.delete(id);}};
  // Both controllers deliberately expose the same capture/recovery gesture surface.
  const controller: any = createInlineDictationController(ports);
  const session = controller.session('A', 1);
  return {controller, session, ports, calls, timers, counts: () => ({permissions, releases, delivered}),
    setRequest(fn: typeof request) {request = fn;},
    job(id = session.requestId, state = 'ready') {return {job_id: `job-${id}`, request_id: id, session: 'A', created: 1,
      state, text: state === 'ready' ? 'spoken' : null, error: null, outcome: null};},
    async record() {assert.equal(await controller.press(session), true); controller.release(session); await flush();},
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break; now = next[1].at; timers.delete(next[0]); next[1].run(); await flush();}
      now = end; await flush();
    }};
}

for (const inline of [true]) {
  for (const failure of ['retain', 'valid'] as const) test(`${inline ? 'inline' : 'compose'} ${failure} acquisition failure resolves false and permits next press`, async () => {
    const f = fixture(inline), retain = f.ports.retain; await f.controller.start();
    f.ports.retain = () => {
      if (failure === 'retain') throw Error('encoder setup');
      return {...retain(), valid() {throw Error('binding validation');}};
    };
    assert.equal(await f.controller.press(f.session), false);
    assert.equal(f.counts().permissions, 0); assert.equal(f.session.outstanding, false);
    assert.equal(f.session.message, 'originalUnavailable');
    assert.equal(f.counts().releases, failure === 'valid' ? 1 : 0);
    f.ports.retain = retain; assert.equal(await f.controller.press(f.session), true); f.controller.dispose();
  });
  test(`${inline ? 'inline' : 'compose'} unknown 404 is protected until fixed bound and explicit local cancellation`, async () => {
    const f = fixture(inline); await f.controller.start();
    f.setRequest(async path => {if (path === '/api/transcribe') throw Error('lost admission'); return Response.json({}, {status: 404});});
    await f.record(); const id = f.session.requestId;
    await f.advance(1000); assert.equal(f.session.requestId, id);
    if (!inline) {f.controller.discard(f.session); await flush(); assert.equal(f.session.requestId, id);}
    else {const press = f.controller.press(f.session); await flush(); f.controller.release(f.session); assert.equal(await press, false);}
    await f.advance(29000);
    if (inline) {
      assert.equal(f.session.requestId, id, 'deadline alone is not authoritative absence');
      assert.equal(await f.controller.press(f.session), true, 'fresh recovery hold explicitly cancels local uncertainty');
      f.controller.release(f.session); await flush();
    } else {assert.equal(f.session.requestId, null); await f.record();}
    assert.notEqual(f.session.requestId, id);
    assert.equal(f.calls.filter(c => c.path === '/api/transcribe').length, 2, 'only fresh manually captured audio is uploaded');
    f.controller.dispose();
  });
  test(`${inline ? 'inline' : 'compose'} delayed admission inside recovery window is cancelled, never delivered`, async () => {
    const f = fixture(inline); await f.controller.start(); let admitted = false;
    f.setRequest(async path => {
      if (path === '/api/transcribe') throw Error('lost');
      if (!admitted) return Response.json({}, {status: 404});
      return Response.json(f.job(undefined, path.endsWith('/cancel') ? 'cancelled' : 'ready'));
    });
    await f.record(); const id = f.session.requestId;
    if (!inline) f.controller.discard(f.session);
    await f.advance(1000); assert.equal(f.session.requestId, id);
    admitted = true; await f.advance(1000);
    if (!inline) await f.advance(1000);
    assert.equal(f.session.requestId, null); assert.equal(f.counts().delivered, 0);
    assert.equal(f.calls.filter(c => c.path === '/api/transcribe').length, 1); f.controller.dispose();
  });
}

test('inline discovery of a previously unknown job does not renew its local recovery deadline', async () => {
  const f = fixture(true), late = deferred<Response>();
  await f.controller.start();
  f.setRequest(async path => {
    if (path === '/api/transcribe') throw Error('lost admission');
    if (path.endsWith('/cancel')) return late.promise;
    return Response.json(f.job());
  });
  try {
    await f.record(); const original = f.session.requestId, oldJob = f.job(original);
    assert.ok(f.session.job, 'request lookup discovers the old job before cancellation stalls');
    await f.advance(30000);
    assert.equal(f.session.requestId, original);
    let accepted: boolean | null = null;
    void f.controller.press(f.session).then((value: boolean) => {accepted = value;});
    await flush();
    assert.equal(accepted, true, 'a fresh explicit hold abandons the original local recovery after its fixed window');
    f.setRequest(async () => Response.json(f.job(undefined, 'queued')));
    f.controller.release(f.session); await flush();
    const fresh = f.session.requestId; assert.notEqual(fresh, original);
    late.resolve(Response.json(oldJob)); await flush();
    assert.equal(f.session.requestId, fresh); assert.equal(f.counts().delivered, 0);
    assert.equal(f.calls.filter(call => call.path === '/api/transcribe').length, 2);
  } finally {f.controller.dispose(); late.resolve(Response.json({})); await flush();}
});

for (const stall of ['headers', 'body'] as const) test(`inline resumes interrupted configuration ${stall} but ignores its old response`, async () => {
  const f = fixture(true), old = deferred<any>(); let configs = 0;
  f.setRequest(async () => {
    if (++configs !== 1) return Response.json(config);
    if (stall === 'headers') return old.promise;
    const r = Response.json({}); r.json = () => old.promise; return r;
  });
  const start = f.controller.start(); await flush(); f.controller.suspendForPageCache();
  f.controller.resumeFromPageCache(); await flush(); await start;
  assert.equal(configs, 2); old.resolve(stall === 'headers' ? Response.json({...config, enabled: false}) : {...config, enabled: false}); await flush();
  assert.equal(await f.controller.press(f.session), true); f.controller.detach(f.session);
  f.controller.suspendForPageCache(); f.controller.resumeFromPageCache(); await flush();
  assert.equal(configs, 2, 'already loaded configuration is retained'); f.controller.dispose();
});

for (const inline of [true]) test(`${inline ? 'inline' : 'compose'} local abandonment aborts an old read and stops background retries`, async () => {
  const f = fixture(inline), late = deferred<Response>(); let signal: AbortSignal | null | undefined;
  await f.controller.start();
  f.setRequest(async (path, init) => {
    if (path === '/api/transcribe') throw Error('lost');
    signal = init.signal; return late.promise;
  });
  await f.record(); const old = f.session.requestId;
  if (!inline) f.controller.discard(f.session);
  await f.advance(30000);
  if (inline) assert.equal(f.controller.discard(f.session), true);
  assert.equal(signal?.aborted, true); assert.equal(f.session.requestId, null);
  const count = f.calls.length; await f.advance(60000); assert.equal(f.calls.length, count);
  f.setRequest(async () => Response.json({}, {status: 404}));
  await f.record(); const fresh = f.session.requestId; assert.notEqual(fresh, old);
  late.resolve(Response.json(f.job(old))); await flush();
  assert.equal(f.session.requestId, fresh); assert.equal(f.counts().delivered, 0); f.controller.dispose();
});

for (const inline of [true]) test(`${inline ? 'inline' : 'compose'} upload time does not consume confirmed admission budget`, async () => {
  const f = fixture(inline), admission = deferred<Response>();
  f.setRequest(async path => {
    if (path.endsWith('/config')) return Response.json({...config, queue_wait_seconds: 1, active_timeout_seconds: 1, result_ttl_seconds: 1});
    if (path === '/api/transcribe') return admission.promise;
    return Response.json(f.job(undefined, path.endsWith('/settle') ? 'settled' : 'ready'));
  });
  await f.controller.start(); await f.record(); const id = f.session.requestId;
  await f.advance(4000); admission.resolve(Response.json(f.job(id, 'queued'))); await flush();
  await f.advance(1000);
  assert.equal(f.counts().releases, inline ? 1 : 0);
  if (!inline) {assert.equal(f.session.state, 'ready'); assert.equal(f.controller.send(f.session), true); await flush();}
  assert.equal(f.counts().delivered, 1); assert.equal(f.session.requestId, null);
  assert.equal(f.calls.filter(call => call.path === '/api/transcribe').length, 1); f.controller.dispose();
});

test('inline result admission budget is absolute and never renewed by status polling', async () => {
  const f = fixture(true);
  f.setRequest(async path => path.endsWith('/config')
    ? Response.json({...config, queue_wait_seconds: 1, active_timeout_seconds: 1, result_ttl_seconds: 1})
    : Response.json(f.job(undefined, path.endsWith('/cancel') ? 'cancelled' : 'processing')));
  await f.controller.start(); await f.record(); await f.advance(3000);
  assert.equal(f.session.requestId, null); assert.equal(f.counts().delivered, 0);
  assert.ok(f.calls.some(call => call.path.endsWith('/cancel'))); f.controller.dispose();
});

for (const kind of ['recovering', 'hung', 'disposed', 'suspended'] as const) test(`inline post-bound known-job cancellation is detached and bounded: ${kind}`, async () => {
  const f = fixture(true), late = deferred<Response>(); let old: string | null = null, oldSignal: AbortSignal | null | undefined;
  let detached = false;
  await f.controller.start();
  f.setRequest(async (path, init) => {
    if (path === '/api/transcribe') {if (!old) throw Error('lost'); return Response.json(f.job());}
    if (path.endsWith('/cancel')) {
      if (!detached || kind === 'recovering' && f.ports.now() < 31000) return Response.json({}, {status: 503});
      oldSignal = init.signal;
      if (kind !== 'recovering') return late.promise;
      return Response.json(f.job(old, 'cancelled'));
    }
    return Response.json(f.job());
  });
  await f.record(); old = f.session.requestId; const oldJob = f.job(old);
  await f.advance(30000); assert.equal(f.session.requestId, old); detached = true;
  assert.equal(await f.controller.press(f.session), true, 'old cleanup cannot block fresh permission/recording');
  assert.equal(f.counts().permissions, 2); assert.equal(f.session.state, 'recording'); assert.equal(f.counts().delivered, 0);
  const cancels = () => f.calls.filter(call => call.path === `/api/transcribe/${oldJob.job_id}/cancel`);
  const count = cancels().length;
  if (kind === 'disposed') f.controller.dispose();
  if (kind === 'suspended') f.controller.suspendForPageCache();
  await f.advance(6000);
  assert.ok(cancels().length > (kind === 'recovering' ? count : count - 1));
  assert.ok(cancels().every(call => new Headers(call.init.headers).get('X-Mesh-Dictation-Client') === 'uuid-1'));
  if (kind !== 'recovering') assert.equal(oldSignal?.aborted, true);
  assert.equal(Reflect.get(f.controller, 'io').size, 0, 'detached cleanup retains no controller I/O registration');
  assert.equal(f.timers.size, 0, 'no background timer survives the detached cleanup bound');
  const end = f.calls.length; await f.advance(60000); assert.equal(f.calls.length, end);
  late.resolve(Response.json(oldJob)); await flush(); assert.equal(f.counts().delivered, 0);
  assert.notEqual(f.session.requestId, old); f.controller.dispose();
});

test('inline transient config errors retry with capped backoff and no duplicate startup load', async () => {
  const f = fixture(true); let available = false;
  f.setRequest(async () => available ? Response.json(config) : Response.json({}, {status: 503}));
  await f.controller.start(); await f.controller.start(); assert.equal(f.calls.length, 1);
  await f.advance(31000);
  assert.deepEqual(f.calls.map(call => call.path), Array(6).fill('/api/transcribe/config'));
  available = true; await f.advance(30000);
  assert.equal(f.calls.length, 7); assert.equal(await f.controller.press(f.session), true);
  f.controller.detach(f.session); await f.advance(120000); assert.equal(f.calls.length, 7); f.controller.dispose();
});

for (const status of [200, 400, 401, 403]) test(`inline config ${status} explicit refusal does not retry`, async () => {
  const f = fixture(true); f.setRequest(async () => Response.json({enabled: false}, {status}));
  await f.controller.start(); await f.advance(120000); assert.equal(f.calls.length, 1);
  assert.equal(await f.controller.press(f.session), false); f.controller.dispose();
});

for (const action of ['dispose', 'suspend'] as const) test(`inline config retry timer is cancelled by ${action}`, async () => {
  const f = fixture(true); f.setRequest(async () => {throw Error('network');});
  await f.controller.start();
  assert.equal(f.timers.size, 1);
  if (action === 'dispose') f.controller.dispose(); else f.controller.suspendForPageCache();
  await flush(); assert.equal(f.timers.size, 0); await f.advance(60000); assert.equal(f.calls.length, 1);
  if (action === 'suspend') {
    f.setRequest(async () => Response.json(config)); f.controller.resumeFromPageCache(); await flush();
    assert.equal(await f.controller.press(f.session), true);
  }
  f.controller.dispose();
});

test('inline repeated transient config failures cap retry cadence at 30 seconds', async () => {
  const f = fixture(true), times: number[] = [];
  f.setRequest(async () => {times.push(f.ports.now()); if (times.length === 1) throw Error('network'); return Response.json({}, {status: 503});});
  await f.controller.start(); await f.advance(91000);
  assert.deepEqual(times, [0, 1000, 3000, 7000, 15000, 31000, 61000, 91000]);
  assert.equal(await f.controller.press(f.session), false); f.controller.dispose();
  await flush(); assert.equal(f.timers.size, 0);
});

test('inline aborted config retry body cannot overwrite valid configuration after resume', async () => {
  const f = fixture(true), old = deferred<unknown>(); let calls = 0;
  f.setRequest(async () => {
    calls++;
    if (calls === 1) return Response.json({}, {status: 503});
    if (calls === 2) {const response = Response.json({}); response.json = () => old.promise; return response;}
    return Response.json(config);
  });
  await f.controller.start(); await f.advance(1000); assert.equal(calls, 2);
  f.controller.suspendForPageCache(); f.controller.resumeFromPageCache(); await flush();
  old.resolve({...config, enabled: false}); await flush(); assert.equal(calls, 3);
  assert.equal(await f.controller.press(f.session), true); f.controller.detach(f.session);
  await f.advance(60000); assert.equal(calls, 3); f.controller.dispose();
});

test('detached old cancellation cannot revoke a fresh capture through a late authentication refusal', async () => {
  const f = fixture(true), late = deferred<Response>(); let abandoned = false;
  await f.controller.start();
  f.setRequest(async path => {
    if (path === '/api/transcribe') throw Error('lost');
    if (path.endsWith('/cancel')) return abandoned ? late.promise : Response.json({}, {status: 503});
    return Response.json(f.job());
  });
  await f.record(); await f.advance(30000); abandoned = true;
  assert.equal(await f.controller.press(f.session), true);
  late.resolve(Response.json({}, {status: 401})); await flush();
  assert.equal(f.session.state, 'recording'); f.controller.detach(f.session);
  assert.equal(await f.controller.press(f.session), true); f.controller.dispose();
});
