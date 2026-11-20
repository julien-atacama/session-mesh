// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createHumanInputLease, createPasteDelivery} from '../static/pane-actions.ts';
import {createDictationChannel} from '../static/dictation-channel.ts';

const source = readFileSync('static/app.js', 'utf8');
function fixture() {
  const scheduled: (() => void)[] = [], frames: number[][] = [], results: any[] = [];
  const context = vm.createContext({MeshPaneActions: {createPasteDelivery}, enc: new TextEncoder(),
    paneTargets: {valid: () => true}, composeOwner: null, localTerminalSocketReady: () => true,
    localMeshEffectsAllowed: () => true, WebSocket: {OPEN: 1}, setTimeout: (fn: () => void) => scheduled.push(fn)});
  vm.runInContext(source.slice(source.indexOf('const paneInput = '), source.indexOf('const paneMenuHolds = ')), context);
  vm.runInContext(`class Pane {${source.slice(source.indexOf('  cancelReplayInput(c) {'), source.indexOf('  inputLeaseFor(name) {'))}}; globalThis.pane = new Pane();`, context);
  const pane = context.pane;
  pane.inputAcks = new Map();
  let fail = false;
  pane.conn = {ws: {send() {}}, terminal: {isOpen: () => true, isBound() {return this.isOpen();}}, replaying: true, closed: false};
  pane.inputLease = createHumanInputLease({clientId: 'human', control() {}, data(bytes) {
    if (!pane.conn.terminal.isOpen()) throw Error('known pre-open transport');
    if (fail) {fail = false; throw Error('one-shot D failure while still open');}
    frames.push([...bytes]);
  }});
  pane.term = {paste(text: string) {context.paneInput.onData(pane, text, () => pane.sendRaw(new TextEncoder().encode(text)));}};
  context.paneInput = vm.runInContext('paneInput', context);
  const binding = context.paneInput.capture(pane, {pane});
  return {pane, context, binding, scheduled, frames, results, fail: () => {fail = true;},
    deliver: () => context.paneInput.deliver(binding, 'prompt', true, (result: any) => results.push(result)),
    finishReplay: () => {pane.conn.replaying = false; pane.flushReplayInput(pane.conn);}};
}

test('definitely pre-open ordinary input refuses before creating a dirty lease or revision', () => {
  const f = fixture(), revision = f.pane.inputLease.revision;
  f.pane.conn.terminal.isOpen = () => false;
  assert.equal(f.pane.sendRaw(Uint8Array.of(97)), false);
  assert.equal(f.pane.inputLease.dirty, false);
  assert.equal(f.pane.inputLease.revision, revision);
  assert.deepEqual(f.frames, []);
});

test('replay paste and delayed Enter finish FIFO before queued Ctrl-C and later keys', () => {
  const f = fixture(); f.deliver();
  f.pane.sendRaw(Uint8Array.of(3), true);
  f.finishReplay();
  f.pane.sendRaw(Uint8Array.of(120));
  assert.deepEqual(f.frames, [[112, 114, 111, 109, 112, 116]], 'nothing overtakes the pending submission');
  for (const callback of f.scheduled.splice(0)) callback();
  assert.deepEqual(f.frames, [[112, 114, 111, 109, 112, 116], [13], [3], [120]]);
  assert.equal(f.results[0].kind, 'submitted');
});

test('idle acknowledged paste holds its reservation and uses acknowledged input', () => {
  const f = fixture();
  f.pane.conn.replaying = false;
  f.pane.inputAck = {version: 2};
  const acknowledged: number[][] = [];
  f.pane.sendAcknowledgedInput = (bytes: Uint8Array) => { acknowledged.push([...bytes]); return true; };
  f.deliver();
  for (const callback of f.scheduled.splice(0)) callback();
  assert.deepEqual(acknowledged, [[112, 114, 111, 109, 112, 116], [13]]);
  assert.deepEqual(f.frames, [], 'raw lease transport must never receive acknowledged paste');
  assert.equal(f.results[0].kind, 'submitted');
});

