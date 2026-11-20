// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHumanInputLease, createHumanInputScope, type HumanInputScope, type HumanInputTransport} from '../static/pane-actions.ts';
import {createDictationChannel} from '../static/dictation-channel.ts';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
function input(scope = createHumanInputScope()) {
  const controls: boolean[] = [], controlIds: string[] = [], frames: string[] = [];
  const transport = {control(id: string, dirty: boolean) {controlIds.push(id); controls.push(dirty);},
    data(bytes: Uint8Array) {frames.push(new TextDecoder().decode(bytes));}};
  const lease = createHumanInputLease({clientId: 'test-client', scope, ...transport});
  return {scope, lease, transport, controls, controlIds, frames};
}

// Reused by the controller's exact AC-4 top-level acceptance check.
export function assertOwnPendingInputGuards(): void {
  const f = input();
  assert.equal(f.lease.write(encode('existing')), true);
  assert.equal(f.lease.inputDirty, true);
  assert.equal(f.lease.claim(), null, 'legacy claims still require globally clean input');
  assert.equal(f.lease.canInsert(), true);
  const capture = f.lease.revision, claim = f.lease.claimInsertion(capture);
  assert.ok(claim);
  assert.equal(claim.write(encode('\x1b[200~bonjour\x1b[201~'), false, f.transport), true);
  assert.equal(f.lease.revision, capture + 1, 'one own frame advances the guarded revision once');
  assert.equal(claim.valid(), true);
  assert.equal(f.lease.dirty, true);
  assert.deepEqual(f.controls, [true], 'insertion/job completion never fabricates clean H');
  f.lease.write(encode('\x7f'));
  assert.equal(claim.valid(), false, 'own native editing invalidates the previous capture');
  assert.equal(f.lease.claimInsertion(capture), null, 'claim cannot resnapshot stale capture');
  assert.ok(f.lease.claimInsertion(f.lease.revision), 'deletion allows a distinct capture without clean H');
  assert.equal(f.lease.atomic(encode('\r')), true);
  assert.deepEqual(f.controls, [true, false], 'ordinary complete Enter remains separate');
  for (const complete of ['\x03', '\x04']) {
    f.lease.write(encode('pending'));
    f.lease.atomic(encode(complete));
    assert.equal(f.lease.dirty, false);
  }

  const foreign = input(f.scope);
  foreign.lease.write(encode('foreign'));
  assert.equal(f.lease.canInsert(), false);
  assert.equal(f.lease.claimInsertion(f.lease.revision), null);
  foreign.lease.atomic(encode('\r'));
  const unobserve = f.scope.observe(() => true);
  assert.equal(f.lease.canInsert(), false, 'unknown observers are a strict barrier');
  unobserve();
  for (const owner of [f, foreign]) {
    const snapshot = f.lease.revision;
    const queued = owner.lease.defer(encode('queued'), false);
    assert.equal(f.lease.canInsert(), false, 'even own deferred/replay input blocks insertion');
    queued.cancel();
    assert.equal(f.lease.claimInsertion(snapshot), null, 'cancelled reservation still invalidates capture');
  }
  const finalClaim = f.lease.claimInsertion(f.lease.revision)!;
  f.transport.control('protocol-only', true);
  assert.equal(finalClaim.valid(), true, 'protocol replies alone do not mutate input scope');
  f.scope.dispose();
  assert.equal(finalClaim.valid(), false);
  assert.equal(f.lease.canInsert(), false);

  const adopted = input(), old = adopted.lease;
  old.write(encode('pending')); old.retire();
  assert.equal(adopted.scope.adopt(adopted.transport), old, 'retired dirty lease adoption is unchanged');
  assert.equal(old.canInsert(), true);
}
test('inline input: own pending input and foreign lease guards', assertOwnPendingInputGuards);

