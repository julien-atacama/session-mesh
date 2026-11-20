// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createHumanInputLease, createHumanInputScope, replayPrefix} from '../static/pane-actions.ts';
import {createDictationChannel} from '../static/dictation-channel.ts';
import type {CapturedTarget} from '../static/pane-actions.ts';

test('queued human input invalidates a native claim before its physical write', () => {
  const frames: number[][] = [];
  const lease = createHumanInputLease({clientId: 'human', control() {}, data: bytes => frames.push([...bytes])});
  const native = lease.claim()!;
  const revision = lease.revision;
  const queued = lease.defer(Uint8Array.of(97), false);
  assert.deepEqual(frames, []);
  assert.ok(lease.revision > revision);
  assert.equal(lease.inputDirty, true);
  assert.equal(native.valid(), false);
  assert.equal(lease.claim(), null);
  assert.equal(queued.flush(), true);
  assert.equal(queued.flush(), false);
  assert.deepEqual(frames, [[97]]);
  assert.equal(lease.dirty, true);
  lease.atomic(Uint8Array.of(13));
  assert.equal(lease.inputDirty, false);
});

test('retired replay input can be cancelled without sending it to a later socket', () => {
  let writes = 0, replacementWrites = 0;
  const scope = createHumanInputScope();
  const lease = createHumanInputLease({clientId: 'old', scope, control() {}, data() {writes++;}});
  const release = lease.retain();
  const queued = lease.defer(Uint8Array.of(97), false);
  lease.retire();
  assert.equal(scope.adopt({control() {}, data() {replacementWrites++;}}, {retained: true}), lease);
  queued.cancel(); queued.cancel();
  assert.equal(queued.flush(), false);
  assert.equal(writes, 0);
  assert.equal(replacementWrites, 0);
  assert.equal(lease.inputDirty, false);
  release();
});

test('queued human input revokes captureFresh and an already-claimed dictation before encoder readiness', () => {
  let prepare = () => {}, writes = 0;
  const transport = {control() {}, data() {writes++;}};
  const lease = createHumanInputLease({clientId: 'original', ...transport});
  const channel = createDictationChannel({target: {} as CapturedTarget, socket: {send() {}},
    lease, transport, valid: () => true, release() {},
    mode: {value: true, valid: true, bytes() {}, dispose() {}},
    encoder: () => ({write: (_text, done) => {prepare = done;}, paste() {throw Error('must not paste');},
      onData: () => ({dispose() {}}), dispose() {}})});
  assert.equal(channel.captureFresh!(), true);
  assert.equal(channel.claim(), true);
  const results: string[] = [];
  channel.deliver('spoken', result => results.push(result.kind), () => true);
  const queued = lease.defer(Uint8Array.of(97), false);
  assert.equal(writes, 0);
  assert.equal(channel.captureFresh!(), false);
  assert.equal(channel.valid(), false);
  prepare();
  assert.deepEqual(results, ['refused']);
  assert.equal(writes, 0);
  queued.cancel(); channel.release();
});

test('mode observer follows the reset and reseeded modes of a reconnection replay', async () => {
  const {createDictationModeObserver} = await import('../static/terminal-mode.ts');
  const sandbox = {exports: {} as any, module: {exports: {} as any}, self: {}, process, setTimeout, clearTimeout};
  vm.runInNewContext(readFileSync('static/vendor/xterm.min.js', 'utf8'), sandbox);
  const Terminal = sandbox.exports.Terminal || sandbox.module.exports.Terminal;
  const term = new Terminal();
  await new Promise<void>(resolve => term.write('\x1b[?2004h', resolve));
  const mode = createDictationModeObserver(false, term);
  assert.equal(mode.value, false, 'observer deliberately disagrees with xterm before reseeding');
  const prefix = replayPrefix(term, true)!;
  mode.bytes(new TextEncoder().encode(prefix));
  assert.equal(mode.valid, true);
  assert.equal(mode.value, true);
  mode.bytes(new TextEncoder().encode('\x1b[?2004l'));
  assert.equal(mode.value, false);
  mode.dispose(); term.dispose();
});

test('a reset separately clears an already enabled mode observer', async () => {
  const {createDictationModeObserver} = await import('../static/terminal-mode.ts');
  const mode = createDictationModeObserver(true);
  assert.equal(mode.value, true);
  mode.bytes(new TextEncoder().encode('\x1bc'));
  assert.equal(mode.valid, true); assert.equal(mode.value, false);
  mode.dispose();
});
