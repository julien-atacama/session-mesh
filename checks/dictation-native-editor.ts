// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
// Test-only native editable buffer. It NEVER evaluates input or invokes an agent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {StringDecoder} from 'node:string_decoder';

export type EditorSnapshot = {text: string; cursor: number; paste: boolean; mode: boolean;
  rows: number; cols: number; pid: number; revision: number};
export type Submission = {event: 'manual-submit'; text: string; sequence: number};
export type EditorObservation = {reason: 'start' | 'resize' | 'input' | 'mode'; changed: boolean; snapshot: EditorSnapshot};

export class NativeEditorBuffer {
  text: string[] = []; cursor = 0; paste = false;
  private pending = ''; private readonly decoder = new StringDecoder('utf8');
  private pasteCR = false;
  private sequence = 0;
  private readonly submit: (event: Submission) => void;
  constructor(submit: (event: Submission) => void) {this.submit = submit;}
  private insert(text: string): void {
    const chars = Array.from(text); this.text.splice(this.cursor, 0, ...chars); this.cursor += chars.length;
  }
  feed(bytes: Buffer): void {
    this.pending += this.decoder.write(bytes);
    const start = '\x1b[200~', end = '\x1b[201~';
    const sequences: Record<string, () => void> = {
      [start]: () => {this.paste = true; this.pasteCR = false;}, [end]: () => {this.paste = false;},
      '\x1b[D': () => {this.cursor = Math.max(0, this.cursor - 1);},
      '\x1b[C': () => {this.cursor = Math.min(this.text.length, this.cursor + 1);},
      '\x1b[A': () => {this.cursor = 0;}, '\x1b[B': () => {this.cursor = this.text.length;},
      '\x1b[H': () => {this.cursor = 0;}, '\x1b[F': () => {this.cursor = this.text.length;},
      '\x1b[3~': () => {this.text.splice(this.cursor, 1);},
    };
    while (this.pending) {
      if (this.paste) {
        if (this.pending.startsWith(end)) {this.pending = this.pending.slice(end.length); this.paste = false; continue;}
        if (end.startsWith(this.pending)) break;
        // A native logical newline accepts CR/LF/CRLF (xterm encodes LF as CR).
        // None submits. The independent input.bin oracle preserves exact wire bytes.
        const c = String.fromCodePoint(this.pending.codePointAt(0)!);
        if (!(c === '\n' && this.pasteCR)) this.insert(c === '\r' ? '\n' : c);
        this.pasteCR = c === '\r'; this.pending = this.pending.slice(c.length); continue;
      }
      if (this.pending[0] === '\x1b') {
        const match = Object.keys(sequences).find(s => this.pending.startsWith(s));
        if (match) {sequences[match]!(); this.pending = this.pending.slice(match.length); continue;}
        if (Object.keys(sequences).some(s => s.startsWith(this.pending))) break;
        throw Error('Unexpected native editor escape input: ' + JSON.stringify(this.pending));
      }
      const c = String.fromCodePoint(this.pending.codePointAt(0)!);
      this.pending = this.pending.slice(c.length);
      if (c === '\r' || c === '\n') {
        this.submit({event: 'manual-submit', text: this.text.join(''), sequence: ++this.sequence});
        this.text = []; this.cursor = 0;
      } else if (c === '\x7f' || c === '\b') {
        if (this.cursor) {this.text.splice(--this.cursor, 1);}
      } else if (c === '\x15') {this.text.splice(0, this.cursor); this.cursor = 0;}
      else if (c === '\x01') this.cursor = 0;
      else if (c === '\x05') this.cursor = this.text.length;
      else if (c === '\t' || c.codePointAt(0)! >= 0x20) this.insert(c);
      else throw Error('Unexpected native editor control input: ' + JSON.stringify(c));
    }
  }
}

function run(directory: string): void {
  assert.ok(path.isAbsolute(directory));
  assert.ok(process.stdin.isTTY && process.stdout.isTTY, 'controlled editor requires a real PTY');
  const state = path.join(directory, 'buffer.json'), events = path.join(directory, 'submissions.jsonl');
  const raw = path.join(directory, 'input.bin');
  const observations = path.join(directory, 'observations.jsonl');
  fs.writeFileSync(events, '', {mode: 0o600}); fs.writeFileSync(raw, '', {mode: 0o600});
  fs.writeFileSync(observations, '', {mode: 0o600});
  let revision = 0, mode = true;
  let previous: string | null = null;
  const editor = new NativeEditorBuffer(event => fs.appendFileSync(events, JSON.stringify(event) + '\n'));
  const save = (reason: EditorObservation['reason']): void => {
    const fields = {text: editor.text.join(''), cursor: editor.cursor, paste: editor.paste,
      mode, rows: process.stdout.rows, cols: process.stdout.columns, pid: process.pid};
    const signature = JSON.stringify(fields), changed = signature !== previous; previous = signature;
    const snapshot: EditorSnapshot = {...fields, revision: ++revision};
    fs.appendFileSync(observations, JSON.stringify({reason, changed, snapshot}) + '\n');
    fs.writeFileSync(state + '.tmp', JSON.stringify(snapshot), {mode: 0o600}); fs.renameSync(state + '.tmp', state);
  };
  process.stdin.setRawMode(true);
  // Synthetic test-owned signal controls change real terminal output, not browser evidence.
  process.on('SIGUSR1', () => {mode = !mode; process.stdout.write(mode ? '\x1b[?2004h' : '\x1b[?2004l'); save('mode');});
  process.on('SIGWINCH', () => save('resize'));
  process.stdin.on('data', (bytes: Buffer) => {
    fs.appendFileSync(raw, bytes); editor.feed(bytes); save('input');
    // Render a disposable visual prompt; exact text is observed only in the private file.
    process.stdout.write('\r\x1b[2Knative fixture> ' + editor.text.join(''));
  });
  process.stdout.write('\x1b[?2004h\r\nnative fixture> '); save('start'); process.stdin.resume();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2], 'private editor oracle directory required'); run(process.argv[2]);
}
