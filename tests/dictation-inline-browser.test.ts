// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
// MESH_CHROMIUM: required actual-page browser tests, discovered by the browser shards.
// Actual application assets with test-owned API/media/socket peers; not phone or native-PTY proof.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test, harness, select, wire, type Sockets, type Writes} from '../checks/dictation-browser-fixture.ts';
import type {Page} from 'playwright-core';
import {waitFor} from './ptyhost-wire-lib.ts';

declare const inlineDictation: any;
declare const active: any;
declare const data: any;
declare function addPane(name: string): any;
declare function setActive(pane: any): void;
declare function refresh(): Promise<unknown>;

async function mode(sockets: Sockets, name: string): Promise<void> {
  const socket = sockets.get(name)?.[0]; assert.ok(socket, `original ${name} socket exists`);
  socket.send(Buffer.from('\x1b[?2004h'));
}
const captures = new WeakMap<Page, Map<string, {created: number; previous: string | null}>>();
async function hold(page: Page, name = 'A'): Promise<void> {
  const capture = await page.evaluate(name => {
    const created = data.mesh.find((session: any) => session.name === name).created;
    return {created, previous: inlineDictation.session(name, created).requestId};
  }, name);
  if (!captures.has(page)) captures.set(page, new Map());
  captures.get(page)!.set(name, capture);
  const mic = page.locator(`.pane.active [data-act="dictate"]`);
  assert.equal(await mic.count(), 1); assert.equal(await mic.isVisible(), true);
  await mic.focus(); await page.keyboard.down('Enter');
  await page.waitForFunction(({name, created}) => inlineDictation.session(name, created).state === 'recording', {name, created: capture.created});
  await page.waitForTimeout(350); await page.keyboard.up('Enter');
}
async function finish(page: Page, api: any, name: string, text: string): Promise<void> {
  const capture = captures.get(page)?.get(name); assert.ok(capture, `${name} capture was started`);
  const {created, previous} = capture;
  await page.waitForFunction(({name, created, previous}) => {
    const id = inlineDictation.session(name, created).requestId;
    return typeof id === 'string' && id.length > 0 && id !== previous;
  }, {name, created, previous});
  const requestId = await page.evaluate(({name, created}) => inlineDictation.session(name, created).requestId, {name, created});
  assert.ok(requestId, `${name} keeps its current request identity`);
  for (let i = 0; !api.jobs.some((j: any) => j.request_id === requestId) && i < 500; i++) await page.waitForTimeout(10);
  const job = api.jobs.find((j: any) => j.request_id === requestId); assert.ok(job, `${name} audio admitted`);
  job.state = 'ready'; job.text = text; api.ack(name);
  await page.waitForFunction(({name, created}) => ['idle','inserted','settled'].includes(inlineDictation.session(name, created).state),
    {name, created});
}
function payload(writes: Writes, key: string): Buffer[] {return wire(writes, key).map(value => Buffer.from(value));}

for (const locale of ['en', 'fr']) for (const phone of [false, true]) {
  test(`${locale} ${phone ? 'phone' : 'desktop'} microphone explains service disable before local eligibility`, async () => {
    const catalog = JSON.parse(readFileSync(new URL(`../static/i18n/${locale}.json`, import.meta.url), 'utf8'));
    const codes = ['not_configured', 'invalid_configuration', 'runtime_unavailable', 'startup_timeout', 'worker_failed'];
    await harness(async (page, api, _sockets, writes) => {
      api.inventory.mesh[0]!.agent = {type: 'shell', foreground: true, status: 'idle'};
      let reason: unknown;
      await page.route('**/api/transcribe/config', route => route.fulfill({json: {enabled: false,
        disabled_reason: reason, message: '<img src=x onerror=alert(1)>'}}));
      for (reason of [...codes, undefined, '<img src=x onerror=alert(1)>']) {
        await page.reload();
        const key = codes.includes(reason as string) ? `dictation.inline.${reason}` : 'dictation.message.unavailable';
        const expected = catalog[key]; assert.equal(typeof expected, 'string');
        const mic = page.locator('.pane.active [data-act="dictate"]');
        const status = page.locator('.pane.active .p-inline-dictation-status');
        await page.waitForFunction(expected => document.querySelector('.pane.active [data-act="dictate"]')
          ?.getAttribute('title') === expected, expected);
        assert.equal(await mic.isVisible(), true); assert.equal(await status.isVisible(), true);
        assert.equal(await mic.getAttribute('aria-disabled'), 'true');
        assert.equal(await status.textContent(), expected);
        assert.equal(await mic.getAttribute('aria-describedby'), await status.getAttribute('id'));
        await mic.focus(); await page.keyboard.down('Enter'); await page.keyboard.up('Enter');
        const box = await mic.boundingBox(); assert.ok(box);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down(); await page.mouse.up();
        assert.equal(await page.evaluate(() => (window as any).micCalls), 0);
        assert.equal(await status.locator('img').count(), 0);
      }
      assert.equal(api.uploads.length, 0);
      assert.ok([...writes.values()].every(frames => frames.filter(Buffer.isBuffer).length === 0));
    }, false, locale, {rows: 24, cols: 80}, {hasTouch: phone, isMobile: phone,
      viewport: {width: phone ? 390 : 1280, height: 844}});
  });
}