test('cancelling a running delayed submission releases unrelated future keys without a late Enter', () => {
  const f = fixture(), operation = f.deliver();
  f.pane.sendRaw(Uint8Array.of(3), true); f.finishReplay();
  operation.cancel();
  for (const callback of f.scheduled.splice(0)) callback();
  assert.deepEqual(f.frames, [[112, 114, 111, 109, 112, 116], [3]]);
  assert.equal(f.results[0].kind, 'uncertain');
  assert.equal(f.pane.inputLease.inputDirty, false);
});

test('physical paste failure preserves later user interruption without scheduling Enter or leaking the FIFO barrier', () => {
  const f = fixture(); f.deliver(); f.pane.sendRaw(Uint8Array.of(3), true);
  f.fail(); f.finishReplay();
  assert.deepEqual(f.frames, [[3]]); assert.equal(f.scheduled.length, 0);
  assert.equal(f.results[0].kind, 'uncertain'); assert.equal(f.pane.inputLease.inputDirty, false);
  assert.equal(f.pane.conn.activeHumanInput, null);
});

for (const replay of [false, true]) test(`upload path keeps its target until ${replay ? 'deferred' : 'immediate'} paste settlement`, () => {
  const f = fixture(); f.pane.conn.replaying = replay;
  let releases = 0;
  Object.assign(f.context, {composeUploads: [], uploadHolds: new Set(), endDirectLine() {}, renderComposeStatus() {}, renderReloadStatus() {},
    releasePickerDestination(destination: any) {releases++; destination.target.released = true;}});
  f.context.paneTargets.valid = (target: any) => !target.released;
  vm.runInContext(source.slice(source.indexOf('function abandonUploadRecord('), source.indexOf('function insertAtCursor(')), f.context);
  const record = {paths: '/uploaded/file', finalized: false, destination: {kind: 'terminal', target: f.binding.target, binding: f.binding},
    batch: {items: [{status: 'uploaded'}], complete: true, abandoned: false}};
  f.context.composeUploads.push(record);
  f.context.finishUploadRecord(record);
  if (replay) {assert.equal(releases, 0); f.finishReplay();}
  assert.equal((record as any).inserted, true); assert.equal((record as any).delivery?.kind, 'paste');
  assert.equal(releases, 1); assert.equal(f.context.composeUploads.length, 0);
  assert.deepEqual(f.frames, [[...new TextEncoder().encode('/uploaded/file ')]]);
});

test('failed deferred upload insertion retains truthful recovery metadata and releases its target', () => {
  const f = fixture(); let releases = 0;
  Object.assign(f.context, {composeUploads: [], uploadHolds: new Set(), endDirectLine() {}, renderComposeStatus() {}, renderReloadStatus() {},
    releasePickerDestination(destination: any) {releases++; destination.target.released = true;}});
  f.context.paneTargets.valid = (target: any) => !target.released;
  vm.runInContext(source.slice(source.indexOf('function abandonUploadRecord('), source.indexOf('function insertAtCursor(')), f.context);
  const record = {paths: '/uploaded/file', finalized: false, destination: {kind: 'terminal', target: f.binding.target, binding: f.binding},
    batch: {items: [{status: 'uploaded'}], complete: true, abandoned: false}};
  f.context.composeUploads.push(record); f.context.finishUploadRecord(record); f.fail(); f.finishReplay();
  assert.equal((record as any).inserted, false); assert.equal((record as any).delivery.kind, 'uncertain');
  assert.equal((record as any).delivery.reason, 'send'); assert.equal(record.paths, '/uploaded/file');
  assert.equal(f.context.composeUploads[0], record); assert.equal(releases, 1);
  assert.equal(f.context.uploadHolds.size, 0); assert.deepEqual(f.frames, []);
});