function channelFixture(options: {scope?: HumanInputScope; insertionOnly?: boolean; held?: boolean} = {}) {
  const f = input(options.scope), mode = {value: true, valid: true, bytes() {}, dispose() {this.valid = false;}};
  const callbacks: (() => void)[] = [], seeds: string[] = [];
  let listener = (_frame: string): void => {}, pasteCalls = 0, releases = 0, live = true;
  let paste = (text: string): void => listener('\x1b[200~' + text.replace(/\n/g, '\r') + '\x1b[201~');
  const encoder = {write(text: string, done: () => void) {
    seeds.push(text); if (options.held) callbacks.push(done); else done();
  }, paste(text: string) {pasteCalls++; paste(text);},
  onData(callback: (frame: string) => void) {listener = callback; return {dispose() {}};}, dispose() {}};
  const socket = {send(_bytes: Uint8Array) {throw Error('must use retained lease transport');}};
  const pane = {}, target = {pane, id: 'A', name: 'A', sessionId: 'A', displayName: 'A', created: 1,
    view: 1, kind: 'mesh' as const, available: true, activeSensitive: false};
  const make = () => createDictationChannel({target, socket, lease: f.lease, encoder: () => encoder,
    valid: () => live, release: () => releases++, transport: f.transport, mode,
    insertionOnly: options.insertionOnly ?? true});
  return {...f, mode, callbacks, seeds, make, emit: (frame: string) => listener(frame),
    setPaste: (callback: (text: string) => void) => {paste = callback;},
    close: () => {live = false;}, counts: () => ({pasteCalls, releases})};
}

function reopenedInput() {
  const controls: [string, boolean][] = [], frames: string[] = [];
  const transport: HumanInputTransport = {control(id, dirty) {controls.push([id, dirty]);},
    data(bytes) {frames.push(new TextDecoder().decode(bytes));}};
  return {transport, controls, frames};
}

for (const initialDirty of [false, true]) test(`inline handoff: retained ${initialDirty ? 'own-dirty' : 'clean'} lease adopts before late original paste`, () => {
  const f = channelFixture({held: true}), reopened = reopenedInput();
  if (initialDirty) f.lease.write(encode('existing'));
  const original = f.make(), captureRevision = f.lease.revision;
  f.lease.retire();
  assert.equal(f.lease.retained, 1); assert.equal(f.lease.retired, true);
  assert.equal(f.scope.adopt(reopened.transport), null, 'default adoption still excludes retained leases');
  const adopted = f.scope.adopt(reopened.transport, {retained: true});
  assert.equal(adopted, f.lease, 'explicit reopen reuses the exact object, not only client ID');
  assert.ok(adopted); assert.equal(adopted.retired, false);
  assert.equal(adopted.revision, captureRevision, 'handoff itself is not human input');
  assert.equal(adopted.retained, 1); assert.equal(adopted.canInsert(), true);
  adopted.reconnect();
  assert.deepEqual(reopened.controls, [['test-client', initialDirty]], 'first new H carries the original identity');
  assert.deepEqual(reopened.frames, []);
  assert.equal(original.captureFresh?.(), true); assert.equal(original.claim(), true);
  const results: string[] = [];
  original.deliver('late original', result => results.push(result.kind), () => true);
  assert.deepEqual(results, []); f.callbacks[0]!();
  assert.deepEqual(results, ['paste']);
  assert.deepEqual(f.frames, [...(initialDirty ? ['existing'] : []), '\x1b[200~late original\x1b[201~']);
  assert.deepEqual(reopened.frames, [], 'late dictation still uses only its explicit original transport');
  assert.deepEqual(f.controlIds, ['test-client']);
  assert.deepEqual(f.controls, [true], 'late completion never cleans H');
  assert.equal(adopted.dirty, true); assert.equal(adopted.canInsert(), true);
  assert.ok(adopted.claimInsertion(adopted.revision), 'new owner can capture with the same own dirty input');
  original.release(); original.release();
  assert.equal(adopted.retained, 0); assert.equal(adopted.retired, false);
  assert.equal(adopted.canInsert(), true, 'old job release cannot remove the active ordinary owner');
  assert.equal(adopted.write(encode('manual edit')), true);
  assert.deepEqual(reopened.frames, ['manual edit'], 'ordinary writes use only the user-opened transport');
  assert.equal(f.frames.length, initialDirty ? 2 : 1);
});

