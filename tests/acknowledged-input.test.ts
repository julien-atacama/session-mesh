// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAcknowledgedInput, terminalReportsOnly } from "../static/pane-actions.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
test('tracked dictation input settles only on exact native ACK and never uses a queued actor', () => {
  const sent: Uint8Array[] = [], settled: boolean[] = [];
  const input = createAcknowledgedInput({version: 2, created: 42, send: frame => sent.push(frame), state: () => {}});
  assert.equal(input.writeTracked(bytes('dictated'), false, ok => settled.push(ok)), false);
  assert.equal(input.connectV2(42, 1, 1, 'a'.repeat(32), true), true);
  assert.equal(input.writeTracked(bytes('dictated'), false, ok => settled.push(ok)), true);
  assert.equal(sent.length, 1); assert.deepEqual([...sent[0]!.subarray(4)], [...bytes('dictated')]);
  assert.deepEqual(settled, []);
  assert.equal(input.writeTracked(bytes('later'), false, ok => settled.push(ok)), false);
  input.ackV2(42, 2, 1, 1, true);
  assert.deepEqual(settled, [false], 'wrong actor receipt cannot confirm insertion');
  input.ackV2(42, 1, 1, 1, true);
  assert.deepEqual(settled, [false], 'late matching receipt cannot reverse uncertainty');
  assert.equal(sent.length, 1);
});
test('tracked dictation input confirms exactly once on the matching ACK', () => {
  const settled: boolean[] = [], input = createAcknowledgedInput({
    version: 2, created: 42, send: () => {}, state: () => {}});
  input.connectV2(42, 1, 1, 'b'.repeat(32), true);
  assert.equal(input.writeTracked(bytes('draft'), false, ok => settled.push(ok)), true);
  assert.deepEqual(settled, []);
  input.ackV2(42, 1, 1, 1, true);
  input.ackV2(42, 1, 1, 1, true);
  assert.deepEqual(settled, [true]);
});
test('tracked dictation input aborts on lost original binding without automatic replay', () => {
  const sent: Uint8Array[] = [], settled: boolean[] = [];
  const input = createAcknowledgedInput({version: 2, created: 42, send: frame => sent.push(frame), state: () => {}});
  input.connectV2(42, 1, 1, 'c'.repeat(32), true);
  assert.equal(input.writeTracked(bytes('draft'), false, ok => settled.push(ok)), true);
  input.disconnect();
  assert.deepEqual(settled, [false]);
  input.connectV2(42, 1, 1, 'c'.repeat(32), true);
  assert.equal(sent.length, 1);
  assert.equal(input.writeTracked(bytes('other'), false, ok => settled.push(ok)), false);
});
test('locally retained input never transmits on reconnect without an explicit retry', () => {
  const frames: Uint8Array[] = [];
  const input = createAcknowledgedInput({version: 2, created: 42, send: frame => frames.push(frame), state: () => {}});
  const nonce = 'a'.repeat(32);
  assert.equal(input.connectV2(42, 1, 1, nonce, true), true);
  assert.equal(input.retain(bytes('held')), true);
  assert.equal(input.state, 'review');
  assert.equal(input.retainedText, 'held');
  assert.equal(frames.length, 0);
  assert.equal(input.connectV2(42, 1, 1, nonce, true), true);
  assert.equal(frames.length, 0);
  assert.equal(input.retry(), true);
  assert.equal(frames.length, 1);
});
test('retaining while an ACK is in flight does not send later bytes on a late receipt', () => {
  const frames: Uint8Array[] = [];
  const input = createAcknowledgedInput({version: 2, created: 42, send: frame => frames.push(frame), state: () => {}});
  const nonce = 'b'.repeat(32);
  assert.equal(input.connectV2(42, 2, 1, nonce, true), true);
  assert.equal(input.write(bytes('first')), true);
  assert.equal(input.retain(bytes('second')), true);
  assert.equal(input.state, 'uncertain');
  input.ackV2(42, 2, 1, 1, true);
  assert.equal(frames.length, 1);
  assert.equal(input.retainedText, 'firstsecond');
  assert.equal(input.connectV2(42, 2, 1, nonce, true), true);
  assert.equal(frames.length, 1);
  assert.equal(input.state, 'uncertain');
});
test('a late receipt after reconnect cannot send review-only input', () => {
  for (const version of [1, 2] as const) {
    const frames: Uint8Array[] = [];
    const id = 'actor';
    const nonce = 'c'.repeat(32);
    const input = createAcknowledgedInput({version, attachmentId: id, created: 42,
      send: frame => frames.push(frame), state: () => {}});
    const connect = () => version === 1 ? input.connect(42, id, true) : input.connectV2(42, 2, 1, nonce, true);
    connect();
    assert.equal(input.write(bytes('first')), true);
    assert.equal(input.retain(bytes('second')), true);
    connect();
    if (version === 1) input.ack(42, id, 1, true);
    else input.ackV2(42, 2, 1, 1, true);
    assert.equal(frames.length, 1, `v${version} must not send retained input`);
    assert.equal(input.retainedText, 'second');
    assert.equal(input.state, 'review');
    assert.equal(input.retry(), true);
    assert.equal(frames.length, 2);
  }
});
for (const version of [1, 2] as const) test(`v${version} fragmented input preserves bytes across two explicit review barriers`, () => {
  const frames: Uint8Array[] = [];
  const id = 'fragment-review', nonce = 'd'.repeat(32);
  const input = createAcknowledgedInput({version, attachmentId: id, created: 42,
    send: frame => frames.push(frame), state: () => {}});
  const connect = () => version === 1 ? input.connect(42, id, true) : input.connectV2(42, 1, 1, nonce, true);
  const ack = (seq: number) => version === 1 ? input.ack(42, id, seq, true) : input.ackV2(42, 1, 1, seq, true);
  const first = Uint8Array.from({length: 70001}, (_, i) => i % 251);
  const held = Uint8Array.from({length: 140003}, (_, i) => (i + 31) % 251);
  const later = new Uint8Array([67]);
  connect();
  assert.equal(input.write(first), true);
  assert.equal(input.retain(held), true);
  connect();
  ack(1); ack(2);
  assert.equal(frames.length, 2, 'the original operation drains, but retained fragments require review');
  assert.equal(input.pendingBytes, held.length);
  assert.equal(input.state, 'review');
  assert.equal(input.retry(), true);
  assert.equal(frames.length, 3);
  assert.equal(input.retain(later), true);
  connect();
  ack(3); ack(4); ack(5);
  assert.equal(frames.length, 5, 'retrying the earlier batch cannot authorize a later retention');
  assert.equal(input.pendingBytes, later.length);
  assert.equal(input.state, 'review');
  assert.equal(input.retry(), true);
  ack(6);
  assert.equal(input.pendingBytes, 0);
  assert.equal(input.state, 'ready');
  assert.deepEqual(Buffer.concat(frames.map(frame => Buffer.from(frame.subarray(4)))),
    Buffer.concat([first, held, later]), 'every byte is delivered once, in order');
  for (const [i, frame] of frames.entries())
    assert.equal(new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0), i + 1);
  assert.equal(input.retain(new Uint8Array([68])), true);
  connect();
  assert.equal(input.discard(), true);
  assert.equal(input.write(new Uint8Array([69])), true);
  assert.equal(frames.length, 7);
  const replacement = frames.at(-1)!;
  assert.equal(new DataView(replacement.buffer, replacement.byteOffset, replacement.byteLength).getUint32(0), 7,
    'discarding never-sent input reuses only its uncommitted sequence');
  assert.deepEqual([...replacement.subarray(4)], [69]);
});
test('a blocked actor keeps offline input for review without allowing retry', () => {
  const frames: Uint8Array[] = [];
  const input = createAcknowledgedInput({version: 2, created: 42, send: frame => frames.push(frame), state: () => {}});
  input.reject();
  assert.equal(input.retain(bytes('held')), true);
  assert.equal(input.retainedText, 'held');
  assert.equal(input.state, 'halted');
  assert.equal(input.connectV2(42, 1, 1, 'a'.repeat(32), true), false);
  assert.equal(input.retry(), false);
  assert.equal(frames.length, 0);
});
test('discarding retained input never revives a halted actor', () => {
  for (const version of [1, 2] as const) {
    const frames: Uint8Array[] = [];
    const id = 'opaque-attachment-0123456789', nonce = 'c'.repeat(32);
    const input = createAcknowledgedInput({version, attachmentId: id, created: 42,
      send: frame => frames.push(frame), state: () => {}});
    if (version === 1) {
      input.connect(41, id, true);
    } else {
      assert.equal(input.connectV2(42, 1, 1, nonce, true), true);
      assert.equal(input.write(bytes('first')), true);
      input.ackV2(42, 1, 1, 1, false, 'invalid_frame');
      assert.equal(input.discard(), true);
    }
    assert.equal(input.state, 'halted');
    const before = frames.length;
    assert.equal(input.retain(bytes('held')), true);
    assert.equal(input.discard(), true);
    assert.equal(input.state, 'halted');
    if (version === 1) input.connect(42, id, true);
    else assert.equal(input.connectV2(42, 1, 1, nonce, true), false);
    assert.equal(input.write(bytes('new')), false);
    assert.equal(input.retry(), false);
    assert.equal(frames.length, before);
  }
});
test("retained text is readable without replay and disappears on discard", () => {
  const sent: Uint8Array[] = [];
  const input = createAcknowledgedInput({version: 2, created: 42, send: frame => sent.push(frame), state: () => {}});
  assert.equal(input.connectV2(42, 1, 1, "a".repeat(32), true), true);
  assert.equal(input.write(bytes("bonjour 🌍")), true);
  input.disconnect();
  assert.equal(input.retainedText, "bonjour 🌍");
  assert.equal(sent.length, 1);
  input.discard();
  assert.equal(input.retainedText, "");
  assert.equal(sent.length, 1);
});
test("retained text exposes terminal controls and replaces invalid UTF-8", () => {
  const input = createAcknowledgedInput({version: 2, created: 42, send: () => {}, state: () => {}});
  assert.equal(input.write(new Uint8Array([27, 91, 50, 48, 48, 126, 65, 8, 255])), true);
  assert.equal(input.retainedText, "\x1b[200~A\b�");
});
test("only complete terminal reports bypass a new draft lease", () => {
  for (const report of [
    "\x1b[I", "\x1b[O", "\x1b[<0;5;5M", "\x1b[<32;6;7M",
    "\x1b[<0;6;7m", "\x1b[M !!", "\x1b[7;9R", "\x1b[0n",
    "\x1b[I\x1b[<0;5;5M\x1b[O",
  ]) assert.equal(terminalReportsOnly(bytes(report)), true, JSON.stringify(report));
  for (const human of [
    "", "draft", "\r", "\x1b[I\r", "\x1b[<0;5;5Mhuman",
    "\x1b[200~paste\x1b[201~", "\x1b[<0;5;5X", "\x1b[<0;5;M",
    "\x1b[1;2A", "\x1b[?1004h", "\x1b[M \r!",
    "\x1b[I".repeat(22000), // cannot split a report across I frames
  ]) assert.equal(terminalReportsOnly(bytes(human)), false, JSON.stringify(human));
});