test('a closed composer cannot begin its queued paste before the asynchronous close event retires its target', () => {
  const f = fixture();
  f.context.composeOwner = {target: f.binding.target, open: true}; f.context.cdlg = {open: true};
  f.deliver(); f.context.cdlg.open = false; f.finishReplay();
  assert.deepEqual(f.frames, []); assert.equal(f.results[0].kind, 'refused');
  assert.equal(f.pane.conn.activeHumanInput, null);
});

test('Direct paste refuses replay before enqueue, retaining the field and Direct context for retry', () => {
  const f = fixture(); let released = 0;
  f.pane.sendRaw(Uint8Array.of(47));
  Object.assign(f.context, {directInputCount: 0, directFieldAttempt: 0, lineRecovery: null, lineDirect: {pane: f.pane}, line: {value: 'clipboard text'},
    fitLine() {}, reportDirect() {}, endDirectLine() {f.context.lineDirect = null;}, MeshPaneActions: {directInput: () => 'multiline'}});
  f.context.paneTargets.capture = () => ({}); f.context.paneTargets.release = () => {released++;};
  f.pane.term.modes = {bracketedPasteMode: true};
  vm.runInContext(source.slice(source.indexOf('function pasteDirect('), source.indexOf('// Ctrl armed: the letter')), f.context);
  vm.runInContext(source.slice(source.indexOf('function recoverDirectText('), source.indexOf('// The field changed and no composition')), f.context);
  assert.equal(f.context.flushDirectField('insertFromPaste'), false);
  assert.equal(f.context.line.value, 'clipboard text'); assert.ok(f.context.lineDirect);
  assert.equal(released, 0); assert.equal(f.pane.conn.queuedHumanInput?.length, 1, 'only the original slash is queued');
  f.finishReplay(); assert.deepEqual(f.frames, [[47]]);
  assert.equal(f.context.flushDirectField('insertFromPaste'), true);
  assert.equal(f.context.line.value, ''); assert.ok(f.context.lineDirect);
  assert.deepEqual(f.frames, [[47], [...new TextEncoder().encode('clipboard text')]]);
  assert.equal(released, 1); assert.equal(f.scheduled.length, 0, 'Direct paste never invents Enter');
});

for (const [kind, reason] of [
  ['replacement', 'line.directReplacement'],
  ['refused', 'line.directRefused'],
  ['multiline', 'line.directNoBracket'],
]) test(`an immediate Direct ${kind} refusal recovers the field without sending input`, () => {
  const f = fixture(), messages: [string, boolean][] = [];
  f.pane.conn.replaying = false; f.pane.term.modes = {bracketedPasteMode: false};
  Object.assign(f.context, {directInputCount: 0, directFieldAttempt: 0, lineRecovery: null, lineDirect: {pane: f.pane, session: 'A'}, line: {value: 'refused field text'},
    fitLine() {}, renderLineStatus() {}, t: (key: string) => key, endDirectLine() { f.context.lineDirect = null; }, reportDirect(message: string, held: boolean) {messages.push([message, held]);},
    MeshPaneActions: {directInput: () => kind}});
  vm.runInContext(source.slice(source.indexOf('function pasteDirect('), source.indexOf('// Ctrl armed: the letter')), f.context);
  vm.runInContext(source.slice(source.indexOf('function recoverDirectText('), source.indexOf('// The field changed and no composition')), f.context);
  assert.equal(f.context.flushDirectField('input', true), false);
  assert.equal(f.context.line.value, '', 'refused text cannot be sent by a later key');
  assert.equal(f.context.lineDirect, null); assert.equal(f.context.lineRecovery.text, 'refused field text');
  assert.equal(f.context.lineRecovery.target.displayName, 'A'); assert.deepEqual(f.frames, []);
  assert.deepEqual(messages, [[reason, true]], 'both the refusal reason and the rejected key are reported');
});

