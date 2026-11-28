// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

export {createRetainedLifetime, browserDictationMedia} from './dictation.ts';
export {createInlineDictationController} from './dictation-inline.ts';
export {createInlineDictationView} from './dictation-inline-view.ts';
export {createDictationChannel} from './dictation-channel.ts';
export {createDictationModeObserver} from './terminal-mode.ts';
export {createTerminalInputOrigin} from './terminal-origin.ts';
// Pane-local presentation only. The app supplies data and keeps action authority.

export { replayPrefix } from "./terminal-replay.ts";
export { isPtySizeFrame, parsePtySize, sendsSize, sizePlan } from "./terminal-size-owner.ts";
export { SIZE_TAKEOVER_KEY, listenForActivation, shouldTakeSize, showsSizeBanner, sizeTakeoverMode } from "./size-takeover.ts";

// Displayed text comes from the app's catalogs. The app installs its translator
// once they are loaded; until then (and in Node checks without one) a key reads
// as itself. Text is always translated when it is produced, never at load.
export * from "./mailbox-panel.ts";
export * from "./config-panel.ts";
export * from "./backend-account-panel.ts";
export { createBackendAccountApi } from "./backend-account-api.ts";
export {createAccountSwitchPicker, switchSource, switchTargets, sameSwitchSource} from './account-switch-picker.ts';
export * from "./agent-mail-consent.ts";
export * from "./narrow-drawer.ts";
export { holdLineForTarget } from "./held-line.ts";
export { postInBatches } from "./restore-batches.ts";
export type Translator = (key: string, params?: Record<string, unknown>) => string;
const untranslated: Translator = (key) => key;
let translate: Translator = untranslated;
export function setTranslator(fn: Translator): void {
  translate = typeof fn === "function" ? fn : untranslated;
}

export type AgentState = "busy" | "waiting" | "shell" | "idle" | "unknown";

export interface HumanInputTransport {
  control(clientId: string, dirty: boolean): void;
  data(bytes: Uint8Array): void;
}

/** Stable across reconnects, distinct across same-PTY incarnations even on old
 * hosts whose human-lease table is keyed only by this opaque id (96 bytes max). */
