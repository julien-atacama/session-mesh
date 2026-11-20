// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type {DictationChannel} from './dictation.ts';
import {hasDictationControls} from '../shared/dictation-text.ts';

export interface InlineJob {
  job_id: string; request_id: string; session: string; created: number;
  state: 'queued' | 'processing' | 'ready' | 'error' | 'cancelled' | 'settled';
  text: string | null; error: {code: string; message: string} | null;
  outcome: 'inserted' | 'submitted' | 'discarded' | null;
}
export type InlineState = 'idle' | 'requesting' | 'recording' | 'uploading' |
  'queued' | 'processing' | 'delivering' | 'recovery';
export class InlineSession {
  readonly name: string; readonly created: number;
  state: InlineState = 'idle'; message = '';
  requestId: string | null = null; job: InlineJob | null = null;
  constructor(name: string, created: number) {this.name = name; this.created = created;}
  get outstanding(): boolean {return this.state !== 'idle' || this.requestId !== null;}
}
export interface InlineDictationPorts {
  namespace: string; uuid(): string; allowed(): boolean; changed(): void;
  eligible(session: InlineSession): boolean;
  retain(session: InlineSession): DictationChannel | null;
  media: {supported(): boolean; permission(): Promise<MediaStream>; recorder(stream: MediaStream): MediaRecorder};
  request(path: string, init?: RequestInit): Promise<Response>;
  schedule(callback: () => void, ms: number): number; unschedule(id: number): void; now(): number;
  inserted?(session: InlineSession): void;
}
interface Config {enabled: boolean; max_bytes: number; capture_seconds: number;
  queue_wait_seconds?: number; active_timeout_seconds?: number; result_ttl_seconds?: number}
const DISABLED_REASONS = ['not_configured', 'invalid_configuration', 'runtime_unavailable',
  'startup_timeout', 'worker_failed'] as const;
type DisabledReason = typeof DISABLED_REASONS[number] | 'unavailable';
function disabledReason(value: unknown): DisabledReason {
  return DISABLED_REASONS.find(code => code === value) ?? 'unavailable';
}
interface Hold {
  session: InlineSession; active: boolean; cancel(): void; cancelled: Promise<void>;
  stream: MediaStream | null; recorder: MediaRecorder | null; chunks: Blob[]; bytes: number;
  released: boolean; completed: boolean; timer: number | null;
}
interface Details {
  generation: number; channel: DictationChannel | null; io: Set<AbortController>;
  timer: number | null; expires: number; recoveryDeadline: number; attempted: boolean;
  cleanup: Promise<boolean> | null; cleanupMode: 'inserted' | 'cancel' | null;
}
const CLEANUP_MS = 30000;
const ABANDONED_CANCEL_MS = 5000;
const validText = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
  && value.length <= 32768 && !hasDictationControls(value);