test('cancelling a completed upload awaiting replay releases its captured target exactly once', () => {
  const f = fixture(); let releases = 0;
  Object.assign(f.context, {composeUploads: [], uploadHolds: new Set(), endDirectLine() {}, renderComposeStatus() {}, renderReloadStatus() {},
    releasePickerDestination(destination: any) {releases++; destination.target.released = true;}});
  f.context.paneTargets.valid = (target: any) => !target.released;
  vm.runInContext(source.slice(source.indexOf('function abandonUploadRecord('), source.indexOf('function insertAtCursor(')), f.context);
  const record = {paths: '/uploaded/file', finalized: false, destination: {kind: 'terminal', target: f.binding.target, binding: f.binding},
    batch: {items: [{status: 'uploaded'}], complete: true, abandoned: false, abandon: () => false}};
  f.context.composeUploads.push(record); f.context.finishUploadRecord(record);
  f.context.abandonUploadRecord(record); f.context.abandonUploadRecord(record); f.finishReplay();
  assert.deepEqual(f.frames, []); assert.equal(releases, 1); assert.equal(f.context.uploadHolds.size, 0);
  assert.equal((record as any).delivery.kind, 'refused'); assert.equal((record as any).inserted, false);
});
for (const timerFirst of [false, true]) test(`deferred paste failure cannot submit when replay ends ${timerFirst ? 'after' : 'before'} the Enter delay`, () => {
  const f = fixture(); f.deliver();
  assert.deepEqual(f.results, [], 'a queued operation cannot report submission');
  if (timerFirst) for (const callback of f.scheduled.splice(0)) callback();
  f.fail(); f.finishReplay();
  for (const callback of f.scheduled.splice(0)) callback();
  assert.deepEqual(f.frames, [], 'no Enter after the failed physical paste');
  assert.equal(f.results.length, 1);
  assert.equal(f.results[0].kind, 'uncertain');
  assert.equal(f.results[0].reason, 'send');
});

test('cancelling the whole deferred paste prevents text and Enter', () => {
  const f = fixture(), operation = f.deliver(); operation.cancel();
  f.finishReplay();
  for (const callback of f.scheduled.splice(0)) callback();
  assert.deepEqual(f.frames, []); assert.equal(f.results[0].kind, 'refused');
});

test('successful deferred paste reserves native authority and reports submission only after physical Enter', () => {
  const f = fixture(), claim = f.pane.inputLease.claim();
  assert.ok(claim); f.deliver();
  assert.equal(claim.valid(), false); assert.equal(f.pane.inputLease.inputDirty, true);
  assert.equal(f.scheduled.length, 0); assert.deepEqual(f.frames, []);
  f.finishReplay();
  assert.deepEqual(f.frames, [[112, 114, 111, 109, 112, 116]]); assert.deepEqual(f.results, []);
  for (const callback of f.scheduled.splice(0)) callback();
  assert.deepEqual(f.frames.at(-1), [13]); assert.equal(f.results[0].kind, 'submitted');
  assert.equal(f.pane.inputLease.inputDirty, false);
});

test('ended queue cancellation settles once without flushing queued text, keys or Enter', () => {
  const f = fixture(), c = f.pane.conn;
  f.deliver(); f.pane.sendRaw(Uint8Array.of(120)); f.pane.sendRaw(Uint8Array.of(13), true);
  c.ended = true;
  f.pane.cancelReplayInput(c); f.pane.cancelReplayInput(c); f.finishReplay();
  for (const callback of f.scheduled) callback();
  assert.equal(f.results.length, 1); assert.equal(f.results[0].kind, 'refused');
  assert.equal(f.pane.inputLease.inputDirty, false); assert.deepEqual(f.frames, []);
});

test('ended running submission cancellation stays uncertain and never sends its delayed Enter', () => {
  const f = fixture(), c = f.pane.conn;
  f.deliver(); f.finishReplay(); assert.equal(f.scheduled.length, 1);
  c.ended = true; f.pane.cancelReplayInput(c);
  for (const callback of f.scheduled) callback();
  assert.equal(f.results.length, 1); assert.equal(f.results[0].kind, 'uncertain');
  assert.deepEqual(f.frames, [[...new TextEncoder().encode('prompt')]]);
});