for (const phone of [false, true]) test(`worker loss while polling explains the cause on ${phone ? 'phone' : 'desktop'}`, async () => {
  await harness(async (page, api, sockets, writes) => {
    await mode(sockets, 'A'); await hold(page);
    await waitFor('original audio admission', 5000, () => api.jobs.length === 1);
    const job = api.jobs[0]!;
    await page.route('**/api/transcribe/**', route => route.fulfill({json: route.request().url().endsWith('/config')
      ? {enabled: false, disabled_reason: 'worker_failed'} : {error: {code: 'disabled', message: '<b>private</b>'}},
    status: route.request().url().endsWith('/config') ? 200 : 503}));
    api.ack('A');
    await page.waitForFunction(() => inlineDictation.disabledReason() === 'worker_failed');
    const mic = page.locator('.pane.active [data-act="dictate"]');
    const status = page.locator('.pane.active .p-inline-dictation-status');
    assert.match(await mic.getAttribute('title') || '', /worker stopped or failed to start/);
    assert.equal(await status.textContent(), await mic.getAttribute('title'));
    assert.equal(await mic.getAttribute('aria-disabled'), 'true');
    assert.equal(await page.evaluate(() => inlineDictation.session('A', 1).requestId), job.request_id);
    assert.equal(await page.evaluate(() => inlineDictation.holds().length), 1);
    await mic.focus(); await page.keyboard.down('Enter'); await page.keyboard.up('Enter');
    assert.equal(await page.evaluate(() => (window as any).micCalls), 1);
    assert.equal(api.uploads.length, 1); assert.deepEqual(payload(writes, 'A:0'), []);
  }, false, 'en', {rows: 24, cols: 80}, {hasTouch: phone, isMobile: phone,
    viewport: {width: phone ? 390 : 1280, height: 844}});
});

test('the native microphone icon is painted in compact desktop and touch headers', async () => {
  for (const width of [1280, 390]) {
    await harness(async (page, api, sockets) => {
      const mic = page.locator('.pane.active [data-act="dictate"]');
      const icon = () => mic.evaluate(button => {
        const style = getComputedStyle(button, '::before');
        return {content: style.content, fontSize: parseFloat(style.fontSize), display: style.display,
          color: style.color, visibility: style.visibility};
      });
      await mode(sockets, 'A');
      await page.waitForFunction(() => document.querySelector('.pane.active [data-act="dictate"]')?.getAttribute('aria-disabled') === 'false');
      assert.equal(await mic.isVisible(), true);
      assert.ok((await mic.boundingBox())!.width >= 44);
      const enabled = await icon();
      assert.ok(enabled.content.includes('🎙'), `${width}px: the header must paint a microphone, not just an empty button`);
      assert.ok(enabled.fontSize >= 20, `${width}px: the icon must escape the compact header's zero-sized text`);
      assert.notEqual(enabled.display, 'none');
      assert.equal(enabled.visibility, 'visible');
      assert.notEqual(enabled.color, 'rgba(0, 0, 0, 0)');
      api.inventory.mesh[0]!.agent = {type:'shell', foreground:true, status:'idle'};
      await page.reload();
      await page.waitForFunction(() => dictationInventoryReady);
      assert.equal(await mic.getAttribute('aria-disabled'), 'true');
      assert.deepEqual(await icon(), enabled, 'disabled targets keep the visible microphone and explanatory title');
      assert.ok(await mic.getAttribute('title'));
      assert.equal(await page.evaluate(() => (window as any).micCalls), 0);
    }, false, 'fr', {rows:24, cols:80}, {viewport:{width,height:844}, hasTouch:width===390, isMobile:width===390});
  }
});

