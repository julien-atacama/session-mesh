// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
// MESH_CHROMIUM: actual app with test-owned sockets, no native terminal or microphone.
import assert from 'node:assert/strict';
import {test, harness, wire, open, select, closeCompose} from '../checks/dictation-browser-fixture.ts';
declare const active: any, composeOwner: any, composeRecovery: any[], dictation: any, dictationInventoryReady: boolean, meshPageCache: any;
declare function refresh(): Promise<unknown>;
declare function openSession(name: string): void;

test('a detached uncertain retained actor is reviewable from another session', async () => {
  await harness(async (page, _api, _sockets, writes) => {
    await select(page, 'B');
    await page.evaluate(() => {
      const input = {pendingBytes: 4, pendingHumanBytes: 4, retainedText: 'held',
        deliveryUncertain: false, retainedConnection: {},
        discard() {this.pendingBytes = this.pendingHumanBytes = 0; this.retainedText = '';}};
      (window as any).foreignRetainedInput = input;
      active.inputAcks.set(['A', '1', 'old-actor'].join('\0'), {input, lease: {dirty: false}});
      active.renderRetainedInput();
    });
    const other = page.locator('.pane.active .p-input-other-drafts .p-input-other-draft');
    assert.equal(await other.count(), 0, 'a live detached delivery does not resize B');
    await page.evaluate(() => {
      const input = (window as any).foreignRetainedInput;
      input.retainedConnection = null;
      input.deliveryUncertain = true;
      active.renderRetainedInput();
    });
    assert.equal(await other.count(), 1, 'a retired uncleared ACK must be reviewable without reopening A');
    assert.equal(await other.locator('strong').textContent(), 'A');
    assert.equal(await other.locator('textarea').inputValue(), 'held');
    await other.getByRole('button', {name: /Discard/}).click();
    assert.equal(await other.count(), 0);
    assert.deepEqual(wire(writes, 'A:0'), []);
    assert.deepEqual(wire(writes, 'B:0'), []);
  }, false, 'en');
});

for (const delayed of [false, true]) test(`ordinary replay paste failure never writes Enter (${delayed ? 'after' : 'before'} the former Enter delay)`, async () => {
  await harness(async (page, _api, _sockets, writes) => {
    await open(page); await page.locator('#compose-text').fill('must not submit');
    await page.evaluate(() => {
      active.conn.replaying = true;
      const socket = active.conn.ws, send = socket.send.bind(socket);
      let fail = true;
      socket.send = (bytes: unknown) => {
        if (fail && bytes instanceof Uint8Array) {fail = false; throw Error('one-shot paste D failure');}
        send(bytes);
      };
    });
    await page.locator('#compose-send').click();
    if (delayed) await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => composeRecovery.length), 0);
    assert.equal(await page.evaluate(() => composeOwner.pending), true, 'queued is not submitted');
    await page.evaluate(() => {active.conn.replaying = false; active.flushReplayInput(active.conn);});
    await page.waitForFunction(() => composeRecovery.length === 1);
    await page.waitForTimeout(100); // a wrongly scheduled Enter would now have fired
    assert.deepEqual(wire(writes, 'A:0'), []);
    assert.deepEqual(await page.evaluate(() => composeRecovery.map(record => ({kind: record.result.kind, text: record.text}))),
      [{kind: 'uncertain', text: 'must not submit'}]);
    assert.equal(await page.evaluate(() => active.conn.terminal.isOpen()), true, 'failure is not hidden by a disconnect');
  }, false, 'en');
});

test('actual replay submission settles before queued Ctrl-C or newly typed keys', async () => {
  await harness(async (page, _api, _sockets, writes) => {
    await open(page); await page.locator('#compose-text').fill('FIFO prompt');
    await page.evaluate(() => {
      const w = window as any;
      w.enterTimers = []; w.realTimer = window.setTimeout;
      window.setTimeout = ((callback: () => void, ms: number, ...args: any[]) => ms === 60
        ? (w.enterTimers.push(callback), 0) : w.realTimer(callback, ms, ...args)) as typeof window.setTimeout;
      active.conn.replaying = true;
    });
    await page.locator('#compose-send').click();
    await page.evaluate(() => {
      active.sendRaw(Uint8Array.of(3), true);
      active.conn.replaying = false; active.flushReplayInput(active.conn);
      active.sendRaw(Uint8Array.of(120));
    });
    assert.deepEqual(wire(writes, 'A:0'), ['FIFO prompt']);
    assert.equal(await page.evaluate(() => composeOwner.pending), true);
    await page.evaluate(() => {
      const w = window as any; window.setTimeout = w.realTimer;
      for (const run of w.enterTimers.splice(0)) run();
    });
    await page.waitForFunction(() => active.conn.activeHumanInput === null);
    await page.waitForTimeout(30);
    assert.deepEqual(wire(writes, 'A:0'), ['FIFO prompt', '\r', '\x03', 'x']);
    assert.equal(await page.evaluate(() => composeRecovery.length), 0);
  }, false, 'en');
});

test('closing a replay-pending composer cancels the whole operation before another session opens', async () => {
  await harness(async (page, _api, _sockets, writes) => {
    await open(page); await page.locator('#compose-text').fill('cancel me');
    await page.evaluate(() => {active.conn.replaying = true; (window as any).originalConnection = active.conn;});
    await page.locator('#compose-send').click(); await closeCompose(page);
    await page.evaluate(() => {
      const old = (window as any).originalConnection;
      old.replaying = false; active.flushReplayInput(old);
    });
    assert.equal(await page.evaluate(() => active.conn === (window as any).originalConnection), true);
    assert.equal(await page.evaluate(() => active.conn.terminal.isOpen()), true);
    assert.deepEqual(wire(writes, 'A:0'), [], 'cancellation works before any session detach');
    await select(page, 'B');
    assert.deepEqual(wire(writes, 'A:0'), []); assert.deepEqual(wire(writes, 'B:0'), []);
  }, false, 'en');
});