test('old queue cancellation releases its original reservation, not new-incarnation lease authority', () => {
  const f = fixture(), old = f.pane.conn, originalLease = f.pane.inputLease;
  f.deliver();
  const next = createHumanInputLease({clientId: 'new-incarnation', control() {}, data() {throw Error('must not send');}});
  const claim = next.claim()!, revision = next.revision;
  f.pane.inputLease = next;
  f.pane.conn = {ws: {}, terminal: {isOpen: () => true}, replayPending: true};
  f.pane.cancelReplayInput(old);
  assert.equal(claim.valid(), true); assert.equal(next.revision, revision); assert.equal(next.inputDirty, false);
  assert.equal(originalLease.inputDirty, false); assert.deepEqual(f.frames, []);
});

test('old closed callback cannot cancel a replacement queue after awaited inventory', async () => {
  const f = fixture(), c = f.pane.conn;
  f.deliver();
  let release!: () => void;
  Object.assign(f.context, {c, name: 'A', version: 0, openedThisAttempt: false, clearTimeout() {}, lineDirect: null, data: {mesh: []}, t: (key: string) => key,
    refresh: () => new Promise<void>(resolve => {release = resolve;}),
    current: (terminal: any) => f.pane.conn === c && c.terminal === terminal && !c.closed});
  f.pane.leaveReplayGeometry = () => {};
  f.pane.renderRetainedInput = () => {};
  let cancellations = 0;
  const cancel = f.pane.cancelReplayInput.bind(f.pane);
  f.pane.cancelReplayInput = (connection: any) => {cancellations++; cancel(connection);};
  const marker = '        closed: async (terminal) => {';
  const start = source.indexOf(marker) + marker.length;
  const end = source.indexOf('\n        },\n      },', start);
  const closed = vm.runInContext(`(async function(terminal) {${source.slice(start, end)}\n})`, f.context);
  const pending = closed.call(f.pane, c.terminal);
  assert.equal(cancellations, 1, 'the closing socket is settled before inventory returns');
  assert.equal(f.results[0].kind, 'refused');
  cancel(c); // Replacement attach detaches and settles its predecessor first.
  const next = createHumanInputLease({clientId: 'replacement', control() {}, data() {throw Error('unexpected new D');}});
  f.pane.inputLease = next;
  const reservation = next.defer(Uint8Array.of(120), false);
  f.pane.conn = {ws: {}, terminal: {isOpen: () => true}, replayPending: true, queuedHumanInput: [{input: reservation}]};
  const revision = next.revision;
  release(); await pending;
  assert.equal(cancellations, 1); assert.equal(next.revision, revision); assert.equal(next.inputDirty, true);
  assert.equal(f.pane.conn.queuedHumanInput.length, 1); reservation.cancel();
});