test('inline handoff: new ordinary input revokes both claimed and unclaimed original captures', () => {
  for (const claimBeforeReopen of [false, true]) {
    const f = channelFixture(), reopened = reopenedInput(), original = f.make();
    if (claimBeforeReopen) assert.equal(original.claim(), true);
    f.lease.retire();
    const adopted = f.scope.adopt(reopened.transport, {retained: true});
    assert.ok(adopted); adopted.reconnect();
    const capture = adopted.revision;
    assert.equal(adopted.write(encode('new human edit')), true);
    assert.equal(adopted.revision, capture + 1);
    assert.equal(original.captureFresh?.(), false); assert.equal(original.claim(), false);
    const results: string[] = [];
    original.deliver('stale original', result => results.push(result.kind), () => true);
    assert.deepEqual(results, ['refused']); assert.deepEqual(f.frames, []);
    assert.deepEqual(reopened.frames, ['new human edit']);
    assert.equal(adopted.canInsert(), true);
    original.release(); assert.equal(adopted.retired, false); assert.equal(adopted.canInsert(), true);
  }
});

test('inline handoff: adoption does not replace original mode or revive revoked original transport', () => {
  for (const revoke of ['mode', 'socket'] as const) {
    const f = channelFixture({held: true}), reopened = reopenedInput(), original = f.make();
    f.lease.retire();
    const adopted = f.scope.adopt(reopened.transport, {retained: true});
    assert.ok(adopted); adopted.reconnect(); assert.equal(original.claim(), true);
    const results: string[] = [];
    original.deliver('late original', result => results.push(result.kind), () => true);
    if (revoke === 'mode') f.mode.value = false; else f.close();
    f.callbacks[0]!(); f.callbacks[0]!();
    assert.deepEqual(results, ['refused']); assert.deepEqual(f.frames, []); assert.deepEqual(reopened.frames, []);
    original.release();
    assert.equal(adopted.retained, 0); assert.equal(adopted.canInsert(), true);
    assert.equal(adopted.write(encode('new ordinary')), true);
    assert.deepEqual(reopened.frames, ['new ordinary'], 'new transport remains independent of the old channel revocation');
  }
});

test('inline handoff: old clean job release cannot dispose its adopted active owner', () => {
  let empty = 0;
  const scope = createHumanInputScope(() => empty++), f = channelFixture({scope}), reopened = reopenedInput();
  const original = f.make(); f.lease.retire();
  const adopted = scope.adopt(reopened.transport, {retained: true});
  assert.ok(adopted); assert.equal(adopted.dirty, false);
  original.release(); original.release();
  assert.equal(adopted.retained, 0); assert.equal(adopted.retired, false);
  assert.equal(empty, 0); assert.equal(adopted.canInsert(), true);
  assert.equal(adopted.write(encode('ordinary after old cleanup')), true);
  assert.deepEqual(reopened.controls, [['test-client', true]]);
  assert.deepEqual(reopened.frames, ['ordinary after old cleanup']); assert.deepEqual(f.frames, []);
});

