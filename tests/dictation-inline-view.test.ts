// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getEventListeners} from 'node:events';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {createInlineDictationView} from '../static/dictation-inline-view.ts';

class Button extends EventTarget {
  captured = new Set<number>();
  closest() {return this;}
  setPointerCapture(id: number) {this.captured.add(id);}
  hasPointerCapture(id: number) {return this.captured.has(id);}
}
function fixture() {
  const old = new Map(['document', 'window', 'Element'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const a = new Button(), b = new Button(), calls: string[] = [];
  const document = Object.assign(new EventTarget(), {hidden: false, activeElement: a});
  const window = new EventTarget();
  for (const [key, value] of Object.entries({document, window, Element: Button}))
    Object.defineProperty(globalThis, key, {value, configurable: true});
  const sessions = new Map([[a, {name: 'A'}], [b, {name: 'B'}]]);
  const controller = {
    async press(s: {name: string}) {calls.push(`press:${s.name}`); return true;},
    release(s: {name: string}) {calls.push(`release:${s.name}`);},
    detach(s: {name: string}) {calls.push(`cancel:${s.name}`);},
  };
  const view = createInlineDictationView({resolve(button) {
    const session = sessions.get(button as unknown as Button);
    return session ? {session, controller} : null;
  }});
  function emit(type: string, button = a, fields: Record<string, unknown> = {}) {
    const event = new Event(type, {cancelable: true});
    Object.defineProperty(event, 'target', {value: button});
    for (const [key, value] of Object.entries(fields)) Object.defineProperty(event, key, {value});
    document.dispatchEvent(event); return event;
  }
  return {a, b, calls, document, window, view, emit, close() {
    view.dispose();
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }};
}

test('inline microphone releases its original pointer target after selection changes', () => {
  const f = fixture();
  try {
    f.emit('pointerdown', f.a, {button: 0, pointerId: 1});
    f.document.activeElement = f.b;
    f.emit('pointerup', f.b, {pointerId: 1});
    assert.deepEqual(f.calls, ['press:A', 'release:A']);
  } finally {f.close();}
});

test('inline keyboard hold releases once and blocks overlapping activation keys', () => {
  const f = fixture();
  try {
    f.emit('keydown', f.a, {key: ' '});
    f.emit('keydown', f.a, {key: 'Enter'});
    f.emit('keyup', f.a, {key: 'Enter'});
    f.emit('keyup', f.a, {key: ' '});
    f.emit('keyup', f.a, {key: ' '});
    assert.deepEqual(f.calls, ['press:A', 'release:A']);
  } finally {f.close();}
});

test('a cancelled keyboard release cannot cancel a newer pointer recording', () => {
  const f = fixture();
  try {
    f.emit('keydown', f.a, {key: ' '});
    f.emit('focusout', f.a);
    f.document.activeElement = f.b;
    f.emit('pointerdown', f.b, {button: 0, pointerId: 2});
    f.emit('focusout', f.a);
    f.emit('keyup', f.a, {key: ' '});
    f.emit('pointerup', f.b, {pointerId: 2});
    assert.deepEqual(f.calls, ['press:A', 'cancel:A', 'press:B', 'release:B']);
  } finally {f.close();}
});

test('lost pointer capture cancels only the matching active pointer', () => {
  const f = fixture();
  try {
    f.emit('pointerdown', f.a, {button: 0, pointerId: 1});
    f.emit('pointercancel', f.a, {pointerId: 2});
    f.a.captured.delete(1);
    f.emit('lostpointercapture', f.a, {pointerId: 1});
    f.emit('pointerup', f.a, {pointerId: 1});
    assert.deepEqual(f.calls, ['press:A', 'cancel:A']);
  } finally {f.close();}
});

test('window blur and page hiding stop inline holds without releasing audio for transcription', () => {
  const f = fixture();
  try {
    f.emit('pointerdown', f.a, {button: 0, pointerId: 1});
    f.window.dispatchEvent(new Event('blur'));
    f.emit('pointerup', f.a, {pointerId: 1});
    f.emit('keydown', f.a, {key: 'Enter'});
    f.document.hidden = true; f.emit('visibilitychange');
    f.emit('keyup', f.a, {key: 'Enter'});
    assert.deepEqual(f.calls, ['press:A', 'cancel:A', 'press:A', 'cancel:A']);
  } finally {f.close();}
});

test('disposing the delegated inline view removes its listeners', () => {
  const f = fixture();
  try {
    f.view.dispose();
    f.emit('pointerdown', f.a, {button: 0, pointerId: 1});
    f.emit('keydown', f.a, {key: ' '});
    assert.deepEqual(f.calls, []);
  } finally {f.close();}
});

for (const key of [' ', 'Enter']) test(`fresh ${JSON.stringify(key)} after window blur needs no sacrificial press`, () => {
  const f = fixture();
  try {
    f.emit('keydown', f.a, {key}); f.window.dispatchEvent(new Event('blur'));
    f.emit('keydown', f.a, {key, repeat: true});
    assert.deepEqual(f.calls, ['press:A', 'cancel:A']);
    // The release happened in another application and never reached this document.
    f.emit('keydown', f.a, {key, repeat: false}); f.emit('keyup', f.a, {key});
    assert.deepEqual(f.calls, ['press:A', 'cancel:A', 'press:A', 'release:A']);
  } finally {f.close();}
});

test('active view disposal cancels once and removes the exact delegated listener set', () => {
  const f = fixture();
  const events = ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture', 'keydown', 'keyup',
    'focusout', 'visibilitychange', 'click', 'contextmenu'];
  try {
    for (const event of events) assert.equal(getEventListeners(f.document, event).length, 1, event);
    assert.equal(getEventListeners(f.window, 'blur').length, 1);
    f.emit('keydown', f.a, {key: 'Enter'});
    f.view.dispose(); f.view.dispose();
    f.emit('keyup', f.a, {key: 'Enter'}); f.window.dispatchEvent(new Event('blur'));
    assert.deepEqual(f.calls, ['press:A', 'cancel:A']);
    for (const event of events) assert.equal(getEventListeners(f.document, event).length, 0, event);
    assert.equal(getEventListeners(f.window, 'blur').length, 0);
  } finally {f.close();}
});

test('inline view and native insertion helpers stay focused below fifty lines', () => {
  for (const file of ['dictation-inline-view.ts', 'dictation-channel.ts']) {
    const text = readFileSync(new URL(`../static/${file}`, import.meta.url), 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) && node.body) {
        const start = source.getLineAndCharacterOfPosition(node.getStart()).line;
        const end = source.getLineAndCharacterOfPosition(node.end).line;
        assert.ok(end - start + 1 < 50, `${file}:${start + 1}: ${end - start + 1} lines`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});
