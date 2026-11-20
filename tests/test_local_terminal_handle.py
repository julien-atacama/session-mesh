# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Local Pane lifecycle through its actual handle and human-input lease."""

from pathlib import Path
import shutil
import subprocess

import pytest


def test_local_terminal_reconnect_lease_and_stale_callbacks():
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node required for the frontend source unit")
    script = r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const vm = require('node:vm');
const sockets = [], timers = new Map(), frames = [], output = [], states = [];
let serial = 0, refresh = async () => {}, fits = 0;
class Socket {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closes = 0; sockets.push(this); }
  send(value) {
    assert.equal(this.readyState, 1);
    this.sent.push(typeof value === 'string' ? JSON.parse(value) : Array.from(value));
  }
  close() { this.closes++; this.readyState = 3; return this.onclose?.(); }
  open() {
    this.readyState = 1;
    this.onopen();
    const url = new URL(this.url);
    this.onmessage({data: JSON.stringify({t: 'bound', name: decodeURIComponent(url.pathname.slice(4)),
      created: Number(url.searchParams.get('created'))})});
    this.bytes(this === sockets[0] ? 'first output' : '');
  }
  bytes(text) { this.onmessage({data: new TextEncoder().encode(text).buffer}); }
}
const context = vm.createContext({WebSocket: Socket, Uint8Array, TextEncoder, crypto,
  requireLocalMesh: () => {}, localMeshEffectsAllowed: () => true,
  localActionUnavailable: () => false, t: key => key, recoveredLineTarget: null,
  location: {protocol: 'https:', host: 'mesh.example'}, touch: false,
  inputLeaseTab: 'a'.repeat(32), humanInputScopes: new Map(), enc: new TextEncoder(), active: null, inventoryLoaded: true,
  lastListing: {management: {state: 'observed'}},
  lineDirect: null, lineRecovery: null, composeOwner: null, composeRecovery: [],
  renderInlineDictation: () => {}, cancelInlineCapture: () => {},
  // Exercise legacy raw input; acknowledged input is covered by the browser/native seam.
  find: name => ({id: name, kind: 'mesh', created: 42, pty_capabilities: []}),
  updateKeys: () => {}, flash: () => {}, refresh: () => refresh(),
  data: {mesh: [{id: 'shell/name', created: 42}]},
  requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
  cancelAnimationFrame: () => {},
  setTimeout: (callback, delay) => { const id = ++serial; timers.set(id, {callback, delay}); return id; },
  clearTimeout: id => timers.delete(id),
});
vm.runInContext(fs.readFileSync('static/pane-actions.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('static/sessions-progress.js', 'utf8') +
  '\nconst Progress = globalThis.MeshSessionsProgress;', context);
const app = fs.readFileSync('static/app.js', 'utf8');
const start = app.indexOf('function localTerminalSocketReady(');
const end = app.indexOf('function webLabel(s) {', start);
assert.ok(start > 0 && end > start);
vm.runInContext(app.slice(start, end) + '\nglobalThis.TestPane = Pane;', context);
const pane = Object.assign(Object.create(context.TestPane.prototype), {
  id: 'shell/name', conn: null, inputLeases: new Map(), inputAcks: new Map(), inputLeaseSlot: 7,
  recoveredLineDrafts: new Map(),
  limitedBanner: {hidden: true},
  limitedKeyboard: {hidden: true},
  termEl: {hidden: false, classList: {remove() {}}, removeAttribute() {}},
  term: {rows: 24, cols: 80, reset() { this.rows = 24; this.cols = 80; }, write(_data, done) { done?.(); }},
  fit: {fit() { fits++; pane.term.rows = 37; pane.term.cols = 143; }},
  setConn: (text, bad) => states.push([text, bad]),
  renderRetainedInput: () => {},
  output: (value, done) => {
    output.push(typeof value === 'string' ? value : new TextDecoder().decode(value));
    done?.();
  },
  resumeFollowing: () => {}, enterReplayGeometry: () => {}, leaveReplayGeometry: () => {},
  armAutoRedraw: () => {}, bumpAutoRedraw: () => {}, bumpInitialFollow: () => {},
  dropReaderAnchor: () => {},
});
const runDelay = delay => {
  const found = [...timers].filter(([, timer]) => timer.delay === delay);
  assert.equal(found.length, 1, `one timer at ${delay}`);
  const [id, timer] = found[0]; timers.delete(id); timer.callback();
};
const finishAttach = () => { frames.splice(0).forEach(callback => callback()); runDelay(100); };
(async () => {
  pane.attach('shell/name');
  assert.equal(sockets.length, 0, 'no attach before measured geometry');
  finishAttach();
  const first = sockets[0];
  assert.equal(first.url, 'wss://mesh.example/ws/shell%2Fname?rows=37&cols=143&replay_geometry=1&pty_size=1&created=42');
  assert.equal(first.binaryType, 'arraybuffer');
  assert.equal(pane.conn.ws, first, 'compatibility field is the actual local socket');
  assert.equal(pane.conn.terminal.isOpen(), false);
  assert.equal(pane.sendRaw(new TextEncoder().encode('offline')), false);
  first.open();
  assert.equal(pane.conn.terminal.isOpen(), true);
  assert.deepEqual(first.sent.map(frame => frame.t), ['h', 'r']);
  assert.equal(first.sent[0].dirty, false, 'refused pre-open input did not enter the lease');
  assert.deepEqual(first.sent[1], {t: 'r', rows: 37, cols: 143});
  const clientId = first.sent[0].client_id;
  pane.sendRaw(new TextEncoder().encode('abc'));
  pane.sendRaw(new Uint8Array([13]), true);
  assert.deepEqual(first.sent.slice(2), [{t: 'h', client_id: clientId, dirty: true},
    [97, 98, 99], [13], {t: 'h', client_id: clientId, dirty: false}]);
  const count = first.sent.length;
  pane.sendSize();
  assert.equal(first.sent.length, count, 'unchanged size does not send another resize');
  pane.sendSize(true);
  assert.equal(first.sent.length, count + 1);
  assert.deepEqual(output, ['\x1bcfirst output']);   // the replay starts from a reset terminal

  pane.sendRaw(new Uint8Array([120]));
  await first.close();
  assert.equal(pane.conn.terminal.isOpen(), false);
  runDelay(800);
  const second = sockets[1];
  second.open();
  assert.equal(second.sent[0].t, 'h');
  assert.equal(second.sent[0].client_id, clientId);
  assert.equal(second.sent[0].dirty, true, 'same lease survives reconnect');
  assert.equal(second.sent[1].t, 'r');
  first.bytes('stale reconnect output');
  const before = second.sent.length;
  first.onopen();
  assert.ok(first.closes >= 2, 'stale opened socket is closed');
  assert.equal(second.sent.length, before, 'stale open cannot emit a new lease or resize');

  let release;
  refresh = () => new Promise(resolve => { release = resolve; });
  const oldConnection = pane.conn;
  const closing = second.close();
  pane.attach('shell/name');
  finishAttach();
  const third = sockets[2]; third.open();
  const statusCount = states.length;
  release(); await closing;
  assert.equal(oldConnection.retry, 0, 'close returning from refresh cannot retry replacement');
  assert.equal(states.length, statusCount);
  assert.equal([...timers.values()].filter(timer => timer.delay === 800).length, 0);
  second.bytes('stale replaced output');
  pane.sendRaw(new Uint8Array([13]), true);
  assert.equal(third.sent.at(-1).dirty, false);
  pane.detach();
  const afterDetach = states.length;
  third.bytes('stale detached output'); third.onopen(); await third.onclose();
  assert.equal(pane.conn, null);
  assert.equal(states.length, afterDetach);
  assert.deepEqual(output, ['\x1bcfirst output', '\x1bc', '\x1bc']);   // each socket supplies its replay
  assert.throws(() => oldConnection.terminal.queueInput(new Uint8Array([1])), /disconnected/);
  pane.attach('shell/name');
  frames.splice(0).forEach(callback => callback());
  pane.detach();
  assert.equal([...timers.values()].filter(timer => timer.delay === 100).length, 0);
  assert.equal(sockets.length, 3, 'detach cancels pending initial attach');
  assert.equal(fits, 5, 'two fits per measured attach, one aborted fit, none on reconnect');
})().catch(error => { console.error(error); process.exitCode = 1; });
"""
    result = subprocess.run([node, "-e", script], cwd=Path(__file__).resolve().parents[1],
                            timeout=20, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