const setup = () => {
  const frames: Uint8Array[] = [];
  const states: string[] = [];
  let open = true;
  const input = createAcknowledgedInput({
    attachmentId: "opaque-attachment-0123456789",
    created: 42,
    send: (frame) => { if (!open) throw Error("closed"); frames.push(frame); },
    state: (state) => states.push(state),
  });
  return { input, frames, states, close: () => { open = false; } };
};

test("bytes remain retained until native ACK; no implicit resend after disconnection", () => {
  const { input, frames } = setup();
  input.connect(42, "opaque-attachment-0123456789", true);
  assert.equal(input.write(bytes("first")), true);
  assert.equal(frames.length, 1);
  assert.equal(input.pendingBytes, 5);
  input.disconnect();
  input.connect(42, "opaque-attachment-0123456789", true);
  assert.equal(frames.length, 1);
  assert.equal(input.state, "uncertain");
  assert.equal(input.retry(), true); // explicit human choice, same incarnation
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], frames[1]); // native deduplication, not a fresh sequence
  input.ack(42, "opaque-attachment-0123456789", 1, true);
  assert.equal(input.pendingBytes, 0);
});

test("fenced rejection and new input stay bounded and require human review", () => {
  const { input, frames } = setup();
  input.connect(42, "opaque-attachment-0123456789", true);
  input.write(bytes("one"));
  input.ack(42, "opaque-attachment-0123456789", 1, false, "switch_input_fenced");
  assert.equal(input.state, "review");
  input.write(bytes("two"));
  assert.equal(frames.length, 1);
  assert.equal(input.pendingBytes, 6);
  input.connect(43, "opaque-attachment-0123456789", true);
  assert.equal(input.retry(), false);
  assert.equal(frames.length, 1);
  assert.equal(input.discard(), true);
  assert.equal(input.pendingBytes, 0);
});