export class InlineDictationController {
  private readonly p: InlineDictationPorts;
  private started = false; private disposed = false; private suspended = false;
  private client = ''; private config: Config | null = null; private hold: Hold | null = null;
  private readonly sessions = new Map<string, InlineSession>();
  private readonly details = new Map<InlineSession, Details>();
  private readonly io = new Set<AbortController>();
  private configurationGeneration = 0;
  private configurationLoading: number | null = null; private configurationTerminal = false;
  private configurationTimer: number | null = null; private configurationFailures = 0;
  private serviceDisabled: DisabledReason | null = null; private serviceFailureChecked = false;
  constructor(ports: InlineDictationPorts) {this.p = ports;}
  private key(name: string, created: number): string {return JSON.stringify([this.p.namespace, name, created]);}
  session(name: string, created: number): InlineSession {
    const key = this.key(name, created);
    let s = this.sessions.get(key);
    if (!s) {
      // Passive UI uses peekSession; discard only terminal idle records, never uncertain identity.
      for (const [oldKey, old] of this.sessions) {
        if (this.sessions.size < 256) break;
        if (!old.outstanding && this.hold?.session !== old) {this.sessions.delete(oldKey); this.details.delete(old);}
      }
      if (this.sessions.size >= 256) return new InlineSession(name, created);
      s = new InlineSession(name, created); this.sessions.set(key, s);
      this.details.set(s, {generation: 0, channel: null, io: new Set(), timer: null, expires: 0, recoveryDeadline: 0,
        attempted: false, cleanup: null, cleanupMode: null});
    }
    return s;
  }
  peekSession(name: string, created: number): InlineSession | undefined {return this.sessions.get(this.key(name, created));}
  private allowed(): boolean {return this.started && !this.disposed && !this.suspended && this.p.allowed();}
  private notify(): void {if (!this.disposed) this.p.changed();}
  private headers(): Record<string, string> {return {'X-Mesh-Dictation-Client': this.client};}
  private current(s: InlineSession, generation: number): boolean {
    return this.allowed() && this.details.get(s)?.generation === generation;
  }
  private releaseChannel(s: InlineSession): void {
    const d = this.details.get(s)!; const channel = d.channel; d.channel = null; channel?.release();
  }
  private invalidate(s: InlineSession): void {
    const d = this.details.get(s)!; d.generation++;
    if (d.timer !== null) this.p.unschedule(d.timer); d.timer = null;
    for (const abort of d.io) abort.abort(); d.io.clear();
  }
  // Bound the entire response (including a stalled body) and race abort explicitly: test and
  // browser adapters need not resolve their promise merely because AbortSignal was aborted.
  private async read(path: string, init: RequestInit = {}, deadline = this.p.now() + CLEANUP_MS,
    s?: InlineSession, signal?: AbortSignal, fatalAuthentication = true): Promise<{response: Response; value: unknown}> {
    if (!this.allowed() || signal?.aborted || this.p.now() >= deadline) throw Error('unavailable');
    const abort = new AbortController(), set = s ? this.details.get(s)!.io : this.io;
    set.add(abort);
    const timer = this.p.schedule(() => abort.abort(), Math.max(0, deadline - this.p.now()));
    const cancel = (): void => abort.abort(); signal?.addEventListener('abort', cancel, {once: true});
    let rejectAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {rejectAbort = () => {this.p.unschedule(timer); reject(Error('aborted'));};});
    abort.signal.addEventListener('abort', rejectAbort, {once: true});
    try {
      return await Promise.race([aborted, (async () => {
        const response = await this.p.request(path, {...init, signal: abort.signal});
        if (abort.signal.aborted || !this.allowed() || this.p.now() >= deadline) throw Error('aborted');
        if (fatalAuthentication && (response.status === 401 || response.status === 403)) {this.dispose(); throw Error('authentication');}
        const value: unknown = await response.json().catch(() => null);
        if (abort.signal.aborted || !this.allowed() || this.p.now() >= deadline) throw Error('aborted');
        return {response, value};
      })()]);
    } finally {
      this.p.unschedule(timer); abort.signal.removeEventListener('abort', rejectAbort); set.delete(abort);
      signal?.removeEventListener('abort', cancel);
    }
  }
  async start(): Promise<void> {
    if (this.started || this.disposed || !this.p.allowed()) return;
    this.started = true; this.client = this.p.uuid();
    await this.configure();
  }
  private async configure(refresh = false): Promise<void> {
    if (!this.allowed() || (!refresh && (this.config || this.configurationTerminal))
      || this.configurationLoading !== null) return;
    const generation = ++this.configurationGeneration;
    this.configurationLoading = generation;
    let retry = false;
    try {
      const {response, value} = await this.read('/api/transcribe/config', {cache: 'no-store'});
      const c = value as Config & {disabled_reason?: unknown};
      if (generation !== this.configurationGeneration || !this.allowed()) return;
      retry = !refresh && response.status >= 500;
      if (response.ok && c?.enabled === false) {
        this.serviceDisabled = disabledReason(c.disabled_reason);
        if (this.hold) this.cancelHold(this.hold);
      }
      if (response.ok && c?.enabled === true && Number.isSafeInteger(c.max_bytes)
        && c.max_bytes > 0 && Number.isSafeInteger(c.capture_seconds) && c.capture_seconds > 0) {
        this.config = c; this.configurationFailures = 0;
      }
      this.configurationTerminal = !retry;
    } catch {retry = !refresh; /* Transient unavailability never acquires media. */ }
    finally {
      if (generation === this.configurationGeneration) {
        this.configurationLoading = null;
        if (retry && this.allowed() && !this.config) {
          const delay = Math.min(30000, 1000 * 2 ** Math.min(this.configurationFailures++, 5));
          this.configurationTimer = this.p.schedule(() => {
            this.configurationTimer = null; void this.configure();
          }, delay);
        }
      }
    }
    this.notify();
  }
  disabledReason(): DisabledReason | null {return this.serviceDisabled;}
  private serviceFailure(response: Response, value: unknown): void {
    const error = (value as {error?: {code?: unknown}} | null)?.error;
    if (response.status !== 503 || error?.code !== 'disabled' || this.serviceFailureChecked) return;
    // A closed relay refusal blocks new capture immediately. Refresh only the safe
    // config cause once; keep all original request identities and cleanup bounds.
    this.serviceFailureChecked = true; this.serviceDisabled = 'unavailable';
    if (this.hold) this.cancelHold(this.hold);
    // Diagnostics must not extend an existing job's result/cleanup deadline.
    void this.configure(true); this.notify();
  }
  reason(s: InlineSession): string {
    if (!this.allowed()) return 'unavailable';
    if (this.serviceDisabled) return this.serviceDisabled;
    if (!this.config || !this.details.has(s) || !Number.isFinite(s.created) || s.created <= 0) return 'unavailable';
    if (!this.p.media.supported()) return 'unsupported';
    if (this.hold) return 'microphoneBusy';
    const d = this.details.get(s)!;
    if (s.outstanding && !d.cleanupMode) return 'outstanding';
    if (!this.p.eligible(s)) return 'ineligible';
    return '';
  }
  async press(s: InlineSession): Promise<boolean> {
    if (this.reason(s)) return false;
    let cancel!: () => void;
    const hold: Hold = {session: s, active: true, cancel: () => cancel(), cancelled: new Promise<void>(r => {cancel = r;}),
      stream: null, recorder: null, chunks: [], bytes: 0, released: false, completed: false, timer: null};
    // Register before the first await, including recovery. Release must cancel this exact gesture.
    this.hold = hold; this.notify();
    const d = this.details.get(s)!;
    if (s.requestId) {
      // A fresh recovery hold is explicit local cancellation after the original fixed
      // window. This says nothing about remote admission and never reuses old audio.
      const abandoned = d.recoveryDeadline > 0 && this.p.now() >= d.recoveryDeadline && this.discard(s);
      const cleaned = abandoned || await Promise.race([this.cleanup(s), hold.cancelled.then(() => false)]);
      if (!cleaned || !this.held(hold)) {if (this.hold === hold) this.cancelHold(hold); return false;}
    }
    if (!this.held(hold) || !this.p.eligible(s)) {this.cancelHold(hold); return false;}
    let acquiring = true;
    try {
      const channel = this.p.retain(s);
      d.channel = channel;
      if (!channel?.valid() || (channel.captureFresh && !channel.captureFresh())) {
        this.cancelHold(hold, 'originalUnavailable'); return false;
      }
      acquiring = false;
      d.attempted = false; d.cleanupMode = null; d.recoveryDeadline = 0;
      s.state = 'requesting'; s.message = ''; this.notify();
      hold.timer = this.p.schedule(() => this.cancelHold(hold, 'permissionTimeout'), this.config!.capture_seconds * 1000);
      const permission = this.p.media.permission().then(stream => {
        if (!this.held(hold)) {stream.getTracks().forEach(track => track.stop()); return null;}
        return stream;
      });
      const stream = await Promise.race([permission, hold.cancelled.then(() => null)]);
      if (!stream) {if (this.hold === hold) this.cancelHold(hold); return false;}
      if (!this.held(hold)) {stream.getTracks().forEach(track => track.stop()); return false;}
      hold.stream = stream;
      if (!this.held(hold) || !this.p.eligible(s) || !this.fresh(s)) {this.cancelHold(hold, 'contextChanged'); return false;}
      if (hold.timer !== null) this.p.unschedule(hold.timer);
      const recorder = this.p.media.recorder(stream); hold.recorder = recorder;
      recorder.ondataavailable = event => {
        if (!hold.active || hold.completed || !event.data.size) return;
        hold.bytes += event.data.size;
        if (hold.bytes > this.config!.max_bytes) {this.cancelHold(hold, 'audioLimit'); return;}
        hold.chunks.push(event.data);
      };
      recorder.onerror = () => this.cancelHold(hold, 'recordingError');
      recorder.onstop = () => this.captured(hold);
      stream.getTracks().forEach(track => {track.onended = () => {if (!hold.released) this.cancelHold(hold, 'microphoneInterrupted');};});
      recorder.start(250); s.state = 'recording';
      hold.timer = this.p.schedule(() => this.cancelHold(hold, 'durationLimit'), this.config!.capture_seconds * 1000);
      this.notify(); return true;
    } catch {
      if (this.hold === hold) this.cancelHold(hold, acquiring ? 'originalUnavailable' : (hold.stream ? 'recordingError' : 'permissionDenied'));
      return false;
    }
  }
  private held(hold: Hold): boolean {return this.allowed() && this.hold === hold && hold.active && !hold.released;}
  private fresh(s: InlineSession): boolean {
    const c = this.details.get(s)!.channel;
    return !!c?.valid() && (!c.captureFresh || c.captureFresh());
  }
  private stop(hold: Hold): void {
    if (hold.timer !== null) this.p.unschedule(hold.timer); hold.timer = null;
    // Stop all owned tracks even if a broken recorder throws while stopping.
    try {if (hold.recorder?.state === 'recording') hold.recorder.stop();}
    finally {hold.stream?.getTracks().forEach(track => {track.onended = null; track.stop();}); hold.stream = null;}
  }
  private cancelHold(hold: Hold, message = ''): void {
    if (!hold.active) return;
    hold.active = false; hold.cancel();
    try {this.stop(hold);} catch { /* Tracks already stopped by finally. */ }
    hold.chunks = []; if (this.hold === hold) this.hold = null;
    const s = hold.session;
    if (!s.requestId) {this.releaseChannel(s); s.state = 'idle'; s.message = message;}
    this.notify();
  }
  release(s: InlineSession): void {
    const hold = this.hold;
    if (!hold || hold.session !== s) return;
    if (!hold.recorder || hold.recorder.state !== 'recording') {this.cancelHold(hold); return;}
    hold.released = true; s.state = 'uploading';
    try {this.stop(hold);} catch {this.cancelHold(hold, 'recordingError');}
    if (hold.active && !hold.completed) {
      hold.timer = this.p.schedule(() => this.cancelHold(hold, 'recordingError'), this.config!.capture_seconds * 1000);
    }
    this.notify();
  }
  private captured(hold: Hold): void {
    if (hold.completed || !hold.active || !hold.released || !this.allowed()) return;
    hold.completed = true;
    if (hold.timer !== null) this.p.unschedule(hold.timer); hold.timer = null;
    const s = hold.session, type = hold.chunks.find(chunk => chunk.type)?.type || hold.recorder?.mimeType || '';
    const audio = new Blob(hold.chunks, {type}); hold.chunks = [];
    hold.active = false; hold.cancel(); if (this.hold === hold) this.hold = null;
    if (!audio.size || !/^audio\/(webm|mp4|ogg|wav|x-wav)(;|$)/i.test(type)) {
      this.releaseChannel(s); s.state = 'idle'; s.message = 'invalidAudio'; this.notify(); return;
    }
    s.requestId = this.p.uuid();
    this.details.get(s)!.expires = 0;
    void this.upload(s, audio);
  }
  private job(s: InlineSession, value: unknown): InlineJob {
    const j = value as InlineJob;
    if (!j || typeof j.job_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(j.job_id) || j.request_id !== s.requestId
      || j.session !== s.name || j.created !== s.created || (s.job && j.job_id !== s.job.job_id)
      || !['queued', 'processing', 'ready', 'error', 'cancelled', 'settled'].includes(j.state)) throw Error('identity');
    return {...j};
  }
  private async upload(s: InlineSession, audio: Blob): Promise<void> {
    const d = this.details.get(s)!, generation = d.generation;
    try {
      const {response, value} = await this.read('/api/transcribe', {method: 'POST', headers: {...this.headers(),
        'Content-Type': audio.type, 'X-Mesh-Session': s.name, 'X-Mesh-Created': String(s.created),
        'X-Mesh-Request-Id': s.requestId!}, body: audio}, this.p.now() + CLEANUP_MS, s);
      if (!this.current(s, generation)) return;
      if (!response.ok) {
        this.serviceFailure(response, value);
        if (!this.current(s, generation)) return;
        if (response.status < 500) {this.finish(s, 'admissionRejected'); return;}
        throw Error('admission');
      }
      this.accept(s, this.job(s, value));
    } catch {if (this.current(s, generation)) void this.cleanup(s, 'cancel', 'admissionUnconfirmed');}
  }
  private accept(s: InlineSession, job: InlineJob): void {
    const d = this.details.get(s)!, c = this.config!;
    if (!d.expires) d.expires = this.p.now() + ((c.queue_wait_seconds ?? 600) + (c.active_timeout_seconds ?? 60)
      + (c.result_ttl_seconds ?? 1800)) * 1000;
    s.job = job;
    if (job.state === 'settled' || job.state === 'cancelled') {this.finish(s); return;}
    if (job.state === 'error') {void this.cleanup(s, 'cancel', job.error?.code || 'recognitionError'); return;}
    if (job.state === 'ready') {
      if (!validText(job.text)) {void this.cleanup(s, 'cancel', 'invalidTranscript'); return;}
      void this.deliver(s); return;
    }
    s.state = job.state; this.notify(); this.pollLater(s);
  }
  private pollLater(s: InlineSession): void {
    const d = this.details.get(s)!, generation = d.generation;
    if (this.p.now() >= d.expires) {void this.cleanup(s, 'cancel', 'resultExpired'); return;}
    d.timer = this.p.schedule(() => {
      d.timer = null; if (this.current(s, generation)) void this.poll(s);
    }, Math.min(1000, d.expires - this.p.now()));
  }
  private async poll(s: InlineSession): Promise<void> {
    const d = this.details.get(s)!, generation = d.generation;
    try {
      const {response, value} = await this.read(`/api/transcribe/${s.job!.job_id}`,
        {headers: this.headers(), cache: 'no-store'}, Math.min(d.expires, this.p.now() + CLEANUP_MS), s);
      if (!this.current(s, generation)) return;
      if (response.status === 404) {this.finish(s, 'jobMissing'); return;}
      if (!response.ok) {this.serviceFailure(response, value); throw Error('status');}
      this.accept(s, this.job(s, value));
    } catch {
      if (!this.current(s, generation)) return;
      s.message = this.serviceDisabled || 'statusUnavailable'; this.notify(); this.pollLater(s);
    }
  }
  private async deliver(s: InlineSession): Promise<void> {
    const d = this.details.get(s)!, generation = d.generation, expected = s.job!;
    if (d.attempted) return;
    s.state = 'delivering'; this.notify();
    // The channel owns the advancing revision during each frame, including the
    // transport write boundary. captureFresh/valid are pre-claim checks, not a
    // recursively callable frame guard while the lease advances its own write.
    const guard = (): boolean => this.current(s, generation) && s.state === 'delivering'
      && this.p.now() < d.expires && this.p.eligible(s);
    try {
      const {response, value} = await this.read(`/api/transcribe/${expected.job_id}`,
        {headers: this.headers(), cache: 'no-store'}, Math.min(d.expires, this.p.now() + CLEANUP_MS), s);
      if (!this.current(s, generation)) return;
      if (response.status === 404) {this.finish(s, 'jobMissing'); return;}
      if (!response.ok) {
        this.serviceFailure(response, value);
        if (!this.current(s, generation)) return;
        throw Error('status');
      }
      const verified = this.job(s, value);
      if (verified.state !== 'ready' || verified.text !== expected.text || !validText(verified.text)
        || !guard() || !this.fresh(s) || !d.channel!.claim() || !guard()) throw Error('guard');
      d.attempted = true;
      d.timer = this.p.schedule(() => {if (this.current(s, generation)) void this.cleanup(s, 'cancel', 'deliveryUncertain');},
        Math.max(0, Math.min(d.expires - this.p.now(), (this.config!.result_ttl_seconds ?? 1800) * 1000)));
      d.channel!.deliver(verified.text, result => {
        if (!this.current(s, generation) || s.state !== 'delivering') return;
        if ((result.kind === 'paste' || result.kind === 'draft') && guard()) {
          // Retire recognition after native insertion or phone-field staging, never submission.
          // Releasing the reference never clears native pending-input ownership (no clean H).
          void this.cleanup(s, 'inserted', '');
          this.p.inserted?.(s);
        } else void this.cleanup(s, 'cancel', result.kind === 'refused' ? 'contextChanged' : 'deliveryUncertain');
      }, guard);
    } catch {if (this.current(s, generation)) void this.cleanup(s, 'cancel', d.attempted ? 'deliveryUncertain' : 'resultUnconfirmed');}
  }
  private finish(s: InlineSession, message = ''): void {
    const d = this.details.get(s)!;
    this.invalidate(s); this.releaseChannel(s); d.cleanupMode = null; d.cleanup = null; d.recoveryDeadline = 0;
    s.requestId = null; s.job = null; s.state = 'idle'; s.message = message; this.notify();
  }
  private async wait(s: InlineSession, deadline: number): Promise<void> {
    const d = this.details.get(s)!, abort = new AbortController(); d.io.add(abort);
    let timer: number | null = null;
    await new Promise<void>(resolve => {
      const done = (): void => {if (timer !== null) this.p.unschedule(timer); d.io.delete(abort); resolve();};
      abort.signal.addEventListener('abort', done, {once: true});
      timer = this.p.schedule(done, Math.max(0, Math.min(1000, deadline - this.p.now())));
    });
  }
  private cleanup(s: InlineSession, mode?: 'inserted' | 'cancel', message?: string): Promise<boolean> {
    const d = this.details.get(s)!;
    if (d.cleanup) return d.cleanup;
    if (!s.requestId || !this.allowed()) return Promise.resolve(!s.requestId);
    this.invalidate(s); this.releaseChannel(s); d.cleanupMode = mode ?? d.cleanupMode ?? 'cancel';
    if (s.job) s.job = {...s.job, text: null};
    s.state = 'recovery'; if (message !== undefined) s.message = message; this.notify();
    if (!s.job && !d.recoveryDeadline) d.recoveryDeadline = this.p.now() + CLEANUP_MS;
    const generation = d.generation, deadline = d.recoveryDeadline || this.p.now() + CLEANUP_MS;
    const attempt = this.clean(s, generation, deadline);
    d.cleanup = attempt;
    void attempt.finally(() => {if (d.cleanup === attempt) d.cleanup = null;});
    return attempt;
  }
  private async clean(s: InlineSession, generation: number, deadline: number): Promise<boolean> {
    const d = this.details.get(s)!; let statusFirst = false;
    const complete = (): true => {
      this.finish(s, d.cleanupMode === 'cancel' && s.message !== 'cleanupUnavailable' ? s.message : ''); return true;
    };
    while (this.current(s, generation) && this.p.now() < deadline) {
      try {
        const known = s.job?.job_id;
        const action = d.cleanupMode === 'inserted' ? 'settle' : 'cancel';
        const control = !!known && !statusFirst;
        const path = known ? `/api/transcribe/${known}${control ? `/${action}` : ''}` : `/api/transcribe/request/${s.requestId}`;
        const {response, value} = await this.read(path, control ? {method: 'POST',
          headers: {...this.headers(), 'Content-Type': 'application/json'}, body: JSON.stringify(action === 'settle' ? {outcome: 'inserted'} : {})}
          : {headers: this.headers(), cache: 'no-store'}, deadline, s);
        if (!this.current(s, generation)) return false;
        if (known && response.status === 404) return complete();
        if (!response.ok) {this.serviceFailure(response, value); throw Error('unconfirmed');}
        const job = this.job(s, value); s.job = {...job, text: null};
        if (job.state === 'settled' || job.state === 'cancelled') return complete();
        statusFirst = false;
        // Lookup/status identified a still-live old job: cancel/settle immediately, not re-upload.
        if (!control) continue;
      } catch {statusFirst = !!s.job;}
      if (this.current(s, generation) && this.p.now() < deadline) await this.wait(s, deadline);
    }
    if (this.current(s, generation)) {
      this.invalidate(s); s.state = 'idle'; s.message = 'cleanupUnavailable'; this.notify();
    }
    return false;
  }
  discard(s: InlineSession): boolean {
    const d = this.details.get(s);
    if (!this.allowed() || !d || !s.requestId || !d.recoveryDeadline || this.p.now() < d.recoveryDeadline) return false;
    // Local abandonment, not a server cancellation acknowledgement. All old I/O
    // and delivery authority are revoked before permitting a new manual capture.
    const job = s.job?.job_id, headers = this.headers();
    this.finish(s);
    if (job) void this.cancelAbandoned(job, headers);
    return true;
  }
  private async cancelAbandoned(job: string, headers: Record<string, string>): Promise<void> {
    // This old-ID-only cleanup has no session/channel reference and cannot hold up
    // a fresh capture or mutate it. Its separate short deadline is never renewed.
    const abort = new AbortController(), deadline = this.p.now() + ABANDONED_CANCEL_MS;
    this.io.add(abort);
    try {
      while (this.allowed() && !abort.signal.aborted && this.p.now() < deadline) {
        try {
          const {response, value} = await this.read(`/api/transcribe/${job}/cancel`, {method: 'POST',
            headers: {...headers, 'Content-Type': 'application/json'}, body: '{}'}, deadline, undefined, abort.signal, false);
          if (abort.signal.aborted) return;
          const result = value as InlineJob;
          if (response.status === 404 || response.ok && result?.job_id === job
            && ['cancelled', 'settled'].includes(result.state)) return;
          if (response.status >= 400 && response.status < 500) return;
        } catch { /* Retry only this old control operation within the fixed bound. */ }
        if (!this.allowed() || abort.signal.aborted || this.p.now() >= deadline) return;
        await new Promise<void>(resolve => {
          const done = (): void => {this.p.unschedule(timer); abort.signal.removeEventListener('abort', done); resolve();};
          const timer = this.p.schedule(done, Math.min(1000, deadline - this.p.now()));
          abort.signal.addEventListener('abort', done, {once: true});
        });
      }
    } finally {this.io.delete(abort);}
  }
  detach(s: InlineSession): void {if (this.hold?.session === s && !this.hold.released) this.cancelHold(this.hold);}
  hidden(): void {if (this.hold && !this.hold.released) this.cancelHold(this.hold);}
  holds(): InlineSession[] {return [...this.sessions.values()].filter(s => s.outstanding || this.hold?.session === s);}
  suspendForPageCache(): void {
    if (this.disposed || this.suspended) return;
    this.suspended = true;
    this.configurationGeneration++;
    this.configurationLoading = null;
    if (this.configurationTimer !== null) this.p.unschedule(this.configurationTimer); this.configurationTimer = null;
    if (this.hold) this.cancelHold(this.hold);
    for (const abort of this.io) abort.abort();
    for (const s of this.sessions.values()) {
      const d = this.details.get(s)!;
      this.invalidate(s); this.releaseChannel(s); d.cleanup = null;
      if (s.requestId) {
        d.cleanupMode ??= 'cancel'; if (s.job) s.job = {...s.job, text: null};
        s.state = 'recovery'; s.message = 'channelUnavailable';
      }
    }
    this.notify();
  }
  resumeFromPageCache(): void {
    if (this.disposed || !this.suspended || !this.p.allowed()) return;
    this.suspended = false;
    if (!this.config) void this.configure();
    for (const s of this.sessions.values()) if (s.requestId) void this.cleanup(s);
    this.notify();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; if (this.hold) this.cancelHold(this.hold);
    if (this.configurationTimer !== null) this.p.unschedule(this.configurationTimer); this.configurationTimer = null;
    for (const abort of this.io) abort.abort();
    for (const s of this.sessions.values()) {this.invalidate(s); this.releaseChannel(s); if (s.job) s.job = {...s.job, text: null};}
  }
}
export function createInlineDictationController(ports: InlineDictationPorts): InlineDictationController {
  return new InlineDictationController(ports);
}
