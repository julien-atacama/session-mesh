// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
// MESH_CHROMIUM: actual app with test-owned API/media/socket peers, no live terminal.
import assert from 'node:assert/strict';
import {test, harness, wire} from '../checks/dictation-browser-fixture.ts';
import type {Page} from 'playwright-core';

declare const active: any, inlineDictation: any;
declare function refresh(): Promise<unknown>;
declare function find(name: string): any;

async function consumeStatus(page: Page, status: string | null | undefined): Promise<void> {
  await page.evaluate(async expected => {
    await refresh();
    if (find('A')?.agent?.status !== expected) throw Error('fixture status was not consumed');
  }, status);
}

test('inline dictation refuses waiting and unverified agent states before microphone permission', async () => {
  for (const status of ['waiting', 'unknown', 'future-state', 'shell', null, undefined]) {
    await harness(async (page, api, sockets, writes) => {
      if (status === undefined) delete (api.inventory.mesh[0]!.agent as any).status;
      else api.inventory.mesh[0]!.agent.status = status as any;
      await consumeStatus(page, status);
      sockets.get('A')![0]!.send(Buffer.from('\x1b[?2004h'));
      await page.waitForFunction(() => active?.conn?.terminal?.dictationMode?.value === true);
      const mic = page.locator('.pane.active [data-act="dictate"]');
      await mic.focus();
      await page.keyboard.down('Space'); await page.keyboard.up('Space');
      assert.equal(await page.evaluate(() => (window as any).micCalls), 0, `${status}: no microphone acquisition`);
      assert.equal(api.uploads.length, 0, `${status}: no admission`);
      assert.deepEqual(wire(writes, 'A:0'), [], `${status}: no native payload`);
      assert.equal(await mic.isVisible(), true);
      assert.equal(await mic.getAttribute('aria-disabled'), 'true');
      const reason = await page.locator('.pane.active .p-inline-dictation-status').textContent();
      assert.equal(reason, 'Wait for the agent’s normal input prompt before dictating.');
    }, false, 'en');
  }
});

test('inline dictation cancels a released result when the original agent starts waiting', async () => {
  await harness(async (page, api, sockets, writes) => {
    sockets.get('A')![0]!.send(Buffer.from('\x1b[?2004h'));
    const mic = page.locator('.pane.active [data-act="dictate"]');
    await page.waitForFunction(() => document.querySelector('.pane.active [data-act="dictate"]')?.getAttribute('aria-disabled') === 'false');
    await mic.focus(); await page.keyboard.down('Enter');
    await page.waitForFunction(() => inlineDictation.session('A', 1).state === 'recording');
    await page.waitForTimeout(350); await page.keyboard.up('Enter');
    await page.waitForFunction(() => inlineDictation.session('A', 1).state === 'uploading');
    for (let i = 0; !api.jobs.length && i < 500; i++) await page.waitForTimeout(10);
    assert.equal(api.jobs.length, 1);
    assert.equal(await page.evaluate(() => (window as any).micCalls), 1);
    api.inventory.mesh[0]!.agent.status = 'waiting';
    await consumeStatus(page, 'waiting');
    api.jobs[0]!.state = 'ready'; api.jobs[0]!.text = 'must not answer the permission prompt'; api.ack('A');
    await page.waitForFunction(() => !inlineDictation.session('A', 1).outstanding);
    assert.deepEqual(wire(writes, 'A:0'), [], 'late transcript never reaches the waiting original prompt');
    assert.equal(api.jobs[0]!.state, 'cancelled', 'only old-job control cleanup runs');
    assert.ok(api.seen.some(path => path.endsWith('/cancel')));
    assert.equal(api.uploads.length, 1, 'no replay or new admission');
    assert.equal(await page.evaluate(() => (window as any).micCalls), 1);
    assert.equal(sockets.get('A')?.length, 1, 'no replacement channel');
  }, false, 'en');
});