test('phone dictation stays editable until the corrected prompt is manually sent', async () => {
  await harness(async (page, api, sockets, writes) => {
    await mode(sockets, 'A');
    await hold(page); await finish(page, api, 'A', 'bonjour A');
    const line = page.locator('#line-text');
    assert.equal(await line.inputValue(), 'bonjour A');
    assert.equal(await page.locator('#line-direct').isVisible(), false);
    assert.deepEqual(payload(writes, 'A:0'), [], 'dictation sends neither terminal text nor Enter');
    assert.equal(await page.evaluate(() => active.inputLease.inputDirty), false, 'a local draft claims no native input');
    await line.fill('bonjour corrigé');
    assert.deepEqual(payload(writes, 'A:0'), [], 'editing is local too');
    await page.locator('#line button.primary').click();
    await waitFor('manual phone send', 5000, () => Buffer.concat(payload(writes, 'A:0')).toString().endsWith('\r'));
    assert.equal(Buffer.concat(payload(writes, 'A:0')).toString(), '\x1b[200~bonjour corrigé\x1b[201~\r');
    assert.equal(await line.inputValue(), '');
    assert.equal(api.jobs[0]!.outcome, 'inserted');
  }, false, 'fr', {rows:24, cols:80}, {hasTouch:true, isMobile:true, viewport:{width:390,height:844}});
});

test('staged phone dictation keeps its exact origin through corrections and another active column', async () => {
  await harness(async (page, api, sockets, writes) => {
    await mode(sockets, 'A'); await hold(page); await finish(page, api, 'A', 'from A');
    await page.evaluate(() => {(window as any).originalPane = active; addPane('B');});
    await page.waitForFunction(() => active.id === 'B' && active.conn?.terminal?.isOpen()
      && !active.conn.replaying && !active.conn.replayPending && !active.conn.draining);
    const line = page.locator('#line-text'); await line.fill('corrected A');
    await page.locator('#line button.primary').click();
    assert.equal(await line.inputValue(), 'corrected A');
    assert.deepEqual(payload(writes, 'A:0'), []); assert.deepEqual(payload(writes, 'B:0'), []);
    await page.evaluate(() => setActive((window as any).originalPane));
    await page.locator('#line button.primary').click();
    await waitFor('original exact destination manually submitted', 5000,
      () => Buffer.concat(payload(writes, 'A:0')).toString().endsWith('\r'));
    assert.equal(Buffer.concat(payload(writes, 'A:0')).toString(), '\x1b[200~corrected A\x1b[201~\r');
    assert.deepEqual(payload(writes, 'B:0'), []);
  }, false, 'en', {rows:24, cols:80}, {hasTouch:true, isMobile:true, viewport:{width:390,height:844}});
});

test('a staged phone draft cannot submit to a replacement incarnation, but explicit clear restores ordinary typing', async () => {
  await harness(async (page, api, sockets, writes) => {
    await mode(sockets, 'A'); await hold(page); await finish(page, api, 'A', 'old A');
    api.inventory.mesh[0]!.created = 11; await page.evaluate(() => refresh());
    await page.waitForFunction(() => active.conn?.created === 11 && active.conn.terminal?.isOpen()
      && !active.conn.replaying && !active.conn.replayPending && !active.conn.draining);
    const line = page.locator('#line-text'); await line.fill('corrected old A');
    await page.locator('#line button.primary').click();
    assert.equal(await line.inputValue(), 'corrected old A');
    assert.deepEqual(payload(writes, 'A:0'), []); assert.deepEqual(payload(writes, 'A:1'), []);
    await line.fill(''); await line.fill('ordinary new A');
    await page.locator('#line button.primary').click();
    await waitFor('ordinary replacement input', 5000, () => Buffer.concat(payload(writes, 'A:1')).toString().endsWith('\r'));
    assert.equal(Buffer.concat(payload(writes, 'A:1')).toString(), 'ordinary new A\r');
    assert.deepEqual(payload(writes, 'A:0'), []);
  }, false, 'en', {rows:24, cols:80}, {hasTouch:true, isMobile:true, viewport:{width:390,height:844}});
});