test('inline handoff: opt-in preserves foreign/unknown/queued barriers and default adoption policy', () => {
  const f = input(), reopened = reopenedInput(), release = f.lease.retain();
  f.lease.write(encode('live foreign'));
  assert.equal(f.scope.adopt(reopened.transport, {retained: true}), null, 'never take over an unretired live owner');
  const other = input(f.scope);
  assert.notEqual(other.lease, f.lease);
  assert.deepEqual(other.controlIds, []);
  assert.equal(other.lease.canInsert(), false, 'identical client ID on a distinct object is still foreign');
  f.lease.retire();
  assert.equal(f.scope.adopt(reopened.transport, {retained: false}), null);
  assert.equal(f.scope.adopt(reopened.transport), null);
  const adopted = f.scope.adopt(reopened.transport, {retained: true});
  assert.equal(adopted, f.lease); assert.ok(adopted);
  assert.equal(f.scope.adopt(reopened.transport, {retained: true}), null, 'adopted owner is now live and cannot be re-adopted');
  const unobserve = f.scope.observe(() => true);
  assert.equal(adopted.canInsert(), false); unobserve();
  const deferred = adopted.defer(encode('queued'), false);
  assert.equal(adopted.canInsert(), false); deferred.cancel();
  other.lease.write(encode('different object, identical ID'));
  assert.equal(adopted.canInsert(), false);
  other.lease.atomic(encode('\r')); assert.equal(adopted.canInsert(), true); release();

  const legacy = input(), legacyReopened = reopenedInput();
  legacy.lease.write(encode('pending')); legacy.lease.retire();
  assert.equal(legacy.scope.adopt(legacyReopened.transport), legacy.lease, 'unretained retired dirty adoption is unchanged');
  const clean = input(), cleanRelease = clean.lease.retain(); clean.lease.retire();
  assert.equal(clean.scope.adopt(legacyReopened.transport), null);
  cleanRelease();
  assert.equal(clean.scope.adopt(legacyReopened.transport, {retained: true}), null, 'disposed clean owner cannot be revived');
});

test('inline channel: bracketed bytes only, no Enter timer, own dirty survives new capture', t => {
  const timer = t.mock.method(globalThis, 'setTimeout', () => {throw Error('native insertion must not schedule Enter');});
  const f = channelFixture(); f.lease.write(encode('existing'));
  for (const text of ['alpha\nbeta\ttab', 'suite A']) {
    const channel = f.make(), results: string[] = [];
    assert.equal(channel.valid(), true); assert.equal(channel.captureFresh?.(), true);
    assert.equal(channel.claim(), true);
    channel.deliver(text, result => results.push(result.kind), () => true);
    assert.deepEqual(results, ['paste']);
    assert.equal(f.lease.dirty, true);
    const before = f.frames.length;
    channel.deliver('must not replay', result => results.push(result.kind), () => true);
    assert.equal(f.frames.length, before);
    channel.release(); channel.release();
    assert.equal(f.lease.dirty, true);
  }
  assert.deepEqual(f.frames, ['existing', '\x1b[200~alpha\rbeta\ttab\x1b[201~', '\x1b[200~suite A\x1b[201~']);
  assert.deepEqual(f.controls, [true]); assert.equal(timer.mock.callCount(), 0);
  assert.equal(f.counts().releases, 2);
});

test('inline channel: capture revision is fixed at hold, not claim or delivery', () => {
  for (const kind of ['own', 'foreign', 'deferred'] as const) {
    const f = channelFixture(), channel = f.make();
    if (kind === 'own') f.lease.write(encode('\x7f'));
    if (kind === 'foreign') input(f.scope).lease.atomic(encode('\r'));
    if (kind === 'deferred') f.lease.defer(encode('queued'), false).cancel();
    assert.equal(channel.captureFresh?.(), false, kind);
    assert.equal(channel.claim(), false, kind);
    const results: string[] = [];
    channel.deliver('stale', result => results.push(result.kind), () => true);
    assert.deepEqual(results, ['refused']); channel.release();
  }
});

test('inline input: rejected human write and deferred attempts still invalidate retained captures', () => {
  for (const kind of ['write', 'defer'] as const) {
    const f = input(), release = f.lease.retain(), capture = f.lease.revision;
    const claim = f.lease.claimInsertion(capture)!;
    f.lease.retire();
    if (kind === 'write') assert.equal(f.lease.write(encode('attempt')), false);
    else assert.equal(f.lease.defer(encode('attempt'), false).flush(), false);
    assert.equal(claim.valid(), false, kind);
    assert.equal(f.lease.claimInsertion(capture), null, kind);
    assert.deepEqual(f.frames, []); release();
  }
});

