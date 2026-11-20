// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// One delegated listener set for all panes; closed panes retain no document listeners.
interface HoldController<S> {
  press(session: S): Promise<boolean>;
  release(session: S): void;
  detach(session: S): void;
}
interface Target<S> {session: S; controller: HoldController<S>}
interface Hold<S> extends Target<S> {button: HTMLButtonElement; token: object}
interface Ports<S> {resolve(button: HTMLButtonElement): Target<S> | null}

function buttonFor(event: Event): HTMLButtonElement | null {
  return event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-act="dictate"]') : null;
}

class InlineDictationView<S> {
  private readonly ports: Ports<S>;
  private disposed = false;
  private held: Hold<S> | null = null;
  private pointer: {id: number; started: number; token: object} | null = null;
  private keyboard: {key: string; button: HTMLButtonElement; token: object; cancelled: boolean} | null = null;
  private readonly blocked = new Set<string>();

  constructor(ports: Ports<S>) {
    this.ports = ports;
    document.addEventListener('pointerdown', this.pointerDown);
    document.addEventListener('pointerup', this.pointerUp);
    document.addEventListener('pointercancel', this.pointerCancel);
    document.addEventListener('lostpointercapture', this.pointerCancel);
    document.addEventListener('keydown', this.keyDown, {capture: true});
    document.addEventListener('keyup', this.keyUp, {capture: true});
    document.addEventListener('focusout', this.focusOut);
    document.addEventListener('visibilitychange', this.visibility);
    document.addEventListener('click', this.preventClick);
    document.addEventListener('contextmenu', this.preventClick);
    window.addEventListener('blur', this.abandon);
  }
  private begin(button: HTMLButtonElement): object | null {
    if (this.disposed || this.held) return null;
    const target = this.ports.resolve(button);
    if (!target) return null;
    const token = {}; this.held = {...target, button, token};
    // The controller owns eligibility and recovery-before-permission checks.
    void target.controller.press(target.session);
    return token;
  }
  private cancelHold(token?: object): void {
    if (!this.held || token && token !== this.held.token) return;
    const old = this.held; this.held = null; old.controller.detach(old.session);
  }
  private release(token: object): void {
    if (!this.held || token !== this.held.token) return;
    const old = this.held; this.held = null; old.controller.release(old.session);
  }
  private readonly pointerDown = (event: PointerEvent): void => {
    const button = buttonFor(event);
    if (!button || event.button !== 0 || this.pointer) return;
    event.preventDefault();
    const token = this.begin(button);
    if (token) {
      this.pointer = {id: event.pointerId, started: event.timeStamp, token};
      try {button.setPointerCapture(event.pointerId);} catch {this.pointer = null; this.cancelHold(token);}
    }
  };
  private readonly pointerUp = (event: PointerEvent): void => {
    if (!this.pointer || event.pointerId !== this.pointer.id || event.timeStamp < this.pointer.started) return;
    event.preventDefault(); const token = this.pointer.token; this.pointer = null; this.release(token);
  };
  private readonly pointerCancel = (event: PointerEvent): void => {
    if (!this.pointer || event.pointerId !== this.pointer.id || event.timeStamp < this.pointer.started) return;
    if (event.type === 'lostpointercapture' && buttonFor(event)?.hasPointerCapture(event.pointerId)) return;
    const token = this.pointer.token; this.pointer = null; this.cancelHold(token);
  };
  private readonly keyDown = (event: KeyboardEvent): void => {
    const button = buttonFor(event);
    if (!button) return;
    if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); this.abandon(); return;}
    if (![' ', 'Enter'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    // A non-repeated down proves a fresh physical press, even if the previous
    // release occurred in another application after blur.
    if (!event.repeat && this.keyboard?.cancelled) this.keyboard = null;
    if (event.repeat || this.keyboard) {
      if (event.key !== this.keyboard?.key) this.blocked.add(event.key);
      return;
    }
    const token = this.begin(button);
    if (token) {this.keyboard = {key: event.key, button, token, cancelled: false}; this.blocked.delete(event.key);}
    else this.blocked.add(event.key);
  };
  private readonly keyUp = (event: KeyboardEvent): void => {
    if (this.blocked.delete(event.key)) {event.preventDefault(); event.stopPropagation(); return;}
    if (!this.keyboard || event.key !== this.keyboard.key) return;
    event.preventDefault(); event.stopPropagation();
    const old = this.keyboard; this.keyboard = null;
    if (!old.cancelled && document.activeElement === old.button) this.release(old.token);
    else this.cancelHold(old.token);
  };
  private readonly abandon = (): void => {
    if (this.keyboard) {this.keyboard.cancelled = true; this.cancelHold(this.keyboard.token);}
    if (this.pointer) {const token = this.pointer.token; this.pointer = null; this.cancelHold(token);}
  };
  private readonly focusOut = (event: FocusEvent): void => {
    if (this.keyboard && event.target === this.keyboard.button) {
      this.keyboard.cancelled = true; this.cancelHold(this.keyboard.token);
    }
  };
  private readonly visibility = (): void => {if (document.hidden) this.abandon();};
  private readonly preventClick = (event: Event): void => {if (buttonFor(event)) event.preventDefault();};

  cancel(session?: S): void {if (!session || this.held?.session === session) this.abandon();}
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abandon(); this.cancelHold();
    document.removeEventListener('pointerdown', this.pointerDown);
    document.removeEventListener('pointerup', this.pointerUp);
    document.removeEventListener('pointercancel', this.pointerCancel);
    document.removeEventListener('lostpointercapture', this.pointerCancel);
    document.removeEventListener('keydown', this.keyDown, {capture: true});
    document.removeEventListener('keyup', this.keyUp, {capture: true});
    document.removeEventListener('focusout', this.focusOut);
    document.removeEventListener('visibilitychange', this.visibility);
    document.removeEventListener('click', this.preventClick);
    document.removeEventListener('contextmenu', this.preventClick);
    window.removeEventListener('blur', this.abandon);
  }
}

export function createInlineDictationView<S>(ports: Ports<S>) {
  return new InlineDictationView(ports);
}