test('phone dictation never overwrites intervening field edits, even when cleared again', async () => {
  for (const clearAgain of [false, true]) await harness(async (page, api, sockets, writes) => {
    await mode(sockets, 'A'); await hold(page);
    await page.locator('#line-text').fill('texte personnel');
    if (clearAgain) await page.locator('#line-text').fill('');
    await finish(page, api, 'A', 'must not replace personal edits');
    assert.equal(await page.locator('#line-text').inputValue(), clearAgain ? '' : 'texte personnel');
    assert.deepEqual(payload(writes, 'A:0'), []);
    assert.equal(api.jobs[0]!.state, 'cancelled');
  }, false, 'fr', {rows:24, cols:80}, {hasTouch:true, isMobile:true, viewport:{width:390,height:844}});
});

test('late phone dictation cannot fill another active session input or reach the original terminal', async () => {
  await harness(async (page, api, sockets, writes) => {
    await mode(sockets, 'A'); await hold(page);
    await select(page, 'C'); await mode(sockets, 'C');
    await page.locator('#line-text').fill('C reste intact');
    const focused = await page.evaluate(() => document.activeElement?.id);
    await finish(page, api, 'A', 'late A');
    assert.equal(await page.locator('#line-text').inputValue(), 'C reste intact');
    assert.equal(await page.evaluate(() => document.activeElement?.id), focused);
    assert.deepEqual(payload(writes, 'A:0'), []);
    assert.deepEqual(payload(writes, 'C:0'), []);
    assert.equal(api.jobs[0]!.state, 'cancelled');
  }, false, 'fr', {rows:24, cols:80}, {hasTouch:true, isMobile:true, viewport:{width:390,height:844}});
});

test('desktop dictation remains native even at a phone-sized viewport', async () => {
  await harness(async (page, api, sockets, writes) => {
    await mode(sockets, 'A'); await hold(page); await finish(page, api, 'A', 'desktop unchanged');
    assert.deepEqual(payload(writes, 'A:0'), [Buffer.from('\x1b[200~desktop unchanged\x1b[201~')]);
    assert.equal(await page.locator('#line-text').inputValue(), '');
  }, false, 'en', {rows:24, cols:80}, {hasTouch:false, isMobile:false, viewport:{width:390,height:844}});
});

test('finish waits for B fresh request identity after an asynchronous recorder stop, not A idle state', async () => {
  await harness(async (page, api, sockets, writes) => {
    await mode(sockets, 'A'); await hold(page); await finish(page, api, 'A', 'first A');
    await select(page, 'B'); await mode(sockets, 'B');
    await page.evaluate(() => {
      const stop = MediaRecorder.prototype.stop;
      MediaRecorder.prototype.stop = function () {
        const stopped = this.onstop;
        this.onstop = event => {setTimeout(() => stopped?.call(this, event), 200);};
        stop.call(this);
      };
    });
    await hold(page, 'B'); await finish(page, api, 'B', 'fresh B');
    assert.equal(api.jobs.length, 2);
    assert.notEqual(api.jobs[0]!.request_id, api.jobs[1]!.request_id);
    assert.equal(api.jobs[1]!.session, 'B');
    assert.equal(Buffer.concat(payload(writes, 'B:0')).toString(), '\x1b[200~fresh B\x1b[201~');
  });
});

test('phone command dictation stays a draft instead of activating Direct', async () => {
  for (const text of ['/help', '$skill']) await harness(async (page, api, sockets, writes) => {
    await mode(sockets, 'A'); await hold(page); await finish(page, api, 'A', text);
    assert.equal(await page.locator('#line-text').inputValue(), text);
    assert.equal(await page.locator('#line-direct').isVisible(), false);
    assert.deepEqual(payload(writes, 'A:0'), []);
  }, false, 'fr', {rows:24, cols:80}, {hasTouch:true, isMobile:true, viewport:{width:390,height:844}});
});

