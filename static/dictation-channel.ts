// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {type CapturedTarget, type HumanInputLease, type HumanInputAttempt, type PasteResult} from './pane-actions.ts';
import type {DictationChannel} from './dictation.ts';
import type {DictationMode} from './terminal-mode.ts';
import {hasDictationControls} from '../shared/dictation-text.ts';
export {createDictationModeObserver} from './terminal-mode.ts';

interface Encoder {
  write(text: string, done: () => void): void;
  paste(text: string): void;
  onData(callback: (text: string) => void): {dispose(): void};
  dispose(): void;
}
interface OriginalChannelPorts {
  target: CapturedTarget; socket: {send(bytes: Uint8Array): void};
  lease: HumanInputLease; encoder(): Encoder;
  valid(): boolean; release(): void;
  transport: {control(id: string, dirty: boolean): void; data(bytes: Uint8Array): void};
  mode: DictationMode;
  // Native prompt insertion only. The app must supply original-binding/replay
  // provenance through valid(); construction snapshots the input revision at hold.
  insertionOnly?: boolean;
}
interface Preparation {
  encoder: Encoder; mode(): boolean; valid(): boolean;
  ready(mode: boolean): void; refused(): void;
}
// Reseed only before any payload; persistent mode churn must fail closed.
function prepareEncoder(p: Preparation, remaining = 3): void {
  if (!p.valid()) {p.refused(); return;}
  const seeded = p.mode();
  let pending = true;
  try {
    p.encoder.write(seeded ? '\x1b[?2004h' : '\x1b[?2004l', () => {
      if (!pending) return;
      pending = false;
      if (!p.valid()) {p.refused(); return;}
      if (p.mode() !== seeded) {
        if (remaining <= 1) {p.refused(); return;}
        prepareEncoder(p, remaining - 1); return;
      }
      p.ready(seeded);
    });
  } catch {p.refused();}
}
interface ChannelResources {encoder: Encoder; listen(callback: (text: string) => void): void; release(): void}
export function createDictationChannel(p: OriginalChannelPorts): DictationChannel {
  let encoder: Encoder | null = null, data: {dispose(): void} | null = null;
  let releaseLease: (() => void) | null = null, released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    // One failing disposer must not strand the original socket/target or input lease.
    for (const dispose of [() => data?.dispose(), () => encoder?.dispose(), () => p.release(), () => releaseLease?.()]) {
      try {dispose();} catch { /* Continue releasing the remaining acquired resources. */ }
    }
  };
  try {
    releaseLease = p.lease.retain(); encoder = p.encoder();
    const resources: ChannelResources = {encoder, listen(callback) {data = encoder!.onData(callback);}, release};
    return createNativeInsertionChannel(p, resources);
  } catch (error) {release(); throw error;}
}

function createNativeInsertionChannel(p: OriginalChannelPorts, resources: ChannelResources): DictationChannel {
  return new NativeInsertionChannel(p, resources);
}

interface InsertionPaste {
  text: string; done(result: PasteResult): void; guard(): boolean;
  settled: boolean; attempted: boolean; frames: number; wireBytes: number;
  expected: string; offset: number; stopped: boolean; failure: PasteResult['reason'];
}

class NativeInsertionChannel implements DictationChannel {
  private readonly p: OriginalChannelPorts;
  private readonly resources: ChannelResources;
  private readonly captureRevision: number;
  private released = false; private used = false;
  private native: HumanInputAttempt | null = null;
  private onFrame: ((frame: string) => void) | null = null;

