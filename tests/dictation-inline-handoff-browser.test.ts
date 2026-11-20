// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
// MESH_CHROMIUM: actual-page retained-input tests, discovered by browser shards.

import assert from 'node:assert/strict';
import {test, harness, select, wire} from '../checks/dictation-browser-fixture.ts';

declare const active: any, inlineDictation: any;
declare function addPane(id: string): any;
declare function closePane(pane: any): void;

test('close and reopen A before its late result keeps the pending input owner usable for a fresh dictation', async () => {
  await harness(async (page, api, sockets, writes) => {
    sockets.get('A')![0].send(Buffer.from('\x1b[?2004h'));
    await page.waitForFunction(() => !inlineDictation.reason(inlineDictation.session('A', 1)));
    const mic = page.locator('.pane.active [data-act="dictate"]');
    await mic.focus(); await page.keyboard.down('Space');
    await page.waitForFunction(() => inlineDictation.session('A', 1).state === 'recording');
    await page.waitForTimeout(350); await page.keyboard.up('Space');
    await page.waitForFunction(() => inlineDictation.session('A', 1).state === 'uploading');
    for (let i = 0; api.jobs.length < 1 && i < 500; i++) await page.waitForTimeout(10);
    assert.equal(api.jobs.length, 1);
    const firstClient = (writes.get('A:0')!.filter(value => typeof value === 'string') as string[])
      .map(value => JSON.parse(value)).find(value => value.t === 'h').client_id;
    await page.evaluate(() => {const original = active; addPane('C'); closePane(original);});
    await select(page, 'A');
    assert.equal(sockets.get('A')!.length, 2);
    sockets.get('A')![1].send(Buffer.from('\x1b[?2004h'));
    await page.waitForFunction(() => active.conn.terminal.dictationMode.value === true);
    const reopenedClients = (writes.get('A:1')!.filter(value => typeof value === 'string') as string[])
      .map(value => JSON.parse(value)).filter(value => value.t === 'h').map(value => value.client_id);
    assert.deepEqual([...new Set(reopenedClients)], [firstClient], 'handoff precedes the new attachment’s first H');
    api.jobs[0].state = 'ready'; api.jobs[0].text = 'late original text'; api.ack('A');
    await page.waitForFunction(() => inlineDictation.session('A', 1).state === 'idle'
      && !inlineDictation.session('A', 1).outstanding);
    assert.deepEqual(wire(writes, 'A:0'), ['\x1b[200~late original text\x1b[201~']);
    assert.deepEqual(wire(writes, 'A:1'), [], 'old insertion never redirects to the reopened attachment');
    assert.equal(await page.evaluate(() => active.inputLease.dirty), true, 'no fake clean H after completion');
    assert.equal(await page.evaluate(() => active.inputLease.canInsert()), true);
    await mic.focus(); await page.keyboard.down('Space');
    await page.waitForFunction(() => inlineDictation.session('A', 1).state === 'recording');
    await page.waitForTimeout(350); await page.keyboard.up('Space');
    for (let i = 0; api.jobs.length < 2 && i < 500; i++) await page.waitForTimeout(10);
    assert.equal(api.jobs.length, 2); assert.notEqual(api.jobs[0].request_id, api.jobs[1].request_id);
    api.jobs[1].state = 'ready'; api.jobs[1].text = 'fresh text'; api.ack('A');
    await page.waitForFunction(() => !inlineDictation.session('A', 1).outstanding);
    assert.deepEqual(wire(writes, 'A:1'), ['\x1b[200~fresh text\x1b[201~']);
    assert.deepEqual(wire(writes, 'A:0'), ['\x1b[200~late original text\x1b[201~']);
  });
});
