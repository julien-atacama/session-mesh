// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
// Controlled native editor evidence, NOT actual Claude/Codex/Pi or physical-device acceptance.
// MESH_CHROMIUM: required by the real-browser/native fixture and discovered by browser shards.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {promisify} from 'node:util';
import {NativeEditorBuffer} from '../checks/dictation-native-editor.ts';
import {
  nativeTest, withNativeEditor, record, expectBuffer, expectNoSubmission, expectPaste,
  expectDirtyWithoutClean, pasteSocket, manualKey, typeNative, waitRetired, waitMode,
} from '../checks/dictation-inline-native-fixture.ts';
declare const active: {term: {rows: number; cols: number}}, inlineDictation: any;

async function componentChecks(file: string, pattern: string, expected: number): Promise<void> {
  const env = {...process.env};
  // A test child must be a new runner, not Node's internal runner IPC child.
  for (const key of Object.keys(env)) if (key.startsWith('NODE_TEST_')) delete env[key];
  const result = await promisify(execFile)(process.execPath, ['--experimental-strip-types', '--test', '--test-reporter=tap',
    '--test-name-pattern=' + pattern, file], {env, cwd: import.meta.dirname + '/..'});
  assert.ok(result.stdout.length, 'independent component runner emitted TAP');
  for (const [key, count] of Object.entries({tests: expected, pass: expected, fail: 0, cancelled: 0, skipped: 0, todo: 0})) {
    assert.match(result.stdout, new RegExp('^# ' + key + ' ' + count + '$', 'm'), 'component runner exact ' + key + ' count');
  }
  const executed = result.stdout.match(/^ok \d+ - /gm) || [];
  assert.equal(executed.length, expected, 'all selected component checks really executed');
  assert.doesNotMatch(result.stdout, /^(?:not ok |ok \d+ - .* # (?:SKIP|TODO)\b)/im);
  console.log(`Component checks executed: ${file}: ${expected} passed, 0 failed/skipped/todo`);
}

nativeTest('AC-1: paste mode and control safety', async () => {
  // Deterministic validation and write-boundary checks use the shipped
  // channel. The native/browser assertions below remain separate.
  await componentChecks('tests/dictation-input-inline.test.ts',
    '^inline channel: (disabled/invalid|late encoder|encoder loss|reentrant H|native mode|pre-frame|complete encoder|real xterm)', 8);
  await withNativeEditor(async f => {
    await record(f, 'alpha\r\nbeta\ttab');
    await expectBuffer(f, 'alpha\nbeta\ttab');
    await expectPaste(f, 'alpha\nbeta\ttab');
    expectNoSubmission(f);
    await waitRetired(f);
    // Actual native mode output, not a browser-side assignment of mode evidence.
    await f.mode(false); await waitMode(f, false);
    const before = f.raw();
    assert.equal(await f.page.locator('.pane.active [data-act="dictate"]').isDisabled(), true);
    assert.ok((await f.page.locator('.pane.active .p-inline-dictation-status').textContent())?.trim());
    assert.deepEqual(f.raw(), before, 'disabled mode never falls back to raw input');
    await f.mode(true); await waitMode(f, true);
    await record(f, 'must not arrive', {beforeResult: async () => {await f.mode(false); await waitMode(f, false);}});
    await waitRetired(f);
    assert.deepEqual(f.raw(), before, 'mode revoked during recognition refuses before any payload');
    expectNoSubmission(f);
  });
  for (const forbidden of ['escape\x1b[201~\r', 'nul\x00', 'control\x03', 'c1\x85']) {
    await withNativeEditor(async f => {
      await record(f, forbidden);
      await waitRetired(f);
      assert.equal(f.raw().length, 0, 'forbidden ESC/C0/C1 text never reaches the native PTY');
      await expectBuffer(f, ''); expectNoSubmission(f);
      assert.ok((await f.page.locator('.pane.active .p-inline-dictation-status').textContent())?.trim(), 'inline rejection reason');
      assert.equal(f.binary().length, 0, 'no plain fallback or terminal replay');
    });
  }
});

nativeTest('AC-3: native insertion and manual submission oracles', async () => {
  const wire = Buffer.from('\x1b[200~alpha\r\nbêta\ttab\x1b[201~');
  for (let split = 0; split <= wire.length; split++) {
    const events: unknown[] = [], editor = new NativeEditorBuffer(event => events.push(event));
    editor.feed(wire.subarray(0, split)); editor.feed(wire.subarray(split));
    assert.equal(editor.text.join(''), 'alpha\nbêta\ttab'); assert.equal(editor.cursor, 14);
    assert.deepEqual(events, [], 'split framing/UTF8/CRLF cannot submit the native oracle');
  }
  await withNativeEditor(async f => {
    await record(f, 'alpha\nbeta\ttab');
    await expectBuffer(f, 'alpha\nbeta\ttab');
    await expectPaste(f, 'alpha\nbeta\ttab'); expectNoSubmission(f);
    await waitRetired(f);
    assert.deepEqual(f.settlements.map(s => s.outcome), ['inserted'], 'real worker retirement is insertion, not submission');
    const inputSocket = pasteSocket(f);
    expectDirtyWithoutClean(f, inputSocket);
    await manualKey(f, 'Backspace'); await typeNative(f, 'B');
    await expectBuffer(f, 'alpha\nbeta\ttaB'); expectNoSubmission(f);
    await manualKey(f, 'Enter');
    await f.wait('separate manual submission event', () => f.submissions().length === 1);
    assert.deepEqual(f.submissions().map(s => s.text), ['alpha\nbeta\ttaB']);
    await expectBuffer(f, '');
    assert.equal(f.raw().toString(), '\x1b[200~alpha\rbeta\ttab\x1b[201~\x7fB\r');
    await f.wait('ordinary manual Enter emits clean H', () => {
      const h = inputSocket.sent.filter(value => typeof value === 'string')
        .map(value => JSON.parse(value as string)).filter(value => value.t === 'h');
      return h.slice(h.findIndex(value => value.dirty === true) + 1).some(value => value.dirty === false);
    });
  });
});

nativeTest('AC-7: conditional incarnation binding acknowledgement', async () => {
  // The sibling producer tests reject missing/duplicate/malformed/late acknowledgements
  // in the actual browser-handle code. Do not manufacture a permissive socket here.
  await componentChecks('tests/dictation-binding.test.ts', '^(bound authority|missing, late|retained original)', 3);
  await withNativeEditor(async f => {
    const initial = f.created;
    const incoming = f.sockets.flatMap(s => s.received);
    const bound = incoming.filter(e => typeof e === 'string' && JSON.parse(e).t === 'bound');
    assert.equal(bound.length, 1);
    assert.deepEqual(JSON.parse(bound[0] as string), {t: 'bound', name: f.name, created: initial});
    const boundAt = incoming.findIndex(value => typeof value === 'string' && JSON.parse(value).t === 'bound');
    const binaryAt = incoming.findIndex(Buffer.isBuffer);
    assert.ok(boundAt >= 0 && binaryAt > boundAt, 'bound precedes the first binary replay');
    assert.ok(incoming.some(Buffer.isBuffer));
    await f.page.close(); // no old page may resize/reconnect while the replacement is measured
    const replacement = await f.replace();
    assert.notEqual(replacement, initial);
    const before = f.snapshot();
    // A context-owned API request performs the authenticated real upgrade attempt;
    // its failure is decided by native attach_if, not inventory or an invented WS.
    const stale = await f.context.request.get(`${f.mesh.base}/ws/${encodeURIComponent(f.name)}?created=${initial}&rows=33&cols=93&replay_geometry=1`, {
      headers: {Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.alloc(16, 7).toString('base64')},
    });
    assert.equal(stale.status(), 404);
    assert.deepEqual(f.snapshot(), before, 'no replacement resize or data from the stale conditional attachment');
    assert.equal(f.raw().length, 0); expectNoSubmission(f);
  });
});

nativeTest('AC-10: record edit and manually submit native prompt', async () => {
  for (const touch of [false, true]) await withNativeEditor(async f => {
    await record(f, 'bonjour A', {gesture: touch ? 'pointer' : 'Enter'});
    if (touch) {
      await f.page.waitForFunction(() => (document.querySelector('#line-text') as HTMLTextAreaElement)?.value === 'bonjour A');
      await expectBuffer(f, '');
      assert.equal(f.raw().length, 0, 'phone recognition has not typed into the native editor');
      assert.equal(await f.page.locator('#line-direct').isVisible(), false);
    } else {
      await expectBuffer(f, 'bonjour A'); await expectPaste(f, 'bonjour A');
      expectDirtyWithoutClean(f, pasteSocket(f));
    }
    expectNoSubmission(f); await waitRetired(f);
    assert.equal(await f.page.locator('dialog[open]').count(), 0, 'main-page capture never opens a modal');
    const mic = f.page.locator('.pane.active [data-act="dictate"]');
    assert.ok(await mic.getAttribute('aria-label'), 'main-page microphone has an accessible name');
    const status = f.page.locator('.pane.active .p-inline-dictation-status');
    assert.ok(await status.getAttribute('aria-live') || await status.getAttribute('role'), 'status is accessible');
    assert.equal(await f.page.evaluate(key => localStorage.getItem(key), f.preferenceKey), 'true', 'stored auto-send remains preserved but unused');
    assert.equal(await f.page.locator('#compose-text').inputValue(), '', 'no browser-owned shadow prompt');
    if (touch) {
      const field = f.page.locator('#line-text');
      assert.equal(await field.inputValue(), 'bonjour A');
      await field.fill('bonjour B');
      await expectBuffer(f, ''); expectNoSubmission(f);
      await field.press('Enter');
    } else {
      await manualKey(f, 'ArrowLeft'); await manualKey(f, 'Delete'); await typeNative(f, 'B');
      await expectBuffer(f, 'bonjour B'); expectNoSubmission(f);
      await manualKey(f, 'Enter');
    }
    await f.wait('edited manual submission', () => f.submissions().length === 1);
    assert.deepEqual(f.submissions().map(s => s.text), ['bonjour B']);
  }, {touch});
  await withNativeEditor(async f => {
    const c = await f.addEditor('native-C');
    let before: ReturnType<typeof c.snapshot>, focus: string | null, geometry: unknown, observations = 0;
    await record(f, 'bonjour A', {beforeResult: async () => {
      await f.select(c.name); await typeNative(f, 'C untouched');
      const earlyDimensions = await f.page.evaluate(() => ({rows: active.term.rows, cols: active.term.cols}));
      await f.wait('C reaches the former early native baseline', () => c.snapshot().text === 'C untouched'
        && c.snapshot().rows === earlyDimensions.rows && c.snapshot().cols === earlyDimensions.cols);
      console.log('C former early baseline readiness:', JSON.stringify({browser: await f.initialAttachState(),
        native: c.snapshot(), wire: f.resizeTrace(c.name)}));
      await f.settleInitialAttach(c.name);
      const size = await f.page.locator('.pane.active .xterm').boundingBox(); assert.ok(size);
      const dimensions = await f.page.evaluate(() => ({rows: active.term.rows, cols: active.term.cols}));
      await f.wait('C native input/geometry settled', () => c.snapshot().text === 'C untouched'
        && c.snapshot().rows === dimensions.rows && c.snapshot().cols === dimensions.cols);
      before = c.snapshot();
      observations = c.observations().length;
      focus = await f.page.evaluate(() => document.activeElement?.outerHTML ?? null);
      geometry = await f.page.locator('.pane.active .xterm').boundingBox();
      console.log('C settled initial-attach baseline readiness:', JSON.stringify({browser: await f.initialAttachState(),
        native: before, wire: f.resizeTrace(c.name)}));
    }});
    await expectBuffer(f, 'bonjour A'); await waitRetired(f);
    await expectPaste(f, 'bonjour A'); expectNoSubmission(f);
    console.log('C native observations after late-result baseline:', JSON.stringify(c.observations().slice(observations)));
    console.log('C after late result readiness:', JSON.stringify({browser: await f.initialAttachState(), wire: f.resizeTrace(c.name)}));
    assert.deepEqual(c.snapshot(), before!, 'late original insertion never changes C buffer/cursor/native geometry');
    assert.equal(c.raw().toString(), 'C untouched'); assert.deepEqual(c.submissions(), []);
    assert.equal(await f.page.evaluate(() => document.activeElement?.outerHTML ?? null), focus!);
    assert.deepEqual(await f.page.locator('.pane.active .xterm').boundingBox(), geometry);
    assert.equal(f.sockets.filter(s => new URL(s.url).pathname === '/ws/' + f.name).length, 1, 'released original uses no replacement socket');
  });
});

for (const dirty of [false, true]) nativeTest(`ACK-v2 A→B→A retains the ${dirty ? 'own-dirty' : 'clean'} original actor and receipt`, async () => {
  await withNativeEditor(async f => {
    const b = await f.addEditor('native-B');
    const originalSocket = f.sockets.find(s => new URL(s.url).pathname === '/ws/' + f.name);
    assert.ok(originalSocket);
    assert.ok(new URL(originalSocket.url).searchParams.has('input_ack'), 'the real attachment negotiated ACK input');
    assert.ok(originalSocket.received.some(value => typeof value === 'string' &&
      JSON.parse(value).t === 'input_capability' && JSON.parse(value).version === 2));
    if (dirty) {await typeNative(f, 'own '); await expectBuffer(f, 'own ');}
    const originalFrameCount = originalSocket.sent.filter(Buffer.isBuffer).length;
    await f.page.evaluate(({name, created}) => {
      const entry = active.inputAcks.get(`${name}\0${created}`);
      (window as any).originalAck = {input: entry.input, lease: entry.lease, connection: active.conn};
    }, {name: f.name, created: f.created});
    await record(f, 'late', {beforeResult: async () => {
      await f.select(b.name);
      assert.equal(await f.page.evaluate(({name, created}) => {
        const old = (window as any).originalAck;
        const entry = [...active.inputAcks].find(([key, entry]) =>
          key.startsWith(`${name}\0${created}\0`) && entry.input === old.input)?.[1];
        return entry?.input === old.input && entry?.lease === old.lease;
      }, {name: f.name, created: f.created}), true, 'switching to B preserves the retained original actor and lease');
      await f.select(f.name);
      assert.deepEqual(await f.page.evaluate(({name, created}) => {
        const old = (window as any).originalAck;
        const entry = active.inputAcks.get(`${name}\0${created}`);
        const retained = [...active.inputAcks].find(([key, value]) =>
          key.startsWith(`${name}\0${created}\0`) && value.input === old.input)?.[1];
        return {input: retained?.input === old.input, lease: retained?.lease === old.lease,
          freshActor: entry?.input === active.inputAck && entry?.input !== old.input,
          originalRoute: old.input.retainedConnection === old.connection,
          currentConnection: active.conn !== old.connection,
          awaitingCapability: active.conn.v2AwaitingCapability};
      }, {name: f.name, created: f.created}), {
        input: true, lease: true, freshActor: true, originalRoute: true,
        currentConnection: true, awaitingCapability: false,
      }, 'returning to A must retain the old actor alongside a separately bound new socket');
    }});
    await expectBuffer(f, dirty ? 'own late' : 'late');
    await waitRetired(f);
    const originalFrames = originalSocket.sent.filter(Buffer.isBuffer);
    assert.equal(originalFrames.length, originalFrameCount + 1, 'only the original socket carries the late insertion');
    const seq = originalFrames[originalFrameCount]!.readUInt32BE(0);
    const binding = await f.page.evaluate(() => (window as any).originalAck.input.binding);
    assert.ok(binding, 'original actor remains bound for its late receipt');
    await f.wait('late original socket receipt', () => originalSocket.received.some(value =>
      typeof value === 'string' && (() => {
        const receipt = JSON.parse(value);
        return receipt.t === 'input_ack' && receipt.input_ack === true && receipt.seq === seq &&
          receipt.created === f.created && receipt.slot === binding.slot &&
          receipt.generation === binding.generation;
      })()));
    const currentSocket = f.sockets.filter(s => new URL(s.url).pathname === '/ws/' + f.name).at(-1)!;
    assert.notEqual(currentSocket, originalSocket);
    assert.equal(currentSocket.sent.filter(Buffer.isBuffer).length, 0);
    expectNoSubmission(f);
    assert.deepEqual(await f.page.evaluate(({name, created}) => {
      const old = (window as any).originalAck;
      const retained = [...active.inputAcks].find(([key, entry]) =>
        key.startsWith(`${name}\0${created}\0`) && entry.input === old.input)?.[1];
      return {dirty: retained?.lease.dirty, retained: !!retained,
        reason: inlineDictation.reason(inlineDictation.session(name, created))};
    }, {name: f.name, created: f.created}), {
      dirty: true, retained: true, reason: 'ineligible',
    }, 'the old dirty actor stays reviewable and fences a new A actor');
    assert.equal(await f.page.locator('.pane.active .p-input-other-drafts .p-input-other-draft').count(), 1,
      'same-incarnation old lease remains reachable from pane recovery');
    await f.select(b.name);
    const fresh = {...f, name: b.name, created: b.created, snapshot: b.snapshot, submissions: b.submissions};
    await record(fresh, 'fresh'); await expectBuffer(fresh, 'fresh'); await waitRetired(fresh);
    assert.equal(originalSocket.sent.filter(Buffer.isBuffer).length, originalFrameCount + 1, 'fresh capture cannot replay on the old socket');
    assert.equal(currentSocket.sent.filter(Buffer.isBuffer).length, 0, 'fresh B capture cannot redirect to reopened A');
    assert.equal(f.sockets.filter(s => new URL(s.url).pathname === '/ws/' + b.name)
      .flatMap(s => s.sent.filter(Buffer.isBuffer)).length, 1, 'fresh B paste uses only B actor');
    assert.deepEqual(b.submissions(), []);
    await f.wait('released original socket', () => originalSocket.isClosed());
    await f.select(f.name);
    assert.equal(await f.page.evaluate(({name, created}) =>
      active.inputAcks.get(`${name}\0${created}`)?.input === (window as any).originalAck.input &&
      active.inputLease === (window as any).originalAck.lease, {name: f.name, created: f.created}), true,
    'after original socket retirement the original dirty actor can resume on A');
    await record(f, 'again'); await expectBuffer(f, dirty ? 'own lateagain' : 'lateagain'); await waitRetired(f);
    assert.equal(originalSocket.sent.filter(Buffer.isBuffer).length, originalFrameCount + 1,
      'a new A capture cannot replay on the old socket');
    expectNoSubmission(f);
  });
});

nativeTest('ACK-v2 reconnects the retained dirty actor in place without replaying input', async () => {
  await withNativeEditor(async f => {
    const b = await f.addEditor('native-B');
    const original = f.sockets.find(s => new URL(s.url).pathname === `/ws/${f.name}`)!;
    const originalFrames = original.sent.filter(Buffer.isBuffer).length;
    const actor = await f.page.evaluate(() => active.inputAck.binding);
    await record(f, 'late', {beforeResult: async () => {
      await f.select(b.name);
      await f.select(f.name);
    }});
    await expectBuffer(f, 'late');
    await waitRetired(f);
    await f.wait('released original socket', () => original.isClosed());
    const opened = f.sockets.filter(s => new URL(s.url).pathname === `/ws/${f.name}`).at(-1)!;
    assert.notEqual(opened, original);
    const hold = original.sent.flatMap(frame => typeof frame === 'string' ? [JSON.parse(frame)] : [])
      .findLast(frame => frame.t === 'h' && frame.dirty);
    assert.deepEqual(hold, {t: 'h', slot: actor.slot, generation: actor.generation, dirty: true},
      'the late hold binds the original actor, not the temporary view');
    const resume = f.page.locator('.pane.active .p-input-other-drafts')
      .getByRole('button', {name: 'Reconnect input', exact: true});
    assert.equal(await resume.count(), 1, 'the same-incarnation draft offers safe reconnect');
    await resume.click();
    await f.wait('in-place ACK reconnect', () => f.sockets.some(s =>
      s !== opened && s !== original && new URL(s.url).pathname === `/ws/${f.name}`));
    await f.page.waitForFunction(({name, created}) => active.conn?.terminal?.isBound(name, created)
      && !active.conn.v2AwaitingCapability && !active.conn.replayPending && !active.conn.replaying &&
      !active.conn.draining, {name: f.name, created: f.created});
    assert.deepEqual(await f.page.evaluate(() => active.inputAck.binding), actor);
    assert.equal(opened.sent.filter(Buffer.isBuffer).length, 0);
    const resumed = f.sockets.filter(s => new URL(s.url).pathname === `/ws/${f.name}`).at(-1)!;
    assert.equal(resumed.sent.filter(Buffer.isBuffer).length, 0, 'reconnect does not replay the old paste');
    await record(f, 'again'); await expectBuffer(f, 'lateagain'); await waitRetired(f);
    assert.equal(original.sent.filter(Buffer.isBuffer).length, originalFrames + 1);
    assert.equal(resumed.sent.filter(Buffer.isBuffer).length, 1);
    expectNoSubmission(f);
  });
});

nativeTest('ACK-v2 reconnect leaves replay-deferred typing on the current socket', async () => {
  await withNativeEditor(async f => {
    const b = await f.addEditor('native-B');
    const original = f.sockets.find(s => new URL(s.url).pathname === `/ws/${f.name}`)!;
    await record(f, 'late', {beforeResult: async () => {
      await f.select(b.name);
      await f.select(f.name);
    }});
    await expectBuffer(f, 'late'); await waitRetired(f);
    await f.wait('released original socket', () => original.isClosed());
    await f.page.waitForFunction(() => !active.conn.v2AwaitingCapability && !!active.inputAck?.binding);
    const queued = await f.page.evaluate(() => {
      const c = active.conn;
      (window as any).queuedReconnectConnection = c;
      c.replayPending = true;
      const retained = active.sendRaw(new TextEncoder().encode('kept'), false);
      return {retained, length: c.queuedHumanInput?.length, dirty: active.inputLease.dirty,
        pending: active.inputAck.pendingBytes};
    });
    assert.deepEqual(queued, {retained: true, length: 1, dirty: false, pending: 0});
    await f.page.locator('.pane.active .p-input-other-drafts')
      .getByRole('button', {name: 'Reconnect input', exact: true}).click();
    assert.deepEqual(await f.page.evaluate(() => {
      const c = (window as any).queuedReconnectConnection;
      return {same: active.conn === c, length: c.queuedHumanInput?.length};
    }), {same: true, length: 1}, 'reconnect refuses without discarding the deferred key');
    await f.page.evaluate(() => {
      active.conn.replayPending = false;
      active.flushReplayInput(active.conn);
    });
    await expectBuffer(f, 'latekept');
    expectNoSubmission(f);
  });
});

nativeTest('ACK-v2 automatic rebind waits for the original socket to close', async () => {
  await withNativeEditor(async f => {
    const b = await f.addEditor('native-B');
    const original = f.sockets.find(s => new URL(s.url).pathname === `/ws/${f.name}`)!;
    await f.page.evaluate(() => {
      const socket = active.conn.ws;
      const close = socket.close.bind(socket);
      (window as any).closingAck = active.inputAck;
      // Delay the real handshake, while exposing the state seen during it.
      socket.close = (...args: [number?, string?]) => {
        Object.defineProperty(socket, 'readyState', {configurable: true, value: WebSocket.CLOSING});
        (window as any).finishRetainedClose = () => {
          Reflect.deleteProperty(socket, 'readyState');
          socket.close = close;
          close(...args);
        };
      };
    });
    try {
      await record(f, 'late', {beforeResult: () => f.select(b.name)});
      await expectBuffer(f, 'late'); await waitRetired(f);
      await f.page.waitForFunction(() => !!(window as any).finishRetainedClose);
      assert.equal(original.isClosed(), false, 'the original native socket is still connected');
      const rebound = await f.page.evaluate(name => {
        active.show(name); setActive(active);
        return active.inputAck === (window as any).closingAck;
      }, f.name);
      assert.equal(rebound, false, 'a CLOSING socket must not lend its actor to a new attachment');
    } finally {
      await f.page.evaluate(() => (window as any).finishRetainedClose?.());
    }
    await f.wait('original socket closed', () => original.isClosed());
    await f.select(f.name);
    await f.select(b.name);
    await f.select(f.name);
    assert.equal(await f.page.evaluate(() => active.inputAck === (window as any).closingAck), true,
      'the exact old actor is resumable after its socket closes');
    await expectBuffer(f, 'late');
    expectNoSubmission(f);
  });
});

nativeTest('ACK-v2 intentional retirement of retained A rejects the late line without a fallback', async () => {
  await withNativeEditor(async f => {
    const b = await f.addEditor('native-B');
    const original = f.sockets.find(s => new URL(s.url).pathname === `/ws/${f.name}`)!;
    await record(f, 'must not arrive', {beforeResult: async () => {
      await f.select(b.name);
      await f.page.evaluate(({name, created}) => {
        const retained = [...active.inputAcks].find(([key, entry]) =>
          key.startsWith(`${name}\0${created}\0`) && entry.input.retainedConnection)?.[1];
        if (!retained) throw Error('missing retained actor');
        retained.input.retainedConnection.terminal.dispose();
      }, {name: f.name, created: f.created});
      await f.wait('intentional socket retirement', () => original.isClosed());
    }});
    await waitRetired(f);
    await expectBuffer(f, '');
    assert.equal(original.sent.filter(Buffer.isBuffer).length, 0, 'no late bytes after retirement');
    expectNoSubmission(f);
    await f.select(f.name);
    await record(f, 'fresh'); await expectBuffer(f, 'fresh'); await waitRetired(f);
    assert.equal(original.sent.filter(Buffer.isBuffer).length, 0, 'fresh input never replays on retired socket');
    expectNoSubmission(f);
  });
});

nativeTest('ACK-v2 same-A reattachment keeps its retained original socket independently bound', async () => {
  await withNativeEditor(async f => {
    const original = f.sockets.find(s => new URL(s.url).pathname === `/ws/${f.name}`)!;
    await f.page.evaluate(({name, created}) => {
      (window as any).originalActor = active.inputAcks.get(`${name}\0${created}`).input;
    }, {name: f.name, created: f.created});
    await record(f, 'late', {beforeResult: async () => {
      await f.page.evaluate(name => active.attach(name), f.name);
      await f.page.waitForFunction(({name, created}) => active.conn?.terminal?.isBound(name, created) &&
        !active.conn.v2AwaitingCapability, {name: f.name, created: f.created});
      assert.equal(await f.page.evaluate(({name, created}) => {
        const old = (window as any).originalActor;
        return [...active.inputAcks].some(([key, entry]) =>
          key.startsWith(`${name}\0${created}\0`) && entry.input === old) &&
          active.inputAck !== old && !!old.retainedConnection;
      }, {name: f.name, created: f.created}), true);
    }});
    await expectBuffer(f, 'late'); await waitRetired(f);
    assert.equal(original.sent.filter(Buffer.isBuffer).length, 1, 'late receipt and input remain on original socket');
    const replacement = f.sockets.filter(s => new URL(s.url).pathname === `/ws/${f.name}`).at(-1)!;
    assert.notEqual(original, replacement);
    assert.equal(replacement.sent.filter(Buffer.isBuffer).length, 0);
    expectNoSubmission(f);
  });
});

nativeTest('AC-11: native deletion and fresh dictation without Discard', async () => {
  await withNativeEditor(async f => {
    await record(f, 'bonjour A'); await expectBuffer(f, 'bonjour A'); await waitRetired(f);
    const firstRequest = f.uploads[0]!.requestId;
    await manualKey(f, 'Backspace'); await expectBuffer(f, 'bonjour ');
    await manualKey(f, 'Control+u'); await expectBuffer(f, '');
    expectNoSubmission(f); expectDirtyWithoutClean(f, pasteSocket(f));
    await record(f, 'suite A'); await expectBuffer(f, 'suite A'); await waitRetired(f);
    assert.equal(f.uploads.length, 2); assert.notEqual(f.uploads[1]!.requestId, firstRequest);
    expectDirtyWithoutClean(f, pasteSocket(f)); expectNoSubmission(f);
    // Native text/cursor is a test-only private file, never a browser draft oracle.
    await manualKey(f, 'Control+u'); await typeNative(f, 'preexisting suffix');
    for (let i = 0; i < ' suffix'.length; i++) await manualKey(f, 'ArrowLeft');
    await record(f, '+spoken');
    await expectBuffer(f, 'preexisting+spoken suffix'); await waitRetired(f);
    assert.equal(f.snapshot().cursor, 'preexisting+spoken'.length);
    expectDirtyWithoutClean(f, pasteSocket(f)); expectNoSubmission(f);
    assert.equal(f.uploads.length, 3);
    assert.deepEqual(f.settlements.map(s => s.outcome), ['inserted', 'inserted', 'inserted']);
    assert.equal(await f.page.locator('dialog[open]').count(), 0);
    assert.equal(await f.page.locator('#compose-text').inputValue(), '');
    const wire = Buffer.concat(f.binary()).toString();
    assert.equal(wire.split('\x1b[200~').length - 1, 3);
    assert.equal(wire.split('\x1b[201~').length - 1, 3);
  });
});

nativeTest('native fixture drains pending inventory routes before disposing the request context', async () => {
  let pending: Promise<void> | undefined, failure: unknown, completed = false;
  let startDrain!: () => void;
  const draining = new Promise<void>(resolve => {startDrain = resolve;});
  await withNativeEditor(async f => {
    await f.page.route('**/api/sessions?teardown=1', route => {
      pending = (async () => {
        await draining;
        const response = await route.fetch();
        await route.fulfill({response}); completed = true;
      })().catch(error => {failure = error;});
      return pending;
    });
    await f.page.evaluate(() => {void fetch('/api/sessions?teardown=1').catch(() => {});});
    await f.wait('inventory route is still active at fixture teardown', () => !!pending);
    assert.equal(completed, false);
  }, {onRouteDrainStart: () => {
    assert.ok(pending, 'route is pending when fixture teardown starts');
    assert.equal(completed, false);
    startDrain();
  }});
  await pending;
  assert.equal(failure, undefined); assert.equal(completed, true);
});

nativeTest('native fixture rejects a failed upstream bind and leaves the existing listener intact', async () => {
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  try {
    const port = (occupied.address() as {port: number}).port;
    await assert.rejects(withNativeEditor(async () => {
      assert.fail('fixture must fail before starting the native editor');
    }, {upstreamPort: port}), {code: 'EADDRINUSE'});
    assert.equal(occupied.listening, true);
  } finally {
    await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve()));
  }
});
