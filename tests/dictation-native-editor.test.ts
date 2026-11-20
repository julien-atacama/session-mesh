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
