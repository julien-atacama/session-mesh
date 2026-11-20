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

export function createInlineDictationView<S>(ports: Ports<S>) {
  let disposed = false;
  let held: Hold<S> | null = null;
  let pointer: {id: number; started: number; token: object} | null = null;
  let keyboard: {key: string; button: HTMLButtonElement; token: object; cancelled: boolean} | null = null;
  const blocked = new Set<string>();
  const buttonFor = (event: Event): HTMLButtonElement | null => event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>('[data-act="dictate"]') : null;
  const begin = (button: HTMLButtonElement): object | null => {
    if (disposed || held) return null;
    const target = ports.resolve(button);
    if (!target) return null;
    const token = {}; held = {...target, button, token};
    // The controller owns eligibility and recovery-before-permission checks.
    void target.controller.press(target.session);
    return token;
  };
  const cancel = (token?: object): void => {
    if (!held || token && token !== held.token) return;
    const old = held; held = null; old.controller.detach(old.session);
  };
  const release = (token: object): void => {
    if (!held || token !== held.token) return;
    const old = held; held = null; old.controller.release(old.session);
  };
  const pointerDown = (event: PointerEvent): void => {
    const button = buttonFor(event);
    if (!button || event.button !== 0 || pointer) return;
    event.preventDefault();
    const token = begin(button);
    if (token) {
      pointer = {id: event.pointerId, started: event.timeStamp, token};
      try {button.setPointerCapture(event.pointerId);} catch {pointer = null; cancel(token);}
    }
  };
  const pointerUp = (event: PointerEvent): void => {
    if (!pointer || event.pointerId !== pointer.id || event.timeStamp < pointer.started) return;
    event.preventDefault(); const token = pointer.token; pointer = null; release(token);
  };
  const pointerCancel = (event: PointerEvent): void => {
    if (!pointer || event.pointerId !== pointer.id || event.timeStamp < pointer.started) return;
    if (event.type === 'lostpointercapture' && buttonFor(event)?.hasPointerCapture(event.pointerId)) return;
    const token = pointer.token; pointer = null; cancel(token);
  };
  const keyDown = (event: KeyboardEvent): void => {
    const button = buttonFor(event);
    if (!button) return;
    if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); abandon(); return;}
    if (![' ', 'Enter'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    // A non-repeated down proves a fresh physical press, even if the previous
    // release occurred in another application after blur.
    if (!event.repeat && keyboard?.cancelled) keyboard = null;
    if (event.repeat || keyboard) {
      if (event.key !== keyboard?.key) blocked.add(event.key);
      return;
    }
    const token = begin(button);
    if (token) {keyboard = {key: event.key, button, token, cancelled: false}; blocked.delete(event.key);}
    else blocked.add(event.key);
  };
  const keyUp = (event: KeyboardEvent): void => {
    if (blocked.delete(event.key)) {event.preventDefault(); event.stopPropagation(); return;}
    if (!keyboard || event.key !== keyboard.key) return;
    event.preventDefault(); event.stopPropagation();
    const old = keyboard; keyboard = null;
    if (!old.cancelled && document.activeElement === old.button) release(old.token);
    else cancel(old.token);
  };
  function abandon(): void {
    if (keyboard) {keyboard.cancelled = true; cancel(keyboard.token);}
    if (pointer) {const token = pointer.token; pointer = null; cancel(token);}
  }
  const focusOut = (event: FocusEvent): void => {
    if (keyboard && event.target === keyboard.button) {keyboard.cancelled = true; cancel(keyboard.token);}
  };
  const visibility = (): void => {if (document.hidden) abandon();};
  const preventClick = (event: Event): void => {if (buttonFor(event)) event.preventDefault();};
  document.addEventListener('pointerdown', pointerDown);
  document.addEventListener('pointerup', pointerUp);
  document.addEventListener('pointercancel', pointerCancel);
  document.addEventListener('lostpointercapture', pointerCancel);
  document.addEventListener('keydown', keyDown, {capture: true});
  document.addEventListener('keyup', keyUp, {capture: true});
  document.addEventListener('focusout', focusOut);
  document.addEventListener('visibilitychange', visibility);
  document.addEventListener('click', preventClick);
  document.addEventListener('contextmenu', preventClick);
  window.addEventListener('blur', abandon);
  return {
    cancel(session?: S): void {if (!session || held?.session === session) abandon();},
    dispose(): void {
      if (disposed) return;
      disposed = true;
      abandon(); cancel();
      document.removeEventListener('pointerdown', pointerDown);
      document.removeEventListener('pointerup', pointerUp);
      document.removeEventListener('pointercancel', pointerCancel);
      document.removeEventListener('lostpointercapture', pointerCancel);
      document.removeEventListener('keydown', keyDown, {capture: true});
      document.removeEventListener('keyup', keyUp, {capture: true});
      document.removeEventListener('focusout', focusOut);
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('click', preventClick);
      document.removeEventListener('contextmenu', preventClick);
      window.removeEventListener('blur', abandon);
    },
  };
}
