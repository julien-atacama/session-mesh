// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

export interface DictationChannel {
  valid(): boolean;
  captureFresh?(): boolean;
  claim(): boolean;
  release(): void;
  deliver(text: string, done: (result: {kind: string}) => void, guard: () => boolean): void;
}
interface MediaPorts {
  supported(): boolean;
  permission(): Promise<MediaStream>;
  recorder(stream: MediaStream): MediaRecorder;
}
export function createRetainedLifetime(close: () => void) {
  let attached = true, disposed = false, refs = 0;
  const check = (): void => {if (!disposed && !attached && !refs) {disposed = true; close();}};
  return {
    retain(): (() => void) | null {
      if (disposed) return null;
      refs++; let held = true;
      return () => {if (!held) return; held = false; refs--; check();};
    },
    detach(): void {attached = false; check();},
    dispose(): void {if (disposed) return; disposed = true; close();},
  };
}
export function browserDictationMedia(): MediaPorts {
  return {
    supported: () => !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined',
    permission: () => navigator.mediaDevices.getUserMedia({audio: true}),
    recorder(stream) {
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      return new MediaRecorder(stream, mimeType ? {mimeType} : {});
    },
  };
}