test('phone dictation refuses pre-existing Direct or owned native input before permission', async () => {
  for (const leaveDirect of [false, true]) await harness(async (page, api, sockets, writes) => {
    await mode(sockets, 'A');
    await page.locator('#line-text').fill('/command');
    assert.equal(await page.locator('#line-direct').isVisible(), true);
    assert.equal(await page.evaluate(() => active.inputLease.inputDirty), true);
    if (leaveDirect) await page.locator('#line-direct').click();
    const mic = page.locator('.pane.active [data-act="dictate"]');
    await mic.focus(); await page.keyboard.down('Space'); await page.keyboard.up('Space');
    assert.equal(await page.evaluate(() => (window as any).micCalls), 0, 'pending native input blocks microphone acquisition');
    assert.equal(api.uploads.length, 0);
    assert.equal(Buffer.concat(payload(writes, 'A:0')).toString(), '/command');
    await page.locator('#line button.primary').click();
    await waitFor('manual submission of the existing Direct command', 5000,
      () => Buffer.concat(payload(writes, 'A:0')).toString().endsWith('\r'));
    assert.equal(Buffer.concat(payload(writes, 'A:0')).toString(), '/command\r', 'no transcript is appended to the existing native command');
  }, false, 'fr', {rows:24, cols:80}, {hasTouch:true, isMobile:true, viewport:{width:390,height:844}});
});

test('phone dictation preserves Direct input started while recognition was pending', async () => {
  await harness(async (page, api, sockets, writes) => {
    await mode(sockets, 'A'); await hold(page);
    await page.locator('#line-text').fill('/typed');
    await finish(page, api, 'A', 'must not be appended');
    assert.equal(await page.locator('#line-direct').isVisible(), true);
    assert.equal(Buffer.concat(payload(writes, 'A:0')).toString(), '/typed');
    assert.equal(api.jobs[0]!.state, 'cancelled');
  }, false, 'fr', {rows:24, cols:80}, {hasTouch:true, isMobile:true, viewport:{width:390,height:844}});
});

test('clearing a dictated phone draft permits a distinct recording without Discard', async () => {
  await harness(async (page, api, sockets, writes) => {
    await mode(sockets, 'A'); await hold(page); await finish(page, api, 'A', 'premier brouillon');
    await page.locator('#line-text').fill('');
    await hold(page); await finish(page, api, 'A', 'nouveau brouillon');
    assert.equal(await page.locator('#line-text').inputValue(), 'nouveau brouillon');
    assert.equal(api.jobs.length, 2);
    assert.notEqual(api.jobs[0]!.request_id, api.jobs[1]!.request_id);
    assert.deepEqual(payload(writes, 'A:0'), []);
  }, false, 'fr', {rows:24, cols:80}, {hasTouch:true, isMobile:true, viewport:{width:390,height:844}});
});

test('phone dictation never stages a draft while the keyboard Ctrl mode is armed', async () => {
  for (const duringRecognition of [false, true]) await harness(async (page, api, sockets, writes) => {
    await mode(sockets, 'A');
    if (duringRecognition) await hold(page);
    await page.locator('#keys [data-k="ctrl"]').click();
    if (duringRecognition) await finish(page, api, 'A', 'must remain local and editable');
    else {
      const mic = page.locator('.pane.active [data-act="dictate"]');
      await mic.focus(); await page.keyboard.down('Space'); await page.keyboard.up('Space');
      assert.equal(await page.evaluate(() => (window as any).micCalls), 0);
    }
    assert.equal(await page.locator('#line-text').inputValue(), '');
    assert.deepEqual(payload(writes, 'A:0'), []);
  }, false, 'fr', {rows:24, cols:80}, {hasTouch:true, isMobile:true, viewport:{width:390,height:844}});
});