for (const prefix of [null, 'reset']) test(`obsolete replay callback cannot flush a current socket (${prefix ?? 'alternate screen'})`, () => {
  const callbacks: (() => void)[] = [];
  let flushes = 0;
  const context = vm.createContext({MeshPaneActions: {replayPrefix: () => prefix}, prefixedBytes: () => new Uint8Array(), renderInlineDictation() {}});
  vm.runInContext(`class Pane {${source.slice(source.indexOf('  writeReplay(c, bytes, stillCurrent) {'), source.indexOf('  // A real size change and back:'))}}; globalThis.pane = new Pane();`, context);
  const pane = context.pane, c = {terminal: {replayMode() {}}};
  pane.output = (_bytes: unknown, done: () => void) => callbacks.push(done);
  pane.flushReplayInput = () => {flushes++;}; pane.resumeFollowing = pane.enterReplayGeometry = pane.leaveReplayGeometry = () => {};
  pane.writeReplay(c, new Uint8Array(), () => false);
  pane.writeReplay(c, new Uint8Array(), () => true);
  callbacks[0]!();
  assert.equal((c as any).replaying, true); assert.equal(flushes, 0);
  callbacks[1]!();
  assert.equal((c as any).replaying, false); assert.equal(flushes, 1);
});
test('a pane header updates dictation presentation for only that pane, not every column', () => {
  const queries = [0, 0, 0], panes = queries.map((_count, index) => ({id: String(index), conn: null, el: {querySelector() {
    queries[index]++; return {dataset: {}};
  }}}));
  const context = vm.createContext({panes, find: () => ({kind: 'mesh'}), inlineDictation: null});
  vm.runInContext(source.slice(source.indexOf('function renderInlineDictation('), source.indexOf('function renderComposeStatus(')), context);
  context.renderDictationBadges(panes[1]);
  assert.deepEqual(queries, [0, 3, 0]);
  assert.match(source.slice(source.indexOf('  header() {'), source.indexOf('  remember(nextId) {')), /renderDictationBadges\(this\)/);
});
test('detaching another column showing the same session does not cancel the held capture', () => {
  const session = {}, original = {conn: {name: 'A', created: 1}}, other = {conn: {name: 'A', created: 1}};
  const contexts = new WeakMap([[session, {pane: original, connection: original.conn}]]);
  let cancelled = 0, detached = 0;
  const context = vm.createContext({inlineContexts: contexts, inlineDictation: {peekSession: () => session, detach: () => detached++},
    inlineDictationView: {cancel: () => cancelled++}});
  vm.runInContext(source.slice(source.indexOf('function cancelInlineCapture('), source.indexOf('function startInlineDictation(')), context);
  context.cancelInlineCapture(other);
  assert.equal(cancelled, 0); assert.equal(detached, 0);
  context.cancelInlineCapture(original);
  assert.equal(cancelled, 1); assert.equal(detached, 1);
});

test('encoder constructor/open failures remove the private DOM host and dispose acquired terminals', () => {
  for (const phase of ['constructor', 'open']) {
    let removed = 0, disposed = 0;
    const context = vm.createContext({document: {body: {append() {}},
      createElement: () => ({setAttribute() {}, remove() {removed++;}})}, Terminal: class {
        constructor() {if (phase === 'constructor') throw Error('construction failed');}
        open() {throw Error('open failed');} dispose() {disposed++;}
      }});
    vm.runInContext(source.slice(source.indexOf('function createDictationEncoder('), source.indexOf('function reportDictationInventory(')), context);
    assert.throws(() => context.createDictationEncoder(), /failed/);
    assert.equal(removed, 1); assert.equal(disposed, phase === 'open' ? 1 : 0);
  }
});

for (const phase of ['append', 'dispose']) test(`encoder ${phase} failure still removes its host exactly once`, () => {
  let removed = 0, disposed = 0;
  const context = vm.createContext({document: {body: {append() {if (phase === 'append') throw Error('append failed');}},
    createElement: () => ({setAttribute() {}, remove() {removed++;}})}, Terminal: class {
      open() {} dispose() {disposed++; throw Error('dispose failed');}
    }});
  vm.runInContext(source.slice(source.indexOf('function createDictationEncoder('), source.indexOf('function reportDictationInventory(')), context);
  if (phase === 'append') assert.throws(() => context.createDictationEncoder(), /append failed/);
  else {
    const encoder = context.createDictationEncoder(); assert.throws(() => encoder.dispose(), /dispose failed/);
    assert.doesNotThrow(() => encoder.dispose(), 'disposal is idempotent even when the first call throws');
  }
  assert.equal(removed, 1); assert.equal(disposed, phase === 'dispose' ? 1 : 0);
});

