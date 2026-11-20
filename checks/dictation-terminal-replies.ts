// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test, harness, open, closeCompose, select, typeNative, wire, observeOutput} from './dictation-browser-fixture.ts';

declare const active: any, dictation: any;

for (const [name, prefix, body, visible] of [
  ['printable output', [...Buffer.from('RETIRED-A-TEXT')], [...Buffer.from('visible')], 'visible'],
  ['CSI prefix', [27, 91, 54], [110], 'n'],
  ['whole query', [27, 91, 54, 110], [...Buffer.from('visible')], 'visible'],
  ['UTF8 prefix', [194], [155, 54, 110], '6n'],
] as const) test(`retired real queued A ${name} cannot mutate B parser/decoder admission`, async () => {
  await harness(async (page, _api, sockets, writes) => {
    await page.evaluate(([argument0]) => {active.conn.ws.dispatchEvent(new MessageEvent('message',{data:new Uint8Array(argument0).buffer}));active.show('B');setActive(active);}, [prefix]);
    await page.waitForFunction(() => active.id === 'B' && active.conn?.terminal?.isOpen());
    await observeOutput(page, 'bPackets', 'unB');
    sockets.get('B')![0]!.send(Buffer.from(body)); await page.waitForFunction(() => (window as any).bPackets === 1);
    await page.evaluate(() => (new Promise(resolve=>active.term.write("",resolve)))); await page.waitForTimeout(50);
    assert.deepEqual(wire(writes, 'B:0'), [], 'retired queued bytes cannot create a query completed by ordinary B output');
    assert.equal(await page.evaluate(() => (active.term.buffer.active.getLine(0).translateToString(true))), visible);
    sockets.get('B')![0]!.send(Buffer.from('\x1b[6n'));
    for (let i = 0; !wire(writes, 'B:0').length && i < 200; i++) await page.waitForTimeout(10);
    assert.equal(wire(writes, 'B:0').length, 1); assert.match(wire(writes, 'B:0')[0]!, /^\x1b\[\d+;\d+R$/);
    assert.equal(await page.evaluate(() => (active.inputLease.dirty)), false);
    await page.evaluate(() => (window.unB()));
  });
});

test('a real asynchronous old parse continuation cannot resume into replacement B', async () => {
  await harness(async (page, _api, sockets, writes) => {
    await page.evaluate(() => {active.term._core._inputHandler._parser.registerCsiHandler({final:'z'},()=>new Promise(resolve=>window.resumeOld=()=>resolve(true)));
      active.conn.ws.dispatchEvent(new MessageEvent('message',{data:new TextEncoder().encode('\x1b[z\x1b[6').buffer}));});
    await page.waitForFunction(() => typeof (window as any).resumeOld === 'function' && active.term._core._inputHandler._parseStack.paused);
    // The old parser continuation is deliberately paused until B has received n;
    // waiting for the new replay to finish parsing here would deadlock the test.
    await select(page, 'B', false);
    await observeOutput(page, 'bPackets', 'unB');
    sockets.get('B')![0]!.send(Buffer.from('n')); await page.waitForFunction(() => (window as any).bPackets === 1);
    await page.evaluate(() => {window.resumeOld();});
    await page.evaluate(() => (new Promise(resolve=>active.term.write("",resolve)))); await page.waitForTimeout(50);
    assert.deepEqual(wire(writes, 'B:0'), [], 'old async continuation cannot leave a CSI prefix for B');
    assert.equal(await page.evaluate(() => (active.term.buffer.active.getLine(0).translateToString(true))), 'n');
    await page.evaluate(() => (new Promise(resolve=>active.term.write("LOCAL",resolve))));
    assert.equal(await page.evaluate(() => (active.term.buffer.active.getLine(0).translateToString(true))), 'nLOCAL');
    await page.evaluate(() => (window.resumeOld=null));
    sockets.get('B')![0]!.send(Buffer.from('\x1b[z\x1b[6n'));
    await page.waitForFunction(() => typeof (window as any).resumeOld === 'function' && active.term._core._inputHandler._parseStack.paused);
    await page.evaluate(() => (window.resumeOld()));
    for (let i = 0; !wire(writes, 'B:0').length && i < 200; i++) await page.waitForTimeout(10);
    assert.equal(wire(writes, 'B:0').length, 1);
  });
});

for (const [prefix, body] of [[[27, 91, 54], [110]], [[194], [155, 54, 110]]] as const) test(`already parsed A state ${JSON.stringify(prefix)} is retired at the binding boundary`, async () => {
  await harness(async (page, _api, sockets, writes) => {
    await page.evaluate(([argument0]) => {active.conn.ws.dispatchEvent(new MessageEvent('message',{data:new Uint8Array(argument0).buffer}));}, [prefix]);
    await page.evaluate(() => (new Promise(resolve=>active.term.write("",resolve))));
    await select(page, 'B');
    await observeOutput(page, 'bPackets', 'unB');
    sockets.get('B')![0]!.send(Buffer.from(body)); await page.waitForFunction(() => (window as any).bPackets === 1);
    await page.evaluate(() => (new Promise(resolve=>active.term.write("",resolve)))); await page.waitForTimeout(50);
    assert.deepEqual(wire(writes, 'B:0'), [], 'completed old parser/decoder state cannot cross connection generations');
  });
});

test('an old queued query cannot route a protocol reply into a replacement B connection', async () => {
  await harness(async (page, _api, sockets, writes) => {
    await page.evaluate(() => {const write=active.term.write.bind(active.term);let hold=true;
      active.term.write=(data,done)=>{if(hold && data instanceof Uint8Array){hold=false;window.oldOutput=()=>write(data,done);}else write(data,done);};});
    sockets.get('A')![0]!.send(Buffer.from('\x1b[6n'));
    await page.waitForFunction(() => typeof (window as any).oldOutput === 'function'); await select(page, 'B');
    await page.evaluate(() => (window.oldOutput())); await page.waitForTimeout(100);
    assert.deepEqual(wire(writes, 'B:0'), [], 'old output has no authority on B');
    assert.equal(await page.evaluate(() => (active.inputLease.dirty)), false);
  });
});

test('protocol replies preserve an existing human dirty bit and input revision', async () => {
  await harness(async (page, _api, sockets, writes) => {
    await typeNative(page, 'human prefix'); const revision = await page.evaluate(() => (active.inputLease.revision));
    sockets.get('A')![0]!.send(Buffer.from('\x1b[6n'));
    for (let i = 0; !wire(writes, 'A:0').some(v => v.endsWith('R')) && i < 200; i++) await page.waitForTimeout(10);
    assert.equal(await page.evaluate(() => (active.inputLease.dirty)), true);
    assert.equal(await page.evaluate(() => (active.inputLease.revision)), revision);
  });
});
test('visible terminal focus reports keep their legitimate connection without becoming human draft input', async () => {
  await harness(async (page, _api, sockets, writes) => {
    sockets.get('A')![0]!.send(Buffer.from('\x1b[?1004h'));
    for (let i = 0; !wire(writes, 'A:0').length && i < 200; i++) await page.waitForTimeout(10);
    await page.locator('.pane.active .xterm-helper-textarea').evaluate(e => (e as HTMLElement).focus());
    await page.waitForTimeout(50); assert.equal(wire(writes, 'A:0').at(-1), '\x1b[I');
    await open(page); await page.waitForTimeout(50); assert.equal(wire(writes, 'A:0').at(-1), '\x1b[O');
    assert.equal(await page.evaluate(() => (active.inputLease.dirty)), false);

  });
});

for (const origin of ['keyboard', 'paste', 'composition']) test(`${origin} still uses native H/scope, even if its bytes look like a reply`, async () => {
  await harness(async (page, _api, _sockets, writes) => {
    const before = await page.evaluate(() => (active.inputLease.revision)) as number;
    if (origin === 'keyboard') await typeNative(page, 'human');
    if (origin === 'paste') await page.evaluate(() => (active.term.paste("\x1b[1;1R")));
    if (origin === 'composition') {
      await page.locator('.pane.active .xterm-helper-textarea').evaluate(e => (e as HTMLElement).focus());
      await page.keyboard.insertText('écrit');
    }
    assert.equal(await page.evaluate(() => (active.inputLease.dirty)), true);
    assert.equal((await page.evaluate(() => (active.inputLease.revision)) as number) > before, true);
    assert.ok(wire(writes, 'A:0').join('').length);
    await open(page);
    await closeCompose(page);
  });
});