test("a sent frame stays uncertain across a refused v1 reconnect and cannot reuse its sequence", () => {
  const {input, frames} = setup();
  input.connect(42, "opaque-attachment-0123456789", true);
  input.write(bytes("possibly delivered"));
  input.connect(43, "opaque-attachment-0123456789", true);
  assert.equal(input.deliveryUncertain, true);
  assert.equal(input.state, "uncertain");
  input.discard();
  assert.equal(input.state, "halted");
  input.connect(42, "opaque-attachment-0123456789", true);
  assert.equal(input.write(bytes("different")), false);
  assert.equal(frames.length, 1);
});

test("only a proven pre-effect refusal permits discarding and reusing an ACK sequence", () => {
  for (const version of [1, 2] as const) {
    for (const reason of [undefined, "input_pending", "switch_input_fenced"] as const) {
      const frames: Uint8Array[] = [];
      const input = createAcknowledgedInput({version, attachmentId: "attachment", created: 42,
        send: frame => frames.push(frame), state: () => {}});
      if (version === 1) input.connect(42, "attachment", true);
      else input.connectV2(42, 1, 1, "a".repeat(32), true);
      input.write(bytes("old"));
      if (version === 1) input.ack(42, "attachment", 1, false, reason);
      else input.ackV2(42, 1, 1, 1, false, reason);
      assert.equal(input.deliveryUncertain, reason === undefined);
      input.discard();
      assert.equal(input.state, reason === undefined ? "halted" : "ready");
      assert.equal(input.write(bytes("new")), reason !== undefined);
      if (reason !== undefined) {
        assert.equal(frames.length, 2);
        assert.equal(new DataView(frames[1]!.buffer).getUint32(0), 1);
      } else assert.equal(frames.length, 1);
    }
  }
});