test('inline channel: foreign, unknown and queued input block even an initially dirty owner', () => {
  for (const kind of ['foreign', 'unknown', 'own-queued', 'foreign-queued'] as const) {
    const f = channelFixture(); f.lease.write(encode('existing'));
    if (kind === 'foreign') input(f.scope).lease.write(encode('foreign'));
    if (kind === 'unknown') f.scope.observe(() => true);
    if (kind === 'own-queued') f.lease.defer(encode('queued'), false);
    if (kind === 'foreign-queued') input(f.scope).lease.defer(encode('queued'), false);
    const channel = f.make(), results: string[] = [];
    assert.equal(channel.valid(), false, kind); assert.equal(channel.claim(), false, kind);
    const before = f.frames.length;
    channel.deliver('safe', result => results.push(result.kind), () => true);
    assert.deepEqual(results, ['refused']); assert.equal(f.frames.length, before); channel.release();
  }
});

test('inline channel: fragmented framing and CR data preserve H and advance each frame once', () => {
  const f = channelFixture(), channel = f.make(), results: string[] = [];
  f.setPaste(() => {for (const frame of ['\x1b[200~', 'alpha', '\r', 'beta', '\x1b[201~']) f.emit(frame);});
  channel.claim(); const capture = f.lease.revision;
  channel.deliver('alpha\nbeta', result => results.push(result.kind), () => true);
  assert.deepEqual(results, ['paste']); assert.equal(f.lease.revision, capture + 5);
  assert.deepEqual(f.frames, ['\x1b[200~', 'alpha', '\r', 'beta', '\x1b[201~']);
  assert.deepEqual(f.controls, [true]); channel.release();
});

test('inline channel: disabled/invalid mode and prohibited transcript controls cause zero attempts', () => {
  for (const text of ['', '\x00', '\x08', '\r', '\x1b[201~', '\x7f', '\x80', '\x9f']) {
    const f = channelFixture(), channel = f.make(), results: string[] = [];
    channel.claim(); channel.deliver(text, result => results.push(result.kind), () => true);
    assert.deepEqual(results, ['refused'], JSON.stringify(text));
    assert.deepEqual(f.frames, []); assert.deepEqual(f.controls, []);
    assert.equal(f.counts().pasteCalls, 0); channel.release();
  }
  for (const invalidate of [(f: ReturnType<typeof channelFixture>) => {f.mode.value = false;},
    (f: ReturnType<typeof channelFixture>) => {f.mode.valid = false;},
    (f: ReturnType<typeof channelFixture>) => {f.close();}]) {
    const f = channelFixture(), channel = f.make(), results: string[] = [];
    channel.claim(); invalidate(f);
    channel.deliver('safe', result => results.push(result.kind), () => true);
    assert.deepEqual(results, ['refused']); assert.deepEqual(f.frames, []); channel.release();
  }
});

test('inline channel: late encoder callback rechecks mode, revision and release exactly once', () => {
  for (const invalidate of [(f: ReturnType<typeof channelFixture>) => {f.mode.value = false;},
    (f: ReturnType<typeof channelFixture>) => {f.lease.atomic(encode('\r'));},
    (_f: ReturnType<typeof channelFixture>, channel: ReturnType<ReturnType<typeof channelFixture>['make']>) => {channel.release();}]) {
    const f = channelFixture({held: true}), channel = f.make(), results: string[] = [];
    channel.claim(); channel.deliver('safe', result => results.push(result.kind), () => true);
    invalidate(f, channel);
    f.callbacks[0]!(); f.callbacks[0]!();
    assert.deepEqual(results, ['refused']); assert.equal(f.counts().pasteCalls, 0);
    assert.ok(f.seeds.length <= 3); channel.release();
  }
});

