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
  canWriteAcknowledged?(bytes: Uint8Array): boolean;
  writeAcknowledged?(bytes: Uint8Array, complete: boolean, settled: (accepted: boolean) => void): boolean;
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
  expected: string; bytes: Uint8Array; offset: number; stopped: boolean; failure: PasteResult['reason'];
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
    const requestedBytes = new TextEncoder().encode(text).byteLength;
    const expected = '\x1b[200~' + text.replace(/\n/g, '\r') + '\x1b[201~';
    const bytes = new TextEncoder().encode(expected);
    const paste: InsertionPaste = {text, done, guard, settled: false, attempted: false, frames: 0, wireBytes: 0,
      expected, bytes, offset: 0, stopped: false, failure: null};
    if (this.used) {this.finish(paste, 'refused', 'guard'); return;}
    this.used = true;
    // LF/tab are data inside framing; CR must already have been normalized
    // upstream. Never let ESC or other C0/C1 controls terminate that framing.
    // The worker accepts at most 32768 transcript bytes; the WS frame is at
    // most 4 MiB. Refuse before invoking an encoder that might stream output.
    if (!text || requestedBytes > 32768 || bytes.byteLength > 4 * 1024 * 1024 || hasDictationControls(text)) {
      this.finish(paste, 'refused', 'incomplete'); return;
    }
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
    // A busy ACK actor must refuse before the lease can emit H or become dirty.
    // The data callback still rechecks guards and writeTracked before the D attempt.
    if (this.p.writeAcknowledged && this.p.canWriteAcknowledged &&
        !this.p.canWriteAcknowledged(paste.bytes)) {this.refuse(paste, 'guard'); return;}
    const p = this.p, revision = p.lease.revision, wasDirty = p.lease.dirty;
    let queued = false, delivered = false;
    try {
      delivered = this.native!.write(paste.bytes, false, {
        control: (id, dirty) => p.transport.control(id, dirty),
        data: payload => {
          if (this.released || !p.mode.valid || !p.mode.value || !p.valid() || !paste.guard() ||
              !p.lease.canInsert() || p.lease.revision !== revision + 1 ||
              (p.writeAcknowledged && p.canWriteAcknowledged && !p.canWriteAcknowledged(payload))) {
            paste.failure = 'guard'; throw Error('insertion guard revoked');
          }
          paste.attempted = true;
          paste.frames = 1; paste.wireBytes = payload.byteLength;
          if (p.writeAcknowledged) {
            queued = p.writeAcknowledged(payload, false, accepted => {
              if (this.released) return;
              if (accepted) this.finish(paste, 'paste', null);
              else this.refuse(paste, 'send');
            });
            if (!queued && !paste.settled) {paste.attempted = false; paste.frames = 0; paste.wireBytes = 0;}
          } else {
            p.transport.data(payload);
            queued = true;
          }
        },
      });
    } catch { /* An uncertain send must never fall back to another write. */ }
    // Cancel this claim's H only on its original transport, when no D could
    // have reached the socket and no human edit preceded or intervened.
    if (!paste.attempted && !wasDirty && p.lease.dirty &&
        p.lease.revision === revision + 1 && p.lease.canInsert()) p.lease.release(p.transport);
    if (!delivered || !queued) this.refuse(paste, paste.failure ?? 'send');
    else if (!p.writeAcknowledged) this.finish(paste, 'paste', null);
  }
  private frame(paste: InsertionPaste, frame: string): void {
    if (paste.stopped || paste.settled) return;
    if (!this.allowed(paste)) {paste.stopped = true; paste.failure = 'guard'; return;}
    if (!frame || !paste.expected.startsWith(frame, paste.offset)) {
      paste.stopped = true; paste.failure = 'incomplete'; return;
    }
    paste.offset += frame.length;
  }
}
