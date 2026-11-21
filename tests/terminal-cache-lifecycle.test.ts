// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createTargetRegistry} from '../static/pane-actions.ts';

const source = readFileSync('static/app.js', 'utf8');
function fixture() {
  const targets = createTargetRegistry();
  const context = vm.createContext({paneTargets: targets, localMeshEffectsAllowed: () => !context.meshPageSuspended,
    meshPageFinal: false, meshStopped: false, meshPageSuspended: false, meshPageCache: null,
    meshCacheFocusRevision: 0, meshPageEpoch: 0, meshContext: {}, panes: [] as any[], document: {activeElement: null},
    disposeBackendAccountSettings() {}, startBackendAccountSettings: async () => {},
    flowGeneration: 0, flowController: null, flowing: false,
    projectsGeneration: 0, workGeneration: 0, projectsController: null, workController: null,
    inventoryPoller: null, listBatch: {cancel() {}, request() {}}, pageSignals: null,
    localTerminalHandles: [], retirePageInput() {}, renderComposeStatus() {}, projecting: false,
    setFlow() {},
    inlineDictation: null, renderInlineDictation() {},
    startInventory: async () => {}});
  vm.runInContext(source.slice(source.indexOf('function suspendLocalPage()'), source.indexOf('function disposeLocalInputScopes()')), context);
  function pane(id: string, created: number | null) {
    const p = {id, conn: {name: id, created} as any, actionView: 0, actionDisposed: false,
      el: {contains: () => false}, attached: [] as any[],
      invalidateActionView() {this.actionView++;}, detach() {this.conn = null;},
      attach(id: string, options: any) {this.conn = {name: id, created: targets.identity(id)!.created}; this.attached.push(options);}};
    context.panes.push(p); return p;
  }
  let issue = 0;
  const listing = (rows: any[]) => {
    assert.equal(targets.applyInventory(++issue, rows), true);
    context.restorePendingCachedTerminals();
  };
  return {context, pane, listing};
}

test('suspension closes account and Flow controllers; resumption restarts them once', async () => {
  const f = fixture(), calls: string[] = [];
  f.context.flowing = true;
  f.context.flowController = {close() {calls.push('flow-close');}};
  f.context.disposeBackendAccountSettings = () => calls.push('accounts-close');
  f.context.startBackendAccountSettings = () => calls.push('accounts-start');
  f.context.setFlow = (enabled: boolean) => calls.push(`flow-${enabled}`);
  f.context.suspendLocalPage();
  assert.deepEqual(calls, ['accounts-close', 'flow-close']);
  await f.context.resumeLocalPage();
  assert.deepEqual(calls, ['accounts-close', 'flow-close', 'accounts-start', 'flow-true']);
  await f.context.resumeLocalPage();
  assert.equal(calls.length, 4);
});

test('a stale resume cannot restart Flow after a second suspension', async () => {
  const f = fixture(), calls: string[] = [];
  f.context.flowing = true;
  f.context.setFlow = () => calls.push('flow-start');
  f.context.suspendLocalPage();
  let release!: () => void;
  f.context.startInventory = () => new Promise<void>(resolve => {release = resolve;});
  const resume = f.context.resumeLocalPage();
  f.context.suspendLocalPage();
  release(); await resume;
  assert.deepEqual(calls, []);
});

test('second suspension retains B while current A/3 replaces only its own original A/1 binding', async () => {
  const f = fixture(), a = f.pane('A', 1), b = f.pane('B', 2);
  f.context.suspendLocalPage();
  let release!: () => void;
  f.context.startInventory = () => new Promise<void>(resolve => {release = resolve;});
  const firstResume = f.context.resumeLocalPage();
  a.conn = {name: 'A', created: 3, initializing: true};
  f.context.suspendLocalPage();
  assert.deepEqual(Array.from(f.context.meshPageCache.bindings, (x: any) => [x.id, x.created]), [['A', 3], ['B', 2]]);
  release(); await firstResume;
  f.context.startInventory = async () => {};
  await f.context.resumeLocalPage();
  f.listing([{id: 'A', name: 'A', created: 3}, {id: 'B', name: 'B', created: 2}]);
  assert.equal(a.conn.created, 3); assert.equal(b.conn.created, 2); assert.equal(f.context.meshPageCache, null);
});

for (const change of ['away-and-back', 'removed', 'disposed']) test(`cache never revives ${change} B`, async () => {
  const f = fixture(), a = f.pane('A', 1), b = f.pane('B', 2);
  f.context.suspendLocalPage(); await f.context.resumeLocalPage();
  if (change === 'away-and-back') {b.id = 'C'; b.invalidateActionView(); b.id = 'B'; b.invalidateActionView();}
  if (change === 'removed') f.context.panes.splice(f.context.panes.indexOf(b), 1);
  if (change === 'disposed') b.actionDisposed = true;
  a.conn = {name: 'A', created: 1};
  f.context.suspendLocalPage(); await f.context.resumeLocalPage();
  f.listing([{id: 'A', name: 'A', created: 1}, {id: 'B', name: 'B', created: 2}]);
  assert.equal(b.conn, null); assert.equal(b.attached.length, 0);
});

for (const end of ['match', 'changed-created', 'missing', 'changed-name']) test(`unknown identity retains original A/1 until ${end}`, async () => {
  const f = fixture(), a = f.pane('A', 1);
  f.context.suspendLocalPage(); await f.context.resumeLocalPage();
  f.listing([{id: 'A', name: 'A', created: null}]);
  assert.equal(a.conn, null); assert.equal(f.context.meshPageCache.bindings[0].created, 1);
  f.listing(end === 'missing' ? [] : [{id: 'A', name: end === 'changed-name' ? 'other' : 'A', created: end === 'changed-created' ? 2 : 1}]);
  assert.equal(a.attached.length, end === 'match' ? 1 : 0); assert.equal(f.context.meshPageCache, null);
});

test('explicit view change retires an unknown pending binding even if the same id returns later', async () => {
  const f = fixture(), a = f.pane('A', 1);
  f.context.suspendLocalPage(); await f.context.resumeLocalPage();
  f.listing([{id: 'A', name: 'A', created: null}]);
  a.invalidateActionView(); a.id = 'C';
  f.listing([{id: 'A', name: 'A', created: null}]);
  assert.equal(f.context.meshPageCache, null);
  a.id = 'A'; a.invalidateActionView();
  f.listing([{id: 'A', name: 'A', created: 1}]); assert.equal(a.attached.length, 0);
});

test('an original unknown cached incarnation never acquires identity from a later positive listing', async () => {
  const f = fixture(), a = f.pane('A', null);
  f.context.suspendLocalPage(); await f.context.resumeLocalPage();
  f.listing([{id: 'A', name: 'A', created: null}]);
  assert.equal(f.context.meshPageCache, null);
  f.listing([{id: 'A', name: 'A', created: 1}]);
  assert.equal(a.conn, null); assert.equal(a.attached.length, 0);
});

test('an explicit connecting selection retires its original cached binding before the socket opens', async () => {
  const f = fixture(), a = f.pane('A', 1);
  f.context.suspendLocalPage(); await f.context.resumeLocalPage();
  f.listing([{id: 'A', name: 'A', created: null}]);
  const current = a.conn = {name: 'A', created: 2, initializing: true};
  f.listing([{id: 'A', name: 'A', created: 2}]);
  assert.equal(a.conn, current); assert.equal(a.attached.length, 0); assert.equal(f.context.meshPageCache, null);
});