test("malformed ACK and exceeded buffer fail closed, no legacy fallback", () => {
  const { input, frames } = setup();
  input.connect(42, "opaque-attachment-0123456789", true);
  assert.equal(input.write(bytes("x")), true);
  input.ack(42, "opaque-attachment-0123456789", 2, true);
  assert.equal(input.state, "uncertain");
  assert.equal(input.write(new Uint8Array(1024 * 1024 + 1)), false);
  assert.equal(frames.length, 1);
  assert.equal(input.pendingBytes, 1);
});

test("reports never complete a human draft, including onBinary's complete hint", () => {
  const {input} = setup();
  input.connect(42, "opaque-attachment-0123456789", true);
  input.write(bytes("draft"));
  input.write(bytes("\x1b[O"), true);
  input.ack(42, "opaque-attachment-0123456789", 1, true);
  input.ack(42, "opaque-attachment-0123456789", 2, true);
  assert.equal(input.completed, false);
  assert.equal(input.pendingHumanBytes, 0);
  input.write(bytes("\x1b[I\r"));
  assert.equal(input.pendingHumanBytes, 4);
});

test("a submitted human frame releases on ACK even when a report follows it", () => {
  const {input} = setup();
  input.connect(42, "opaque-attachment-0123456789", true);
  input.write(bytes("draft\r"), true);
  input.write(bytes("\x1b[<0;5;5M"), true);
  input.ack(42, "opaque-attachment-0123456789", 1, true);
  assert.equal(input.completed, true);
  assert.equal(input.pendingHumanBytes, 0);
  assert.ok(input.pendingBytes > 0, "the report still needs its own ACK");
  input.ack(42, "opaque-attachment-0123456789", 2, true);
  assert.equal(input.completed, false);
  assert.equal(input.pendingBytes, 0);
});

test("uncertain discard permanently halts this attachment across socket reopen", () => {
  const {input, frames} = setup();
  input.connect(42, "opaque-attachment-0123456789", true);
  input.write(bytes("possibly delivered"));
  input.disconnect();
  assert.equal(input.deliveryUncertain, true);
  assert.equal(input.discard(), true);
  assert.equal(input.state, "halted");
  input.connect(42, "opaque-attachment-0123456789", true);
  assert.equal(input.state, "halted");
  assert.equal(input.write(bytes("new input")), false);
  assert.equal(input.retry(), false);
  assert.equal(frames.length, 1);
  const fresh = setup();
  fresh.input.connect(42, "opaque-attachment-0123456789", true);
  assert.equal(fresh.input.write(bytes("new input")), true);
  assert.equal(fresh.frames.length, 1);
});

