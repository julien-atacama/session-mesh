// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {type CapturedTarget, type HumanInputLease, type HumanInputAttempt, type PasteResult} from './pane-actions.ts';
import type {DictationChannel} from './dictation.ts';
import type {DictationMode} from './terminal-mode.ts';
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
  let released = false, used = false;
  let native: HumanInputAttempt | null = null;
  let onFrame: ((frame: string) => void) | null = null;
  const captureRevision = p.lease.revision, encoder = resources.encoder;
  const valid = (): boolean => {
    try {return !released && p.mode.valid && p.mode.value && p.valid()
      && (native ? native.valid() : p.lease.revision === captureRevision && p.lease.canInsert());}
    catch {return false;}
  };
  resources.listen(frame => onFrame?.(frame));
  return {
    valid,
    captureFresh: () => valid() && p.lease.revision === captureRevision,
    claim() {
      if (used || !valid()) return false;
      native ??= p.lease.claimInsertion(captureRevision);
      return !!native && valid();
    },
    release() {
      if (released) return;
      released = true; onFrame = null; resources.release();
    },
    deliver(text, done, guard) {
      let settled = false, attempted = false, frames = 0, wireBytes = 0;
      const finish = (kind: PasteResult['kind'], reason: PasteResult['reason']): void => {
        if (settled) return;
        settled = true; onFrame = null;
        const result: PasteResult = {kind, reason, frames, wireBytes,
          requestedBytes: new TextEncoder().encode(text).byteLength, unknownAttempt: kind === 'uncertain'};
        done(result);
      };
      if (used) {finish('refused', 'guard'); return;}
      used = true;
      // LF/tab are data inside framing; CR must already have been normalized
      // upstream. Never let ESC or other C0/C1 controls terminate that framing.
      if (!text || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(text)) {finish('refused', 'incomplete'); return;}
      const allowed = (): boolean => {
        try {return !settled && !!native && valid() && guard();} catch {return false;}
      };
      const refuse = (reason: PasteResult['reason']): void => finish(attempted ? 'uncertain' : 'refused', reason);
      prepareEncoder({encoder, mode: () => p.mode.value, valid: allowed, refused: () => refuse('guard'),
        ready() {
          if (!allowed()) {refuse('guard'); return;}
          // Match the independent xterm encoder's existing newline conversion,
          // but accept no plaintext fallback, truncated framing or extra action.
          const expected = '\x1b[200~' + text.replace(/\n/g, '\r') + '\x1b[201~';
          let offset = 0, stopped = false;
          let failure: PasteResult['reason'] = null;
          onFrame = frame => {
            if (stopped || settled) return;
            if (!allowed()) {stopped = true; failure = 'guard'; return;}
            if (!frame || !expected.startsWith(frame, offset)) {stopped = true; failure = 'incomplete'; return;}
            const bytes = new TextEncoder().encode(frame);
            const revision = p.lease.revision;
            try {
              // A paste never completes native H ownership, even if an encoder
              // splits a multiline payload into a frame containing only CR.
              const delivered = native!.write(bytes, false, {
                control: (id, dirty) => p.transport.control(id, dirty),
                data(payload) {
                  // H control can reenter application code. At the actual D
                  // boundary allow exactly our write's one revision increment.
                  if (released || !p.mode.valid || !p.mode.value || !p.valid() || !guard()
                    || !p.lease.canInsert() || p.lease.revision !== revision + 1) {
                    failure = 'guard'; throw Error('insertion guard revoked');
                  }
                  attempted = true; p.transport.data(payload);
                },
              });
              if (!delivered) {stopped = true; failure ??= 'send'; return;}
            } catch {stopped = true; failure = 'send'; return;}
            frames++; wireBytes += bytes.byteLength; offset += frame.length;
          };
          try {encoder.paste(text);} catch {stopped = true; failure = 'paste';}
          finally {onFrame = null;}
          if (stopped) {refuse(failure); return;}
          if (offset !== expected.length) {refuse('incomplete'); return;}
          if (!allowed()) {refuse('guard'); return;}
          finish('paste', null);
        },
      });
    },
  };
}
