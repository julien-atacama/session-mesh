// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {NativeEditorBuffer, type Submission} from '../checks/dictation-native-editor.ts';

test('controlled editor keeps split bracketed multiline UTF-8 as editable data until manual Enter', () => {
  const bytes = Buffer.from('\x1b[200~alpha\r\nbêta\ttab\x1b[201~');
  for (let split = 0; split <= bytes.length; split++) {
    const submitted: Submission[] = [], editor = new NativeEditorBuffer(event => submitted.push(event));
    editor.feed(bytes.subarray(0, split)); editor.feed(bytes.subarray(split));
    assert.equal(editor.text.join(''), 'alpha\nbêta\ttab');
    assert.equal(editor.cursor, 14); assert.equal(editor.paste, false);
    assert.deepEqual(submitted, []);
    editor.feed(Buffer.from('\x7fB\r'));
    assert.deepEqual(submitted, [{event: 'manual-submit', text: 'alpha\nbêta\ttaB', sequence: 1}]);
    assert.equal(editor.text.join(''), ''); assert.equal(editor.cursor, 0);
  }
});

test('controlled editor preserves preexisting text and edits only its native insertion point', () => {
  const submitted: Submission[] = [], editor = new NativeEditorBuffer(event => submitted.push(event));
  editor.feed(Buffer.from('preexisting suffix'));
  editor.feed(Buffer.from('\x1b[D'.repeat(' suffix'.length)));
  editor.feed(Buffer.from('\x1b[200~+spoken\x1b[201~'));
  assert.equal(editor.text.join(''), 'preexisting+spoken suffix');
  assert.equal(editor.cursor, 'preexisting+spoken'.length); assert.deepEqual(submitted, []);
  editor.feed(Buffer.from('\x15'));
  assert.equal(editor.text.join(''), ' suffix'); assert.equal(editor.cursor, 0);
});

test('controlled editor consumes only the exact cursor-position report without editing or submitting', () => {
  const report = Buffer.from('\x1b[1;1R');
  for (let split = 0; split <= report.length; split++) {
    const submitted: Submission[] = [], editor = new NativeEditorBuffer(event => submitted.push(event));
    editor.feed(Buffer.from('before'));
    editor.feed(report.subarray(0, split));
    editor.feed(report.subarray(split));
    assert.equal(editor.text.join(''), 'before');
    assert.equal(editor.cursor, 6);
    assert.deepEqual(submitted, []);
    editor.feed(Buffer.from('after'));
    assert.equal(editor.text.join(''), 'beforeafter');
    assert.deepEqual(submitted, []);
  }
  for (const unknown of ['\x1b[1;2R', '\x1b[2;1R', '\x1b[1;1X']) {
    const editor = new NativeEditorBuffer(() => {});
    assert.throws(() => editor.feed(Buffer.from(unknown)), /Unexpected native editor escape input/);
  }
});