test('inline channel: per-frame mode/revision loss and transport throws are uncertain, never replayed', () => {
  for (const kind of ['mode', 'revision', 'transport', 'encoder'] as const) {
    const f = channelFixture(), channel = f.make(), results: string[] = [];
    if (kind === 'transport') f.transport.data = () => {throw Error('send may have queued bytes');};
    f.setPaste(() => {
      f.emit('\x1b[200~');
      if (kind === 'mode') f.mode.value = false;
      if (kind === 'revision') f.lease.atomic(encode('\x03'));
      if (kind === 'encoder') throw Error('encoder failed after a frame');
      f.emit('safe'); f.emit('\x1b[201~');
    });
    channel.claim(); channel.deliver('safe', result => results.push(result.kind), () => true);
    assert.deepEqual(results, ['uncertain'], kind);
    const before = f.frames.length; f.emit('late callback');
    channel.deliver('replay', () => {}, () => true);
    assert.equal(f.frames.length, before); channel.release();
  }
});

test('inline channel: reentrant H control revokes a first frame before its actual data attempt', () => {
  for (const kind of ['mode', 'revision'] as const) {
    const f = channelFixture(), channel = f.make(), results: string[] = [];
    const control = f.transport.control;
    f.transport.control = (id, dirty) => {
      control(id, dirty);
      if (kind === 'mode') f.mode.value = false;
      else f.scope.mutate();
    };
    channel.claim(); channel.deliver('safe', result => results.push(result.kind), () => true);
    assert.deepEqual(results, ['refused'], kind); assert.deepEqual(f.frames, []); channel.release();
  }
});

test('inline channel: native mode never accepts a plaintext encoder fallback', () => {
  const f = channelFixture(), channel = f.make(), results: string[] = [];
  f.setPaste(text => f.emit(text));
  channel.claim(); channel.deliver('safe', result => results.push(result.kind), () => true);
  assert.deepEqual(results, ['refused']); assert.deepEqual(f.frames, []); channel.release();
});

test('inline channel: pre-frame failure refuses, truncated or surplus framing is uncertain after an attempt', () => {
  for (const kind of ['guard', 'encoder', 'unclaimed', 'truncated', 'surplus'] as const) {
    const f = channelFixture(), channel = f.make(), results: string[] = [];
    f.setPaste(() => {
      if (kind === 'guard') f.mode.value = false;
      if (kind === 'encoder') throw Error('encoder failed before data');
      f.emit(kind === 'truncated' ? '\x1b[200~safe' : '\x1b[200~safe\x1b[201~');
      if (kind === 'surplus') f.emit('\r');
    });
    if (kind !== 'unclaimed') channel.claim();
    channel.deliver('safe', result => results.push(result.kind), () => true);
    const partial = kind === 'truncated' || kind === 'surplus';
    assert.deepEqual(results, [partial ? 'uncertain' : 'refused'], kind);
    if (!partial) assert.deepEqual(f.frames, []);
    else assert.equal(f.frames.length, 1);
    assert.equal(f.controls.includes(false), false); channel.release();
  }
});

test('inline channel: duplicate late readiness or a throw after readiness settles only once', () => {
  const f = channelFixture({held: true}), channel = f.make(), results: string[] = [];
  channel.claim(); channel.deliver('safe', result => {results.push(result.kind); throw Error('consumer failed');}, () => true);
  assert.throws(() => f.callbacks[0]!(), /consumer failed/);
  f.callbacks[0]!();
  assert.deepEqual(results, ['paste']); assert.equal(f.frames.length, 1); channel.release();
});

test('inline channel: throwing guards refuse before attempts and are uncertain after a frame', () => {
  for (const afterFrame of [false, true]) {
    const f = channelFixture(), channel = f.make(), results: string[] = [];
    let fail = !afterFrame;
    f.setPaste(() => {f.emit('\x1b[200~'); fail = true; f.emit('safe\x1b[201~');});
    channel.claim(); channel.deliver('safe', result => results.push(result.kind), () => {
      if (fail) throw Error('revoked guard'); return true;
    });
    assert.deepEqual(results, [afterFrame ? 'uncertain' : 'refused']);
    assert.equal(f.frames.length, afterFrame ? 1 : 0); channel.release();
  }
});