// The original phone Direct expectation is superseded by the editable-phone-prompt request.
test('AC-2: phone editable prompt and support boundary', async () => {
  await harness(async (page, api, sockets, writes) => {
    await mode(sockets, 'A');
    await hold(page); await finish(page, api, 'A', 'bonjour A');
    assert.deepEqual(payload(writes, 'A:0'), [], 'touch dictation stages an editable prompt');
    assert.equal(await page.locator('#line-direct').isVisible(), false);
    assert.equal(await page.locator('#line-text').inputValue(), 'bonjour A');
    const line = page.locator('#line-text');
    await page.locator('#line button.primary').click();
    await waitFor('explicit phone submission', 5000, () => Buffer.concat(payload(writes, 'A:0')).toString().endsWith('\r'));
    assert.equal(Buffer.concat(payload(writes, 'A:0')).toString(), '\x1b[200~bonjour A\x1b[201~\r');
    // Explicitly typing a slash still starts the existing Direct feature.
    await line.fill('/');
    assert.equal(await page.locator('#line-direct').isVisible(), true);
    await line.fill('typed natively');
    assert.equal(await line.inputValue(), '', 'Direct adapter commits keyboard text rather than retaining a shadow');
    assert.equal(Buffer.concat(payload(writes, 'A:0')).toString(), '\x1b[200~bonjour A\x1b[201~\r/typed natively', 'ordinary Direct typing still uses the original channel');
    await line.press('Backspace');
    assert.ok(Buffer.concat(payload(writes, 'A:0')).toString().endsWith('\x7f'), 'DEL reaches native input');
    await page.locator('#keys [data-k="left"]').click();
    assert.ok(Buffer.concat(payload(writes, 'A:0')).toString().endsWith('\x1b[D'), 'native arrow reaches original channel');
    await page.locator('#keys [data-k="enter"]').click();
    assert.ok(Buffer.concat(payload(writes, 'A:0')).toString().endsWith('\r'), 'manual Enter reaches native input');
    assert.equal(await page.locator('#line-direct').isVisible(), false, 'manual Enter exits Direct');
  }, false, 'fr', {rows:24, cols:80}, {hasTouch:true, isMobile:true, viewport:{width:390,height:844}});
  await harness(async (page, api, sockets, writes) => {
    await mode(sockets, 'A'); await hold(page); await finish(page, api, 'A', 'bonjour A');
    const before = Buffer.concat(payload(writes, 'A:0'));
    const line = page.locator('#line-text');
    // A staged dictation is an ordinary editable phone field, not Direct input.
    assert.equal(await page.locator('#line-direct').isVisible(), false);
    await line.fill('keep me');
    assert.equal(await line.inputValue(), 'keep me', 'ordinary phone text is still present before microphone');
    const mic = page.locator('.pane.active [data-act="dictate"]');
    await mic.focus(); await page.keyboard.down('Space');
    assert.equal(await page.evaluate(() => (window as any).micCalls), 1, 'occupied phone field prevents additional media permission');
    assert.equal(await page.locator('#line-text').inputValue(), 'keep me', 'occupied field is preserved');
    assert.ok((await page.locator('.pane.active .p-inline-dictation-status').innerText()).trim());
    assert.equal(await page.locator('.pane.active [data-act="dictate"]').isVisible(), true);
    assert.equal(api.uploads.length, 1);
    assert.deepEqual(Buffer.concat(payload(writes, 'A:0')), before, 'occupied phone text is neither erased nor transferred');
  }, false, 'fr', {rows:24, cols:80}, {hasTouch:true, isMobile:true, viewport:{width:390,height:844}});

  await harness(async (page, api) => {
    // Change only the fake peer's inventory response, then reload so production consumes it.
    api.inventory.mesh[0]!.agent = {type:'shell', foreground:true, status:'idle'};
    await page.reload(); await page.waitForFunction(() => dictationInventoryReady);
    const mic = page.locator('.pane.active [data-act="dictate"]');
    assert.equal(await mic.isVisible(), true); assert.equal(await mic.getAttribute('aria-disabled'), 'true');
    assert.ok((await mic.getAttribute('title'))?.trim(), 'unsupported target reason is visible');
    await mic.focus(); await page.keyboard.down('Space'); await page.keyboard.up('Space');
    assert.equal(await page.evaluate(() => (window as any).micCalls), 0);
    assert.equal(api.uploads.length, 0);
  });
});