function channelSetupFixture(touch: boolean, failure: string) {
  const counts = {target: 0, terminal: 0, lease: 0};
  const lease = {revision: 0, inputDirty: false, canInsert: () => true, retain() {
    if (failure === 'lease') throw Error('lease retain failed');
    return () => {counts.lease++;};
  }};
  const terminal = {isOpen: () => true, retain() {
    if (failure === 'retain') throw Error('terminal retain failed');
    return () => {counts.terminal++;};
  }, get dictationMode() {
    if (failure === 'mode') throw Error('mode lookup failed');
    return {valid: true, value: true};
  }};
  const pane = {conn: {terminal, ws: {}}, inputLease: lease}, session = {name: 'A', created: 1};
  const context = vm.createContext({touch, lineRevision: 0, inlineContextReason: () => '',
    inlineContexts: new WeakMap([[session, {pane, connection: pane.conn, lease}]]),
    composeOwner: {target: {name: 'A', created: 1, pane}},
    paneTargets: {capture: () => ({}), release() {counts.target++; if (failure === 'release') throw Error('target release failed');}},
    createDictationEncoder: () => ({onData: () => ({dispose() {}}), dispose() {}}),
    MeshPaneActions: {createDictationChannel}});
  for (const [start, end] of [['retainInlinePhonePrompt', 'retainInlineChannel'], ['retainInlineChannel', 'inlineInsertionFinished']]) {
    vm.runInContext(source.slice(source.indexOf(`function ${start}(`), source.indexOf(`function ${end}(`)), context);
  }
  return {counts, context, session};
}

for (const [touch, failure] of [[false, 'retain'], [true, 'retain'], [true, 'lease'], [false, 'mode']] as const) {
  test(`${touch ? 'phone' : 'native'} app channel rolls back pre-factory ${failure} failure`, () => {
    const f = channelSetupFixture(touch, failure);
    assert.throws(() => f.context.retainInlineChannel(f.session), /failed/);
    assert.deepEqual(f.counts, {target: 1, terminal: failure === 'retain' ? 0 : 1, lease: 0});
  });
}
for (const touch of [false, true]) test(`${touch ? 'phone' : 'native'} app channel releases every reference when target release throws`, () => {
  const f = channelSetupFixture(touch, 'release'), channel = f.context.retainInlineChannel(f.session);
  assert.doesNotThrow(() => channel.release()); assert.doesNotThrow(() => channel.release());
  assert.deepEqual(f.counts, {target: 1, terminal: 1, lease: 1});
});
test('inline header marks recording only after permission and recorder startup', () => {
  const attributes = new Map<string,string>(), button = {setAttribute(key: string,value: string) {attributes.set(key,value);}};
  const status = {id: 'native-status', dataset: {}}, session = {state: 'requesting'};
  const pane = {id: 'A',conn: {name: 'A',created: 1},el: {querySelector(selector: string) {return selector.includes('dictate') ? button : status;}}};
  const context = vm.createContext({panes: [pane],touch: false,t: (key: string) => key,
    find: () => ({kind: 'mesh'}),inlineContext: () => ({}),inlineContextReason: () => '',inlineContexts: new WeakMap(),
    inlineStateLabel: () => '',inlineReasonText: () => '',inlineDictation: {
      holds: () => [session],session: () => session,reason: () => '',disabledReason: () => null}});
  vm.runInContext(source.slice(source.indexOf('function renderInlineDictation('),source.indexOf('function renderDictationBadges(')),context);
  context.renderInlineDictation();
  assert.equal(attributes.get('aria-pressed'),'false','permission-pending is not recording');
  assert.equal(attributes.get('aria-disabled'),'false','the pending hold remains cancellable');
  assert.equal(attributes.get('aria-describedby'), 'native-status');
  session.state = 'recording'; context.renderInlineDictation(); assert.equal(attributes.get('aria-pressed'),'true');
  session.state = 'idle'; context.renderInlineDictation(); assert.equal(attributes.get('aria-pressed'),'false');
});