  constructor(p: OriginalChannelPorts, resources: ChannelResources) {
    this.p = p; this.resources = resources; this.captureRevision = p.lease.revision;
    resources.listen(frame => this.onFrame?.(frame));
  }
  valid(): boolean {
    const p = this.p;
    try {return !this.released && p.mode.valid && p.mode.value && p.valid()
      && (this.native ? this.native.valid() : p.lease.revision === this.captureRevision && p.lease.canInsert());}
    catch {return false;}
  }
  captureFresh(): boolean {return this.valid() && this.p.lease.revision === this.captureRevision;}
  claim(): boolean {
    if (this.used || !this.valid()) return false;
    this.native ??= this.p.lease.claimInsertion(this.captureRevision);
    return !!this.native && this.valid();
  }
  release(): void {
    if (this.released) return;
    this.released = true; this.onFrame = null; this.resources.release();
  }
  deliver(text: string, done: (result: PasteResult) => void, guard: () => boolean): void {
    const paste: InsertionPaste = {text, done, guard, settled: false, attempted: false, frames: 0, wireBytes: 0,
      expected: '\x1b[200~' + text.replace(/\n/g, '\r') + '\x1b[201~', offset: 0, stopped: false, failure: null};
    if (this.used) {this.finish(paste, 'refused', 'guard'); return;}
    this.used = true;
    // LF/tab are data inside framing; CR must already have been normalized
    // upstream. Never let ESC or other C0/C1 controls terminate that framing.
    if (!text || hasDictationControls(text)) {this.finish(paste, 'refused', 'incomplete'); return;}
    prepareEncoder({encoder: this.resources.encoder, mode: () => this.p.mode.value,
      valid: () => this.allowed(paste), refused: () => this.refuse(paste, 'guard'), ready: () => this.paste(paste)});
  }
  private allowed(paste: InsertionPaste): boolean {
    try {return !paste.settled && !!this.native && this.valid() && paste.guard();} catch {return false;}
  }
  private finish(paste: InsertionPaste, kind: PasteResult['kind'], reason: PasteResult['reason']): void {
    if (paste.settled) return;
    paste.settled = true; this.onFrame = null;
    paste.done({kind, reason, frames: paste.frames, wireBytes: paste.wireBytes,
      requestedBytes: new TextEncoder().encode(paste.text).byteLength, unknownAttempt: kind === 'uncertain'});
  }
  private refuse(paste: InsertionPaste, reason: PasteResult['reason']): void {
    this.finish(paste, paste.attempted ? 'uncertain' : 'refused', reason);
  }
  private paste(paste: InsertionPaste): void {
    if (!this.allowed(paste)) {this.refuse(paste, 'guard'); return;}
    // Match xterm's newline conversion, but accept no plaintext fallback,
    // truncated framing or extra action.
    this.onFrame = frame => this.frame(paste, frame);
    try {this.resources.encoder.paste(paste.text);} catch {paste.stopped = true; paste.failure = 'paste';}
    finally {this.onFrame = null;}
    if (paste.stopped) {this.refuse(paste, paste.failure); return;}
    if (paste.offset !== paste.expected.length) {this.refuse(paste, 'incomplete'); return;}
    if (!this.allowed(paste)) {this.refuse(paste, 'guard'); return;}
    this.finish(paste, 'paste', null);
  }
  private frame(paste: InsertionPaste, frame: string): void {
    if (paste.stopped || paste.settled) return;
    if (!this.allowed(paste)) {paste.stopped = true; paste.failure = 'guard'; return;}
    if (!frame || !paste.expected.startsWith(frame, paste.offset)) {
      paste.stopped = true; paste.failure = 'incomplete'; return;
    }
    const p = this.p, bytes = new TextEncoder().encode(frame), revision = p.lease.revision;
    try {
      // A paste never completes H ownership, even for a frame containing only CR.
      const delivered = this.native!.write(bytes, false, {
        control: (id, dirty) => p.transport.control(id, dirty),
        data: payload => {
          // H can reenter application code. At the actual D boundary allow
          // exactly our write's one revision increment.
          if (this.released || !p.mode.valid || !p.mode.value || !p.valid() || !paste.guard()
            || !p.lease.canInsert() || p.lease.revision !== revision + 1) {
            paste.failure = 'guard'; throw Error('insertion guard revoked');
          }
          paste.attempted = true; p.transport.data(payload);
        },
      });
      if (!delivered) {paste.stopped = true; paste.failure ??= 'send'; return;}
    } catch {paste.stopped = true; paste.failure = 'send'; return;}
    paste.frames++; paste.wireBytes += bytes.byteLength; paste.offset += frame.length;
  }
}
