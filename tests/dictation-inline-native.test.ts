// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
// Controlled native editor evidence, NOT actual Claude/Codex/Pi or physical-device acceptance.
// MESH_CHROMIUM: required by the real-browser/native fixture and discovered by browser shards.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {NativeEditorBuffer} from '../checks/dictation-native-editor.ts';
import {
  nativeTest, withNativeEditor, record, expectBuffer, expectNoSubmission, expectPaste,
  expectDirtyWithoutClean, manualKey, typeNative, waitRetired, waitMode,
} from '../checks/dictation-inline-native-fixture.ts';
declare const active: {term: {rows: number; cols: number}};

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
  // Deterministic per-frame boundary checks use the shipped channel with a fake
  // encoder. Native/browser assertions below remain separate and are not faked.
  await componentChecks('tests/dictation-input-inline.test.ts',
    '^inline channel: (disabled/invalid|late encoder|per-frame|reentrant H|native mode|pre-frame)', 6);
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
    expectDirtyWithoutClean(f);
    await manualKey(f, 'Backspace'); await typeNative(f, 'B');
    await expectBuffer(f, 'alpha\nbeta\ttaB'); expectNoSubmission(f);
    await manualKey(f, 'Enter');
    await f.wait('separate manual submission event', () => f.submissions().length === 1);
    assert.deepEqual(f.submissions().map(s => s.text), ['alpha\nbeta\ttaB']);
    await expectBuffer(f, '');
    assert.equal(f.raw().toString(), '\x1b[200~alpha\rbeta\ttab\x1b[201~\x7fB\r');
    await f.wait('ordinary manual Enter emits clean H', () => {
      const h = f.sockets.flatMap(s => s.sent).filter(value => typeof value === 'string')
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
    assert.equal(typeof incoming[0], 'string');
    assert.equal(JSON.parse(incoming[0] as string).t, 'bound', 'bound precedes geometry and first binary replay');
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
      expectDirtyWithoutClean(f);
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

nativeTest('AC-11: native deletion and fresh dictation without Discard', async () => {
  await withNativeEditor(async f => {
    await record(f, 'bonjour A'); await expectBuffer(f, 'bonjour A'); await waitRetired(f);
    const firstRequest = f.uploads[0]!.requestId;
    await manualKey(f, 'Backspace'); await expectBuffer(f, 'bonjour ');
    await manualKey(f, 'Control+u'); await expectBuffer(f, '');
    expectNoSubmission(f); expectDirtyWithoutClean(f);
    await record(f, 'suite A'); await expectBuffer(f, 'suite A'); await waitRetired(f);
    assert.equal(f.uploads.length, 2); assert.notEqual(f.uploads[1]!.requestId, firstRequest);
    expectDirtyWithoutClean(f); expectNoSubmission(f);
    // Native text/cursor is a test-only private file, never a browser draft oracle.
    await manualKey(f, 'Control+u'); await typeNative(f, 'preexisting suffix');
    for (let i = 0; i < ' suffix'.length; i++) await manualKey(f, 'ArrowLeft');
    await record(f, '+spoken');
    await expectBuffer(f, 'preexisting+spoken suffix'); await waitRetired(f);
    assert.equal(f.snapshot().cursor, 'preexisting+spoken'.length);
    expectDirtyWithoutClean(f); expectNoSubmission(f);
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
  await withNativeEditor(async f => {
    await f.page.route('**/api/sessions?teardown=1', route => {
      pending = (async () => {
        await new Promise(resolve => setTimeout(resolve, 200));
        const response = await route.fetch();
        await route.fulfill({response}); completed = true;
      })().catch(error => {failure = error;});
      return pending;
    });
    await f.page.evaluate(() => {void fetch('/api/sessions?teardown=1').catch(() => {});});
    await f.wait('inventory route is still active at fixture teardown', () => !!pending);
    assert.equal(completed, false);
  });
  await pending;
  assert.equal(failure, undefined); assert.equal(completed, true);
});