test("unsent or rejected input without an acknowledged draft can clear its lease", () => {
  const {input} = setup();
  assert.equal(input.write(bytes("not sent")), true);
  assert.equal(input.deliveryUncertain, false);
  input.discard();
  input.connect(42, "opaque-attachment-0123456789", true);
  input.write(bytes("rejected"));
  input.ack(42, "opaque-attachment-0123456789", 1, false, "input_pending");
  assert.equal(input.deliveryUncertain, false);
});

test("a rejected final frame cannot release an earlier acknowledged partial draft", () => {
  const {input} = setup();
  input.connect(42, "opaque-attachment-0123456789", true);
  input.write(bytes("partial"));
  input.ack(42, "opaque-attachment-0123456789", 1, true);
  input.write(bytes("\r"), true);
  input.ack(42, "opaque-attachment-0123456789", 2, false, "input_pending");
  assert.equal(input.deliveryUncertain, false);
  assert.equal(input.incompleteHumanInput, true);
});

test("v2 sends only after a confirmed slot and resumes exactly the confirmed generation", () => {
  const frames: Uint8Array[] = [];
  const input = createAcknowledgedInput({version: 2, created: 42,
    send: frame => frames.push(frame), state: () => {}});
  assert.equal(input.write(bytes("queued")), true);
  assert.equal(frames.length, 0);
  assert.equal(input.connectV2(42, 7, 11, "0123456789abcdef0123456789abcdef", true), true);
  assert.deepEqual(input.binding, {slot: 7, generation: 11, actorNonce: "0123456789abcdef0123456789abcdef"});
  assert.equal(input.state, "review");
  assert.equal(frames.length, 0, "confirmation does not automatically submit a queued draft");
  assert.equal(input.retry(), true);
  assert.equal(frames.length, 1);
  input.disconnect();
  assert.equal(input.connectV2(42, 7, 11, "0123456789abcdef0123456789abcdef", true), true);
  assert.equal(input.state, "uncertain");
  assert.equal(frames.length, 1);
  input.ackV2(42, 7, 12, 1, true);
  assert.equal(input.pendingBytes, 6);
  input.ackV2(42, 7, 11, 1, true);
  assert.equal(input.pendingBytes, 0);
});

test("v2 refused or mismatched capability cannot change bindings or silently use a new actor", () => {
  const input = createAcknowledgedInput({version: 2, created: 42,
    send: () => assert.fail("no input"), state: () => {}});
  assert.equal(input.connectV2(42, 0, 3, "0123456789abcdef0123456789abcdef", true), true);
  input.disconnect();
  assert.equal(input.connectV2(42, 0, 3, "ffffffffffffffffffffffffffffffff", true), false);
  assert.deepEqual(input.binding, {slot: 0, generation: 3, actorNonce: "0123456789abcdef0123456789abcdef"});
  assert.equal(input.write(bytes("not admitted")), false);
  assert.equal(input.connectV2(42, 0, 3, "0123456789abcdef0123456789abcdef", true), false);
  const first = createAcknowledgedInput({version: 2, created: 42,
    send: () => assert.fail("no input"), state: () => {}});
  first.write(bytes("not admitted"));
  first.reject();
  assert.equal(first.pendingBytes, 12);
  assert.equal(first.retry(), false);
  first.discard();
  assert.equal(first.state, "halted");
});

test("v2 nonce is mandatory and invalid or noncanonical values cannot bind", () => {
  for (const nonce of ["", "ABCDEF0123456789abcdef0123456789", "0123456789abcdef", "g".repeat(32)]) {
    const input = createAcknowledgedInput({version: 2, created: 42, send: () => assert.fail(), state: () => {}});
    assert.equal(input.connectV2(42, 0, 1, nonce, true), false);
    assert.equal(input.binding, null);
  }
});

test("a v2 terminal rejection remains halted across disconnect and late receipts", () => {
  const {input, frames} = (() => {
    const frames: Uint8Array[] = [];
    const input = createAcknowledgedInput({version: 2, created: 42,
      send: frame => frames.push(frame), state: () => {}});
    return {input, frames};
  })();
  input.connectV2(42, 0, 1, "0123456789abcdef0123456789abcdef", true);
  input.write(bytes("rejected"));
  input.ackV2(42, 0, 1, 1, false, "sequence_gap");
  assert.equal(input.state, "halted");
  input.disconnect();
  input.ackV2(42, 0, 1, 2, true);
  assert.equal(input.state, "halted");
  assert.equal(input.connectV2(42, 0, 1, "0123456789abcdef0123456789abcdef", true), false);
  assert.equal(input.retry(), false);
  assert.equal(frames.length, 1);
});