export function humanInputClientId(tab: string, slot: number, name: string, created: number | null): string {
  if (!Number.isSafeInteger(slot) || slot < 1 || (created !== null && (!Number.isFinite(created) || created <= 0)))
    throw new TypeError(translate("paneActions.inputIdentityInvalid"));
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, created ?? 0, false);
  const epoch = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${tab.slice(0, 32)}_${slot.toString(36)}_${name.slice(0, 32)}_${epoch}`;
}
export interface DeferredHumanInput {
  flush(): boolean;
  cancel(): void;
  /** Write a reserved operation's chunks on its original transport. */
  write(bytes: Uint8Array, complete: boolean): boolean;
}
export interface HumanInputLease {
  readonly dirty: boolean;
  readonly releasePending: boolean;
  readonly inputDirty: boolean;
  readonly revision: number;
  claim(): HumanInputAttempt | null;
  canInsert(): boolean;
  claimInsertion(expectedCaptureRevision: number): HumanInputAttempt | null;
  reconnect(): void;
  hold(): void;
  release(): void;
  write(bytes: Uint8Array, complete?: boolean, transport?: HumanInputTransport): boolean;
  defer(bytes: Uint8Array, complete: boolean): DeferredHumanInput;
  atomic(bytes: Uint8Array): boolean;
  readonly retired: boolean; readonly retained: number;
  bind(transport: HumanInputTransport): void;
  retain(): () => void; retire(): void; dispose(): void;
}
// Exact-session history spans known local views; H identity/dirty stay per lease.
// Count attempted D writes, including completed or uncertain foreign input.
export interface HumanInputScope {
  readonly revision: number;
  readonly attempts: number;
  readonly dirty: boolean;
  attempt(revision: number): void;
  observe(dirty: () => boolean, owner?: HumanInputLease): () => void;
  canInsert(lease: HumanInputLease): boolean;
  mutate(): number;
  track(lease: HumanInputLease): void; forget(lease: HumanInputLease): void;
  adopt(transport: HumanInputTransport, options?: {retained?: boolean}): HumanInputLease | null;
  dispose(): void;
}
export interface HumanInputAttempt {
  valid(): boolean;
  write(bytes: Uint8Array, complete: boolean, transport: HumanInputTransport): boolean;
}
export function createHumanInputScope(empty: () => void = () => {}): HumanInputScope {
  let revision = 0, attempts = 0;
  const observations = new Map<() => boolean, HumanInputLease | undefined>();
  const leases = new Set<HumanInputLease>();
  return {get revision() {return revision;}, get attempts() {return attempts;}, attempt(order) {attempts = Math.max(attempts, order);}, get dirty() {for (const read of observations.keys()) if (read()) return true; return false;},
    observe(read, owner) {observations.set(read, owner); return () => {observations.delete(read);};}, mutate() {return ++revision;},
    canInsert(lease) {
      if (!leases.has(lease)) return false;
      for (const [read, owner] of observations) if (owner !== lease && read()) return false;
      return true;
    },
    track(lease) {leases.add(lease);}, forget(lease) {leases.delete(lease); if (!leases.size && !observations.size) empty();},
    adopt(transport, options) {
      // Explicit user-opened views may share a retired job's input identity;
      // bind only ordinary input, never the job's explicit original transport.
      for (const lease of leases) if (lease.retired
        && ((!lease.retained && (lease.dirty || lease.releasePending)) || (options?.retained === true && lease.retained > 0))) {
        lease.bind(transport); return lease;
      }
      return null;
    }, dispose() {revision++; for (const lease of leases) lease.dispose(); observations.clear(); empty();}};
}
function claimHumanInput(scope: HumanInputScope, write: HumanInputLease['write'], expected = scope.revision,
  eligible: () => boolean = () => true): HumanInputAttempt | null {
  if (scope.revision !== expected || !eligible()) return null;
  const valid = (): boolean => scope.revision === expected && eligible();
  return {valid,
    write(bytes, complete, transport) {
      if (!valid()) return false;
      const delivered = write(bytes, complete, transport);
      if (scope.revision !== expected + 1) return false;
      expected = scope.revision; return delivered;
    }};
}

// One browser tab owns one opaque client id. WebSocket ordering makes each
// successful H/D/H sequence visible to the PTY arbiter in that order. H is an
// advisory extension, though: an older relay or a transient control failure
// must never prevent the baseline D frame from reaching the terminal.
class NativeInputLease implements HumanInputLease {
  private readonly clientId: string; private readonly scope: HumanInputScope;
  private pending = false; private pendingRelease = false; private isRetired = false; private refs = 0;
  private completedReservation: {transport: HumanInputTransport; releaseNeeded: boolean} | null = null;
  private disposed = false; private queued = 0;
  private transport: HumanInputTransport | null;
  private readonly unobserve: () => void;
  constructor(clientId: string, scope: HumanInputScope, transport: HumanInputTransport) {
    this.clientId = clientId; this.scope = scope;
    this.transport = transport;
    const unobservePending = scope.observe(() => this.dirty, this);
    // Deferred input is a barrier even when it belongs to this same lease.
    const unobserveQueued = scope.observe(() => this.queued > 0);
    this.unobserve = () => {unobservePending(); unobserveQueued();}; scope.track(this);
  }
  get inputDirty(): boolean {return this.scope.dirty;}
  get dirty(): boolean {return this.pending;}
  get releasePending(): boolean {return this.pendingRelease;}
  get retired(): boolean {return this.isRetired;}
  get retained(): number {return this.refs;}
  get revision(): number {return this.scope.revision;}
  private set(next: boolean, transport: HumanInputTransport, force = false): void {
    if (this.dirty === next && !force) return;
    // Keep the barrier until advisory release succeeds, but remember that
    // completed D needs only H(false), never another D, on reconnect.
    this.pendingRelease = !next;
    transport.control(this.clientId, next); this.pending = next; this.pendingRelease = false;
  }
  defer(bytes: Uint8Array, complete: boolean): DeferredHumanInput {
    const transport = this.transport, payload = bytes.slice();
    let held = !this.disposed && !!transport && !!payload.byteLength;
    if (!this.disposed && payload.byteLength) this.scope.mutate();
    const deferredRevision = this.scope.revision;
    if (held) this.queued++;
    const cancel = (): void => {if (held) {
      held = false; this.queued--;
      if (!this.queued && this.completedReservation) {
        const completed = this.completedReservation; this.completedReservation = null;
        if (!completed.releaseNeeded) this.pending = false;
        else try {this.set(false, completed.transport);} catch { /* Retry release on reconnect. */ }
      }
      this.cleanup();
    }};
    let flushing = false, writing = false;
    const write = (bytes: Uint8Array, finished: boolean): boolean => {
      if (!held || writing) return false;
      writing = true;
      try {return this.deliver(bytes, finished && this.scope.attempts <= deferredRevision, transport, true, deferredRevision);}
      finally {writing = false;}
    };
    return {cancel, write, flush: () => {
      if (!held || flushing) return false;
      flushing = true;
      try {return write(payload, complete);}
      finally {cancel();}
    }};
  }
  write(bytes: Uint8Array, complete = false, transport = this.transport): boolean {
    return this.deliver(bytes, complete, transport, false);
  }
  private deliver(bytes: Uint8Array, complete: boolean, transport: HumanInputTransport | null, reserved: boolean, attemptOrder?: number): boolean {
    if (this.disposed || !bytes.byteLength) return false;
    // A deferred operation invalidated captures when reserved. Flushing it must
    // not make subsequent reservations look like newer human input.
    const revision = reserved ? this.scope.revision : this.scope.mutate();
    if (!transport) return false;
    this.scope.attempt(attemptOrder ?? revision);
    this.completedReservation = null;
    const reacquire = this.pendingRelease;
    this.pendingRelease = false;   // a new D attempt supersedes an older completed operation
    if (!this.dirty || reacquire) {
      try { this.set(true, transport, reacquire); } catch { /* H is optional; D remains the authority. */ }
    }
    const releaseNeeded = this.dirty;
    this.pending = true;   // unfinished local D is a barrier even when optional H(true) failed
    let delivered = false;
    try {
      transport.data(bytes);
      delivered = true;
    } catch {this.pending = true; /* An uncertain/failed D remains dirty, even if advisory acquisition failed. */ }
    if (delivered && complete && this.dirty && this.scope.revision === revision) {
      if (reserved && this.queued > 1)
        this.completedReservation = {transport, releaseNeeded};
      else if (!releaseNeeded) this.pending = false;
      else try { this.set(false, transport); } catch { /* Reconnect retries H(false), never D. */ }
    }
    this.cleanup();
    return delivered;
  }
  hold(): void {
    this.completedReservation = null;
    if (this.disposed || this.dirty) return;
    this.scope.mutate();
    this.pending = true;
    try { if (this.transport) this.set(true, this.transport, true); } catch { /* Reassert on reconnect. */ }
  }
  release(): void {
    if (this.disposed || !this.dirty) return;
    this.scope.mutate();
    this.pendingRelease = true;
    try { if (this.transport) this.set(false, this.transport); } catch { /* Retry on reconnect. */ }
    this.cleanup();
  }
  atomic(bytes: Uint8Array): boolean {return this.write(bytes, true);}
  claim(): HumanInputAttempt | null {
    return this.disposed || this.scope.dirty ? null
      : claimHumanInput(this.scope, this.write.bind(this), this.scope.revision, () => !this.disposed);
  }
  canInsert(): boolean {return !this.disposed && this.scope.canInsert(this);}
  claimInsertion(expectedCaptureRevision: number): HumanInputAttempt | null {
    return claimHumanInput(this.scope, this.write.bind(this), expectedCaptureRevision, () => this.canInsert());
  }
  reconnect(): void {
    try {if (this.transport) {
      const dirty = this.releasePending ? false : this.dirty;
      this.transport.control(this.clientId, dirty); this.pending = dirty; this.pendingRelease = false;
      if (dirty && this.completedReservation) this.completedReservation.releaseNeeded = true;
    }}
    catch { /* Socket setup must continue. */ }
    this.cleanup();
  }
  bind(transport: HumanInputTransport): void {if (!this.disposed) {this.isRetired = false; this.transport = transport;}}
  retain(): () => void {
    if (this.disposed) return () => {};
    this.refs++; let held = true;
    return () => {if (!held) return; held = false; this.refs--; this.cleanup();};
  }
  retire(): void {this.isRetired = true; this.transport = null; this.cleanup();}
  private cleanup(): void {if (this.retired && !this.retained && !this.dirty && !this.releasePending && !this.queued) this.dispose();}
  dispose(): void {if (this.disposed) return; this.disposed = true; this.transport = null; this.unobserve(); this.scope.forget(this);}
}
export function createHumanInputLease(ports: HumanInputTransport & {clientId: string; scope?: HumanInputScope}): HumanInputLease {
  return new NativeInputLease(ports.clientId, ports.scope ?? createHumanInputScope(), ports);

}

export type RetainedInputState = "ready" | "sending" | "uncertain" | "review" | "halted";

// Keep the browser's lease decision in step with Mesh_pty_input's strict
// terminal_reports_only grammar. The native host independently classifies
// these bytes; a browser hint cannot exempt arbitrary human input.
export function terminalReportsOnly(data: Uint8Array): boolean {
  if (!data.length || data.length > 65536) return false;
  const byte = (i: number) => data[i] ?? -1;
  const digit = (i: number) => byte(i) >= 48 && byte(i) <= 57;
  const digits = (i: number): number | null => {
    if (!digit(i)) return null;
    while (digit(i)) i++;
    return i;
  };
  const groups = (start: number, count: number): number | null => {
    let i = start;
    for (let group = 0; group < count; group++) {
      const end = digits(i);
      if (end === null) return null;
      i = end;
      if (group + 1 < count) {
        if (byte(i) !== 59) return null; // ;
        i++;
      }
    }
    return i;
  };
  const report = (start: number): number | null => {
    if (byte(start) !== 27 || byte(start + 1) !== 91) return null; // ESC [
    const i = start + 2;
    if (byte(i) === 73 || byte(i) === 79) return i + 1; // I / O
    if (byte(i) === 77) { // X10 mouse: M and three printable bytes
      if (i + 3 < data.length && byte(i + 1) >= 32 &&
          byte(i + 2) >= 32 && byte(i + 3) >= 32) return i + 4;
      return null;
    }
    if (byte(i) === 60) { // < button ; column ; row M/m
      const end = groups(i + 1, 3);
      return end !== null && (byte(end) === 77 || byte(end) === 109) ? end + 1 : null;
    }
    const cursor = groups(i, 2);
    if (cursor !== null && byte(cursor) === 82) return cursor + 1; // R
    const status = digits(i);
    return status !== null && byte(status) === 110 ? status + 1 : null; // n
  };
  for (let i = 0; i < data.length;) {
    const end = report(i);
    if (end === null) return false;
    i = end;
  }
  return true;
}

// Only a native ACK clears bytes. The caller must supply the host-announced
// binding, not one inferred from its own attach request. No timers or replay.
export function createAcknowledgedInput(ports: {
  readonly attachmentId?: string;
  readonly version?: 1 | 2;
  readonly created: number;
  readonly send: (payload: Uint8Array) => void;
  readonly state: (state: RetainedInputState) => void;
}) {
  const maxPending = 1024 * 1024;
  const maxFrame = 65536;
  type Pending = { seq: number; data: Uint8Array; complete: boolean; reportOnly: boolean; reviewOnly: boolean;
    settled: ((accepted: boolean) => void) | undefined; send: (payload: Uint8Array) => void };
  const pending: Pending[] = [];
  let nextSeq = 1;
  let active = false;
  let sent = false;
  let state: RetainedInputState = "ready";
  let completed = false;
  let incompleteHumanInput = false;
  let binding: { slot: number; generation: number; actorNonce: string } | null = null;
  let blocked = false;
  const updateState = (value: RetainedInputState) => { state = value; ports.state(value); };
  const settleTracked = (frame: Pending | undefined, accepted: boolean) => {
    const callback = frame?.settled;
    if (frame) frame.settled = undefined;
    callback?.(accepted);
  };
  const size = () => pending.reduce((sum, frame) => sum + frame.data.length, 0);
  const transmit = () => {
    if (!active || state === "halted") return;
    const frame = pending[0];
    if (!frame) return;
    if (frame.reviewOnly) { updateState("review"); return; }
    const payload = new Uint8Array(4 + frame.data.length);
    new DataView(payload.buffer).setUint32(0, frame.seq);
    payload.set(frame.data, 4);
    // A failed/uncertain socket send must never allow automatic retry.
    sent = true;
    updateState("sending");
    try { frame.send(payload); }
    catch { updateState("uncertain"); settleTracked(frame, false); }
  };
  const enqueue = (bytes: Uint8Array, complete: boolean, retainOnly: boolean,
    settled?: (accepted: boolean) => void, send = ports.send) => {
    if ((!retainOnly && (blocked || state === "halted")) || !bytes.length || bytes.length > maxPending - size() ||
        nextSeq + Math.ceil(bytes.length / maxFrame) > 0x80000000) return false;
    const reportOnly = terminalReportsOnly(bytes);
    const wasEmpty = pending.length === 0;
    if (retainOnly) active = false;
    for (let offset = 0; offset < bytes.length; offset += maxFrame) {
      const end = Math.min(bytes.length, offset + maxFrame);
      pending.push({ seq: nextSeq++, data: bytes.slice(offset, end),
        complete: complete && !reportOnly && end === bytes.length, reportOnly, reviewOnly: retainOnly,
        settled: end === bytes.length ? settled : undefined, send });
    }
    completed = false;
    if (retainOnly) updateState(blocked || state === "halted" ? "halted" : sent ? "uncertain" : "review");
    else if (wasEmpty && active && state === "ready") transmit();
    else if (wasEmpty && state === "ready") updateState("review");
    return true;
  };
  const retainedText = () => {
    const decoder = new TextDecoder();
    let text = "";
    for (const frame of pending) if (!frame.reportOnly) text += decoder.decode(frame.data, {stream: true});
    return text + decoder.decode();
  };
  return {
    get version() { return ports.version ?? 1; },
    get state() { return state; },
    get completed() { return completed; },
    get pendingBytes() { return size(); },
    get deliveryUncertain() { return sent; },
    get incompleteHumanInput() { return incompleteHumanInput; },
    get binding() { return binding && { ...binding }; },
    get blocked() { return blocked; },
    get pendingHumanBytes() {
      return pending.reduce((sum, frame) => sum + (frame.reportOnly ? 0 : frame.data.length), 0);
    },
    get retainedText() { return retainedText(); },
    get editableRetainedText() {
      return active && !sent && !blocked && !incompleteHumanInput && state === "review" &&
        pending.length > 0 && pending.every(frame => frame.reviewOnly && !frame.reportOnly)
        ? retainedText() : "";
    },
    connect(created: number, id: string, supported: boolean) {
      if (ports.version === 2) return;
      if (state === "halted") return;
      active = supported && created === ports.created && id === ports.attachmentId;
      if (!active) { updateState(pending.length ? (sent ? "uncertain" : "review") : "halted"); return; }
      if (pending.length) updateState(sent ? "uncertain" : "review");
      else updateState("ready");
    },
    connectV2(created: number, slot: number, generation: number, actorNonce: string, supported: boolean) {
      if (ports.version !== 2 || blocked || state === "halted") return false;
      if (!supported || created !== ports.created || !Number.isFinite(created) || created <= 0 ||
          !Number.isSafeInteger(slot) || slot < 0 || slot > 63 ||
          !Number.isSafeInteger(generation) || generation <= 0 ||
          typeof actorNonce !== "string" || !/^[0-9a-f]{32}$/.test(actorNonce) ||
          (binding !== null && (binding.slot !== slot || binding.generation !== generation ||
            binding.actorNonce !== actorNonce))) {
        blocked = true;
        active = false;
        settleTracked(pending[0], false);
        updateState(pending.length ? (sent ? "uncertain" : "review") : "halted");
        return false;
      }
      binding ??= {slot, generation, actorNonce};
      active = true;
      updateState(pending.length ? (sent ? "uncertain" : "review") : "ready");
      return true;
    },
    reject() {
      if (ports.version !== 2) return;
      blocked = true;
      active = false;
      settleTracked(pending[0], false);
      updateState(pending.length ? (sent ? "uncertain" : "review") : "halted");
    },
    disconnect() {
      active = false;
      settleTracked(pending[0], false);
      if (pending.length && state !== "halted" && !blocked)
        updateState(sent ? "uncertain" : "review");
    },
    write(bytes: Uint8Array, complete = false) {
      return enqueue(bytes, complete, false);
    },
    writeTracked(bytes: Uint8Array, complete: boolean, settled: (accepted: boolean) => void,
      send = ports.send) {
      return active && state === "ready" && !blocked && !pending.length && bytes.length <= maxFrame &&
        enqueue(bytes, complete, false, settled, send);
    },
    retain(bytes: Uint8Array, complete = false) { return enqueue(bytes, complete, true); },
    ack(created: number, id: string, seq: number, ok: boolean, reason?: string) {
      if (ports.version === 2 || !active || created !== ports.created || id !== ports.attachmentId ||
          !Number.isSafeInteger(seq) || !sent ||
          seq !== pending[0]?.seq || (state !== "sending" && state !== "uncertain")) {
        if (pending.length && state !== "halted" && !blocked) updateState("uncertain");
        settleTracked(pending[0], false);
        return;
      }
      if (!ok) {
        settleTracked(pending[0], false);
        if (reason === "switch_input_fenced" || reason === "input_pending") {
          sent = false;
          updateState("review");
        } else updateState(reason === undefined ? "uncertain" : "halted");
        return;
      }
      const accepted = pending.shift();
      settleTracked(accepted, true);
      completed = accepted?.complete === true;
      if (accepted && !accepted.reportOnly)
        incompleteHumanInput = !accepted.complete;
      sent = false;
      if (pending.length) transmit();
      else updateState("ready");
    },
    ackV2(created: number, slot: number, generation: number, seq: number, ok: boolean, reason?: string) {
      if (ports.version !== 2 || !active || !binding ||
          created !== ports.created || slot !== binding.slot || generation !== binding.generation ||
          !Number.isSafeInteger(seq) || !sent || seq !== pending[0]?.seq ||
          (state !== "sending" && state !== "uncertain")) {
        if (pending.length && state !== "halted" && !blocked) updateState("uncertain");
        settleTracked(pending[0], false);
        return;
      }
      if (!ok) {
        settleTracked(pending[0], false);
        if (reason === "switch_input_fenced" || reason === "input_pending") {
          sent = false;
          updateState("review");
        } else updateState(reason === undefined ? "uncertain" : "halted");
        return;
      }
      const accepted = pending.shift();
      settleTracked(accepted, true);
      completed = accepted?.complete === true;
      if (accepted && !accepted.reportOnly) incompleteHumanInput = !accepted.complete;
      sent = false;
      if (pending.length) transmit();
      else updateState("ready");
    },
    retry() {
      if (!active || !pending.length || (state !== "uncertain" && state !== "review"))
        return false;
      for (const frame of pending) frame.reviewOnly = false;
      transmit();
      return true;
    },
    discard() {
      const head = pending[0];
      if (!head) return false;
      const uncertain = sent;
      const halted = state === "halted";
      const first = head.seq;
      settleTracked(head, false);
      pending.length = 0;
      sent = false;
      completed = false;
      // The host may have committed the discarded sequence. Never send another
      // frame on this actor after uncertain delivery.
      if (uncertain || blocked || halted) updateState("halted");
      else { nextSeq = first; updateState(active ? "ready" : "review"); }
      return true;
    },
  };
}

type PortfolioFactState = "observed" | "unavailable" | "not-collected" | "not-a-repository" | "malformed";
interface PortfolioMetadata { readonly source: string; readonly observedAt: string }
interface WorktreeFact {
  readonly path: string; readonly head: string; readonly branch: string;
  readonly detached: boolean; readonly bare: boolean;
}
interface WorktreeFacts extends PortfolioMetadata {
  readonly cwd: string; readonly state: PortfolioFactState; readonly facts: readonly WorktreeFact[];
}
export interface PortfolioProvenance extends PortfolioMetadata {
  readonly state: PortfolioFactState; readonly rows: readonly WorktreeFacts[];
}

// Received observation only: no clock sampling, network, capabilities or globals.
export function portfolioProvenance(value: unknown): PortfolioProvenance {
  const record = (input: unknown): Record<string, unknown> | null =>
    input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : null;
  const metadata = (input: Record<string, unknown> | null): PortfolioMetadata => {
    const epoch = input?.observed_at;
    const date = typeof epoch === "number" && Number.isFinite(epoch) && epoch >= 0 ? new Date(epoch * 1000) : null;
    return { source: typeof input?.source === "string" && input.source ? input.source : translate("paneActions.provenance.unknownSource"),
      observedAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : translate("paneActions.provenance.unknownTime") };
  };
  const input = record(value);
  const base = metadata(input);
  if (value == null || input?.state === "not-collected") return { ...base, state: "not-collected", rows: [] };
  if (input?.state === "unavailable") return { ...base, state: "unavailable", rows: [] };
  if (input?.state !== "observed" || !Array.isArray(input.directories)) return { ...base, state: "malformed", rows: [] };
  const rows = input.directories.map((raw): WorktreeFacts => {
    const row = record(raw);
    const validCwd = typeof row?.cwd === "string" && !!row.cwd;
    const rowBase = { ...metadata(row), cwd: validCwd ? row.cwd as string : translate("paneActions.provenance.unknownDirectory"), facts: [] };
    if (!row || !validCwd) return { ...rowBase, state: "malformed" };
    if (row.state === "unavailable" || row.state === "not-a-repository" || row.state === "not-collected") return { ...rowBase, state: row.state };
    if (row.state !== "observed" || !Array.isArray(row.worktrees)) return { ...rowBase, state: "malformed" };
    const facts: WorktreeFact[] = [];
    for (const rawFact of row.worktrees) {
      const fact = record(rawFact);
      if (!fact || typeof fact.path !== "string" || !fact.path || typeof fact.detached !== "boolean" || typeof fact.bare !== "boolean"
          || (fact.head != null && typeof fact.head !== "string") || (fact.branch != null && typeof fact.branch !== "string")) return { ...rowBase, state: "malformed" };
      facts.push({ path: fact.path, head: typeof fact.head === "string" && fact.head ? fact.head : translate("paneActions.provenance.unknownHead"),
        branch: typeof fact.branch === "string" && fact.branch ? fact.branch : translate("paneActions.provenance.unknownBranch"),
        detached: fact.detached, bare: fact.bare });
    }
    return { ...rowBase, state: "observed", facts };
  });
  return { ...base, state: "observed", rows };
}

export type ContextualDiffLineKind = "file-header" | "hunk-header" | "added" | "deleted" | "context";

export function contextualDiffSelector(listing: unknown, binding: { readonly name: string; readonly created: number; readonly cwd: string }): string | null {
  if (!listing || typeof listing !== "object") return null;
  const inventory = (listing as { mesh_sessions?: unknown }).mesh_sessions;
  if (!inventory || typeof inventory !== "object") return null;
  const { state, directories } = inventory as { state?: unknown; directories?: unknown };
  if (state !== "observed" || !Array.isArray(directories)) return null;
  for (const row of directories) {
    if (!row || typeof row !== "object" || row.cwd !== binding.cwd || !Array.isArray(row.sessions)) continue;
    const issuer = row.sessions[0];
    if (issuer?.name === binding.name && issuer.created === binding.created && typeof row.diff_selector === "string" && row.diff_selector) return row.diff_selector;
  }
  return null;
}

// Classification is presentation only: callers always render the original text.
export function contextualDiffLineKind(line: string): ContextualDiffLineKind {
  if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff --git ")) return "file-header";
  if (line.startsWith("@@ ")) return "hunk-header";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "deleted";
  return "context";
}

export function createContextualDiffLifetime(): {
  begin(): number | null;
  current(request: number): boolean;
  dispose(): void;
} {
  let generation = 0;
  let disposed = false;
  return {
    begin() { return disposed ? null : ++generation; },
    current(request) { return !disposed && request === generation; },
    dispose() { disposed = true; generation++; },
  };
}

export interface IdentitySnapshot {
  readonly kind: "terminal" | "document" | "board" | "demo" | "diff" | "unknown";
  readonly title: string;
  readonly origin: "local" | "external" | "unknown";
  readonly externalOrigin: string | null;
  readonly sessionLabel: string | null;
  readonly readOnly: boolean;
  readonly load: "loading" | "frame-loaded" | "connected" | "unavailable" | "unknown";
}

export function identityPresentation(snapshot: IdentitySnapshot): Readonly<Record<string, string>> {
  let origin = translate("paneActions.identity.originUnknown");
  if (snapshot.origin === "local") origin = translate("paneActions.identity.originLocal");
  if (snapshot.origin === "external" && snapshot.externalOrigin) {
    try {
      const url = new URL(snapshot.externalOrigin);
      if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) origin = url.origin;
    } catch { /* Unknown provenance remains explicit. */ }
  }
  const states = {
    loading: () => translate("paneActions.identity.state.loading"),
    "frame-loaded": () => translate("paneActions.identity.state.frameLoaded"),
    connected: () => translate("paneActions.identity.state.connected"),
    unavailable: () => translate("paneActions.identity.state.unavailable"),
    unknown: () => translate("paneActions.identity.state.unknown"),
  };
  const kinds = {
    terminal: () => translate("paneActions.identity.kind.terminal"),
    document: () => translate("paneActions.identity.kind.document"),
    board: () => translate("paneActions.identity.kind.board"),
    demo: () => translate("paneActions.identity.kind.demo"),
    diff: () => translate("paneActions.identity.kind.diff"),
    unknown: () => translate("paneActions.identity.kind.unknown"),
  };
  const readOnly = (snapshot.kind === "diff" || snapshot.kind === "demo") && snapshot.readOnly;
  return {
    kind: kinds[snapshot.kind](),
    title: snapshot.title,
    origin: translate("paneActions.identity.origin", { origin }),
    session: translate("paneActions.identity.session",
      { session: snapshot.sessionLabel || translate("paneActions.identity.sessionUnknown") }),
    rights: readOnly ? translate("paneActions.identity.readOnly") : translate("paneActions.identity.rightsHidden"),
    state: states[snapshot.load](),
  };
}

export interface HeaderSnapshot {
  readonly name: string;
  readonly cwd: string;
  readonly terminal: boolean;
  readonly agentStatus: string | null;
  readonly unread: boolean;
  readonly boardModified: boolean;
}

export interface HeaderCallbacks {
  readonly rename: () => void;
}

export interface HeaderController {
  readonly update: (snapshot: HeaderSnapshot) => void;
  readonly setConnection: (text: string, bad: boolean) => void;
}

export function agentState(status: string | null): AgentState {
  switch (status) {
    case "busy": case "waiting": case "shell": case "idle": return status;
    default: return "unknown";
  }
}

export function createHeader(root: HTMLElement, callbacks: HeaderCallbacks): HeaderController {
  // Query only the injected pane. No Mesh, terminal, network or document singleton.
  const required = <T extends Element>(selector: string): T => {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`Pane header element missing: ${selector}`);
    return element;
  };
  const name = required<HTMLElement>(".p-name");
  const fullName = required<HTMLElement>(".p-full-name");
  const disclosure = required<HTMLElement>(".p-name-disclosure summary");
  const cwd = required<HTMLElement>(".p-cwd");
  const agent = required<HTMLElement>(".p-agent");
  const unread = required<HTMLElement>(".p-unread");
  const boardHint = required<HTMLElement>(".p-board-hint");
  const board = required<HTMLButtonElement>('[data-act="board"]');
  const connection = required<HTMLElement>(".conn");
  name.addEventListener("dblclick", () => callbacks.rename());

  return {
    update(snapshot) {
      // An inventory/header refresh must not replace an active inline rename.
      if (!name.querySelector("input.rename")) name.textContent = snapshot.name;
      fullName.textContent = snapshot.name;
      disclosure.setAttribute("aria-label", translate("paneActions.header.fullName", { name: snapshot.name }));
      cwd.textContent = snapshot.cwd;
      name.title = snapshot.terminal ? translate("paneActions.header.renameHint", { name: snapshot.name }) : snapshot.name;
      const state = agentState(snapshot.agentStatus);
      agent.hidden = !snapshot.terminal;
      agent.dataset.state = state;
      agent.textContent = translate("paneActions.header.agent", { state: translate(`paneActions.agent.${state}`) });
      agent.title = agent.textContent;
      unread.hidden = !(snapshot.terminal && snapshot.unread);
      boardHint.hidden = !(snapshot.terminal && snapshot.boardModified);
      const modified = snapshot.terminal && snapshot.boardModified;
      board.classList.toggle("board-modified", modified);
      board.setAttribute("aria-label", modified ? translate("paneActions.header.openBoardModified") : translate("paneActions.header.openBoard"));
    },
    setConnection(text, bad) {
      connection.textContent = text
        ? translate("paneActions.header.connection", { state: text === "●" ? translate("paneActions.header.connected") : text })
        : "";
      connection.title = connection.textContent;
      connection.classList.toggle("bad", bad);
      connection.hidden = !text;
    },
  };
}

export type PaneKind = "mesh" | "web" | "board" | "external" | "history" | "empty";
export type ActionId = "file" | "compose" | "browse" | "redraw" | "folder" | "raw" | "demo" | "stop" | "close" | "reload" | "newtab" | "watch";
// Action identifiers and their presentation keys are a closed, code-owned
// vocabulary.  A future extension may request one of these actions, but it
// cannot provide executable behavior or invent an identifier/message key.
export type ActionMessageKey =
  | "action.attach" | "action.compose" | "action.browse" | "action.redraw" | "action.demo"
  | "action.folder" | "action.raw" | "action.stop" | "action.close"
  | "action.reload" | "action.open-external" | "action.watch-start" | "action.watch-stop";
export interface ActionDefinition {
  readonly id: ActionId;
  readonly messageKey: ActionMessageKey;
  readonly label: string;
  readonly danger: boolean;
}
// `label` is read at use, so it follows the translator installed at that time.
const declareAction = (id: ActionId, messageKey: ActionMessageKey, danger: boolean): ActionDefinition => Object.freeze({
  id, messageKey, danger,
  get label() { return translate(`paneActions.action.${id}`); },
});
const ACTION_CATALOG: readonly ActionDefinition[] = Object.freeze([
  declareAction("file", "action.attach", false),
  declareAction("compose", "action.compose", false),
  declareAction("browse", "action.browse", false),
  declareAction("redraw", "action.redraw", false),
  declareAction("demo", "action.demo", false),
  declareAction("folder", "action.folder", false),
  declareAction("raw", "action.raw", false),
  declareAction("stop", "action.stop", true),
  declareAction("close", "action.close", false),
  declareAction("reload", "action.reload", false),
  declareAction("newtab", "action.open-external", false),
  declareAction("watch", "action.watch-start", false),
]);
const ACTIONS_BY_ID = new Map<ActionId, ActionDefinition>(ACTION_CATALOG.map((action) => [action.id, action]));
const ACTION_MESSAGE_KEYS: readonly ActionMessageKey[] = Object.freeze([
  ...ACTION_CATALOG.map((action) => action.messageKey), "action.watch-stop",
]);
const ACTION_MESSAGE_KEY_SET = new Set<string>(ACTION_MESSAGE_KEYS);
if (ACTIONS_BY_ID.size !== ACTION_CATALOG.length) throw new Error("duplicate Mesh action identifier");
if (ACTION_MESSAGE_KEY_SET.size !== ACTION_MESSAGE_KEYS.length) throw new Error("duplicate Mesh action message key");
export function actionCatalog(): readonly ActionDefinition[] { return ACTION_CATALOG; }
export function actionDefinition(value: unknown): ActionDefinition | null {
  return typeof value === "string" ? ACTIONS_BY_ID.get(value as ActionId) ?? null : null;
}
export function actionMessageKey(value: unknown): ActionMessageKey | null {
  return typeof value === "string" && ACTION_MESSAGE_KEY_SET.has(value) ? value as ActionMessageKey : null;
}

// This is a catalog, not a permission system.  It gives future extension
// manifests a closed vocabulary, while every non-empty request remains
// unavailable until a separately reviewed host bridge exists.
export type ExtensionSurface = "demo" | "mod";
export type CapabilityId = "session.summary.read" | "portfolio.read" | "roadmap.read"
  | "signals.subscribe" | "skills.usage.read" | "network.fetch";
export interface CapabilityDefinition {
  readonly id: CapabilityId;
  readonly surfaces: readonly ExtensionSurface[];
  readonly state: "reserved";
}
const MOD_SURFACES: readonly ExtensionSurface[] = Object.freeze(["mod"]);
const CAPABILITY_CATALOG: readonly CapabilityDefinition[] = Object.freeze([
  Object.freeze({ id: "session.summary.read", surfaces: MOD_SURFACES, state: "reserved" }),
  Object.freeze({ id: "portfolio.read", surfaces: MOD_SURFACES, state: "reserved" }),
  Object.freeze({ id: "roadmap.read", surfaces: MOD_SURFACES, state: "reserved" }),
  Object.freeze({ id: "signals.subscribe", surfaces: MOD_SURFACES, state: "reserved" }),
  Object.freeze({ id: "skills.usage.read", surfaces: MOD_SURFACES, state: "reserved" }),
  Object.freeze({ id: "network.fetch", surfaces: MOD_SURFACES, state: "reserved" }),
]);
const CAPABILITIES_BY_ID = new Map<CapabilityId, CapabilityDefinition>(CAPABILITY_CATALOG.map((capability) => [capability.id, capability]));
if (CAPABILITIES_BY_ID.size !== CAPABILITY_CATALOG.length) throw new Error("duplicate Mesh capability identifier");
export function capabilityCatalog(): readonly CapabilityDefinition[] { return CAPABILITY_CATALOG; }
export function capabilityDefinition(value: unknown): CapabilityDefinition | null {
  return typeof value === "string" ? CAPABILITIES_BY_ID.get(value as CapabilityId) ?? null : null;
}
export type CapabilityRequestResult =
  | { readonly accepted: true; readonly capabilities: readonly CapabilityDefinition[] }
  | { readonly accepted: false; readonly reason: "malformed" | "duplicate" | "unknown" | "reserved" | "wrong-surface" };
export function validateCapabilityRequest(value: unknown): CapabilityRequestResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { accepted: false, reason: "malformed" };
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys.join(",") !== "capabilities,surface,v" || record.v !== 1
    || (record.surface !== "demo" && record.surface !== "mod") || !Array.isArray(record.capabilities)
    || record.capabilities.length > 16 || record.capabilities.some((capability) => typeof capability !== "string")) {
    return { accepted: false, reason: "malformed" };
  }
  const requested = record.capabilities as readonly string[];
  if (new Set(requested).size !== requested.length) return { accepted: false, reason: "duplicate" };
  const definitions = requested.map(capabilityDefinition);
  if (definitions.some((definition) => definition === null)) return { accepted: false, reason: "unknown" };
  const known = definitions as readonly CapabilityDefinition[];
  if (known.some((definition) => !definition.surfaces.includes(record.surface as ExtensionSurface))) {
    return { accepted: false, reason: "wrong-surface" };
  }
  if (known.length) return { accepted: false, reason: "reserved" };
  return { accepted: true, capabilities: Object.freeze([]) };
}

// A decoded v1 mod identity.  This is deliberately not a loader or an
// approval: the only representable capability list is empty.  The OCaml
// decoder owns byte-level JSON validation (including duplicate member
// rejection); this projection is for already-decoded client observations.
export interface ModDescriptorV1 {
  readonly v: 1;
  readonly kind: "mod";
  readonly modId: string;
  readonly codeDigest: string;
  readonly capabilities: readonly CapabilityDefinition[];
}
const MOD_DESCRIPTOR_KEYS = "capabilities,code_digest,kind,mod_id,v";
const MOD_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const CODE_DIGEST_RE = /^[0-9a-f]{64}$/;
export function modDescriptorV1(value: unknown): ModDescriptorV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== MOD_DESCRIPTOR_KEYS || record.v !== 1 || record.kind !== "mod"
    || typeof record.mod_id !== "string" || !MOD_ID_RE.test(record.mod_id)
    || typeof record.code_digest !== "string" || !CODE_DIGEST_RE.test(record.code_digest)) return null;
  const capabilities = validateCapabilityRequest({ v: 1, surface: "mod", capabilities: record.capabilities });
  if (!capabilities.accepted || capabilities.capabilities.length !== 0) return null;
  return Object.freeze({ v: 1, kind: "mod", modId: record.mod_id, codeDigest: record.code_digest,
    capabilities: Object.freeze([]) });
}
export function sameModCodeRevision(left: ModDescriptorV1, right: ModDescriptorV1): boolean {
  return left.modId === right.modId && left.codeDigest === right.codeDigest;
}
export interface Applicability {
  readonly kind: PaneKind;
  readonly multiple: boolean;
  readonly rawCodex: boolean;
  readonly fileWeb: boolean;
  readonly watching: boolean;
}
export interface MenuAction extends ActionDefinition {}
export function availableActions(view: Applicability): readonly MenuAction[] {
  const entries: MenuAction[] = [];
  const add = (id: ActionId, override?: Pick<MenuAction, "messageKey" | "label">): void => {
    const definition = actionDefinition(id);
    if (!definition) throw new Error(`unknown Mesh action: ${id}`);
    const entry = Object.freeze(override ? { ...definition, ...override } : definition);
    if (!actionMessageKey(entry.messageKey)) throw new Error(`unknown Mesh action message key: ${entry.messageKey}`);
    entries.push(entry);
  };
  if (view.kind === "mesh") {
    add("file"); add("compose"); add("browse"); add("redraw"); add("demo"); add("folder");
    if (view.rawCodex) add("raw");
    add("stop");
  } else if (view.kind === "web" || view.kind === "board") {
    add("reload"); add("newtab");
    if (view.kind === "web" && view.fileWeb) add("watch", view.watching
      ? { messageKey: "action.watch-stop", label: translate("paneActions.action.watchStop") }
      : undefined);
  }
  if (view.multiple) add("close");
  return entries;
}

export interface Identity { readonly id: string; readonly name: string; readonly created: number | null }
export interface PaneEvidence {
  readonly pane: object; readonly id: string | null; readonly name: string | null;
  readonly sessionId: string | null;
  readonly displayName: string; readonly created: number | null; readonly view: number;
  readonly kind: PaneKind; readonly available: boolean;
}
export interface CapturedTarget extends PaneEvidence { readonly activeSensitive: boolean }
export interface TargetRegistry {
  readonly observePane: (evidence: PaneEvidence) => void;
  readonly setActive: (pane: object | null) => void;
  readonly invalidatePane: (pane: object) => void;
  readonly capture: (pane: object, activeSensitive?: boolean) => CapturedTarget | null;
  readonly valid: (target: CapturedTarget) => boolean;
  readonly release: (target: CapturedTarget) => void;
  readonly applyInventory: (issue: number, identities: readonly Identity[]) => boolean;
  readonly identity: (id: string) => Identity | null;
}
export function createTargetRegistry(): TargetRegistry {
  const panes = new Map<object, PaneEvidence>();
  const tokens = new Map<CapturedTarget, boolean>();
  let active: object | null = null;
  let applied = 0;
  let inventory = new Map<string, Identity>();
  const equal = (a: PaneEvidence, b: PaneEvidence): boolean => a.pane === b.pane && a.id === b.id
    && a.name === b.name && a.sessionId === b.sessionId && a.created === b.created && a.view === b.view && a.kind === b.kind && b.available;
  const valid = (target: CapturedTarget): boolean => {
    if (tokens.get(target) !== true) return false;
    const current = panes.get(target.pane);
    if (!current || !equal(target, current) || (target.activeSensitive && active !== target.pane)) {
      tokens.set(target, false); return false;
    }
    return true;
  };
  return {
    observePane(evidence) {
      if (evidence.available) panes.set(evidence.pane, Object.freeze({ ...evidence }));
      else panes.delete(evidence.pane);
      for (const target of tokens.keys()) if (target.pane === evidence.pane) valid(target);
    },
    setActive(pane) {
      active = pane;
      for (const target of tokens.keys()) if (target.activeSensitive && target.pane !== pane) tokens.set(target, false);
    },
    invalidatePane(pane) {
      for (const target of tokens.keys()) if (target.pane === pane) tokens.set(target, false);
    },
    capture(pane, activeSensitive = false) {
      const evidence = panes.get(pane);
      if (!evidence?.available || (activeSensitive && active !== pane)) return null;
      if ((evidence.kind === "mesh" || evidence.kind === "board") && applied > 0) {
        const observed = evidence.sessionId ? inventory.get(evidence.sessionId) : null;
        if (!observed || observed.name !== evidence.name || observed.created !== evidence.created) return null;
      }
      const target = Object.freeze({ ...evidence, activeSensitive });
      tokens.set(target, true); return target;
    },
    valid,
    release(target) { tokens.delete(target); },
    applyInventory(issue, identities) {
      if (!Number.isSafeInteger(issue) || issue <= applied) return false;
      if (identities.some((identity) => typeof identity.id !== "string" || !identity.id
        || typeof identity.name !== "string" || !identity.name
        || (identity.created !== null && !Number.isFinite(identity.created)))) return false;
      const next = new Map(identities.map((identity) => [identity.id, Object.freeze({ ...identity })]));
      if (next.size !== identities.length) return false;
      inventory = next; applied = issue;
      for (const target of tokens.keys()) {
        if (target.kind !== "mesh" && target.kind !== "board") continue;
        const current = target.sessionId ? inventory.get(target.sessionId) : null;
        if (!current || current.name !== target.name || current.created !== target.created) tokens.set(target, false);
      }
      return true;
    },
    identity(id) { return inventory.get(id) ?? null; },
  };
}

export interface StopPorts {
  readonly valid: (target: CapturedTarget) => boolean;
  readonly confirm: (target: CapturedTarget) => boolean;
  readonly dispatch: (target: CapturedTarget) => void | Promise<void>;
}
export type StopOutcome = "refused" | "cancelled" | "dispatched";
export function createStopGuard(ports: StopPorts): (target: CapturedTarget) => Promise<StopOutcome> {
  // The real endpoint is name-based. Two panes (or a replaced incarnation)
  // must not launch concurrent confirmation/dispatch for that same name.
  const pending = new Set<string>();
  return async (target) => {
    if (target.kind !== "mesh" || !target.name || pending.has(target.name) || !ports.valid(target)) return "refused";
    const key = target.name;
    pending.add(key);
    try {
      if (!ports.valid(target)) return "refused";
      if (!ports.confirm(target)) return "cancelled";
      // Native confirmation can run a nested browser event loop. Recheck now.
      if (!ports.valid(target)) return "refused";
      await ports.dispatch(target);
      return "dispatched";
    } finally { pending.delete(key); }
  };
}

export interface PasteSocket { send(bytes: Uint8Array): void }
export interface PasteConnection {
  readonly ws: PasteSocket | null;
  readonly closed: boolean; readonly ended?: boolean; readonly initializing: boolean;
}
export interface PasteBinding {
  readonly pane: object; readonly target: CapturedTarget;
  readonly connection: PasteConnection; readonly socket: PasteSocket;
  readonly current?: () => boolean;
}
export type PasteResultKind = "refused" | "paste" | "submitted" | "uncertain";
export interface PasteResult {
  readonly kind: PasteResultKind;
  readonly requestedBytes: number; readonly frames: number; readonly wireBytes: number;
  readonly unknownAttempt: boolean;
  readonly reason: "guard" | "incomplete" | "send" | "paste" | "schedule" | "cancel" | null;
}
export interface PastePorts {
  readonly valid: (target: CapturedTarget) => boolean;
  readonly connection: (pane: object) => PasteConnection | null;
  readonly open: (socket: PasteSocket) => boolean;
  readonly paste: (pane: object, text: string) => void;
  readonly encode: (text: string) => Uint8Array;
  readonly send?: (pane: object, socket: PasteSocket, bytes: Uint8Array, complete: boolean) => boolean;
  readonly defer?: (binding: PasteBinding, text: string, resume: () => void, cancel: () => void) => {start(): void; settle(): void};
  readonly schedule: (callback: () => void) => void;
}
export interface PasteDelivery {
  readonly capture: (pane: object, target: CapturedTarget, current?: () => boolean) => PasteBinding | null;
  readonly onData: (pane: object, frame: string, ordinary: () => void) => void;
  readonly deliver: (binding: PasteBinding, text: string | Promise<string>, enter: boolean,
    settle: (result: PasteResult) => void) => { readonly cancel: () => void };
}
export function createPasteDelivery(ports: PastePorts): PasteDelivery {
  type Attempt = { binding: PasteBinding; frames: number; wireBytes: number; joined: string;
    stopped: boolean; unknown: boolean; reason: PasteResult["reason"] };
  let current: Attempt | null = null;
  const valid = (binding: PasteBinding): boolean => ports.valid(binding.target)
    && (!binding.current || binding.current())
    && ports.connection(binding.pane) === binding.connection
    && binding.connection.ws === binding.socket
    && !binding.connection.closed && !binding.connection.ended && !binding.connection.initializing
    && ports.open(binding.socket);
  const result = (attempt: Attempt, requestedBytes: number, kind: PasteResultKind): PasteResult => ({
    kind, requestedBytes, frames: attempt.frames, wireBytes: attempt.wireBytes,
    unknownAttempt: attempt.unknown, reason: attempt.reason,
  });
  const send = (attempt: Attempt, frame: string): void => {
    if (attempt.stopped) return;
    if (!valid(attempt.binding)) { attempt.stopped = true; attempt.reason = "guard"; return; }
    const bytes = ports.encode(frame);
    try {
      const accepted = ports.send
        ? ports.send(attempt.binding.pane, attempt.binding.socket, bytes, frame === "\r")
        : (attempt.binding.socket.send(bytes), true);
      if (!accepted) throw new Error("send refused");
    }
    catch { attempt.stopped = true; attempt.unknown = true; attempt.reason = "send"; return; }
    attempt.frames++; attempt.wireBytes += bytes.byteLength; attempt.joined += frame;
  };
  return {
    capture(pane, target, current) {
      const connection = ports.connection(pane), socket = connection?.ws;
      if (!connection || !socket) return null;
      const binding = Object.freeze({ pane, target, connection, socket, ...(current ? {current} : {}) });
      return valid(binding) ? binding : null;
    },
    onData(pane, frame, ordinary) {
      const attempt = current;
      if (attempt?.binding.pane === pane) send(attempt, frame);
      else ordinary();
    },
    deliver(binding, payload, enter, settle) {
      let ready = typeof payload === "string", running = false;
      let text = ready ? payload as string : "";
      let requestedBytes = ports.encode(text).byteLength;
      const attempt: Attempt = { binding, frames: 0, wireBytes: 0, joined: "",
        stopped: false, unknown: false, reason: null };
      let settled = false, deferred: {start(): void; settle(): void} | null = null;
      const finish = (kind: PasteResultKind): void => {
        if (settled) return;
        settled = true;
        try {settle(result(attempt, requestedBytes, kind));}
        finally {deferred?.settle();}
      };
      const operation = { cancel: (): void => {
        if (settled) return;
        attempt.stopped = true; attempt.reason = "cancel";
        finish(attempt.frames || attempt.unknown ? "uncertain" : "refused");
      } };
      const run = (): void => {
        if (settled || running) return;
        if (!ready) return;
        running = true;
        if (!valid(binding)) { attempt.reason = "guard"; finish("refused"); return; }
        if (!text) {
          if (!enter) { attempt.reason = "incomplete"; finish("refused"); return; }
          send(attempt, "\r");
          finish(attempt.stopped ? (attempt.unknown ? "uncertain" : "refused") : "submitted");
          return;
        }
        const previous = current;
        current = attempt;
        try { ports.paste(binding.pane, text); }
        catch { attempt.stopped = true; attempt.unknown = true; attempt.reason = "paste"; }
        finally { current = previous; }
        // xterm may normalize line endings and surround the payload with bracketed
        // paste frames. Do not accept a framing-only or truncated synchronous paste.
        const normalize = (value: string): string => value.replace(/\r\n|\n/g, "\r");
        if (!attempt.stopped && (!attempt.frames || !normalize(attempt.joined).includes(normalize(text)))) {
          attempt.stopped = true; attempt.reason = "incomplete";
        }
        if (attempt.stopped) {
          finish(attempt.frames || attempt.unknown ? "uncertain" : "refused");
          return;
        }
        if (!enter) { finish("paste"); return; }
        try {
          ports.schedule(() => {
            if (settled) return;
            send(attempt, "\r");
            finish(attempt.stopped ? "uncertain" : "submitted");
          });
        } catch { attempt.reason = "schedule"; finish("uncertain"); }
      };
      if (!ready) void (payload as Promise<string>).then(value => {
        if (settled) return;
        text = value; requestedBytes = ports.encode(text).byteLength; ready = true;
        if (deferred) deferred.start();
        else run();
      }, () => {
        if (settled) return;
        attempt.reason = "paste"; finish("refused");
      });
      if (!valid(binding)) {attempt.reason = "guard"; finish("refused"); return operation;}
      deferred = ports.defer?.(binding, text, run, operation.cancel) ?? null;
      if (deferred) deferred.start();
      else run();
      return operation;
    },
  };
}

// A composer opening owns one destination and one text revision. Closing it
// retires that destination; selecting another pane does not. The browser owns
// the textarea and transport, while this small domain gate prevents stale
// asynchronous work from acquiring either one.
export interface ComposeOwner {
  readonly target: CapturedTarget;
  readonly binding: PasteBinding;
  readonly revision: number;
  readonly open: boolean;
  readonly pending: boolean;
  readonly change: () => boolean;
  readonly begin: () => number | null;
  readonly settle: (revision: number) => boolean;
  readonly acceptsUpload: (revision: number) => boolean;
  readonly close: () => void;
}
export function createComposeOwner(target: CapturedTarget, binding: PasteBinding): ComposeOwner {
  let revision = 0, open = true, pending = false;
  return {
    target, binding,
    get revision() { return revision; },
    get open() { return open; },
    get pending() { return pending; },
    change() { if (!open || pending) return false; revision++; return true; },
    begin() { if (!open || pending) return null; pending = true; return revision; },
    settle(original) {
      if (!pending) return false;
      pending = false;
      return open && original === revision;
    },
    acceptsUpload(original) { return open && !pending && original === revision; },
    close() { open = false; },
  };
}

export interface ChooserToken {
  readonly source: object;
  readonly destination: object;
  readonly serial: number;
}
export interface ChooserGate {
  readonly pending: ChooserToken | null;
  readonly acquire: (source: object, destination: object) => ChooserToken | null;
  readonly owns: (token: ChooserToken) => boolean;
  readonly settle: (token: ChooserToken) => boolean;
  readonly reset: (token: ChooserToken) => boolean;
}
export function createChooserGate(): ChooserGate {
  let pending: ChooserToken | null = null, serial = 0;
  const settle = (token: ChooserToken): boolean => {
    if (pending !== token) return false;
    pending = null; return true;
  };
  return {
    get pending() { return pending; },
    acquire(source, destination) {
      if (pending) return null;
      const token = Object.freeze({ source, destination, serial: ++serial });
      pending = token; return token;
    },
    owns(token) { return pending === token && token.source === pending.source; },
    settle,
    reset: settle,
  };
}

type SessionActionRequest = Readonly<{
  id: string;
  action: "create" | "restart" | "switch_account" | "settings";
  state: "pending" | "claimed";
  preset: string | null;
  model: string | null;
  effort?: string | null;
  // The option tokens the server will add to this launch, already joined for display ('' when none),
  // and the revision of the file they were read from: the approval names the version it saw.
  options?: string | null;
  options_revision?: string | null;
  lease_expires_at?: number | null;
  source: Readonly<{ id: string }>;
  // switch_account: the account ids, and their labels as the server knows them
  account?: string | null;
  account_label?: string | null;
  from_account?: string | null;
  from_label?: string | null;
}>;

// The owner reads the label of the "New session" form, not an internal preset id.
const PRESET_LABEL_KEYS: Readonly<Record<string, string>> = Object.freeze({ "codex-yolo": "new.codexYolo" });

function presetLabel(preset: string | null): string {
  if (preset === null) return translate("paneActions.sessionRequest.defaultPreset");
  const key = Object.hasOwn(PRESET_LABEL_KEYS, preset) ? PRESET_LABEL_KEYS[preset] : undefined;
  return key ? translate(key) : preset;
}

/** An account as the switch dialog names it: its label, and its id when the label differs. */
function accountName(id: string, label: string | null | undefined): string {
  return typeof label === "string" && label && label !== id ? `${label} (${id})` : id;
}

function describeSessionRequest(request: SessionActionRequest): string {
  const params = { agent: request.source.id, model: request.model, preset: presetLabel(request.preset) };
  // The owner's stored options run too, so the confirmation names them: consent covers what will run.
  const withOptions = (text: string): string => {
    const options = typeof request.options === "string" ? request.options.trim() : "";
    return options ? translate("paneActions.sessionRequest.withOptions", { text, options }) : text;
  };
  if (request.action === "switch_account") {
    // The owner approves sending the whole conversation to the other account's provider: the text says so.
    return translate("paneActions.sessionRequest.switchAccount", { agent: request.source.id,
      from: accountName(request.from_account as string, request.from_label),
      to: accountName(request.account as string, request.account_label) });
  }
  if (request.action === "settings") {
    if (request.effort) {
      return translate(request.model ? "paneActions.sessionRequest.restartWithSettings"
        : "paneActions.sessionRequest.restartWithEffort", {...params, effort: request.effort});
    }
    return translate("paneActions.sessionRequest.restartWithSelectedModel", params);
  }
  if (request.action === "restart") {
    return request.model ? translate("paneActions.sessionRequest.restartWithModel", params)
      : translate("paneActions.sessionRequest.restart", params);
  }
  return withOptions(request.model ? translate("paneActions.sessionRequest.createWithModel", params)
    : translate("paneActions.sessionRequest.create", params));
}

type SessionRequestClaim = Readonly<{kind: "claimed"; claimNonce: string}>;
type SessionRequestBusy = Readonly<{kind: "busy"; leaseExpiresAt: number | null}>;

/** One owner dialog per server lease, with retry only after transport failure. */
export function createSessionRequestGate(ports: Readonly<{
  claim: (id: string, claimNonce?: string) => Promise<SessionRequestClaim | SessionRequestBusy | "stale" | "retry">;
  confirm: (message: string) => boolean;
  decide: (id: string, approve: boolean, claimNonce: string, optionsRevision?: string) => Promise<"settled" | "stale" | "retry">;
  notify: (message: string) => void;
  now?: () => number;
  jitterMs?: (id: string) => number;
}>) {
  const handled = new Set<string>();
  const inFlight = new Set<string>();
  const claims = new Map<string, string>();
  // The owner's answer, kept with the text it answered: a request whose options changed under it is asked again.
  const decisions = new Map<string, { approve: boolean; description: string; revision: string | undefined }>();
  const retryAfter = new Map<string, number>();
  const notifiedLease = new Map<string, number>();
  const now = ports.now ?? Date.now;
  const jitterMs = ports.jitterMs ?? ((id: string) => 50 + ([...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 201));
  const boundedRetryAt = (id: string, epochMs: number | null): number => {
    const current = now();
    if (epochMs === null) return current + 1000;
    return Math.max(current + 250, Math.min(epochMs + jitterMs(id), current + 60_000));
  };
  const valid = (value: unknown): value is SessionActionRequest => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const request = value as Partial<SessionActionRequest>;
    const switchNames = request.action !== "switch_account"
      || (typeof request.account === "string" && request.account.length > 0
        && typeof request.from_account === "string" && request.from_account.length > 0);
    const settings = request.action !== "settings"
      || ((request.model === null || typeof request.model === "string")
        && (request.effort === null || typeof request.effort === "string")
        && Boolean(request.model || request.effort));
    return typeof request.id === "string" && request.id.length > 0
      && (request.action === "create" || request.action === "restart"
        || request.action === "switch_account" || request.action === "settings")
      && switchNames && settings
      && (request.state === "pending" || request.state === "claimed") && !!request.source
      && typeof request.source.id === "string";
  };
  return {
    async consider(values: unknown): Promise<void> {
      if (!Array.isArray(values)) return;
      const visible = new Set(values.flatMap(value => value && typeof value === "object"
        && typeof (value as {id?: unknown}).id === "string" ? [(value as {id: string}).id] : []));
      for (const id of retryAfter.keys()) if (!visible.has(id)) retryAfter.delete(id);
      for (const id of notifiedLease.keys()) if (!visible.has(id)) notifiedLease.delete(id);
      for (const value of values) {
        if (!valid(value) || handled.has(value.id) || inFlight.has(value.id)) continue;
        const leaseHint = typeof value.lease_expires_at === "number" && Number.isFinite(value.lease_expires_at)
          ? value.lease_expires_at * 1000 : null;
        const waitUntil = retryAfter.get(value.id) ?? (value.state === "claimed" && leaseHint !== null
          ? boundedRetryAt(value.id, leaseHint) : 0);
        if (waitUntil > now()) {
          retryAfter.set(value.id, waitUntil);
          if (notifiedLease.get(value.id) !== waitUntil) {
            notifiedLease.set(value.id, waitUntil);
            ports.notify(translate("paneActions.sessionRequest.leaseWait"));
          }
          continue;
        }
        retryAfter.delete(value.id);
        inFlight.add(value.id);
        const claim = await ports.claim(value.id, claims.get(value.id));
        if (claim === "stale") {
          handled.add(value.id);
          ports.notify(translate("paneActions.sessionRequest.stale"));
          inFlight.delete(value.id); continue;
        }
        if (typeof claim === "object" && claim.kind === "busy") {
          const expiry = boundedRetryAt(value.id, claim.leaseExpiresAt === null
            ? null : claim.leaseExpiresAt * 1000);
          retryAfter.set(value.id, expiry);
          if (notifiedLease.get(value.id) !== expiry) {
            notifiedLease.set(value.id, expiry);
            ports.notify(translate("paneActions.sessionRequest.leaseWait"));
          }
          inFlight.delete(value.id); continue;
        }
        if (claim === "retry") { inFlight.delete(value.id); continue; }
        retryAfter.delete(value.id); notifiedLease.delete(value.id);
        claims.set(value.id, claim.claimNonce);
        const description = describeSessionRequest(value);
        const revision = typeof value.options_revision === "string" ? value.options_revision : undefined;
        const answered = decisions.get(value.id);
        const approve = answered !== undefined && answered.description === description && answered.revision === revision ? answered.approve
          : ports.confirm(translate("paneActions.sessionRequest.confirm", { description }));
        decisions.set(value.id, { approve, description, revision });
        const outcome = await ports.decide(value.id, approve, claim.claimNonce, revision);
        if (outcome === "settled") handled.add(value.id);
        if (outcome === "stale") {
          handled.add(value.id);
          ports.notify(translate("paneActions.sessionRequest.decidedElsewhere"));
        }
        if (outcome !== "retry") { claims.delete(value.id); decisions.delete(value.id); }
        inFlight.delete(value.id);
      }
    },
  };
}

export type UploadItem = Readonly<{
  name: string; status: "pending" | "uploaded" | "error" | "skipped";
  path: string | null; error: string | null;
}>;
export interface UploadBatch {
  readonly items: readonly UploadItem[];
  readonly abandoned: boolean;
  readonly complete: boolean;
  readonly next: () => number | null;
  readonly finish: (index: number, outcome: { path: string } | { error: string }) => boolean;
  readonly abandon: () => boolean;
}
export function createUploadBatch(names: readonly string[]): UploadBatch {
  let items: readonly UploadItem[] = Object.freeze(names.map((name) => Object.freeze({
    name, status: "pending", path: null, error: null,
  })));
  let cursor = 0, inFlight: number | null = null, abandoned = false;
  return {
    get items() { return items; },
    get abandoned() { return abandoned; },
    get complete() { return inFlight === null && (abandoned || cursor === items.length); },
    next() {
      if (abandoned || inFlight !== null || cursor >= items.length) return null;
      inFlight = cursor++;
      return inFlight;
    },
    finish(index, outcome) {
      if (inFlight !== index || index < 0 || index >= items.length) return false;
      const path = "path" in outcome ? outcome.path : null;
      const error = "error" in outcome ? outcome.error : null;
      if ((path === null) === (error === null) || path === "" || error === "") return false;
      items = Object.freeze(items.map((item, at) => at === index ? Object.freeze({
        name: item.name, status: path === null ? "error" : "uploaded", path, error,
      }) : item));
      inFlight = null;
      return true;
    },
    abandon() {
      if (abandoned || (inFlight === null && cursor === items.length)) return false;
      abandoned = true;
      items = Object.freeze(items.map((item, at) => at >= cursor && item.status === "pending"
        ? Object.freeze({ ...item, status: "skipped" }) : item));
      return true;
    },
  };
}

export interface MenuPorts {
  readonly activate: () => void;
  readonly actions: () => readonly MenuAction[];
  readonly capture: () => CapturedTarget | null;
  readonly valid: (target: CapturedTarget) => boolean;
  readonly release: (target: CapturedTarget) => void;
  readonly run: (action: ActionId, target: CapturedTarget) => void | Promise<void>;
  readonly hold: (held: boolean) => void;
  readonly canFocus: (element: HTMLElement) => boolean;
  readonly fallbackFocus: () => void;
  readonly reportError: (error: unknown) => void;
}
export interface MenuController {
  readonly refresh: () => void;
  readonly close: (reason?: "escape" | "outside" | "tab" | "invalidate") => void;
  readonly dispose: () => void;
}
let nextMenuId = 0;
type MenuCloseReason = "escape" | "outside" | "tab" | "invalidate";

/** Where the focus goes once the menu is hidden: see createMenu. */
function focusAfterMenuHide(trigger: HTMLButtonElement, ports: MenuPorts, ownerDocument: Document,
  focus: { menuHeldFocus: boolean; triggerWasFocusTarget: boolean }, reason: MenuCloseReason): void {
  if (focus.menuHeldFocus) {
    // A hidden focused row remains document.activeElement in Chromium. Tab
    // starts at the trigger; other exits must not strand keyboard focus.
    // Capture eligibility before hiding: getClientRects can be transiently
    // empty while Chromium removes the focused menu row from layout.
    if (focus.triggerWasFocusTarget && trigger.isConnected && !trigger.hidden) trigger.focus({ preventScroll: true });
    else ports.fallbackFocus();
  } else if (reason === "escape") {
    const current = ownerDocument.activeElement;
    if (!(current && current !== ownerDocument.body && ports.canFocus(current as HTMLElement))) ports.fallbackFocus();
  }
}

/** Arrow keys, Home and End move between the entries. True when the key was one of them. */
function moveMenuFocus(menu: HTMLElement, ownerDocument: Document, key: string): boolean {
  const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  if (!buttons.length) return false;
  const at = buttons.indexOf(ownerDocument.activeElement as HTMLButtonElement);
  let next: number;
  if (key === "ArrowDown") next = (at + 1) % buttons.length;
  else if (key === "ArrowUp") next = (at - 1 + buttons.length) % buttons.length;
  else if (key === "Home") next = 0;
  else if (key === "End") next = buttons.length - 1;
  else return false; // Native Enter/Space activation fires exactly one click.
  buttons[next]?.focus({ preventScroll: true });
  return true;
}

/** Entries of an unbound menu are unavailable (aria-disabled). The menu itself is never marked busy:
 * some screen readers would then hold back its content. */
function markMenuEntries(menu: HTMLElement, available: boolean): void {
  for (const entry of menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')) {
    if (available) entry.removeAttribute("aria-disabled"); else entry.setAttribute("aria-disabled", "true");
  }
}

export function createMenu(root: HTMLElement, ports: MenuPorts): MenuController {
  const trigger = root.querySelector<HTMLButtonElement>('[data-act="more"]');
  const menu = root.querySelector<HTMLElement>('[role="menu"]');
  if (!trigger || !menu) throw new Error("Pane menu elements missing");
  menu.id = `pane-actions-menu-${++nextMenuId}`;
  trigger.setAttribute("aria-controls", menu.id);
  // Pane headers are created in an inert template document and adopted later.
  // Resolve the live document at interaction time, never at construction.
  const ownerDocument = (): Document => root.ownerDocument;
  let outsideDocument: Document | null = null;
  // An opening of the menu. Before the session list names the pane's session (its terminal attaches
  // first), no target can be captured: the menu still opens, its entries marked unavailable
  // (aria-disabled), and the next refresh() that can capture one binds it and enables them. Only a
  // bound menu holds a pending reload of the page (`hold`): an unbound one has nothing to lose.
  type Opening = { target: CapturedTarget | null; signature: string };
  let opened: Opening | null = null;
  const signature = (actions: readonly MenuAction[]): string => actions.map((action) => `${action.id}:${action.label}`).join("|");
  const hide = (reason: MenuCloseReason): void => {
    const menuHeldFocus = menu.contains(ownerDocument().activeElement);
    const triggerWasFocusTarget = menuHeldFocus && ports.canFocus(trigger);
    opened = null;
    outsideDocument?.removeEventListener("pointerdown", outside, true); outsideDocument = null;
    menu.hidden = true; trigger.setAttribute("aria-expanded", "false");
    focusAfterMenuHide(trigger, ports, ownerDocument(), { menuHeldFocus, triggerWasFocusTarget }, reason);
    ports.hold(false);
  };
  const close = (reason: MenuCloseReason = "invalidate"): void => {
    const original = opened;
    if (!original) return;
    hide(reason);
    if (original.target) ports.release(original.target);
  };
  const capture = (): CapturedTarget | null => {
    const target = ports.capture();
    if (target && ports.valid(target)) return target;
    if (target) ports.release(target);
    return null;
  };
  const entry = (opening: Opening, action: MenuAction): HTMLButtonElement => {
    const button = ownerDocument().createElement("button");
    button.type = "button"; button.setAttribute("role", "menuitem"); button.dataset.menuAction = action.id;
    button.textContent = action.label; button.className = action.danger ? "danger" : "";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (opened === opening && opening.target === null) return;   // not bound yet: the entry is unavailable
      const target = opening.target;
      if (opened !== opening || !target || !ports.valid(target)) { close(); return; }
      // End menu ownership before dispatch, retain only this callback's token.
      hide("invalidate");
      try {
        Promise.resolve(ports.run(action.id, target)).catch(ports.reportError).finally(() => ports.release(target));
      } catch (error) { ports.release(target); ports.reportError(error); }
    });
    return button;
  };
  const fill = (opening: Opening, actions: readonly MenuAction[]): void => {
    const heldFocus = menu.contains(ownerDocument().activeElement);
    opening.signature = signature(actions);
    menu.replaceChildren(...actions.map((action) => entry(opening, action)));
    markMenuEntries(menu, opening.target !== null);
    if (heldFocus) menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  };
  const open = (): void => {
    if (opened) { close(); return; }
    if (!trigger.isConnected || trigger.disabled || trigger.closest("[hidden], [inert]") || trigger.getClientRects().length === 0) return;
    ports.activate();
    if (!ports.canFocus(trigger)) return;
    const actions = ports.actions();
    if (!actions.length) return;
    const opening: Opening = { target: capture(), signature: "" };
    opened = opening;
    fill(opening, actions);
    trigger.setAttribute("aria-expanded", "true"); menu.hidden = false;
    if (opening.target) ports.hold(true);
    outsideDocument = ownerDocument(); outsideDocument.addEventListener("pointerdown", outside, true);
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  };
  const triggerClick = (event: Event): void => { event.stopPropagation(); open(); };
  const keydown = (event: KeyboardEvent): void => {
    if (!opened) return;
    if (opened.target && !ports.valid(opened.target)) { close(); return; }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close("escape"); return; }
    if (event.key === "Tab") { close("tab"); return; }
    if (moveMenuFocus(menu, ownerDocument(), event.key)) { event.preventDefault(); event.stopPropagation(); }
  };
  const outside = (event: PointerEvent): void => {
    const view = ownerDocument().defaultView;
    if (opened && view && event.target instanceof view.Node
      && !menu.contains(event.target) && !trigger.contains(event.target)) close("outside");
  };
  trigger.addEventListener("click", triggerClick);
  menu.addEventListener("keydown", keydown);
  const refresh = (): void => {
    const actions = ports.actions();
    trigger.hidden = actions.length === 0;
    const opening = opened;
    if (opening && opening.target === null && actions.length) {
      // Still unbound: follow the actions and bind as soon as a target can be captured.
      if (signature(actions) !== opening.signature) fill(opening, actions);
      opening.target = capture();
      markMenuEntries(menu, opening.target !== null);
      if (opening.target) ports.hold(true);
    } else if (opening && (!opening.target || !ports.valid(opening.target) || signature(actions) !== opening.signature)) close();
    if (!opened) trigger.setAttribute("aria-expanded", "false");
  };
  refresh();
  return { refresh, close, dispose() {
    close(); trigger.removeEventListener("click", triggerClick); menu.removeEventListener("keydown", keydown);
    outsideDocument?.removeEventListener("pointerdown", outside, true); outsideDocument = null;
  } };
}

// Phone direct writing: pure rules, in their own file.
export { directInput, directLineStarts, directLineTrigger, foregroundAgent } from "./direct-line.ts";