test('AC-8: released channel retention and capture detachment', async () => {
  await harness(async (page, api, sockets, writes) => {
    await mode(sockets, 'A'); await hold(page, 'A');
    // Release has already stopped tracks before any response is admitted.
    await page.waitForFunction(() => (window as any).micStreams.length === 1
      && (window as any).micStreams[0].getTracks().every((track: MediaStreamTrack) => track.readyState === 'ended'));
    await page.waitForFunction(() => typeof inlineDictation.session('A', 1).requestId === 'string');
    await select(page, 'B'); await mode(sockets, 'B'); await hold(page, 'B'); await select(page, 'C'); await mode(sockets, 'C');
    const cPane = await page.locator('.pane.active').getAttribute('data-pane-id').catch(() => null);
    for (let i=0; i<500 && api.jobs.length<2; i++) await page.waitForTimeout(10);
    assert.equal(api.jobs.length, 2); api.jobs[0]!.state='ready'; api.jobs[0]!.text='late A'; api.ack('A');
    api.jobs[1]!.state='ready'; api.jobs[1]!.text='late B'; api.ack('B');
    await page.waitForFunction(() => inlineDictation.session('A',1).state === 'idle' && inlineDictation.session('B',2).state === 'idle');
    assert.deepEqual(payload(writes,'A:0'), [Buffer.from('\x1b[200~late A\x1b[201~')]);
    assert.deepEqual(payload(writes,'B:0'), [Buffer.from('\x1b[200~late B\x1b[201~')]); assert.deepEqual(payload(writes,'C:0'), []);
    assert.equal(api.jobs[0]!.session,'A'); assert.ok(sockets.get('A')?.length === 1, 'no replacement socket');
    assert.equal(await page.locator('.pane.active [data-act="dictate"]').isVisible(), true);
    assert.equal(cPane, await page.locator('.pane.active').getAttribute('data-pane-id').catch(() => null));

    // A separate unreleased hold is cancelled by hiding its page context; late capture cannot upload.
    await select(page,'C'); await mode(sockets,'C'); await page.locator('.pane.active [data-act="dictate"]').focus();
    await page.keyboard.down('Space'); await page.waitForFunction(() => inlineDictation.session('C',3).state === 'recording');
    await page.evaluate(() => {Object.defineProperty(document, 'hidden', {configurable:true, value:true}); document.dispatchEvent(new Event('visibilitychange'));});
    await page.waitForFunction(() => inlineDictation.session('C',3).state !== 'recording');
    assert.equal(api.uploads.length, 2); assert.equal(await page.evaluate(() => (window as any).micStreams.at(-1).getTracks().every((t: MediaStreamTrack) => t.readyState === 'ended')), true);
  });
  await harness(async (page, api, sockets, writes) => {
    await mode(sockets,'A'); await hold(page,'A');
    for(let i=0;!api.jobs.length&&i<500;i++) await page.waitForTimeout(10);
    assert.equal(api.jobs.length,1);
    sockets.get('A')![0]!.close({code:1000,reason:'original channel closed'});
    api.jobs[0]!.state='ready'; api.jobs[0]!.text='must not retarget'; api.ack('A');
    await page.waitForFunction(() => inlineDictation.session('A', 1).requestId === null);
    await waitFor('closed original job retired', 5000, () => api.jobs[0]!.state === 'cancelled' || api.jobs[0]!.state === 'settled');
    assert.deepEqual(payload(writes,'A:0'),[],'closed original channel cannot receive remaining payload');
    assert.equal(sockets.get('A')?.length,1,'late job does not reconnect by session name');
  });
});

test('AC-9: input interference and authenticated lifecycle cleanup', async () => {
  await harness(async (page, api, sockets, writes) => {
    await mode(sockets,'A'); await hold(page);
    for (let i=0; !api.jobs.length && i<500; i++) await page.waitForTimeout(10);
    assert.equal(api.jobs.length,1);
    // Observed user keystroke on original session invalidates this result before delivery.
    await page.locator('.pane.active .xterm-helper-textarea').focus(); await page.keyboard.type('human');
    api.jobs[0]!.state='ready'; api.jobs[0]!.text='stale'; api.ack('A');
    await page.waitForFunction(() => ['idle','error'].includes(inlineDictation.session('A',1).state));
    assert.equal(Buffer.concat(payload(writes,'A:0')).toString(), 'human', 'only observed human native bytes, no stale transcript payload');
    assert.ok(api.seen.some(path => /\/cancel$/.test(path)) || api.seen.some(path => /\/settle$/.test(path)));
  });
  // Keep a real outstanding, unacknowledged job across final disposal, then deliver its late result.
  await harness(async (page, api, sockets, writes) => {
    await mode(sockets, 'A'); await hold(page);
    await page.waitForFunction(() => typeof inlineDictation.session('A', 1).requestId === 'string');
    for (let i = 0; !api.jobs.length && i < 500; i++) await page.waitForTimeout(10);
    assert.equal(api.jobs.length, 1);
    const prior = await page.evaluate(() => (window as any).micCalls);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    api.jobs[0]!.state = 'ready'; api.jobs[0]!.text = 'late after final disposal'; api.ack('A');
    const mic = page.locator('.pane.active [data-act="dictate"]');
    await mic.focus(); await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => (window as any).micCalls), prior, 'a new hold cannot request media after final disposal');
    assert.deepEqual(payload(writes, 'A:0'), []); assert.equal(sockets.get('A')?.length, 1);
    assert.equal(api.uploads.length, 1);
  });
  // Authentication refusal retires the real page controller; later holds cannot reacquire media.
  await harness(async (page, api, _sockets, writes) => {
    await mode(_sockets,'A');
    await page.route('**/api/transcribe', route => route.fulfill({status:401, json:{error:{code:'authentication'}}}));
    await hold(page,'A');
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => inlineDictation.reason(inlineDictation.session('A',1))), 'unavailable', '401 revokes controller authority');
    assert.equal(await page.evaluate(() => (window as any).micStreams[0].getTracks().every((t:MediaStreamTrack)=>t.readyState==='ended')), true);
    assert.deepEqual(payload(writes,'A:0'), []); assert.equal(api.uploads.length,0);
    const calls = await page.evaluate(() => (window as any).micCalls);
    const mic=page.locator('.pane.active [data-act="dictate"]'); await mic.focus(); await page.keyboard.down('Space'); await page.keyboard.up('Space');
    assert.equal(await page.evaluate(() => (window as any).micCalls),calls,'auth refusal prevents another media acquisition');
  });
  // Page-cache suspension revokes the retained insertion authority while allowing only old-job controls.
  await harness(async (page, api, sockets, writes) => {
    await mode(sockets,'A'); await hold(page,'A');
    for(let i=0;!api.jobs.length&&i<500;i++) await page.waitForTimeout(10);
    assert.equal(api.jobs.length,1);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
    api.jobs[0]!.state='ready'; api.jobs[0]!.text='must not replay'; api.ack('A');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
    await page.waitForTimeout(500);
    assert.deepEqual(payload(writes,'A:0'),[],'cache suspension revokes paste authority');
    assert.equal(api.uploads.length,1); assert.ok(api.seen.some(path=>/\/cancel$/.test(path)) || api.seen.some(path=>/\/\d+$/.test(path)), `only old-job control cleanup is permitted: ${api.seen.join(',')}`);
    for (const [key, frames] of writes) if (key.startsWith('A:') && key !== 'A:0') assert.deepEqual(frames.filter(frame=>typeof frame!=='string'),[], 'resumed replacement channel receives no old-job payload');
  });
});

test('AC-12: A and B complete while C stays unchanged', async () => {
  await harness(async (page, api, sockets, writes) => {
    await mode(sockets,'A'); await hold(page,'A'); await select(page,'B'); await mode(sockets,'B');
    await hold(page,'B'); await select(page,'C');
    const input = page.locator('.pane.active .xterm-helper-textarea'); await input.focus(); await page.keyboard.type('C unchanged');
    const focusBefore = await page.evaluate(() => document.activeElement?.outerHTML ?? null);
    const geometryBefore = await page.locator('.pane.active .xterm').boundingBox();
    assert.ok(geometryBefore);
    for (let i=0; api.jobs.length<2 && i<500; i++) await page.waitForTimeout(10);
    assert.deepEqual(api.jobs.map(j=>j.session), ['A','B']);
    api.jobs[0]!.state='ready'; api.jobs[0]!.text='alpha'; api.ack('A');
    api.jobs[1]!.state='ready'; api.jobs[1]!.text='beta'; api.ack('B');
    await page.waitForFunction(() => inlineDictation.session('A',1).state === 'idle' && inlineDictation.session('B',2).state === 'idle');
    assert.deepEqual(payload(writes,'A:0'), [Buffer.from('\x1b[200~alpha\x1b[201~')]);
    assert.deepEqual(payload(writes,'B:0'), [Buffer.from('\x1b[200~beta\x1b[201~')]);
    assert.equal(Buffer.concat(payload(writes,'C:0')).toString(), 'C unchanged', 'per-keystroke websocket frames are coalesced for oracle');
    assert.deepEqual(await page.locator('.pane.active .xterm').boundingBox(), geometryBefore);
    assert.equal(await page.evaluate(() => document.activeElement?.outerHTML ?? null), focusBefore);
    assert.equal(sockets.get('A')?.length,1); assert.equal(sockets.get('B')?.length,1);
    assert.equal(api.jobs.length,2); assert.equal(api.uploads.length,2);
  });
});
