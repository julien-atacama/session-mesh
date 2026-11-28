// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

"use strict";

// Displayed text comes from the catalogs (static/i18n.js, static/i18n/*.json),
// loaded before startMesh goes on. Nothing may call t() while this file is
// first evaluated: top-level code that writes text registers it with
// whenTranslated(), run once the catalogs are there.
const t = (key, params) => MeshI18n.t(key, params);
// A server answer is still prose in the server's language: known ones are translated.
const serverText = (text) => MeshI18n.serverMessage(text);
const translatedInits = [];
const whenTranslated = (init) => { translatedInits.push(init); };

// Only executable entry code starts the mesh. Before start (and after
// disposal) no local request or transport is permitted.
let meshContext = null;
let meshStopped = false;
let meshPageSuspended = false, meshPageFinal = false, meshPageEpoch = 0;
let meshPageCache = null;
let meshCacheFocusRevision = 0;
function localMeshEffectsAllowed() { return meshContext !== null && !meshStopped && !meshPageSuspended; }
function requireLocalMesh() {
  if (!localMeshEffectsAllowed()) throw new Error(t("mesh.localStopped"));
}
function requestLocal(...args) {
  requireLocalMesh();
  if (args[0] === "/api/logout" || args[0] === "/api/logout-all") {
    meshPageFinal = true;
    inlineDictation?.dispose(); inlineDictationView?.cancel();
  }
  return fetch(...args);
}
function localActionUnavailable() {
  return !localMeshEffectsAllowed();
}
// The work view's bundle once loaded (static/work-view.ts), shared by the Projects view and the session marker, so
// that both read through the same page slots; and the session marker (see tickSessionMarker).
let workModule = null;
let sessionMarker = null;
// The known tracker ids behind the T-, P- and N- references of the terminals (see tickReferences).
let references = null;

const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const touch = matchMedia("(hover: none)").matches;
// The agents whose idle state the server can observe (server.IDLE_OBSERVABLE): only they are offered "when idle".
const IDLE_OBSERVABLE_AGENTS = new Set(["claude", "codex", "opencode"]);
const SWIPE_ROWS = 1.5;   // rows of finger travel per wheel notch (phones)
const SWIPE_QUEUE = 96;   // enough for a fast phone drag; bounded to avoid a long runaway scroll
const HOLD_MS = 1000;   // output held back while a finger scrolls: flushed at least this often
const HOLD_BYTES = 256 * 1024;   // ... or as soon as this much is waiting
const SWIPE_DECAY = 0.9975;   // glide speed kept per ms: halves in ~280 ms, like native momentum
const LONG_PRESS_MS = 500;   // touch selection starts deliberately, never while a swipe is under way
const TOUCH_SLOP_PX = 8;
// Acceleration: a slow drag follows the finger, a fast flick goes further (up to 4x).
const swipeGain = (vel) => Math.min(4, 1 + 1.5 * Math.max(0, Math.abs(vel) - 0.4));   // vel in px/ms
const narrow = () => matchMedia("(max-width: 760px)").matches;
const enc = new TextEncoder();

const store = {
  get(k, d) {
    if (!meshContext || meshStopped) return d;
    try { const v = localStorage.getItem(`${meshContext.storagePrefix}.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    if (!meshContext || meshStopped) return;
    try { localStorage.setItem(`${meshContext.storagePrefix}.${k}`, JSON.stringify(v)); } catch {}
  },
};

let data = { mesh: [], external: [], home: "" };
// The session list's progressive loading (static/sessions-progress.ts). Until the server's first
// answer, `data` holds the sessions this device knew at its last listing, marked provisional.
const Progress = globalThis.MeshSessionsProgress;
let inventoryLoaded = false;   // a listing from the server has been applied
let lastListing = null;   // the last listing applied, as the server sent it (merged when incremental)
let inventoryPoller = null;
let pageSignals = null;
const hostSilence = Progress.createHostSilence();   // rows kept on screen while the PTY host is silent
const shownMesh = () => hostSilence.shown(data.mesh);
// Restoration only rehydrates browser-local panes.  Suppress incidental writes
// while groups/tabs are assembled so a stale target is not erased midway.
let restoringWorkspace = false;
let ctrlArmed = false;
let copyOnSelectDenied = false;   // the browser refused an automatic copy: said once (see copyOnSelect)
// An input that ends the program's line (Enter, ^C, ^D): the input lease is clean again after it.
const completesInput = (str) => str === "\r" || str === "\x03" || str === "\x04";
let lineDirect = null;   // phone direct writing: { pane, conn, session } (see "phone input line")
let recoveredLineTarget = null;
let fontSize = store.get("font", touch ? 12 : 13.5);
const folded = new Set(store.get("folded", []));
const MAX_PANES = 3;
const paneTargets = MeshPaneActions.createTargetRegistry();
const paneInput = MeshPaneActions.createPasteDelivery({
  valid: (target) => paneTargets.valid(target)
    && (target.kind !== "mesh" || target.pane.conn?.terminal?.isBound(target.name, target.created))
    && !(composeOwner?.target === target && (!composeOwner.open || !cdlg.open)),
  connection: (pane) => pane.conn,
  open: (socket) => localTerminalSocketReady(socket),
  paste: (pane, text) => pane.term.paste(text),
  encode: (text) => enc.encode(text),
  send: (pane, socket, bytes, complete) => pane.conn?.ws === socket
    && !pane.conn.replaying && !pane.conn.draining && !pane.conn.replayPending
    && (pane.conn.activeHumanInput?.write
      ? pane.conn.activeHumanInput.write(bytes, complete) : (pane.inputLease?.write(bytes, complete) ?? false)),
  defer: (binding, text, resume, cancel) => binding.pane.deferReplayPaste(binding, text, resume, cancel),
  schedule: (callback) => { setTimeout(callback, 60); },
});
const paneMenuHolds = new Set();
const paneStopHolds = new Set();
let paneInventoryIssue = 0;

// The terminals' colours come from the colour theme (static/themes.ts), like the page's. Themes
// are cosmetic: when static/themes.js did not load (a 404 during an upgrade, a stale cache, a
// blocked request), meshThemes() is null and the app keeps the default dark look instead of
// failing to start. Every use of MeshThemes goes through meshThemes().
const meshThemes = () => globalThis.MeshThemes ?? null;
const DEFAULT_TERMINAL_THEME = Object.freeze({
  background: "#0d1117", foreground: "#d8dee9", cursor: "#7ee0a1", cursorAccent: "#0d1117",
  selectionBackground: "#2d3b4f",
  black: "#1b2029", red: "#ff7b72", green: "#7ee0a1", yellow: "#f5c56b", blue: "#79b8ff",
  magenta: "#d2a8ff", cyan: "#76e3ea", white: "#d8dee9",
  brightBlack: "#4b5361", brightRed: "#ffa198", brightGreen: "#a5f0c0", brightYellow: "#ffdf8a",
  brightBlue: "#a5cdff", brightMagenta: "#e2c5ff", brightCyan: "#b3f0f5", brightWhite: "#ffffff",
});
const terminalTheme = () => meshThemes()?.runtime.terminal() ?? DEFAULT_TERMINAL_THEME;

// ---------------------------------------------------------------- helpers

function ago(ts) {
  if (!ts) return "";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return t("time.justNow");
  if (s < 3600) return t("time.minutesShort", { n: Math.floor(s / 60) });
  if (s < 86400) return t("time.hoursShort", { n: Math.floor(s / 3600) });
  return t("time.daysShort", { n: Math.floor(s / 86400) });
}
const short = (p) => (p || "").replace(data.home, "~");
// An agent session is busy (working), wait (claude is blocked on a question or a
// permission), unread (it has written since it was last on screen here) or idle.
// codex never says it waits: for it, unread is the signal. claude's "shell" (its turn is
// over, a background shell it left still runs) is a fifth, quieter state: unread first
// when the reply was not seen, else "shell", so it is never drawn as fully idle.
// Times are the server's: `updated` is a file mtime there, so `seen` is kept on
// the server's clock too (offset learnt from each listing's `now`).
const seen = store.get("seen", null) || {};   // session id -> when it was last on screen (server s)
// what this device never saw counts as read up to its first visit: a new device
// starts clean, a session that ends while the device is away shows as unread
let seenSince = store.get("seenSince", null);
let clockOffset = 0;
const serverNow = () => Date.now() / 1000 + clockOffset;
let activityRanking = null;
const activityPhase = (s) => activityRanking?.entries[s.id]?.identity === JSON.stringify([s.name ?? null, s.created ?? null])
  ? activityRanking.phaseById[s.id] : null;
function state(s) {
  const a = s.agent;
  if (!a || s.provisional) return "";
  if (a.status === "busy") return "busy";
  if (a.status === "waiting") return "wait";
  if (activityPhase(s) === "active") return "busy";
  if (lastSeen(s) > (seen[s.id] ?? seenSince ?? Infinity) + 1) return "unread";
  if (a.status === "shell") return "shell";
  return activityPhase(s) === "unknown" ? "unknown" : "idle";
}
// Catalog keys, translated where the state is shown: t(STATE_TEXT[st]).
const STATE_TEXT = { busy: "session.state.busy", wait: "session.state.wait", unread: "session.state.unread", shell: "session.state.shell", unknown: "session.state.unknown" };
function label(s) {
  const a = s.agent;
  return s.label || (a && (a.title || a.name)) || (s.kind === "mesh" ? s.name : short(s.cwd).split("/").pop() || "~");
}
const lastSeen = (s) => s.agent?.updated || s.activity || 0;
// Documents use "web:<target>"; session boards use "board:<session id>".
const webs = new Map();
const boards = new Map();
const demos = new Map();
// A contextual diff is an owner-only, read-only snapshot.  Keep it only in
// this page; selectors expire on the server and no edit/comment state exists.
const portfolioDiffs = new Map();  // ephemeral pane id -> frozen issuer binding and snapshot
let nextContextualDiff = 0;
const isContextualDiffPane = (id) => id?.startsWith("context-diff:");
// Per-page state only: the server keeps references, but opening a board never
// acknowledges anything remotely or changes what another browser sees.
const boardSignalVersions = new Map();
const boardModified = new Set();
const boardSignalIdentities = new Map();
let boardSignalBaseline = false;
const isWebPane = (id) => id?.startsWith("web:");
const isBoardPane = (id) => id?.startsWith("board:");
const isDemoPane = (id) => id?.startsWith("demo:");
const isAdjacentPane = (id) => isWebPane(id) || isBoardPane(id) || isDemoPane(id) || isContextualDiffPane(id);
const find = (id) => (isContextualDiffPane(id) ? portfolioDiffs.get(id) : isWebPane(id) ? webs.get(id) : isBoardPane(id) ? boards.get(id) : isDemoPane(id) ? demos.get(id)
  : data.mesh.find((s) => s.id === id) || data.external.find((s) => s.id === id));
// ``known_agent`` is launch provenance, not proof that the process still
// exists: the login shell deliberately remains after an agent exits. An agent
// may also run in the background while the shell owns PTY input. Only a live,
// foreground discovered Codex process may receive agent-specific input.
const isCodexTerminal = (session) => session?.kind === "mesh"
  && session.agent?.type === "codex" && session.agent?.foreground === true;

const isPiTerminal = (session) => session?.kind === "mesh"
  && session.agent?.type === "pi" && session.agent?.foreground === true;

// OpenCode draws on the alternate screen with mouse reporting, like Pi's fullscreen mode, and a replay
// cut at 2 MiB loses those modes the same way: it gets the same explicit recovery.
const isOpenCodeTerminal = (session) => session?.kind === "mesh"
  && session.agent?.type === "opencode" && session.agent?.foreground === true;
// Antigravity (agy) may draw on the alternate screen with mouse reporting in its full-screen rendering
// mode (its setting "altScreenMode"), and then needs the same recovery after a cut replay.
const isAgyTerminal = (session) => session?.kind === "mesh"
  && session.agent?.type === "agy" && session.agent?.foreground === true;
// Copilot CLI too: alternate screen, mouse tracking (any), SGR encoding and bracketed paste.
const isCopilotTerminal = (session) => session?.kind === "mesh"
  && session.agent?.type === "copilot" && session.agent?.foreground === true;
const hasFullscreenScrollRecovery = (session) => isPiTerminal(session) || isOpenCodeTerminal(session)
  || isCopilotTerminal(session)
  || isAgyTerminal(session);
const FULLSCREEN_SCROLL_TEXT = {
  pi: { menu: "menu.restorePiScroll", mobile: "mobile.piScroll", replaced: "terminal.piReplaced",
    restored: "terminal.piScrollRestored" },
  opencode: { menu: "menu.restoreOpenCodeScroll", mobile: "mobile.openCodeScroll",
    replaced: "terminal.openCodeReplaced", restored: "terminal.openCodeScrollRestored" },
  copilot: { menu: "menu.restoreCopilotScroll", mobile: "mobile.copilotScroll",
    replaced: "terminal.copilotReplaced", restored: "terminal.copilotScrollRestored" },
  agy: { menu: "menu.restoreAgyScroll", mobile: "mobile.agyScroll", replaced: "terminal.agyReplaced",
    restored: "terminal.agyScrollRestored" },
};
const fullscreenScrollText = (session) => FULLSCREEN_SCROLL_TEXT[session?.agent?.type] || FULLSCREEN_SCROLL_TEXT.pi;

function syncMobileRawScrollAction() {
  const button = $("#mobile-raw-scrollback");
  if (!button) return;
  const session = active?.id && find(active.id);
  button.hidden = !isCodexTerminal(session);
  const pi = $("#mobile-pi-scroll");
  if (pi) {
    pi.hidden = !hasFullscreenScrollRecovery(session);
    // The key is also written as data-i18n: a language change re-applies the page's keys and would
    // otherwise put the Pi label back on an OpenCode or Antigravity terminal.
    const key = fullscreenScrollText(session).mobile;
    pi.setAttribute("data-i18n", key);
    pi.textContent = t(key);
  }
}

function boardEntry(sessionId) {
  const session = data.mesh.find((s) => s.id === sessionId);
  if (!session) return null;
  const id = `board:${session.id}`;
  const board = { id, kind: "board", session: session.id, target: session.name || session.id, cwd: session.cwd };
  boards.set(id, board);
  return board;
}

function demoEntry(sessionId, version, sandbox, demoId = "legacy", catalog = []) {
  const session = data.mesh.find((s) => s.id === sessionId);
  if (!session || !Number.isFinite(session.created) || !Number.isSafeInteger(version) || version < 0
      || typeof sandbox !== "string") return null;
  const id = `demo:${session.id}`;
  const demo = { id, kind: "demo", session: session.id, name: session.name, created: session.created,
    target: session.name, cwd: session.cwd, version, sandbox, demoId, catalog,
    offeredVersion: null, offeredSandbox: null, selectionSerial: 0 };
  demos.set(id, demo);
  return demo;
}

function renderDemoSelector(pane, demo) {
  const label = $(".demo-switch", pane.el);
  const tools = $(".demo-tools", pane.el);
  const history = $(".demo-history", pane.el);
  const select = $("select", label);
  const rows = MeshDemoCatalog.readCatalog(demo.catalog) ?? [];
  label.hidden = rows.length < 2;
  history.hidden = demo.demoId === "legacy";
  tools.hidden = label.hidden && history.hidden;
  select.replaceChildren(...rows.map((row) => {
    const option = document.createElement("option");
    option.value = row.id;
    option.textContent = MeshDemoCatalog.choiceLabel(row, rows);
    return option;
  }));
  select.value = demo.demoId;
}

function declaredBoardSignal(signal) {
  if (!signal || typeof signal !== "object" || Array.isArray(signal)) return null;
  const keys = Object.keys(signal).sort().join(",");
  const obj = signal.object;
  if (keys !== "at,object,source,type,v" || signal.v !== 0 || signal.type !== "board.updated"
      || typeof signal.source !== "string" || !obj || typeof obj !== "object" || Array.isArray(obj)
      || Object.keys(obj).sort().join(",") !== "id,kind,version" || obj.kind !== "board"
      || typeof obj.id !== "string" || signal.source !== obj.id || !Number.isSafeInteger(obj.version)
      || obj.version < 0 || typeof signal.at !== "number" || !Number.isFinite(signal.at)) return null;
  return obj;
}

function receiveBoardSignals(signals) {
  if (!Array.isArray(signals)) return;
  const identities = new Map(data.mesh.filter((s) => Number.isFinite(s.created)).map((s) => [s.id, s.created]));
  for (const [id, created] of boardSignalIdentities) {
    if (identities.get(id) !== created) {
      boardSignalIdentities.delete(id);
      boardSignalVersions.delete(id);
      boardModified.delete(id);
    }
  }
  for (const [id, created] of identities) boardSignalIdentities.set(id, created);
  const live = new Set(data.mesh.map((s) => s.id));
  const references = signals.map(declaredBoardSignal).filter((obj) => obj && live.has(obj.id));
  if (!boardSignalBaseline) {
    for (const obj of references) boardSignalVersions.set(obj.id, Math.max(boardSignalVersions.get(obj.id) ?? -1, obj.version));
    boardSignalBaseline = true;
    return;
  }
  for (const obj of references) {
    const previous = boardSignalVersions.get(obj.id) ?? -1;
    if (obj.version > previous) {
      boardSignalVersions.set(obj.id, obj.version);
      boardModified.add(obj.id);
    }
  }
}

function clearBoardModified(sessionId) {
  if (!boardModified.delete(sessionId)) return;
  renderLists();
  for (const pane of panes) pane.header();
}
// a past conversation: "h:<agent>:<id>" (strict: it also comes from URLs and saved layouts)
const isHist = (id) => typeof id === "string" && /^h:(claude|codex|pi):[0-9A-Za-z][0-9A-Za-z-]{7,63}$/.test(id);

let flashTimer;
function flash(msg, ms = 1600) {
  const el = $("#flash");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (el.hidden = true), ms);
}
// a click on the message dismisses it (the long ones outlast the default)
$("#flash").addEventListener("click", () => { clearTimeout(flashTimer); $("#flash").hidden = true; });
// a message that lists things to read stays on screen in proportion to its length
const flashLong = (msg) => flash(msg, Math.min(60000, Math.max(8000, 1600 + 70 * msg.length)));

// ---------------------------------------------------------------- panes
//
// Each pane shows one session: a live terminal for a mesh session, an info
// card for an outside terminal, or a placeholder. The active pane receives
// sidebar clicks, the phone key bar, the composer and file uploads.

const panes = [];
// A workspace is only a browser-local arrangement.  A Pane remains the owner
// of its terminal/iframe: a group merely reparents already mounted panes and
// toggles which one is visible.  In particular, switching tabs must never call
// Pane.show(), which would detach a live terminal connection.
const workspaceGroups = [];
let nextGroup = 1;
let active = null;

const REDRAW_GAP_MS = 100;   // between the shrunk size and the real one, so the program sees two changes
// The automatic redraw after an attach waits for the replay to go quiet (no message for
// this long, so the last chunk is in xterm), but never longer than the cap after the socket opened.
const AUTO_REDRAW_SETTLE_MS = 150;
const AUTO_REDRAW_MAX_MS = 1500;
// A redraw itself has two resize frames and programs can answer slightly later
// under load; wait longer before fixing the initial viewport than before
// deciding the replay is quiet enough to request that redraw.
const INITIAL_FOLLOW_SETTLE_MS = 350;
const FRAME_BACK_TIMEOUT_MS = 1000;
const FRAME_NAVIGATION_TIMEOUT_MS = 5000;
// A program that exits badly can leave xterm's private mouse/focus-reporting
// modes enabled.  They make browser pointer/focus events look like input to
// the next shell.  This is deliberately a *local* parser write: it never goes
// through the PTY, and is only used by the explicit recovery action below.
const TERMINAL_INTERACTION_MODE_RESET = "\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1007l\x1b[?1015l";
let inputLeaseSerial = 0;
const humanInputScopes = new Map();
let inputLeaseTab = null;
function initializeLocalInputTab() {
  try {
    inputLeaseTab = sessionStorage.getItem("mesh-input-tab");
    if (!/^[A-Za-z0-9_]{16,96}$/.test(inputLeaseTab || "")) {
      inputLeaseTab = crypto.randomUUID().replaceAll("-", "");
      sessionStorage.setItem("mesh-input-tab", inputLeaseTab);
    }
  } catch { inputLeaseTab = crypto.randomUUID().replaceAll("-", ""); }
}

// Local-only adapter. The socket remains exposed solely for the existing paste
// identity port and local browser diagnostics; it is not a remote handle API.
function localTerminalSocketReady(socket) {
  return socket?.readyState === WebSocket.OPEN;
}
function listedInputVersion(session) {
  if (session?.kind !== "mesh" || !(inventoryLoaded || session.provisional === true) ||
      !Number.isFinite(session?.created) || session.created <= 0 ||
      !Array.isArray(session.pty_capabilities)) return 0;
  if (session.pty_capabilities.includes("acknowledged_input_v2")) return 2;
  if (v2Attempted.has(`${session.id}\0${session.created}`)) return 0;
  return session.pty_capabilities.includes("acknowledged_input_v1") ? 1 : 0;
}
function listedInputAcknowledgement(session) { return listedInputVersion(session) !== 0; }
const ackAttempted = new Set();
const v2Attempted = new Set();
function listedLegacyInput(session) {
  // A missing cached hint is not evidence of an older host. Only an observed
  // live incarnation that did not attempt ACK may take the legacy raw path.
  return inventoryLoaded && lastListing?.management?.state === "observed" &&
    !Progress.pending(lastListing) && session?.kind === "mesh" && !session.provisional &&
    session.ready !== false &&
    Number.isFinite(session.created) && session.created > 0 &&
    !ackAttempted.has(`${session.id}\0${session.created}`) &&
    (session.pty_capabilities == null || (Array.isArray(session.pty_capabilities) &&
      session.pty_capabilities.length <= 16 &&
      session.pty_capabilities.every((value) => typeof value === "string") &&
      new Set(session.pty_capabilities).size === session.pty_capabilities.length &&
      !session.pty_capabilities.includes("acknowledged_input_v1") &&
      !session.pty_capabilities.includes("acknowledged_input_v2")));
}
function prefixedBytes(prefix, bytes) {
  const head = enc.encode(prefix), joined = new Uint8Array(head.length + bytes.length);
  joined.set(head);
  joined.set(bytes, head.length);
  return joined;
}

function localTerminalSocket(name, { rows, cols, created }, inputBinding = null) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  // replay_geometry=1: retained output geometry when the PTY host can establish it,
  // not historical per-byte geometry of a replay spanning several resize epochs.
  // pty_size=1: this pane follows the PTY size another device owns ({t:"s"}, Pane.applyPtySize).
  const conditional = typeof created === "number" && Number.isFinite(created) && created > 0;
  if (created != null && !conditional) throw new TypeError(t("dictation.inline.invalidIncarnation"));
  const incarnation = conditional ? `&created=${encodeURIComponent(created)}` : "";
  const inputQuery = inputBinding
    ? inputBinding.version === 2
      ? `&input_ack=2&input_ack_mode=${inputBinding.mode}&input_ack_created=${encodeURIComponent(inputBinding.created)}` +
        (inputBinding.mode === "resume" ? `&input_ack_slot=${inputBinding.slot}&input_ack_generation=${inputBinding.generation}&input_ack_nonce=${inputBinding.actorNonce}` : "")
      : `&input_ack=1&input_ack_created=${encodeURIComponent(inputBinding.created)}&input_ack_id=${encodeURIComponent(inputBinding.id)}`
    : "";
  const socket = new WebSocket(`${proto}://${location.host}/ws/${encodeURIComponent(name)}?rows=${rows}&cols=${cols}&replay_geometry=1&pty_size=1${incarnation}${inputQuery}`);
  socket.binaryType = "arraybuffer";
  return socket;
}

// Original-socket binding with admitted control frames, not replay confidence.
// Callers additionally guard replay/drain, inventory, modes and input revision.
function localTerminalBinding(name, created, bytes, geometry, ptySize = () => {}, protocol = () => {}) {
  let binding = created != null ? "pending" : "invalid";
  let replayStarted = false;
  return {
    isBound: () => binding === "bound",
    receive(data) {
      if (typeof data !== "string") {
        replayStarted = true;   // the first D is a boundary even when its payload is empty
        if (binding === "pending") binding = "invalid";
        bytes(new Uint8Array(data));
        return;
      }
      const size = replayGeometry(data);
      const ownedSize = MeshPaneActions.parsePtySize(data);
      let message;
      try { message = JSON.parse(data); } catch { binding = "invalid"; return; }
      if (message?.t === "bound") {
        const exact = Object.keys(message).length === 3 && message.name === name
          && typeof message.created === "number" && Number.isFinite(message.created)
          && message.created > 0 && message.created === created;
        binding = binding === "pending" && !replayStarted && exact ? "bound" : "invalid";
        if (binding === "bound") protocol(false);
      } else if (message?.t === "limited" && Object.keys(message).length === 1) {
        binding = "invalid";
        protocol(true);
      } else if (!size && !MeshPaneActions.isPtySizeFrame(message)) {
        // A verified socket can still be resized explicitly when its replay is
        // too large to render. It must not retain deferred-input authority.
        const wireDimension = (value) => Number.isInteger(value) && value >= 2 && value <= 65535;
        const unrenderable = message?.t === "g" && Object.keys(message).length === 3
          && wireDimension(message.rows) && wireDimension(message.cols);
        const verified = binding === "bound";
        binding = "invalid";
        if (verified && unrenderable) protocol(true);
      }
      if (size) geometry(size);
      if (ownedSize) ptySize(ownedSize);
    },
  };
}

function openLocalTerminal(name, size, observer, inputBinding = null) {
  requireLocalMesh();
  const socket = localTerminalSocket(name, size, inputBinding), {created} = size;
  let disposed = false;
  let attached = true;
  let limited = false;
  let dictationMode = MeshPaneActions.createDictationModeObserver(observer.modeSource?.modes?.bracketedPasteMode === true, observer.modeSource);
  const lifetime = MeshPaneActions.createRetainedLifetime(() => {
    disposed = true; dictationMode.dispose(); localTerminalHandles.delete(handle); socket.close();
  });
  const send = (payload) => {
    if (!handle.isOpen()) throw new Error("terminal disconnected");
    socket.send(payload); // queued locally; this is not a PTY delivery receipt
  };
  const handle = {
    socket,
    get dictationMode() { return dictationMode; },
    replayMode: (prefix, bytes) => {
      dictationMode.dispose();
      dictationMode = MeshPaneActions.createDictationModeObserver(false, observer.modeSource);
      dictationMode.bytes(prefixedBytes(prefix, bytes));
    },
    isOpen: () => !disposed && localTerminalSocketReady(socket),
    get limited() { return limited; },
    isBound: (expectedName, expectedCreated) => handle.isOpen() && binding.isBound()
      && expectedName === name && expectedCreated === created,
    queueInput: (bytes) => {
      if (inputBinding) throw new Error("input_ack_raw_disabled");
      send(bytes);
    },
    acknowledgedInput: (bytes) => {
      if (!inputBinding) throw new Error("input_ack_not_negotiated");
      if (inputBinding.version === 2 && !inputBinding.current())
        throw new Error("input_ack_v2_not_confirmed");
      send(bytes);
    },
    lease: (clientId, dirty) => {
      if (inputBinding?.version === 2) {
        const binding = inputBinding.current();
        if (!binding) throw new Error("input_ack_v2_not_confirmed");
        send(JSON.stringify({ t: "h", slot: binding.slot, generation: binding.generation, dirty }));
      } else send(JSON.stringify({ t: "h", client_id: clientId, dirty }));
    },
    // mode "claim" (the default, no field): applied only while no other device owns the size;
    // "take": the banner's take-over; "keep": a redraw at the PTY's size.
    resize: (rows, cols, mode = "claim") => {
      if (binding.isBound() || ((limited || created == null) && mode === "take"))
        send(JSON.stringify(mode === "claim" ? { t: "r", rows, cols } : { t: "r", rows, cols, size: mode }));
    },
    retain: () => binding.isBound() ? lifetime.retain() : null,
    close: () => { attached = false; lifetime.detach(); },
    dispose: () => lifetime.dispose(),
  };
  localTerminalHandles.add(handle);
  const current = () => !disposed && attached && observer.current(handle);
  const binding = localTerminalBinding(name, created, (bytes) => {
    dictationMode.bytes(bytes);
    if (current()) observer.bytes(handle, bytes);
  }, (geometry) => {if (current()) observer.replayGeometry(handle, geometry);},
  (ptySize) => {if (current()) observer.ptySize?.(handle, ptySize);},
  (isLimited) => {
    limited = isLimited;
    if (current()) observer.protocol?.(handle, isLimited);
  });
  socket.onopen = () => {
    if (!current()) { try { handle.close(); } catch {} return; }
    observer.opened(handle);
  };
  socket.onmessage = (event) => {
    if (disposed) return;
    if (inputBinding && typeof event.data === "string") {
      let message;
      try { message = JSON.parse(event.data); } catch {}
      if (message?.t === "input_capability") { if (current()) observer.inputCapability?.(handle, message); return; }
      if (message?.t === "input_ack") {
        if (current() || observer.retainedInput?.(handle)) observer.inputAck?.(handle, message);
        return;
      }
      if (message?.t === "input_rejected") { if (current()) observer.inputRejected?.(handle); return; }
    }
    binding.receive(event.data);
  };
  socket.onclose = (event) => {
    if (event?.code === 1012) inventoryPoller?.noteRestart();   // the server closes its sockets as it restarts
    const notify = current();
    observer.abandonRetainedInput?.(handle);
    lifetime.dispose();
    if (notify) return observer.closed(handle);
  };
  return handle;
}
const localTerminalHandles = new Set();

// {t:"g", rows, cols}: the current pre-attach geometry, not per-byte replay
// history. Initial unrenderable geometry deliberately revokes automation binding.
function replayGeometry(text) {
  let message;
  try { message = JSON.parse(text); } catch { return null; }
  const valid = (value) => Number.isInteger(value) && value >= 2 && value <= 1000;
  return message?.t === "g" && valid(message.rows) && valid(message.cols)
    ? { rows: message.rows, cols: message.cols } : null;
}

// Keep only metadata: input text may contain credentials and must not enter logs.
function logObsoleteInput(name, created) {
  try {
    const key = "mesh-obsolete-input-log";
    const previous = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(previous)) return false;
    previous.push({ name, created, forgottenAt: Date.now() });
    localStorage.setItem(key, JSON.stringify(previous.slice(-100)));
    return true;
  } catch { return false; }
}

class Pane {
  constructor() {
    this.el = $("#pane-tpl").content.firstElementChild.cloneNode(true);
    this.inputAcks = new Map();
    this.recoveredLineDrafts = new Map();
    $(".p-input-retry", this.el).addEventListener("click", () => {
      if (this.inputAck?.state === "halted" && this.inputAck.pendingBytes === 0) {
        const c = this.conn;
        const session = c && find(c.name);
        if (!c || session?.created !== c.created ||
            !listedInputAcknowledgement(session)) return;
        const key = `${c.name}\0${c.created}`;
        if (this.inputAck.version === 2 && this.inputLease?.dirty &&
            !confirm(t("conn.inputRebindDraftConfirm"))) return;
        // A discarded uncertain frame may have reached the native input queue.
        // Do not send H(false) merely because the local copy was discarded.
        this.inputAcks.delete(key);
        this.inputLeases.delete(key);
        this.attach(c.name);
        flash(t("conn.inputNewAttachment"));
      } else if (this.inputAck) {
        const hold = this.inputAck.version === 2 && this.inputAck.binding &&
          !this.conn?.v2AwaitingCapability && this.inputAck.pendingHumanBytes > 0 &&
          !this.inputLease?.dirty;
        if (hold) this.inputLease?.hold();
        const retried = this.inputAck.retry();
        if (!retried && hold) this.inputLease?.release();
        if (retried) this.renderRetainedInput();
      }
    });
    $(".p-input-discard", this.el).addEventListener("click", () => {
      for (const [, entry] of this.activeSessionInputs()) {
        if (entry.input.pendingBytes) {
          const uncertain = entry.input.deliveryUncertain;
          entry.input.discard();
          if (!uncertain && !entry.input.incompleteHumanInput) entry.lease?.release();
        }
      }
      this.renderRetainedInput();
    });
    const forgetDraft = document.createElement("button");
    forgetDraft.type = "button";
    forgetDraft.className = "p-input-forget-draft";
    $(".p-input-review", this.el).append(forgetDraft);
    const otherDrafts = document.createElement("div");
    otherDrafts.className = "p-input-other-drafts";
    $(".p-input-review", this.el).append(otherDrafts);
    forgetDraft.addEventListener("click", () => {
      const obsolete = this.obsoleteDirtyInput();
      if (!obsolete || !confirm(t("conn.inputForgetOldDraftConfirm"))) return;
      // This forgets only the browser's stale record; it cannot release or
      // complete the old actor's native lease or the terminal's draft.
      this.inputAcks.delete(obsolete.key);
      this.inputLeases.delete(obsolete.key);
      this.renderRetainedInput();
      renderReloadStatus();
    });
    this.defaultEmptyHtml = $(".empty", this.el).innerHTML;
    this.termEl = $(".term", this.el);
    $(".demo-offer button", this.el).addEventListener("click", () => {
      const demo = find(this.id);
      if (demo?.kind !== "demo" || !Number.isSafeInteger(demo.offeredVersion)
          || typeof demo.offeredSandbox !== "string") return;
      demo.version = demo.offeredVersion;
      demo.sandbox = demo.offeredSandbox;
      demo.offeredVersion = null;
      demo.offeredSandbox = null;
      this.show(demo.id, true);
    });
    $(".demo-switch select", this.el).addEventListener("change", (event) => {
      selectDemoScene(this, event.currentTarget.value);
    });
    $(".demo-history", this.el).addEventListener("click", () => openDemoHistory(this));
    this.sizeBanner = $(".size-banner", this.el);   // another device owns the PTY size (followPtySize)
    this.limitedBanner = $(".limited-banner", this.el);
    $("button", this.limitedBanner).addEventListener("click", () => this.takeSize());
    this.limitedKeyboard = $(".limited-keyboard", this.el);
    this.limitedKeyboard.addEventListener("click", (event) => {
      event.stopPropagation(); this.focusLimitedKeyboard();
    });
    this.ptyFollowing = false;
    $("button", this.sizeBanner).addEventListener("click", () => this.takeSize());
    this.lastAutoTake = null;   // automatic take-over (static/size-takeover.ts)
    MeshPaneActions.listenForActivation($(".pane-body", this.el), (event) => this.autoTakeSize(event));
    $(".web", this.el).addEventListener("load", () => this.frameLoaded());
    this.id = null;
    this.layoutTarget = null;
    this.layoutType = null;
    this.conn = null;
    this.inputLease = null;
    this.inputLeases = new Map();
    this.inputLeaseSlot = ++inputLeaseSerial;
    this.queuedOutput = [];   // terminal output waiting while a finger scrolls (see output())
    this.queuedBytes = 0;
    this.holdTimer = 0;
    this.mobileSelection = ""; // survives mobile Chromium's compatibility click after a long press
    this.webBack = [];
    this.frameHistoryDepth = 0;
    this.frameBackPending = false;
    this.frameBackLoaded = false;
    this.frameBackReady = false;
    this.frameBackTimer = 0;
    this.frameNavigation = null;
    this.frameNavigationTimer = 0;
    this.frameLoadSerial = 0;
    this.frameInitialReady = false;
    this.term = new Terminal({
      // "Mesh Symbols" (style.css): the bundled symbol font, only for symbols such as U+23F5
      // that the fonts before it lack (no Android font has it).
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, monospace, "Mesh Symbols"',
      fontSize, lineHeight: 1.12, cursorBlink: true, allowProposedApi: true,
      // Option still forces a selection on macOS (Shift does elsewhere) when a program tracks the mouse
      scrollback: localMeshEffectsAllowed() ? 20000 : 0,
      disableStdin: !localMeshEffectsAllowed(),
      macOptionIsMeta: true, macOptionClickForcesSelection: true, theme: terminalTheme(),
      // OSC 8 hyperlinks (claude prints file paths this way): same rule as
      // plain links, file:// URLs become documents in the side panel
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (e, uri) => {
          if (isExternalUrl(uri)) return openExternalTab(uri);
          const target = uri.startsWith("file://") ? decodeURIComponent(new URL(uri).pathname) : uri;
          if (e.ctrlKey || e.metaKey) describeWeb(target).then((d) => d && window.open(viewUrl(d), "_blank", "noopener"));
          else openWeb(target);
        },
      },
    });
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.mounted = false;
    this.actionView = 0;
    this.actionKind = "empty";
    this.actionDisposed = false;
    this.paneHeader = MeshPaneActions.createHeader(this.el, {
      rename: () => renameSession(this.id, $(".p-name", this.el)),
    });
    this.paneMenu = MeshPaneActions.createMenu(this.el, {
      activate: () => setActive(this),
      actions: () => paneMenuActions(this),
      capture: () => { observePaneActions(this); return paneTargets.capture(this, true); },
      valid: (target) => paneTargets.valid(target),
      release: (target) => paneTargets.release(target),
      run: (action, target) => runPaneAction(action, target),
      hold: (held) => { if (held) paneMenuHolds.add(this); else paneMenuHolds.delete(this); renderReloadStatus(); },
      canFocus: canFocusPaneAction,
      fallbackFocus: focusPaneActionFallback,
      reportError: (error) => flash(t("pane.actionFailed", { error: error?.message || error })),
    });
  }

  // The envelope button opens this session's mailbox; the badge counts the approval
  // requests that concern it (known from the inventory, never polled here).
  openMailbox() {
    const s = this.id && find(this.id);
    if (!s || s.kind !== "mesh" || !Number.isFinite(s.created)) { flash(t("pane.actionCancelled")); return; }
    mailboxPanel.open(s.name, s.created);
  }
  renderMailboxBadge(s) {
    const button = $('[data-act="compose"]', this.el), badge = $(".mail-badge", button);
    const count = s && Number.isFinite(s.created) ? mailboxPanel.pending(s.name, s.created) : 0;
    badge.hidden = count === 0;
    $(".mail-badge-count", badge).textContent = count ? String(count) : "";
    $(".sr-only", badge).textContent = count ? t("mailbox.pending", { count }) : "";
  }
  // The "? n" button: the open questions of this session in the tracker (sessionMarkerOf); it opens them in the
  // Projects view. Hidden when the session has none or the tracker could not be read.
  renderQuestionsButton(s) {
    const button = $('[data-act="questions"]', this.el), marker = sessionMarkerOf(s);
    button.hidden = !marker;
    if (!marker) return;
    const questionsLabel = t("pane.questions.aria", { n: marker.count });
    $(".p-questions-count", button).textContent = sessionMarkerText(marker);
    button.setAttribute("aria-label", questionsLabel);
    button.title = questionsLabel;
  }

  // xterm must be opened once its element is in the document (it measures glyphs)
  mount() {
    if (this.mounted) return;
    this.mounted = true;
    this.term.open(this.termEl);
    this.wire();
  }

  wire() {
    const t = this.term;
    const currentOutput = (reply) => reply != null && reply.connection === this.conn && reply.terminal === this.conn?.terminal
      && reply.view === this.actionView && !this.actionDisposed;
    const currentReply = (reply) => currentOutput(reply) && !this.conn?.closed && reply.terminal?.isOpen();
    this.inputOrigin = MeshPaneActions.createTerminalInputOrigin(t._core?.coreService, t._core?._inputHandler, currentOutput);
    for (const event of ["focus", "blur"]) t.textarea?.addEventListener(event, () => {
      this.inputOrigin.focus({connection: this.conn, terminal: this.conn?.terminal, view: this.actionView});
    }, true);
    for (const event of ["focus", "blur"]) t.textarea?.addEventListener(event, () => this.inputOrigin.clearFocus());
    this.wireReplayInput();
    t.onData((d) => {
      const human = this.inputOrigin.consume();
      const reply = this.inputOrigin.target();
      if (!localMeshEffectsAllowed()) return;
      // xterm answers the queries (device attributes, cursor position...) the replayed output
      // contains: they were asked long ago, and their answers would land at the prompt.
      // While draining, xterm is still parsing output written for the previous session
      // (see attach()): its answers would land at this session's prompt.
      if (this.conn?.replaying || this.conn?.draining || this.conn?.replayPending) {
        if (human && this.replayKeyboard) {
          this.replayKeyboard = false;
          if (ctrlArmed && d.length === 1) {
            const c = d.toUpperCase().charCodeAt(0);
            if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64);
            setCtrl(false);
          }
          this.send(d);
        }
        return;
      }
      if (this.filterFocusReport(d)) return;
      paneInput.onData(this, d, () => {
        if (human && ctrlArmed && d.length === 1) {
          const c = d.toUpperCase().charCodeAt(0);
          if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64);
          setCtrl(false);
        }
        if (human) this.send(d);
        else if (currentReply(reply) && reply.terminal.isBound(this.conn.name, this.conn.created)) {
          const bytes = enc.encode(d);
          if (this.inputAck) this.sendAcknowledgedInput(bytes, false);
          else reply.terminal.queueInput(bytes);
        }
      });
    });
    // file paths of viewable documents are clickable: they open in a web pane,
    // relative ones against the session's working directory
    t.registerLinkProvider({
      provideLinks: (y, cb) => {
        const links = [];
        for (const { text: path, start, end, kind } of terminalLinksOnRow(t.buffer.active, y - 1, t.cols)) {
          links.push({
            range: { start: { x: start[1] + 1, y: start[0] + 1 }, end: { x: end[1] + 1, y: end[0] + 1 } },
            text: path,
            activate: (e) => followLink(kind, path, e, this),
            ...(kind === "ref" ? { hover: () => this.showReferenceTitle(path), leave: () => this.showReferenceTitle(null) } : {}),
          });
        }
        cb(links);
      },
    });
    // Programs that track the mouse (fullscreen claude, codex) receive every
    // click, so xterm never activates a link. Look for a document path or URL
    // under the pointer ourselves; any other click still goes to the program.
    this.termEl.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || t.modes.mouseTrackingMode === "none") return;
      if (MeshTerminalLinks.forcesSelection(e, shortcutPlatform)) return;   // Shift (Option on macOS)+drag forces a text selection: let it
      const link = this.linkAt(e);
      if (!link) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      followLink(link.kind, link.text, e, this);
    }, true);
    // A URL has an explicit system-browser action.  Paths retain their older
    // source-view shortcut, so local documents never turn into browser opens.
    this.termEl.addEventListener("contextmenu", (e) => {
      if (t.hasSelection()) return;                   // right click copies a selection (below)
      const link = this.linkAt(e);
      if (link?.kind === "url") {
        e.preventDefault();
        e.stopImmediatePropagation();
        openExternalLinkMenu(link.text, e.clientX, e.clientY);
        return;
      }
      if (!link || link.kind !== "doc" || !SOURCE_EXT.test(splitLine(link.text).path)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      openWeb(link.text, sessionBases(this.id), { source: true });
    }, true);
    // Touch scrolling, with a glide after a quick release. In the normal buffer the
    // scrollback is scrolled here, to the pixel (xterm's own touch scrolling stops dead
    // on release); in the alternate buffer (fullscreen claude, less) there is none, and a
    // wheel notch goes out per SWIPE_ROWS rows the finger travels, as a mouse wheel would.
    if (localMeshEffectsAllowed()) this.swipeToWheel();
    else {
      // Read-only panning is browser navigation even when the program enabled
      // terminal mouse reporting. Do not let xterm consume it as PTY input.
      for (const type of ["wheel", "touchstart", "touchmove", "touchend", "touchcancel"])
        this.termEl.addEventListener(type, (event) => event.stopPropagation(), {capture: true, passive: true});
    }
    this.wireToBottom();
    this.termEl.addEventListener("mousemove", (e) => {
      if (t.modes.mouseTrackingMode === "none") return void this.termEl.classList.remove("over-link");
      const link = this.linkAt(e);
      this.termEl.classList.toggle("over-link", !!link);
      this.showReferenceTitle(link?.kind === "ref" ? link.text : null);
    });
    // Mouse reports in xterm's default encoding come here, not through onData: dropped, as
    // there, while a replay (or a previous session's output) is parsed, since the modes
    // they follow are not yet the replayed program's.
    t.onBinary((d) => {
      if (!localMeshEffectsAllowed() || this.conn?.replaying || this.conn?.draining) return;
      this.sendRaw(Uint8Array.from(d, (c) => c.charCodeAt(0)), true);
    });
    t.onResize(() => this.sendSize());
    t.textarea.addEventListener("focus", () => { setActive(this); this.retakeSize(); });
    this.wireFocusReports();
    this.wireCopyOnSelect();
    if (touch) t.textarea.setAttribute("inputmode", "none");   // phones type in the input line
    this.el.addEventListener("pointerdown", () => setActive(this), true);

    t.attachCustomKeyEventHandler((e) => {
      // A key the shortcut table owns while a terminal has the focus is the page's, never the program's.
      if (e.type === "keydown" && /* shortcut veto */ MeshShortcuts.resolve(MeshShortcuts.SHORTCUTS, e, "terminal", shortcutPlatform)) return false;
      if (!localMeshEffectsAllowed()) {
        if (e.type === "keydown" && e.ctrlKey && e.key.toLowerCase() === "c" && (e.shiftKey || t.hasSelection())) {
          e.preventDefault(); this.copySelection();
        }
        return false;
      }
      if (e.type !== "keydown") return true;
      const k = e.key.toLowerCase();
      if (e.key === "Enter" && (e.shiftKey || e.altKey) && !e.ctrlKey) {
        e.preventDefault();
        this.send(this.newlineSeq());
        return false;
      }
      // Ctrl+Shift+C always copies; Ctrl+C copies when there is a selection, else it is ^C.
      if (e.ctrlKey && k === "c" && (e.shiftKey || t.hasSelection())) {
        e.preventDefault();
        this.copySelection();
        return false;
      }
      // Ctrl+V: let the browser fire its paste event, which xterm turns into a
      // bracketed paste (multi-line text arrives as one block).
      if (e.ctrlKey && k === "v") return false;
      return true;
    });
    t.element.addEventListener("contextmenu", (e) => {
      if (t.hasSelection()) { e.preventDefault(); this.copySelection(); }
    });

    // capture phase: grab file pastes before xterm turns them into (empty) text
    this.termEl.addEventListener("paste", (e) => {
      const files = pastedFiles(e);
      if (!files.length) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.filesIn(files);
    }, true);

    const body = $(".pane-body", this.el), drop = $(".drop", this.el);
    let depth = 0;
    const dragging = (e) => this.conn && [...(e.dataTransfer?.types || [])].includes("Files");
    body.addEventListener("dragenter", (e) => { if (dragging(e)) { depth++; drop.hidden = false; } });
    body.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; drop.hidden = true; } });
    body.addEventListener("dragover", (e) => { if (dragging(e)) e.preventDefault(); });
    body.addEventListener("drop", (e) => {
      depth = 0; drop.hidden = true;
      if (!dragging(e)) return;
      e.preventDefault();
      setActive(this);
      this.filesIn([...e.dataTransfer.files]);
    });

    this.el.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "back") this.goBack();
      else if (act === "close") closePane(this);
      else if (act === "kill") this.killSession();
      else if (act === "redraw") this.redraw();
      else if (act === "raw") this.enableCodexRawScrollback();
      else if (act === "compose") { setActive(this); this.openMailbox(); }
      else if (act === "questions") openSessionQuestions(this.id);
      else if (act === "file") openAttach();
      else if (act === "new") openNew();
      else if (act === "folder") openFolderDialog(this.id);
      else if (act === "browse") { const b = sessionBases(this.id); if (b[0]) openTree(b[0], b); }
      else if (act === "board") openBoard(this.id);
      else if (act === "reload") this.reloadWeb();
      else if (act === "watch") this.toggleWatch();
      else if (act === "newtab") { const w = find(this.id); if (w) describeWeb(w.target).then((d) => d && window.open(viewUrl(d), "_blank", "noopener")); }
      const mode = e.target.closest("[data-adopt]")?.dataset.adopt;
      if (mode) this.adopt(mode, e.target);
      const h = e.target.closest("[data-hact]");
      if (h) histAction(this, h.dataset.hact, h);
    });
    new ResizeObserver(() => requestAnimationFrame(() => this.refit())).observe(body);
  }

  // ---- io
  wireReplayInput() {
    // xterm handles keydown in capture on its own root; observe on the outer
    // pane terminal element, before that handler can synchronously emit data.
    const input = this.termEl;
    for (const type of ["keydown", "keypress"]) {
      input.addEventListener(type, () => { this.replayKeyboard = true; }, true);
      input.addEventListener(type, () => { this.replayKeyboard = false; });
    }
    // IME/mobile text can arrive without a keydown xterm can use. Take it
    // before xterm's input listener, so it is queued once, not dropped there.
    input.addEventListener("beforeinput", (event) => {
      const c = this.conn;
      if (!localMeshEffectsAllowed() || !(c?.replaying || c?.draining || c?.replayPending)
          || event.isComposing || !event.data || !["insertText", "insertCompositionText"].includes(event.inputType)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      this.sendRaw(enc.encode(event.data), false);
    }, true);
  }
  cancelReplayInput(c) {
    const queue = c.queuedHumanInput || [], running = c.activeHumanInput;
    c.queuedHumanInput = [];
    c.cancellingHumanInput = true;
    try {running?.cancel(); for (const entry of queue) entry.input.cancel();}
    finally {c.cancellingHumanInput = false;}
  }
  flushReplayInput(c) {
    if (c.replaying || c.draining || c.replayPending || c.flushingHumanInput || c.cancellingHumanInput) return;
    c.flushingHumanInput = true;
    try {
      c.activeHumanInput?.resume?.();
      while (!c.activeHumanInput && !c.replaying && !c.draining && !c.replayPending && c.queuedHumanInput?.length) {
        const entry = c.queuedHumanInput.shift();
        if (localMeshEffectsAllowed() && this.conn === c && !c.closed && c.ws === entry.socket
            && c.terminal?.isBound(c.name, c.created)) entry.input.flush();
        else entry.input.cancel();
      }
    } finally {c.flushingHumanInput = false;}
  }
  deferReplayPaste(binding, text, resume, cancel) {
    const c = binding.connection;
    if (c.v2AwaitingCapability || !c.terminal?.isBound(c.name, c.created)) {
      cancel(); return {start() {}, settle() {}};
    }
    // Keep the FIFO barrier through settlement, including delayed Enter.
    // Later human keys must not overtake a submitted paste, even after replay.
    const reservation = this.inputLease.defer(enc.encode(text || "\r"), false);
    const acknowledged = this.inputAck;
    let held = true;
    const settle = () => {
      if (!held) return;
      held = false; reservation.cancel();
      if (c.activeHumanInput === input) c.activeHumanInput = null;
      this.flushReplayInput(c);
    };
    const input = {
      write: (bytes, complete) => this.conn === c && this.inputAck === acknowledged &&
        (acknowledged ? this.sendAcknowledgedInput(bytes, complete) : reservation.write(bytes, complete)),
      resume,
      flush: () => {
        if (!held) return false;
        c.activeHumanInput = input;
        resume(); return true;
      },
      cancel: () => {if (!held) return; try {cancel();} finally {settle();}},
    };
    (c.queuedHumanInput ||= []).push({socket: binding.socket, input});
    return {start: () => this.flushReplayInput(c), settle};
  }
  send(str, complete = completesInput(str)) {
    this.sendRaw(enc.encode(str), complete);
  }
  sendRaw(bytes, complete = false) {
    if (!localMeshEffectsAllowed()) return false;
    const c = this.conn;
    if (!c || c.closed || c.ended) return false;
    if (!c.terminal?.isOpen()) {
      const entry = this.inputAcks.get(`${c.name}\0${c.created}`);
      const offline = c.initializing || [WebSocket.CONNECTING, WebSocket.CLOSING, WebSocket.CLOSED].includes(c.ws?.readyState);
      if (!offline || c.waitingListing || !Number.isFinite(c.created) || c.created <= 0 ||
          !this.inputAck || entry?.input !== this.inputAck || entry?.lease !== this.inputLease ||
          MeshPaneActions.terminalReportsOnly(bytes)) return false;
      const retainedBytes = [...this.inputAcks.values()].reduce((sum, item) => sum + item.input.pendingBytes, 0);
      if (bytes.byteLength > 1024 * 1024 - retainedBytes - (c.queuedAckBytes || 0)) return false;
      const retained = this.inputAck.retain(bytes, complete);
      if (retained) { this.inputLease?.hold(); this.renderRetainedInput(); }
      return retained;
    }
    // A v2 actor awaiting its first capability stores bytes for explicit review;
    // it cannot send them before the server has bound the actor.
    if (this.inputAck?.version === 2 && c.v2AwaitingCapability)
      return this.sendAcknowledgedInput(bytes, complete);
    if ((c.replaying || c.draining || c.replayPending || c.activeHumanInput || c.flushingHumanInput
        || c.queuedHumanInput?.length) && this.inputLease) {
      if (!c.terminal.isBound(c.name, c.created)) { flash(t("terminal.limitedInput")); return false; }
      if (this.inputAck) {
        const retained = [...this.inputAcks.values()].reduce((sum, entry) => sum + entry.input.pendingBytes, 0);
        if (bytes.byteLength > 1024 * 1024 - retained - (c.queuedAckBytes || 0)) {
          flash(t("conn.inputFull")); return false;
        }
        const payload = bytes.slice(), reservation = this.inputLease.defer(payload, complete);
        const originalAck = this.inputAck;
        let pending = true;
        c.queuedAckBytes = (c.queuedAckBytes || 0) + payload.byteLength;
        const release = () => {
          if (!pending) return false;
          pending = false; c.queuedAckBytes -= payload.byteLength; reservation.cancel(); return true;
        };
        const input = {cancel: release, flush: () => {
          if (!release()) return false;
          if (this.conn !== c || this.inputAck !== originalAck) return false;
          // The FIFO is already being flushed; send directly, without requeueing.
          return this.sendAcknowledgedInput(payload, complete);
        }};
        (c.queuedHumanInput ||= []).push({socket: c.ws, input});
      } else {
        const input = this.inputLease.defer(bytes, complete);
        (c.queuedHumanInput ||= []).push({socket: c.ws, input});
      }
      return true;
    }
    if (this.inputAck) return this.sendAcknowledgedInput(bytes, complete);
    return this.inputLease?.write(bytes, complete) ?? false;
  }
  sendAcknowledgedInput(bytes, complete) {
    if (!this.inputAck) return false;

      if (!this.conn?.terminal?.isOpen()) {
        flash(t("conn.inputUnavailable"));
        return false;
      }
      if (this.inputAck.state === "halted" || this.inputAck.blocked) {
        flash(t("conn.inputUnavailable"));
        return false;
      }
      const retainedBytes = [...this.inputAcks.values()]
        .reduce((sum, entry) => sum + entry.input.pendingBytes, 0);
      if (bytes.byteLength > 1024 * 1024 - retainedBytes - (this.conn?.queuedAckBytes || 0)) {
        flash(t("conn.inputFull"));
        return false;
      }
      const reportOnly = MeshPaneActions.terminalReportsOnly(bytes);
      const wasDirty = this.inputLease?.dirty;
      if (!reportOnly && !(this.inputAck.version === 2 && this.conn?.v2AwaitingCapability))
        this.inputLease?.hold();
      const retained = this.inputAck.write(bytes, complete);
      if (!retained && !wasDirty && !reportOnly) this.inputLease?.release();
      if (!retained) flash(t(this.inputAck.state === "halted" ? "conn.inputUnavailable" : "conn.inputFull"));
      this.renderRetainedInput();
      return retained;
  }

  renderRetainedInput() {
    const container = $(".p-input-review", this.el);
    let stale = this.obsoleteDirtyInput();
    while (stale && logObsoleteInput(this.conn.name, stale.key.split("\0")[1])) {
      this.inputAcks.delete(stale.key);
      this.inputLeases.delete(stale.key);
      stale = this.obsoleteDirtyInput();
    }
    const entries = this.activeSessionInputs().map(([, entry]) => entry).filter((entry) => entry.input.pendingBytes);
    const pending = entries.reduce((total, entry) => total + entry.input.pendingBytes, 0);
    const current = this.inputAck;
    const obsolete = this.obsoleteDirtyInput();
    // A retained socket's lease is reviewed on its own session, not by
    // resizing an unrelated active terminal when its late ACK arrives.
    const other = [...this.inputAcks].filter(([key, entry]) =>
      (key.split("\0").length === 2 && !key.startsWith(`${this.conn?.name ?? ""}\0`) ||
        (key.startsWith(`${this.conn?.name}\0${this.conn?.created}\0`) &&
          !entry.input.retainedConnection && entry.lease?.dirty && !entry.input.pendingBytes)) &&
      (entry.input.pendingBytes || entry.lease?.dirty));
    const saved = [...(this.recoveredLineDrafts || [])];
    const composeDraft = this.recoveredComposeDraft;
    const savedCompose = composeDraft && !this.recoveredComposeOwner &&
      (composeDraft.name !== this.conn?.name || composeDraft.created !== this.conn?.created) ? composeDraft : null;
    const forgetDraft = $(".p-input-forget-draft", container);
    forgetDraft.textContent = t("conn.inputForgetOldDraft");
    forgetDraft.hidden = !obsolete;
    // Routine ACKs must not move the terminal under the cursor or a finger.
    // Retained input needing review, including from an old attachment, still needs a choice.
    const reviewPending = entries.some(({ input }) => input !== current || input.state !== "sending");
    container.hidden = !reviewPending && current?.state !== "halted" && !obsolete && !other.length && !saved.length && !savedCompose;
    if (touch && this.conn && this.recoveredLineDrafts?.has(`${this.conn.name}\0${this.conn.created}`))
      setTimeout(() => restoreSavedLine(this), 0);
    if (!this.restoreOldInputScheduled && current?.editableRetainedText) {
      this.restoreOldInputScheduled = true;
      setTimeout(() => { this.restoreOldInputScheduled = false; restoreOldInputToEditor(this); }, 0);
    }
    const otherContainer = $(".p-input-other-drafts", container);
    const otherState = JSON.stringify([other.map(([key, entry]) =>
      [key, entry.input.pendingBytes, entry.input.pendingHumanBytes, entry.input.deliveryUncertain, entry.input.retainedText, !!entry.lease?.dirty]),
      saved.map(([key, draft]) => [key, draft.text])]);
    if (this.otherDraftsState !== otherState || this.otherDraftsCompose !== savedCompose || !this.otherDraftsEntries ||
        other.some(([key, entry], i) => this.otherDraftsEntries[i]?.[0] !== key || this.otherDraftsEntries[i]?.[1] !== entry)) {
      this.otherDraftsState = otherState;
      this.otherDraftsEntries = other;
      this.otherDraftsCompose = savedCompose;
      otherContainer.replaceChildren();
      for (const [key, entry] of other) {
        const card = document.createElement("section");
        card.className = "p-input-other-draft";
        const heading = document.createElement("strong");
        heading.textContent = key.split("\0", 1)[0];
        const summary = document.createElement("span");
        summary.textContent = entry.input.pendingBytes
          ? t("conn.inputRetained", { count: entry.input.pendingBytes,
            state: t(entry.input.deliveryUncertain ? "conn.inputUncertain" : "conn.inputReview") })
          : t("conn.inputObsoleteDraft");
        card.append(heading, summary);
        if (entry.input.pendingHumanBytes) {
          const label = document.createElement("label");
          label.textContent = t("conn.inputCopyDraft");
          const text = document.createElement("textarea");
          text.readOnly = true; text.spellcheck = false; text.value = entry.input.retainedText;
          label.append(text); card.append(label);
          const copy = document.createElement("button");
          copy.type = "button"; copy.className = "btn ghost sm"; copy.textContent = t("common.copy");
          copy.addEventListener("click", async () => {
            if (this.inputAcks.get(key) !== entry) return;
            try { await navigator.clipboard.writeText(text.value); flash(t("clipboard.copied")); }
            catch { text.focus(); text.select(); flash(t("clipboard.copyDenied")); }
          });
          card.append(copy);
        }
        if (entry.input.pendingBytes) {
          const discard = document.createElement("button");
          discard.type = "button"; discard.className = "btn ghost sm";
          discard.textContent = t(entry.input.deliveryUncertain ? "conn.inputDiscardUnknown" : "conn.inputDiscard");
          discard.addEventListener("click", () => {
            if (this.inputAcks.get(key) !== entry || !entry.input.pendingBytes) return;
            const uncertain = entry.input.deliveryUncertain;
            entry.input.discard();
            if (!uncertain && !entry.input.incompleteHumanInput) entry.lease?.release();
            this.renderRetainedInput();
            renderReloadStatus();
          });
          card.append(discard);
        }
        if (entry.lease?.dirty && !entry.input.pendingBytes) {
          const sameIncarnation = key.startsWith(`${this.conn?.name}\0${this.conn?.created}\0`);
          const action = document.createElement("button");
          action.type = "button"; action.className = "btn ghost sm";
          action.textContent = t(sameIncarnation ? "conn.inputReconnect" : "conn.inputForgetOldDraft");
          action.addEventListener("click", () => {
            if (this.inputAcks.get(key) !== entry || entry.input.pendingBytes || !entry.lease?.dirty) return;
            if (sameIncarnation) {
              if (!this.reconnectRetainedInput(key, entry)) flash(t("conn.inputUnavailable"));
              return;
            }
            if (!confirm(t("conn.inputForgetOldDraftConfirm"))) return;
            this.inputAcks.delete(key);
            this.inputLeases.delete(key);
            this.renderRetainedInput();
            renderReloadStatus();
          });
          card.append(action);
        }
        otherContainer.append(card);
      }
      const reviewDrafts = saved.map(([key, draft]) => ({
        name: draft.name, value: draft.text,
        matches: () => this.recoveredLineDrafts.get(key) === draft,
        discard: () => { releaseDiscardedEditorDraft(draft); this.recoveredLineDrafts.delete(key); },
      }));
      if (savedCompose) reviewDrafts.push({
        name: savedCompose.name, value: savedCompose.text,
        matches: () => this.recoveredComposeDraft === savedCompose && !this.recoveredComposeOwner,
        discard: () => {
          releaseDiscardedEditorDraft({pane: this, ...savedCompose});
          this.recoveredComposeDraft = null;
        },
      });
      for (const {name, value, matches, discard: removeDraft} of reviewDrafts) {
        const card = document.createElement("section"); card.className = "p-input-other-draft";
        const heading = document.createElement("strong"); heading.textContent = name;
        const label = document.createElement("label"); label.textContent = t("conn.inputCopyDraft");
        const field = document.createElement("textarea"); field.readOnly = true; field.value = value;
        label.append(field); card.append(heading, label);
        const copy = document.createElement("button"); copy.type = "button"; copy.className = "btn ghost sm";
        copy.textContent = t("common.copy");
        copy.addEventListener("click", async () => {
          if (!matches()) return;
          try { await navigator.clipboard.writeText(value); flash(t("clipboard.copied")); }
          catch { field.focus(); field.select(); flash(t("clipboard.copyDenied")); }
        });
        const discard = document.createElement("button"); discard.type = "button"; discard.className = "btn ghost sm";
        discard.textContent = t("conn.inputDiscard");
        discard.addEventListener("click", () => {
          if (!matches()) return;
          removeDraft(); this.renderRetainedInput(); renderReloadStatus();
        });
        card.append(copy, discard); otherContainer.append(card);
      }
    }
    const drafts = $(".p-input-drafts", container);
    const texts = [];
    if (!container.hidden && this.conn?.name) {
      for (const [key, entry] of this.activeSessionInputs()) {
        if (!entry.input.pendingHumanBytes) continue;
        // In-flight input does not need review. Showing it while another draft
        // keeps this panel open makes the terminal resize on every ACK.
        if (entry.input === current && entry.input.state === "sending") continue;
        texts.push({ text: entry.input.retainedText, previous:
          !key.startsWith(`${this.conn.name}\0${this.conn.created}\0`) &&
          key !== `${this.conn.name}\0${this.conn.created}` });
      }
    }
    const existing = [...drafts.querySelectorAll("textarea")];
    if (drafts.dataset.session !== (this.conn?.name ?? "") || existing.length !== texts.length ||
        existing.some((field, i) => field.value !== texts[i].text || field.dataset.previous !== String(texts[i].previous))) {
      drafts.replaceChildren();
      drafts.dataset.session = this.conn?.name ?? "";
      for (const {text, previous} of texts) {
        const label = document.createElement("label");
        label.textContent = t(previous ? "conn.inputCopyPreviousDraft" : "conn.inputCopyDraft");
        const textarea = document.createElement("textarea");
        textarea.dataset.previous = String(previous);
        textarea.readOnly = true;
        textarea.spellcheck = false;
        textarea.value = text;
        label.append(textarea);
        drafts.append(label);
      }
    }
    if (container.hidden) return;
    $(".p-input-discard", container).textContent = t(entries.some((entry) =>
      entry.input.state === "uncertain") ? "conn.inputDiscardUnknown" : "conn.inputDiscard");
    $(".p-input-discard", container).hidden = !pending;
    const retry = $(".p-input-retry", container);
    retry.textContent = t(current?.state === "halted" ? "conn.inputReconnect" : "conn.inputRetry");
    retry.hidden = !current ||
      (current.version === 2 && current.blocked && current.state !== "halted") ||
      (current.state === "halted" ? current.pendingBytes !== 0
        : !current.pendingBytes || (current.state !== "review" && current.state !== "uncertain")) ||
      (!this.conn?.terminal?.isOpen() && !(current.version === 2 && current.state === "halted"));
    const state = entries.some((entry) => entry.input !== current)
      ? t("conn.inputStale")
      : obsolete ? t("conn.inputObsoleteDraft")
      : t(current?.version === 2 && !current.binding
        ? (current.blocked ? "conn.inputV2Unconfirmed" : "conn.inputV2Awaiting")
        : current?.state === "uncertain" ? "conn.inputUncertain"
        : current?.state === "sending" ? "conn.inputSending"
          : current?.state === "halted" ? "conn.inputHalted" : "conn.inputReview");
    $(".p-input-state", container).textContent = pending
      ? t("conn.inputRetained", { count: pending, state }) : state;
  }

  activeSessionInputs() {
    const name = this.conn?.name;
    return name ? [...this.inputAcks].filter(([key]) => key.startsWith(`${name}\0`)) : [];
  }

  obsoleteDirtyInput() {
    const c = this.conn;
    if (!c) return null;
    const currentKey = `${c.name}\0${c.created}`;
    for (const [key, entry] of this.activeSessionInputs()) {
      if (key !== currentKey && !key.startsWith(`${currentKey}\0`) && entry.input !== this.inputAck &&
          !entry.input.pendingBytes && entry.lease?.dirty) return { key, entry };
    }
    return null;
  }

  reconnectRetainedInput(key, entry) {
    const c = this.conn, session = c && find(c.name);
    if (!localMeshEffectsAllowed() || !c || c.closed || c.ended || !session ||
        !rowAuthoritative(session) || session.created !== c.created || listedInputVersion(session) !== 2) return false;
    const currentKey = `${c.name}\0${c.created}`, current = this.inputAcks.get(currentKey);
    if (!key.startsWith(`${currentKey}\0`) || this.inputAcks.get(key) !== entry ||
        entry.input.version !== 2 || !entry.input.binding || entry.input.blocked ||
        entry.input.pendingBytes || !entry.lease?.dirty || entry.input.retainedConnection ||
        entry.retainedSocket?.socket.readyState !== WebSocket.CLOSED ||
        !current || current.input !== this.inputAck || current.lease !== this.inputLease ||
        current.input.pendingBytes || current.input.retainedConnection || current.lease.dirty ||
        current.lease.releasePending || current.lease.retained) return false;
    // Resume the original native actor, not its text. The temporary view's
    // clean actor can retire; the original dirty lease stays authoritative.
    this.detach();
    current.lease.retire();
    this.inputAcks.delete(key); this.inputLeases.delete(key);
    this.inputAcks.set(currentKey, entry); this.inputLeases.set(currentKey, entry.lease);
    this.attach(c.name, {focusTerminal: true});
    return true;
  }

  inputLeaseFor(name) {
    requireLocalMesh();
    const session = find(name);
    const incarnation = session?.created ?? null;
    if ((!session || session.provisional) &&
        (!Number.isFinite(incarnation) || incarnation <= 0)) {
      this.inputAck = null;
      return null;
    }
    if (incarnation !== null && !listedInputAcknowledgement(session) && !listedLegacyInput(session)) {
      this.inputAck = null;
      return null;
    }
    const key = `${name}\0${incarnation}`;
    let scope = humanInputScopes.get(key);
    if (!scope) {
      scope = MeshPaneActions.createHumanInputScope(() => {if (humanInputScopes.get(key) === scope) humanInputScopes.delete(key);});
      humanInputScopes.set(key, scope);
    }
    const version = listedInputVersion(session);
    if (version === 2 && !this.inputAcks.has(key)) {
      const former = [...this.inputAcks].find(([old, entry]) =>
        old.startsWith(`${key}\0`) && entry.input.version === 2 &&
        !entry.input.retainedConnection && entry.retainedSocket &&
        !entry.retainedSocket.isOpen() && !entry.input.pendingBytes);
      if (former) {
        const [old, entry] = former;
        this.inputAcks.delete(old); this.inputLeases.delete(old);
        this.inputAcks.set(key, entry); this.inputLeases.set(key, entry.lease);
      }
    }
    for (const [old, entry] of this.inputAcks) {
      if (old !== key && !entry.input.retainedConnection &&
          entry.input.pendingBytes === 0 && !entry.lease?.dirty) {
        this.inputAcks.delete(old); this.inputLeases.delete(old);
      } else if (entry.input.retainedConnection && old.split("\0").length === 2) {
        // The native host cannot bind one ACK actor to two simultaneous sockets.
        // Keep this actor for its retained socket while a reopened pane gets its own.
        const retained = `${old}\0${entry.id}`;
        entry.retainedSocket = entry.input.retainedConnection.terminal;
        this.inputAcks.delete(old); this.inputLeases.delete(old);
        this.inputAcks.set(retained, entry); this.inputLeases.set(retained, entry.lease);
      }
    }
    let lease = this.inputLeases.get(key);
    const previous = this.inputAcks.get(key);
    if (lease && previous?.input.version === 1 && version === 2 &&
        !previous.input.pendingBytes && !lease.dirty &&
        ![...this.inputAcks.values()].some((entry) => entry.input.pendingBytes || entry.lease?.dirty)) {
      this.inputAcks.delete(key);
      this.inputLeases.delete(key);
      lease.retire();
      lease = null;
    }
    if (lease) this.inputAck = this.inputAcks.get(key)?.input ?? null;
    const clientId = this.inputAcks.get(key)?.id ?? (version
      ? `${inputLeaseTab.slice(0, 32)}_${this.inputLeaseSlot}_${crypto.randomUUID().replaceAll("-", "")}`
      : MeshPaneActions.humanInputClientId(inputLeaseTab, this.inputLeaseSlot, name, incarnation));
    if (!lease) this.inputAck = version
      ? MeshPaneActions.createAcknowledgedInput({
        attachmentId: version === 1 ? clientId : undefined, version, created: incarnation,
        send: (frame) => {
          const c = this.conn;
          if (c?.name !== name || c.created !== incarnation || !c.terminal?.isOpen())
            throw new Error("terminal disconnected");
          c.terminal.acknowledgedInput(frame);
        },
        state: () => this.renderRetainedInput(),
      }) : null;
    const input = this.inputAck;
    const transport = {
      control: (id, dirty) => {
        const c = this.conn, terminal = c?.terminal;
        if (this.inputLease !== lease || this.inputAck !== input ||
            c?.name !== name || (c.created ?? null) !== incarnation ||
            (version === 2 && (c.v2AwaitingCapability || !input?.binding)) || !terminal?.isOpen())
          throw new Error("terminal disconnected");
        terminal.lease(id, dirty);
      },
      data: (bytes) => {
        const c = this.conn, terminal = c?.terminal;
        if (this.inputLease !== lease || this.inputAck !== input ||
            c?.name !== name || (c.created ?? null) !== incarnation || !terminal?.isOpen())
          throw new Error("terminal disconnected");
        terminal.queueInput(bytes);
      },
    };
    // Acknowledged actors retain their own identity; only legacy leases may be adopted.
    const adopted = !version && !lease?.dirty && scope.adopt(transport, {retained: true});
    if (adopted && adopted !== lease) {lease?.retire(); lease = adopted;}
    if (lease) lease.bind(transport);
    else lease = MeshPaneActions.createHumanInputLease({clientId, scope, ...transport});
    this.inputLeases.set(key, lease);
    if (this.inputAck) this.inputAcks.set(key, { id: clientId, input: this.inputAck, lease });
    return lease;
  }
  // Tell the pty this pane's size. `force` is for events that mean "this device is
  // the one in use" (focus, the page becoming visible, a new socket); automatic
  // refits only send a size that differs from the last one this connection sent,
  // so a layout that jitters cannot storm the program with SIGWINCH.
  // `mode` (MeshPaneActions.sendsSize): a pane that follows another device's size sends
  // only "keep" (a redraw at the PTY's size); "take" goes through takeSize.
  sendSize(force = false, rows = this.ownSize().rows, mode = "claim") {
    if (!localMeshEffectsAllowed()) return;
    const c = this.conn;
    if (c?.initializing || !c?.terminal?.isOpen()) return;
    if (!c.terminal.isBound(c.name, c.created) && !((c.terminal.limited || c.created == null) && mode === "take")) return;
    if (!MeshPaneActions.sendsSize(c.pty ?? null, mode)) return;
    const cols = this.ownSize().cols, last = c.lastSize;
    if (!force && last && last.rows === rows && last.cols === cols) return;
    c.lastSize = { rows, cols };
    c.terminal.resize(rows, cols, mode);
    if (mode === "claim" && c.pty === null) c.initialSizeClaim = true;
  }
  // The PTY size and its owner, from the host ({t:"s"}, at each change). Another device owns
  // it: the pane shows the PTY at that size (followPtySize). Nobody owns it: the pane fits and
  // claims. This pane owns it: nothing to change, unless it followed until now.
  applyPtySize(c, initialClaim = false) {
    if (c !== this.conn || this.termEl.hidden) return;
    if (c.replaySize) {
      c.replaySizeRelease = c.pty?.owner === "none" && !initialClaim;
      return;
    }
    const owner = c.pty?.owner;
    if (owner === "you" && !this.ptyFollowing) return;
    this.refit();
    // The first snapshot may precede our already-queued claim. A later release
    // must still claim even when its dimensions equal the last size sent.
    if (owner === "none" && !initialClaim) this.sendSize(true);
  }
  // The size the pane's area fits, without applying it; null when it cannot be measured.
  fitSize() {
    let size = null;
    try { size = this.fit.proposeDimensions(); } catch {}
    return Number.isInteger(size?.rows) && Number.isInteger(size?.cols) ? { rows: size.rows, cols: size.cols } : null;
  }
  // True when another device owns the size: xterm takes the PTY's size, clipped by the pane
  // (the bottom rows kept when it is taller), and the banner offers to take the size back.
  followPtySize(c) {
    if (c?.terminal?.limited) {
      const size = c.limitedGeometry;
      this.sizeBanner.hidden = true;
      this.ptyFollowing = !!size;
      this.termEl.classList.toggle("pty-tall", !!size && size.rows > (this.fitSize()?.rows ?? this.term.rows));
      if (size && (this.term.cols !== size.cols || this.term.rows !== size.rows)) this.term.resize(size.cols, size.rows);
      return !!size;
    }
    if (!c?.pty && !this.ptyFollowing) return false;   // a host without the rule: nothing to show
    const own = this.fitSize() ?? { rows: this.term.rows, cols: this.term.cols };
    const plan = MeshPaneActions.sizePlan(c?.pty ?? null, own);
    this.ptyFollowing = plan.follow;
    this.termEl.classList.toggle("pty-follow", plan.follow);
    this.termEl.classList.toggle("pty-tall", plan.follow && plan.term.rows > own.rows);
    this.sizeBanner.hidden = !MeshPaneActions.showsSizeBanner(sizeTakeoverMode(), plan.banner);
    if (plan.follow && (plan.term.rows !== this.term.rows || plan.term.cols !== this.term.cols))
      this.term.resize(plan.term.cols, plan.term.rows);
    return plan.follow;
  }
  // The banner's button: the PTY takes this pane's size, and this device owns it until another
  // one takes it back. The take-over is sent before xterm fits, so the fit's own size, sent as
  // a claim, reaches the host after it.
  takeSize() {
    const c = this.conn, own = this.fitSize();
    if (localActionUnavailable() || !own || c?.initializing || c?.replaySize || !c?.terminal?.isOpen()) return false;
    if (c.terminal.limited) {
      c.limitedGeometry = own;
      c.terminal.resize(own.rows, own.cols, "take");
      this.refit(); return true;
    }
    if (c.pty) c.pty = { ...c.pty, owner: "you" };
    c.lastSize = own;
    c.away = null;
    c.terminal.resize(own.rows, own.cols, "take");
    this.refit();
    return true;
  }
  // The automatic mode (per-browser preference "sizeTakeover"): the same take-over, sent when the
  // person uses this device (MeshPaneActions.shouldTakeSize decides; never a timer or a resize).
  autoTakeSize(event) {
    const c = this.conn;
    if (this.termEl.hidden || !c?.terminal?.isBound(c.name, c.created) || c.replayPending || c.replaying) return;
    const now = performance.now();
    if (!MeshPaneActions.shouldTakeSize({ mode: sizeTakeoverMode(), owner: c.pty?.owner ?? null,
      event: event.type, trusted: event.isTrusted, visible: document.visibilityState === "visible",
      focused: document.hasFocus(), activated: navigator.userActivation?.isActive === true, now, lastTake: this.lastAutoTake })) return;
    if (this.takeSize()) this.lastAutoTake = now;
  }
  // The pane's fitted size; while a replay is parsed at its own geometry (enterReplayGeometry),
  // the size xterm returns to afterwards, never the replay's.
  ownSize() {
    return this.conn?.replaySize ?? { rows: this.term.rows, cols: this.term.cols };
  }
  // A replay is parsed at its reported geometry when available,
  // then xterm takes this pane's size back and rewraps its rows (leaveReplayGeometry). The
  // resize is done now, not in a write of its own: output still queued before the replay is
  // wiped by the reset the replay starts with (replayPrefix). Meanwhile sizes sent are the
  // pane's own (ownSize) and refit waits.
  enterReplayGeometry(c, geometry) {
    const own = this.ownSize();
    const at = geometry && (geometry.rows !== own.rows || geometry.cols !== own.cols) ? geometry : null;
    c.replaySize = at ? own : null;
    const size = at ?? own;
    if (size.rows !== this.term.rows || size.cols !== this.term.cols) this.term.resize(size.cols, size.rows);
  }
  // Only for the connection and socket that parsed the replay: a pane that changed connection
  // fits its own size; a later socket's replay starts from replaySize (enterReplayGeometry).
  leaveReplayGeometry(c) {
    const own = c.replaySize;
    if (!own) return;
    c.replaySize = null;
    const claimReleased = c.replaySizeRelease;
    c.replaySizeRelease = false;
    // A pane that follows another device's size goes straight to the PTY's (one rewrap).
    const back = c.terminal?.limited && c.limitedGeometry
      ? c.limitedGeometry : c.pty?.owner === "other" ? c.pty : own;
    this.term.resize(back.cols, back.rows);
    const beforeRefit = c.lastSize;
    this.refit();   // the layout may have changed meanwhile
    if (c === this.conn && claimReleased && c.pty?.owner === "none" && !this.termEl.hidden && c.lastSize === beforeRefit)
      this.sendSize(true);
  }
  // A socket's first frame: the replay of the session's recent output, which after a
  // reconnection the terminal already shows. Its reset (replayPrefix) is in the same write, so
  // output written before is parsed before the reset and nothing waits between them; it is
  // parsed at the geometry it was produced at; the pane follows again, as a reader's anchor in
  // the replaced buffer means nothing. A reconnection on the alternate screen (null prefix)
  // appends the replay at the pane's size, as before. `stillCurrent`: the socket that brought
  // the replay is still this connection's, and the connection still the pane's.
  writeReplay(c, bytes, stillCurrent) {
    c.replaying = true;
    const prefix = MeshPaneActions.replayPrefix(this.term, c.replayed === true);
    const geometry = c.replayGeometry;
    c.replayed = true;
    c.replayGeometry = null;
    const finish = () => {
      if (!stillCurrent()) return;
      c.replaying = false;
      if (prefix !== null) this.leaveReplayGeometry(c);
      if (c.cacheRestore && c.terminal?.isBound(c.name, c.created)) {
        c.cacheRestore = false;
        this.cachedTerminalMoveBlockedId = null;
      }
      this.flushReplayInput(c);
      renderInlineDictation();
    };
    if (prefix === null) return this.output(bytes, finish);
    // The retained socket observer sees raw output. A visible replay also has
    // a local reset/mode prefix; mirror that prefix before its raw bytes.
    c.terminal.replayMode(prefix, bytes);
    this.resumeFollowing(c);
    this.enterReplayGeometry(c, geometry);
    this.output(prefixedBytes(prefix, bytes), finish);
  }
  // A real size change and back: the program gets a genuine SIGWINCH and repaints.
  redraw() {
    if (localActionUnavailable()) return;
    const c = this.conn;
    if (!c?.terminal?.isOpen()) return;
    if (!c.terminal.isBound(c.name, c.created)) { flash(t("terminal.limitedInput")); return; }
    const rows = this.ownSize().rows;
    // A pane that follows another device's size redraws at the PTY's size, which stays that
    // device's ("keep"); the second size is the one read now, as the first changes xterm's.
    const mode = c.pty?.owner === "other" ? "keep" : "claim";
    c.away = null;   // the program repaints the whole screen for this size
    this.sendSize(true, rows > 2 ? rows - 1 : rows + 1, mode);
    setTimeout(() => { if (this.conn === c) this.sendSize(true, rows, mode); }, REDRAW_GAP_MS);
  }
  // The device in use takes the size back (its terminal focused, the page visible again).
  // With a host that has the size owner rule (c.pty known), the pane always shows the PTY's
  // width, so nothing was drawn for another width: it only sends its size, which the host
  // applies if this pane owns the size or nobody does (only the banner takes it from another
  // device). With an older host, the PTY has the size of the last client that sent one, and
  // this pane is not told when another one does. Evidence that the screen may hold output
  // drawn for another width: output arrived while this terminal was not in use and another
  // client was attached. Then ask for a redraw, which repaints even when the PTY already has
  // this size; else only send the size, so an ordinary focus never makes the program repaint.
  // Taking the size back ends the time away either way: output from then on is drawn for
  // this size.
  retakeSize() {
    const c = this.conn, away = c?.away;
    if (away && !c.pty && (away.shared || this.sharedSession(c)) && !c.autoRedraw) { this.redraw(); return; }
    if (c) c.away = null;
    this.sendSize(true);
  }
  noteOutputAway(c) {
    if (c.replaying || c.autoRedraw || c.initialFollow) return;   // the attach's own redraw is under way
    if (document.visibilityState === "visible" && document.activeElement === this.term.textarea) return;
    c.away ??= { shared: false };
    c.away.shared ||= this.sharedSession(c);
  }
  // From the session list (refreshed every few seconds): an attachment shorter than that can be missed.
  sharedSession(c) {
    return (find(c.name)?.attached ?? 0) > 1;
  }
  // Do not put this in attach/redraw/focus paths: a live fullscreen program is
  // entitled to use these modes.  A person invokes it only after a crashed or
  // misbehaving program left mouse/focus reporting behind.  xterm consumes the
  // sequences locally, so the current shell never receives escape bytes.
  recoverTerminalInteractionModes() {
    this.termEl.classList.remove("over-link");
    if (this.conn) this.conn.piFullscreenScroll = false;
    this.term.write(TERMINAL_INTERACTION_MODE_RESET, () => flash(t("terminal.modesReset")));
  }
  // A long replay can lose Pi's (or OpenCode's) initial fullscreen mouse modes. Restore only
  // on an explicit owner action: regular-mode Pi must keep native scrollback.
  // Do not enter the alternate screen here: that would clear the replay grid.
  restorePiFullscreenScroll(created) {
    const session = this.id && find(this.id), c = this.conn;
    const text = fullscreenScrollText(session);
    if (!Number.isFinite(created) || created <= 0 || !hasFullscreenScrollRecovery(session) || !c || c.closed
        || session.created !== created || c.created !== created) {
      flash(t(text.replaced));
      return;
    }
    c.piFullscreenScroll = true;
    this.term.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h",
      () => flash(t(text.restored)));
  }
  // Codex owns this mode and remembers it for the running process.  This asks
  // explicitly for the on state rather than emitting Alt+R, which would turn
  // it off again if the running session already has raw mode enabled.
  // It is a user-triggered recovery action, never input emitted during attach
  // or while handling a touch gesture.
  enableCodexRawScrollback() {
    if (!isCodexTerminal(this.id && find(this.id))) return;
    this.send("/raw on\r", true);
    flash(t("terminal.codexRawRequested"));
  }
  // Once per socket open: the host replays only the last 2 MiB, so a long conversation can
  // leave blank or partial rows; a real size change makes the program repaint its screen.
  // Armed on open, fired when the replay has gone quiet (the size is known: onopen sent it).
  armAutoRedraw(c) {
    c.autoRedraw = { terminal: c.terminal, deadline: Date.now() + AUTO_REDRAW_MAX_MS, timer: 0 };
    this.bumpAutoRedraw(c);
  }
  bumpAutoRedraw(c) {
    const a = c.autoRedraw;
    if (!a) return;
    clearTimeout(a.timer);
    a.timer = setTimeout(() => {
      c.autoRedraw = null;
      if (!c.closed && c.terminal === a.terminal) {
        // The resize asks the program to paint a complete screen after the
        // replay; follow that output separately, once it too is quiet.
        this.redraw();
        this.armInitialFollow(c);
      }
    }, Math.max(0, Math.min(AUTO_REDRAW_SETTLE_MS, a.deadline - Date.now())));
  }
  // One final anchor after the automatic redraw.  xterm usually follows a
  // write itself, but the replay/fit/redraw race can otherwise retain a
  // middle row.  A real history scroll cancels this; an ordinary click or
  // focus must not turn a fresh terminal into a stale one.
  armInitialFollow(c) {
    c.initialFollow = { terminal: c.terminal, deadline: Date.now() + AUTO_REDRAW_MAX_MS,
                        notBefore: Date.now() + REDRAW_GAP_MS + INITIAL_FOLLOW_SETTLE_MS, timer: 0 };
    this.bumpInitialFollow(c);
  }
  bumpInitialFollow(c) {
    const a = c.initialFollow;
    if (!a) return;
    clearTimeout(a.timer);
    const now = Date.now();
    const delay = Math.max(INITIAL_FOLLOW_SETTLE_MS, a.notBefore - now);
    a.timer = setTimeout(() => {
      c.initialFollow = null;
      if (!c.closed && c.terminal === a.terminal && c.followOutput) this.term.scrollToBottom();
    }, Math.max(0, Math.min(delay, a.deadline - now)));
  }
  cancelInitialFollow() {
    const a = this.conn?.initialFollow;
    if (!a) return;
    clearTimeout(a.timer);
    this.conn.initialFollow = null;
  }
  // `viewportY < baseY` says only where xterm currently is.  It does not say
  // whether a person deliberately scrolled there or an attach/fit/write race
  // left it behind.  Keep that intent per socket: a new attachment follows
  // output until a real history gesture says otherwise.
  followLiveOutput(c = this.conn) {
    if (!c || c.closed || this.conn !== c || !c.followOutput) return false;
    const b = this.term.buffer.active;
    if (b.type === "normal" && b.viewportY < b.baseY) {
      this.term.scrollToBottom();
      return true;
    }
    return false;
  }
  // A move towards the live end is resolved on the next frame because the
  // browser/xterm has not necessarily applied that move yet.  A packet can
  // arrive first, though: commit the result while the viewport is still at
  // the old end, before parsing advances baseY.  This is shared by wheel,
  // touch, scrollbar and End/PageDown; it records a person's intent rather
  // than relying on xterm's incidental follow behaviour.
  commitFollowAtBottom(c = this.conn) {
    if (!c || c.closed || this.conn !== c || !c.followCandidate) return false;
    const b = this.term.buffer.active;
    if (b.type !== "normal" || b.viewportY < b.baseY) return false;
    this.resumeFollowing(c);
    return true;
  }
  resumeFollowing(c = this.conn) {
    if (!c || c.closed || this.conn !== c) return;
    c.followCandidate = false;
    c.followOutput = true;
    this.dropReaderAnchor(c);
    if (c.followFrame) cancelAnimationFrame(c.followFrame);
    c.followFrame = 0;
  }
  dropReaderAnchor(c = this.conn) {
    c?.preserveViewport?.marker?.dispose();
    if (c) c.preserveViewport = null;
  }
  preserveReaderViewport(c = this.conn) {
    if (!c || c.closed || this.conn !== c || c.followOutput || c.preserveViewport !== null) return;
    const b = this.term.buffer.active;
    if (b.type === "normal") {
      // An absolute row number changes meaning when a full scrollback trims
      // older lines. xterm's public marker tracks that same line through trim.
      const marker = this.term.registerMarker(b.viewportY - b.baseY - b.cursorY);
      c.preserveViewport = { row: b.viewportY, marker };
    }
  }
  restoreReaderViewport(c = this.conn) {
    if (!c || c.closed || this.conn !== c || c.preserveViewport === null) return;
    const { row, marker } = c.preserveViewport;
    const viewportY = marker?.line >= 0 ? marker.line : row;
    this.dropReaderAnchor(c);
    const b = this.term.buffer.active;
    // xterm normally follows its own writes. While the person reads history,
    // put it back on the same absolute row after that parsed write instead.
    if (!c.followOutput && b.type === "normal") this.term.scrollToLine(Math.min(viewportY, b.baseY));
  }
  noteUserScroll(towardEnd = false) {
    const c = this.conn;
    if (!c || c.closed || this.term.buffer.active.type !== "normal") return;
    // An actual history gesture supersedes a prior click on the down-arrow.
    // A native scroll queued before that click must not pull the reader back
    // to the end after they have made a newer choice.
    c.bottomSync = false;
    c.followOutput = false;  // stop before a concurrent write can snap the reader back
    c.followCandidate = !!towardEnd;
    this.dropReaderAnchor(c);
    this.cancelInitialFollow();
    // Scrolling towards history is decisive even before xterm has painted its
    // new viewport. Only a gesture towards the end can opt back in, and then
    // only after the viewport has had one frame to reach that end.
    if (c.followFrame) {
      cancelAnimationFrame(c.followFrame);
      c.followFrame = 0;
    }
    if (!towardEnd) return;
    c.followFrame = requestAnimationFrame(() => {
      c.followFrame = 0;
      if (c.closed || this.conn !== c) return;
      // Reaching the end manually is an explicit request to resume following.
      // If parsing a live packet made that impossible first, it was resolved
      // by commitFollowAtBottom() before the write instead.
      if (!this.commitFollowAtBottom(c)) c.followCandidate = false;
    });
  }
  refit() {
    if (this.conn?.replaySize) return;   // leaveReplayGeometry refits once the replay is parsed
    if (this.termEl.hidden || this.followPtySize(this.conn)) return;
    try { this.fit.fit(); } catch {}
    this.sendSize();
  }
  focusLimitedKeyboard() {
    const c = this.conn;
    if (!touch || !localMeshEffectsAllowed() || !c?.terminal?.limited || c.closed || c.ended
        || this.termEl.hidden) return false;
    if (directPasteWaits(this)) { flash(t("terminal.limitedKeyboardWaiting")); return false; }
    setActive(this);
    if (this.conn !== c) return false;
    c.liveKeyboard = true;   // focus intent only, never retained/deferred input authority
    this.term.textarea.setAttribute("inputmode", "text");
    this.term.focus();
    return true;
  }
  // Phones normally type in the input line; limited mode offers an explicit live keyboard.
  focus() {
    if (this.termEl.hidden) return;
    if (touch && !$("#line").hidden && !(this.conn?.liveKeyboard && this.conn.terminal?.limited)) $("#line-text").focus();
    else this.term.focus();
  }

  // Focus is an effect of a person choosing a live terminal, not of showing or
  // restoring one.  An attach hides xterm for its first fit, so retain that
  // narrow intent until it becomes focusable. On a phone the editable field
  // stays the target unless the person explicitly chose the limited live keyboard.
  focusSelectedTerminal() {
    const c = this.conn;
    if (!c || c.closed || this.id !== c.name || active !== this) return false;
    c.focusRequested = true;
    return this.applySelectedTerminalFocus(c);
  }
  applySelectedTerminalFocus(c) {
    if (!c?.focusRequested) return false;
    if (c.closed || this.conn !== c || this.id !== c.name || active !== this) {
      c.focusRequested = false;
      return false;
    }
    // A focused but connecting terminal drops input because there is no socket
    // to send it on yet.  Waiting for onopen keeps "ready to type" literal.
    if (!c.terminal?.isOpen()) return false;
    if (touch && !(c.liveKeyboard && c.terminal.limited)) {
      if ($("#line").hidden) return false;
      $("#line-text").focus();
    } else {
      if (this.termEl.hidden) return false;
      this.term.focus();
    }
    c.focusRequested = false;
    return true;
  }

  // Focus reports (mode ?1004) describe the pane, not xterm's helper textarea. Claude Code
  // ignores a click that arrives less than 400 ms after a focus-in (a "window activation
  // click"), and xterm focuses its textarea on mousedown just before it reports the click.
  // So a move between the textarea and the phone input line is not reported (the pane keeps
  // the focus), a focus-in caused by a press is sent once the button is released, and only
  // changes are reported. A report no focus event caused (xterm answering a program that
  // turns the mode on) passes as is.
  wireFocusReports() {
    const textarea = this.term.textarea;
    this.focusReported = null; this.focusCause = null; this.heldFocusIn = false; this.pressed = false;
    this.termEl.addEventListener("focus", (e) => { if (e.target === textarea) this.focusCause = { in: true }; }, true);
    this.termEl.addEventListener("blur", (e) => { if (e.target === textarea) this.focusCause = { in: false, to: e.relatedTarget }; }, true);
    // xterm's own listeners, added when the terminal was opened, have run: the cause is spent
    for (const type of ["focus", "blur"]) textarea.addEventListener(type, () => { this.focusCause = null; });
    const release = () => {
      window.removeEventListener("blur", abandon);
      this.pressed = false;
      setTimeout(() => {   // after xterm has reported the release
        if (!this.heldFocusIn) return;
        this.heldFocusIn = false;
        this.reportFocus(true);
      });
    };
    // The release went to another application: the press no longer holds focus reports back.
    // The textarea blurs with the window, so a held focus-in is withdrawn, not sent.
    const abandon = () => {
      window.removeEventListener("mouseup", release, true);
      this.pressed = false; this.heldFocusIn = false;
    };
    this.termEl.addEventListener("mousedown", () => {
      this.pressed = true;
      window.addEventListener("mouseup", release, { capture: true, once: true });
      window.addEventListener("blur", abandon, { once: true });
    }, true);
  }
  // true when xterm's focus report `d` must not reach the program
  filterFocusReport(d) {
    if (d !== "\x1b[I" && d !== "\x1b[O") return false;
    const cause = this.focusCause, focusIn = d === "\x1b[I";
    // A tap gives the focus back to the input line, possibly before the press is released:
    // the pane keeps the focus, so a focus-in held for that release still stands.
    if (cause && !focusIn && cause.to && cause.to === $("#line-text") && active === this) return true;
    this.heldFocusIn = false;
    if (!cause) { this.focusReported = focusIn; return false; }
    if (focusIn) {
      if (this.focusReported === true) return true;
      if (this.pressed) { this.heldFocusIn = true; return true; }
      this.focusReported = true;
      return false;
    }
    if (this.focusReported === false) return true;
    this.focusReported = false;
    return false;
  }
  // A focus change the textarea did not cause: the pane left while the phone input line had
  // the focus, or the browser window losing or regaining it while it had. The report is not
  // human input: it bypasses the input lease, so it never marks it dirty, and the state
  // changes only once the report is on the socket.
  reportFocus(focused) {
    if (this.focusReported === focused || !this.term.modes.sendFocusMode) return;
    if (!localMeshEffectsAllowed() || this.conn?.replaying || this.conn?.draining) return;
    const terminal = this.conn?.terminal;
    if (!terminal?.isOpen()) return;
    try {
      if (this.inputAck) {
        if (!this.sendRaw(enc.encode(focused ? "\x1b[I" : "\x1b[O"))) return;
      } else terminal.queueInput(enc.encode(focused ? "\x1b[I" : "\x1b[O"));
    } catch { return; }
    this.focusReported = focused;
  }

  // The document path or URL under a mouse event, from the visible buffer text.
  linkAt(e) {
    const t = this.term, box = $(".xterm-screen", this.termEl)?.getBoundingClientRect();
    if (!box || !box.width) return null;
    const col = Math.floor((e.clientX - box.left) / (box.width / t.cols));
    const row = Math.floor((e.clientY - box.top) / (box.height / t.rows));
    if (col < 0 || row < 0 || col >= t.cols || row >= t.rows) return null;
    const y = t.buffer.active.viewportY + row;
    const hit = terminalLinksOnRow(t.buffer.active, y, t.cols)
      .find((l) => MeshTerminalLinks.cellIn([y, col], l.start, l.end));
    return hit || null;
  }

  // The title of a tracker reference under the pointer (text only, from the cache of known ids), or none.
  showReferenceTitle(id) {
    const label = id ? referenceLabel(id) : "";
    if (label) this.termEl.title = label; else this.termEl.removeAttribute("title");
  }

  // Newline without submitting. Each TUI reads a different sequence:
  // claude takes Meta+Enter (ESC CR), codex takes Ctrl+J (LF).
  newlineSeq() { return find(this.id)?.agent?.type === "codex" ? "\n" : "\x1b\r"; }

  async copySelection() {
    const sel = this.term.getSelection() || this.mobileSelection;
    if (!sel) return;
    try { await navigator.clipboard.writeText(this.clipboardText(sel)); flash(t("clipboard.copied")); } catch { flash(t("clipboard.copyDenied")); }
    this.term.clearSelection();
    this.mobileSelection = "";
  }
  // What the usual copies write: the text, or its "copy as shell command" form when the per-device
  // preference "copyAsShell" (off by default) is on. The rewrite is MeshTerminalLinks.copiedText.
  clipboardText(text) {
    const { copiedText, copyAsShellEnabled, COPY_AS_SHELL_KEY } = MeshTerminalLinks;
    return copiedText(this.term, text, copyAsShellEnabled(store.get(COPY_AS_SHELL_KEY, false)));
  }
  // Copy on select (per-device preference "copyOnSelect", on by default). Unlike copySelection() this
  // keeps the selection, and a refusal by the browser shows one notice per page, not one per selection.
  // One named handler per pane: a press arms it, the release (or a blur / hidden page / disposal,
  // as in wireFocusReports) disarms it, so a missed mouseup never stacks a second listener.
  // A double click waits one multi-click window so a triple click writes the clipboard once.
  wireCopyOnSelect() {
    let forced = false, timer = 0;
    const release = (e) => {
      window.removeEventListener("mouseup", release, true);
      window.removeEventListener("blur", abandon);
      document.removeEventListener("visibilitychange", abandon);
      // after xterm has finished the selection of this release
      timer = setTimeout(() => { timer = 0; this.copyOnSelect(forced); }, MeshTerminalLinks.copyOnSelectDelay(e.detail));
    };
    const abandon = () => {
      window.removeEventListener("mouseup", release, true);
      window.removeEventListener("blur", abandon);
      document.removeEventListener("visibilitychange", abandon);
      clearTimeout(timer); timer = 0;
    };
    this.abandonCopyOnSelect = abandon;
    this.termEl.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      abandon();   // a still-pending copy of the previous click is superseded
      const bar = e.target;
      // a press on the scrollbar selects nothing: no copy
      if (bar.classList?.contains("xterm-viewport") && e.offsetX >= bar.clientWidth) return;
      forced = MeshTerminalLinks.forcesSelection(e, shortcutPlatform);   // forces a selection past mouse tracking
      window.addEventListener("mouseup", release, true);
      window.addEventListener("blur", abandon);
      document.addEventListener("visibilitychange", abandon);
    }, true);
  }
  async copyOnSelect(forced, touchText) {
    if (this.actionDisposed) return;   // the pane was closed since the press: its terminal is gone
    const text = touchText ?? this.term.getSelection();
    const { copyOnSelectEnabled, shouldCopyOnSelect, COPY_ON_SELECT_KEY } = MeshTerminalLinks;
    if (!shouldCopyOnSelect({
      enabled: copyOnSelectEnabled(store.get(COPY_ON_SELECT_KEY, true)), selection: text, forced,
      visible: document.visibilityState === "visible" && this.termEl.getClientRects().length > 0,
      mouseTracking: this.term.modes.mouseTrackingMode !== "none",
    })) return;
    try { await navigator.clipboard.writeText(this.clipboardText(text)); } catch {
      if (!copyOnSelectDenied) { copyOnSelectDenied = true; flash(t("clipboard.copyDenied")); }
    }
  }
  async pasteClipboard() {
    const c = this.conn, terminal = c?.terminal, socket = c?.ws, view = this.actionView;
    const term = this.term, name = c?.name, created = c?.created;
    const current = () => c && !c.closed && !c.ended && this.conn === c && c.terminal === terminal
      && c.ws === socket && c.name === name && c.created === created && this.id === name
      && this.term === term && this.actionView === view && !this.actionDisposed
      && !this.termEl.hidden && this.termEl.getClientRects().length > 0
      && localMeshEffectsAllowed() && terminal?.isBound(name, created);
    if (!terminal?.isBound(name, created)) { flash(t("terminal.limitedInput")); return; }
    if (!current()) return;
    observePaneActions(this);
    const target = paneTargets.capture(this);
    if (!target) return;
    const binding = paneInput.capture(this, target, current);
    if (!binding) { paneTargets.release(target); return; }
    try {
      // Reserve before awaiting the browser: later keys stay behind this paste,
      // including when replay starts while the clipboard permission is pending.
      const text = navigator.clipboard.readText();
      await new Promise((done) => {
        paneInput.deliver(binding, text, false, (result) => {
          paneTargets.release(target);
          if (result.reason === "paste") flash(t("clipboard.pasteDenied"));
          done();
        });
      });
    }
    catch { paneTargets.release(target); flash(t("clipboard.pasteDenied")); }
  }
  filesIn(files) {
    if (!files.length) return;
    const destination = captureTerminalDestination(this);
    if (!destination) { flash(t("upload.destinationUnavailable")); return; }
    beginUpload(files, destination);
  }

  // A reloaded Markdown page starts at the top: hand it back the position it last reported.
  restoreScroll() {
    const w = this.id && find(this.id);
    if (w?.keepsScroll && w.scrollY > 0) $(".web", this.el).contentWindow?.postMessage({ smesh: "scrollto", y: w.scrollY }, "*");
  }

  // Follow (or stop following) the file: reloaded when it changes. The choice is
  // also the default for documents opened next (per browser).
  async toggleWatch() {
    const w = find(this.id);
    if (!w || w.type !== "file") return;
    await setWatch(w, !w.watch);
    store.set("watchDefault", w.watch);
    this.header();
    flash(w.watch ? t("web.watchOn") : t("web.watchOff"));
  }

  // /view URLs expire: reload with a freshly signed one
  async reloadWeb(target = null) {
    if (target && !paneTargets.valid(target)) return;
    const w = find(this.id);
    if (w?.kind === "board") {
      loadFrame($(".web", this.el), `/static/board.html?v=${encodeURIComponent(loadedVersion)}&session=${encodeURIComponent(w.session)}`);
      return;
    }
    const plain = w && (await describeWeb(w.target));
    const d = plain && w.source ? sourceEntry(plain) : plain;
    if (!d || this.id !== d.id || (target && !paneTargets.valid(target))) return;
    const f = $(".web", this.el);
    loadFrame(f, viewUrl(d));   // a re-signed code page keeps its line
  }

  swipeToWheel() {
    const term = this.term, screen = () => $(".xterm-screen", this.termEl);
    let x0 = 0, y0 = 0, lastY = null, lastT = 0, x = 0, y = 0, acc = 0, vel = 0, glide = 0, pending = 0, pump = 0, dropTouchTail = false;
    let longPress = 0, selection = null, moved = false;
    // xterm is canvas-rendered, so Android cannot select its glyphs natively.
    // Map a deliberate touch gesture to xterm's public selection API instead.
    // `row` is an absolute buffer row, as required by Terminal.select().
    const cellAt = (p, needsText = true) => {
      const box = screen()?.getBoundingClientRect();
      if (!box?.width || !box.height) return null;
      const col = Math.max(0, Math.min(term.cols - 1, Math.floor((p.clientX - box.left) / (box.width / term.cols))));
      const visualRow = Math.floor((p.clientY - box.top) / (box.height / term.rows));
      if (visualRow < 0 || visualRow >= term.rows) return null;
      const row = term.buffer.active.viewportY + visualRow, line = term.buffer.active.getLine(row);
      if (!line || (needsText && !line.getCell(col)?.getChars()?.trim())) return null; // long-press only real text, never empty canvas
      return { col, row };
    };
    const selectWord = ({ col, row }) => {
      const line = term.buffer.active.getLine(row);
      let start = col, end = col + 1;
      // Cell access preserves terminal columns (unlike JavaScript string indexes).
      while (start > 0 && line?.getCell(start - 1)?.getChars()?.trim()) start--;
      while (end < term.cols && line?.getCell(end)?.getChars()?.trim()) end++;
      term.select(start, row, Math.max(1, end - start));
    };
    const selectRange = (from, to) => {
      const a = from.row * term.cols + from.col, b = to.row * term.cols + to.col;
      const start = Math.min(a, b), end = Math.max(a, b);
      term.select(start % term.cols, Math.floor(start / term.cols), end - start + 1);
    };
    const clearLongPress = () => { clearTimeout(longPress); longPress = 0; };
    const step = () => SWIPE_ROWS * screen().clientHeight / term.rows;
    // Keep the queued distance from a fast drag without flooding a TUI with
    // all its wheel events in one task. Four per frame drains the bound in
    // about 400 ms at 60 Hz; a new touch still cancels the remainder.
    const send = () => {
      const n = Math.min(Math.abs(pending), Math.abs(pending) > 4 ? 4 : 1), dir = Math.sign(pending), px = step();
      for (let i = 0; i < n; i++)
        screen().dispatchEvent(new WheelEvent("wheel", { deltaY: dir * px, deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          clientX: x, clientY: y, bubbles: true, cancelable: true }));
      pending -= dir * n;
      pump = pending ? requestAnimationFrame(send) : 0;
    };
    const feed = (dy) => {   // dy > 0: towards the end of the output
      if (dy === 0) return;  // no movement is not a new history-reading intent
      acc += dy;
      const piWheel = this.conn?.piFullscreenScroll && hasFullscreenScrollRecovery(this.id && find(this.id))
        && term.modes.mouseTrackingMode !== "none";
      if (term.buffer.active.type === "normal" && !piWheel) {   // the scrollback is here, whatever the program tracks: scroll it at once,
        this.noteUserScroll(dy > 0);
        this.holdOutput();   // (xterm re-syncs the viewport on every write: let the output wait)
        const px = Math.trunc(acc), vp = $(".xterm-viewport", this.termEl);   // to the pixel, like the
        if (px && vp) {
          acc -= px;
          // xterm updates buffer.viewportY from the native scroll event, not
          // synchronously with scrollTop.  If this actual finger movement
          // reaches the native end, commit that intent before a touchend/live
          // packet can advance baseY in the gap.
          const end = vp.scrollHeight - vp.clientHeight;
          if (px > 0 && vp.scrollTop + px >= end - 1) this.resumeFollowing();
          vp.scrollTop += px;
        }   // native viewport at the right edge (xterm follows its scroll event)
        return;
      }
      const px = step(), n = Math.trunc(acc / px);
      if (!n) return;
      acc -= n * px;
      // A change of direction drops what is queued. Bound an exceptionally
      // large drag, but preserve the ordinary fast flick that exceeded 15.
      pending = Math.sign(pending) === -Math.sign(n) ? n : Math.max(-SWIPE_QUEUE, Math.min(SWIPE_QUEUE, pending + n));
      if (!pump) pump = requestAnimationFrame(send);
    };
    const stop = () => {
      cancelAnimationFrame(glide);
      glide = 0;
      vel = 0;
      pending = 0;
      // A button click can win the page task before Chromium delivers the
      // terminal's final touch events.  Those events belong to the gesture we
      // just cancelled; do not let them measure a new velocity or arm a glide.
      lastY = null;
      acc = 0;
      dropTouchTail = true;
    };
    this.stopGlide = stop;
    this.termEl.addEventListener("touchstart", (e) => {
      stop();
      dropTouchTail = false;  // this starts a new gesture, not the cancelled tail
      clearLongPress();
      selection = null;
      moved = false;
      this.mobileSelection = "";
      this.releaseOutput();   // a tap holds nothing; a swipe holds again from its first move
      pending = 0;   // a touch stops the scrolling
      lastY = e.touches.length === 1 ? e.touches[0].clientY : null;
      x0 = e.touches[0]?.clientX; y0 = e.touches[0]?.clientY;
      lastT = e.timeStamp; acc = 0; vel = 0;
      const start = e.touches.length === 1 && cellAt(e.touches[0]);
      if (start) longPress = setTimeout(() => {
        longPress = 0;
        if (lastY === null) return;
        selection = start;
        selectWord(start);
        this.mobileSelection = term.getSelection();
        flash(t("terminal.textSelected"));
      }, LONG_PRESS_MS);
    // Initialise before xterm's inner screen/text handlers can stop bubbling.
    // touchmove is already captured; otherwise it sees no start and drops the swipe.
    }, { passive: true, capture: true });
    this.termEl.addEventListener("touchmove", (e) => {
      if (lastY === null || e.touches.length !== 1) {
        if (dropTouchTail && e.touches.length === 1) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
        return;
      }
      const p = e.touches[0];
      if (selection) {
        e.preventDefault();
        e.stopPropagation();
        const end = cellAt(p, false);
        if (end) {
          selectRange(selection, end);
          this.mobileSelection = term.getSelection();
        }
        return;
      }
      // A finger settles by a few pixels before a tap.  It must neither hold
      // output nor cancel a fresh attachment's final anchor: only a real
      // gesture, beyond the same slop used for long-press selection, owns the
      // terminal viewport.  Keep lastY at the initial point so that first
      // accepted move still contains the whole intended distance.
      if (!moved) {
        if (Math.hypot(p.clientX - x0, p.clientY - y0) <= TOUCH_SLOP_PX) return;
        moved = true;
        clearLongPress();
      }
      e.preventDefault();
      e.stopPropagation();   // xterm's own touch scrolling has no glide: ours replaces it
      const dy = lastY - p.clientY, dt = Math.max(1, e.timeStamp - lastT);
      vel = 0.8 * (dy / dt) + 0.2 * vel;   // px/ms, smoothed
      lastY = p.clientY; lastT = e.timeStamp; x = p.clientX; y = p.clientY;
      feed(dy * swipeGain(vel));
    }, { passive: false, capture: true });
    this.termEl.addEventListener("touchend", (e) => {
      if (lastY === null && dropTouchTail) {
        clearLongPress();
        e.preventDefault();
        e.stopImmediatePropagation();
        dropTouchTail = false;
        this.releaseOutput();
        return;
      }
      clearLongPress();
      if (selection) {
        e.preventDefault();
        e.stopPropagation();
        selection = null;
        lastY = null;
        this.releaseOutput();
        this.copyOnSelect(true, this.mobileSelection);   // once, when the finger lifts
        return;
      }
      const p = e.changedTouches[0];
      if (touch && p && !moved && Math.hypot(p.clientX - x0, p.clientY - y0) <= TOUCH_SLOP_PX && !$("#line").hidden) {
        // a tap: the keyboard, in the input line. The browser then synthesizes mouse events,
        // and xterm's mousedown focuses its own textarea: take the focus back after that click
        const toLine = () => $("#line-text").focus(), at = performance.now();
        setTimeout(toLine);
        this.termEl.addEventListener("click", () => { if (performance.now() - at < 800) setTimeout(toLine); },
                                     { once: true, capture: true });
      }
      if (lastY === null || Math.abs(vel) < 0.2) { this.releaseOutput(); return; }
      lastY = null;
      let prev = performance.now();
      vel *= swipeGain(vel);
      const tick = (now) => {
        const dt = now - prev;
        if (dt > 0) {
          prev = now;
          feed(vel * dt);
          vel *= Math.pow(SWIPE_DECAY, dt);
        }
        glide = Math.abs(vel) > 0.02 ? requestAnimationFrame(tick) : 0;
        if (!glide) this.releaseOutput();
      };
      glide = requestAnimationFrame(tick);
    }, { passive: false, capture: true });
    this.termEl.addEventListener("touchcancel", () => { clearLongPress(); selection = null; stop(); this.releaseOutput(); }, { passive: true });
  }

  // The "↓" button: shown (class `on`) while the normal buffer is scrolled away from its
  // end. Refreshed once per frame on scroll, parsed writes, buffer switches and the native
  // viewport's scroll event; nothing polls.
  wireToBottom() {
    const t = this.term, button = $(".to-bottom", this.el);
    let frame = 0;
    const refresh = () => {
      frame = 0;
      const b = t.buffer.active;
      button.classList.toggle("on", b.type === "normal" && b.viewportY < b.baseY);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(refresh); };
    t.onScroll(() => { schedule(); this.commitFollowAtBottom(); });
    t.onWriteParsed(() => {
      this.restoreReaderViewport();
      // A forced live follow updates xterm synchronously.  Do not leave an
      // actionable down-arrow visible until the pending paint frame: callers
      // can observe the new logical position in that same task.
      if (this.followLiveOutput()) {
        if (frame) cancelAnimationFrame(frame);
        refresh();
      } else schedule();
    });
    t.buffer.onBufferChange(schedule);
    const viewport = $(".xterm-viewport", this.termEl);
    let scrollbarGesture = false;
    viewport?.addEventListener("scroll", () => {
      schedule();
      const c = this.conn, b = t.buffer.active;
      // scrollToBottom moves xterm's logical viewport synchronously, whereas
      // the DOM viewport can still deliver an older scrollTop on a later
      // frame. Retain only an explicit button jump until the native viewport
      // has acknowledged its bottom position. A later real gesture clears
      // bottomSync in noteUserScroll(), so this never pins history readers.
      if (c?.bottomSync) {
        if (!c.followOutput || b.type !== "normal") c.bottomSync = false;
        else if (b.viewportY < b.baseY) t.scrollToBottom();
        else if (viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - 1) c.bottomSync = false;
      }
      if (scrollbarGesture) this.noteUserScroll(true);
    }, { passive: true });
    // A wheel is a history gesture. The viewport's own pointerdown is the
    // scrollbar track/thumb, not a terminal click; both can intentionally
    // leave the bottom and both can return to it.
    this.termEl.addEventListener("wheel", (e) => this.noteUserScroll(e.deltaY > 0), { passive: true, capture: true });
    viewport?.addEventListener("pointerdown", () => { scrollbarGesture = true; this.noteUserScroll(); }, { passive: true });
    viewport?.addEventListener("pointerup", () => { scrollbarGesture = false; }, { passive: true });
    viewport?.addEventListener("pointercancel", () => { scrollbarGesture = false; }, { passive: true });
    this.termEl.addEventListener("keydown", (e) => {
      if (["PageUp", "Home"].includes(e.key)) this.noteUserScroll();
      else if (["PageDown", "End"].includes(e.key)) this.noteUserScroll(true);
    }, { capture: true });
    button.addEventListener("click", () => {
      this.stopGlide?.();     // a glide in progress would carry on scrolling up
      if (this.conn) {
        this.conn.followCandidate = false;
        this.conn.followOutput = true;
        this.conn.bottomSync = true;
        if (this.conn.followFrame) cancelAnimationFrame(this.conn.followFrame);
        this.conn.followFrame = 0;
      }
      this.releaseOutput();   // output held for a finger is written now, in order
      t.scrollToBottom();
      refresh();
    });
  }

  // Terminal output goes through here. While a finger scrolls the text (and the
  // glide after it), xterm would re-sync the viewport to whole rows on each write
  // and undo the pixel scrolling: the bytes wait, in order, and are written when
  // the gesture ends, and at least every HOLD_MS (or HOLD_BYTES) during a long one.
  // `done` runs once xterm has parsed these bytes.
  output(bytes, done) {
    this.inputOrigin?.tag(bytes, {connection: this.conn, terminal: this.conn?.terminal, view: this.actionView});
    this.commitFollowAtBottom();
    if (!this.holdTimer) {
      this.preserveReaderViewport();
      return this.term.write(bytes, done);
    }
    this.queuedOutput.push([bytes, done]);
    this.queuedBytes += bytes.length;
    if (this.queuedBytes >= HOLD_BYTES) this.flushOutput();
  }
  holdOutput() {
    if (!this.holdTimer) this.holdTimer = setInterval(() => this.flushOutput(), HOLD_MS);
  }
  releaseOutput() {
    clearInterval(this.holdTimer);
    this.holdTimer = 0;
    this.flushOutput();
  }
  flushOutput() {
    const chunks = this.queuedOutput;
    this.queuedOutput = [];
    this.queuedBytes = 0;
    if (chunks.length) {
      this.commitFollowAtBottom();
      this.preserveReaderViewport();
    }
    for (const [chunk, done] of chunks) this.term.write(chunk, done);
  }

  // ---- what the pane shows
  invalidateActionView() {
    if (isContextualDiffPane(this.id)) {
      portfolioDiffs.get(this.id)?.lifetime.dispose();
      portfolioDiffs.delete(this.id);
    }
    this.actionView++;
    paneTargets.invalidatePane(this);
    this.paneMenu?.close("invalidate");
  }

  show(id, force = false, opts = {}) {
    if (!localMeshEffectsAllowed()) return;
    if (this === active && this.id !== id) saveRecoveredLine();
    if (isHist(id)) return this.showHist(id, force);
    const s = find(id);
    if (!s) return;
    this.cachedTerminalMoveBlockedId = null;
    const frame = $(".web", this.el);
    const src = s.kind === "board" ? `/static/board.html?v=${encodeURIComponent(loadedVersion)}&session=${encodeURIComponent(s.session)}`
      : s.kind === "demo" ? s.demoId === "legacy"
        ? `/demo-scene/${encodeURIComponent(s.name)}/${s.version}?created=${encodeURIComponent(s.created)}`
        : `/demo-scene/${encodeURIComponent(s.name)}/${encodeURIComponent(s.demoId)}/${s.version}?created=${encodeURIComponent(s.created)}`
      : s.kind === "web" ? viewUrl(s) : null;
    if (force || this.id !== id || this.actionKind !== s.kind
        || (src !== null && frame.dataset.src !== src)) this.invalidateActionView();
    this.actionKind = s.kind;
    if (this.id !== id) leaveSeen(this.id);
    if (this.id !== id && !opts.fromBack) this.remember(id);
    this.id = id;
    see([id]);
    this.hist = null;
    $(".empty", this.el).hidden = true;
    if (s.kind === "web" || s.kind === "board" || s.kind === "demo") {
      this.detach();
      this.termEl.hidden = true;
      $(".detail", this.el).hidden = true;
      // The server describes a frame's sandbox from the same policy that emits
      // its response CSP. Only its explicit "inert" answer (PDF and image
      // viewers) leaves a document unsandboxed: a missing or malformed value
      // gets the strictest sandbox, never none.
      if (s.kind === "board" || (s.kind === "web" && s.inert === true)) frame.removeAttribute("sandbox");
      else frame.setAttribute("sandbox", typeof s.sandbox === "string" ? s.sandbox : "");
      if (force || frame.dataset.src !== src) loadFrame(frame, src, true);
      frame.hidden = false;
    } else {
      this.unloadFrame();
    }
    $(".demo-offer", this.el).hidden = s.kind !== "demo" || s.offeredVersion === null;
    if (s.kind === "demo") $(".demo-offer span", this.el).textContent = t("demo.offer", { offered: s.offeredVersion, version: s.version });
    $(".demo-tools", this.el).hidden = s.kind !== "demo";
    if (s.kind === "demo") renderDemoSelector(this, s);
    if (s.kind === "web" || s.kind === "board" || s.kind === "demo") {
      // nothing else to set up
    } else if (s.kind === "contextual-diff") {
      this.detach();
      this.termEl.hidden = true;
      $(".detail", this.el).hidden = false;
      renderContextualDiff(this, s);
    } else if (s.kind === "mesh") {
      $(".detail", this.el).hidden = true;
      if (this.conn?.name !== id) this.attach(id, opts);
    } else {
      this.detach();
      this.termEl.hidden = true;
      $(".detail", this.el).hidden = false;
      this.renderDetail(s);
    }
    this.header();
    saveLayout();
    renderLists();
    if (opts.focusTerminal) this.focusSelectedTerminal();
  }

  // a pane leaving a document unloads it: hidden, it would keep running (and
  // show through a card's transparent background)
  unloadFrame() {
    const frame = $(".web", this.el);
    this.resetFrameHistory();
    frame.hidden = true;
    frame.removeAttribute("src");
    delete frame.dataset.src;
    delete frame.dataset.token;
  }

  // a past session: its card, fetched with the long fields (summary…)
  async showHist(id, force = false) {
    if (localActionUnavailable()) return;
    if (force || this.id !== id || this.actionKind !== "history") this.invalidateActionView();
    this.actionKind = "history";
    if (this.id !== id) leaveSeen(this.id);
    if (this.id !== id) this.remember(id);
    this.id = id;
    this.detach();
    this.unloadFrame();
    this.termEl.hidden = true;
    $(".empty", this.el).hidden = true;
    const box = $(".detail", this.el);
    box.hidden = false;
    if (this.hist?.key !== id) {
      const request = this.hist = { key: id, d: hist.by.get(id) || null };
      box.innerHTML = `<div class="card hist"><p class="mute">${esc(t("hist.loading"))}</p></div>`;
      this.header();
      saveLayout();
      renderLists();
      const [, agent, sid] = id.split(":");
      let d, error;
      try {
        const r = await requestLocal(`/api/history/${agent}/${encodeURIComponent(sid)}`);
        if (r.ok) d = await r.json();
        else error = serverText(await r.text()) || t("hist.loadFailedHttp", { status: r.status });
      } catch (e) { error = t("hist.loadFailed", { error: e.message }); }
      if (this.id !== id || this.hist !== request) return;
      if (error) {
        this.hist = null;   // failed details are retryable, not a cached summary
        box.innerHTML = `<div class="card hist"><p class="mute">${esc(error)}</p></div>`;
        return;
      }
      this.hist.d = d;
    }
    this.renderHist();
    this.header();
  }

  renderHist() {
    const d = this.hist?.d;
    if (!d) return;
    const live = liveOf(d.id, d.agent);
    this.hist.live = live?.id || null;
    $(".detail", this.el).innerHTML = histCardHtml(d, live);
  }

  clear(persist = true) {
    if (this === active) saveRecoveredLine();
    this.invalidateActionView();
    this.cachedTerminalMoveBlockedId = null;
    this.actionKind = "empty";
    leaveSeen(this.id);
    this.back = null;
    this.webBack = [];
    this.resetFrameHistory();
    this.id = null;
    this.layoutTarget = null;
    this.layoutType = null;
    this.hist = null;
    this.detach();
    this.termEl.hidden = true;
    const frame = $(".web", this.el);
    frame.hidden = true; frame.removeAttribute("src"); delete frame.dataset.src; delete frame.dataset.token;
    $(".detail", this.el).hidden = true;
    const empty = $(".empty", this.el);
    empty.innerHTML = this.defaultEmptyHtml;
    empty.hidden = false;
    this.header();
    if (persist) saveLayout();
  }

  // A persisted layout is never authority to recreate its target. Preserve the
  // visual slot and make its absence explicit instead of resuming a process.
  showUnavailable(reason, target = null, type = "terminal") {
    this.clear(false);
    this.layoutTarget = typeof target === "string" ? target : null;
    this.layoutType = type;
    const text = reason === "unknown-type" ? t("pane.unavailable.unknownType")
      : reason === "ephemeral-pane" ? t("pane.unavailable.ephemeral")
        : t("pane.unavailable.gone");
    $(".empty", this.el).innerHTML = `<p>${esc(text)}</p><p class="mute">${esc(t("pane.unavailable.layoutKept"))}</p>`;
    this.header();
  }

  header() {
    const s = this.id && find(this.id);
    const isWeb = s?.kind === "web";
    const isBoard = s?.kind === "board";
    const isDemo = s?.kind === "demo";
    const isContext = s?.kind === "contextual-diff";
    const h = !s && this.hist?.d;
    const mesh = s?.kind === "mesh" || (!s && this.actionKind === "mesh" && !!paneTargets.identity(this.id));
    const title = s ? (isDemo ? t("pane.title.demo", { session: label(find(s.session) || s), version: s.version }) : isBoard ? t("pane.title.board", { session: label(find(s.session) || s) }) : isWeb ? webLabel(s) : label(s)) : h ? histTitle(h) : paneTargets.identity(this.id)?.name || "—";
    this.panelIdentity = MeshPaneActions.identityPresentation({
      kind: isBoard ? "board" : isDemo ? "demo" : isWeb ? "document" : h || isContext ? "diff" : mesh ? "terminal" : "unknown",
      title,
      origin: !localMeshEffectsAllowed() ? "unknown"
        : (isWeb || mesh || isBoard || isDemo || h || isContext) ? "local" : "unknown",
      sessionLabel: isContext ? s.binding.name : (isBoard || isDemo) ? (find(s.session) ? label(find(s.session)) : null) : mesh && s ? label(s) : null,
      readOnly: !localMeshEffectsAllowed() || !!h || isContext || isDemo,
      load: (!s && !h) || ((isBoard || isDemo) && !find(s.session)) ? "unavailable" : isWeb || isBoard || isDemo ? this.identityLoad || "unknown" : "unknown",
    });
    const identityBody = $(".p-provenance-body", this.el);
    identityBody.replaceChildren(...Object.values(this.panelIdentity).map((text) => {
      const line = document.createElement("div"); line.textContent = text; return line;
    }));
    if (mesh && s && typeof s.name === "string") {
      const name = document.createElement("div");
      name.textContent = `${t("pane.meshSessionName", { name: s.name })} `;
      const copy = document.createElement("button");
      copy.type = "button"; copy.textContent = t("common.copy");
      copy.setAttribute("aria-label", t("pane.copySessionNameLabel"));
      copy.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(s.name); flash(t("pane.sessionNameCopied")); }
        catch { flash(t("pane.copyRefused")); }
      });
      name.append(copy); identityBody.append(name);
    }
    const disclosure = $(".p-provenance", this.el);
    disclosure.onkeydown = (event) => {
      if (event.key === "Escape" && disclosure.open) {
        event.stopPropagation(); disclosure.open = false; $("summary", disclosure).focus();
      }
    };
    this.paneHeader.update({
      name: title,
      cwd: s ? short((isWeb || isBoard || isDemo) ? s.target : s.cwd) : h ? t("pane.historyCwd", { cwd: short(h.cwd) }) : "",
      terminal: mesh,
      agentStatus: typeof s?.agent?.status === "string" ? s.agent.status : null,
      unread: !!(mesh && s && lastSeen(s) > (seen[s.id] ?? seenSince ?? Infinity) + 1),
      boardModified: !!(mesh && boardModified.has(this.id)),
    });
    const badge = $(".p-account", this.el);
    showAccountBadge(badge, mesh ? s : null);
    const authority = !!(mesh && rowAuthoritative(s) && localMeshEffectsAllowed());
    badge.disabled = !MeshPaneActions.switchSource(s, authority)
      && !(authority && accountSwitchPicker.hasReceipt(s));
    badge.setAttribute("aria-label", t("accountSwitch.open", { account: badge.textContent }));
    // Only a session launched as a messaging agent has a mailbox; a plain shell does not.
    $('[data-act="compose"]', this.el).hidden = !mesh || !localMeshEffectsAllowed() || !MeshPaneActions.hasMailbox(s);
    $('[data-act="compose"]', this.el).disabled = !localMeshEffectsAllowed();
    this.renderMailboxBadge(mesh && s ? s : null);
    this.renderQuestionsButton(mesh && s && localMeshEffectsAllowed() ? s : null);
    $('[data-act="board"]', this.el).hidden = !mesh || !localMeshEffectsAllowed();
    // External/history/empty retain direct local close; Mesh/documents use Plus.
    $('[data-act="close"]', this.el).hidden = panes.length < 2 || mesh || isWeb || isBoard || isDemo;
    const webBack = isWeb && this.nextWebBack();
    const frameBack = isWeb && this.frameHistoryDepth > 0;
    const back = this.back && find(this.back);
    const backBtn = $('[data-act="back"]', this.el);
    backBtn.hidden = !(frameBack || webBack || back);
    backBtn.disabled = this.frameBackPending;
    if (frameBack) {
      backBtn.textContent = t("pane.back.previous");
      backBtn.title = t("pane.back.previousTitle");
      backBtn.setAttribute("aria-label", t("pane.back.previousTitle"));
    } else if (webBack) {
      backBtn.textContent = `← ${webLabel(webBack)}`;
      backBtn.title = t("pane.back.to", { name: webLabel(webBack) });
      backBtn.setAttribute("aria-label", t("pane.back.to", { name: webLabel(webBack) }));
    } else if (back) {
      backBtn.textContent = `← ${label(back)}`;
      backBtn.title = t("pane.back.to", { name: label(back) });
      backBtn.setAttribute("aria-label", t("pane.back.to", { name: label(back) }));
    }
    if (this === active) syncMobileRawScrollAction();
    observePaneActions(this);
    this.paneMenu.refresh();
    this.group?.render();
    renderDictationBadges(this);
  }

  // A pane reused for a document retains the preceding Mesh view. This matters
  // on a phone, but is also needed on desktop once all adjacent panes are used.
  remember(nextId) {
    const leaving = this.id && find(this.id);
    const next = nextId && find(nextId);
    const nextIsSession = nextId && !isAdjacentPane(nextId) && !isHist(nextId);
    if (leaving?.kind === "web" && next?.kind === "web" && leaving.id !== next.id) {
      this.webBack.push(leaving.id);
    }
    if (nextIsSession) { this.back = null; this.webBack = []; }
    else if (leaving && leaving.kind !== "web") this.back = this.id;
  }

  nextWebBack() {
    while (this.webBack.length && !find(this.webBack[this.webBack.length - 1])) this.webBack.pop();
    return this.webBack[this.webBack.length - 1] && find(this.webBack[this.webBack.length - 1]);
  }

  resetFrameHistory() {
    clearTimeout(this.frameBackTimer);
    clearTimeout(this.frameNavigationTimer);
    this.frameBackTimer = 0;
    this.frameNavigationTimer = 0;
    this.frameBackPending = false;
    this.frameBackLoaded = false;
    this.frameBackReady = false;
    this.frameHistoryDepth = 0;
    this.frameNavigation = null;
    this.frameLoadSerial = 0;
    this.frameInitialReady = false;
  }

  frameLoaded() {
    this.identityLoad = "frame-loaded";
    if (this.actionKind === "web" || this.actionKind === "board" || this.actionKind === "demo") this.invalidateActionView();
    this.restoreScroll();
    this.frameLoadSerial++;
    if (this.frameNavigation?.continued
        && this.frameNavigation.loadSerial < this.frameLoadSerial) this.frameNavigation.loaded = true;
    this.finishFrameNavigation();
    if (this.frameBackPending) {
      this.frameBackLoaded = true;
      this.finishFrameBack();
    }
    this.maybeContinueFrameNavigation($(".web", this.el));
    this.header();
  }

  observeFrameNavigation(href, navigation, frame) {
    if (this.frameBackPending) return;
    this.invalidateActionView();
    clearTimeout(this.frameNavigationTimer);
    const observed = { href, navigation, continued: false, loaded: false, ready: false, loadSerial: 0 };
    this.frameNavigation = observed;
    this.frameNavigationTimer = setTimeout(() => {
      if (this.frameNavigation === observed) this.frameNavigation = null;
    }, FRAME_NAVIGATION_TIMEOUT_MS);
    this.maybeContinueFrameNavigation(frame);
  }

  // A document can receive a user click before the outer iframe has emitted
  // load. Hold that click's validated intent until both sides have observed
  // the initial page, then ask the bridge to navigate. The next iframe load
  // is therefore unambiguously the one that enables Previous.
  maybeContinueFrameNavigation(frame) {
    const navigation = this.frameNavigation;
    if (!navigation || navigation.continued || !this.frameInitialReady || !this.frameLoadSerial
        || !frame.contentWindow) return;
    navigation.continued = true;
    navigation.loadSerial = this.frameLoadSerial;
    frame.contentWindow.postMessage({ smesh: "frame-history-continue", token: frame.dataset.token,
                                      url: navigation.href, navigation: navigation.navigation }, "*");
  }

  finishFrameNavigation() {
    const navigation = this.frameNavigation;
    if (!navigation?.continued || !navigation.loaded || !navigation.ready) return;
    clearTimeout(this.frameNavigationTimer);
    this.frameNavigationTimer = 0;
    this.frameNavigation = null;
    this.frameHistoryDepth++;
    this.header();
  }

  acceptFrameReady(href) {
    const frame = $(".web", this.el);
    const acknowledge = () => frame.contentWindow?.postMessage(
      { smesh: "frame-history-ack", token: frame.dataset.token }, "*");
    acknowledge();
    if (this.frameBackPending) {
      this.frameBackReady = true;
      this.finishFrameBack();
      return;
    }
    if (href === new URL(frame.src, location.href).href) {
      this.frameInitialReady = true;
      this.maybeContinueFrameNavigation(frame);
      return;
    }
    const navigation = this.frameNavigation;
    // A bridge now runs before author HTML, so ready can precede the iframe
    // load. Remember it rather than consuming it only after the load event:
    // the matching observed load and ready are both required for Previous.
    if (!navigation?.continued || navigation.href !== href) return;
    navigation.ready = true;
    this.finishFrameNavigation();
  }

  finishFrameBack() {
    if (!this.frameBackPending || !this.frameBackLoaded || !this.frameBackReady) return;
    clearTimeout(this.frameBackTimer);
    this.frameBackTimer = 0;
    this.frameBackPending = false;
    this.frameBackLoaded = false;
    this.frameBackReady = false;
    this.header();
  }

  goBack() {
    if (this.frameBackPending) return;
    const web = this.id && find(this.id);
    if (web?.kind === "web" && this.frameHistoryDepth > 0) {
      this.invalidateActionView();
      const frame = $(".web", this.el), token = frame.dataset.token;
      if (!token) return;
      this.frameHistoryDepth--;
      this.frameBackPending = true;
      this.frameBackLoaded = false;
      this.frameBackReady = false;
      clearTimeout(this.frameBackTimer);
      frame.contentWindow?.postMessage({ smesh: "frame-history-back", token }, "*");
      // A local HTML page with the bridge acknowledges on pageshow. A page
      // that navigated away (or blocked the bridge) still returns to the Mesh
      // document instead of trapping the user in its frame.
      this.frameBackTimer = setTimeout(() => {
        if (!this.frameBackPending) return;
        this.resetFrameHistory();
        const src = frame.dataset.src;
        if (src) loadFrame(frame, src);
        this.header();
      }, FRAME_BACK_TIMEOUT_MS);
      this.header();
      return;
    }
    const previous = web?.kind === "web" && this.nextWebBack();
    if (previous) {
      this.webBack.pop();
      this.show(previous.id, true, { fromBack: true });
      return;
    }
    if (this.back && find(this.back)) this.show(this.back, false, { fromBack: true });
    else { this.back = null; this.header(); flash(t("pane.back.gone")); }
  }

  setConn(text, bad) {
    this.paneHeader.setConnection(text, !!bad);
  }

  cancelCachedRestore(c) {
    if (this.conn !== c || !c.cacheRestore) return;
    if (document.activeElement === this.term.textarea) this.term.textarea.blur();
    this.detach();
    this.setConn(t("conn.cachedUnconfirmed"), true);
  }

  attach(name, opts = {}) {
    if (localActionUnavailable()) return;
    const session = find(name);
    if (recoveredLineTarget?.pane === this &&
        (recoveredLineTarget.name !== name || recoveredLineTarget.created !== session?.created)) {
      saveRecoveredLine();
    }
    this.detach();
    this.inputLease = this.inputLeaseFor(name);
    this.renderRetainedInput();
    // xterm's reset temporarily clears the viewport row height.  If a pending
    // native scroll is delivered while an old terminal is still visible,
    // xterm divides its scrollTop by that zero height and corrupts ydisp with
    // NaN.  Reset while hidden, then fit only after its next frame.
    this.termEl.hidden = true;
    this.inputOrigin?.reset();
    this.term.reset();
    // Output held for a finger belongs to the previous session: flushed later, it would be
    // parsed after the draining below and its queries answered to this session.
    this.queuedOutput = []; this.queuedBytes = 0;
    const c = { name, created: session?.created, cachedAck: !!session?.provisional && !!this.inputAck,
      piFullscreenScroll: false, retry: 0, closed: false, terminal: null,
      ws: null, // real local socket: legacy paste identity/diagnostic compatibility only
      initializing: true, cacheRestore: opts.cacheRestore === true, waitingListing: !this.inputLease,
      followOutput: true, followCandidate: false, followFrame: 0, preserveViewport: null, bottomSync: false,
      focusRequested: opts.focusTerminal === true, draining: true };
    this.conn = c;
    // The old draft belongs to the previous connection; re-evaluate it only
    // after the new incarnation is known, including a legacy/no-ACK terminal.
    this.renderRetainedInput();
    // reset() does not empty xterm's write queue: output of the previous session may
    // still be parsed after this point. xterm parses writes in order, so this empty
    // write's callback runs once all of it has been parsed.
    this.term.write("", () => { c.draining = false; this.flushReplayInput(c); });
    requestAnimationFrame(() => {
      if (c.closed || this.conn !== c) return;
      this.termEl.hidden = false;
      try { this.fit.fit(); } catch {}
      // A hidden xterm needs a settled layout before its glyph geometry is
      // usable.  Keep its temporary default size private and, importantly,
      // do not create the WebSocket (whose URL also carries the dimensions)
      // until the measured geometry is ready.
      c.initTimer = setTimeout(() => {
        if (c.closed || this.conn !== c) return;
        try { this.fit.fit(); } catch {}
        c.initializing = false;
        open();
      }, 100);
    });
    updateKeys();
    const open = () => {
      if (c.closed) return;
      // A positive cached hint opens only an ACK-bound socket. Neither an absent
      // hint nor a failed handshake can open a raw socket before the listing.
      if (c.waitingListing) return;
      this.setConn(c.retry ? t("conn.reconnecting") : t("conn.connecting"));
      if (this.inputAck) {
        ackAttempted.add(`${name}\0${c.created}`);
        if (this.inputAck.version === 2) v2Attempted.add(`${name}\0${c.created}`);
      }
      const current = (terminal) => !c.closed && this.conn === c && c.terminal === terminal;
      const version = this.inputAck?.version ?? 0;
      const socketInput = this.inputAck, socketLease = this.inputLease;
      const knownBinding = version === 2 ? this.inputAck.binding : null;
      c.v2AwaitingCapability = version === 2;
      let openedThisAttempt = false;
      const terminal = openLocalTerminal(name, { ...this.ownSize(), created: c.created }, {
        modeSource: this.term,
        current,
        retainedInput: (handle) => socketInput?.retainedConnection === c && c.terminal === handle,
        abandonRetainedInput: (handle) => {
          if (socketInput?.retainedConnection === c && c.terminal === handle) {
            c.forgetRetainedInput?.();
            socketInput.disconnect();
          }
        },
        inputCapability: (_terminal, message) => {
          if (version === 2) {
            const valid = message.version === 2 && message.supported === true &&
              message.created === c.created &&
              Number.isSafeInteger(message.slot) && message.slot >= 0 && message.slot < 64 &&
              Number.isSafeInteger(message.generation) && message.generation > 0 &&
              typeof message.actor_nonce === "string" && /^[0-9a-f]{32}$/.test(message.actor_nonce) &&
              Object.keys(message).sort().join(",") === "actor_nonce,created,generation,slot,supported,t,version";
            if (!valid || !this.inputAck?.connectV2(message.created, message.slot, message.generation,
              message.actor_nonce, true)) {
              c.v2Refused = true;
              this.inputAck?.reject();
              _terminal.socket.close();
            } else {
              c.v2AwaitingCapability = false;
              c.v2HealthyFailures = 0;
              clearTimeout(c.v2AwaitTimer);
              this.inputLease?.reconnect();
            }
            this.renderRetainedInput();
            return;
          }
          if (message.id !== this.inputAcks.get(`${name}\0${c.created}`)?.id ||
              message.created !== c.created || typeof message.supported !== "boolean") {
            this.inputAck?.disconnect();
            return;
          }
          this.inputAck?.connect(message.created, message.id, message.supported);
          this.renderRetainedInput();
        },
        inputAck: (_terminal, message) => {
          const ackInput = socketInput;
          const ackLease = socketLease;
          if (version === 2) {
            if (message.version !== 2 || typeof message.input_ack !== "boolean" ||
                !Number.isSafeInteger(message.seq)) {
              c.v2Refused = true;
              ackInput?.reject();
              _terminal.socket.close();
            } else ackInput?.ackV2(message.created, message.slot, message.generation,
              message.seq, message.input_ack, message.reason);
            if (ackInput?.completed && ackInput.pendingHumanBytes === 0)
              ackLease?.release();
            this.renderRetainedInput();
            return;
          }
          if (typeof message.input_ack !== "boolean" || !Number.isSafeInteger(message.seq)) {
            ackInput?.disconnect();
            return;
          }
          ackInput?.ack(message.created, message.id, message.seq, message.input_ack, message.reason);
          if (ackInput?.completed && ackInput.pendingHumanBytes === 0)
            ackLease?.release();
          this.renderRetainedInput();
        },
        inputRejected: (terminal) => {
          if (version === 2) {
            c.v2Refused = true;
            this.inputAck?.reject();
            terminal.socket.close();
          }
          else this.inputAck?.disconnect();
          this.renderRetainedInput();
        },
        opened: () => {
          this.cancelReplayInput(c);
          openedThisAttempt = true;
          if (version === 2) c.v2AwaitTimer = setTimeout(() => {
            if (!current(terminal) || !c.v2AwaitingCapability) return;
            c.v2Refused = true;
            this.inputAck?.reject();
            this.renderRetainedInput();
            terminal.socket.close();
          }, 5000);
          this.queuedOutput = []; this.queuedBytes = 0;   // the old connection's output is wiped with the screen
          c.replayPending = true;   // the host's first frame is the replay (see onData)
          c.replayGeometry = null;   // until server.py names it, before the replay
          c.away = null;   // this socket sends its size and redraws (armAutoRedraw)
          c.pty = null;    // until the host tells this socket (ptySize, after the replay)
          c.initialSizeClaim = false;
          c.replaySizeRelease = false;
          c.limitedGeometry = null;
          this.limitedBanner.hidden = true;
          this.limitedKeyboard.hidden = true; c.liveKeyboard = false;
          if (touch) this.term.textarea.setAttribute("inputmode", "none");
          c.retry = 0; this.setConn("●");
          if (version !== 2) this.inputLease.reconnect();
          if (this.inputLease.dirty)
            flash(t("conn.unsentInput"));
          // Desktop xterm focus emits the same forced size through its focus
          // handler. Let that be the socket-open resize, not a duplicate R.
          const focusedXterm = !touch && this.applySelectedTerminalFocus(c);
          if (!this.termEl.hidden && !focusedXterm) this.sendSize(true);
          if (touch) this.applySelectedTerminalFocus(c);
          if (opts.cacheFocus && opts.cacheFocusRevision === meshCacheFocusRevision
              && canFocusPaneAction(opts.cacheFocus)) opts.cacheFocus.focus({preventScroll: true});
        },
        replayGeometry: (_terminal, geometry) => {
          if (c.replayPending) c.replayGeometry = geometry;
          if (_terminal.limited) c.limitedGeometry = geometry;
        },
        protocol: (_terminal, limited) => {
          this.limitedBanner.hidden = !limited;
          this.limitedKeyboard.hidden = !limited || !touch;
          if (!limited) {
            this.sendSize(true); this.armAutoRedraw(c);
            this.renderRetainedInput();
          }
        },
        ptySize: (_terminal, size) => {
          const initialClaim = c.pty === null && c.initialSizeClaim;
          c.pty = size;
          c.initialSizeClaim = false;
          this.applyPtySize(c, initialClaim);
        },
        bytes: (terminal, bytes) => {
          // A closing browser socket may already have a replay frame queued.
          // The handle's current guard rejects frames for a replacement pane.
          if (c.replayPending) {
            c.replayPending = false;
            this.writeReplay(c, bytes, () => current(terminal));
          } else {
            this.noteOutputAway(c);
            this.output(bytes);
          }
          this.bumpAutoRedraw(c);
          this.bumpInitialFollow(c);
          const nativeMode = terminal.dictationMode.valid && terminal.dictationMode.value;
          if (c.inlineMode !== nativeMode) {c.inlineMode = nativeMode; renderInlineDictation();}
        },
        closed: async (terminal) => {
          c.forgetRetainedInput?.();
          clearTimeout(c.v2AwaitTimer);
          // Settle only this socket's replay queue before the inventory refresh
          // yields; a replacement socket owns a different queue.
          if (current(terminal)) this.cancelReplayInput(c);
          const missingV2Capability = version === 2 && c.v2AwaitingCapability;
          // A socket that opened but never confirmed its actor has refused the
          // attachment. A failed upgrade can also mean the server is restarting;
          // distinguish that case after the inventory read below.
          if (missingV2Capability && openedThisAttempt) {
            c.v2Refused = true;
            this.inputAck?.reject();
          }
          socketInput?.disconnect();
          this.renderRetainedInput();
          this.leaveReplayGeometry(c);
          if (lineDirect?.conn === c) endDirectLine("line.directConnection");
          if (c.autoRedraw) { clearTimeout(c.autoRedraw.timer); c.autoRedraw = null; }
          if (c.initialFollow) { clearTimeout(c.initialFollow.timer); c.initialFollow = null; }
          await refresh();
          // refresh yields to the browser. The pane may have been detached or
          // reattached while it was in flight; recheck before changing or retrying.
          if (!current(terminal)) return;
          if (c.cacheRestore) { this.cancelCachedRestore(c); return; }
          if (missingV2Capability && !openedThisAttempt && !c.v2Refused &&
              (inventoryPoller?.state().failures ?? 0) === 0) {
            // One extra attempt after a healthy listing permits a server that
            // returned during the failed upgrade. A persistent refusal stops.
            c.v2HealthyFailures = (c.v2HealthyFailures ?? 0) + 1;
            if (c.v2HealthyFailures >= 2) {
              c.v2Refused = true;
              this.inputAck?.reject();
              this.renderRetainedInput();
            }
          }
          if (c.v2Refused) {
            this.setConn(t("conn.inputUnavailable"), true);
            return;
          }
          const session = data.mesh.find((s) => s.id === name);
          if (!session) {
            c.ended = true;   // a restored session of this name lets refresh() reattach the pane
            this.cancelReplayInput(c);
            this.setConn(t("conn.ended"), true);
            this.output(`\r\n\x1b[2m[${t("conn.sessionEnded")}]\x1b[0m\r\n`);
            return;
          }
          if ((session.created ?? null) !== (c.created ?? null)) {
            this.attach(name); return;
          }
          c.retry++;
          this.setConn(t("conn.disconnected"), true);
          setTimeout(open, Math.min(8000, 400 * 2 ** c.retry));
        },
      }, version === 2 ? {
        version: 2, mode: knownBinding ? "resume" : "new", created: c.created,
        slot: knownBinding?.slot, generation: knownBinding?.generation, actorNonce: knownBinding?.actorNonce,
        current: () => c.v2AwaitingCapability ? null : socketInput?.binding,
      } : this.inputAck ? this.inputAcks.get(`${name}\0${c.created}`) && {
        version: 1, id: this.inputAcks.get(`${name}\0${c.created}`).id, created: c.created,
      } : null);
      c.terminal = terminal;
      c.ws = terminal.socket;
    };
  }

  detach() {
    if (!this.conn) return;
    // A recovered editor draft stays in the browser when its terminal closes.
    // Release its reservation while the original transport is still bound.
    const key = `${this.conn.name}\0${this.conn.created}`;
    const recoveredLine = lineRecovery?.recovered;
    for (const draft of [this.recoveredLineDrafts.get(key), recoveredLine, this.recoveredComposeDraft]) {
      if (draft && draft.name === this.conn.name && draft.created === this.conn.created &&
          (!draft.pane || draft.pane === this)) {
        releaseDiscardedEditorDraft({pane: this, ...draft});
      }
    }
    for (const {target, entry} of composeRecovery) {
      if (target.pane === this && target.name === this.conn.name && target.created === this.conn.created)
        releaseDiscardedEditorDraft(target, entry);
    }
    this.limitedBanner.hidden = true;
    this.limitedKeyboard.hidden = true;
    if (touch) this.term.textarea.setAttribute("inputmode", "none");
    // The session left keeps no focus-in: its focus-out goes on its own connection. The pane's
    // focus state is then reset, so the next session starts unreported (whatever the pane
    // reported to the previous one) and gets a focus-in only per the rules above.
    if (this.focusReported === true) this.reportFocus(false);
    this.focusReported = null; this.heldFocusIn = false;
    cancelInlineCapture(this);
    this.cancelReplayInput(this.conn);
    this.dropReaderAnchor(this.conn);
    this.conn.closed = true;
    if (this.inputAck?.retainedConnection !== this.conn) this.inputAck?.disconnect();
    if (this.conn.autoRedraw) clearTimeout(this.conn.autoRedraw.timer);
    if (this.conn.initialFollow) clearTimeout(this.conn.initialFollow.timer);
    if (this.conn.followFrame) cancelAnimationFrame(this.conn.followFrame);
    if (this.conn.initTimer) clearTimeout(this.conn.initTimer);
    if (this.conn.v2AwaitTimer) clearTimeout(this.conn.v2AwaitTimer);
    try { this.conn.terminal?.close(); } catch {}
    this.conn = null;
    if (this.ptyFollowing || this.sizeBanner?.hidden === false) {
      this.ptyFollowing = false;
      this.sizeBanner.hidden = true;
      this.termEl.classList.remove("pty-follow", "pty-tall");
    }
    this.setConn("");
    updateKeys();
  }

  renderDetail(s) {
    const a = s.agent;
    $(".detail", this.el).innerHTML = `<div class="card">
      <h2>${esc(label(s))}</h2>
      <div class="mute">${esc(s.host)} · ${esc(s.tty)} · ${esc(t("detail.pid", { pid: s.pid }))}</div>
      <dl>
        <dt>${esc(t("detail.folder"))}</dt><dd>${esc(short(s.cwd))}</dd>
        <dt>${esc(t("detail.command"))}</dt><dd>${esc(s.cmd)}</dd>
        ${a ? `<dt>${esc(t("detail.agent"))}</dt><dd>${esc(a.type)} · ${esc(a.status || "?")} · ${esc(ago(a.updated))}</dd>
               <dt>${esc(t("detail.session"))}</dt><dd>${esc(a.session_id || "?")}</dd>` : ""}
        ${a?.last ? `<dt>${esc(t("detail.lastPrompt"))}</dt><dd class="quote">${esc(a.last)}</dd>` : ""}
      </dl>
      <p class="why">${esc(t("detail.why", { host: s.host }))}</p>
      <div class="actions">
        ${!a || !a.session_id ? `<div class="hint">${esc(t("detail.noConversation"))}</div>`
          : s.pending ? `<button class="btn primary" disabled>${esc(t("detail.pendingButton"))}</button>
                         <button class="btn ghost" data-adopt="cancel">${esc(t("common.cancel"))}</button>
                         <div class="hint">${esc(t("detail.pendingHint"))}</div>`
          : `${IDLE_OBSERVABLE_AGENTS.has(a.type) ? `<button class="btn primary" data-adopt="when-idle">${esc(t("detail.whenIdle"))}</button>` : ""}
             <button class="btn" data-adopt="resume">${esc(t("detail.resumeNow"))}</button>
             <div class="hint">${!IDLE_OBSERVABLE_AGENTS.has(a.type) ? esc(t(a.type === "pi" ? "detail.piHint" : "detail.noIdleHint")) : `<b>${esc(t("detail.whenIdleHintLead"))}</b> ${esc(t("detail.whenIdleHintRest"))}`}
             <br><b>${esc(t("detail.nowHintLead"))}</b> ${esc(t("detail.nowHintRest"))}</div>`}
      </div>
    </div>`;
  }

  async adopt(mode, btn) {
    const s = find(this.id);
    if (!s) return;
    if (mode === "resume" && !confirm(t("detail.confirmResume", { agent: s.agent.type, pid: s.agent.pid, host: s.host }))) return;
    btn.disabled = true;
    const r = await requestLocal("/api/adopt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pid: s.pid, mode }) });
    if (!r.ok) { alert(serverText(await r.text())); btn.disabled = false; return; }
    const { id } = await r.json();
    await refresh();
    if (id) {
      if (flowing) setFlow(false);
      this.show(id, false, { focusTerminal: true });
    }
  }

  killSession() {
    observePaneActions(this);
    const target = paneTargets.capture(this);
    if (target) return stopPaneTarget(target).finally(() => paneTargets.release(target));
  }

  dispose() {
    this.invalidateActionView(); this.actionDisposed = true; this.abandonCopyOnSelect?.();
    observePaneActions(this); this.paneMenu.dispose();
    this.resetFrameHistory(); this.detach();
    // Pinned xterm reset queues viewport syncs that dispose does not cancel.
    // Retire only this closed viewport before its renderer is destroyed.
    const viewport = this.term._core?.viewport;
    if (viewport) viewport.syncScrollArea = () => {};
    this.term.dispose();
    this.inputOrigin?.dispose();
    for (const lease of this.inputLeases.values()) lease.retire();
    this.inputLeases.clear();
  }
}

function webLabel(s) {
  const name = s.target.split("/").pop();
  return s.source ? t("web.sourceLabel", { name }) : name;
}

// The source view of a rendered document (HTML, Markdown, SVG, a diff) in the code viewer:
// its own pane entry, the same signed URL with ?source=1.
const SOURCE_EXT = /\.(html?|md|markdown|svg|diff|patch)$/i;
function sourceEntry(w) {
  const id = `${w.id}#source`;
  const previous = webs.get(id) || {};
  const s = { ...w, id, source: true, url: w.url + "?source=1", opensLinks: false, opensSessions: false, keepsScroll: true,
              watch: previous.watch ?? w.watch, mtime: previous.mtime ?? w.mtime, scrollY: previous.scrollY };
  webs.set(id, s);
  return s;
}

// Where a relative path printed in a session is rooted: the agent's current
// directory (from its transcript; agents cd), then where it was started.
function sessionBases(id) {
  const s = id && find(id);
  return s ? [s.agent?.cwd, s.cwd].filter(Boolean) : [];
}

// A clicked path in a terminal: a directory opens the file tree, anything else
// the side panel (Ctrl/Cmd: a new tab).
function followLink(kind, text, e, pane) {
  if (kind === "ref") return openReference(text);
  if (kind === "url") return openExternalTab(text);
  const base = sessionBases(pane.id);
  if (kind === "dir") return openTree(text, base);
  if (e.ctrlKey || e.metaKey) describeWeb(text, base).then((d) => d && window.open(viewUrl(d), "_blank", "noopener"));
  else openWeb(text, base);
}

function isExternalUrl(url) {
  try { const parsed = new URL(url); return (parsed.protocol === "http:" || parsed.protocol === "https:") && !!parsed.host; }
  catch { return false; }
}

// Normal clicks never load an external origin into a mesh iframe.  This is
// important for sites that reject framing (which otherwise looks like a blank
// panel) and keeps the mesh's signed local-document panes local.
function openExternalTab(url) {
  if (localActionUnavailable()) return;
  if (!isExternalUrl(url)) return flash(t("link.invalidExternal"));
  window.open(url, "_blank", "noopener,noreferrer");
}

async function openInExternalBrowser(url) {
  const r = await requestLocal("/api/external-open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
  if (!r.ok) return flash(serverText(await r.text()));
  flash(t("link.openedExternal"));
}

let externalLinkMenu = null;
function closeExternalLinkMenu() { externalLinkMenu?.remove(); externalLinkMenu = null; }
function openExternalLinkMenu(url, x, y) {
  if (localActionUnavailable()) return;
  closeExternalLinkMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.setAttribute("role", "menu");
  const item = document.createElement("button");
  item.type = "button";
  item.setAttribute("role", "menuitem");
  item.textContent = t("link.openExternal");
  item.addEventListener("click", () => { closeExternalLinkMenu(); openInExternalBrowser(url); });
  menu.append(item);
  document.body.append(menu);
  const gap = 4, box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(gap, Math.min(x, innerWidth - box.width - gap))}px`;
  menu.style.top = `${Math.max(gap, Math.min(y, innerHeight - box.height - gap))}px`;
  externalLinkMenu = menu;
  item.focus();
}
document.addEventListener("pointerdown", (e) => { if (externalLinkMenu && !externalLinkMenu.contains(e.target)) closeExternalLinkMenu(); }, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeExternalLinkMenu(); }, true);
window.addEventListener("blur", closeExternalLinkMenu);
// While the phone input line holds the active pane's focus, xterm sees no window focus change.
for (const [type, focused] of [["blur", false], ["focus", true]])
  window.addEventListener(type, () => { if (active?.mounted && document.activeElement === $("#line-text")) active.reportFocus(focused); });

// A document's URL with its line, if any: the code viewer jumps to #L<n>.
const viewUrl = (w) => w.url + (w.line ? `#L${w.line}` : "");

// "file.py:42", "file.py:42:7" (a column, ignored) or "file.py:10-20" (a range)
function splitLine(target) {
  const at = /^https?:/i.test(target) ? null : target.match(/^(.*?):(\d+)(?:([:-])(\d+))?$/);
  return at ? { path: at[1], line: at[3] === "-" ? `${at[2]}-${at[4]}` : at[2] } : { path: target, line: null };
}

// Every caller (click, Ctrl+click, dialog, reload) goes through here, so a
// ":line" suffix is always taken off before asking the server, and kept.
async function describeWeb(target, base, opts = {}) {
  if (localActionUnavailable()) return;
  // base: a directory, or a list of them (sessionBases), tried in order
  const bases = Array.isArray(base) ? base : base ? [base] : [];
  const { path, line } = splitLine(target);
  const r = await requestLocal("/api/view", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target: path, base: bases[0], bases }) });
  if (!r.ok) { flash(serverText(await r.text())); return null; }
  const d = await r.json();
  const id = `web:${d.target}`;
  // a re-signed document keeps what the page learned about it: whether it is watched, and where it was scrolled
  const previous = webs.get(id) || {};
  const { watch, mtime, scrollY } = previous;
  const w = { id, kind: "web", type: d.kind, ext: d.ext, target: d.target, url: d.url, sandbox: d.sandbox, inert: d.inert === true, opensLinks: d.opens_links === true,
              opensSessions: d.opens_sessions === true, keepsScroll: d.keeps_scroll === true, watch, mtime, scrollY,
              // a line given now wins; an explicit open without one starts at the top;
              // other callers (reload, new tab) keep the pane's line
              line: line ?? (opts.fresh ? null : previous.line ?? null) };
  webs.set(w.id, w);
  return w;
}

// Where a document goes: the pane that already shows it; else, for a document
// opened for a session, next to that session's pane (see placeNextTo); else a
// web pane, a new column, or the rightmost other pane.
function placeWeb(w, anchor) {
  const same = panes.find((q) => q.id === w.id);
  if (same) return same;
  if (narrow() && active) return active;   // one pane on screen: there, so "←" leads back to what was shown
  if (anchor) return placeNextTo(anchor);
  let p = panes.find((q) => isAdjacentPane(q.id));
  if (!p && workspaceGroups.length < MAX_PANES && !narrow()) {
    const keep = active;
    p = addPane();
    setActive(keep);
  }
  return p || [...panes].reverse().find((q) => q !== active) || active;
}

// Next to `anchor`: a neighbouring web pane (right first) is reused, else a column
// is added right after it if there is room, else the neighbour is taken over.
function placeNextTo(anchor) {
  const at = panes.indexOf(anchor);
  const neighbours = [panes[at + 1], panes[at - 1]].filter(Boolean);
  const web = neighbours.find((q) => isAdjacentPane(q.id));
  if (web) return web;
  if (workspaceGroups.length < MAX_PANES && !narrow()) {
    const keep = active;
    const p = addPane(null, at + 1);
    setActive(keep);
    return p;
  }
  return neighbours[0] || anchor;
}

// Show a document beside the terminals. The keyboard stays where it was.
// opts.anchor: the pane of the session it was opened for; opts.watch / opts.mtime:
// reload it when the file changes (the mtime is the server's baseline at open time).
async function openWeb(target, base, opts = {}) {
  if (localActionUnavailable()) return;
  const plain = await describeWeb(target, base, { fresh: true });   // "file.py:42" opens at that line
  if (!plain) return;
  const w = opts.source && plain.type === "file" && SOURCE_EXT.test(plain.target) ? sourceEntry(plain) : plain;
  if (opts.watch) { w.watch = true; w.mtime = opts.mtime ?? null; }
  else if (w.type === "file" && w.watch === undefined) await setWatch(w, store.get("watchDefault", false));
  if (flowing) setFlow(false);
  const p = placeWeb(w, opts.anchor);
  p.show(w.id, true);   // asked to open: always load afresh, even if the signed URL is unchanged
  if (narrow()) setActive(p);
  else active?.focus();
}

// A board is a first-class adjacent pane rather than an untrusted document:
// its iframe is same-origin and only calls the private relative board API.
function openBoard(sessionId = active?.id) {
  const board = boardEntry(sessionId);
  if (!board) return flash(t("board.sessionMissing"));
  clearBoardModified(sessionId);
  const anchor = panes.find((pane) => pane.id === sessionId);
  const pane = placeWeb(board, anchor);
  pane.show(board.id, true);
  if (narrow()) setActive(pane);
  else active?.focus();
}

const demoCatalogUrl = (session) => `/api/demo-scene/${encodeURIComponent(session.name)}/catalog?created=${encodeURIComponent(session.created)}`;
const demoChooser = MeshDemoCatalog.createChooser($("#dlg-demo-chooser"));
const demoHistoryDialog = MeshDemoCatalog.createHistoryDialog($("#dlg-demo-history"));
const demoOpenSerials = new Map();
function nextDemoOpenSerial(sessionId) {
  const serial = (demoOpenSerials.get(sessionId) ?? 0) + 1;
  demoOpenSerials.set(sessionId, serial);
  return serial;
}
const demoSceneUrl = (session, demoId, version = null) => {
  const revision = version === null ? "" : `&version=${encodeURIComponent(version)}`;
  return demoId === "legacy"
    ? `/api/demo-scene/${encodeURIComponent(session.name)}?created=${encodeURIComponent(session.created)}${revision}`
    : `/api/demo-scene/${encodeURIComponent(session.name)}/selected?created=${encodeURIComponent(session.created)}&demo_id=${encodeURIComponent(demoId)}${revision}`;
};
const demoHistoryUrl = (demo) => `/api/demo-scene/${encodeURIComponent(demo.name)}/selected/revisions?created=${encodeURIComponent(demo.created)}&demo_id=${encodeURIComponent(demo.demoId)}`;
const demoRestoreUrl = (demo) => `/api/demo-scene/${encodeURIComponent(demo.name)}/selected/restore?created=${encodeURIComponent(demo.created)}`;

async function readDemoSceneResponse(response) {
  const sandbox = response.headers.get("X-Mesh-Frame-Sandbox");
  if (!response.ok || sandbox === null || sandbox.length > 128
      || !/^(?:[a-z]+(?:-[a-z]+)*(?: [a-z]+(?:-[a-z]+)*)*)?$/.test(sandbox)) return null;
  const scene = await response.json();
  if (!["mesh-scene-v0", "mesh-scene-v1"].includes(scene?.format)
      || !Number.isSafeInteger(scene.version) || scene.version < 0) return null;
  return { scene, sandbox };
}

async function readDemoCatalog(session) {
  const response = await requestLocal(demoCatalogUrl(session));
  if (!response.ok) throw new Error("catalog unavailable");
  const rows = MeshDemoCatalog.readCatalog(await response.json());
  if (!rows) throw new Error("invalid catalog");
  return rows.length ? rows : [{ id: "legacy", title: t("demo.defaultTitle"), version: 0 }];
}

async function chooseDemoScene(target) {
  const session = find(target.id);
  if (!session || session.created !== target.created || !paneTargets.valid(target)) return;
  let catalog;
  try { catalog = await readDemoCatalog(session); }
  catch { return flash(t("demo.catalogUnavailable")); }
  if (!paneTargets.valid(target)) return;
  const selected = demos.get(`demo:${target.id}`)?.demoId ?? null;
  const choice = catalog.length === 1 ? catalog[0].id
    : await demoChooser.choose(catalog, selected, target.displayName || target.name);
  if (!choice || !paneTargets.valid(target)) return;
  await openDemoScene(target.id, true, choice);
}

async function selectDemoScene(pane, demoId) {
  const demo = demos.get(pane.id);
  const row = demo?.catalog.find((entry) => entry.id === demoId);
  if (!row) return;
  nextDemoOpenSerial(demo.session);
  const serial = ++demo.selectionSerial;
  const response = await requestLocal(demoSceneUrl(demo, demoId));
  const described = await readDemoSceneResponse(response);
  if (!described) return flash(t("demo.sceneUnavailable"));
  const { scene, sandbox } = described;
  if (pane.id !== demo.id || demos.get(demo.id) !== demo || serial !== demo.selectionSerial
      || !data.mesh.some((s) => s.id === demo.session && s.created === demo.created)) return;
  demo.demoId = demoId;
  demo.version = scene.version;
  demo.sandbox = sandbox;
  demo.offeredVersion = null;
  demo.offeredSandbox = null;
  pane.show(demo.id, true);
}

async function openDemoHistory(pane) {
  const demo = demos.get(pane.id);
  if (!demo || demo.demoId === "legacy" || !data.mesh.some((session) => session.id === demo.session
      && session.created === demo.created)) return;
  const demoId = demo.demoId;
  const serial = ++demo.selectionSerial;
  let history;
  try {
    const response = await requestLocal(demoHistoryUrl(demo));
    if (!response.ok) throw new Error();
    history = MeshDemoCatalog.readNamedHistory(await response.json(), demoId);
  } catch { return flash(t("demo.historyUnavailable")); }
  if (!history) return flash(t("demo.historyInvalid"));
  if (demos.get(demo.id) !== demo || demo.demoId !== demoId || serial !== demo.selectionSerial) return;
  const row = demo.catalog.find((entry) => entry.id === demoId);
  const action = await demoHistoryDialog.choose(history, demo.version,
    row ? MeshDemoCatalog.choiceLabel(row, demo.catalog) : demoId.slice(0, 6));
  if (!action || demos.get(demo.id) !== demo || demo.demoId !== demoId
      || serial !== demo.selectionSerial
      || !data.mesh.some((session) => session.id === demo.session && session.created === demo.created)) return;
  if (action.kind === "preview") {
    if (!history.versions.includes(action.version)) return;
    const response = await requestLocal(demoSceneUrl(demo, demoId, action.version));
    const described = await readDemoSceneResponse(response);
    if (!described || described.scene.version !== action.version || demos.get(demo.id) !== demo
        || demo.demoId !== demoId || serial !== demo.selectionSerial) return flash(t("demo.revisionUnavailable"));
    let current = null;
    if (history.current !== action.version) {
      current = await readDemoSceneResponse(await requestLocal(demoSceneUrl(demo, demoId, history.current)));
      if (!current || current.scene.version !== history.current || demos.get(demo.id) !== demo
          || demo.demoId !== demoId || serial !== demo.selectionSerial) return flash(t("demo.revisionUnavailable"));
    }
    demo.version = action.version;
    demo.sandbox = described.sandbox;
    demo.offeredVersion = history.current === action.version ? null : history.current;
    demo.offeredSandbox = current?.sandbox ?? null;
    pane.show(demo.id, true);
    return;
  }
  let restored;
  try {
    const response = await requestLocal(demoRestoreUrl(demo), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demo_id: demoId, version: action.version, expected_version: history.current }),
    });
    if (response.status === 409) return flash(t("demo.historyChanged"));
    if (!response.ok) throw new Error();
    restored = await readDemoSceneResponse(response);
  } catch { return flash(t("demo.restoreFailed")); }
  if (!restored) return flash(t("demo.restoreFailed"));
  const restoredSandbox = restored.sandbox;
  restored = restored.scene;
  if (demos.get(demo.id) !== demo || demo.demoId !== demoId || serial !== demo.selectionSerial
      || !["mesh-scene-v0", "mesh-scene-v1"].includes(restored?.format)
      || restored.version !== history.current + 1
      || !data.mesh.some((session) => session.id === demo.session && session.created === demo.created)) return;
  let catalog;
  try { catalog = await readDemoCatalog(demo); }
  catch { return flash(t("demo.restoredRefreshCatalog")); }
  if (demos.get(demo.id) !== demo || demo.demoId !== demoId || serial !== demo.selectionSerial) return;
  const current = catalog.find((entry) => entry.id === demoId);
  if (!current || current.version !== restored.version) return flash(t("demo.restoredRefreshCatalog"));
  demo.catalog = catalog;
  demo.version = restored.version;
  demo.sandbox = restoredSandbox;
  demo.offeredVersion = null;
  demo.offeredSandbox = null;
  pane.show(demo.id, true);
  flash(t("demo.restored", { from: action.version, to: restored.version }));
}

async function openDemoScene(sessionId, focus = false, preferredId = null) {
  const session = data.mesh.find((s) => s.id === sessionId);
  if (!session || !Number.isFinite(session.created)) return flash(t("demo.sessionUnavailable"));
  const serial = nextDemoOpenSerial(sessionId);
  let catalog;
  try { catalog = await readDemoCatalog(session); }
  catch { return flash(t("demo.catalogUnavailable")); }
  if (demoOpenSerials.get(sessionId) !== serial) return;
  const existing = demos.get(`demo:${sessionId}`);
  const demoId = catalog.some((row) => row.id === preferredId) ? preferredId
    : catalog.some((row) => row.id === existing?.demoId) ? existing.demoId : catalog[0].id;
  const response = await requestLocal(demoSceneUrl(session, demoId));
  if (demoOpenSerials.get(sessionId) !== serial) return;
  const described = await readDemoSceneResponse(response);
  if (!described) return flash(t("demo.sceneUnavailable"));
  const { scene, sandbox } = described;
  if (demoOpenSerials.get(sessionId) !== serial) return;
  if (!data.mesh.some((s) => s.id === sessionId && s.created === session.created)) return;
  const existingPane = panes.find((pane) => pane.id === existing?.id);
  if (existing?.created === session.created && existingPane) {
    if (preferredId === null && existing.demoId !== demoId) {
      if (focus || narrow()) setActive(existingPane, true);
      return;
    }
    existing.catalog = catalog;
    if (existing.demoId !== demoId) {
      existing.selectionSerial++;
      existing.demoId = demoId;
      existing.version = scene.version;
      existing.sandbox = sandbox;
      existing.offeredVersion = null;
      existing.offeredSandbox = null;
      existingPane.show(existing.id, true);
    }
    if (scene.version > Math.max(existing.version, existing.offeredVersion ?? -1)) {
      existing.offeredVersion = scene.version;
      existing.offeredSandbox = sandbox;
      for (const pane of panes.filter((pane) => pane.id === existing.id)) pane.show(existing.id);
    }
    renderDemoSelector(existingPane, existing);
    if (focus || narrow()) setActive(existingPane, true);
    return;
  }
  const demo = demoEntry(sessionId, scene.version, sandbox, demoId, catalog);
  if (!demo) return;
  const anchor = panes.find((pane) => pane.id === sessionId);
  const pane = placeWeb(demo, anchor);
  pane.show(demo.id);
  if (focus || narrow()) setActive(pane, true);
  else active?.focus();
}

async function checkDemoSceneUpdates() {
  for (const demo of demos.values()) {
    if (!panes.some((pane) => pane.id === demo.id)) continue;
    if (!data.mesh.some((s) => s.id === demo.session && s.created === demo.created)) continue;
    try {
      const selectedId = demo.demoId;
      const catalog = await readDemoCatalog(demo);
      if (demos.get(demo.id) !== demo || demo.demoId !== selectedId) continue;
      demo.catalog = catalog;
      for (const pane of panes.filter((pane) => pane.id === demo.id)) renderDemoSelector(pane, demo);
      const response = await requestLocal(demoSceneUrl(demo, selectedId));
      const described = await readDemoSceneResponse(response);
      if (!described) continue;
      const { scene, sandbox } = described;
      if (demos.get(demo.id) !== demo || demo.demoId !== selectedId) continue;
      if (!data.mesh.some((s) => s.id === demo.session && s.created === demo.created)) continue;
      if (scene.version > Math.max(demo.version, demo.offeredVersion ?? -1)) {
        demo.offeredVersion = scene.version;
        demo.offeredSandbox = sandbox;
        for (const pane of panes.filter((pane) => pane.id === demo.id)) pane.show(demo.id);
      }
    } catch { /* Keep the pinned revision; a future poll can offer again. */ }
  }
}

function invalidateReplacedDemoPanes() {
  for (const demo of demos.values()) {
    const current = data.mesh.find((session) => session.id === demo.session);
    if (!current || current.created === demo.created) continue;
    // A reused session name must never inherit the old incarnation's iframe or
    // label. Keep the historical revisions in storage, but clear this view.
    for (const pane of panes.filter((pane) => pane.id === demo.id)) pane.clear();
    demoHistoryDialog.close();
    demos.delete(demo.id);
  }
}

function contextualDiffRow(binding) {
  const directories = data.portfolio?.mesh_sessions?.directories;
  return Array.isArray(directories) ? directories.find((row) => row?.cwd === binding.cwd
    && row.sessions?.[0]?.name === binding.name && row.sessions[0].created === binding.created) : null;
}

function renderContextualDiff(pane, snapshot) {
  const box = $(".detail", pane.el);
  const panel = document.createElement("section");
  panel.className = "contextual-diff-panel";
  panel.setAttribute("aria-label", t("diff.title"));
  const text = (tag, value) => { const node = document.createElement(tag); node.textContent = value; panel.append(node); return node; };
  text("h2", t("diff.title"));
  text("p", `${snapshot.binding.name} · ${short(snapshot.binding.cwd).split("/").pop() || t("diff.directoryFallback")}`);
  text("p", t("diff.gitTimeUnknown"));
  const provenance = text("details", "");
  provenance.className = "contextual-diff-provenance";
  const summary = document.createElement("summary");
  summary.textContent = t("diff.provenance");
  provenance.append(summary);
  for (const value of [
    t("diff.incarnation", { created: snapshot.binding.created }),
    t("diff.fullDirectory", { cwd: snapshot.binding.cwd }),
    t("diff.source", { source: snapshot.source ?? t("diff.sourceDefault"), observed: snapshot.observedAt ?? t("diff.unknown") }),
    snapshot.receivedAt ? t("diff.received", { time: new Date(snapshot.receivedAt).toLocaleTimeString(MeshI18n.locale()) }) : t("diff.notReceived"),
  ]) {
    const line = document.createElement("p"); line.textContent = value; provenance.append(line);
  }
  provenance.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && provenance.open) {
      event.preventDefault(); event.stopPropagation(); provenance.open = false; summary.focus();
    }
  });
  const refreshButton = text("button", t("diff.refresh"));
  refreshButton.className = "btn contextual-diff-refresh";
  refreshButton.type = "button";
  refreshButton.disabled = snapshot.pending;
  refreshButton.addEventListener("click", async () => {
    const listing = await refresh();
    if (pane.id === snapshot.id && portfolioDiffs.get(snapshot.id) === snapshot) {
      await loadContextualDiff(pane, snapshot, listing?.portfolio ?? null);
    }
  });
  const returnButton = text("button", t("diff.linkedTerminal"));
  returnButton.setAttribute("aria-label", t("diff.returnLabel"));
  returnButton.className = "btn contextual-diff-return";
  returnButton.type = "button";
  const returnToTerminal = () => {
    const session = data.mesh.find((entry) => entry.name === snapshot.binding.name
      && entry.created === snapshot.binding.created && entry.cwd === snapshot.binding.cwd);
    if (!session) return;
    const terminal = panes.find((entry) => entry.id === session.id);
    if (terminal) { setActive(terminal); terminal.focusSelectedTerminal(); }
    else { pane.show(session.id, false, { focusTerminal: true }); setActive(pane); }
  };
  returnButton.disabled = !data.mesh.some((entry) => entry.name === snapshot.binding.name
    && entry.created === snapshot.binding.created && entry.cwd === snapshot.binding.cwd);
  returnButton.addEventListener("click", returnToTerminal);
  panel.tabIndex = -1;
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); returnToTerminal(); }
  });
  const result = snapshot.result;
  const states = { clean: t("diff.state.clean"), "over-limit": t("diff.state.overLimit"), unavailable: t("diff.state.unavailable"), "not-a-repository": t("diff.state.notARepository"), "invalid-output": t("diff.state.invalidOutput") };
  if (snapshot.pending) text("p", t("common.loading"));
  else if (result?.state !== "observed") text("p", (Object.hasOwn(states, result?.state) && states[result.state]) || t("diff.state.unavailable"));
  else {
    text("p", Array.isArray(result.files) ? result.files.join(" · ") : t("diff.filesUnknown"));
    const pre = text("pre", "");
    if (typeof result.unified === "string") for (const line of result.unified.split("\n")) {
      const span = document.createElement("span");
      span.className = `contextual-diff-line ${MeshPaneActions.contextualDiffLineKind(line)}`;
      span.textContent = `${line}\n`;
      pre.append(span);
    }
  }
  box.replaceChildren(panel);
}

async function loadContextualDiff(pane, snapshot, freshPortfolio = data.portfolio) {
  const request = snapshot.lifetime.begin();
  if (request === null) return;
  const selector = MeshPaneActions.contextualDiffSelector(freshPortfolio, snapshot.binding);
  snapshot.pending = true;
  renderContextualDiff(pane, snapshot);
  let result = { state: "unavailable" };
  let receivedAt = null;
  try {
    if (selector !== null) {
      const response = await requestLocal(`/api/portfolio/diff/${encodeURIComponent(selector)}`);
      receivedAt = Date.now();
      if (response.ok) result = await response.json();
    }
  } catch { /* Preserve explicit unavailable state, never fallback to active. */ }
  if (!snapshot.lifetime.current(request) || pane.id !== snapshot.id || !panes.includes(pane)) return;
  if (!contextualDiffRow(snapshot.binding)) result = { state: "unavailable" };
  snapshot.pending = false;
  snapshot.result = result;
  snapshot.receivedAt = receivedAt;
  renderContextualDiff(pane, snapshot);
}

function openContextualDiff(cwd) {
  const portfolio = data.portfolio;
  const row = portfolio?.mesh_sessions?.directories?.find((entry) => entry.cwd === cwd);
  const session = row?.sessions?.[0];
  if (typeof session?.name !== "string" || !Number.isFinite(session.created) || typeof row.diff_selector !== "string") return;
  const snapshot = { id: `context-diff:${++nextContextualDiff}`, kind: "contextual-diff",
    name: t("diff.title"), cwd,
    binding: Object.freeze({ name: session.name, created: session.created, cwd }),
    // null: the default source text is translated where it is displayed
    source: typeof portfolio.source === "string" ? portfolio.source : null,
    observedAt: portfolio.observed_at, receivedAt: null, pending: true, result: null,
    lifetime: MeshPaneActions.createContextualDiffLifetime() };
  portfolioDiffs.set(snapshot.id, snapshot);
  const anchor = panes.find((pane) => find(pane.id)?.name === session.name && find(pane.id)?.created === session.created);
  const pane = placeWeb(snapshot, anchor);
  pane.show(snapshot.id);
  if (narrow()) { setActive(pane); $(".contextual-diff-panel", pane.el)?.focus(); }
  loadContextualDiff(pane, snapshot);
}

// A mesh-open request. One made for a session (the server took the name from the
// session's token) is shown only by the pages that display that session.
function handleOpen(o) {
  // This is a closed, server-authored queue union.  In particular, an unknown
  // queue record must not become an implicit UI-control command.
  if (!o || typeof o !== "object") return;
  if (o.kind === "demo-scene-open") {
    const keys = Object.keys(o).sort().join(",");
    if (!(["at,kind,seq,session", "at,demo_id,kind,seq,session"].includes(keys))
        || (o.demo_id !== undefined && o.demo_id !== "legacy" && !/^[0-9a-f]{32}$/.test(o.demo_id))
        || typeof o.session !== "string"
        || !Number.isFinite(o.seq) || !Number.isFinite(o.at)) return;
    if (!panes.some((pane) => pane.id === o.session
        || (pane.id === `demo:${o.session}` && demos.get(pane.id)?.session === o.session))) {
      flash(t("open.demoNotShown", { session: o.session }));
      return;
    }
    openDemoScene(o.session, false, o.demo_id ?? null);
    return;
  }
  if (o.kind === "board-open") {
    if (Object.keys(o).sort().join(",") !== "at,kind,seq,session" || typeof o.session !== "string"
        || !Number.isFinite(o.seq) || !Number.isFinite(o.at)) return;
    const boardId = `board:${o.session}`;
    if (panes.some((pane) => pane.id === boardId)) return;  // never reload or focus-steal a drawing
    if (!panes.some((pane) => pane.id === o.session)) {
      flash(t("open.boardNotShown", { session: o.session }));
      return;
    }
    openBoard(o.session);
    flash(t("open.boardOpened", { session: o.session }));
    return;
  }
  if (o.kind === "board-refresh") {
    if (Object.keys(o).sort().join(",") !== "at,kind,seq,session" || typeof o.session !== "string"
        || !Number.isFinite(o.seq) || !Number.isFinite(o.at)) return;
    const pane = panes.find((candidate) => candidate.id === `board:${o.session}`);
    // The request is deliberately inert without an already-open board. It
    // cannot create, navigate, focus, or reload a pane.
    if (!pane) return;
    const frame = $(".web", pane.el);
    frame.contentWindow?.postMessage({ type: "mesh-board-refresh-offer" }, location.origin);
    return;
  }
  if (typeof o.target !== "string") return;
  const name = o.target.split("/").pop();
  if (o.session == null) {
    openWeb(o.target, undefined, { watch: o.watch, mtime: o.mtime });
    flash(t("open.opened", { name }));
    return;
  }
  const anchor = panes.find((p) => p.id === o.session);
  if (!anchor) { flash(t("open.docNotShown", { name, session: o.session })); return; }
  openWeb(o.target, undefined, { anchor, watch: o.watch, mtime: o.mtime });
  flash(t("open.opened", { name }));
}

// Rendered Markdown cannot open windows (its sandbox forbids popups): on a
// click on an external link it asks the mesh instead. Only from a pane the
// server marked opens_links, only for http(s), only right after a user gesture.
// The same pane also reports its scroll position (a finite number, nothing else),
// which is given back after a reload.
// A pane's frame is trusted only for the document the mesh itself loaded in
// it: any later navigation inside the frame (a relative link to an .html next
// to a Markdown file) loads a page that must not inherit the link opener.
// Every load the mesh starts carries a fresh random token in its query (?dt=…),
// and the Markdown renderer echoes it in each message. A page reached by
// navigating inside the frame (a relative link to an .html next to the file)
// never has it; a reload of the same src (moving panes) keeps it.
function loadFrame(frame, src, viewAlreadyInvalidated = false) {
  requireLocalMesh();
  const pane = panes.find((candidate) => $(".web", candidate.el) === frame);
  if (pane) pane.identityLoad = "loading";
  if (!viewAlreadyInvalidated) pane?.invalidateActionView();
  pane?.resetFrameHistory();
  const token = crypto.randomUUID();
  const url = new URL(src, location.href);
  url.searchParams.set("dt", token);
  frame.dataset.token = token;
  frame.src = url.pathname + url.search + url.hash;
  frame.dataset.src = src;     // what show() compares, without the token
  pane?.header();
}

// "/view/<capability>/<absolute path>" -> the absolute path
function viewPath(href) {
  const parts = new URL(href, location.href).pathname.split("/");
  return parts[1] === "view" ? "/" + parts.slice(3).map(decodeURIComponent).join("/") : null;
}

// A sandboxed child cannot be read by its parent. Its local-history helper may
// therefore only report the exact signed /view URL it was about to follow; the
// outer frame's last Mesh-owned src supplies the capability to compare against.
function frameHistoryUrl(value, frame) {
  if (typeof value !== "string" || !frame?.dataset.token) return null;
  try {
    const next = new URL(value, location.href), initial = new URL(frame.src, location.href);
    const cap = (url) => {
      const parts = url.pathname.split("/");
      return parts[1] === "view" && parts.length > 3 ? parts[2] : null;
    };
    if (next.protocol !== location.protocol || next.origin !== location.origin
        || next.searchParams.get("dt") !== frame.dataset.token || !cap(next) || cap(next) !== cap(initial)) return null;
    return next.href;
  } catch { return null; }
}

// Bound requests to at most one per pane per second. Browser activation can
// last longer than this gap; this does not enforce one request per gesture.
const GOTO_GAP_MS = 1000;
window.addEventListener("message", (e) => {
  const p = panes.find((q) => $(".web", q.el)?.contentWindow === e.source);
  const w = p && find(p.id);
  const frame = p && $(".web", p.el);
  const historyEvent = e.data?.smesh;
  if (historyEvent === "frame-history-push" || historyEvent === "frame-history-ready") {
    if (w?.kind !== "web" || typeof e.data?.token !== "string" || e.data.token !== frame?.dataset.token
        || (historyEvent === "frame-history-push"
          ? (typeof e.data.navigation !== "string"
             || Object.keys(e.data).sort().join(",") !== "navigation,smesh,token,url")
          : Object.keys(e.data).sort().join(",") !== "smesh,token,url")) return;
    const href = frameHistoryUrl(e.data.url, frame);
    if (!href) return;
    if (historyEvent === "frame-history-push") p.observeFrameNavigation(href, e.data.navigation, frame);
    else p.acceptFrameReady(href);
    return;
  }
  // A document (rendered Markdown, a local HTML page) may ask the mesh to show
  // a conversation by agent and id: it names no host, port or path, the mesh
  // resolves it against its own state. "hello" is answered so the page knows it
  // can ask; "goto-session" also needs exact keys, a valid past-conversation id
  // and a user gesture made in this frame: the activation is mesh-wide, so the
  // frame must hold the focus (a click in it gives it), and one request per
  // pane per GOTO_GAP_MS is honoured (the activation lasts seconds; a page
  // could post many ids). It only shows (the mesh terminal running it, else its
  // card) and leaves the keyboard alone: it never resumes, starts or types anything.
  if (historyEvent === "hello" || historyEvent === "goto-session") {
    if (!w?.opensSessions || typeof e.data.token !== "string" || e.data.token !== frame?.dataset.token) return;
    const keys = Object.keys(e.data).sort().join(",");
    if (historyEvent === "hello") {
      if (keys === "smesh,token") e.source.postMessage({ smesh: "caps", sessions: true }, "*");
      return;
    }
    const { agent, id } = e.data;
    if (keys !== "agent,id,smesh,token" || typeof agent !== "string" || typeof id !== "string") return;
    const hid = `h:${agent}:${id}`;
    if (!isHist(hid) || !navigator.userActivation?.isActive || document.activeElement !== frame) return;
    const now = performance.now();
    if (now - (p.gotoAt ?? -Infinity) < GOTO_GAP_MS) return;
    p.gotoAt = now;
    // what openSession would show: the mesh terminal running it, else its card
    const live = liveOf(id, agent);
    const target = live?.kind === "mesh" ? live.id : hid;
    if (panes.some((q) => q.id === target)) { openSession(hid, { focus: false }); return; }   // activates that pane
    // else a new column right of the document's, so the document stays visible (the columns
    // are laid out again: framed documents, this one included, reload); with no room for one
    // (MAX_PANES, one-pane layout) the most recently active pane in another group is taken over, and
    // with no other group at all a new tab of the document's column
    let q = null;
    if (workspaceGroups.length < MAX_PANES && !narrow()) {
      const next = workspaceGroups[workspaceGroups.indexOf(p.group) + 1];
      q = addPane(null, next ? panes.indexOf(next.tabs[0]) : panes.length);
    } else {
      q = panes.filter((o) => o.group !== p.group).sort((a, b) => (b.activeAt ?? 0) - (a.activeAt ?? 0))[0] || null;
    }
    q ||= addTab(p.group, null);
    if (q) { setActive(q); openSession(hid, { focus: false }); }
    return;
  }
  if (!(w?.opensLinks || w?.keepsScroll) || typeof e.data?.token !== "string" || e.data.token !== $(".web", p.el).dataset.token) return;
  if (e.data.smesh === "nav" && w.opensLinks) {
    // a relative link to another Markdown file: loaded by the mesh, so it is trusted too
    const target = typeof e.data.url === "string" && viewPath(e.data.url);
    if (target && /\.(md|markdown)$/i.test(target)) openWeb(target);
    return;
  }
  if (e.data?.smesh === "scroll") {
    if (Number.isFinite(e.data.y)) w.scrollY = Math.max(0, e.data.y);
    return;
  }
  if (e.data?.smesh === "ready") {   // the code viewer is built after its frame's load event
    p.restoreScroll();
    return;
  }
  const url = e.data?.smesh === "open" && w.opensLinks ? e.data.url : null;
  if (typeof url !== "string") return;
  if (!/^https?:\/\//i.test(url) || !navigator.userActivation?.isActive) return;
  window.open(url, "_blank", "noopener,noreferrer");
});

let activeSeq = 0;   // orders panes by how recently they were active (Pane.activeAt)
function setActive(p, persist = false) {
  if (active === p) {
    syncMobileRawScrollAction();
    if (persist) saveLayout();
    return;
  }
  saveRecoveredLine();
  // the pane left had the focus outside its textarea (the phone input line, or a control the
  // switch went through); a focused textarea reports its own blur
  if (active?.mounted && document.activeElement !== active.term.textarea) active.reportFocus(false);
  active = p;
  endDirectLine();   // direct writing belongs to the pane left
  if (p) p.activeAt = ++activeSeq;
  paneTargets.setActive(p || null);
  for (const q of panes) if (q !== p) q.paneMenu.close("invalidate");
  for (const q of panes) q.el.classList.toggle("active", q === p);
  for (const g of workspaceGroups) g.el.classList.toggle("group-active", g === p?.group);
  p?.group?.select(p, false);
  if (p?.conn && p.inputAcks) p.renderRetainedInput();
  if (persist) saveLayout();
  updateKeys();
  syncMobileRawScrollAction();
  renderLists();
  renderInlineDictation();
}

// the phone key bar follows the active pane: shown while it holds a terminal
function updateKeys() {
  const keys = $("#keys"), visible = !!(touch && active?.conn && localMeshEffectsAllowed());
  const wasHidden = keys.hidden;
  keys.hidden = $("#line").hidden = !visible;
  if (!visible) endDirectLine();
  if (wasHidden && visible) keys.scrollLeft = 0;
}

function paneKind(p) {
  if (isContextualDiffPane(p.id)) return "contextual-diff";
  if (isDemoPane(p.id)) return "demo";
  if (isBoardPane(p.id)) return "board";
  if (isHist(p.id)) return "diff";
  if (isWebPane(p.id)) return "document";
  return "terminal";
}

// The displayed name of a pane kind (paneKind itself is a stored identifier).
const PANE_KIND_KEYS = {
  "contextual-diff": "pane.kind.contextualDiff", demo: "pane.kind.demo", board: "pane.kind.board",
  diff: "pane.kind.diff", document: "pane.kind.document", terminal: "pane.kind.terminal",
};
function paneKindLabel(p) { return t(PANE_KIND_KEYS[paneKind(p)]); }

class WorkspaceGroup {
  constructor() {
    this.id = `g${nextGroup++}`;
    this.tabs = [];
    this.selected = null;
    this.el = document.createElement("section");
    this.el.className = "workspace-group";
    this.tabsEl = document.createElement("div");
    this.tabsEl.className = "workspace-tabs";
    this.tabsEl.setAttribute("role", "tablist");
    this.tabsEl.setAttribute("aria-label", t("pane.tabsLabel"));
    this.body = document.createElement("div");
    this.body.className = "workspace-body";
    this.el.append(this.tabsEl, this.body);
  }
  add(p) {
    this.tabs.push(p);
    p.group = this;
    this.body.append(p.el);
    if (!this.selected) this.selected = p;
  }
  select(p, activate = true) {
    if (!this.tabs.includes(p)) return;
    for (const q of this.tabs) if (q !== p) cancelInlineCapture(q);
    this.selected = p;
    for (const q of this.tabs) q.el.classList.toggle("tab-hidden", q !== p);
    this.render();
    if (activate) {
      setActive(p, true);
    }
  }
  render() {
    this.tabsEl.replaceChildren();
    this.tabs.forEach((p, i) => {
      const b = document.createElement("button");
      const panelId = `workspace-${this.id}-panel-${i}`;
      const tabId = `workspace-${this.id}-tab-${i}`;
      p.el.id = panelId;
      p.el.setAttribute("role", "tabpanel");
      p.el.setAttribute("aria-labelledby", tabId);
      b.className = "workspace-tab";
      b.type = "button";
      b.id = tabId;
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(p === this.selected));
      b.setAttribute("aria-controls", panelId);
      b.tabIndex = p === this.selected ? 0 : -1;
      b.title = t("pane.tabTitle", { kind: paneKindLabel(p), name: $(".p-name", p.el).textContent || t("pane.newPane") });
      b.textContent = t("pane.tabLabel", { kind: paneKindLabel(p), name: $(".p-name", p.el).textContent || t("pane.newShort") });
      b.addEventListener("click", () => this.select(p));
      b.addEventListener("keydown", (e) => {
        const keys = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: this.tabs.length - 1 };
        if (!(e.key in keys)) return;
        e.preventDefault();
        const next = this.tabs[(keys[e.key] + this.tabs.length) % this.tabs.length];
        this.select(next);
        this.tabsEl.querySelector(`#workspace-${this.id}-tab-${this.tabs.indexOf(next)}`)?.focus();
      });
      this.tabsEl.append(b);
      if (i === 0) b.dataset.first = "";
    });
    const add = document.createElement("button");
    add.className = "workspace-tab-add";
    add.type = "button";
    add.title = t("pane.addTab");
    add.setAttribute("aria-label", t("pane.addTab"));
    add.textContent = "+";
    add.addEventListener("click", () => addTab(this));
    this.tabsEl.append(add);
    const controls = document.createElement("span");
    controls.className = "workspace-move";
    for (const [label, delta] of [[t("pane.moveLeft"), -1], [t("pane.moveRight"), 1]]) {
      const b = document.createElement("button");
      b.className = "workspace-move-button";
      b.type = "button";
      b.title = label;
      b.setAttribute("aria-label", label);
      b.textContent = delta < 0 ? "←" : "→";
      b.disabled = !workspaceGroups.includes(this) || workspaceGroups.indexOf(this) + delta < 0 || workspaceGroups.indexOf(this) + delta >= workspaceGroups.length;
      b.addEventListener("click", () => moveGroup(this, delta));
      controls.append(b);
    }
    this.tabsEl.append(controls);
    for (const p of this.tabs) p.el.classList.toggle("tab-hidden", p !== this.selected);
  }
}

function moveGroup(group, delta) {
  const i = workspaceGroups.indexOf(group), j = i + delta;
  if (i < 0 || j < 0 || j >= workspaceGroups.length) return;
  workspaceGroups.splice(i, 1);
  workspaceGroups.splice(j, 0, group);
  layout();
  saveLayout();
}

function groupAtPaneOffset(at) {
  const right = panes[at];
  return right?.group ? workspaceGroups.indexOf(right.group) : workspaceGroups.length;
}

function addTab(group, id = null) {
  if (!group) return null;
  const p = new Pane();
  panes.push(p);
  group.add(p);
  layout();
  group.select(p);
  saveLayout();
  if (id && (find(id) || isHist(id))) p.show(id);
  return p;
}

// Columns are workspace groups separated by draggable grips; widths kept as flex ratios.
function layout() {
  // Widths are flex-grow ratios. Rescale them so they always sum to the pane
  // count: a lone pane keeping a 0.6 share from a split would fill only 60%.
  const grows = workspaceGroups.map((g) => parseFloat(g.el.style.flexGrow) || 1);
  const sum = grows.reduce((a, b) => a + b, 0);
  workspaceGroups.forEach((g, i) => { g.el.style.flexGrow = (grows[i] * workspaceGroups.length) / sum; });
  const box = $("#panes");
  box.replaceChildren();
  workspaceGroups.forEach((g, i) => {
    if (i) box.append(makeGrip(workspaceGroups[i - 1], g));
    box.append(g.el);
    for (const p of g.tabs) { p.mount(); p.header(); }
    g.render();
  });
  $("#btn-split").disabled = workspaceGroups.length >= MAX_PANES;
}

function makeGrip(left, right) {
  const g = document.createElement("div");
  g.className = "grip";
  g.title = t("pane.gripTitle");
  g.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    g.setPointerCapture(e.pointerId);
    g.classList.add("drag");
    document.body.classList.add("resizing");
    const a = left.el.getBoundingClientRect(), b = right.el.getBoundingClientRect();
    const total = a.width + b.width, grow = parseFloat(left.el.style.flexGrow || 1) + parseFloat(right.el.style.flexGrow || 1);
    const move = (ev) => {
      const w = Math.min(total - 160, Math.max(160, ev.clientX - a.left));
      left.el.style.flexGrow = (grow * w) / total;
      right.el.style.flexGrow = (grow * (total - w)) / total;
    };
    const up = () => {
      g.classList.remove("drag");
      document.body.classList.remove("resizing");
      g.removeEventListener("pointermove", move);
      saveLayout();
      active?.focus();
    };
    g.addEventListener("pointermove", move);
    g.addEventListener("pointerup", up, { once: true });
  });
  g.addEventListener("dblclick", () => { left.el.style.flexGrow = right.el.style.flexGrow = 1; saveLayout(); });
  return g;
}

function addPane(id, at = panes.length) {
  if (!meshContext || meshStopped) return null;
  if (workspaceGroups.length >= MAX_PANES) return null;
  const groupAt = groupAtPaneOffset(at);
  const p = new Pane();
  panes.splice(at, 0, p);
  const g = new WorkspaceGroup();
  workspaceGroups.splice(groupAt, 0, g);
  g.add(p);
  layout();
  setActive(p);
  if (id && (find(id) || isHist(id))) p.show(id);
  return p;
}

// Kill a mesh session after asking (from its pane, or from its menu in the list).
function paneMenuActions(pane) {
  if (!localMeshEffectsAllowed()) {
    return MeshPaneActions.availableActions({
      kind: pane.actionKind, multiple: panes.length > 1,
    }).filter((action) => action.id === "close");
  }
  if (!["mesh", "web", "board"].includes(pane.actionKind)) return [];
  const session = pane.id && find(pane.id);
  return MeshPaneActions.availableActions({
    kind: pane.actionKind, multiple: panes.length > 1,
    rawCodex: isCodexTerminal(session), fileWeb: session?.kind === "web" && session.type === "file",
    watching: !!session?.watch,
  });
}

function observePaneActions(pane) {
  const session = pane.id && find(pane.id);
  const sessionId = pane.actionKind === "mesh" ? pane.id : pane.actionKind === "board" ? session?.session : null;
  const identity = sessionId ? paneTargets.identity(sessionId) : null;
  paneTargets.observePane({
    pane, id: pane.id, name: identity ? identity.name : session?.name || pane.id || null,
    sessionId: sessionId || null,
    displayName: $(".p-full-name", pane.el).textContent || "—",
    created: identity ? identity.created : null, view: pane.actionView, kind: pane.actionKind,
    available: !pane.actionDisposed && (!["mesh", "board"].includes(pane.actionKind) || !!identity),
  });
}

function canFocusPaneAction(element) {
  if (!(element instanceof HTMLElement) || !element.isConnected || element.closest("[hidden], [inert]")
      || element.matches(":disabled") || element.getClientRects().length === 0) return false;
  const style = getComputedStyle(element);
  if (style.visibility === "hidden" || style.display === "none") return false;
  const owner = element.closest(".pane");
  if (owner && !panes.some((pane) => pane.el === owner && pane.mounted && pane === active)) return false;
  const modal = document.querySelector("dialog:modal");
  return !modal || modal.contains(element);
}

function focusPaneActionFallback() {
  const current = document.activeElement;
  if (current !== document.body && canFocusPaneAction(current)) return;
  const modal = document.querySelector("dialog:modal");
  if (modal) {
    const candidate = [...modal.querySelectorAll('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])')].find(canFocusPaneAction);
    candidate?.focus({ preventScroll: true }); return;
  }
  const terminalInput = touch ? $("#line-text") : active?.term?.textarea;
  if (active?.conn && canFocusPaneAction(terminalInput)) { terminalInput.focus({ preventScroll: true }); return; }
  for (const candidate of [$("#btn-mobile-actions"), $("#btn-menu"), $("#btn-new")]) {
    if (canFocusPaneAction(candidate)) { candidate.focus({ preventScroll: true }); return; }
  }
}

const guardedPaneStop = MeshPaneActions.createStopGuard({
  valid: (target) => paneTargets.valid(target) && Number.isFinite(target.created),
  confirm: (target) => confirm(t("stop.confirmPane", { displayName: target.displayName, name: target.name })),
  dispatch: async (target) => {
    const session = find(target.id);
    const name = target.name;
    if (!name || session?.created !== target.created) throw new Error(t("stop.sessionChanged"));
    const response = await requestLocal(`/api/kill/${encodeURIComponent(name)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ created: target.created }),
    });
    if (!response.ok) throw new Error(t("stop.refusedHttp", { status: response.status }));
    await refresh();
    const pane = target.pane;
    const current = paneTargets.identity(target.id);
    if (panes.includes(pane) && pane.id === target.id && pane.actionView === target.view
        && (!current || (current.name === target.name && current.created === target.created))) pane.clear();
  },
});

async function stopPaneTarget(target) {
  const hold = {};
  paneStopHolds.add(hold);
  renderReloadStatus();
  try { return await guardedPaneStop(target); }
  finally { paneStopHolds.delete(hold); renderReloadStatus(); }
}

async function runPaneAction(action, target) {
  const pane = target.pane;
  if (!MeshPaneActions.actionDefinition(action) || !paneTargets.valid(target) || !panes.includes(pane) || !paneMenuActions(pane).some((entry) => entry.id === action)) {
    flash(t("pane.actionCancelled")); return;
  }
  if (action === "stop") {
    const outcome = await stopPaneTarget(target);
    if (outcome === "refused") flash(t("stop.refused"));
  } else if (action === "close") closePane(pane);
  else if (action === "file") openAttach();
  else if (action === "compose") openCompose();
  else if (action === "browse") { const bases = sessionBases(target.id); if (bases[0]) openTree(bases[0], bases); }
  else if (action === "redraw") pane.redraw();
  else if (action === "folder") openFolderDialog(target.id);
  else if (action === "raw") pane.enableCodexRawScrollback();
  else if (action === "demo") await chooseDemoScene(target);
  else if (action === "reload") await pane.reloadWeb(target);
  else if (action === "watch") await pane.toggleWatch();
  else if (action === "newtab") {
    const session = find(target.id);
    if (session?.kind === "board") {
      if (paneTargets.valid(target)) window.open(`/static/board.html?v=${encodeURIComponent(loadedVersion)}&session=${encodeURIComponent(session.session)}`, "_blank", "noopener");
      return;
    }
    const described = session && await describeWeb(session.target);
    if (described && paneTargets.valid(target)) window.open(viewUrl(described), "_blank", "noopener");
  }
}

async function closeSession(id) {
  const s = find(id);
  if (!s || !Number.isFinite(s.created) || !rowAuthoritative(s)
      || !confirm(t("stop.confirmSession", { name: s.name }))) return;
  const shown = panes.filter((pane) => pane.id === s.id)
    .map((pane) => ({ pane, view: pane.actionView }));
  const response = await requestLocal(`/api/kill/${encodeURIComponent(s.name)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ created: s.created }),
  });
  if (!response.ok) { flash(t("stop.refusedHttp", { status: response.status })); return; }
  hostSilence.noteClosed(s.name);
  await refresh();
  const current = find(s.id);
  if (!current || current.created === s.created) {
    for (const { pane, view } of shown) {
      if (panes.includes(pane) && pane.id === s.id && pane.actionView === view) pane.clear();
    }
  }
}

function closePane(p) {
  if (panes.length < 2) return;
  const i = panes.indexOf(p);
  if (i < 0) return;
  const pending = [...p.inputAcks.values()].reduce((sum, entry) => sum + entry.input.pendingBytes, 0);
  const dirty = [...p.inputAcks.values()].some((entry) => entry.lease?.dirty) ||
    !!p.recoveredLineDrafts?.size || !!p.recoveredComposeDraft?.text ||
    (recoveredLineTarget?.pane === p && !!line.value);
  if ((pending || dirty) && !confirm((pending ? t("conn.inputCloseConfirm", { count: pending }) : "") +
      (dirty ? `${pending ? "\n\n" : ""}${t("conn.inputCloseDraftConfirm")}` : ""))) return;
  if (pending) for (const entry of p.inputAcks.values()) {
    if (entry.input.pendingBytes) entry.input.discard();
  }
  const group = p.group;
  leaveSeen(p.id);
  panes.splice(i, 1);
  group.tabs.splice(group.tabs.indexOf(p), 1);
  p.dispose();
  if (!group.tabs.length) {
    workspaceGroups.splice(workspaceGroups.indexOf(group), 1);
    group.selected = null;
  }
  else if (group.selected === p) group.selected = group.tabs[Math.max(0, group.tabs.length - 1)];
  layout();
  const fallback = panes.includes(active) ? active
    : (group.tabs.includes(group.selected) ? group.selected : panes[Math.max(0, i - 1)]);
  setActive(fallback);
  saveLayout();
  renderLists();
}

matchMedia("(max-width: 760px)").addEventListener("change", () => {
  if (!narrow() && mobileActionsSheet.open) mobileActionsSheet.close();
  for (const p of panes) p.header();
  syncMobileChrome();
});

function saveLayout() {
  if (restoringWorkspace) return;
  const ephemeral = (id) => isContextualDiffPane(id) || isDemoPane(id);
  const retainedBack = (p) => ephemeral(p.back) ? undefined : p.back || undefined;
  const descriptor = (p) => {
    if (p.layoutTarget) return { id: p.layoutTarget, kind: p.layoutType || "terminal" };
    if (!ephemeral(p.id)) return { id: p.id, kind: paneKind(p), back: retainedBack(p) };
    // A phone diff temporarily replaces its terminal view. Reload restores that
    // prior view, never the ephemeral diff id, capability, binding or text.
    return p.back && find(p.back) ? { id: p.back, kind: paneKind({ id: p.back }) } : { id: null, kind: "terminal" };
  };
  const v1 = { active: ephemeral(active?.id) ? retainedBack(active) ?? null : active?.id ?? null, columns: workspaceGroups.map((g) => ({
    grow: parseFloat(g.el.style.flexGrow || 1), active: Math.max(0, g.tabs.filter((p) => descriptor(p)).indexOf(g.selected)),
    tabs: g.tabs.map(descriptor).filter(Boolean),
  })).filter((g) => g.tabs.length) };
  store.set("workspace.v1", v1); // retained until all installed clients understand v2
  const v2 = MeshWorkspaceSpec.migrateV1(v1);
  if (v2) store.set("workspace.v2", v2);
  store.set("layout", panes.map((p) => {
    const saved = descriptor(p);
    return saved && { id: saved.id, grow: parseFloat(p.el.style.flexGrow || 1), back: saved.back };
  }).filter(Boolean));
  // A hash is deliberately the old, shareable flat layout.  It cannot express
  // local tab groups, so never let a self-written hash override workspace.v1
  // at the next boot (and silently discard tabs after the first three).
  const hasTabs = workspaceGroups.some((g) => g.tabs.length > 1);
  const ids = panes.map(descriptor).filter(Boolean).map((p) => encodeURIComponent(p.id || "")).join(",");
  const localHash = hasTabs || !ids.replace(/,/g, "") ? "" : `#${ids}`;
  // Remember the hash written by this browser.  A flat URL cannot retain the
  // selected column, so it must not trump workspace.v1 on reload.  A different
  // hash is an intentionally opened, shareable layout and still takes priority.
  store.set("workspace.hash", localHash);
  // The state of the entry stays: the Projects view marks its entries (static/work-nav.ts).
  history.replaceState(history.state, "", localHash ? localHash : location.pathname);
}

$("#btn-split").addEventListener("click", () => {
  const p = addPane();
  if (p) flash(t("pane.newColumn"));
});

// ---------------------------------------------------------------- font size

function setFont(size) {
  fontSize = Math.min(22, Math.max(9, size));
  store.set("font", fontSize);
  for (const p of panes) { p.term.options.fontSize = fontSize; p.refit(); }
  flash(t("font.size", { size: fontSize }));
  active?.focus();
}
$("#btn-font-down").addEventListener("click", () => setFont(fontSize - 1));
$("#btn-font-up").addEventListener("click", () => setFont(fontSize + 1));

// ---------------------------------------------------------------- sidebar width

{
  const side = store.get("side", 320);
  document.documentElement.style.setProperty("--side", `${side}px`);
  const g = $("#side-grip");
  g.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    g.setPointerCapture(e.pointerId);
    g.classList.add("drag");
    document.body.classList.add("resizing");
    const move = (ev) => {
      const w = Math.min(window.innerWidth * 0.6, Math.max(200, ev.clientX));
      document.documentElement.style.setProperty("--side", `${w}px`);
    };
    g.addEventListener("pointermove", move);
    g.addEventListener("pointerup", () => {
      g.removeEventListener("pointermove", move);
      g.classList.remove("drag");
      document.body.classList.remove("resizing");
      store.set("side", parseInt(getComputedStyle(document.documentElement).getPropertyValue("--side")));
      active?.focus();
    }, { once: true });
  });
  g.addEventListener("dblclick", () => { document.documentElement.style.setProperty("--side", "320px"); store.set("side", 320); });
}

// ---------------------------------------------------------------- phone keys

const KEYS = { esc: "\x1b", tab: "\t", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", cc: "\x03", enter: "\r" };
const ACTIONS = { nl: () => sendKeyToAgent(active.newlineSeq()), copy: () => active.copySelection(), paste: () => (lineDirect ? pasteClipboardDirect() : active.pasteClipboard()),
                  compose: () => openCompose(), file: () => openAttach() };
function setCtrl(on) { ctrlArmed = on; $('#keys [data-k="ctrl"]').classList.toggle("on", on); }
// A tap on a key of the bar never moves the focus, so it never opens or closes the
// soft keyboard: the input line keeps the focus when it has it, and nothing
// editable takes it otherwise. A tap's mousedown comes only after the finger
// lifted without panning, so this leaves the strip's horizontal scroll alone.
// ✎ and 📎 open a dialog, which takes the focus and gives it back on close: they
// keep the browser's own handling. A word the keyboard is still composing ends
// only when the line loses the focus: that tap lets the button take it, so the
// word goes before the key, and the line gets it back right after.
const KEYS_OWN_FOCUS = new Set(["compose", "file"]);
let keyTapRefocus = false;
function keepFocusOnKeyTap(e) {
  const k = e.target.closest("button")?.dataset.k;
  keyTapRefocus = false;
  if (!k || KEYS_OWN_FOCUS.has(k)) return;
  if (document.activeElement === line && lineComposing) keyTapRefocus = true;
  else e.preventDefault();
}
$("#keys").addEventListener("mousedown", keepFocusOnKeyTap);
// Let the browser distinguish a tap from a horizontal pan.  Activating on
// pointerdown made every swipe across this overflow strip send the key that
// happened to be under the finger when the gesture started.
$("#keys").addEventListener("click", (e) => {
  const k = e.target.closest("button")?.dataset.k;
  if (keyTapRefocus) { keyTapRefocus = false; line.focus(); }
  if (!k || !active) return;
  e.preventDefault();
  if (k === "ctrl") { if (ctrlArmed || !lineDirect || directKeyAllowed()) setCtrl(!ctrlArmed); }   // arming it: the held text goes first, as typed
  else if (ACTIONS[k]) return ACTIONS[k]();
  else if (k === "enter" && lineDirect) enterLine();
  else if (sendKeyToAgent(KEYS[k]) && k === "cc") endDirectLine();   // a control key ends direct writing
});

// ---------------------------------------------------------------- list

// Browser-local shortcuts are keyed by the provider's resumable conversation
// identity, never by a mutable Mesh name or by a transient PTY id.
//
// Every agent the History index reads (claude, codex, pi, opencode, gemini, agy, copilot, vibe) can be
// pinned once Mesh knows the conversation id: the agent's hooks or process (discover.py) or, when those
// name none, the one conversation the History index holds for the session's folder since it started
// (server._apply_history_identity). A closed pin opens that conversation's History card, which shows
// what it is before it is resumed; the card also holds the agent's exact resume command. A pin from such a
// guess (identity_source "history_cwd") is stored with guessed: true and the card says so: it never resumes
// by itself, and the server treats a guessed id as display-only (server._resume_argv, live_where).
const PIN_HISTORY_AGENTS = ["claude", "codex", "pi", "opencode", "gemini", "agy", "copilot", "vibe"];
const PIN_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{7,63}$/;
function validPin(p) {
  return Boolean(p) && typeof p.id === "string" && typeof p.label === "string" && p.label.length <= 256
    && PIN_HISTORY_AGENTS.includes(p.agent) && PIN_ID.test(p.id) && (p.guessed === undefined || p.guessed === true);
}
// What a live session may be pinned as, or null: {agent, id, guessed} (guessed: the id comes from the folder's history).
function pinIdentity(s) {
  const a = s?.agent, id = a?.session_id;
  return typeof id === "string" && PIN_HISTORY_AGENTS.includes(a.type) && PIN_ID.test(id)
    ? { agent: a.type, id, guessed: a.identity_source === "history_cwd" } : null;
}
function pinnedSessions() {
  const value = store.get("pinnedSessions", []);
  if (!Array.isArray(value)) return [];
  return value.filter(validPin).slice(0, 100);
}
function isPinned(agent, id) { return pinnedSessions().some(p => p.agent === agent && p.id === id); }
function togglePin(agent, id, label, guessed = false) {
  if (localActionUnavailable()) return;
  const pins = pinnedSessions();
  const exists = pins.some(p => p.agent === agent && p.id === id);
  if (!exists && pins.length >= 100) return flash(t("pins.limit", { max: 100 }));
  const pin = { agent, id, label: String(label || id).slice(0, 256), ...(guessed ? { guessed: true } : {}) };
  if (!exists && !validPin(pin)) return;   // never store what a pin could not reopen
  const next = exists ? pins.filter(p => p.agent !== agent || p.id !== id) : [pin, ...pins];
  try { localStorage.setItem("mesh.pinnedSessions", JSON.stringify(next)); }
  catch { flash(t("pins.storageUnavailable")); return; }
  // An explicit pin change must update the sidebar even when its item retains
  // keyboard focus; passive refreshes normally defer while an item is focused.
  renderList(true);
  renderHistList();
  if (exploring) renderExplorer(true);
  for (const pane of panes) if (pane.hist?.d) pane.renderHist();
  flash(exists ? t("pins.unpinned") : t("pins.pinned"));
}
window.addEventListener("storage", e => { if (e.key === "mesh.pinnedSessions") renderLists(); });

function pinnedHtml(query) {
  const pins = pinnedSessions().filter(p => !query || `${p.label} ${p.agent} ${p.id}`.toLowerCase().includes(query));
  if (!pins.length) return "";
  const f = folded.has("pins");
  return `<section class="pinned-sessions"><button class="group ${f ? "folded" : ""}" data-group="pins" title="${esc(t("pins.groupTitle"))}">
    <span class="chev">▾</span><span>${esc(t("pins.groupLabel"))}</span><span class="count">${pins.length}</span></button>` +
    (f ? "" : pins.map(p => {
      const live = liveOf(p.id, p.agent);
      const id = live?.kind === "mesh" ? live.id : `h:${p.agent}:${p.id}`;
      const shownLabel = live?.kind === "mesh" ? label(live) : p.label;
      const hint = live?.kind === "mesh" ? t("pins.running") : p.guessed ? t("pins.guessed") : t("pins.openCard");
      return `<div class="pin-row"><button class="item hitem" data-id="${esc(id)}"><div class="top"><span class="dot ${live ? state(live) : "hist"}"></span><span class="name">${esc(shownLabel)}</span>${live?.kind === "mesh" ? accountBadgeHtml(live) : ""}<span class="tag">${esc(p.agent)}</span></div><div class="meta">${esc(hint)}</div></button><button class="pin-remove" data-unpin-agent="${esc(p.agent)}" data-unpin-id="${esc(p.id)}" aria-label="${esc(t("pins.unpinLabel", { label: shownLabel }))}" title="${esc(t("pins.unpin"))}">×</button></div>`;
    }).join("")) + `</section>`;
}

// A missing alias indicates only the Mesh default, not the OAuth account in use.
const shortAccountLabel = (value) => [...String(value)].slice(0, 24).join("");
const accountLabel = (s) => (typeof s?.account === "string" && s.account ? [...String(s.account_label || s.account)].slice(0, 24).join("")
  : (s?.account == null || s.account === "") && s?.kind === "mesh"
    && ["claude", "codex"].includes(s.agent?.type || s.known_agent) ? t("list.accountDefault") : "");
const accountTitle = (s, shown) => s?.account ? t("list.accountTitle", { label: shown }) : t("list.accountDefaultTitle");
// Keep the colors of active aliases; returning aliases reuse their saved color
// when it is free. The registry is browser-local and scoped to this Mesh.
let accountColorRows = null, accountColorPrefix = null, accountColors = new Map(), activeAccountColors = new Map();
function accountColor(s) {
  if (typeof s?.account !== "string" || !s.account) return "";
  const prefix = meshContext?.storagePrefix ?? null;
  if (accountColorPrefix !== prefix) {
    accountColorPrefix = prefix;
    accountColorRows = null;
    activeAccountColors = new Map();
    const saved = store.get("account-colors.v1", []);
    accountColors = new Map(Array.isArray(saved) ? saved.filter(pair => Array.isArray(pair)
      && pair.length === 2 && typeof pair[0] === "string" && pair[0].length > 0 && pair[0].length <= 128
      && Number.isInteger(pair[1]) && pair[1] >= 0 && pair[1] < 12).slice(0, 1024) : []);
  }
  if (accountColorRows !== data.mesh) {
    accountColorRows = data.mesh;
    const aliases = [...new Set(data.mesh.map(row => row.account)
      .filter(alias => typeof alias === "string" && alias && alias.length <= 128))].sort();
    const used = new Set(), next = new Map(), pending = [];
    // Current aliases keep their slots first. If more than twelve were active,
    // resolve a surviving collision whenever a slot becomes available.
    for (const alias of aliases) {
      const slot = activeAccountColors.get(alias);
      if (slot !== undefined && (!used.has(slot) || used.size === 12)) {
        used.add(slot);
        next.set(alias, slot);
      } else pending.push(alias);
    }
    let changed = false;
    for (const alias of pending) {
      let hash = 2166136261;
      for (const c of alias) hash = Math.imul(hash ^ c.codePointAt(0), 16777619);
      let slot = activeAccountColors.get(alias) ?? accountColors.get(alias) ?? (hash >>> 0) % 12;
      if (used.size < 12) while (used.has(slot)) slot = (slot + 1) % 12;
      used.add(slot);
      next.set(alias, slot);
      if (accountColors.get(alias) !== slot && (accountColors.has(alias) || accountColors.size < 1024)) {
        accountColors.set(alias, slot);
        changed = true;
      }
    }
    activeAccountColors = next;
    if (changed) store.set("account-colors.v1", [...accountColors]);
  }
  const color = activeAccountColors.get(s.account);
  return color === undefined ? "" : String(color);
}
function accountBadgeHtml(s) {
  const shown = accountLabel(s);
  const color = accountColor(s);
  return shown ? `<span class="account-badge"${color === "" ? "" : ` data-account-color="${color}"`} title="${esc(accountTitle(s, shown))}">${esc(shown)}</span>` : "";
}
function showAccountBadge(element, s) {
  const shown = accountLabel(s);
  const color = accountColor(s);
  element.hidden = !shown;
  element.textContent = shown;
  element.title = shown ? accountTitle(s, shown) : "";
  if (color === "") delete element.dataset.accountColor;
  else element.dataset.accountColor = color;
}

// A focused or dragged row holds list reordering, but account metadata must
// still follow the latest inventory. Updating just this non-interactive span
// keeps the row and its focus intact.
function syncAccountBadges(skipHeld = false) {
  for (const row of document.querySelectorAll("#list .item[data-id]")) {
    if (skipHeld && (listWindow.keep(row) || (row.parentElement && listWindow.keep(row.parentElement)))) continue;
    const s = find(row.dataset.id);
    const shown = s?.kind === "mesh" && accountLabel(s);
    let badge = row.querySelector(".account-badge");
    if (!shown) { badge?.remove(); continue; }
    if (!badge) {
      const name = row.querySelector(".top .name");
      if (!name) continue;
      badge = document.createElement("span");
      badge.className = "account-badge";
      name.after(badge);
    }
    showAccountBadge(badge, s);
  }
}

function itemHtml(s, opts = {}) {
  const a = s.agent;
  // A Mesh-launched CLI can be known even when it has no transcript/status or
  // safe resume contract. Keep that identity distinct from `agent`: the latter
  // remains the discovered, resumable Claude/Codex shape.
  const tag = a ? `<span class="tag ${esc(a.type)}">${esc(a.type)}</span>`
    : s.known_agent ? `<span class="tag known-agent" title="${esc(t("list.knownAgentTitle"))}">${esc(s.known_agent)}</span>`
    : `<span class="tag">${esc((s.cmd || "").split(" ")[0].split("/").pop())}</span>`;
  const where = s.kind === "mesh" ? `${s.name} · ${short(s.cwd)}` : `${short(s.cwd)} · ${s.tty.replace("/dev/", "")}`;
  const shown = panes.some((p) => p.id === s.id), here = active?.id === s.id;
  const sure = rowAuthoritative(s), rowSt = s.kind === "mesh" ? Progress.rowState(s, hostSilence.silent()) : "ready";
  const drag = s.kind === "mesh" && sure ? ` draggable="true" title="${esc(t("list.itemDragTitle"))}"` : "";
  const st = state(s), mine = st === "wait" || st === "unread";
  const stText = STATE_TEXT[st] ? `<span class="st ${st}">${esc(t(STATE_TEXT[st]))}${st === "wait" && a.since ? ` · ${esc(ago(a.since))}` : ""}</span> · ` : "";
  const changed = s.kind === "mesh" && boardModified.has(s.id);
  // what needs me shows what the agent said or asks; otherwise the last prompt
  const preview = mine ? a.said || a.last : a?.last;
  const nativeVoice = s.kind === "mesh" && inlineDictation?.peekSession(s.name, s.created);
  const voice = nativeVoice;
  const voiceLabel = voice ? inlineStateLabel(voice) : "";
  const voiceBadge = voice?.outstanding ? `<span class="dictation-label" data-state="${esc(voice.state)}">${esc(voiceLabel)}</span>` : "";
  const rowBadge = rowSt === "ready" ? "" : `<span class="row-state ${rowSt}">${esc(t(`sessions.row.${rowSt}`))}</span>`;
  const row = `<button class="item ${here ? "sel" : shown ? "shown" : ""}${s.folder ? " in-folder" : ""}${mine ? ` ${st}` : ""}${rowSt === "ready" ? "" : ` row-${rowSt}`}" data-id="${esc(s.id)}"${opts.todo ? "" : drag}>
    <div class="top"><span class="dot ${rowSt === "ready" ? st : "pending"}" aria-hidden="true"></span><span class="name">${esc(label(s))}</span>${accountBadgeHtml(s)}${changed ? `<span class="board-badge" aria-label="${esc(t("list.boardModified"))}" title="${esc(t("list.boardModified"))}"></span>` : ""}${s.pending ? `<span class="tag" title="${esc(t("list.pendingRestart"))}">⏳</span>` : ""}${s.wake_unconfirmed === true ? `<span class="tag wake-unconfirmed" role="img" aria-label="${esc(t("list.wakeUnconfirmed"))}" title="${esc(t("list.wakeUnconfirmed"))}">✉?</span>` : ""}${questionBadgeHtml(s)}${tag}<span class="ago">${esc(ago(lastSeen(s)))}</span></div>
    <div class="meta">${rowBadge}${stText}${esc(where)} ${voiceBadge}</div>
    ${s.notice === "opencode-unsupported" ? `<div class="last">${esc(t("list.opencodeUnsupportedNotice"))}</div>` : ""}
    ${s.notice === "opencode-unreadable" ? `<div class="last">${esc(t("list.opencodeUnreadableNotice"))}</div>` : ""}
    ${preview ? `<div class="last">${esc(preview)}</div>` : ""}
  </button>`;
  if (!Progress.RETRYABLE.has(rowSt)) return row;
  const retry = t("sessions.row.retry", { name: label(s) });
  return `<div class="row-wrap" data-id="${esc(s.id)}">${row}<button type="button" class="row-retry" data-retry="${esc(s.id)}" aria-label="${esc(retry)}" title="${esc(retry)}">↻</button></div>`;
}

// Whether a row may be acted on as observed fact (closed, filed, dragged): not a provisional row, a
// row the server has not described yet, a row of a skeleton listing, or any row while the PTY host is
// silent (static/sessions-contract.ts, host-silence.ts).
const rowAuthoritative = (s) => s?.kind !== "mesh"
  || Progress.authoritative(s, s.provisional ? null : lastListing, hostSilence.silent());

// outside terminals grouped by what owns them
function groups(list) {
  const by = new Map();
  for (const s of list) by.set(s.host, [...(by.get(s.host) || []), s]);
  const order = ["SSH", "Terminator"];
  return [...by].sort((a, b) => {
    const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || b[1].length - a[1].length;
  });
}

function groupHtml(key, title, list, emptyHtml = "") {
  const f = folded.has(key);
  const busy = list.filter((s) => state(s) === "busy").length;
  return `<button class="group ${f ? "folded" : ""}" data-group="${esc(key)}">
      <span class="chev">▾</span><span>${esc(title)}</span>
      <span class="count">${busy ? `<span class="dot busy"></span> ` : ""}${list.length}</span></button>` +
    (f ? "" : rowsHtml(`group:${key}`, list) || emptyHtml);
}
// The rows of one run (a status section, a folder, the loose sessions, a group of outside terminals),
// windowed in a long list (static/list-window.ts).
function rowsHtml(runKey, list, opts = {}) {
  return listWindow.runHtml(runKey, list, (s) => s.id, (s) => itemHtml(s, opts));
}

// ---- mesh folders, names and order (stored on the server, organize.py)
// Folding is per browser; everything else is the same on every device.

async function organize(op, beforeRefresh = null) {
  if (localActionUnavailable()) return false;
  const r = await requestLocal("/api/organize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(op) });
  if (!r.ok) { flash(serverText(await r.text())); return false; }
  beforeRefresh?.(await r.json());
  await refresh();
  return true;
}

function folderHtml(name, list) {
  const key = `dir:${name}`, f = folded.has(key);
  const busy = list.filter((s) => state(s) === "busy").length;
  return `<div class="folder" data-folder="${esc(name)}">
    <div class="folder-toolbar">
      <button class="group folder-head ${f ? "folded" : ""}" data-group="${esc(key)}" data-folder-head="${esc(name)}" draggable="true"
              title="${esc(t("folder.dragTitle"))}">
        <span class="chev">▾</span><span class="fname">📁 ${esc(name)}</span>
        <span class="count">${busy ? `<span class="dot busy"></span> ` : ""}${list.length}</span></button>
      <span class="folder-actions">
        <button type="button" class="folder-action" data-folder-rename="${esc(name)}" aria-label="${esc(t("folder.renameLabel", { name }))}" title="${esc(t("folder.rename"))}">✎</button>
        <button type="button" class="folder-action folder-delete" data-folder-del="${esc(name)}" aria-label="${esc(t("folder.deleteLabel", { name }))}" title="${esc(t("folder.deleteTitle"))}">✕</button>
      </span>
    </div>
    ${f ? "" : rowsHtml(key, list) || `<div class="meta folder-empty">${esc(t("folder.empty"))}</div>`}
  </div>`;
}

function meshHtml(mesh) {
  const key = "mesh", f = folded.has(key);
  const busy = mesh.filter((s) => state(s) === "busy").length;
  const head = `<button class="group" data-group="mesh" data-root="1">
      <span class="chev">▾</span><span>${esc(t("list.meshGroup"))}</span>
      <span class="count">${busy ? `<span class="dot busy"></span> ` : ""}${mesh.length}</span></button>`;
  if (f) return head;
  const folders = data.folders || [];
  const inFolder = (name) => mesh.filter((s) => s.folder === name);
  const loose = mesh.filter((s) => !s.folder || !folders.includes(s.folder));
  return head +
    folders.map((name) => folderHtml(name, inFolder(name))).join("") +
    `<div class="loose" data-root="1">${rowsHtml("loose", loose) ||
      (mesh.length ? "" : `<div class="meta" style="margin:4px 10px 10px">${esc(t(inventoryLoaded ? "list.meshEmpty" : "sessions.row.loadingList"))}</div>`)}</div>` +
    `<button class="add-folder" data-add-folder="1">${esc(t("folder.add"))}</button>`;
}

// This is an evidence display, not a project/worktree browser. It shows only
// observer facts tied to CWDs already in the authenticated Mesh listing. There
// are no controls: it cannot create, resume or alter a session or repository.
function portfolioHtml(portfolio) {
  // The first synchronous render happens before the first /api/sessions
  // response. Silence is more truthful than briefly calling the live host
  // unavailable during that startup window.
  if (portfolio == null) return "";
  if (portfolio.mesh_sessions?.state !== "observed" || !Array.isArray(portfolio.mesh_sessions.directories)
      || !portfolio.mesh_sessions.directories.every((row) => row && typeof row.cwd === "string" && row.cwd && Array.isArray(row.sessions))) {
    return `<section class="portfolio"><div class="group portfolio-head">${esc(t("portfolio.title"))}</div>
      <div class="meta portfolio-note">${esc(portfolio.mesh_sessions?.state === "unavailable" ? t("portfolio.meshUnavailable") : t("portfolio.meshMalformed"))}</div>
      ${portfolioProvenanceHtml(portfolio)}</section>`;
  }
  const directories = portfolio.mesh_sessions?.directories;
  if (!Array.isArray(directories)) return "";
  const rows = directories.map((row) => {
    const cwd = typeof row.cwd === "string" ? short(row.cwd) : t("portfolio.unknownDirectory");
    const count = Array.isArray(row.sessions) ? row.sessions.length : 0;
    const selector = typeof row.diff_selector === "string" ? row.diff_selector : "";
    const control = selector ? `<button class="btn ghost portfolio-diff-button" data-portfolio-diff="${esc(selector)}" data-portfolio-cwd="${esc(row.cwd)}">${esc(t("portfolio.diffButton"))}</button>` : "";
    return `<div class="portfolio-row"><span>${esc(cwd)}</span><span class="count">${count}</span>${control}</div>`;
  }).join("");
  const unlocated = Array.isArray(portfolio.mesh_sessions?.unlocated) ? portfolio.mesh_sessions.unlocated.length : 0;
  return `<section class="portfolio" aria-label="${esc(t("portfolio.inventoryLabel"))}">
    <div class="group portfolio-head"><span>${esc(t("portfolio.title"))}</span><span class="count">${directories.length}</span></div>
    ${rows || `<div class="meta portfolio-note">${esc(t("portfolio.noDirectory"))}</div>`}
    ${unlocated ? `<div class="meta portfolio-note">${esc(t("portfolio.unlocated", { n: unlocated }))}</div>` : ""}
    ${worktreeNote(portfolio.worktrees)}
    ${portfolioProvenanceHtml(portfolio)}
    <div class="meta portfolio-note">${esc(t("portfolio.historyNotCollected"))}</div>
  </section>`;
}

function portfolioProvenanceHtml(portfolio) {
  const projection = MeshPaneActions.portfolioProvenance(portfolio.worktrees);
  const labels = {
    observed: t("portfolio.state.observed"), unavailable: t("portfolio.state.unavailable"), "not-collected": t("portfolio.state.notCollected"),
    "not-a-repository": t("portfolio.state.notRepository"), malformed: t("portfolio.state.malformed"),
  };
  const yesNo = (value) => (value ? t("portfolio.fact.yes") : t("portfolio.fact.no"));
  const meta = (facts) => `<p>${esc(t("portfolio.meta", { source: facts.source, observedAt: facts.observedAt }))}</p>`;
  const inventory = MeshPaneActions.portfolioProvenance({ state: "observed", directories: [], source: portfolio.source, observed_at: portfolio.observed_at });
  const open = $(".portfolio-provenance")?.open;
  return `<details class="portfolio-provenance"${open ? " open" : ""}><summary>${esc(t("portfolio.provenance"))}</summary>
    <p>${esc(t("portfolio.sessionInventory"))}</p>${meta(inventory)}
    <p>${esc(t("portfolio.observationOnly"))}</p>
    <p>${esc(t("portfolio.worktreesState", { state: labels[projection.state] }))}</p>${meta(projection)}
    ${projection.state === "observed" && !projection.rows.length ? `<p>${esc(t("portfolio.noWorktree"))}</p>` : ""}
    ${projection.rows.map((row) => `<div class="portfolio-facts"><p>${esc(row.cwd)} · ${esc(labels[row.state])}</p>${meta(row)}
      ${row.state === "observed" && !row.facts.length ? `<p>${esc(t("portfolio.noWorktreeHere"))}</p>` : ""}
      ${row.facts.map((fact) => `<p>${esc(t("portfolio.fact.path", { path: fact.path }))}<br>${esc(t("portfolio.fact.head", { head: fact.head }))}<br>${esc(t("portfolio.fact.branch", { branch: fact.branch }))}<br>${esc(t("portfolio.fact.flags", { detached: yesNo(fact.detached), bare: yesNo(fact.bare) }))}</p>`).join("")}</div>`).join("")}
  </details>`;
}

$("#list").addEventListener("keydown", (event) => {
  const details = event.target.closest(".portfolio-provenance");
  if (event.key === "Escape" && details?.open) {
    event.preventDefault(); event.stopPropagation(); details.open = false; $("summary", details).focus();
  }
});

function worktreeNote(worktrees) {
  const projection = MeshPaneActions.portfolioProvenance(worktrees);
  if (projection.state === "not-collected") return `<div class="meta portfolio-note">${esc(t("worktrees.notCollected"))}</div>`;
  if (projection.state !== "observed") return `<div class="meta portfolio-note">${esc(projection.state === "malformed" ? t("worktrees.malformed") : t("worktrees.unavailable"))}</div>`;
  const observed = projection.rows.filter((row) => row.state === "observed");
  const count = observed.reduce((total, row) => total + row.facts.length, 0);
  const unknown = projection.rows.length - observed.length;
  return `<div class="meta portfolio-note">${esc(t("worktrees.observed", { n: count }))}${unknown ? esc(t("worktrees.undetermined", { n: unknown })) : ""}</div>`;
}

// The status sections at the top of the list: copies of the sessions in one state,
// collapsible like the groups (same `folded` set). Empty ones are not drawn.
const STATUS_SECTIONS = {
// Catalog keys, translated where they are displayed.
  wait: { title: "list.status.wait.title", help: "list.status.wait.help" },
  unread: { title: "list.status.unread.title", help: "list.status.unread.help" },
  busy: { title: "list.status.busy.title", help: "list.status.busy.help" },
};

function statusHtml(st, list) {
  if (!list.length) return "";
  const title = t(STATUS_SECTIONS[st].title), help = t(STATUS_SECTIONS[st].help), key = `st:${st}`, f = folded.has(key);
  return `<div class="todo ${st}-section"><button class="group status-head ${st} ${f ? "folded" : ""}" data-group="${key}" title="${esc(help)}">
      <span class="chev">▾</span><span>${esc(title)}</span><span class="help" data-help="${st}" role="button" aria-label="${esc(t("list.status.helpLabel"))}" title="${esc(help)}">?</span>
      <span class="count">${list.length}</span></button>` +
    (f ? "" : rowsHtml(key, list, { todo: true })) + `</div>`;
}

let listBusy = false;   // dragging or renaming: don't re-render under the pointer
let listPointerHeld = false;
let pendingListRender = false;
let renderedActiveOrder = null;

function releaseListReorder() {
  queueMicrotask(() => {
    if (listPointerHeld || listBusy || document.activeElement?.closest?.("#list .item, #list .pin-remove")) return;
    if (pendingListRender) renderList();
  });
}
$("#list").addEventListener("pointerdown", (event) => {
  if (event.target.closest(".pin-remove")) event.preventDefault();
  if (event.target.closest(".item")) listPointerHeld = true;
});
document.addEventListener("pointerup", () => { listPointerHeld = false; releaseListReorder(); });
document.addEventListener("pointercancel", () => { listPointerHeld = false; releaseListReorder(); });
// The focus leaving a row for another one (Tab, the arrows) keeps the render held back: run between the
// two, it would replace the row about to get the focus, and the focus would fall to the page.
$("#list").addEventListener("focusout", (event) => {
  if (event.relatedTarget?.closest?.("#list .item, #list .pin-remove")) return;
  releaseListReorder();
});

// ---- drawing the list: keyed updates, one render per frame, a window over long lists
// (static/keyed-render.ts, static/list-window.ts). The model is what the list last drew from: a
// scroll redraws it (moving the window) and never publishes newer data under the owner's focus or
// pointer (renderList defers those).
let listModel = null;
// A folder's toolbar holds its inline rename editor: kept like a row while the editor is open.
const listWindow = Progress.createListWindow({ box: $("#list"), rowSelector: ".item", holderSelector: ".item, .pin-row, .row-wrap, .folder-toolbar",
  editingSelector: "input.rename", idOf: (el) => el.getAttribute("data-id"), escape: esc });
const LIST_MORPH = { keyAttributes: ["data-id", "data-group", "data-folder", "data-folder-head", "data-retry", "data-unpin-id",
  "data-add-folder", ...Progress.WINDOW_KEY_ATTRIBUTES], isLeaf: (el) => el.tagName === "BUTTON" || el.matches(".pin-row, .row-wrap") };
const frames = { request: (run) => requestAnimationFrame(run), cancel: (handle) => cancelAnimationFrame(handle) };
const listBatch = Progress.createFrameBatcher(() => renderLists(), frames);
const listScroll = Progress.createFrameBatcher(() => { if (listWindow.windowed()) drawList(true); }, frames);
$("#list").addEventListener("scroll", () => listScroll.request(), { passive: true });
$("#list").addEventListener("focusin", () => { if (listWindow.windowed()) listScroll.request(); });
new ResizeObserver(() => { if (listWindow.windowed()) listScroll.request(); }).observe($("#list"));

function drawList(fromScroll = false) {
  const model = listModel;
  if (!model) return;
  const runs = [["st:wait", model.waiting], ["st:unread", model.unread], ["st:busy", model.working], ["mesh", model.mesh], ["", model.external]];
  listWindow.setRowCount(Progress.shownRowCount(runs.map(([key, list]) => ({ size: list.length, folded: folded.has(key) }))));
  const next = document.createElement("div");
  next.innerHTML = pinnedHtml(model.q) +
    statusHtml("wait", model.waiting) + statusHtml("unread", model.unread) + statusHtml("busy", model.working) +
    meshHtml(model.mesh) + portfolioHtml(data.portfolio) +
    groups(model.external).map(([host, list]) => groupHtml(host, host, list)).join("");
  // A scroll leaves the held rows (focus, inline rename, drag) exactly as they are.
  Progress.morphChildren($("#list"), next, fromScroll ? { ...LIST_MORPH, keep: listWindow.keep } : LIST_MORPH);
  // Windowed scroll redraws use the held list model, whose account metadata may
  // predate a deferred inventory update. Refresh only rows not held by the user.
  if (fromScroll) syncAccountBadges(true);
  listWindow.measure();
  // A run above changed height (folded, rows added): the windows below were placed at its old offsets.
  if (!fromScroll && listWindow.offsetsMoved()) listScroll.request();
}

function renderList(completedDrop = false) {
  const provenanceFocus = document.activeElement?.matches("#list .portfolio-provenance summary");
  const focusedRow = document.activeElement?.closest?.("#list .item, #list .pin-remove");
  const restoreFocusId = completedDrop ? focusedRow?.dataset.id : null;
  const retriedId = document.activeElement?.closest?.("#list .row-retry")?.dataset.retry;   // its row may lose the button
  if (listBusy || listPointerHeld || (focusedRow && !completedDrop)) {
    syncAccountBadges();
    pendingListRender = true;
    return;
  }
  const q = $("#filter").value.trim().toLowerCase();
  const match = (s) => !q || [label(s), s.aliases, s.cwd, s.name, s.cmd, s.known_agent, s.agent?.last, s.agent?.said, s.folder].flat().join(" ").toLowerCase().includes(q);
  const all = [...data.mesh, ...data.external];
  const by = (st) => all.filter((s) => state(s) === st);
  const waiting = by("wait").sort((x, y) => (x.agent.since || 0) - (y.agent.since || 0));   // oldest wait first
  const unread = by("unread").sort((x, y) => lastSeen(y) - lastSeen(x));
  const activeById = new Map(by("busy").map((s) => [s.id, s]));
  const working = (activityRanking?.activeIds || []).map((id) => activeById.get(id)).filter(Boolean);
  for (const session of activeById.values()) if (!working.includes(session)) working.push(session);
  const activeOrder = working.map((s) => s.id).join("\0");
  const batchOwed = listBatch.cancel();   // the batched render it replaces also drew history and explorer
  listModel = { q, waiting: waiting.filter(match), unread: unread.filter(match), working: working.filter(match),
    mesh: shownMesh().filter(match), external: data.external.filter(match) };
  drawList();
  if (tab === "live") {
    const parts = [t("list.foot.sessions", { n: all.length }), t("list.foot.active", { n: working.length })];
    if (waiting.length) parts.push(t("list.foot.waiting", { n: waiting.length }));
    if (unread.length) parts.push(t("list.foot.unread", { n: unread.length }));
    $("#foot").textContent = parts.join(" · ");
  }
  $("#n-live").textContent = all.length;
  showTodoCount(waiting.length + unread.length);
  if (pendingListRender && renderedActiveOrder !== null && activeOrder !== renderedActiveOrder) {
    const message = t("list.activeOrderUpdated");
    const status = $("#active-order-status");
    status.textContent = "";
    requestAnimationFrame(() => { status.textContent = message; });
    flash(message);
  }
  pendingListRender = false;
  renderedActiveOrder = activeOrder;
  if (restoreFocusId) listItem(restoreFocusId)?.focus({ preventScroll: true });
  if (retriedId && !$("#list").contains(document.activeElement)) listItem(retriedId)?.focus({ preventScroll: true });
  if (provenanceFocus) $(".portfolio-provenance summary")?.focus({ preventScroll: true });
  if (batchOwed) { renderHistList(); if (exploring) renderExplorer(); }
}

// the count of sessions needing me, where it is seen without opening the menu
function showTodoCount(n) {
  document.title = n ? t("list.titleWithCount", { n }) : "Session Mesh";
  $("#btn-menu").dataset.badge = n || "";
}

// What is read: the sessions on screen while the page is visible — on a phone
// only the active pane, and not while the menu covers it.
function onScreen(evenHidden = false) {
  if (document.body.classList.contains("flowing")) return [];
  if (!evenHidden && document.visibilityState !== "visible") return [];
  if (narrow()) return document.body.classList.contains("drawer") || !active?.id ? [] : [active.id];
  return panes.map((p) => p.id).filter(Boolean);
}
const sessionIds = (ids) => ids.filter((id) => !isAdjacentPane(id) && !isHist(id));   // only sessions are tracked
function see(ids, evenHidden = false) {
  ids = sessionIds(ids);
  if (!ids.length || (!evenHidden && document.visibilityState !== "visible")) return;
  const now = serverNow();
  for (const id of ids) seen[id] = now;
  saveSeen();
}
// a session being left was read up to now (checked before it goes)
function leaveSeen(id) { if (id && onScreen().includes(id)) see([id]); }

// Every tab of this browser shares the map: merged on write (latest time wins),
// pruned after the merge, written only when it changed (another tab's storage
// event must not bounce back as a write).
function mergeStored() {
  const stored = store.get("seen", {}) || {};
  for (const [id, t] of Object.entries(stored)) if (!(seen[id] >= t)) seen[id] = t;
  return stored;
}
// gone from the listing for a day (not at once: a failed listing shows none)
const stale = (id, t) => inventoryLoaded && data.mesh.length + data.external.length > 0 && !find(id) && serverNow() - t > 86400;
function saveSeen() {
  const stored = mergeStored();
  for (const [id, t] of Object.entries(seen)) if (stale(id, t)) delete seen[id];
  const same = Object.keys(stored).length === Object.keys(seen).length && Object.entries(seen).every(([id, t]) => stored[id] === t);
  if (!same) store.set("seen", seen);
}
window.addEventListener("storage", (e) => {
  if (e.key !== "mesh.seen") return;
  mergeStored();   // in memory only
  renderList();
});

// After a listing: adopted sessions keep their time, what is on screen is read,
// and sessions gone for a day are forgotten (not at once: a failed listing shows none).
function markSeen() {
  const now = serverNow();
  if (seenSince === null) { seenSince = now; store.set("seenSince", now); }
  const ids = new Set([...data.mesh, ...data.external].map((s) => s.id));
  for (const [from, to] of Object.entries(data.moved || {})) if (seen[from] && !(seen[to] >= seen[from])) seen[to] = seen[from];
  for (const id of onScreen()) if (ids.has(id)) seen[id] = now;
  saveSeen();
}
document.addEventListener("visibilitychange", (event) => {
  // going hidden: what was on screen was read until now
  if (document.visibilityState === "hidden") see(onScreen(true), true);
  else { markSeen(); for (const p of panes) { p.retakeSize(); p.autoTakeSize(event); } }   // this device is the one in use now
  renderList();
});

// Inline rename: an input over the name; Enter saves, Escape cancels, empty restores the default.
function editInline(el, value, save) {
  listBusy = true;
  const input = document.createElement("input");
  input.className = "rename";
  input.value = value;
  el.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (ok) => {
    if (done) return;
    done = true;
    const nextValue = input.value.trim();
    input.remove();
    el.textContent = value;
    listBusy = false;
    if (ok && nextValue !== value) await save(nextValue);
    renderList();
    for (const p of panes) p.header();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  // a <button> activates on the keyup of Space: stop that one, not the typing
  input.addEventListener("keyup", (e) => { e.stopPropagation(); if (e.key === " ") e.preventDefault(); });
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("blur", () => finish(true));
}

function renameSession(id, el) {
  if (localActionUnavailable()) return;
  const s = find(id);
  if (s?.kind === "mesh" && !rowAuthoritative(s)) return;   // a session not listed as observed fact yet
  if (s?.kind === "mesh") editInline(el, label(s), (v) => organize({ op: "rename", id, label: v }, (result) => {
    const agent = s.agent?.type, sid = s.agent?.session_id;
    const pins = pinnedSessions();
    const pin = pins.find(p => p.agent === agent && p.id === sid);
    if (!pin) return;
    pin.label = String(result.sessions?.[id]?.label || s.name || sid).slice(0, 256);
    try { localStorage.setItem("mesh.pinnedSessions", JSON.stringify(pins)); }
    catch { flash(t("pins.renameLabelStale")); }
  }));
}

// Folder headers are buttons (fold and drag), so their editor must be their
// sibling, never an interactive descendant of the button.  The small TS
// module below owns the response shape and the browser-local folded-key move;
// this file remains the DOM/network orchestrator during the incremental split.
function editFolderInline(folder, value, save) {
  const toolbar = $(".folder-toolbar", folder);
  const head = $(".folder-head", toolbar);
  const actions = $(".folder-actions", toolbar);
  if (!toolbar || !head || !actions) return;
  listBusy = true;
  const input = document.createElement("input");
  input.className = "rename folder-rename-input";
  input.value = value;
  toolbar.insertBefore(input, head);
  head.hidden = actions.hidden = true;
  input.focus();
  input.select();
  let done = false;
  const finish = async (ok) => {
    if (done) return;
    done = true;
    input.remove();
    head.hidden = actions.hidden = false;
    listBusy = false;
    if (ok && input.value.trim() !== value) await save(input.value.trim());
    renderList();
    for (const p of panes) p.header();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("blur", () => finish(true));
}

function renameFolder(old, folder) {
  if (localActionUnavailable()) return;
  editFolderInline(folder, old, (name) => name && organize({ op: "folder-rename", old, new: name }, (result) => {
    const rename = MeshFolderState.folderRenameReceipt(result, old);
    if (!rename) return;
    const next = MeshFolderState.migrateFoldedFolder(folded, rename);
    folded.clear();
    for (const key of next) folded.add(key);
    store.set("folded", [...folded]);
  }));
}

$("#list").addEventListener("dblclick", (e) => {
  const item = e.target.closest(".item");
  if (item && e.target.closest(".name")) { e.preventDefault(); renameSession(item.dataset.id, $(".name", item)); }
});

async function onListClick(e) {
  // while a name is being edited, clicks belong to the editor (a space typed in
  // an input nested in a <button> can fire the button's click)
  if (e.target.closest(".rename") || $("#list input.rename")) return;
  const unpin = e.target.closest("[data-unpin-agent]");
  if (unpin) return togglePin(unpin.dataset.unpinAgent, unpin.dataset.unpinId, "");
  const retry = e.target.closest("[data-retry]")?.dataset.retry;
  if (retry) { e.stopPropagation(); retryFocus = retry; return void refresh(); }   // that row first in the next `focus`
  const selector = e.target.closest("[data-portfolio-diff]")?.dataset.portfolioDiff;
  if (selector) {
    e.stopPropagation();
    const button = e.target.closest("[data-portfolio-diff]");
    const cwd = button.dataset.portfolioCwd;
    if (!cwd) return;
    openContextualDiff(cwd);
    return;
  }
  const del = e.target.closest("[data-folder-del]")?.dataset.folderDel;
  if (del) {
    e.stopPropagation();
    if (confirm(t("folder.deleteConfirm", { name: del }))) organize({ op: "folder-remove", name: del });
    return;
  }
  const rename = e.target.closest("[data-folder-rename]");
  if (rename) {
    e.stopPropagation();
    const folder = rename.closest(".folder"), old = rename.dataset.folderRename;
    if (old && folder) renameFolder(old, folder);
    return;
  }
  if (e.target.closest("[data-add-folder]")) {
    const btn = e.target.closest("[data-add-folder]");
    return editInline(btn, "", (v) => v && organize({ op: "folder-add", name: v }));
  }
  const help = e.target.closest("[data-help]")?.dataset.help;
  if (help) return flash(t(STATUS_SECTIONS[help].help));   // the title attribute does not exist on touch
  const g = e.target.closest(".group")?.dataset.group;
  if (g) {
    folded.has(g) ? folded.delete(g) : folded.add(g);
    store.set("folded", [...folded]);
    renderLists();
    return active?.focus();
  }
  const more = e.target.closest("[data-more]")?.dataset.more;
  if (more) { unfoldedLeaves.add(more); return renderHistList(); }
  const id = e.target.closest(".item")?.dataset.id;
  if (!id) return;
  openSession(id);
}
$("#list").addEventListener("click", onListClick);
$("#hlist").addEventListener("click", onListClick);

// Show a session in the active pane; a past conversation that is running in
// the mesh opens its terminal instead of its card. opts.focus === false shows
// it without giving the terminal the keyboard (a request from a document).
function openSession(id, opts = {}) {
  const focus = opts.focus !== false;
  if (isHist(id)) {
    const [, agent, sid] = id.split(":");
    const live = liveOf(sid, agent);
    if (live?.kind === "mesh") id = live.id;
  }
  if (projecting) setProjects(false);
  if (exploring) setExplorer(false);
  if (flowing) setFlow(false);
  document.body.classList.remove("drawer");
  // already open in another column: activate that column
  const there = panes.find((p) => p.id === id);
  if (there) {
    setActive(there, true);
    if (!localMeshEffectsAllowed()) return;
    const session = find(id);
    if (!there.conn && session?.kind === "mesh" && rowAuthoritative(session)) {
      there.cachedTerminalMoveBlockedId = null;
      there.attach(id, {focusTerminal: focus});
    }
    if (isHist(id) && there.hist?.key !== id) there.showHist(id);
    else if (focus) there.focusSelectedTerminal();
    return;
  }
  // A restored workspace can have a pane but no selected pane yet. Sidebar
  // navigation must still work before the user has focused that pane.
  const target = active || panes[0];
  if (!target) return flash(t("pane.noneAvailable"));
  if (!active) setActive(target);
  target.show(id, false, { focusTerminal: focus });
}

// Drag & drop: a session onto a folder (files it), onto another session
// (goes just before it, in its folder) or onto the mesh header / loose area
// (back to the top level). A folder onto another folder reorders folders.
{
  const list = $("#list");
  let dragged = null;   // { kind: "session" | "folder", id }
  const clearMarks = () => list.querySelectorAll(".drop-before, .drop-into").forEach((x) => x.classList.remove("drop-before", "drop-into"));
  const target = (e) => {
    const item = e.target.closest(".item[draggable]");
    const head = e.target.closest("[data-folder-head]");
    const folder = e.target.closest(".folder");
    const root = e.target.closest("[data-root]");
    const addRow = e.target.closest("[data-add-folder]");
    if (dragged?.kind === "folder") {
      if (addRow) return { el: addRow, mode: "into", before: null };          // last
      return head && head.dataset.folderHead !== dragged.id ? { el: head, before: head.dataset.folderHead } : null;
    }
    // a session whose folder no longer exists is shown loose: dropping next to it means loose
    const folderOf = (id) => { const f = find(id)?.folder; return f && (data.folders || []).includes(f) ? f : null; };
    if (item && item.dataset.id !== dragged?.id) return { el: item, mode: "before", before: item.dataset.id, folder: folderOf(item.dataset.id) };
    if (head) return { el: head, mode: "into", folder: head.dataset.folderHead };
    if (folder) return { el: $("[data-folder-head]", folder), mode: "into", folder: folder.dataset.folder };
    if (root) return { el: root, mode: "into", folder: null };
    return null;
  };
  // Auto-scroll while dragging. The browser's own autoscroll is a thin band at the
  // very edge of the window (and touch drags get none), while the list ends at the
  // window's edge: do it here, from the pointer position dragover reports (the
  // list's own, and the one past its borders).
  const EDGE = 56, MAX_STEP = 22;
  let pointer = null, scroller = null;
  const stopScroll = () => { clearInterval(scroller); scroller = pointer = null; };
  const scrollStep = () => {
    if (!dragged) return stopScroll();
    const r = list.getBoundingClientRect();
    if (!pointer || pointer.x < r.left || pointer.x > r.right) return;
    const zone = Math.min(EDGE, r.height / 3);
    const speed = (dist) => Math.ceil(MAX_STEP * Math.min(1, (zone - dist) / zone));
    if (pointer.y - r.top < zone) list.scrollTop -= speed(pointer.y - r.top);
    else if (r.bottom - pointer.y < zone) list.scrollTop += speed(r.bottom - pointer.y);
  };
  for (const type of ["dragenter", "dragover"]) document.addEventListener(type, (e) => { if (dragged) pointer = { x: e.clientX, y: e.clientY }; });
  document.addEventListener("dragend", stopScroll);   // also when the dragged node was re-rendered away
  list.addEventListener("dragstart", (e) => {
    const head = e.target.closest?.("[data-folder-head]");
    const item = e.target.closest?.(".item[draggable]");
    dragged = head ? { kind: "folder", id: head.dataset.folderHead } : item ? { kind: "session", id: item.dataset.id } : null;
    if (!dragged) return;
    if (ctxMenu) { dragged = null; return e.preventDefault(); }   // a long press on a phone is the menu, not a drag
    listBusy = true;
    listWindow.setDragged(dragged.kind === "session" ? dragged.id : null);
    clearInterval(scroller);
    scroller = setInterval(scrollStep, 16);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragged.id);
  });
  list.addEventListener("dragover", (e) => {
    if (!dragged) return;
    const t = target(e);
    clearMarks();
    if (!t) return;
    e.preventDefault();
    t.el.classList.add(t.mode === "into" ? "drop-into" : "drop-before");
  });
  list.addEventListener("drop", async (e) => {
    if (!dragged) return;
    e.preventDefault();
    const t = target(e), d = dragged;
    clearMarks();
    stopScroll();
    dragged = null;
    listBusy = false;
    listWindow.setDragged(null);
    listPointerHeld = false;
    if (!t) return renderList(true);
    if (d.kind === "folder") await organize({ op: "folder-move", name: d.id, before: t.before });
    else await organize({ op: "move", id: d.id, folder: t.folder, before: t.mode === "before" ? t.before : null,
                          order: data.mesh.map((s) => s.id) });   // the order shown, never-moved sessions included
    renderList(true);   // publish the explicit drop result, then restore row focus
  });
  list.addEventListener("dragend", () => { clearMarks(); listWindow.setDragged(null); if (dragged) { dragged = null; listBusy = false; renderList(); } });
}

// ---- the menu of a session in the sidebar: right click, long press on a phone,
// or the menu key / Shift+F10 on a focused item. A mesh session can be renamed,
// filed in a folder, shown in a new column or closed; an outside one (not ours to
// rename, file or kill) can only be opened. History rows have no menu.
let ctxMenu = null;   // { el, id } while open
let swallowClick = false;   // the click that ends a long press must not open the session

const listItem = (id) => {
  const all = [...$("#list").querySelectorAll(".item")].filter((x) => x.dataset.id === id);
  return all.find((x) => !x.closest(".todo")) || all[0] || null;   // the one in the list, not a status-section copy
};

function closeMenu(refocus = true) {
  if (!ctxMenu) return;
  const { el, id } = ctxMenu;
  ctxMenu = null;
  el.remove();
  listBusy = false;   // the list was held still under the menu
  renderList();
  if (refocus) listItem(id)?.focus();
}

// the pane showing this session (the active one first), if any
function redrawSession(id) {
  const pane = panes.find((p) => p.id === id && p.conn && p === active) || panes.find((p) => p.id === id && p.conn);
  if (pane) pane.redraw();
  else flash(t("session.openToRedraw"));
}

// A local xterm recovery, not terminal input.  Keep this adjacent to redraw:
// both are explicit session-menu remedies for a currently open terminal.
function recoverTerminalModes(id) {
  const pane = panes.find((p) => p.id === id && p.conn && p === active) || panes.find((p) => p.id === id && p.conn);
  if (pane) pane.recoverTerminalInteractionModes();
  else flash(t("session.openToResetModes"));
}

function restorePiFullscreenScroll(id, created) {
  const pane = panes.find(p => p.id === id && p.conn && p === active)
    || panes.find(p => p.id === id && p.conn);
  if (pane) pane.restorePiFullscreenScroll(created);
  else flash(t("session.openToRestoreScroll"));
}

function openInNewColumn(id) {
  document.body.classList.remove("drawer");
  if (flowing) setFlow(false);
  const pane = addPane();
  if (!pane) flash(t("pane.maxColumns"));
  else pane.show(id, false, { focusTerminal: true });
}

async function moveToFolder(id, folder) {
  await organize({ op: "move", id, folder, before: null, order: data.mesh.map((s) => s.id) });
}

async function moveToNewFolder(id) {
  const name = (prompt(t("folders.newPrompt")) || "").trim();
  if (!name) return;
  const known = new Set(data.folders || []);
  if (!(await organize({ op: "folder-add", name }))) return;
  await moveToFolder(id, (data.folders || []).find((f) => !known.has(f)) ?? name);
}

function renameFromMenu(id) {
  const s = find(id);
  if (s && s.folder && folded.has(`dir:${s.folder}`)) { folded.delete(`dir:${s.folder}`); store.set("folded", [...folded]); renderList(); }
  const name = listItem(id) && $(".name", listItem(id));
  if (name) renameSession(id, name);
}

function folderEntries(id) {
  const current = find(id)?.folder || null;
  const mark = (label, on) => (on ? `✓ ${label}` : label);
  return [
    { label: t("menu.backArrow"), stay: true, run: () => showEntries(menuEntries(id)) },
    { label: mark(t("folders.none"), !current), run: () => current && moveToFolder(id, null) },
    ...(data.folders || []).map((f) => ({ label: mark(f, f === current), run: () => f !== current && moveToFolder(id, f) })),
    { label: t("folders.newEntry"), run: () => moveToNewFolder(id) },
  ];
}

function menuEntries(id) {
  const s = find(id);
  if (!localMeshEffectsAllowed()) return [];
  const pin = s?.kind === "mesh" ? pinIdentity(s) : null;
  // A session not yet observed by the server is offered nothing that changes or ends it.
  if (s?.kind === "mesh" && !rowAuthoritative(s)) return [
    { label: t("menu.openInColumn"), run: () => openInNewColumn(id) },
    { label: t("menu.redraw"), run: () => redrawSession(id) },
  ];
  if (s?.kind === "mesh") return [
    ...(pin ? [{ label: isPinned(pin.agent, pin.id) ? t("pin.unpin") : t("pin.pinHere"),
      run: () => togglePin(pin.agent, pin.id, label(s), pin.guessed) }] : []),
    { label: t("menu.rename"), run: () => renameFromMenu(id) },
    { label: t("menu.moveTo"), stay: true, run: () => showEntries(folderEntries(id)) },
    { label: t("menu.openInColumn"), run: () => openInNewColumn(id) },
    ...(hasFullscreenScrollRecovery(s) ? [{ label: t(fullscreenScrollText(s).menu),
      run: () => restorePiFullscreenScroll(id, s.created) }] : []),
    { label: t("menu.redraw"), run: () => redrawSession(id) },
    { label: t("menu.resetModes"), run: () => recoverTerminalModes(id) },
    { label: t("menu.closeSession"), danger: true, run: () => closeSession(id) },
  ];
  if (s) return [
    { label: t("common.open"), run: () => openSession(id) },
    { label: t("menu.openInColumn"), run: () => openInNewColumn(id) },
  ];
  return [];
}

// the entries as buttons; the menu keeps its place, and is clamped inside the viewport
function showEntries(entries) {
  const { el } = ctxMenu;
  el.replaceChildren(...entries.map((entry) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.className = entry.danger ? "danger" : "";
    b.textContent = entry.label;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (entry.stay) return entry.run();
      const { id } = ctxMenu;
      closeMenu(false);
      Promise.resolve(entry.run()).finally(() => { if (!document.activeElement || document.activeElement === document.body) listItem(id)?.focus(); });
    });
    return b;
  }));
  placeMenu();
  el.firstElementChild.focus();
}

function placeMenu() {
  const { el, x, y } = ctxMenu;
  const gap = 4;
  el.style.left = el.style.top = "0";
  const { width, height } = el.getBoundingClientRect();
  el.style.left = `${Math.max(gap, Math.min(x, innerWidth - width - gap))}px`;
  el.style.top = `${Math.max(gap, Math.min(y, innerHeight - height - gap))}px`;
}

function openMenu(id, x, y) {
  if (!meshContext || meshStopped) return;
  if (listBusy && !ctxMenu) return false;   // a rename or a drag is under way
  closeMenu(false);
  const entries = menuEntries(id);
  if (!entries.length) return false;
  const el = document.createElement("div");
  el.className = "ctx-menu";
  el.setAttribute("role", "menu");
  document.body.append(el);
  listBusy = true;   // no re-render under the menu
  ctxMenu = { el, id, x, y };
  showEntries(entries);
  return true;
}

function openMenuAt(itemEl, e) {
  const r = itemEl.getBoundingClientRect();
  const fromKeyboard = !e || !(e.clientX || e.clientY);
  return openMenu(itemEl.dataset.id, fromKeyboard ? r.left + 24 : e.clientX, fromKeyboard ? r.bottom - 4 : e.clientY);
}

$("#list").addEventListener("contextmenu", (e) => {
  const itemEl = e.target.closest(".item");
  if (!itemEl || e.target.closest(".rename")) return;
  if (ctxMenu?.id === itemEl.dataset.id && e.timeStamp - (ctxMenu.at ?? 0) < 400) return e.preventDefault();   // the long press already did
  if (openMenuAt(itemEl, e)) e.preventDefault();
});

$("#list").addEventListener("keydown", (e) => {
  if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey)) return;
  const itemEl = e.target.closest?.(".item");
  if (itemEl && openMenuAt(itemEl)) e.preventDefault();
});

// long press on a phone: still, 450 ms
{
  let press = null;   // { timer, x, y }
  const cancel = () => { if (press) clearTimeout(press.timer); press = null; };
  $("#list").addEventListener("pointerdown", (e) => {
    cancel();
    const itemEl = e.pointerType === "touch" && e.target.closest(".item");
    if (!itemEl || e.target.closest(".rename")) return;
    press = { x: e.clientX, y: e.clientY, timer: setTimeout(() => {
      press = null;
      if (openMenu(itemEl.dataset.id, e.clientX, e.clientY)) { swallowClick = true; ctxMenu.at = performance.now(); }
    }, 450) };
  });
  $("#list").addEventListener("pointermove", (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancel();
  });
  for (const type of ["pointerup", "pointercancel"]) $("#list").addEventListener(type, () => { if (!ctxMenu) cancel(); });
  $("#list").addEventListener("click", (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
}

// leaving the menu: Escape, an outside press, the window changing under it
document.addEventListener("keydown", (e) => {
  swallowClick = false;
  if (!ctxMenu) return;
  const items = [...ctxMenu.el.querySelectorAll("[role=menuitem]")];
  const at = items.indexOf(document.activeElement);
  const go = (i) => { e.preventDefault(); items[(i + items.length) % items.length].focus(); };
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); }
  else if (e.key === "Tab") { e.preventDefault(); closeMenu(); }
  else if (e.key === "ArrowDown") go(at + 1);
  else if (e.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
  else if (e.key === "Home") go(0);
  else if (e.key === "End") go(-1);
  else return;
  e.stopPropagation();
}, true);
document.addEventListener("pointerdown", (e) => {
  swallowClick = false;
  if (!ctxMenu || ctxMenu.el.contains(e.target)) return;
  closeMenu(false);
  if (e.button !== 0) return;   // a right click elsewhere may open another menu
  const stop = (c) => { c.stopPropagation(); c.preventDefault(); };
  document.addEventListener("click", stop, { capture: true, once: true });   // this press only closes it
  setTimeout(() => document.removeEventListener("click", stop, true), 600);
}, true);
window.addEventListener("resize", () => closeMenu(false));
window.addEventListener("blur", () => closeMenu(false));
// Focusing a fixed context menu can produce a deferred scroll event on the
// sidebar.  That scroll is not an owner action and must not detach the action
// being clicked.  Real pointer interaction is already caught above; wheel is
// the remaining direct way to scroll the list without a pointer-down.
$("#list").addEventListener("wheel", () => closeMenu(false), { passive: true });

$("#filter").addEventListener("input", () => { renderLists(); if (tab === "hist") fullText($("#filter").value); });

// ---------------------------------------------------------------- newer client
//
// An installed PWA has no reload button: after a deploy the page reconnects but keeps running
// the old script. The server serves its client version in a <meta> and repeats the current one
// in every /api/sessions reply; a different one shows the bar, and the page reloads by itself
// when that cannot cost the owner anything. Rule (all must hold, checked on each refresh):
//   - no field holds text: the phone input line, the compose box, any other focused input
//     or textarea (filter, rename, dialog fields), and no <dialog> is open;
//   - no drag, rename, context menu, owner-held upload or retained recovery is under way;
//   - the page is hidden, or there has been no key / pointer / touch / wheel input for
//     reloadIdleMs.
// Typing straight into a terminal loses nothing (keys go to the pty at once), but it counts as
// activity. At most one automatic reload per target version (sessionStorage), so a version the
// page cannot reach can never loop; the bar and "Reload" stay available.

const loadedVersion = document.querySelector('meta[name="client-version"]')?.content || "";
let reloadIdleMs = 8000;
let lastActivity = performance.now();
for (const type of ["keydown", "pointerdown", "pointermove", "touchstart", "wheel", "input"]) {
  document.addEventListener(type, () => { lastActivity = performance.now(); }, { capture: true, passive: true });
}

function fieldHoldsText() {
  const focused = document.activeElement;
  const typing = focused?.matches?.("input:not([type=checkbox]):not([type=radio]), textarea") && focused.value !== "";
  return Boolean(typing || line.value || ctext.value);
}

const reloadStatus = document.createElement("details");
reloadStatus.id = "reload-status";
reloadStatus.hidden = true;
reloadStatus.style.cssText = "padding:6px 10px;overflow-wrap:anywhere;background:var(--panel);border-bottom:1px solid var(--line)";
$("#update-bar").after(reloadStatus);
let pendingClientVersion = "";

function reloadHolds() {
  const holds = [];
  const add = (kind, label, owner = null) => holds.push({ kind, label, owner });
  for (const pane of panes) {
    const count = [...pane.inputAcks.values()].reduce((sum, entry) => sum + entry.input.pendingBytes, 0);
    if (count) add("input-ack", t("reload.hold.inputAck", { count }), pane);
    if ([...pane.inputAcks.values()].some((entry) => entry.lease?.dirty))
      add("input-draft", t("reload.hold.inputDraft"), pane);
    if (pane.recoveredComposeDraft?.text) add("input-draft", t("reload.hold.inputDraft"), pane.recoveredComposeDraft);
    if (pane.recoveredLineDrafts?.size) add("input-draft", t("reload.hold.inputDraft"), pane.recoveredLineDrafts);
  }
  for (const session of inlineDictation?.holds() || []) add("dictation", t("dictation.reloadHold", {session: session.name}), session);
  if (fieldHoldsText()) add("draft", t("reload.hold.draft"));
  if (linePending) add("line-pending", t("reload.hold.linePending"), linePending);
  if (lineRecovery) add("line-recovery", t("reload.hold.lineRecovery"), lineRecovery);
  if (composeOwner?.pending) add("compose-pending", t("reload.hold.composePending", { target: composeOwner.target.displayName }), composeOwner);
  for (const record of composeRecovery) add("compose-recovery", t("reload.hold.composeRecovery", { target: record.target.displayName }), record);
  for (const record of composeUploads) add((record.batch.complete && !record.inserting) || record.batch.abandoned ? "upload-recovery" : "upload-pending",
    t("reload.hold.attachments", { target: record.target.displayName, files: record.batch.items.map((item) => item.name).join(", ") }), record);
  for (const record of uploadHolds) if (!composeUploads.includes(record))
    add("upload-pending", t("reload.hold.uploadActive", { target: record.target.displayName }), record);
  if (pickerGate.pending) {
    const destination = pickerGate.pending.destination;
    const target = destination.kind === "compose" ? destination.owner.target : destination.target;
    add("picker", t("reload.hold.picker", { target: target.displayName }), pickerGate.pending);
  }
  if (capActive && !capActive.discarded) {
    const destination = capActive.destination;
    const target = destination?.kind === "compose" ? destination.owner.target : destination?.target;
    add("media", t("reload.hold.media", { target: target?.displayName || t("reload.hold.originSession") }), capActive);
  }
  for (const pane of paneMenuHolds) add("pane-menu", t("reload.hold.paneMenu", { pane: pane.id || t("reload.hold.noSession") }), pane);
  if (paneStopHolds.size) add("stop", t("reload.hold.stop"));
  if (ctxMenu) add("context-menu", t("reload.hold.contextMenu"));
  if (listBusy) add("list", t("reload.hold.list"));
  if (document.querySelector("dialog[open]")) add("dialog", t("reload.hold.dialog"));
  return holds;
}

function renderReloadStatus() {
  const holds = reloadHolds();
  // Ordinary typing/open dialogs already show their own UI; avoid moving the
  // workspace for every keystroke unless an update is actually pending.
  reloadStatus.hidden = !holds.length || (!pendingClientVersion && !holds.some((hold) =>
    ["line-pending", "line-recovery", "compose-pending", "compose-recovery",
      "upload-pending", "upload-recovery", "picker", "media"].includes(hold.kind)));
  if (!holds.length) { reloadStatus.replaceChildren(); return; }
  const wasOpen = reloadStatus.open;
  const summary = document.createElement("summary");
  summary.textContent = `${t("reload.holdsSummary", { n: holds.length })}${pendingClientVersion ? ` · ${t("reload.newVersion")}` : ""}`;
  const list = document.createElement("ul");
  for (const hold of holds) {
    const row = document.createElement("li");
    const label = document.createElement("span"); label.textContent = hold.label;
    row.append(label);
    const action = (name, callback) => {
      const button = document.createElement("button");
      button.type = "button"; button.textContent = name;
      button.addEventListener("click", () => { callback(); renderReloadStatus(); });
      row.append(" ", button);
    };
    if (hold.kind === "line-pending") action(t("reload.action.cancelEnter"), () => cancelLinePending(hold.owner));
    else if (hold.kind === "compose-pending") action(t("reload.action.cancelEnter"), () => hold.owner.operation?.cancel());
    else if (hold.kind === "upload-pending")
      action(t("reload.action.cancelResult"), () => abandonUploadRecord(hold.owner));
    else if (hold.kind === "picker") action(t("reload.action.resetPicker"), () => resetPendingPicker(hold.owner));
    else if (hold.kind === "media") action(t("reload.action.cancelCapture"), () => {
      if (capActive !== hold.owner) return;
      resetCapture(hold.owner);
      if (adlg.open) adlg.close();
    });
    else if (hold.kind === "pane-menu") action(t("reload.action.closeMenu"), () => hold.owner.paneMenu.close());
    else if (hold.kind === "context-menu") action(t("reload.action.closeMenu"), closeMenu);
    else if (hold.kind === "line-recovery" || hold.kind === "compose-recovery"
        || hold.kind === "upload-recovery") {
      action(t("reload.action.showResult"), () => {
        const place = hold.kind === "line-recovery" ? lineStatus : composeStatus;
        place.scrollIntoView({ block: "nearest" });
      });
    }
    list.append(row);
  }
  reloadStatus.replaceChildren(summary, list);
  reloadStatus.open = wasOpen;
}

function safeToReload() {
  if (reloadHolds().length) return false;
  return document.visibilityState === "hidden" || performance.now() - lastActivity >= reloadIdleMs;
}

function reloadApp() { location.reload(); }

function requestReload() {
  const holds = reloadHolds();
  if (holds.length && !confirm(t("reload.confirmManual", { n: holds.length }) +
      (holds.some((hold) => hold.kind === "input-ack") ? `\n\n${t("reload.confirmInputAck")}` : "") +
      (holds.some((hold) => hold.kind === "input-draft") ? `\n\n${t("reload.confirmInputDraft")}` : ""))) return;
  reloadApp();
}

function checkClientVersion(announced) {
  if (!announced || !loadedVersion || announced === loadedVersion) return;
  $("#update-bar").hidden = false;
  pendingClientVersion = announced;
  renderReloadStatus();
  let tried = "";
  try { tried = sessionStorage.getItem("mesh-auto-reload") || ""; } catch {}
  if (tried === announced || !safeToReload()) return;
  try { sessionStorage.setItem("mesh-auto-reload", announced); } catch { return; }   // no memory, no loop guard: leave it to the owner
  reloadApp();
}
$("#update-bar").addEventListener("click", requestReload);
// A newer Session Mesh release, as the server found it (static/update-notice.ts).
function showUpdateNotice(update) {
  let store = null;
  try { store = window.localStorage; } catch {}
  try { MeshUpdateNotice.render($("#update-notice"), update, t, store, MeshI18n.locale()); } catch {}
}
document.addEventListener("input", () => queueMicrotask(renderReloadStatus), { capture: true });
$("#btn-reload").addEventListener("click", requestReload);

let lastOpen = null;   // seq of the last mesh-open request handled
const pageStartedAt = Date.now() / 1000;   // opens after it are handled (static/open-replay.ts)
function sessionRequestTabNonce() {
  const key = "mesh-session-request-tab";
  try {
    const old = sessionStorage.getItem(key);
    if (/^[0-9a-f]{32}$/.test(old || "")) return old;
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const fresh = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
    sessionStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return [...crypto.getRandomValues(new Uint8Array(16))]
      .map(value => value.toString(16).padStart(2, "0")).join("");
  }
}
let sessionRequestTab = null;
const sessionRequestGate = MeshPaneActions.createSessionRequestGate({
  confirm: (message) => confirm(message),
  notify: (message) => flash(message),
  claim: async (id, claimNonce) => {
    try {
      const response = await requestLocal(`/api/session-actions/${encodeURIComponent(id)}/claim`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tab_nonce: sessionRequestTab,
          ...(claimNonce ? { claim_nonce: claimNonce } : {}) }),
      });
      if (response.status === 409) {
        const body = await response.json().catch(() => null);
        const request = body?.request;
        if (request?.state !== "claimed") return "stale";
        return { kind: "busy", leaseExpiresAt: Number.isFinite(request.lease_expires_at)
          ? request.lease_expires_at : null };
      }
      if (response.status === 404) return "stale";
      if (!response.ok) return "retry";
      const body = await response.json();
      return typeof body.claim_nonce === "string" && /^[A-Za-z0-9_-]{24,64}$/.test(body.claim_nonce)
        ? { kind: "claimed", claimNonce: body.claim_nonce } : "retry";
    } catch { return "retry"; }
  },
  decide: async (id, approve, claimNonce, optionsRevision) => {
    try {
      const response = await requestLocal(`/api/session-actions/${encodeURIComponent(id)}/decision`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        // The revision is the one the confirmation showed: a save since then makes the server refuse
        // and ask again, rather than launch options the owner never saw.
        body: JSON.stringify({ approve, claim_nonce: claimNonce,
          ...(typeof optionsRevision === "string" ? { options_revision: optionsRevision } : {}) }),
      });
      if (response.ok) {
        const body = await response.json().catch(() => null);
        const notice = body?.request?.result?.notice;
        if (typeof notice === "string" && notice.length > 0) flash(serverText(notice), 8000);
        return "settled";
      }
      if (response.status === 409) {
        const body = await response.json().catch(() => null);
        return body?.error === "stale-options" ? "retry" : "stale";
      }
      return "retry";
    } catch { return "retry"; }
  },
});
let accountSwitchPane = null;
const accountSwitchPicker = MeshPaneActions.createAccountSwitchPicker($("#dlg-account-switch"), {
  source: () => {
    const s = accountSwitchPane && find(accountSwitchPane.id);
    return s ? { session: s, authoritative: rowAuthoritative(s) && localMeshEffectsAllowed() } : null;
  },
  label: s => label(s),
  t, serverText,
  notice: text => flash(text),
  profiles: async () => {
    const response = await requestLocal("/api/accounts/profiles", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok || body?.ok !== true || !Array.isArray(body.data?.profiles)) throw new Error();
    return body.data.profiles;
  },
  submit: async (source, target) => {
    const response = await requestLocal("/api/session-actions/operator/switch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, target }),
    });
    const body = await response.json();
    if (response.status === 409 && body?.refused === "foreground_unavailable") return null;
    if (!response.ok || body?.request?.action !== "switch_account") throw new Error();
    return body.request;
  },
  status: async id => {
    const response = await requestLocal(`/api/session-actions/operator/switch/${encodeURIComponent(id)}`,
      {cache: "no-store"});
    if (!response.ok) throw new Error();
    const body = await response.json();
    if (body?.request?.action !== "switch_account") throw new Error();
    return body.request;
  },
});
document.addEventListener("click", event => {
  const badge = event.target?.closest?.("#panes .pane .p-account");
  if (!badge || badge.disabled) return;
  const pane = panes.find(p => p.el === badge.closest(".pane"));
  if (!pane) return;
  accountSwitchPane = pane;
  void accountSwitchPicker.open(badge);
});
const agentMailConsentDialog = $("#dlg-agent-mail-consent");
const agentMailConsentDescription = $("#agent-mail-consent-description");
const agentMailConsentStatus = $("#agent-mail-consent-status");
const agentMailConsentPrompt = MeshPaneActions.createAgentMailConsentPrompt(agentMailConsentDialog, {
  blocked: () => document.querySelector("dialog:modal") !== null,
  describe: (request) => {
    const started = new Date(request.source.created * 1000).toLocaleString(MeshI18n.locale());
    agentMailConsentDescription.textContent = t("agentMail.consentDescription",
      { source: request.source.id, agent: request.source.agent, started, target: request.target.id });
  },
  // The next prompt opens over #flash, which the modal dialog makes inert: what became of the
  // previous request is said again inside the dialog, in its status line.
  notice: (notice) => {
    agentMailConsentStatus.textContent = notice === "withdrawn" ? t("agentMail.previousWithdrawn")
      : notice === "answeredElsewhere" ? t("agentMail.previousAnsweredElsewhere") : "";
  },
  withdrawn: () => flash(t("agentMail.withdrawn"), 4000),
});
const agentMailConsentGate = MeshPaneActions.createAgentMailConsentGate({
  choose: agentMailConsentPrompt.choose,
  withdraw: agentMailConsentPrompt.withdraw,
  answeredElsewhere: () => flash(t("agentMail.answeredElsewhere")),
  decide: async (id, decision) => {
    try {
      const response = await requestLocal(`/api/agent-mail/consent/${encodeURIComponent(id)}/decision`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      return response.ok ? "settled" : response.status === 404 ? "stale" : "retry";
    } catch { return "retry"; }
  },
});

const mailboxPanel = MeshPaneActions.createMailboxPanel({
  dialog: $("#dlg-mailbox"), session: $("#mailbox-session"), body: $("#mailbox-body"),
}, {
  t, locale: () => MeshI18n.locale(),
  wakeUnconfirmed: (name, created) =>
    data.mesh.some((row) => row.name === name && row.created === created && row.wake_unconfirmed === true),
  load: async (name, created) => {
    try {
      const query = new URLSearchParams({ session: name, created: String(created) });
      const response = await requestLocal(`/api/agent-mail/messages?${query}`, { cache: "no-store" });
      if (response.status === 404) return { state: "gone" };
      return response.ok ? { state: "ok", value: await response.json() } : { state: "error" };
    } catch { return { state: "error" }; }
  },
  decide: async (id, decision) => {
    try {
      const response = await requestLocal(`/api/agent-mail/consent/${encodeURIComponent(id)}/decision`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }),
      });
      return response.ok ? "settled" : response.status === 404 ? "stale" : "retry";
    } catch { return "retry"; }
  },
  revoke: async (policyId) => {
    try {
      const response = await requestLocal("/api/agent-mail/consent/revoke", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ policy_id: policyId }),
      });
      return response.ok ? "settled" : response.status === 404 ? "stale" : "retry";
    } catch { return "retry"; }
  },
});

const configPanel = MeshPaneActions.createConfigPanel({ dialog: $("#dlg-config"), body: $("#config-body") }, {
  t: (key, params) => {
    if (MeshI18n.loaded) {
      const translated = t(key, params);
      if (translated !== key) return translated;
    }
    const fallback = window.MeshConfigFallback?.[key];
    if (typeof fallback !== "string") return key;
    return fallback.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) =>
      params && Object.hasOwn(params, name) ? String(params[name]) : match);
  },
  load: async () => {
    try {
      const response = await requestLocal("/api/config", { cache: "no-store" });
      return response.ok && response.headers.get("Content-Type")?.split(";")[0]?.trim() === "application/json"
        ? { state: "ok", value: await response.json() } : { state: "error" };
    } catch { return { state: "error" }; }
  },
  onLoad: (config) => observeBackendAccountConfig(config),
  copy: async (value) => {
    try { await navigator.clipboard.writeText(value); return true; } catch { return false; }
  },
  // The token is sent once in this body and not kept; the server answers with an HttpOnly cookie.
  elevate: async (token) => {
    const response = await requestLocal("/api/config/elevate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    const body = await response.json().catch(() => ({}));
    if (response.ok) return { ok: true, secondsLeft: Number(body.seconds_left) || 0 };
    return { ok: false, error: String(body.error || response.status), retryAfter: Number(body.retry_after) || null };
  },
  revoke: async () => (await requestLocal("/api/config/elevate/revoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).ok,
  save: async (payload) => {
    const response = await requestLocal("/api/config/launch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (response.ok) return { ok: true };
    const body = await response.json().catch(() => ({}));
    return { ok: false, error: String(body.error || response.status), message: typeof body.message === "string" ? body.message : null };
  },
  // The per-agent launch options have their own route and their own revision.
  saveOptions: async (payload) => {
    const response = await requestLocal("/api/config/launch-options", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const body = await response.json().catch(() => ({}));
    return response.ok ? { ok: true } : { ok: false, error: String(body.error || response.status), message: typeof body.message === "string" ? body.message : null };
  },
  // The runner settings (the operator's display name) share the launch route and its elevation.
  saveSettings: async (settings) => {
    const response = await requestLocal("/api/config/launch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings }) });
    const body = await response.json().catch(() => ({}));
    return response.ok ? { ok: true, value: body } : { ok: false, error: String(body.error || response.status) };
  },
}, () => MeshI18n.locale(), {
  // Per browser (client store): who takes the shared terminal size (static/size-takeover.ts).
  get: sizeTakeoverMode,
  set: (mode) => {
    store.set(MeshPaneActions.SIZE_TAKEOVER_KEY, mode);
    for (const p of panes) if (p.conn && !p.termEl.hidden) p.followPtySize(p.conn);   // the banner, at once
  },
});
function sizeTakeoverMode() { return MeshPaneActions.sizeTakeoverMode(store.get(MeshPaneActions.SIZE_TAKEOVER_KEY, "auto")); }
let configOpenAttempt = 0;
$("#dlg-config [data-close-dialog]").addEventListener("click", () => {
  if (!MeshI18n.loaded) $("#dlg-config").close();
});
$("#btn-config").addEventListener("click", async () => {
  const attempt = ++configOpenAttempt;
  let timer;
  const ready = await Promise.race([
    MeshI18n.ready.then(() => true, () => false),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), 4000); }),
  ]);
  clearTimeout(timer);
  if (attempt !== configOpenAttempt) return;
  if (!ready) flash($("#config-translation-unavailable").textContent, 8000);
  configPanel.open();
});

let backendAccountPanel = null;
let backendAccountPorts = null;
let backendAccountCapabilityRead = null;
let backendAccountGeneration = 0;
function showBackendAccountEntries(available) {
  for (const entry of document.querySelectorAll('#btn-accounts, [data-mobile-action="btn-accounts"]')) entry.hidden = !available;
}
function showBackendAccountRetry(available) {
  for (const entry of document.querySelectorAll('#btn-accounts-retry, [data-mobile-action="btn-accounts-retry"]')) entry.hidden = !available;
}
function enableBackendAccountSettings() {
  if (!localMeshEffectsAllowed() || backendAccountPanel) return;
  const focused = document.activeElement;
  const returnFocus = focused?.matches?.('#btn-accounts-retry') ? document.querySelector('#btn-accounts')
    : focused?.matches?.('[data-mobile-action="btn-accounts-retry"]')
      ? document.querySelector('[data-mobile-action="btn-accounts"]') : null;
  ++backendAccountGeneration;
  backendAccountCapabilityRead?.abort(); backendAccountCapabilityRead = null;
  backendAccountPorts = MeshPaneActions.createBackendAccountApi((url, init) => requestLocal(url, init));
  backendAccountPanel = MeshPaneActions.createBackendAccountPanel(document.body, Object.assign(backendAccountPorts, {
    t, refreshCapability: () => { void startBackendAccountSettings(true); },
    clearCapability: clearBackendAccountCapability,
  }));
  showBackendAccountEntries(true);
  showBackendAccountRetry(false);
  returnFocus?.focus();
}
function observeBackendAccountConfig(config) {
  if (!localMeshEffectsAllowed() || backendAccountPanel) return;
  if (config?.capabilities?.account_settings === true) {
    enableBackendAccountSettings();
  } else if (!backendAccountPanel) {
    showBackendAccountRetry(false);
    ++backendAccountGeneration;
    backendAccountCapabilityRead?.abort(); backendAccountCapabilityRead = null;
  }
}
function clearBackendAccountCapability() {
  ++backendAccountGeneration;
  backendAccountCapabilityRead?.abort(); backendAccountCapabilityRead = null;
  backendAccountPorts.setProvisionCapability(undefined);
  backendAccountPanel.refreshProvisionView();
}
async function startBackendAccountSettings(refreshProvision = false) {
  if (!localMeshEffectsAllowed()) return;
  if (refreshProvision) {
    if (!backendAccountPanel) return;
    clearBackendAccountCapability();
  } else if (backendAccountPanel || backendAccountCapabilityRead) return;
  const generation = ++backendAccountGeneration, abort = new AbortController();
  let failed = true;
  backendAccountCapabilityRead = abort;
  const updateProvision = (value) => {
    backendAccountPorts.setProvisionCapability(value);
    backendAccountPanel.refreshProvisionView();
  };
  const timer = setTimeout(() => abort.abort(), 15_000);
  try {
    const response = await requestLocal("/api/config", { method: "GET", signal: abort.signal, credentials: "same-origin",
      mode: "same-origin", redirect: "error", cache: "no-store", headers: { Accept: "application/json" } });
    if (!response.ok || response.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json") return;
    const config = await response.json();
    if (abort.signal.aborted || generation !== backendAccountGeneration || !localMeshEffectsAllowed()) return;
    failed = false;
    if (backendAccountPanel) updateProvision(config?.capabilities?.account_settings === true
      ? config.capabilities.profile_provision : undefined);
    else if (config?.capabilities?.account_settings === true) enableBackendAccountSettings();
    else showBackendAccountRetry(false);
  } catch { /* An absent, refused or unreadable capability leaves account settings unavailable. */ }
  finally {
    clearTimeout(timer);
    if (backendAccountCapabilityRead === abort) backendAccountCapabilityRead = null;
    if (failed && generation === backendAccountGeneration && localMeshEffectsAllowed() && !backendAccountPanel)
      showBackendAccountRetry(true);
  }
}
function disposeBackendAccountSettings() {
  ++backendAccountGeneration;
  backendAccountCapabilityRead?.abort(); backendAccountCapabilityRead = null;
  showBackendAccountEntries(false);
  showBackendAccountRetry(false);
  backendAccountPanel?.dispose(); backendAccountPanel = null;
  backendAccountPorts = null;
}
whenTranslated(() => { void startBackendAccountSettings(); });
$("#btn-accounts-retry").addEventListener("click", () => { void startBackendAccountSettings(); });
$("#btn-accounts").addEventListener("click", (event) => {
  if (localActionUnavailable() || !backendAccountPanel) return;
  const trigger = event.currentTarget.getClientRects().length ? event.currentTarget : $("#btn-mobile-actions");
  void backendAccountPanel?.open(trigger);
});

// Local transport owns local account navigation. A loader returns a LoadOutcome
// (static/single-flight-poller.ts); a failure or a refusal is never an observed empty snapshot.
// A server that numbers its listings gets `since` and `focus` (docs/sessions-loading.md); the
// answer is merged into the last listing here, so the rest of the page always sees a whole one. A
// requested load (refresh() after a change) sends no `since`, so its answer holds that change.
async function loadLocalInventory(signal, attempt) {
  const epoch = meshPageEpoch, previous = lastListing;
  const current = () => localMeshEffectsAllowed() && !signal?.aborted && epoch === meshPageEpoch;
  const { url, since } = Progress.inventoryUrl("/api/sessions", previous, focusNames(), attempt?.requested === true);
  const response = await requestLocal(url, { signal });
  if (!current()) return { kind: "failed", status: null };
  if (response.status === 401) {
    forgetKnownSessions();
    inlineDictation?.dispose(); inlineDictationView?.cancel();
    location.href = "/login";
    return { kind: "refused" };
  }
  if (!response.ok) return { kind: "failed", status: response.status };
  const dropped = (row) => console.debug("session-mesh: a listing row without an id was dropped", row);
  const value = await response.json();
  if (!current()) return { kind: "failed", status: null };
  return { kind: "loaded", value: Progress.mergeListing(previous, value, since, dropped) };
}

// The sessions this page wants described first (`focus`, static/sessions-priority.ts).
let retryFocus = null;   // a row whose retry button was pressed: first in the next request's `focus`
function focusNames() {
  const names = Progress.focusRequest({ retry: retryFocus, active: active?.id, panes: panes.map((p) => p.id),
    pinned: pinnedSessions().map((p) => liveOf(p.id, p.agent)?.id), rows: data.mesh,
    visible: listWindow.visibleIds(Progress.PRIORITY_LIMIT, (id) => !isHist(id)), isSession: (id) => find(id)?.kind === "mesh" });
  retryFocus = null;
  return names;
}

// What this device knew at its last observed listing (static/known-sessions.ts): shown, as
// loading, before the server answers. Forgotten on sign-out and on a refused listing.
const KNOWN_KEY = "knownSessions";
let knownWritten = "";
let knownForgotten = false;
const SIGNED_OUT_KEY = "signedOutAt";   // set by a sign-out in any tab of this browser
function rememberKnownSessions(listing) {
  const known = Progress.knownFrom(listing);
  if (!known || knownForgotten || !Progress.mayRemember(store.get(SIGNED_OUT_KEY, null), pageStartedAt * 1000)) return;
  const text = JSON.stringify(known);
  if (text === knownWritten) return;
  knownWritten = text;
  store.set(KNOWN_KEY, known);
}
function forgetKnownSessions() {
  knownForgotten = true;
  references?.stop();   // the credential is gone: the known tracker ids go too
  const prefix = meshContext?.storagePrefix ?? "mesh";
  try {
    localStorage.removeItem(`${prefix}.${KNOWN_KEY}`);
    localStorage.removeItem(`${prefix}.recentFolders`);   // kept here by older versions (see moveRecentFoldersToRunner)
    localStorage.setItem(`${prefix}.${SIGNED_OUT_KEY}`, JSON.stringify(Date.now()));
  } catch {}
  // The Projects view's place and unsent answer drafts (static/work-view-state.ts); the sign-in page removes them too.
  workController?.forget();
  try { sessionStorage.removeItem("mesh.workView"); } catch {}
}

// Preserve the existing local DTO and management-observation distinction.
// Validation has no registry, rendering or network effects.
function validateInventorySnapshot(next) {
  if (!next || typeof next !== "object" || !Array.isArray(next.mesh) || !Array.isArray(next.external)) return null;
  let identities = null;
  if (next.management?.state === "observed") {
    identities = [];
    for (const session of next.mesh) {
      if (!session || session.kind !== "mesh" || typeof session.id !== "string" || !session.id
          || typeof session.name !== "string" || !session.name
          || (session.created != null && (typeof session.created !== "number" || !Number.isFinite(session.created)))) return null;
      identities.push({ id: session.id, name: session.name, created: session.created ?? null });
    }
  }
  return { next, identities };
}

// One listing request at a time per tab (static/single-flight-poller.ts): refresh() joins the request
// in flight, or the single follow-up that starts after it; the poll waits as long as the server took
// to answer (1 s base while the server says its listing is incomplete, 4 s otherwise, at least 30 s
// while the tab is hidden); becoming visible or getting the network back asks at once.
function startInventory(context, cacheResume = false) {
  inventoryPoller?.stop();
  pageSignals?.dispose();
  const epoch = meshPageEpoch;
  let shortRecoveryDeadline = cacheResume;
  const current = () => localMeshEffectsAllowed() && meshContext === context && epoch === meshPageEpoch;
  let issue = paneInventoryIssue;
  inventoryPoller = Progress.createPoller({
    load: async (signal, attempt) => {
      issue = ++paneInventoryIssue;
      let aborted;
      try {
        // The poller aborts at its deadline. Race even a loader/body adapter
        // that ignores abort, so a cached page can resume polling afterwards.
        const outcome = await Promise.race([
          Promise.resolve().then(() => context.inventory(signal, attempt)),
          new Promise(resolve => {
            aborted = () => resolve({kind: "failed", status: null});
            if (signal.aborted) aborted();
            else signal.addEventListener("abort", aborted, {once: true});
          }),
        ]);
        if (current() && !signal.aborted && outcome?.kind !== "loaded") reportDictationInventory(issue, false);
        return outcome;
      } catch (error) {
        if (current() && !signal.aborted) reportDictationInventory(issue, false);
        throw error;
      } finally {if (aborted) signal.removeEventListener("abort", aborted);}
    },
    apply: (value) => {
      if (!current()) return undefined;
      if (Progress.holdKnownRows(value, data)) {
        lastListing = value; reportDictationInventory(issue, false); sessionsStatus.render(); return undefined;
      }
      const snapshot = validateInventorySnapshot(value);
      if (!snapshot) {reportDictationInventory(issue, false); return undefined;}
      const applied = applyInventorySnapshot(issue, snapshot);
      reportDictationInventory(issue, !!applied && snapshot.identities !== null);
      return applied;
    },
    clock: { now: () => Date.now(), setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: (handle) => clearTimeout(handle) },
    baseIntervalMs: () => (Progress.complete(lastListing) ? 4000 : 1000),
    minDelayMs: () => pageSignals?.minDelayMs() ?? 0,
    timeoutMs: () => {
      const timeout = shortRecoveryDeadline ? 5000 : Progress.TIMEOUT_MS;
      shortRecoveryDeadline = false;
      return timeout;
    },
    onChange: (state) => {
      if (!current() || state.stopped) return;
      if (state.lastFailureKind === "timeout") reportDictationInventory(issue, false);
      sessionsStatus.render();
    },
    onApplyError: (error) => {
      if (current()) reportDictationInventory(issue, false);
      console.error("session-mesh: the session list could not be applied", error);
    },
  });
  pageSignals = Progress.watchPageSignals({ win: window, doc: document, wake: () => void refresh(), changed: () => sessionsStatus.render() });
  return inventoryPoller.start();
}

// "Where are we": the status line above the list (static/sessions-status.ts, status-line-view.ts).
const statusTime = (at) => new Date(at).toLocaleTimeString(MeshI18n.locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const sessionsStatus = Progress.createStatusView({ box: $("#sessions-status"), translate: t, onRetry: () => void refresh(),
  now: () => Date.now(), timers: window, read: (now) => {
    if (!inventoryPoller) return { line: null, ticking: false };
    const poller = inventoryPoller.state();
    const line = Progress.statusLine({ poller, listing: lastListing, rows: shownMesh(), now, formatTime: statusTime,
      offline: pageSignals?.offline() ?? false, hostSilent: hostSilence.silent() });
    return { line, ticking: Progress.statusTicks(line, poller) };
  } });

function refresh() {
  if (!localMeshEffectsAllowed() || !inventoryPoller) return Promise.resolve();
  return inventoryPoller.request();
}

// The first observed listing settles the panes restored before it (`provisional` holds the session
// each was restored to): a session it does not list is shown as unavailable, its place in the layout
// kept, as a restore without the list would have. A pane that shows something else by then (a
// history card, another session) is left as it is.
let inventoryObserved = false;   // an observed listing has been applied
function settleProvisionalPanes() {
  for (const p of panes) {
    const restored = p.provisional;
    if (!restored) continue;
    p.provisional = false;
    if (p.id === restored && !find(restored)) p.showUnavailable("missing-target", restored, "terminal");
  }
}
// A pane just restored to a session the server has not listed yet (`unlisted`: the provisional
// rows at boot). Marked at once, so a listing that arrives while a later pane is still being restored
// settles it; settled at once when an observed listing has already arrived.
function markProvisional(p, unlisted) {
  if (!p?.id || !unlisted.has(p.id)) return;
  p.provisional = p.id;
  if (inventoryObserved) settleProvisionalPanes();
}

function applyInventorySnapshot(issue, { next, identities }) {
  let observedInventory = false;
  try {
    if (identities !== null) {
      if (!paneTargets.applyInventory(issue, identities)) return;
      observedInventory = true;
    }
    lastListing = next;
    inventoryLoaded = true;
    hostSilence.update(next, data.mesh, observedInventory);   // `data` is still the previous listing here
    data = next;
    accountSwitchPicker.revalidate();
    if (observedInventory) rememberKnownSessions(next);
    if (localMeshEffectsAllowed()) {
      void sessionRequestGate.consider(next.sessionRequests);
      mailboxPanel.note(next.agentMailConsent);
      void agentMailConsentGate.consider(next.agentMailConsent);
    }
    activityRanking = MeshSessionActivity.update(activityRanking, [...next.mesh, ...next.external],
      next.management, typeof next.now === "number" ? next.now : Date.now() / 1000);
  } catch { return; }
  if (observedInventory) restorePendingCachedTerminals();
  if (observedInventory && localMeshEffectsAllowed()) receiveBoardSignals(data.signals);
  if (localMeshEffectsAllowed()) checkClientVersion(data.client_version);
  showUpdateNotice(data.update);
  if (typeof data.now === "number") clockOffset = data.now - Date.now() / 1000;
  directLineAlive();   // the agent may have left the foreground
  markSeen();   // before the panes and the list are drawn
  invalidateReplacedDemoPanes();
  consumeOpens();
  syncPanesWithListing(observedInventory);
  if (observedInventory) { inventoryObserved = true; settleProvisionalPanes(); }
  if (localMeshEffectsAllowed()) checkDemoSceneUpdates();
  listBatch.request();   // one sidebar render per frame, however many answers arrive in it
  sessionsStatus.render();
  if (localMeshEffectsAllowed()) {
    if (managing) renderManagement();
    renderRestore();
    pollWatched();
    pollHistory();
    tickSessionMarker();
    tickReferences();
  }
  return { portfolio: data.portfolio };
}

// Requests to open a pane (the listing's `opens`) are handled once the saved panes are restored: met
// during the restore, a request could find its anchor pane not restored yet and be lost. Requests made
// before the page started are not replayed (static/open-replay.ts).
function consumeOpens() {
  if (restoringWorkspace) return;
  const opens = localMeshEffectsAllowed() ? data.opens : [];
  lastOpen = Progress.replayCutoff(lastOpen, opens, pageStartedAt + clockOffset);
  for (const o of Array.isArray(opens) ? opens : []) if (o.seq > lastOpen) { lastOpen = o.seq; handleOpen(o); }
}

// The panes after a listing: an adopted session followed, an ended terminal attached again, headers redrawn.
function syncPanesWithListing(observedInventory) {
  for (const p of panes) {
    if (p.back && data.moved?.[p.back]) p.back = data.moved[p.back];   // adopted: back to its new id
    if (!p.id || isAdjacentPane(p.id)) { p.header(); continue; }
    const moved = data.moved?.[p.id];
    if (moved && find(moved)) {
      if (p.conn?.cacheRestore) p.cancelCachedRestore(p.conn);
      else if (p.cachedTerminalMoveBlockedId !== p.id) p.show(moved);
      continue;
    }
    if (isHist(p.id)) {
      p.header();
      if (p.hist?.d && (liveOf(p.hist.d.id, p.hist.d.agent)?.id || null) !== p.hist.live) p.renderHist();
      continue;
    }
    const s = find(p.id);
    if (!s && observedInventory && p.conn?.cacheRestore) {
      p.cancelCachedRestore(p.conn); p.header(); continue;
    }
    if (!s && observedInventory && p.id.startsWith("t")) p.clear();
    else if (s) {
      if (localMeshEffectsAllowed() && s.kind === "mesh") {
        if (p.conn?.cacheRestore) {
          if (observedInventory && Number.isFinite(s.created) && s.created > 0 && s.created !== p.conn.created)
            p.cancelCachedRestore(p.conn);
        } else {
          const refreshBinding = p.conn && observedInventory && !s.provisional &&
            (p.conn?.waitingListing || (Number.isFinite(s.created) && s.created > 0 && p.conn?.created !== s.created) ||
             (p.conn?.cachedAck && p.conn?.created === s.created && p.inputAck?.version === 1 &&
              listedInputVersion(s) === 2 &&
              ![...p.inputAcks.values()].some((entry) => entry.input.pendingBytes || entry.lease?.dirty)));
          if (p.conn?.ended || refreshBinding) {
            const focusTerminal = active === p && p.conn?.name === p.id && p.conn?.focusRequested === true;
            p.attach(p.id, { focusTerminal });
          }
        }
      }
      p.header();
      if (s.kind === "external") p.renderDetail(s);
    }
  }
}

// ---------------------------------------------------------------- restore after a ptyhost restart
//
// The server offers the sessions a ptyhost restart ended (`restorable`). Nothing starts without
// a click: an agent is relaunched on its conversation with the options it was started with
// (`--yolo` for a codex-yolo session).

const restoreOff = new Set();   // names unchecked by the owner
let restoreKey = "";
let restoreBusy = false;
// What the last restoration said when it succeeded in part: shown in the offer (which stays) until the owner's next
// restore or ignore, where the flash disappears after a few seconds.
let restoreNotice = "";
let restoreNoticeNames = [];   // the sessions the notice speaks of: it goes when none of them is offered any more

function restoreDetail(e) {
  if (e.agent && e.resumable) return t("restore.detail.resumes", { agent: e.agent });
  if (e.agent) return t("restore.detail.unknownConversation", { agent: e.agent });
  return e.running ? t("restore.detail.wasRunning", { command: e.running }) : "shell";
}

function restoreRow(e) {
  const row = document.createElement("label");
  row.className = "restore-row";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = !restoreOff.has(e.name);
  box.dataset.name = e.name;
  const text = document.createElement("span");
  text.className = "restore-name";
  text.textContent = e.name;
  const more = document.createElement("span");
  more.className = "mute";
  more.textContent = `${short(e.cwd)} · ${restoreDetail(e)}`;
  row.append(box, text, more);
  return row;
}

function restoreChosen() {
  return [...document.querySelectorAll("#restore input[data-name]")].filter((b) => b.checked).map((b) => b.dataset.name);
}

function restoreButtons() {
  const n = restoreChosen().length;
  const go = $("#restore-go");
  if (go) { go.disabled = restoreBusy || !n; go.textContent = t("restore.go", { n }); }
}

function renderRestore() {
  const box = $("#restore");
  const offer = data.restorable || [];
  const key = offer.map((e) => `${e.name}:${e.created}`).join("|");
  box.hidden = !offer.length;
  // An offer that went away without a click here (dismissed elsewhere, expired) takes its notice with it.
  if (restoreNotice && !restoreNoticeNames.some((name) => offer.some((e) => e.name === name))) restoreNotice = "";
  if (!offer.length) restoreKey = "";
  if (!offer.length || key === restoreKey) return;   // the 4 s refresh must not reset the checkboxes
  restoreKey = key;
  const head = document.createElement("div");
  head.className = "restore-head";
  head.textContent = t("restore.lost", { n: offer.length });
  const actions = document.createElement("div");
  actions.className = "restore-actions";
  actions.innerHTML = `<button id="restore-go" class="btn primary sm"></button><button id="restore-ignore" class="btn ghost sm" title="${esc(t("restore.ignoreHint"))}">${esc(t("restore.ignore"))}</button>`;
  const rebind = document.createElement("button");
  rebind.className = "btn ghost sm";
  rebind.textContent = t("restore.rebind.open");
  rebind.addEventListener("click", openRestoreRebind);
  actions.append(rebind);
  const hint = document.createElement("div");
  hint.className = "mute restore-hint";
  hint.textContent = t("restore.ignoreHint");
  const notice = document.createElement("div");
  notice.id = "restore-warnings";
  notice.className = "restore-warnings";
  notice.setAttribute("role", "status");
  notice.textContent = restoreNotice;     // textContent only: the warnings quote session names
  notice.hidden = !restoreNotice;
  box.replaceChildren(head, ...offer.map(restoreRow), notice, actions, hint);
  restoreButtons();
}

// Rebinding changes only the saved offer; it never launches an agent. The preview
// binds confirmation to both the exact offer and the profile revision.
async function openRestoreRebind() {
  if (localActionUnavailable()) return;
  const dialog = document.createElement("dialog");
  dialog.className = "restore-rebind";
  const heading = document.createElement("h2"); heading.id = "restore-rebind-title"; heading.textContent = t("restore.rebind.title");
  dialog.setAttribute("aria-labelledby", heading.id);
  const explanation = document.createElement("p"); explanation.textContent = t("restore.rebind.hint");
  const offerLabel = document.createElement("label"); offerLabel.textContent = t("restore.rebind.session");
  const offerSelect = document.createElement("select"); offerLabel.append(offerSelect);
  const accountLabel = document.createElement("label"); accountLabel.textContent = t("restore.rebind.account");
  const accountSelect = document.createElement("select"); accountLabel.append(accountSelect);
  const details = document.createElement("pre"); details.className = "restore-rebind-details"; details.hidden = true;
  const status = document.createElement("p"); status.setAttribute("role", "status");
  const preview = document.createElement("button"); preview.className = "btn primary"; preview.textContent = t("restore.rebind.preview"); preview.disabled = true;
  const confirm = document.createElement("button"); confirm.className = "btn primary"; confirm.textContent = t("restore.rebind.confirm"); confirm.hidden = true;
  const close = document.createElement("button"); close.className = "btn ghost"; close.textContent = t("restore.rebind.close");
  const actions = document.createElement("div"); actions.className = "restore-actions"; actions.append(preview, confirm, close);
  dialog.append(heading, explanation, offerLabel, accountLabel, details, status, actions);
  document.body.append(dialog); dialog.addEventListener("close", () => dialog.remove(), {once: true});
  close.addEventListener("click", () => dialog.close()); dialog.showModal();
  let offers = [], profiles = [], proposal = null, busy = false, offersFresh = false;
  const reset = () => { proposal = null; details.hidden = true; confirm.hidden = true; preview.hidden = !offersFresh; if (offersFresh) status.textContent = ""; };
  const updateProfiles = () => {
    reset(); accountSelect.replaceChildren();
    const offer = offers[Number(offerSelect.value)];
    profiles.filter(p => p.enabled === true && p.backend === offer?.expected?.agent_kind).forEach(p => {
      const option = document.createElement("option"); option.value = p.id; option.textContent = p.label; accountSelect.append(option);
    });
    preview.disabled = !offersFresh || !accountSelect.options.length;
  };
  offerSelect.addEventListener("change", updateProfiles); accountSelect.addEventListener("change", reset);
  try {
    const [a, b] = await Promise.all([requestLocal("/api/restore/rebind", {cache:"no-store"}), requestLocal("/api/accounts/profiles", {cache:"no-store"})]);
    if (!a.ok || !b.ok) throw new Error();
    const listed = await a.json(), registry = await b.json();
    if (!Array.isArray(listed.offers) || !Array.isArray(registry?.data?.profiles)) throw new Error();
    offers = listed.offers.filter(o => o?.expected && typeof o.expected.name === "string"); profiles = registry.data.profiles; offersFresh = true;
    offers.forEach((o, i) => { const option = document.createElement("option"); option.value = String(i); option.textContent = `${o.expected.name} · ${o.previous_account}`; offerSelect.append(option); });
    if (!offers.length) status.textContent = t("restore.rebind.none"); else updateProfiles();
  } catch { status.textContent = t("restore.rebind.unavailable"); }
  preview.addEventListener("click", async () => {
    if (busy || !offersFresh) return; busy = true; preview.disabled = true; offerSelect.disabled = accountSelect.disabled = true;
    try {
      const selected = offers[Number(offerSelect.value)];
      const r = await requestLocal("/api/restore/rebind", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({action:"preview", expected:selected.expected, account:accountSelect.value})});
      if (!r.ok) throw new Error();
      const result = await r.json();
      if (result.ok !== true || typeof result.offer_digest !== "string" || typeof result.context_revision !== "string" || typeof result.config_root !== "string") throw new Error();
      proposal = {expected:selected.expected, account:accountSelect.value, context_revision:result.context_revision, offer_digest:result.offer_digest};
      details.textContent = `${t("restore.rebind.account")}: ${result.label} (${result.account})\n${t("restore.rebind.root")}: ${result.config_root}\n${t("restore.rebind.revision")}: ${result.context_revision}`;
      details.hidden = false; preview.hidden = true; confirm.hidden = false;
    } catch { status.textContent = t("restore.rebind.stale"); }
    finally { busy = false; preview.disabled = false; offerSelect.disabled = accountSelect.disabled = false; }
  });
  const refreshOffersAfterUncertain = async () => {
    offersFresh = false; preview.hidden = true; preview.disabled = true;
    try {
      const response = await requestLocal("/api/restore/rebind", {cache:"no-store"});
      if (!response.ok) throw new Error();
      const listed = await response.json();
      if (!Array.isArray(listed.offers)) throw new Error();
      offers = listed.offers.filter(o => o?.expected && typeof o.expected.name === "string");
      offersFresh = true; offerSelect.replaceChildren();
      offers.forEach((o, i) => { const option = document.createElement("option"); option.value = String(i); option.textContent = `${o.expected.name} · ${o.previous_account}`; offerSelect.append(option); });
      if (offers.length) { updateProfiles(); preview.hidden = false; }
    } catch { /* Keep preview unavailable until the dialog is reopened. */ }
    status.textContent = t("restore.rebind.uncertain");
  };
  confirm.addEventListener("click", async () => {
    if (busy || !proposal) return; busy = true; confirm.disabled = true; offerSelect.disabled = accountSelect.disabled = true;
    try {
      const r = await requestLocal("/api/restore/rebind", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({action:"confirm", ...proposal})});
      if (!r.ok) {
        confirm.hidden = true; proposal = null;
        if ([400, 401, 403, 409].includes(r.status)) { status.textContent = t("restore.rebind.stale"); preview.hidden = false; preview.disabled = false; }
        else await refreshOffersAfterUncertain();
        return;
      }
      const result = await r.json();
      if (result.ok !== true) throw new Error();
      status.textContent = t("restore.rebind.done"); confirm.hidden = true; proposal = null;
      restoreKey = ""; await refresh();
    } catch { confirm.hidden = true; proposal = null; await refreshOffersAfterUncertain(); }
    finally { busy = false; confirm.disabled = false; offerSelect.disabled = accountSelect.disabled = false; }
  });
}

// The restore routes take at most 50 names per request: larger offers go in batches, one after
// the other, stopping at the first refused or failed one (its names and the later ones stay offered).
async function restorePost(path, names) {
  return MeshPaneActions.postInBatches(names, async (batch) => {
    try {
      const r = await requestLocal(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ names: batch }) });
      if (!r.ok) return { ok: false, error: serverText(await r.text()) };
      const body = await r.json();
      return { ok: true, results: body && typeof body.results === "object" ? body.results : {} };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });
}

// What was not sent, and why: "" when every batch was answered.
function restoreUnsent(out) {
  return out.error === null ? "" : t("restore.notSent", { n: out.unsent.length, error: out.error });
}

async function restoreGo() {
  if (localActionUnavailable()) return;
  const names = restoreChosen();
  if (!names.length || restoreBusy) return;
  restoreBusy = true;
  restoreNotice = "";
  restoreButtons();
  try {
    const out = await restorePost("/api/restore", names);
    const unsent = restoreUnsent(out);
    if (!out.sent.length) { flash(out.error); return; }   // nothing answered: the refusal alone, as before
    const bad = Object.entries(out.results).filter(([, r]) => !r.ok);
    const notes = Object.values(out.results).map((r) => r.note).filter(Boolean);
    const warnings = restoreWarnings(out.results);
    const done = bad.length ? restoreFailures(bad)
      : notes[0] ? serverText(notes[0]) : t("restore.done", { n: out.sent.length });
    const summary = unsent ? `${done} ${unsent}` : done;
    // A restoration can succeed in part (the session exists, its agent mail stays at the old identity and the
    // offer stays): the warnings say so, with the name of the session they concern.
    if (warnings) {
      restoreNotice = t("restore.withWarnings", { summary, warnings });
      restoreNoticeNames = Object.entries(out.results).filter(([, r]) => Array.isArray(r.warnings) && r.warnings.length).map(([name]) => name);
      flashLong(restoreNotice);
    } else (bad.length || unsent ? flashLong : flash)(summary);
  } finally { restoreBusy = false; restoreKey = ""; await refresh(); }
}

// The warnings of the sessions that were restored, by name, translated: "" when there are none.
function restoreWarnings(results) {
  return Object.entries(results)
    .flatMap(([name, r]) => (Array.isArray(r.warnings) ? r.warnings : []).map((warning) => t("restore.warningItem", { name, warning: serverText(warning) })))
    .join("; ");
}

// Every refused session, by name with its reason: the restore goes on after a
// refusal, and each refused session stays offered.
function restoreFailures(bad) {
  const failures = bad.map(([name, r]) => t("restore.failedItem", { name, error: serverText(r.error) }));
  return t("restore.failed", { n: bad.length, failures: failures.join("; ") });
}

$("#restore").addEventListener("change", (e) => {
  const name = e.target.dataset?.name;
  if (name) { e.target.checked ? restoreOff.delete(name) : restoreOff.add(name); restoreButtons(); }
});
$("#restore").addEventListener("click", async (e) => {
  if (e.target.closest("#restore-go")) restoreGo();
  else if (e.target.closest("#restore-ignore")) {
    restoreNotice = "";
    const out = await restorePost("/api/restore/discard", (data.restorable || []).map((x) => x.name));
    if (out.error !== null) flash(out.sent.length ? restoreUnsent(out) : out.error);
    if (out.sent.length) { restoreKey = ""; await refresh(); }
  }
});

// Start or stop watching a document; the current mtime is the baseline, so turning
// it on does not reload at once.
async function setWatch(w, on) {
  if (localActionUnavailable()) return;
  w.watch = on;
  if (!on) return;
  try {
    const r = await requestLocal("/api/stat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targets: [w.target] }) });
    if (r.ok) w.mtime = (await r.json()).mtimes[w.target] ?? null;
  } catch {}
}

// A watched document is reloaded when its file changes. One batched stat per refresh;
// /api/view is not polled, every call to it mints a new URL.
let polling = false;
async function pollWatched() {
  if (!localMeshEffectsAllowed()) return;
  const watched = panes.filter((p) => isWebPane(p.id) && webs.get(p.id)?.watch);
  if (polling || !watched.length) return;
  polling = true;
  try {
    const targets = [...new Set(watched.map((p) => webs.get(p.id).target))];
    const r = await requestLocal("/api/stat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targets }) });
    if (!r.ok) return;
    const { mtimes } = await r.json();
    for (const p of watched) {
      const w = webs.get(p.id);
      const now = w && mtimes[w.target];
      if (!now || now === w.mtime) continue;   // missing for now (an editor replacing the file): keep waiting
      w.mtime = now;
      p.reloadWeb();
    }
  } catch {} finally { polling = false; }
}

const menuButton = $("#btn-menu");
const mobileActionsButton = $("#btn-mobile-actions");
const mobileActionsSheet = $("#mobile-actions-sheet");
let mobilePiScrollTarget = null;
let mobileActionsHandoff = false;
const mobilePanelsButton = $("#btn-mobile-panels");
const mobilePanelsSheet = $("#mobile-panels-sheet");
const mobilePanelsList = $("#mobile-panels-list");

function syncMobileChrome() {
  menuButton.setAttribute("aria-expanded", String(document.body.classList.contains("drawer")));
  mobileActionsButton.setAttribute("aria-expanded", String(mobileActionsSheet.open));
  mobilePanelsButton.setAttribute("aria-expanded", String(mobilePanelsSheet.open));
}

function closeMobileActions() {
  mobileActionsSheet.close();
  mobileActionsButton.setAttribute("aria-expanded", "false");
}

function closeMobilePanels() {
  mobilePanelsSheet.close();
  syncMobileChrome();
  if (narrow()) mobilePanelsButton.focus({ preventScroll: true });
}

function renderMobilePanels() {
  mobilePanelsList.replaceChildren();
  for (const group of workspaceGroups) for (const pane of group.tabs) {
    const row = document.createElement("div");
    row.className = "mobile-panel-row";
    const choose = document.createElement("button");
    choose.className = "btn";
    choose.type = "button";
    choose.textContent = `${paneKindLabel(pane)} · ${$(".p-name", pane.el).textContent || t("pane.newShort")}`;
    choose.addEventListener("click", () => { closeMobilePanels(); setActive(pane, true); });
    row.append(choose);
    const identity = document.createElement("small");
    identity.className = "mobile-panel-identity";
    identity.textContent = pane.panelIdentity ? `${pane.panelIdentity.origin} · ${pane.panelIdentity.session} · ${pane.panelIdentity.rights}` : t("mobilePanels.unknownIdentity");
    row.append(identity);
    const close = document.createElement("button");
    close.className = "btn ghost";
    close.type = "button";
    close.textContent = t("common.close");
    close.title = t("mobilePanels.closeTitle");
    close.setAttribute("aria-label", t("mobilePanels.closeLabel", { name: $(".p-name", pane.el).textContent || t("pane.newShort") }));
    close.disabled = panes.length < 2;
    close.addEventListener("click", () => { closePane(pane); renderMobilePanels(); });
    row.append(close);
    mobilePanelsList.append(row);
  }
}

new MutationObserver(syncMobileChrome).observe(document.body, { attributes: true, attributeFilter: ["class"] });
mobileActionsSheet.addEventListener("close", () => {
  syncMobileChrome();
  // The close event is asynchronous: an action chosen in the sheet has already
  // moved focus to its own target, which must not be taken back.
  const handedOff = mobileActionsHandoff;
  mobileActionsHandoff = false;
  if (narrow() && !handedOff) mobileActionsButton.focus({ preventScroll: true });
});
mobileActionsSheet.addEventListener("cancel", (e) => {
  e.preventDefault();
  closeMobileActions();
});
mobileActionsSheet.addEventListener("click", (e) => {
  if (e.target === mobileActionsSheet) closeMobileActions();
});
mobilePanelsSheet.addEventListener("cancel", (e) => { e.preventDefault(); closeMobilePanels(); });
mobilePanelsSheet.addEventListener("click", (e) => { if (e.target === mobilePanelsSheet) closeMobilePanels(); });
$("#mobile-panels-sheet [value=cancel]").addEventListener("click", closeMobilePanels);
mobilePanelsButton.addEventListener("click", () => { renderMobilePanels(); mobilePanelsSheet.showModal(); syncMobileChrome(); });
mobileActionsSheet.addEventListener("click", (e) => {
  const target = e.target.closest("[data-mobile-action]");
  if (!target) return;
  const piTarget = mobilePiScrollTarget;
  mobileActionsHandoff = true;
  closeMobileActions();
  if (target.dataset.mobileAction === "pi-scroll") {
    if (piTarget) restorePiFullscreenScroll(piTarget.id, piTarget.created);
    return;
  }
  if (target.dataset.mobileAction === "raw-scrollback") {
    active?.enableCodexRawScrollback();
    return;
  }
  $("#" + target.dataset.mobileAction).click();
});
$("#mobile-actions-sheet [value=cancel]").addEventListener("click", closeMobileActions);
menuButton.addEventListener("click", () => document.body.classList.toggle("drawer"));
mobileActionsButton.addEventListener("click", () => {
  if (!narrow()) return;
  syncMobileRawScrollAction();
  if (mobileActionsSheet.open) closeMobileActions();
  else {
    const session = active?.id && find(active.id);
    mobilePiScrollTarget = hasFullscreenScrollRecovery(session) ? { id: session.id, created: session.created } : null;
    mobileActionsHandoff = false;
    mobileActionsSheet.showModal();
  }
  syncMobileChrome();
});
syncMobileChrome();

// Narrow edge navigation owns an action only after deliberate horizontal intent.
{
  let gesture = null;
  const pointers = new Set();
  const excluded = target => target.closest('input,textarea,select,button,a,[contenteditable],dialog,.project-followup,.project-followup-chart,#keys,#line,.gutter,.pane-resize,.p-actions');
  const reset = () => { gesture = null; };
  document.addEventListener('pointerdown', event => {
    pointers.add(event.pointerId);
    if (!narrow() || pointers.size !== 1 || !event.isPrimary || event.button !== 0 || excluded(event.target)) { reset(); return; }
    const open = document.body.classList.contains('drawer');
    const edge = event.clientX < 40 ? 'sessions' : event.clientX > innerWidth - 40 ? 'projects' : null;
    if (!edge && !(open && event.target.closest('#side'))) return;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now(), edge, open, mode: projecting };
  }, { capture: true });
  document.addEventListener('pointermove', event => {
    const start = gesture; if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (!narrow() || pointers.size !== 1 || performance.now() - start.at >= 500 || Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx) || String(getSelection() ?? '')) { reset(); return; }
    if (Math.abs(dx) < 50 || Math.abs(dx) < 2 * Math.abs(dy)) return;
    reset();
    const wantsSessions = start.edge === 'sessions' && dx > 0;
    const wantsProjects = start.edge === 'projects' && dx < 0;
    if (start.open) {
      if (start.mode ? dx > 0 : dx < 0) document.body.classList.remove('drawer');
      return;
    }
    if (!wantsSessions && !wantsProjects) return;
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    if (wantsProjects && !projecting) setProjects(true);
    if (wantsSessions && projecting) setProjects(false);
    document.body.classList.add('drawer');
  }, { capture: true, passive: false });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) document.addEventListener(name, event => { pointers.delete(event.pointerId); reset(); }, { capture: true });
  let drawerWidth = innerWidth;
  window.addEventListener('resize', () => {
    reset();
    if (MeshPaneActions.drawerClosesOnResize(drawerWidth, innerWidth)) document.body.classList.remove('drawer');
    drawerWidth = innerWidth;
  });
}
$("#main").addEventListener("click", (e) => {
  if (document.body.classList.contains("drawer") && !e.target.closest("#btn-menu")) document.body.classList.remove("drawer");
});

// ---------------------------------------------------------------- history
//
// Past claude / codex conversations from their transcripts. The sidebar's
// "History" tab groups them by folder (first folder under ~, then the
// working dir); the explorer is the same list as a table, for sorting and
// deleting in bulk. A session id is "h:<agent>:<id>" wherever a pane id goes.

let tab = store.get("tab", "live");
const hist = { gen: null, list: [], by: new Map(), names: [], namesGen: null, indexing: false, error: null, skipped: 0, degraded: false };
const HIST_AGENTS = ["claude", "codex", "pi", "opencode", "gemini", "agy", "copilot", "vibe"];
const histFilterDefaults = () => ({ ...Object.fromEntries(HIST_AGENTS.map((a) => [a, true])), exec: false, live: false });
// the resume command shown on a card, per agent (the argv Mesh itself launches: resumeargs.py)
const HIST_RESUME_CMD = { claude: "claude --resume ", codex: "codex resume ", pi: "pi --session ", opencode: "opencode --session ",
  gemini: "gemini --resume ", agy: "agy --conversation ", copilot: "copilot --resume=", vibe: "vibe --resume " };
const hf = Object.assign(histFilterDefaults(), store.get("hfilter", {}));
const unfoldedLeaves = new Set();
const LEAF_MAX = 5;
const hkey = (d) => `h:${d.agent}:${d.id}`;
const histTitle = (d) => d.mesh_label || d.mesh_name || d.name || d.title || d.first || d.id;
const tokens = (d) => (d.tin || 0) + (d.tout || 0) + (d.tcr || 0) + (d.tcw || 0);

// a number with exactly `digits` decimals, in the interface language
const fmtFixed = (value, digits) => value.toLocaleString(MeshI18n.locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
// a number with at most one decimal, in the interface language
const fmtDecimal = (value) => value.toLocaleString(MeshI18n.locale(), { maximumFractionDigits: 1 });
function fmtN(n) {
  if (!n) return "—";
  if (n < 1000) return String(n);
  if (n < 1e6) return t("units.thousands", { value: fmtFixed(n / 1e3, n < 1e4 ? 1 : 0) });
  if (n < 1e9) return t("units.millions", { value: fmtFixed(n / 1e6, n < 1e7 ? 1 : 0) });
  return t("units.billions", { value: fmtFixed(n / 1e9, 1) });
}
function fmtBytes(n) {
  if (!n) return "—";
  if (n < 1024 * 1024) return t("units.kilobytes", { value: Math.max(1, Math.round(n / 1024)) });
  if (n < 1024 ** 3) return t("units.megabytes", { value: fmtFixed(n / 1024 ** 2, 1) });
  return t("units.gigabytes", { value: fmtFixed(n / 1024 ** 3, 1) });
}
const fmtDate = (ts) => (ts ? new Date(ts * 1000).toLocaleString(MeshI18n.locale(), { dateStyle: "short", timeStyle: "short" }) : "—");
function fmtSpan(a, b) {
  const m = Math.round(Math.max(0, (b || 0) - (a || 0)) / 60);
  return !a || !b ? "—" : m < 60 ? t("units.minutes", { value: m })
    : t("units.hoursMinutes", { hours: Math.floor(m / 60), minutes: String(m % 60).padStart(2, "0") });
}

// conversation id -> the mesh session or terminal running it now; a session whose id the agent reported
// (or was launched with) is preferred to one whose id was guessed from the folder's history, as on the server
function liveOf(sid, agent = null) {
  if (!sid) return null;
  const found = [...data.mesh, ...data.external].filter((s) => s.agent?.session_id === sid
    && (agent === null || s.agent.type === agent));
  return found.find((s) => s.agent.identity_source !== "history_cwd") || found[0] || null;
}

// The list is fetched whole once, then as changes since the generation the
// client has (the server sends the changed entries and the removed ids). One
// request at a time: a caller arriving meanwhile shares it, or with fresh
// (after a change of its own) waits for it and asks again.
let histLoading = null, histLoadedAt = 0;
const HIST_POLL = 15000;
function loadHistory(fresh) {
  if (histLoading) return fresh ? histLoading.then(() => loadHistory()) : histLoading;
  histLoading = fetchHistory().finally(() => { histLoading = null; histLoadedAt = Date.now(); });
  return histLoading;
}
async function fetchHistory() {
  try {
    const params = new URLSearchParams();
    if (hist.gen !== null) params.set("gen", String(hist.gen));
    if (hist.namesGen !== null) params.set("names_gen", hist.namesGen);
    const r = await requestLocal(`/api/history${params.size ? `?${params}` : ""}`);
    if (r.status === 401) {
      forgetKnownSessions();   // as a refused listing does: the Projects view's drafts go too
      location.href = "/login";
      return;
    }
    if (!r.ok) throw new Error(serverText(await r.text()) || r.statusText);
    const j = await r.json();
    hist.error = null;
    hist.indexing = j.indexing;
    hist.skipped = Number.isInteger(j.skipped) ? j.skipped : 0;
    hist.degraded = j.degraded === true;
    // the server could not list the index: keep the generation and the list as they are (no gen, no sessions)
    if (j.listing_failed === true) return;
    hist.gen = j.gen;
    if (!j.names_unchanged) hist.names = MeshHistoryState.bindings(j.mesh_names);
    hist.namesGen = typeof j.names_gen === "string" ? j.names_gen : null;
    if (j.unchanged) {
      if (j.names_unchanged) return;
      hist.list = [...hist.by.values()].map(d => MeshHistoryState.decorate(d, hist.names))
        .sort((a, b) => (b.updated || 0) - (a.updated || 0));
      return;
    }
    if (j.full) hist.by = new Map();
    for (const k of j.gone) hist.by.delete(`h:${k}`);
    for (const d of j.sessions) hist.by.set(hkey(d), d);
    hist.list = [...hist.by.values()].map(d => MeshHistoryState.decorate(d, hist.names))
      .sort((a, b) => (b.updated || 0) - (a.updated || 0));
  } catch (e) { hist.error = e.message; }
}

// while the history is on screen: a fetch in the background, never awaited by
// the live list's refresh
function pollHistory() {
  if (!localMeshEffectsAllowed()) return;
  if ((tab === "hist" || exploring) && !histLoading && Date.now() - histLoadedAt > HIST_POLL)
    loadHistory().then(() => {
      renderLists();
      // a query left in a box is searched again once its hits are older than FT_TTL
      if (tab === "hist") fullText($("#filter").value);
      if (exploring) fullText($("#ex-q").value, "explorer");
    });
}

// full-text search runs on the server (ripgrep over the transcripts); its hits
// are added to the client-side match on titles, recaps, folders and branches.
// Hits are kept per query for a minute (transcripts keep growing); the sidebar
// and the explorer each debounce their own box.
const ftCache = new Map();   // query -> { at, ids }
const FT_TTL = 60000;
const ftTimers = {};
function fullText(q, box = "side", retry = true) {
  q = q.trim();
  clearTimeout(ftTimers[box]);
  if (q.length < 3 || Date.now() - (ftCache.get(q)?.at || 0) < FT_TTL) return;
  ftTimers[box] = setTimeout(async () => {
    try {
      const r = await requestLocal(`/api/history/search?q=${encodeURIComponent(q)}`);
      if (r.status === 409) {   // replaced by a newer query: from the other box, retry if still wanted
        // once only: two boxes would otherwise keep cancelling each other
        if (retry && $(box === "explorer" ? "#ex-q" : "#filter").value.trim() === q) fullText(q, box, false);
        return;
      }
      if (!r.ok) throw new Error(serverText(await r.text()));
      ftCache.delete(q);
      ftCache.set(q, { at: Date.now(), ids: new Set((await r.json()).map((k) => `h:${k}`)) });
      if (ftCache.size > 30) ftCache.delete(ftCache.keys().next().value);
      renderLists(true);
    } catch (e) { flash(t("history.searchFailed", { error: e.message })); }
  }, 350);
}

function histMatch(q) {
  q = q.trim();
  const ql = q.toLowerCase(), ft = ftCache.get(q)?.ids;
  return (d) => {
    if (!hf[d.agent]) return false;
    if (d.source === "exec" && !hf.exec) return false;
    if (hf.live && !liveOf(d.id, d.agent)) return false;
    if (!ql) return true;
    if (ft?.has(hkey(d))) return true;
    if (MeshHistoryState.matchesName(ql, d)) return true;
    return [d.title, d.name, d.recap, d.first, d.last_user, d.cwd, d.branch, d.id].join(" ").toLowerCase().includes(ql);
  };
}

function chipsHtml() {
  const n = hist.list.filter((d) => d.source === "exec").length;
  return [...HIST_AGENTS.map((a) => [a, a]), ["exec", `codex exec${n ? ` (${n})` : ""}`], ["live", t("history.chips.liveOnly")]]
    .map(([k, text]) => `<button class="chip ${hf[k] ? "on" : ""}" data-hf="${k}"${k === "exec" ? ` title="${esc(t("history.chips.execTitle"))}"` : ""}>${esc(text)}</button>`).join("");
}
function onChip(e) {
  const k = e.target.closest("[data-hf]")?.dataset.hf;
  if (!k) return;
  hf[k] = !hf[k];
  store.set("hfilter", hf);
  renderLists(true);
}
$("#hchips").addEventListener("click", onChip);
$("#ex-chips").addEventListener("click", onChip);

// first folder under ~ (or the parent dir outside ~), then the working dir inside it
function area(cwd) {
  const home = data.home;
  if (!cwd) return ["?", "?"];
  if (cwd === home) return [home, ""];
  if (cwd.startsWith(home + "/")) {
    const first = cwd.slice(home.length + 1).split("/")[0];
    return [`${home}/${first}`, cwd.slice(home.length + 2 + first.length)];
  }
  const i = cwd.lastIndexOf("/");
  return [cwd.slice(0, i) || "/", cwd.slice(i + 1)];
}

function histItemHtml(d) {
  const key = hkey(d), live = liveOf(d.id, d.agent);
  const shown = panes.some((p) => p.id === key || (live && p.id === live.id));
  const here = active && (active.id === key || (live && active.id === live.id));
  const where = live ? (live.kind === "mesh" ? t("history.inMesh") : live.host) : t("history.messageCount", { n: d.n_user + d.n_assistant });
  return `<button class="item hitem ${here ? "sel" : shown ? "shown" : ""}" data-id="${esc(key)}">
    <div class="top"><span class="dot ${live ? state(live) : "hist"}"></span><span class="name">${esc(histTitle(d))}</span><span class="tag ${esc(d.agent)}">${esc(d.agent)}</span><span class="ago">${esc(ago(d.updated))}</span></div>
    <div class="meta">${d.branch ? `<span class="br">${esc(d.branch)}</span> · ` : ""}${esc(where)}</div>
    ${d.recap || d.last_user ? `<div class="last">${esc(d.recap || d.last_user)}</div>` : ""}
  </button>`;
}

function renderHistList() {
  if (tab !== "hist") {   // hidden: only the tab's count, not ~10k rows
    $("#n-hist").textContent = hist.gen === null ? "" : hist.list.filter((d) => d.source !== "exec").length;
    return;
  }
  const list = hist.list.filter(histMatch($("#filter").value));
  const areas = new Map();
  for (const d of list) {
    const [a, leaf] = area(d.cwd);
    if (!areas.has(a)) areas.set(a, new Map());
    const leaves = areas.get(a);
    if (!leaves.has(leaf)) leaves.set(leaf, []);
    leaves.get(leaf).push(d);
  }
  const q = $("#filter").value.trim();
  const recent = MeshHistoryState.recent(hist.names,
    new Set([...data.mesh, ...data.external].flatMap(s => s.agent?.session_id
      ? [`${s.agent.type}:${s.agent.session_id}`] : [])))
    .filter(n => (!n.agent || hf[n.agent]) && !hf.live
      && (!q || MeshHistoryState.matchesName(q, n) || n.sid?.includes(q)));
  let html = recent.length ? `<div class="group"><span>${esc(t("history.recentlyClosed"))}</span><span class="count">${recent.length}</span></div>` : "";
  for (const n of recent) {
    const key = n.sid ? `h:${n.agent}:${n.sid}` : null;
    const transcript = key && hist.by.get(key);
    html += `<button class="item hitem"${key ? ` data-id="${esc(key)}"` : " disabled"}>
      <div class="top"><span class="dot hist"></span><span class="name">${esc(n.label || n.name)}</span>
      <span class="tag">${esc(n.agent || "terminal")}</span><span class="ago">${esc(ago(n.closed_at))}</span></div>
      <div class="meta">${esc(transcript ? t("history.recent.kept") : key ? t("history.recent.identityKept") : t("history.recent.unidentified"))}</div></button>`;
  }
  if (recent.length && list.length) html += `<div class="group"><span>${esc(t("history.allConversations"))}</span></div>`;
  for (const [a, leaves] of areas) {
    const n = [...leaves.values()].reduce((x, l) => x + l.length, 0);
    const ka = `ha:${a}`, fa = folded.has(ka) && !q;
    html += `<button class="group ${fa ? "folded" : ""}" data-group="${esc(ka)}"><span class="chev">▾</span><span>${esc(short(a))}</span><span class="count">${n}</span></button>`;
    if (fa) continue;
    for (const [leaf, items] of leaves) {
      let body = items;
      const kl = `hl:${a}/${leaf}`;
      if (leaf) {
        const fl = folded.has(kl) && !q;
        html += `<button class="group sub ${fl ? "folded" : ""}" data-group="${esc(kl)}"><span class="chev">▾</span><span>${esc(leaf)}</span><span class="count">${items.length}</span></button>`;
        if (fl) continue;
      }
      if (!q && !unfoldedLeaves.has(kl) && items.length > LEAF_MAX) {
        body = items.slice(0, LEAF_MAX);
        html += body.map(histItemHtml).join("") + `<button class="more" data-more="${esc(kl)}">${esc(t("history.moreItems", { n: items.length - LEAF_MAX }))}</button>`;
      } else html += body.map(histItemHtml).join("");
    }
  }
  const state = hist.error ? t("history.unavailable", { error: hist.error })
    : hist.gen === null || hist.indexing ? `${t("history.indexing")}${hist.list.length ? ` (${hist.list.length})` : ""}` : "";
  const note = hist.degraded ? t("history.degraded") : hist.skipped ? t("history.skipped", { n: hist.skipped }) : "";
  $("#hlist").innerHTML = (state ? `<div class="meta" style="margin:10px">${esc(state)}</div>` : "") +
    (note ? `<div class="meta hist-note" style="margin:10px;opacity:.7">${esc(note)}</div>` : "") +
    (html || (state ? "" : `<div class="meta" style="margin:10px">${esc(t("history.empty"))}</div>`));
  const shown = hist.list.filter((d) => d.source !== "exec").length;
  $("#n-hist").textContent = hist.gen === null ? "" : shown;
  if (tab === "hist") {
    const bytes = list.reduce((x, d) => x + (d.bytes || 0), 0);
    $("#foot").textContent = t("history.foot", { n: list.length, size: fmtBytes(bytes) });
  }
}

let exSig = "";
function renderLists(force) {
  renderList();
  renderHistList();
  if (exploring) renderExplorer(force);
}

function setTab(name) {
  if (!localMeshEffectsAllowed() && name !== "live") {
    localActionUnavailable();
    return;
  }
  tab = name;
  store.set("tab", name);
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("cur", b.dataset.tab === name);
  $("#list").hidden = name !== "live";
  $("#hlist").hidden = $("#hchips").hidden = name !== "hist";
  $("#filter").placeholder = name === "hist" ? t("history.filterPlaceholder") : t("sessions.filterPlaceholder");
  $("#hchips").innerHTML = chipsHtml();
  if (name === "hist") { loadHistory().then(() => renderLists(true)); fullText($("#filter").value); }
  renderLists();
}
$(".tabs").addEventListener("click", (e) => { const name = e.target.closest("[data-tab]")?.dataset.tab; if (name) setTab(name); });

// ---- the card of a past session, shown in a pane

function histCardHtml(d, live) {
  const cmd = `cd ${shq(d.cwd || "~")} && ${HIST_RESUME_CMD[d.agent]}${shq(d.id)}`;
  const cache = d.tin + d.tcr + d.tcw ? Math.round((100 * d.tcr) / (d.tin + d.tcr + d.tcw)) : null;
  const room = workspaceGroups.length < MAX_PANES && !narrow();
  // the server says what Mesh can do with this agent's conversation (resumable, deletable: history.py)
  const canResume = localMeshEffectsAllowed() && d.resumable !== false;
  const canDelete = localMeshEffectsAllowed() && d.deletable !== false;
  return `<div class="card hist">
    <h2>${esc(histTitle(d))}</h2>
    <div class="sub"><span class="tag ${esc(d.agent)}">${esc(d.agent)}</span>${d.branch ? `<span class="br">${esc(d.branch)}</span>` : ""}
      <span>${esc(short(d.cwd))}</span><span>· ${esc(ago(d.updated))}</span>${d.name && d.title ? `<span>· ${esc(d.title)}</span>` : ""}</div>
    ${live ? `<div class="warn">${esc(live.kind === "mesh" ? t("history.card.runningInMesh") : t("history.card.runningIn", { host: live.host }))}</div>` : ""}
    ${pinnedSessions().some(p => p.guessed && p.agent === d.agent && p.id === d.id) ? `<div class="warn">${esc(t("history.card.pinGuessed"))}</div>` : ""}
    ${d.recap ? `<div class="recap"><div class="lbl">${esc(t("history.card.recap"))}</div>${esc(d.recap)}</div>` : ""}
    <div class="cols">
      <div><div class="lbl">${esc(t("history.card.session"))}</div><dl>
        <dt>${esc(t("history.card.id"))}</dt><dd>${esc(d.id)}</dd>
        <dt>${esc(t("history.card.started"))}</dt><dd>${esc(fmtDate(d.started))}</dd>
        <dt>${esc(t("history.card.last"))}</dt><dd>${esc(fmtDate(d.updated))}</dd>
        <dt>${esc(t("history.card.duration"))}</dt><dd>${esc(fmtSpan(d.started, d.updated))}</dd>
        <dt>${esc(t("history.card.messages"))}</dt><dd>${esc(t("history.card.messageSplit", { user: d.n_user, assistant: d.n_assistant, agent: d.agent }))}</dd>
        <dt>${esc(t("history.card.disk"))}</dt><dd>${esc(fmtBytes(d.bytes))}</dd>
        ${d.version ? `<dt>${esc(t("history.card.version"))}</dt><dd>${esc(d.version)}</dd>` : ""}
      </dl></div>
      <div><div class="lbl">${esc(t("history.card.usage"))}</div><dl>
        <dt>${esc(t("history.card.model"))}</dt><dd>${esc((d.models || []).join(", ") || "—")}</dd>
        <dt>${esc(t("history.card.tokens"))}</dt><dd>${esc(fmtN(tokens(d)))}</dd>
        <dt>${esc(t("history.card.input"))}</dt><dd>${esc(fmtN(d.tin))}</dd>
        <dt>${esc(t("history.card.output"))}</dt><dd>${esc(fmtN(d.tout))}</dd>
        <dt>${esc(t("history.card.cacheRead"))}</dt><dd>${esc(fmtN(d.tcr))}${cache !== null ? ` (${esc(t("units.percent", { value: cache }))})` : ""}</dd>
        ${d.tcw ? `<dt>${esc(t("history.card.cacheWritten"))}</dt><dd>${esc(fmtN(d.tcw))}</dd>` : ""}
        ${d.web ? `<dt>${esc(t("history.card.web"))}</dt><dd>${d.web}</dd>` : ""}
      </dl></div>
    </div>
    ${d.last_user || d.last_assistant ? `<div class="lbl">${esc(t("history.card.lastExchanges"))}</div>
      ${d.last_user ? `<div class="msg"><b>${esc(t("history.card.you"))}</b> · ${esc(d.last_user)}</div>` : ""}
      ${d.last_assistant ? `<div class="msg"><b>${esc(d.agent)}</b> · ${esc(d.last_assistant)}</div>` : ""}` : ""}
    ${d.summary ? `<details><summary>${esc(t("history.card.compactionSummary"))}</summary><pre>${esc(d.summary)}</pre></details>` : ""}
    <div class="actions">
      <button class="btn" data-hact="pin">${esc(isPinned(d.agent, d.id) ? t("pin.unpin") : t("pin.pinHere"))}</button>
      ${live ? `<button class="btn primary" data-hact="goto" data-to="${esc(live.id)}">${esc(live.kind === "mesh" ? t("history.card.openTerminal") : t("history.card.showTerminal", { host: live.host }))}</button>`
        : canResume ? `<button class="btn primary" data-hact="resume">${esc(t("history.card.resumeHere"))}</button>
           ${room && localMeshEffectsAllowed() ? `<button class="btn" data-hact="resume-col">${esc(t("history.card.resumeInColumn"))}</button>` : ""}` : ""}
      <div class="cmd"><code title="${esc(cmd)}">${esc(cmd)}</code><button class="btn ghost" data-hact="copy" data-cmd="${esc(cmd)}">${esc(t("common.copy"))}</button>
        ${live || !canDelete ? "" : `<button class="btn ghost danger" data-hact="delete">${esc(t("history.card.delete"))}</button>`}</div>
    </div>
  </div>`;
}

async function histAction(pane, act, btn) {
  const d = pane.hist?.d;
  if (act === "goto") { setActive(pane); return openSession(btn.dataset.to); }
  if (!d) return;
  if (act === "pin") {
    togglePin(d.agent, d.id, histTitle(d), pinnedSessions().find(p => p.agent === d.agent && p.id === d.id)?.guessed);
  } else if (act === "copy") {
    try { await navigator.clipboard.writeText(btn.dataset.cmd); flash(t("history.commandCopied")); } catch { flash(t("history.copyRefused")); }
  } else if (act === "resume" || act === "resume-col") {
    btn.disabled = true;
    let id;
    try {
      const r = await requestLocal("/api/history/resume", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: d.agent, id: d.id }) });
      if (!r.ok) throw new Error(serverText(await r.text()));
      ({ id } = await r.json());
    } catch (e) { alert(e.message); btn.disabled = false; return; }
    await refresh();
    if (!localMeshEffectsAllowed()) return;
    const target = act === "resume-col" ? addPane() || pane : pane;
    setActive(target);
    target.show(id, false, { focusTerminal: true });
  } else if (act === "delete") {
    await deleteHist([d]);
  }
}

// items: the sessions themselves (a card's own copy works before the list is loaded)
async function deleteHist(items) {
  if (!items.length) return false;
  const titles = items.slice(0, 5).map((d) => `• ${histTitle(d)}`).join("\n") + (items.length > 5 ? `\n${t("history.delete.more", { n: items.length - 5 })}` : "");
  const what = items.length === 1 ? t("history.delete.one", { title: histTitle(items[0]) }) : t("history.delete.many", { n: items.length, titles });
  if (!confirm(t("history.delete.confirm", { what, size: fmtBytes(items.reduce((x, d) => x + (d.bytes || 0), 0)) }))) return false;
  const done = [];
  let error = "";
  for (const d of items) {
    try {
      const r = await requestLocal(`/api/history/${d.agent}/${encodeURIComponent(d.id)}`, { method: "DELETE" });
      if (r.ok) done.push(hkey(d));
      else error ||= serverText(await r.text());
    } catch (e) { error ||= e.message; }
  }
  const failed = items.length - done.length;
  for (const k of done) exSel.delete(k);
  for (const p of panes) if (done.includes(p.id)) p.clear();
  if (failed) alert(items.length === 1 ? error : t("history.delete.partial", { done: done.length, failed, error }));
  else flash(items.length > 1 ? t("history.delete.doneMany", { n: items.length }) : t("history.delete.doneOne"));
  await loadHistory(true);
  renderLists(true);
  return !failed;
}

// ---- explorer: the history as a table, in place of the panes

let exploring = false;
let managing = false;
let flowing = false;
let flowController = null;
let flowGeneration = 0;
const exSel = new Set();
let exAll = false;
const EX_PAGE = 400;

function setExplorer(on) {
  if (on && localActionUnavailable()) return;
  endDirectLine();   // a change of view ends direct writing
  if (on && projecting) setProjects(false);
  if (on && managing) setManagement(false);
  if (on && flowing) setFlow(false);
  exploring = on;
  document.body.classList.toggle("exploring", on);
  $("#explorer").hidden = !on;
  $("#btn-explore").classList.toggle("on", on);
  if (on) {
    $("#ex-chips").innerHTML = chipsHtml();
    loadHistory().then(() => renderLists(true));
    renderExplorer(true);
    if (!touch) $("#ex-q").focus();
  } else {
    for (const p of panes) p.refit();
    active?.focus();
  }
}
$("#btn-explore").addEventListener("click", () => setExplorer(!exploring));

// Projects is optional: import and artifact reads never participate in Sessions boot or polling. The one exception is
// the session marker (tickSessionMarker): it loads the work view's bundle after the first listing and reads the
// tracker at most once a minute, and a failure shows nothing.
let projecting = false;
let projectsReturnFocus = null;
document.addEventListener('focusin', event => {
  if (!projecting && event.target instanceof HTMLElement && event.target.closest('#panes,#keys,#line')) projectsReturnFocus = event.target;
});
document.addEventListener('pointerdown', event => {
  if (!projecting && event.target instanceof HTMLElement && event.target.closest('#btn-projects,[data-mobile-action="btn-projects"]') && document.activeElement instanceof HTMLElement && document.activeElement.closest('#panes,#keys,#line')) projectsReturnFocus = document.activeElement;
}, { capture: true });
let projectsGeneration = 0;
let projectsController = null;
async function loadProjectsModule() {
  const issue = ++projectsGeneration;
  const status = $("#projects-module-status");
  const retry = $("#projects-module-retry");
  status.textContent = t("projects.loading"); retry.hidden = true;
  let timer;
  try {
    const module = await Promise.race([
      import(`/static/projects.js?v=${encodeURIComponent($("meta[name=client-version]").content)}&attempt=${issue}`),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 5000); }),
    ]);
    if (!projecting || issue !== projectsGeneration || !localMeshEffectsAllowed()) return;
    projectsController ||= module.mountProjectWorkspace({ root: $("#projects-root"), sidebar: $("#project-sidebar-list"),
      request: requestLocal, translate: t, availability: (ready) => { if (projecting) $("#btn-new").disabled = !ready; },
      mountArtifact: (root) => module.mountProjects({ root, request: requestLocal, translate: t,
        readPath: () => store.get("projects.path", ""), writePath: (path) => store.set("projects.path", path), origin: location.origin }) });
    projectsController.open();
    status.textContent = "";
  } catch {
    if (projecting && issue === projectsGeneration) { status.textContent = t("projects.unavailable"); retry.hidden = false; }
  } finally { clearTimeout(timer); }
}
// Projects has two presentations: the work view (default, static/work-view.ts) and the previous workspace,
// reachable through a persisted display preference until it is removed. Each has its own root element.
let workGeneration = 0;
let workController = null;
let temporaryLegacy = false;
const legacyProjects = () => temporaryLegacy || store.get("projects.legacy", false) === true;
function applyProjectsPresentation() {
  const legacy = legacyProjects();
  $("#projects-fallback-notice").hidden = true;
  $("#work-root").hidden = legacy;
  $("#projects-root").hidden = !legacy;
  $("#project-navigation").hidden = !projecting || !legacy;
  $("#work-rail").hidden = !projecting || legacy;   // the work view's tree of products and projects
  const key = legacy ? "work.newView" : "work.oldView";
  $("#projects-view-switch").setAttribute("data-i18n", key);
  $("#projects-view-switch").textContent = t(key);
}
function setLegacyProjects(on, temporary = false) {
  temporaryLegacy = temporary && on;
  if (!temporary) store.set("projects.legacy", on);
  if (!projecting) return;
  projectsGeneration++; workGeneration++;
  projectsController?.close(); workController?.close();
  $("#projects-module-status").textContent = ""; $("#projects-module-retry").hidden = true;
  applyProjectsPresentation();
  openProjectsPresentation();
}
// Where the work view opens next (a session marker's target, static/work-session-questions.ts), taken once.
let pendingWorkTarget = null;
function openProjectsPresentation() {
  if (legacyProjects()) {
    pendingWorkTarget = null;   // the old view has no such places
    if (projectsController) projectsController.open();
    else void loadProjectsModule();
  } else void loadWorkView();
}
// The bundle is imported once per page (one module, so one set of read slots): callers share the import in flight,
// and a failed import is tried again by the next caller.
let workImportAttempt = 0;
let workImport = null;
function importWorkModule() {
  if (workModule) return Promise.resolve(workModule);
  workImport ||= importWorkModuleOnce().finally(() => { workImport = null; });
  return workImport;
}
async function importWorkModuleOnce() {
  let timer;
  try {
    workModule = await Promise.race([
      import(`/static/work-view.js?v=${encodeURIComponent($("meta[name=client-version]").content)}&attempt=${++workImportAttempt}`),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 5000); }),
    ]);
    return workModule;
  } finally { clearTimeout(timer); }
}
// A choice in the work view's tree of the sidebar: on a phone the drawer closes over it; true when it did.
function closeDrawerAfterChoice() {
  if (!narrow() || !document.body.classList.contains("drawer")) return false;
  document.body.classList.remove("drawer");
  syncMobileChrome();
  return true;
}
async function loadWorkView() {
  const issue = ++workGeneration;
  const status = $("#projects-module-status");
  const retry = $("#projects-module-retry");
  status.textContent = t("projects.loading"); retry.hidden = true;
  try {
    const module = await importWorkModule();
    if (!projecting || issue !== workGeneration || legacyProjects() || !localMeshEffectsAllowed()) return;
    workController ||= module.mountWorkView({ root: $("#work-root"), rail: $("#work-rail"), onRailChoice: closeDrawerAfterChoice,
      request: requestLocal, translate: t,
      onLegacy: () => setLegacyProjects(true, true),
      onOpenQuestions: (count) => showOpenQuestions(count, module.counterText(count)) });
    const target = pendingWorkTarget ?? undefined;
    pendingWorkTarget = null;
    workController.open(target);
    status.textContent = "";
  } catch {
    if (projecting && issue === workGeneration) { status.textContent = t("projects.unavailable"); retry.hidden = false; }
  }
}
// The open questions badge of the Projects buttons (main and phone menu). It shows the count the work view or the
// session marker last read (the view when it opens, on Refresh, after an answer; the marker at most once a minute),
// and an unknown count shows nothing. `shown` is the badge text from the work view's counterText ("" for nothing).
function showOpenQuestions(count, shown) {
  for (const badge of document.querySelectorAll(".projects-question-badge")) {
    badge.textContent = shown;
    badge.hidden = !shown;
  }
  const description = $("#projects-questions-description");
  description.textContent = shown ? t("work.questions.badge", { n: count }) : "";
  for (const button of document.querySelectorAll('#btn-projects,[data-mobile-action="btn-projects"]')) {
    if (shown) button.setAttribute("aria-describedby", description.id); else button.removeAttribute("aria-describedby");
  }
}
// The "? n" marker of the session rows and headers: the open questions of each session in the tracker, joined by
// session name (static/work-session-marker.ts, in the work view's bundle). Each applied listing ticks it; it reads
// at most once a minute while the page is visible, and at once after the Projects view is left.
let sessionMarkerLoading = false;
let sessionMarkerRetryAt = 0;
const sessionMarkerOf = (s) => (s && typeof s.name === "string" && sessionMarker?.marker(s.name)) || null;
const sessionMarkerText = (marker) => workModule?.counterText(marker.count) ?? "";
function tickSessionMarker() {
  if (sessionMarker) return sessionMarker.tick();
  if (sessionMarkerLoading || Date.now() < sessionMarkerRetryAt || !localMeshEffectsAllowed()) return;
  sessionMarkerLoading = true;
  importWorkModule().then((module) => {
    if (!localMeshEffectsAllowed()) return;
    sessionMarker ||= module.mountSessionMarker({ request: requestLocal, onChange: sessionMarkerChanged,
      visible: () => document.visibilityState === "visible" });
    sessionMarker.tick();
  }, () => { sessionMarkerRetryAt = Date.now() + 60_000; }).finally(() => { sessionMarkerLoading = false; });
}
// The T-, P- and N- references of the terminals (static/terminal-references.ts): an id is a link only when the cache
// of known ids (static/work-references.ts, in the work view's bundle) has it. Each applied listing ticks the cache
// while terminals are shown: it reads at most once a minute while the page is visible, and again when the Projects
// view opens. A lookup never sends a request. Clicking a reference opens the Projects view on it.
let referencesLoading = false;
let referencesRetryAt = 0;
function tickReferences() {
  if (!panes.length) return;
  if (references) return references.tick();
  if (referencesLoading || knownForgotten || Date.now() < referencesRetryAt || !localMeshEffectsAllowed()) return;
  referencesLoading = true;
  importWorkModule().then((module) => {
    // The credential may have been refused while the module loaded (forgetKnownSessions): no cache, no read.
    if (!localMeshEffectsAllowed() || knownForgotten) return;
    references ||= module.mountReferences({ request: requestLocal, visible: () => document.visibilityState === "visible" });
    references.tick();
  }, () => { referencesRetryAt = Date.now() + 60_000; }).finally(() => { referencesLoading = false; });
}
const knownReference = (id) => references?.lookup(id) ?? null;
// Paths, URLs and directories first (MeshTerminalLinks.linksOnRow), then the known references that overlap none.
function terminalLinksOnRow(buf, y, cols) {
  const { linksOnRow, referencesOnRow, cellIn } = MeshTerminalLinks;
  const links = linksOnRow(buf, y, cols);
  if (!references) return links;
  for (const ref of referencesOnRow(buf, y, (id) => knownReference(id) !== null)) {
    if (!links.some((l) => cellIn(ref.start, l.start, l.end) || cellIn(l.start, ref.start, ref.end))) links.push(ref);
  }
  return links;
}
// The hover text of a reference: its kind, id and title, as text; empty when the id is not known.
function referenceLabel(id) {
  const entry = knownReference(id);
  if (!entry) return "";
  return entry.title ? t(`terminal.reference.${entry.kind}`, { id: entry.id, title: entry.title }) : entry.id;
}
function openReference(id) {
  const entry = knownReference(id);
  if (!entry || localActionUnavailable()) return;
  pendingWorkTarget = entry.target;
  setProjects(true);
  if (!projecting) pendingWorkTarget = null;   // the view did not open: the target is not kept for a later opening
}
function sessionMarkerChanged() {
  listBatch.request();
  for (const pane of panes) pane.header();
  const count = sessionMarker.openQuestions();
  showOpenQuestions(count, workModule.counterText(count));
}
function questionBadgeHtml(s) {
  const marker = s.kind === "mesh" ? sessionMarkerOf(s) : null;
  if (!marker) return "";
  const questionsLabel = t("sessions.questions.row", { n: marker.count });
  return `<span class="tag question-badge" role="img" aria-label="${esc(questionsLabel)}" title="${esc(questionsLabel)}">? ${esc(sessionMarkerText(marker))}</span>`;
}
function openSessionQuestions(id) {
  const marker = sessionMarkerOf(find(id));
  if (!marker) return;
  pendingWorkTarget = marker.target;
  setProjects(true);
  if (!projecting) pendingWorkTarget = null;   // the view did not open: the target is not kept for a later opening
}
function setProjects(on) {
  if (on && localActionUnavailable()) return;
  endDirectLine();   // a change of view ends direct writing
  if (on && exploring) setExplorer(false);
  if (on && managing) setManagement(false);
  if (on && flowing) setFlow(false);
  if (on && !projecting && document.activeElement instanceof HTMLElement && document.activeElement.closest("#panes,#keys,#line")) projectsReturnFocus = document.activeElement;
  const leavingProjects = projecting && !on;
  projecting = on;
  store.set("primaryView", on ? "projects" : "sessions");
  document.body.classList.toggle("projecting", on);
  $("#projects").hidden = !on;
  applyProjectsPresentation();
  $("#btn-projects").classList.toggle("on", on);
  $("#btn-projects").setAttribute("aria-pressed", String(on));
  $("#btn-sessions").classList.toggle("on", !on);
  $("#btn-sessions").setAttribute("aria-pressed", String(!on));
  $("#btn-new").disabled = on;
  $("#btn-new").title = t(on ? "projectWorkspace.new" : "side.newTitle");
  $("#bar-hint").textContent = t(on ? "projectWorkspace.intro" : "bar.hint");
  $("#btn-menu").setAttribute("data-i18n", on ? "projects.title" : "bar.sessions");
  $("#btn-menu").textContent = t(on ? "projects.title" : "bar.sessions");
  if (on) {
    document.body.classList.remove("drawer");
    $("#projects-return").focus();
    references?.refresh();   // the tracker is being looked at: its ids are read again at the next tick
    openProjectsPresentation();
  } else {
    projectsGeneration++; workGeneration++;
    projectsController?.close(); workController?.close();
    pendingWorkTarget = null;
    if (leavingProjects) {   // an answer given in Projects may have closed questions; the Sessions button alone reads nothing
      sessionMarker?.refresh();
      tickSessionMarker();
    }
    for (const pane of panes) pane.refit();
    if (projectsReturnFocus instanceof HTMLElement && projectsReturnFocus.isConnected && !projectsReturnFocus.closest("#projects,#side")) projectsReturnFocus.focus({ preventScroll: true });
    else active?.focus();
  }
}
$("#btn-projects").addEventListener("click", () => setProjects(true));
$("#btn-sessions").addEventListener("click", () => {
  if (exploring) setExplorer(false);
  if (managing) setManagement(false);
  if (flowing) setFlow(false);
  setProjects(false);
});
$("#project-refresh").addEventListener("click", () => { if (projecting) projectsController?.open(); });
$("#projects-view-switch").addEventListener("click", () => setLegacyProjects(!legacyProjects()));
$("#projects-return").addEventListener("click", () => setProjects(false));
$("#projects-module-retry").addEventListener("click", () => { if (projecting) openProjectsPresentation(); });

// ---- management: bounded facts already received with the owner snapshot
//
// This surface deliberately has no fetch, action or browser persistence.  Its
// rows are a display of the sealed server projection, never a second session
// list or a process-control interface.

const MANAGEMENT_SOURCES = new Set(["mesh", "external", "observed-stop", "restart-recovery"]);
const MANAGEMENT_LIFECYCLES = new Set(["active", "stopped-observed", "lost-recovery", "unavailable", "unknown"]);
const MANAGEMENT_AGENTS = new Set(["claude", "codex", "opencode", "copilot", "gemini", "pi", "unknown"]);
const MANAGEMENT_STATUSES = new Set(["busy", "waiting", "shell", "idle", "unknown"]);
// A table of display texts whose entries are read from the catalogs when they
// are read (never while this file is first evaluated): table[name] is translate(name).
function translatedTable(names, translate) {
  const table = {};
  for (const name of names) Object.defineProperty(table, name, { enumerable: true, get: () => translate(name) });
  return Object.freeze(table);
}
const MANAGEMENT_LIFECYCLE_TEXT = translatedTable(MANAGEMENT_LIFECYCLES, (name) => t(`management.lifecycle.${name}`));
const MANAGEMENT_STATUS_TEXT = translatedTable(MANAGEMENT_STATUSES, (name) => t(`management.status.${name}`));
const MANAGEMENT_TIME_TEXT = translatedTable(["created", "observed_stopped_at", "lost_at"], (name) => t(`management.time.${name}`));
const MANAGEMENT_METRIC_KEYS = ["observed_duration_seconds", "cpu_percent", "rss_bytes", "tokens"];
const MANAGEMENT_METRIC_STATES = new Set(["reported", "derived", "unavailable", "unknown"]);
const MANAGEMENT_METRIC_SOURCES = new Set([
  "management-lifecycle", "procfs-stat", "procfs-statm", "no-approved-adapter",
  "not-current-mesh-agent", "not-recognized-agent",
]);
const MANAGEMENT_METRIC_REASONS = new Set([
  "first-sample", "not-live", "not-collected", "procfs-unavailable", "association-changed",
  "sampling-capacity", "no-lifecycle-window",
]);

function managementSnapshot() {
  const value = data.management;
  return value && typeof value === "object" && !Array.isArray(value) ? value : { state: "unavailable", sessions: [] };
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function managementMetric(raw) {
  const keys = ["state", "source", "value", "observed_at", "window", "reason"];
  if (!exactKeys(raw, keys) || !MANAGEMENT_METRIC_STATES.has(raw.state)
      || !MANAGEMENT_METRIC_SOURCES.has(raw.source)) return null;
  const observedAt = typeof raw.observed_at === "number" && Number.isFinite(raw.observed_at)
    ? raw.observed_at : raw.observed_at === null ? null : undefined;
  if (observedAt === undefined) return null;
  const numeric = raw.state === "reported" || raw.state === "derived";
  if (numeric) {
    if (typeof raw.value !== "number" || !Number.isFinite(raw.value)
        || !exactKeys(raw.window, ["start", "end"])
        || !Number.isFinite(raw.window.start) || !Number.isFinite(raw.window.end)
        || raw.window.end < raw.window.start || observedAt === null || raw.reason !== null) return null;
  } else if (raw.value !== null || raw.window !== null || !MANAGEMENT_METRIC_REASONS.has(raw.reason)) {
    return null;
  }
  return { state: raw.state, source: raw.source, value: raw.value, observedAt,
    window: numeric ? { start: raw.window.start, end: raw.window.end } : null, reason: raw.reason };
}

function managementMetrics(raw) {
  if (raw === undefined) return null; // Snapshots without metrics remain readable during rollout.
  if (!exactKeys(raw, MANAGEMENT_METRIC_KEYS)) return null;
  const metrics = Object.fromEntries(MANAGEMENT_METRIC_KEYS.map((key) => [key, managementMetric(raw[key])]));
  return MANAGEMENT_METRIC_KEYS.every((key) => metrics[key] !== null) ? metrics : null;
}

function managementRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw.source, lifecycle = raw.lifecycle;
  const agent = raw.agent_type, status = raw.last_observed_agent_status;
  if (!MANAGEMENT_SOURCES.has(source) || !MANAGEMENT_LIFECYCLES.has(lifecycle)
      || !MANAGEMENT_AGENTS.has(agent) || !MANAGEMENT_STATUSES.has(status)) return null;
  const time = typeof raw.time === "number" && Number.isFinite(raw.time) ? raw.time : null;
  const name = typeof raw.name === "string" ? raw.name : null;
  const created = typeof raw.created === "number" && Number.isFinite(raw.created) ? raw.created : null;
  const timeBasis = typeof raw.time_basis === "string" && MANAGEMENT_TIME_TEXT[raw.time_basis]
    ? raw.time_basis : "unknown";
  return { name, created, source, lifecycle, agent, status, timeBasis, time,
    metrics: managementMetrics(raw.metrics) };
}

function managementRows() {
  const raw = managementSnapshot().sessions;
  return (Array.isArray(raw) ? raw : []).map(managementRecord).filter(Boolean);
}

function managementMetricNumber(metric) {
  return metric && (metric.state === "reported" || metric.state === "derived") ? metric.value : null;
}

function managementMetricValue(metric, kind) {
  const value = managementMetricNumber(metric);
  if (value === null) return t("management.metric.none");
  if (kind === "cpu_percent") return t("units.percent", { value: fmtDecimal(value) });
  if (kind === "rss_bytes") return value === 0 ? t("units.bytes", { value: 0 }) : fmtBytes(value);
  return fmtSpan(metric.window.start, metric.window.end);
}

function monotonicIntervalText(start, end) {
  const seconds = Math.max(0, end - start);
  if (seconds < 60) return t("units.seconds", { value: fmtDecimal(seconds) });
  if (seconds < 3600) return t("units.minutes", { value: fmtDecimal(seconds / 60) });
  return t("units.hours", { value: fmtDecimal(seconds / 3600) });
}

// Where a figure comes from is a tooltip, not a line of the card.
function managementMetricProvenance(metric, kind) {
  if (!metric || managementMetricNumber(metric) === null) return "";
  const parts = [t("management.metric.source", { source: metric.source })];
  if (metric.observedAt !== null) parts.push(t("management.metric.measured", { date: fmtDate(metric.observedAt) }));
  if (kind === "cpu_percent" && metric.source === "procfs-stat") {
    parts.push(t("management.metric.monotonicInterval", { interval: monotonicIntervalText(metric.window.start, metric.window.end) }));
  } else {
    parts.push(t("management.metric.window", { start: fmtDate(metric.window.start), end: fmtDate(metric.window.end) }));
  }
  return parts.join(" · ");
}

function managementAgentLabel(agent) {
  return { claude: "Claude", codex: "Codex", opencode: "OpenCode", copilot: "Copilot CLI",
    gemini: "Gemini CLI", agy: "Antigravity", vibe: "Mistral Vibe", pi: "Pi" }[agent] || t("management.agentUnknown");
}

function managementMetricHtml(label, kind, metric) {
  const title = managementMetricProvenance(metric, kind);
  return `<span class="management-metric" data-kind="${kind}"${title ? ` title="${esc(title)}"` : ""}>${esc(label)} ${esc(managementMetricValue(metric, kind))}</span>`;
}

// Heaviest first: resident memory, then CPU, then the newest session.
function managementWeight(row) {
  const rss = managementMetricNumber(row.metrics?.rss_bytes), cpu = managementMetricNumber(row.metrics?.cpu_percent);
  return [rss ?? -1, cpu ?? -1, row.created ?? 0];
}

function managementByWeight(a, b) {
  const [x, y] = [managementWeight(a), managementWeight(b)];
  return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
}

function managementActiveHtml(row) {
  const metrics = row.metrics;
  const figures = metrics ? [managementMetricHtml(t("management.metric.cpu"), "cpu_percent", metrics.cpu_percent),
    managementMetricHtml(t("management.metric.rss"), "rss_bytes", metrics.rss_bytes),
    managementMetricHtml(t("management.metric.observedDuration"), "observed_duration_seconds", metrics.observed_duration_seconds)].join("") : "";
  return `<article class="management-row" data-source="${row.source}" data-lifecycle="${row.lifecycle}">
    <div class="management-row-title"><b>${esc(row.name)}</b><span class="tag">${esc(managementAgentLabel(row.agent))}</span><span class="management-status">${esc(MANAGEMENT_STATUS_TEXT[row.status])}</span></div>
    ${figures ? `<p class="management-figures">${figures}</p>` : ""}
  </article>`;
}

function managementRecentHtml(row) {
  const when = row.time === null ? MANAGEMENT_LIFECYCLE_TEXT[row.lifecycle]
    : `${MANAGEMENT_TIME_TEXT[row.timeBasis]} · ${fmtDate(row.time)}`;
  return `<article class="management-row" data-source="${row.source}" data-lifecycle="${row.lifecycle}">
    <div class="management-row-title"><b>${esc(row.name)}</b><span class="tag">${esc(managementAgentLabel(row.agent))}</span><span class="management-status">${esc(when)}</span></div>
  </article>`;
}

function renderManagement() {
  const snapshot = managementSnapshot();
  const rows = managementRows();
  $("#management-authority").textContent = snapshot.state === "observed"
    ? t("management.authority.observed")
    : t("management.authority.unavailable");
  const retention = snapshot.retention && typeof snapshot.retention === "object" ? snapshot.retention : {};
  const keep = Number.isSafeInteger(retention.keep_seconds) && retention.keep_seconds > 0
    ? t("management.retention.days", { n: Math.round(retention.keep_seconds / 86400) }) : t("management.retention.unknownDuration");
  const cap = Number.isSafeInteger(retention.max_entries) && retention.max_entries > 0
    ? t("management.retention.entries", { n: retention.max_entries }) : t("management.retention.unknownCap");
  $("#management-retention").textContent = t("management.retention.text", { keep, cap });
  const active = rows.filter((row) => row.source === "mesh" && row.lifecycle === "active" && row.name !== null)
    .sort(managementByWeight);
  const recent = rows.filter((row) => (row.lifecycle === "stopped-observed" || row.lifecycle === "lost-recovery")
    && row.name !== null).sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  const external = rows.filter((row) => row.source === "external").length;
  $("#management-external").hidden = external === 0;
  $("#management-external").textContent = t("management.external", { n: external });
  $("#management-rows").innerHTML = active.length ? active.map(managementActiveHtml).join("")
    : `<p class="management-empty">${esc(t("management.rows.empty"))}</p>`;
  $("#management-recent").innerHTML = recent.length ? recent.map(managementRecentHtml).join("")
    : `<p class="management-empty">${esc(t("management.recent.empty"))}</p>`;
}

function setManagement(on) {
  if (on && localActionUnavailable()) return;
  endDirectLine();   // a change of view ends direct writing
  if (on && projecting) setProjects(false);
  if (on && exploring) setExplorer(false);
  if (on && flowing) setFlow(false);
  managing = on;
  document.body.classList.toggle("managing", on);
  $("#management").hidden = !on;
  $("#btn-management").classList.toggle("on", on);
  if (on) renderManagement();
  else {
    for (const pane of panes) pane.refit();
    active?.focus();
  }
}

$("#btn-management").addEventListener("click", () => setManagement(!managing));

async function setFlow(on) {
  if (on && localActionUnavailable()) return;
  endDirectLine();
  if (on && projecting) setProjects(false);
  if (on && exploring) setExplorer(false);
  if (on && managing) setManagement(false);
  flowing = on;
  const turn = ++flowGeneration;
  document.body.classList.toggle("flowing", on);
  $("#flow").hidden = !on;
  $("#btn-flow").classList.toggle("on", on);
  $("#btn-flow").setAttribute("aria-pressed", String(on));
  $("#btn-sessions").classList.toggle("on", !on);
  $("#btn-sessions").setAttribute("aria-pressed", String(!on));
  if (!on) {
    flowController?.close();
    for (const pane of panes) pane.refit();
    active?.focus();
    return;
  }
  document.body.classList.remove("drawer");
  const root = $("#flow");
  try {
    const module = await import(`/static/flow-view.js?v=${encodeURIComponent($("meta[name=client-version]").content)}`);
    if (!flowing || turn !== flowGeneration || !localMeshEffectsAllowed()) return;
    flowController ||= module.mountFlowView({root, request: requestLocal, translate: t, locale: () => MeshI18n.locale(), now: serverNow,
      current: () => {
        const row = data.mesh.find(session => session.id === active?.id);
        return row && Number.isFinite(row.created) ? {id: row.id, created: row.created} : null;
      }});
    flowController.open();
  } catch {
    if (flowing && turn === flowGeneration) root.textContent = t("flow.unavailable");
  }
}
$("#btn-flow").addEventListener("click", () => void setFlow(true));
$("#flow").addEventListener("flow-close", () => void setFlow(false));

function exList() {
  const list = hist.list.filter(histMatch($("#ex-q").value));
  const by = {
    recent: (a, b) => (b.updated || 0) - (a.updated || 0), old: (a, b) => (a.updated || 0) - (b.updated || 0),
    bytes: (a, b) => (b.bytes || 0) - (a.bytes || 0), msgs: (a, b) => b.n_user + b.n_assistant - a.n_user - a.n_assistant,
    tokens: (a, b) => tokens(b) - tokens(a),
  }[$("#ex-sort").value];
  return list.sort(by);
}

function renderExplorer(force) {
  const list = exList();
  const sig = [hist.gen, list.length, $("#ex-q").value, $("#ex-sort").value, exAll,
               JSON.stringify(list.slice(0, 60).map(d => [hkey(d), histTitle(d), liveOf(d.id, d.agent)?.id || ""]))].join("|");
  if (!force && sig === exSig) return;
  exSig = sig;
  const bytes = list.reduce((x, d) => x + (d.bytes || 0), 0);
  const projects = new Set(list.map((d) => d.cwd)).size;
  const live = list.filter((d) => liveOf(d.id, d.agent)).length;
  $("#ex-chips").innerHTML = chipsHtml();
  const tokenTotal = list.reduce((x, d) => x + tokens(d), 0);
  $("#ex-stats").innerHTML = hist.gen === null ? esc(t("explorer.stats.indexing")) :
    `<span><b>${list.length}</b> ${esc(t("explorer.stats.sessions", { n: list.length }))}${list.length !== hist.list.length ? ` ${esc(t("explorer.stats.ofTotal", { total: hist.list.length }))}` : ""}</span><span><b>${projects}</b> ${esc(t("explorer.stats.folders", { n: projects }))}</span>` +
    `<span><b style="color:var(--idle)">${live}</b> ${esc(t("explorer.stats.active", { n: live }))}</span><span><b>${esc(fmtBytes(bytes))}</b> ${esc(t("explorer.stats.onDisk"))}</span>` +
    `<span><b>${esc(fmtN(tokenTotal))}</b> ${esc(t("explorer.stats.tokens", { n: tokenTotal }))}</span>`;
  // a selection is what is in view: a row hidden by the search or a chip is
  // never deleted by surprise
  const inView = new Set(list.map(hkey));
  for (const k of exSel) if (!inView.has(k)) exSel.delete(k);
  const rows = exAll ? list : list.slice(0, EX_PAGE);
  // a re-render (the list moves while agents run) keeps the keyboard focus
  const focused = document.activeElement?.closest?.("#ex-rows") && document.activeElement;
  const refocus = focused && (focused.dataset.sel ? `[data-sel="${CSS.escape(focused.dataset.sel)}"]`
    : focused.dataset.open ? `[data-open="${CSS.escape(focused.dataset.open)}"]` : null);
  $("#ex-rows").innerHTML = rows.map((d) => {
    const k = hkey(d), lv = liveOf(d.id, d.agent), on = exSel.has(k);
    return `<tr class="ex-row ${on ? "checked" : ""}" data-id="${esc(k)}">
      <td class="c-cb"><input type="checkbox" data-sel="${esc(k)}" ${on ? "checked" : ""} ${lv ? `disabled title="${esc(t("explorer.row.liveUndeletable"))}"` : ""} aria-label="${esc(t("explorer.row.select"))}"></td>
      <td class="c-when" title="${esc(fmtDate(d.updated))}">${esc(ago(d.updated))}</td>
      <td><div class="ex-title"><button class="ex-open" data-open="${esc(k)}">${esc(histTitle(d))}</button>${lv ? `<span class="tag live">● ${esc(lv.kind === "mesh" ? "mesh" : lv.host)}</span>` : ""}${d.source === "exec" ? `<span class="tag">${esc(t("explorer.row.execTag"))}</span>` : ""}</div>
        ${d.recap || d.first ? `<div class="ex-sub">${esc(d.recap || d.first)}</div>` : ""}</td>
      <td class="c-proj"><div class="ex-proj"><bdi>${esc(short(d.cwd))}</bdi></div>${d.branch ? `<div class="br">${esc(d.branch)}</div>` : ""}</td>
      <td class="c-agent"><span class="tag ${esc(d.agent)}">${esc(d.agent)}</span></td>
      <td class="c-num">${d.n_user + d.n_assistant}</td><td class="c-num">${esc(fmtN(tokens(d)))}</td><td class="c-num">${esc(fmtBytes(d.bytes))}</td>
    </tr>`;
  }).join("");
  if (refocus) $(refocus, $("#ex-rows"))?.focus();
  $("#ex-more").innerHTML = rows.length < list.length
    ? `${esc(t("explorer.more", { n: list.length - rows.length }))} <button class="btn sm" id="ex-showall">${esc(t("explorer.showAll"))}</button>` : "";
  renderBulk(list);
}

// the select-all box and the bulk bar, from the selection
function renderBulk(list) {
  const deletable = list.filter((d) => !liveOf(d.id, d.agent));
  $("#ex-all").checked = deletable.length > 0 && deletable.every((d) => exSel.has(hkey(d)));
  const sel = [...exSel].map((k) => hist.by.get(k)).filter(Boolean);
  $("#ex-bulk").hidden = !sel.length;
  const folderCount = new Set(sel.map((d) => d.cwd)).size;
  $("#ex-bulk").innerHTML = sel.length ? `<b>${esc(t("explorer.bulk.selected", { n: sel.length }))}</b>
    <span class="mute">· ${esc(fmtBytes(sel.reduce((x, d) => x + (d.bytes || 0), 0)))} · ${esc(t("explorer.bulk.folders", { n: folderCount }))}</span>
    <span style="flex:1"></span><button class="btn sm danger" id="ex-del">${esc(t("explorer.bulk.delete"))}</button><button class="btn sm ghost" id="ex-none">${esc(t("explorer.bulk.deselect"))}</button>` : "";
}

$("#explorer").addEventListener("click", async (e) => {
  if (e.target.id === "ex-showall") { exAll = true; return renderExplorer(true); }
  if (e.target.id === "ex-none") { exSel.clear(); return renderExplorer(true); }
  if (e.target.id === "ex-del") {
    if (!localMeshEffectsAllowed()) return;
    return deleteHist(exList().filter((d) => exSel.has(hkey(d))));
  }
  if (e.target.id === "ex-all") {
    const on = e.target.checked;
    for (const d of exList()) if (!liveOf(d.id, d.agent)) on ? exSel.add(hkey(d)) : exSel.delete(hkey(d));
    return renderExplorer(true);
  }
  const k = e.target.dataset.sel;
  if (k) {   // in place: a re-render would take the focus from the box
    e.target.checked ? exSel.add(k) : exSel.delete(k);
    e.target.closest("tr").classList.toggle("checked", e.target.checked);
    return renderBulk(exList());
  }
  if (e.target.closest(".c-cb")) return;
  const id = e.target.closest("tr.ex-row")?.dataset.id;
  if (id) openSession(id);
});
$("#ex-q").addEventListener("input", () => { exAll = false; renderExplorer(true); fullText($("#ex-q").value, "explorer"); });
$("#ex-sort").addEventListener("change", () => renderExplorer(true));

// ---------------------------------------------------------------- files
// Pasted / dropped / picked files are uploaded to the machine, then their
// paths are typed (as a paste) where the cursor is: claude and codex attach a
// pasted image path, and any other path is just text the agent can read.

const shq = (p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);
const pastedFiles = (e) => [...(e.clipboardData?.items || [])].filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter(Boolean);

const uploadHolds = new Set();
const uploadName = (f) => f.name && f.name !== "image.png" ? f.name
  : `paste-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.${(f.type.split("/")[1] || "bin").replace("jpeg", "jpg")}`;
function beginUpload(files, destination, capturedRevision = destination.kind === "compose" ? destination.owner?.revision : null) {
  if (!files.length) { releasePickerDestination(destination); return null; }
  const owner = destination.kind === "compose" ? destination.owner : null;
  if (destination.kind === "compose" && !owner) { flash(t("upload.unknownDestination")); return null; }
  const names = files.map(uploadName);
  const record = {
    target: owner ? owner.target : destination.target, destination,
    revision: capturedRevision, batch: MeshPaneActions.createUploadBatch(names),
    paths: "", inserted: false, finalized: false,
  };
  composeUploads.push(record); uploadHolds.add(record); renderComposeStatus();
  uploadFiles(files, record);
  return record;
}
async function uploadFiles(files, record) {
  const batch = record.batch;
  try {
    for (let index = batch.next(); index !== null; index = batch.next()) {
      const name = batch.items[index].name;
      flash(t("upload.sending", { name }));
      try {
        const response = await requestLocal(`/api/upload?name=${encodeURIComponent(name)}`, { method: "POST", body: files[index] });
        if (!response.ok) {
          batch.finish(index, { error: t("upload.httpError", { status: response.status, message: serverText(await response.text()) }) });
        } else {
          const body = await response.json();
          batch.finish(index, typeof body?.path === "string" && body.path
            ? { path: body.path } : { error: t("upload.noPath") });
        }
      } catch (error) { batch.finish(index, { error: t("upload.failed", { message: error?.message || error }) }); }
      record.paths = batch.items.filter((item) => item.status === "uploaded").map((item) => shq(item.path)).join(" ");
      if (composeUploads.includes(record)) renderComposeStatus();
    }
  } finally {
    uploadHolds.delete(record);
    if (!batch.abandoned) finishUploadRecord(record);
    if (composeUploads.includes(record)) renderComposeStatus();
    renderReloadStatus();
  }
}

function abandonUploadRecord(record) {
  if (!record.batch.abandon() && !record.inserting) return;
  uploadHolds.delete(record);
  record.finalized = true; // no late result may insert into any destination
  if (record.inserting) {record.operation?.cancel(); return;}
  releasePickerDestination(record.destination);
  renderComposeStatus();
}

function finishUploadRecord(record) {
  if (record.finalized) return;
  record.finalized = true;
  const destination = record.destination;
  if (record.paths && destination.kind === "compose") {
    const owner = destination.owner;
    if (owner === composeOwner && cdlg.open && owner.acceptsUpload(record.revision)
        && paneTargets.valid(owner.target)) {
      insertAtCursor(ctext, record.paths + " "); owner.change();
      record.inserted = true;
    }
  } else if (record.paths && paneTargets.valid(destination.target)) {
    endDirectLine();   // like the composer: the paths are not typed at the agent's line
    record.inserting = true; uploadHolds.add(record);
    let settled = false;
    const operation = paneInput.deliver(destination.binding, record.paths + " ", false, (outcome) => {
      if (settled) return;
      settled = true; record.inserting = false; record.operation = null;
      record.inserted = outcome.kind === "paste"; record.delivery = outcome;
      uploadHolds.delete(record); releasePickerDestination(destination);
      if (record.inserted && record.batch.items.every((item) => item.status === "uploaded")) {
        const index = composeUploads.indexOf(record);
        if (index >= 0) composeUploads.splice(index, 1);
      }
      renderComposeStatus(); renderReloadStatus();
    });
    if (!settled) record.operation = operation;
    return;
  }
  releasePickerDestination(destination);
  if (record.inserted && record.batch.items.every((item) => item.status === "uploaded")) {
    const index = composeUploads.indexOf(record);
    if (index >= 0) composeUploads.splice(index, 1);
  }
}

function insertAtCursor(el, text) {
  const a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? a;
  el.value = el.value.slice(0, a) + text + el.value.slice(b);
  el.selectionStart = el.selectionEnd = a + text.length;
  el.focus();
}

// ---------------------------------------------------------------- composer
// A plain textarea for long or multi-line prompts (handy on a phone): the text
// goes into the active pane as one bracketed paste, then Enter if asked.

// ---- phone input line
// Phone keyboards compose words, autocorrect and re-insert them: xterm's hidden
// textarea loses characters in that dance. On a phone the text is typed in a
// real field and goes to the agent in one block (as a paste), then Enter; an
// empty line sends Enter alone.

const line = $("#line-text");
// Typing in the input line or on the key bar is using this device (automatic size take-over).
for (const bar of [$("#line"), $("#keys")]) MeshPaneActions.listenForActivation(bar, (event) => active?.autoTakeSize(event));
function fitLine() { line.style.height = "auto"; line.style.height = `${line.scrollHeight}px`; }
const lineStatus = document.createElement("section");
lineStatus.setAttribute("aria-live", "polite");
lineStatus.hidden = true;
lineStatus.style.cssText = "padding:6px 10px;overflow-wrap:anywhere;background:var(--panel);border-top:1px solid var(--line)";
$("#line").after(lineStatus);
let linePending = null, lineRecovery = null, lineRevision = 0, lineDictationOrigin = null;
function saveRecoveredLine() {
  const target = recoveredLineTarget;
  if (!target) return;
  const key = `${target.name}\0${target.created}`;
  // Once submitted, the pending operation or its recovery result owns the text.
  if (line.value && !linePending?.operation && !lineRecovery)
    target.pane.recoveredLineDrafts.set(key, {...target, text: line.value});
  else target.pane.recoveredLineDrafts.delete(key);
  line.value = ""; recoveredLineTarget = null; fitLine();
}
function restoreSavedLine(pane) {
  const c = pane.conn;
  if (!touch || active !== pane || !c || pane.id !== c.name || line.value || recoveredLineTarget ||
      lineDirect || linePending || lineRecovery || $("#line").hidden) return;
  const key = `${c.name}\0${c.created}`, saved = pane.recoveredLineDrafts.get(key);
  if (!saved) return;
  line.value = saved.text; pane.recoveredLineDrafts.delete(key);
  recoveredLineTarget = saved;
  fitLine(); pane.renderRetainedInput(); renderReloadStatus();
}
function renderLineStatus() {
  lineStatus.replaceChildren();
  lineStatus.hidden = !linePending && !lineRecovery;
  // Read-only blocks edits without blurring the phone keyboard's focused
  // textarea. The sendLine ownership guard still blocks repeated submission.
  line.readOnly = !!linePending || !!lineRecovery;
  if (linePending) {
    const text = document.createElement("span");
    text.textContent = `${t(linePending.hold ? "line.waitingList" : "line.pending")} `;
    const cancel = document.createElement("button");
    cancel.type = "button"; cancel.textContent = t("compose.cancelPendingEnter");
    cancel.addEventListener("click", () => { if (linePending) cancelLinePending(linePending); });
    lineStatus.append(text, cancel);
  }
  if (lineRecovery) {
    const record = lineRecovery;
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = record.result.kind === "refused"
      ? t("line.recovery.refused")
      : t("line.recovery.partial");
    const info = document.createElement("p");
    info.textContent = t("line.recovery.info", { target: record.target.displayName, frames: record.result.frames,
      bytes: record.result.wireBytes, reason: record.result.reason || t("line.recovery.unknownReason") });
    const original = document.createElement("pre");
    original.textContent = record.text;
    original.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere";
    details.append(summary, info, original);
    const copy = document.createElement("button");
    copy.type = "button"; copy.textContent = t("compose.copyText");
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(record.text); flash(t("line.copied")); }
      catch { flash(t("line.copyFailed")); }
    });
    const discard = document.createElement("button");
    discard.type = "button"; discard.textContent = t("compose.discardResult");
    discard.addEventListener("click", () => {
      if (lineRecovery !== record) return;
      lineRecovery = null;
      releaseDiscardedEditorDraft(record.recovered);
      if (line.value === record.text) {
        line.value = "";
        lineDictationOrigin = null;
        if (recoveredLineTarget === record.recovered) {
          recoveredLineTarget = null;
        }
      }
      fitLine(); renderLineStatus(); line.focus();
    });
    lineStatus.append(details, copy, discard);
  }
  renderReloadStatus();
}
// Direct writing. Agents complete commands (`/`) and skills (`$`) while a key is typed, which
// needs every insertion at the terminal as it is made. So in an agent session a line that
// starts with one of those characters stops being a line: each insertion goes to the terminal
// as typed and the field is emptied at once. The field never mirrors the agent's line (Tab,
// the arrows, Esc, a paste or a Ctrl key change that line behind its back): the terminal is
// the only thing shown, and nothing hidden can build up. Backspace on the empty field is sent
// as DEL. A multi-line insertion is one bracketed paste or is refused, never raw bytes, and a
// keyboard correction (insertReplacementText) is refused: the field has nothing to replace.
// Enter, and every key of the bar that writes into the agent's line (Esc, Tab, the arrows, ↵ line,
// ^C, Ctrl, Paste), first deliver any text the field still holds, as typed (a composition that
// ended but is not flushed yet): nothing goes before the text that precedes it, and nothing goes
// after a text that was not delivered. They are refused while a composition is in progress.
// Back to the line: Enter,
// a control key (^C, Ctrl armed), the chip, a send from the composer or the attachment menu,
// another pane, session or view, a lost connection, or the agent leaving the foreground. See
// docs/features.md.
const lineDirectChip = $("#line-direct");
let lineWasEmpty = true;
let lineComposing = false;   // a composition is in progress in the field
let lineCompositionPane = null;   // the pane that was active when the composition started
let directInputCount = 0;   // writes made in direct writing so far: tells that something was sent meanwhile
// The pane whose agent left the foreground during direct writing: the inventory is at most a few
// seconds old, so keys typed since may have reached the program that took the terminal over. The
// first ordinary line (or key bar ⏎) sent afterwards is held back once, with a warning, while the
// input lease is dirty. The hold expires: it applies only within DIRECT_RESIDUE_MS of the loss,
// and any send, held or not, consumes it.
const DIRECT_RESIDUE_MS = 30000;
let directResidue = null;   // { pane, since }
function residueHolds(pane) {
  const residue = directResidue;
  directResidue = null;
  if (residue?.pane !== pane || Date.now() - residue.since > DIRECT_RESIDUE_MS || !pane.inputLease?.dirty) return false;
  flash(t("line.directResidue"), 6000);
  return true;
}
// The field's own attributes (an absent one is restored as absent), and what direct writing sets.
const lineTypingAttributes = [["autocapitalize", "off"], ["autocorrect", "off"], ["spellcheck", "false"]]
  .map(([name, direct]) => ({ name, direct, before: line.getAttribute(name) }));
function renderLineDirect() {
  $("#line").classList.toggle("direct", !!lineDirect);
  lineDirectChip.hidden = !lineDirect;
  // Nothing is edited in the field while writing directly: no capital, no correction.
  for (const { name, direct, before } of lineTypingAttributes) {
    if (lineDirect) line.setAttribute(name, direct);
    else if (before === null) line.removeAttribute(name);
    else line.setAttribute(name, before);
  }
}
// Ends the mode. The field is left alone: after the mode ended on its own, what is typed next
// is an ordinary line. `message` is the i18n key of what to tell, when the user must know.
function endDirectLine(message = null, held = false) {
  if (!lineDirect) return;
  if (lineDirect.heldInputType !== undefined && line.value && !lineRecovery) {
    lineRecovery = {target: {displayName: lineDirect.session}, text: line.value,
      result: {kind: "partial", frames: 0, wireBytes: 0, reason: t("line.directPasteFailed")}};
    line.value = ""; fitLine(); renderLineStatus();
  }
  lineDirect = null;
  lineComposing = false;
  renderLineDirect();
  if (message) reportDirect(message, held);
}
// Tells why something was not delivered. With `held` (the text the field held when a key came
// was not delivered) the message also says that the key was not sent.
function reportDirect(message, held = false) {
  flash(held ? t("line.directHeld", { reason: t(message) }) : t(message), 4000);
}
// Whether the mode still holds: same pane, session and connection, and the agent is in the
// foreground according to the latest inventory. If not, it ends here, sending nothing.
function directLineAlive() {
  if (!lineDirect) return false;
  const { pane, conn, session } = lineDirect;
  const here = active === pane && pane.id === session;
  const connected = pane.conn === conn && !!conn && !conn.closed && !conn.ended && localMeshEffectsAllowed();
  if (here && connected && MeshPaneActions.foregroundAgent(find(session))) return true;
  if (here && connected) directResidue = { pane, since: Date.now() };   // keys typed since the last inventory may have reached the program
  endDirectLine(!here ? null : connected ? "line.directForeground" : "line.directConnection");
  return false;
}
function writeDirect(text, complete = false, held = false) {
  directInputCount += 1;
  if (lineDirect.pane.sendRaw(enc.encode(text), complete)) return true;
  endDirectLine("line.directFailed", held);
  return false;
}
// One bracketed paste, verified by the same delivery as the ordinary line. Never raw bytes.
function pasteDirect(text, kind, held = false) {
  directInputCount += 1;
  const { pane } = lineDirect;
  if (kind === "refused" || kind === "replacement") {
    reportDirect(kind === "refused" ? "line.directRefused" : "line.directReplacement", held);
    return "refused";
  }
  if (directPasteWaits(pane)) {
    reportDirect("line.directPasteFailed", held); return "waiting";
  }
  if (kind === "multiline" && !pane.term.modes.bracketedPasteMode) {
    reportDirect("line.directNoBracket", held); return "refused";
  }
  const target = paneTargets.capture(pane);
  const binding = target && paneInput.capture(pane, target);
  let result = null;
  if (binding) paneInput.deliver(binding, text, false, (r) => { result = r; });
  if (target) paneTargets.release(target);
  if (result?.kind === "paste") return "sent";
  endDirectLine("line.directPasteFailed", held);
  // Only a known refusal can be retained; an uncertain write may have arrived.
  return !binding || result?.kind === "refused" ? "refused" : "discarded";
}
function directPasteWaits(pane) {
  const c = pane.conn;
  return !!(!c?.terminal?.isOpen() || c.replaying || c.draining || c.replayPending || c.activeHumanInput
    || c.flushingHumanInput || c.queuedHumanInput?.length);
}
// Ctrl armed: the letter is a control key, and that ends the mode. True when it was sent.
function sendDirectControl(letter, held = false) {
  setCtrl(false);
  const c = letter.toUpperCase().charCodeAt(0);
  if (c < 64 || c > 95) { reportDirect("line.directNoControl", held); return false; }
  const control = String.fromCharCode(c - 64);
  if (!writeDirect(control, completesInput(control), held)) return false;
  endDirectLine();
  return true;
}
let directFieldAttempt = 0;   // a held-key attempt supersedes a pending composition flush
function recoverDirectText(direct, text, reason) {
  if (lineRecovery) return;
  lineRecovery = {target: {displayName: direct.session}, text,
    result: {kind: "refused", frames: 0, wireBytes: 0, reason: t(reason)}};
  line.value = ""; fitLine();
  if (lineDirect === direct) endDirectLine();
  renderLineStatus();
}
// Keep a paste held by the queue, or keep previously held text after a definite refusal.
// Other failures clear the field so the text cannot later be sent as ordinary input.
function flushDirectField(inputType, held = false) {
  const text = line.value;
  if (!text) {delete lineDirect.heldInputType; return true;}
  directFieldAttempt += 1;
  const direct = lineDirect, previousOrigin = direct.heldInputType;
  const origin = previousOrigin ?? inputType;
  const kind = MeshPaneActions.directInput(text, origin);
  // Delivery may end direct mode synchronously. Only a still-waiting paste
  // should be recovered by that teardown; classify all other results below.
  delete direct.heldInputType;
  // The terminal replay queue can be dropped with its socket. Preserve typed
  // text in the review field before the queue can take ownership of it.
  if (kind === "typed" && directPasteWaits(direct.pane)) {
    recoverDirectText(direct, text, "line.directFailed");
    return false;
  }
  const paste = kind === "typed" ? null : pasteDirect(text, kind, held);
  if (paste === "waiting") {
    if (lineDirect === direct) direct.heldInputType = origin;
    return false;
  }
  line.value = "";
  fitLine();
  if (paste !== null) {
    if (paste === "refused") recoverDirectText(direct, text, "line.directPasteFailed");
    return paste === "sent";
  }
  if (ctrlArmed && Array.from(text).length === 1) return sendDirectControl(text, held);
  // ACK writes returning false did not enqueue these bytes. Keep them for explicit review;
  // a legacy write can have an uncertain outcome and must never be offered for replay here.
  const acknowledged = !!lineDirect.pane.inputAck;
  const delivered = writeDirect(text, false, held);
  if (!delivered && acknowledged) recoverDirectText(direct, text, "line.directFailed");
  return delivered;
}
// The field changed and no composition is in progress. True when direct writing took the text.
// `composedOn` is the pane a composition started on: its word does not start the mode on another.
function settleLine(inputType, composedOn = active) {
  if (lineDictationOrigin) return false;   // dictated corrections stay local, including slash/skill prefixes
  if (lineDirect) {
    if (!directLineAlive()) return false;
    flushDirectField(inputType);
    return true;
  }
  if (ctrlArmed || !lineWasEmpty || composedOn !== active || !active?.conn?.terminal?.isOpen()   // a connection not open yet cannot take the word: it stays in the field
      || !active.conn.terminal.isBound(active.conn.name, active.conn.created)
      || !MeshPaneActions.directLineStarts(MeshPaneActions.foregroundAgent(find(active.id)), line.value, inputType)) return false;
  lineDirect = { pane: active, conn: active.conn, session: active.id };
  renderLineDirect();
  flushDirectField(inputType);
  void refresh();   // the foreground may have changed since the last poll: the mode ends if so
  return true;
}
// Text the field still holds when a key comes: a composition that ended but is not flushed yet
// (its flush waits for the next task). It goes first, in order, so the key never overtakes it.
// False when the key must not be sent: the text is a composition still in progress (it will be
// committed later, so taking it now would double it), or it was not delivered as typed (refused,
// not delivered, or turned into a control key that ended the mode). A message says why.
function deliverHeldDirectText() {
  if (!line.value) return true;
  if (lineComposing) { flash(t("line.directComposing"), 4000); return false; }
  const delivered = flushDirectField("insertCompositionText", true);
  fitLine();
  return delivered && !!lineDirect;
}
// The gate of every key that writes into the agent's line while writing directly: the mode
// still holds (else it ended, saying why), and the text the field holds has gone first.
function directKeyAllowed() { return directLineAlive() && deliverHeldDirectText(); }
// The one way a key of the bar reaches the agent's line. While writing directly it follows
// Enter's rule. Otherwise it goes as it is, except the bar's ⏎, which is held back once after the
// agent left the foreground (see residueHolds). True when it was handed to the pane.
function sendKeyToAgent(str) {
  if (lineRecovery) return false;
  if (lineDirect) return directKeyAllowed() && writeDirect(str, completesInput(str));
  if (str === "\r" && residueHolds(active)) return false;
  active.send(str);
  return true;
}
function submitDirectLine() {   // Enter: the agent's line is submitted as it is in the terminal
  directInputCount += 1;
  const delivered = lineDirect.pane.sendRaw(enc.encode("\r"), true);
  endDirectLine(delivered ? null : "line.directEnterFailed");
}
function enterLine() {   // the line's own Enter, or the key bar's
  if (lineRecovery) return;
  if (!lineDirect) return sendLine();
  if (directKeyAllowed()) submitDirectLine();   // else the mode ended or the text is held: a message says why
}
async function pasteClipboardDirect() {   // the key bar's Paste while writing directly
  const direct = lineDirect;
  if (!directKeyAllowed()) return;   // the held text goes before the paste, or a message says why not
  const inputBefore = directInputCount;   // what is sent from here to the clipboard's answer was typed after the tap
  let text;
  try { text = await navigator.clipboard.readText(); }
  catch { flash(t("clipboard.pasteDenied")); return; }
  if (lineDirect !== direct) { flash(t("line.directPasteFailed"), 4000); return; }
  if (directInputCount !== inputBefore) { flash(t("line.directPasteLate"), 4000); return; }   // a key went first: the paste would land out of order
  if (!directKeyAllowed()) return;   // text typed meanwhile and still held goes first, or a message says why not
  if (!text) { flash(t("line.directPasteEmpty")); return; }
  const result = pasteDirect(text, MeshPaneActions.directInput(text, "insertFromPaste"));
  if (result === "refused" || result === "waiting") recoverDirectText(direct, text, "line.directPasteFailed");
}
lineDirectChip.addEventListener("click", () => { endDirectLine("line.directLeft"); line.focus(); });
// Enter pressed before the session list has named the pane's session (its terminal attaches by name
// first): the line is held, read-only, until a listing names it (static/held-line.ts). It goes only
// to the pane and view Enter was pressed in, within LINE_HOLD_MS, and Cancel ends the wait. Otherwise
// nothing is sent, the text stays in the field and a message says why. Null when nothing is to be sent.
const LINE_HOLD_MS = 5000;
async function heldLineTarget(pane, pending) {
  const id = pane.id, view = pane.actionView;
  const hold = MeshPaneActions.holdLineForTarget({
    capture: () => { observePaneActions(pane); return paneTargets.capture(pane); },
    waiting: () => !inventoryLoaded || !!pane.provisional,
    same: () => active === pane && pane.id === id && pane.actionView === view,
    listed: () => refresh(),
    timers: window, limitMs: LINE_HOLD_MS, pauseMs: 250,
  });
  pending.hold = hold.waits ? hold : null;
  linePending = pending;
  renderLineStatus();
  const end = await hold.settled;
  pending.hold = null;
  if (end.kind === "target" && linePending === pending) return end.target;
  if (end.kind === "target") paneTargets.release(end.target);
  if (linePending === pending) linePending = null;
  renderLineStatus();
  const why = { missing: "line.noTarget", moved: "line.heldMoved", late: "line.heldLate" }[end.kind];
  if (why) flash(t(why), 6000);
  return null;
}
// Cancel of a pending line: its Enter once the text is sent, or the wait before it (text kept).
function cancelLinePending(owner) {
  if (owner.operation) { owner.operation.cancel(); return; }
  if (!owner.hold?.cancel()) return;
  if (linePending === owner) linePending = null;
  renderLineStatus();
  line.focus();
}
async function sendLine() {
  if (linePending || lineRecovery || !active?.conn) return;
  if (active.conn.terminal?.limited) { flash(t("terminal.limitedInput")); return; }
  const pane = active;
  if (recoveredLineTarget && (recoveredLineTarget.pane !== pane ||
      recoveredLineTarget.name !== pane.conn.name || recoveredLineTarget.created !== pane.conn.created)) {
    flash(t("line.recoveredOtherSession")); return;
  }
  if (lineDictationOrigin) {
    const origin = lineDictationOrigin, identity = find(pane.id);
    if (pane !== origin.pane || pane.conn !== origin.connection || pane.conn.terminal !== origin.terminal
        || identity?.name !== origin.name || identity?.created !== origin.created) {
      flash(t("line.dictationTargetChanged")); return;
    }
  }
  if (residueHolds(pane)) return;   // once: the next Enter sends
  const text = line.value;
  const recovered = recoveredLineTarget;
  const pending = { operation: null, done: false, hold: null };
  const target = await heldLineTarget(pane, pending);
  if (!target) return;
  linePending = null;
  const binding = paneInput.capture(pane, target);
  if (!binding) { paneTargets.release(target); renderLineStatus(); flash(t("line.noConnection")); return; }
  linePending = pending;
  renderLineStatus();
  pending.operation = paneInput.deliver(binding, text, true, (result) => {
    if (pending.done) return;
    pending.done = true;
    paneTargets.release(target);
    if (linePending === pending) linePending = null;
    if (result.kind === "submitted") {
      if (line.value === text) {line.value = ""; lineDictationOrigin = null;}
      recoveredLineTarget = null;
      fitLine();
    } else {
      lineRecovery = { target, text, result, recovered };
    }
    renderLineStatus();
  });
  if (!pending.done) renderLineStatus();
}
function directBackspace() {   // the field is empty, so the key would do nothing: it erases in the agent's line
  if (directLineAlive()) writeDirect("\x7f");
}
$("#line").addEventListener("submit", (e) => { e.preventDefault(); enterLine(); line.focus(); });
line.addEventListener("input", () => {
  if (!line.value) {
    releaseDiscardedEditorDraft(recoveredLineTarget);
    recoveredLineTarget = null;
    active?.renderRetainedInput();
  }
});
line.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enterLine(); }
  else if (e.key === "Backspace" && lineDirect && line.value === "") { e.preventDefault(); directBackspace(); }
});
line.addEventListener("beforeinput", (e) => {   // Enter and Backspace from keyboards that send no usable keydown
  if (!e.isComposing) lineWasEmpty = line.value === "";
  if (e.inputType === "insertReplacementText" && lineDirect) {   // the correction of text the field no longer holds
    e.preventDefault();
    flash(t("line.directReplacement"), 4000);
    return;
  }
  if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") { e.preventDefault(); enterLine(); }
  else if (e.inputType === "deleteContentBackward" && lineDirect && !e.isComposing && line.value === "") {
    e.preventDefault();
    directBackspace();
  }
});
line.addEventListener("input", (e) => {
  lineRevision++;
  if (!line.value) lineDictationOrigin = null;
  if (lineDictationOrigin) {fitLine(); return;}
  if (!e.isComposing && settleLine(e.inputType || "")) { fitLine(); return; }
  if (ctrlArmed && line.value.length === 1) {   // Ctrl armed in the key bar: the letter is a control key
    const c = line.value.toUpperCase().charCodeAt(0);
    line.value = "";
    setCtrl(false);
    if (c >= 64 && c <= 95) active?.send(String.fromCharCode(c - 64));
  }
  fitLine();
});
// A composition is sent when it ends; some browsers fire its last input event after compositionend.
// The field is checked when a composition starts: its own events come with isComposing set, so
// beforeinput cannot tell whether the field was empty before the composition.
line.addEventListener("compositionstart", () => {
  lineRevision++;
  lineComposing = true;
  lineWasEmpty = line.value === "";
  lineCompositionPane = active;
});
line.addEventListener("compositionend", () => {
  lineRevision++;
  if (!line.value) lineDictationOrigin = null;
  lineComposing = false;
  const composedOn = lineCompositionPane;
  const before = directFieldAttempt;
  setTimeout(() => {
    if (directFieldAttempt === before && settleLine("insertCompositionText", composedOn)) fitLine();
  }, 0);
});

const cdlg = $("#dlg-compose"), ctext = $("#compose-text");
const composeSend = $("#compose-send"), composeInsert = $("#compose-insert");
const composeStatus = document.createElement("section");
composeStatus.setAttribute("aria-live", "polite");
composeStatus.style.cssText = "padding:8px;overflow-wrap:anywhere;background:var(--panel);border:1px solid var(--line)";
cdlg.after(composeStatus);
const composePending = document.createElement("p");
composePending.setAttribute("aria-live", "polite");
composePending.hidden = true;
ctext.after(composePending);
let composeOwner = null;
const composeRecovery = [], composeUploads = [];
let inlineDictation = null, inlineDictationView = null;
const inlineContexts = new WeakMap();
let dictationInventoryReady = false, dictationInventoryIssue = 0;
function createDictationEncoder() {
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true"); host.inert = true;
  host.className = "dictation-encoder";
  let terminal, disposed = false;
  try {
    document.body.append(host);
    terminal = new Terminal({cols: 80, rows: 2, scrollback: 0});
    terminal.open(host);
  } catch (error) {
    try {terminal?.dispose();} finally {host.remove();}
    throw error;
  }
  return {write: (text, done) => terminal.write(text, done), paste: (text) => terminal.paste(text),
    onData: (callback) => terminal.onData(callback), dispose: () => {
      if (disposed) return;
      disposed = true;
      try {terminal.dispose();} finally {host.remove();}
    }};
}
function reportDictationInventory(issue, ready) {
  if (!localMeshEffectsAllowed() || issue < dictationInventoryIssue) return;
  dictationInventoryIssue = issue; dictationInventoryReady = ready;
  renderInlineDictation();
}
function inlinePhoneBusy() {
  return touch && (line.value.length > 0 || lineComposing || !!linePending || !!lineRecovery);
}
function inlineContextReason(context, capture = false) {
  const {pane, connection, name, created, lease} = context;
  const identity = paneTargets.identity(name), session = find(name), terminal = connection?.terminal;
  if (!localMeshEffectsAllowed() || !dictationInventoryReady || identity?.name !== name
       || identity.created !== created || session?.kind !== "mesh" || session.created !== created
       || !rowAuthoritative(session)) return "unavailable";
  const agent = session.agent;
  if (!agent?.type || agent.foreground !== true) return "unsupportedTarget";
  if (agent.type !== context.agentType || agent.pid !== context.agentPid) return "contextChanged";
  if (agent.status === "busy") return "agentBusy";
  if (agent.status !== "idle") return "agentNotReady";
  if (!terminal?.isOpen() || !terminal.isBound(name, created) || connection.ended) return "bindingUnavailable";
  if (connection.replaying || connection.draining || connection.replayPending
      || !terminal.dictationMode.valid || !terminal.dictationMode.value) return "unsafePaste";
  if (!lease?.canInsert()) return "pendingInput";
  if (touch && (lease.inputDirty || lineDirect || ctrlArmed)) return "phoneNativeInputBusy";
  if (capture && (pane.actionDisposed || pane.conn !== connection || pane.el.classList.contains("tab-hidden")
      || pane.el.getClientRects().length === 0)) return "hiddenContext";
  if (capture && inlinePhoneBusy()) return "phoneInputBusy";
  return "";
}
function inlineContext(pane) {
  const c = pane.conn, agent = find(c?.name)?.agent;
  return {pane, connection: c, name: c?.name, created: c?.created, lease: pane.inputLease,
    agentType: agent?.type, agentPid: agent?.pid};
}
function inlineSessionEligible(session) {
  const context = inlineContexts.get(session);
  return !!context && !inlineContextReason(context, ["idle", "requesting", "recording"].includes(session.state));
}
function resolveInlineHold(button) {
  const pane = panes.find(p => p.el.contains(button)), c = pane?.conn;
  if (!inlineDictation || !pane || !Number.isFinite(c?.created) || c.created <= 0) return null;
  const session = inlineDictation.session(c.name, c.created);
  setActive(pane);
  renderInlineDictation();
  if (!session.outstanding || ["idle", "recovery"].includes(session.state)) inlineContexts.set(session, inlineContext(pane));
  return {controller: inlineDictation, session};
}
function retainInlinePhonePrompt(context, releaseTarget) {
  const {pane, connection, lease} = context;
  const fieldRevision = lineRevision, nativeRevision = lease.revision, releaseLease = lease.retain();
  let released = false, claimed = false, used = false;
  const valid = () => !released && active === pane && pane.conn === connection
    && !pane.actionDisposed && !$("#line").hidden && !document.querySelector("dialog[open]")
    && lineRevision === fieldRevision && lease.revision === nativeRevision
    && !inlinePhoneBusy() && !inlineContextReason(context, true);
  return {
    valid, captureFresh: valid,
    claim() {if (used || !valid()) return false; claimed = true; return true;},
    release() {
      if (released) return;
      released = true;
      for (const dispose of [releaseTarget, releaseLease]) {
        try {dispose();} catch { /* One failed disposer must not retain the other reference. */ }
      }
    },
    deliver(text, done, guard) {
      if (!claimed || used || !valid() || !guard()) {done({kind: "refused"}); return;}
      used = true;
      // Do not dispatch input: a dictated slash/skill must remain an editable draft too.
      lineDictationOrigin = {...context, terminal: connection.terminal};
      line.value = text; lineWasEmpty = false; lineRevision++; fitLine();
      done({kind: "draft"});
    },
  };
}
function retainInlineChannel(session) {
  const context = inlineContexts.get(session);
  if (!context || inlineContextReason(context, true)) return null;
  const {pane, connection, lease} = context, terminal = connection.terminal;
  const inputAck = pane.inputAck;
  if (inputAck && (pane.inputAcks.get(`${context.name}\0${context.created}`)?.input !== inputAck ||
      pane.conn !== connection || pane.inputLease !== lease)) return null;
  const target = paneTargets.capture(pane);
  if (!target) return null;
  let releaseTerminal = null, releaseInput = null, released = false;
  const releaseTarget = () => {
    if (released) return;
    released = true;
    try {paneTargets.release(target);}
    finally { try {releaseInput?.();} finally {releaseTerminal?.();} }
  };
  try {
    releaseTerminal = terminal.retain();
    if (!releaseTerminal) {releaseTarget(); return null;}
    if (touch) return retainInlinePhonePrompt(context, releaseTarget);
    if (inputAck) {
      if (inputAck.retainedConnection) {releaseTarget(); return null;}
      inputAck.retainedConnection = connection;
      releaseInput = () => {
        if (inputAck.retainedConnection !== connection || connection.forgetRetainedInput !== releaseInput) return;
        inputAck.retainedConnection = null;
        connection.forgetRetainedInput = null;
        if (connection.closed) inputAck.disconnect();
      };
      connection.forgetRetainedInput = releaseInput;
    }
    return MeshPaneActions.createDictationChannel({
      target, socket: connection.ws, lease, encoder: createDictationEncoder, mode: terminal.dictationMode,
      insertionOnly: true,
      valid: () => !inlineContextReason(context),
      release: releaseTarget,
      transport: {control: (id, dirty) => terminal.lease(id, dirty), data: bytes => terminal.queueInput(bytes)},
      writeAcknowledged: inputAck ? (bytes, complete, settled) =>
        inputAck.retainedConnection === connection && connection.terminal === terminal && !connection.v2AwaitingCapability &&
        terminal.isBound(context.name, context.created) &&
        inputAck.writeTracked(bytes, complete, settled, frame => terminal.acknowledgedInput(frame)) : undefined,
    });
  } catch (error) {releaseTarget(); throw error;}
}
function inlineInsertionFinished(session) {
  const context = inlineContexts.get(session), pane = context?.pane;
  if (!context || !pane || active !== pane || pane.conn !== context.connection
      || pane.actionDisposed || inlineContextReason(context) || document.querySelector("dialog[open]")) return;
  const focused = document.activeElement;
  if (focused !== document.body && !pane.el.contains(focused) && focused !== line) return;
  if (touch) {
    if (lineComposing || linePending || lineRecovery) return;
    line.focus({preventScroll: true});
  } else pane.term.textarea?.focus({preventScroll: true});
}
function cancelInlineCapture(pane) {
  const c = pane.conn, session = c && inlineDictation?.peekSession(c.name, c.created);
  const context = session && inlineContexts.get(session);
  if (!context || context.pane !== pane || context.connection !== c) return;
  inlineDictationView?.cancel(session); inlineDictation.detach(session);
}
function startInlineDictation() {
  inlineDictation = MeshPaneActions.createInlineDictationController({
    namespace: `${location.origin}/${meshContext.storagePrefix}/native`, uuid: () => crypto.randomUUID(),
    allowed: localMeshEffectsAllowed, eligible: inlineSessionEligible, retain: retainInlineChannel,
    media: MeshPaneActions.browserDictationMedia(), request: (path, init) => requestLocal(path, init),
    changed: () => {renderInlineDictation(); renderLists(); renderReloadStatus();},
    inserted: inlineInsertionFinished,
    schedule: (callback, ms) => setTimeout(callback, ms), unschedule: id => clearTimeout(id), now: () => performance.now(),
  });
  inlineDictationView = MeshPaneActions.createInlineDictationView({resolve: resolveInlineHold});
  for (const event of ["input", "compositionstart", "compositionend"]) line.addEventListener(event, renderInlineDictation);
  void inlineDictation.start();
}
function inlineReasonText(code) {
  const keys = {
    unsupportedTarget: "dictation.inline.unsupportedTarget", agentBusy: "dictation.inline.agentBusy",
    agentNotReady: "dictation.inline.agentNotReady",
    bindingUnavailable: "dictation.inline.bindingUnavailable", unsafePaste: "dictation.inline.unsafePaste",
    pendingInput: "dictation.inline.pendingInput", hiddenContext: "dictation.inline.hiddenContext",
    phoneInputBusy: "dictation.inline.phoneInputBusy", cleanupUnavailable: "dictation.inline.cleanupUnavailable",
    phoneNativeInputBusy: "dictation.inline.phoneNativeInputBusy",
    contextChanged: "dictation.inline.interference", deliveryUncertain: "dictation.inline.uncertain",
    invalidTranscript: "dictation.inline.invalidTranscript", resultExpired: "dictation.inline.expired",
    jobMissing: "dictation.inline.expired", outstanding: "dictation.inline.outstanding",
    unavailable: "dictation.message.unavailable", unsupported: "dictation.message.unsupported",
    microphoneBusy: "dictation.message.microphoneBusy", permissionTimeout: "dictation.message.permissionTimeout",
    permissionDenied: "dictation.message.permissionDenied", audioLimit: "dictation.message.audioLimit",
    recordingError: "dictation.message.recordingError", microphoneInterrupted: "dictation.message.microphoneInterrupted",
    durationLimit: "dictation.message.durationLimit", invalidAudio: "dictation.message.invalidAudio",
    not_configured: "dictation.inline.not_configured", invalid_configuration: "dictation.inline.invalid_configuration",
    runtime_unavailable: "dictation.inline.runtime_unavailable", startup_timeout: "dictation.inline.startup_timeout",
    worker_failed: "dictation.inline.worker_failed",
  };
  return code ? t(keys[code] || "dictation.inline.failure") : "";
}
function inlineStateLabel(session) {
  const keys = {requesting: "dictation.state.requesting", recording: "dictation.state.recording",
    uploading: "dictation.state.uploading", queued: "dictation.state.queued", processing: "dictation.state.processing",
    delivering: "dictation.inline.inserting", recovery: "dictation.inline.cleanup"};
  return session?.message ? inlineReasonText(session.message) : keys[session?.state] ? t(keys[session.state]) : "";
}
function renderInlineDictation(onlyPane = null) {
  const holds = new Set(inlineDictation?.holds() || []);
  for (const pane of onlyPane?.el ? [onlyPane] : panes) {
    const button = pane.el.querySelector('[data-act="dictate"]'), status = pane.el.querySelector(".p-inline-dictation-status");
    if (!button || !status) continue;
    const c = pane.conn, local = find(pane.id)?.kind === "mesh" && !!c;
    button.hidden = status.hidden = !local;
    if (!local) continue;
    const session = Number.isFinite(c.created) && c.created > 0 ? inlineDictation?.session(c.name, c.created) : null;
    if (session && !holds.has(session)) inlineContexts.set(session, inlineContext(pane));
    const localReason = inlineContextReason(inlineContext(pane), true);
    let controllerReason = session ? inlineDictation.reason(session) : "unavailable";
    if (!localReason && ["idle", "recovery"].includes(session?.state) && controllerReason === "ineligible") controllerReason = "";
    const serviceReason = inlineDictation?.disabledReason();
    const reason = serviceReason || localReason || controllerReason;
    const capturing = session?.state === "requesting" || session?.state === "recording";
    button.setAttribute("aria-disabled", String(!!reason && !capturing));
    button.setAttribute("aria-pressed", String(session?.state === "recording"));
    button.title = inlineReasonText(reason) || t("dictation.holdHint");
    if (!status.id) status.id = `dictation-status-${crypto.randomUUID()}`;
    button.setAttribute("aria-describedby", status.id);
    status.textContent = inlineReasonText(serviceReason) || inlineStateLabel(session) || inlineReasonText(reason)
      || (touch ? t("dictation.inline.phoneIdle") : t("dictation.inline.idle"));
    status.dataset.state = session?.state || "idle";
  }
}
function renderDictationBadges(onlyPane = null) {
  for (const pane of onlyPane ? [onlyPane] : panes) {
    let badge = pane.el.querySelector(".p-dictation");
    if (!badge) {badge = document.createElement("span"); badge.className = "p-dictation dictation-label";
      badge.setAttribute("role", "status"); pane.el.querySelector(".p-name").after(badge);}
    const s = find(pane.id), native = s?.kind === "mesh" && inlineDictation?.peekSession(s.name, s.created);
    const session = native;
    badge.hidden = !session?.outstanding; badge.dataset.state = session?.state || "idle";
    badge.textContent = session ? inlineStateLabel(session) : "";
  }
  renderInlineDictation(onlyPane);
}
function renderComposeStatus() {
  composeStatus.replaceChildren();
  const pending = !!composeOwner?.pending;
  composeStatus.hidden = !composeRecovery.length && !composeUploads.length;
  composePending.replaceChildren(); composePending.hidden = !pending;
  ctext.readOnly = pending || composeRecovery.length > 0;
  composeSend.disabled = composeInsert.disabled = pending || composeRecovery.length > 0;
  if (pending) {
    const row = document.createElement("p");
    row.textContent = t("compose.pending", { target: composeOwner.target.displayName });
    const cancel = document.createElement("button");
    cancel.type = "button"; cancel.textContent = t("compose.cancelPendingEnter");
    cancel.addEventListener("click", () => composeOwner?.operation?.cancel());
    composePending.append(row, cancel);
  }
  for (const record of composeRecovery) renderComposeRecovery(record);
  for (const record of composeUploads) renderComposeUpload(record);
  renderReloadStatus();
}
function renderComposeRecovery(record) {
  const details = document.createElement("details"), summary = document.createElement("summary");
  summary.textContent = t("compose.recovery.summary", { target: record.target.displayName,
    kind: record.result.kind === "refused" ? t("compose.recovery.refused") : t("compose.recovery.partial") });
  const info = document.createElement("p");
  const outcome = record.result.kind === "refused"
    ? t("compose.recovery.refusedOutcome")
    : t("compose.recovery.partialOutcome");
  info.textContent = t("compose.recovery.info", { frames: record.result.frames, bytes: record.result.wireBytes,
    reason: record.result.reason || t("compose.recovery.unknownReason"), outcome });
  const original = document.createElement("pre");
  original.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere";
  original.textContent = record.text;
  details.append(summary, info, original);
  const copy = document.createElement("button");
  copy.type = "button"; copy.textContent = t("compose.copyText");
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(record.text); flash(t("compose.copied")); }
    catch { flash(t("compose.copyFailed")); }
  });
  const discard = document.createElement("button");
  discard.type = "button"; discard.textContent = t("compose.discardResult");
  discard.addEventListener("click", () => {
    const index = composeRecovery.indexOf(record);
    if (index < 0) return;
    releaseDiscardedEditorDraft(record.target, record.entry);
    composeRecovery.splice(index, 1); renderComposeStatus();
  });
  const transfer = document.createElement("button");
  transfer.type = "button"; transfer.textContent = t("compose.recovery.newDraft");
  transfer.addEventListener("click", () => {
    if (!composeRecovery.includes(record)) return;
    if (!confirm(t("compose.recovery.newDraftConfirm"))) return;
    if (!openCompose(record.text, true)) return;
    const {pane, name, created} = composeOwner.target;
    if (record.entry && pane === record.target.pane &&
        name === record.target.name && created === record.target.created) {
      pane.recoveredComposeDraft = {name, created, text: record.text, entry: record.entry};
      pane.recoveredComposeOwner = composeOwner;
    } else releaseDiscardedEditorDraft(record.target, record.entry);
    composeRecovery.splice(composeRecovery.indexOf(record), 1);
    renderComposeStatus();
  });
  composeStatus.append(details, copy, discard, transfer);
}
function renderComposeUpload(record) {
  const row = document.createElement("section");
  const state = record.batch.abandoned ? t("upload.state.abandoned")
    : !record.batch.complete || record.inserting ? t("upload.state.inProgress")
      : record.inserted ? t("upload.state.inserted")
        : t("upload.state.notInserted");
  const title = document.createElement("p");
  title.textContent = t("upload.title", { target: record.target.displayName, state });
  const details = document.createElement("ul");
  for (const item of record.batch.items) {
    const li = document.createElement("li");
    const status = item.status === "uploaded" ? t("upload.item.stored", { path: item.path })
      : item.status === "error" ? t("upload.item.failed", { error: item.error })
        : item.status === "skipped" ? t("upload.item.skipped") : t("upload.item.waiting");
    li.textContent = t("upload.item.line", { name: item.name, status });
    details.append(li);
  }
  row.append(title, details);
  const copy = document.createElement("button");
  copy.type = "button"; copy.textContent = t("upload.copyPaths"); copy.disabled = !record.paths;
  copy.addEventListener("click", () => navigator.clipboard.writeText(record.paths).catch(() => flash(t("upload.copyFailed"))));
  const cancel = document.createElement("button");
  cancel.type = "button"; cancel.textContent = t("upload.cancelPending");
  cancel.addEventListener("click", () => abandonUploadRecord(record));
  const discard = document.createElement("button");
  discard.type = "button"; discard.textContent = t("compose.discardResult");
  discard.addEventListener("click", () => {
    if (record.inserting) record.operation?.cancel();
    const index = composeUploads.indexOf(record);
    if (index >= 0) composeUploads.splice(index, 1);
    renderComposeStatus();
  });
  row.append(copy);
  if ((!record.batch.complete || record.inserting) && !record.batch.abandoned) row.append(cancel);
  else row.append(discard);
  composeStatus.append(row);
}
function openCompose(preset = "", fromRecovery = false) {
  if (localActionUnavailable()) return;
  if (active?.conn?.terminal?.limited) { flash(t("terminal.limitedInput")); return false; }
  if (cdlg.open) return false;
  // A terminal-origin native picker may stay pending without a browser cancel
  // event. Keep its Reset outside the top-layer composer instead of hiding it.
  if (pickerGate.pending?.destination.kind === "terminal") {
    flash(t("compose.pickerPending"));
    return false;
  }
  // A native close event may still be queued. Settle its old ownership before
  // another opening can replace the shared dialog's controller.
  if (composeOwner) retireComposeOwner(composeOwner);
  if (!active?.conn) return false;
  if (composeRecovery.length && !fromRecovery) {
    flash(t("compose.reviewPrevious")); return false;
  }
  const pane = active;
  const recovered = pane.recoveredComposeDraft;
  if (!preset && recovered && recovered.name === pane.conn.name && recovered.created === pane.conn.created)
    preset = recovered.text;
  observePaneActions(pane);
  const target = paneTargets.capture(pane);
  if (!target) { flash(t("compose.noTarget")); return false; }
  const binding = paneInput.capture(pane, target);
  if (!binding) { paneTargets.release(target); flash(t("compose.noConnection")); return false; }
  composeOwner = MeshPaneActions.createComposeOwner(target, binding);
  if (recovered && preset === recovered.text && recovered.name === pane.conn.name && recovered.created === pane.conn.created)
    pane.recoveredComposeOwner = composeOwner;
  ctext.value = preset;
  cdlg.append(composeStatus);
  cdlg.showModal(); renderComposeStatus(); ctext.focus(); return true;
}

// Move only unsent text into the editor for the same verified input actor.
function restoreOldInputToEditor(pane) {
  const c = pane.conn;
  if (active !== pane || !c?.terminal?.isOpen() || !c.terminal.isBound(c.name, c.created) ||
      lineDirect || linePending || lineRecovery) return;
  const key = `${c.name}\0${c.created}`;
  const entry = pane.inputAcks.get(key);
  if (!entry || entry.input !== pane.inputAck || entry.lease !== pane.inputLease) return;
  const text = entry.input.editableRetainedText;
  // Control sequences and invalid UTF-8 cannot safely be reconstructed as text.
  if (!text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/.test(text)) return;
  if (touch) {
    if (line.value || recoveredLineTarget || $("#line").hidden) return;
    line.value = text;
    recoveredLineTarget = { pane, name: c.name, created: c.created, entry };
    fitLine();
  } else {
    if (cdlg.open || composeRecovery.length || pickerGate.pending || pane.recoveredComposeDraft) return;
    if (!openCompose(text, true)) return;
    pane.recoveredComposeDraft = { name: c.name, created: c.created, text, entry };
    pane.recoveredComposeOwner = composeOwner;
  }
  entry.input.discard();
  pane.renderRetainedInput();
  renderReloadStatus();
}
function releaseDiscardedEditorDraft(target, entry = target?.entry) {
  if (!target || !entry) return;
  const original = target.pane.inputAcks.get(`${target.name}\0${target.created}`);
  if (original && entry.input && original.input === entry.input && original.lease === entry.lease &&
      !entry.input.pendingBytes && !entry.input.incompleteHumanInput) entry.lease.release();
}
function retireComposeOwner(owner) {
  if (!owner) return;
  owner.close(); owner.operation?.cancel(); paneTargets.release(owner.target);
  if (composeOwner !== owner) return;
  const pane = owner.target.pane;
  if (pane.recoveredComposeOwner === owner) {
    if (pane.recoveredComposeDraft) pane.recoveredComposeDraft.text = ctext.value;
    if (!ctext.value) {
      releaseDiscardedEditorDraft(owner.target, pane.recoveredComposeDraft?.entry);
      pane.recoveredComposeDraft = null;
    }
    pane.recoveredComposeOwner = null;
  }
  composeOwner = null; ctext.value = ""; renderComposeStatus();
}
function sendCompose(submit) {
  if (!localMeshEffectsAllowed()) return;
  const owner = composeOwner, text = ctext.value;
  if (!owner?.open || !cdlg.open || owner.pending || composeRecovery.length || !text) return;
  const revision = owner.begin();
  if (revision === null) return;
  endDirectLine();   // what the composer sends is not typed at the agent's line: the field is an ordinary line again
  renderComposeStatus();
  owner.operation = paneInput.deliver(owner.binding, text, submit, (result) => {
    const stillOpen = owner.settle(revision);
    paneTargets.release(owner.target);
    const pane = owner.target.pane;
    let entry;
    if (pane.recoveredComposeOwner === owner) {
      entry = pane.recoveredComposeDraft?.entry;
      pane.recoveredComposeDraft = null;
    }
    if (result.kind === (submit ? "submitted" : "paste")) {
      if (stillOpen && composeOwner === owner && ctext.value === text) {
        retireComposeOwner(owner); cdlg.close();
      }
    } else {
      composeRecovery.push({ target: owner.target, text, result, entry });
      if (stillOpen && composeOwner === owner) { retireComposeOwner(owner); cdlg.close(); }
    }
    renderComposeStatus();
  });
  renderComposeStatus();
}
cdlg.addEventListener("close", () => {
  if (!cdlg.open) retireComposeOwner(composeOwner);
  if (!cdlg.open) active?.renderRetainedInput();
  if (!cdlg.open) cdlg.after(composeStatus);
  if (pickerGate.pending?.destination.kind === "compose") adlg.after(pickerStatus);
  renderReloadStatus();
});
ctext.addEventListener("input", () => { composeOwner?.change(); });
$("#compose-send").addEventListener("click", () => sendCompose(true));
$("#compose-insert").addEventListener("click", () => sendCompose(false));
ctext.addEventListener("paste", (e) => {
  const files = pastedFiles(e);
  if (!files.length) return;
  e.preventDefault();
  deliverComposeFiles(files);
});
ctext.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendCompose(true); }
});

// the paths go into the compose box when it is open, else into the active terminal
const pickerGate = MeshPaneActions.createChooserGate();
const pickerBySource = new WeakMap();
function deliverComposeFiles(files, owner = composeOwner) {
  if (!files.length) return;
  if (!owner) { flash(t("upload.unknownDestinationNothingInserted")); return; }
  return beginUpload(files, { kind: "compose", owner });
}
for (const input of document.querySelectorAll(".attach-input")) wirePickerSource(input);
$("#compose-attach").addEventListener("click", openAttach);

// ---------------------------------------------------------------- attachments
// 📎 opens a small menu. A phone offers its camera and gallery (the system
// picker: a file input with `capture` or an `accept` filter), a computer its
// webcam; both offer files and the microphone. The webcam photo and the voice
// recording go through the page (getUserMedia) and wait for "Send" before
// anything is uploaded; every track is stopped when the capture ends or the
// dialog closes, so the camera light goes off. Hidden when the browser lacks
// getUserMedia / MediaRecorder (it needs a secure context: https or localhost).

const RECORDING_MAX_SECONDS = 300;   // a voice note, not a meeting: ~2-3 MB of opus, far below UPLOAD_MAX
const adlg = $("#dlg-attach");
const pickerStatus = document.createElement("section");
pickerStatus.setAttribute("aria-live", "polite");
pickerStatus.style.cssText = "padding:8px;overflow-wrap:anywhere;background:var(--panel);border:1px solid var(--line)";
adlg.after(pickerStatus);
let capActive = null;
const capEl = (id) => $(`#cap-${id}`);

const isPhone = () => matchMedia("(hover: none) and (pointer: coarse)").matches;
const canCapture = () => !!navigator.mediaDevices?.getUserMedia;
const canRecord = () => canCapture() && typeof MediaRecorder !== "undefined";

// `picker`: opens the system file picker (the dialog closes first); otherwise the choice continues in the dialog
function attachChoices() {
  const phone = isPhone();
  return [
    phone && { id: "camera", label: t("attach.camera"), picker: "#camera-input" },
    phone && { id: "gallery", label: t("attach.gallery"), picker: "#gallery-input" },
    { id: "file", label: t("attach.file"), picker: "#file-input" },
    !phone && canCapture() && { id: "webcam", label: t("attach.webcam"), next: startWebcam },
    canRecord() && { id: "mic", label: t("attach.mic"), next: showMicStart },
  ].filter(Boolean);
}

function capturePickerDestination() {
  if (cdlg.open) return composeOwner?.open ? { kind: "compose", owner: composeOwner } : null;
  return captureTerminalDestination(active);
}

function captureTerminalDestination(pane) {
  if (!pane?.conn) return null;
  if (pane.conn.terminal?.limited) { flash(t("terminal.limitedInput")); return null; }
  observePaneActions(pane);
  const target = paneTargets.capture(pane);
  if (!target) return null;
  const binding = paneInput.capture(pane, target);
  if (!binding) { paneTargets.release(target); return null; }
  return { kind: "terminal", pane, target, binding };
}

function releasePickerDestination(destination) {
  if (destination.kind === "terminal") paneTargets.release(destination.target);
}

function retirePickerSource(input) {
  // A reset must not let a late event from the old physical input be mistaken
  // for the next picker. Replacing the actual node preserves native activation
  // from the next user click while its old event listener keeps the old token.
  const replacement = input.cloneNode();
  input.replaceWith(replacement);
  wirePickerSource(replacement);
}

function renderPickerStatus() {
  pickerStatus.replaceChildren();
  const token = pickerGate.pending;
  pickerStatus.hidden = !token;
  if (!token) { renderReloadStatus(); return; }
  const destination = token.destination;
  const original = destination.kind === "compose" ? destination.owner.target : destination.target;
  const text = document.createElement("p");
  text.textContent = t("picker.pending", { target: original.displayName });
  const reset = document.createElement("button");
  reset.type = "button"; reset.textContent = t("picker.reset");
  reset.addEventListener("click", () => resetPendingPicker(token));
  pickerStatus.append(text, reset);
  renderReloadStatus();
}

function resetPendingPicker(token) {
  if (!pickerGate.reset(token)) return false;
  retirePickerSource(token.source);
  releasePickerDestination(token.destination);
  renderPickerStatus();
  flash(t("picker.resetDone"));
  return true;
}

function wirePickerSource(input) {
  const settle = (files) => {
    const token = pickerBySource.get(input);
    if (!token || !pickerGate.settle(token)) return;
    input.value = "";
    retirePickerSource(input);
    renderPickerStatus();
    const destination = token.destination;
    if (!files.length) { releasePickerDestination(destination); return; }
    // The chooser hold is gone before upload starts; upload has its own hold.
    if (destination.kind === "compose") deliverComposeFiles(files, destination.owner);
    else deliverPickedTerminalFiles(files, destination);
  };
  input.addEventListener("change", () => settle([...input.files]));
  input.addEventListener("cancel", () => settle([]));
}

function deliverPickedTerminalFiles(files, destination) {
  return beginUpload(files, destination);
}

function startPicker(input) {
  if (localActionUnavailable()) return;
  if (pickerGate.pending) { flash(t("picker.alreadyOpenReset")); return; }
  const destination = capturePickerDestination();
  if (!destination) { flash(t("picker.noDestination")); return; }
  const token = pickerGate.acquire(input, destination);
  if (!token) { releasePickerDestination(destination); flash(t("picker.alreadyOpen")); return; }
  pickerBySource.set(input, token);
  if (destination.kind === "compose") cdlg.append(pickerStatus);
  else adlg.after(pickerStatus);
  renderPickerStatus();
  adlg.close(); // intentional menu→native-picker handoff, not chooser cancellation
  try { input.click(); }
  catch (error) {
    if (pickerGate.settle(token)) {
      retirePickerSource(input); releasePickerDestination(destination); renderPickerStatus();
      flash(t("picker.failed", { message: error?.message || error }));
    }
  }
}

function openAttach() {
  if (localActionUnavailable()) return;
  if (pickerGate.pending) { flash(t("picker.alreadyOpenChoose")); return; }
  if (adlg.open) return;
  const menu = $("#attach-menu");
  menu.replaceChildren(...attachChoices().map(({ id, label, picker, next }) => {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: label });
    b.dataset.attach = id;
    b.setAttribute("role", "menuitem");
    b.addEventListener("click", () => {
      if (next) {
        const destination = capturePickerDestination();
        if (!destination) { flash(t("capture.noDestination")); return; }
        return next(destination);
      }
      startPicker($(picker));
    });
    return b;
  }));
  showCaptureStep(null);
  adlg.showModal();
  menu.firstElementChild.focus();
}

// which part of the dialog is shown: the menu (step null) or the capture area
function showCaptureStep(step, status = "") {
  $("#attach-menu").hidden = step !== null;
  $("#attach-capture").hidden = step === null;
  $("#attach-title").textContent = step === "webcam" ? t("capture.title.webcam")
    : step === "mic" ? t("capture.title.mic") : t("capture.title.attach");
  capEl("status").textContent = status;
  for (const id of ["video", "image", "audio", "rec", "retry", "main", "send"]) capEl(id).hidden = true;
}

function newCapture(destination) {
  if (capActive) resetCapture(capActive);
  const owner = { destination, stream: null, recorder: null, ticker: null, url: null, file: null,
    revision: destination.kind === "compose" ? destination.owner.revision : null,
    discarded: false, requesting: false, photoPending: false };
  capActive = owner;
  renderReloadStatus();
  return owner;
}
const captureCurrent = (owner) => capActive === owner && adlg.open && !owner.discarded && (
  owner.destination?.kind === "compose"
    ? owner.destination.owner === composeOwner && composeOwner.open && cdlg.open
      && paneTargets.valid(composeOwner.target)
    : !!owner.destination && paneTargets.valid(owner.destination.target));
function stopStream(owner) {
  owner.stream?.getTracks().forEach((track) => track.stop());
  owner.stream = null;
  if (capActive === owner) capEl("video").srcObject = null;
}
function resetCapture(owner = capActive, release = true) {
  if (!owner || owner.discarded) return;
  owner.discarded = true;
  clearInterval(owner.ticker);
  owner.ticker = null;
  if (owner.recorder && owner.recorder.state !== "inactive") {
    try { owner.recorder.stop(); } catch {} // stop can race with the recorder's own final event
  }
  owner.recorder = null;
  stopStream(owner);
  if (owner.url) URL.revokeObjectURL(owner.url);
  owner.url = owner.file = null;
  if (capActive === owner) {
    capActive = null;
    capEl("image").removeAttribute("src");
    capEl("audio").removeAttribute("src");
  }
  if (release && owner.destination) releasePickerDestination(owner.destination);
  owner.destination = null;
  renderReloadStatus();
}
adlg.addEventListener("cancel", () => resetCapture());
adlg.addEventListener("close", () => { if (!adlg.open) { resetCapture(); renderReloadStatus(); } });
capEl("cancel").addEventListener("click", () => { resetCapture(); adlg.close(); });

async function openStream(owner, constraints, step) {
  if (localActionUnavailable()) return;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia(constraints); }
  catch (error) {
    if (captureCurrent(owner)) showCaptureStep(step, t("capture.accessDenied", { error: error.name }));
    else resetCapture(owner);
    return false;
  }
  if (!captureCurrent(owner)) {
    stream.getTracks().forEach((track) => track.stop());
    resetCapture(owner);
    return false;
  }
  owner.stream = stream;
  return true;
}

function setCapMain(label, handler) {
  const b = capEl("main");
  b.textContent = label;
  b.hidden = false;
  b.onclick = handler;
}

const stamp = () => new Date().toISOString().slice(11, 19).replace(/:/g, "");

// ---- webcam photo: preview, "Capture", then the PNG to confirm
async function startWebcam(destination) {
  if (localActionUnavailable()) return;
  const owner = newCapture(destination);
  showCaptureStep("webcam", t("capture.cameraStarting"));
  if (!(await openStream(owner, { video: true }, "webcam"))) return;
  const video = capEl("video");
  video.srcObject = owner.stream;
  video.hidden = false;
  await video.play().catch(() => {});
  if (!captureCurrent(owner)) { resetCapture(owner); return; }
  capEl("status").textContent = t("capture.nothingSentYet");
  setCapMain(t("capture.take"), () => takePhoto(owner));
}

function takePhoto(owner) {
  if (!captureCurrent(owner)) { resetCapture(owner); return; }
  if (owner.photoPending) return;
  const video = capEl("video");
  if (!video.videoWidth) return;
  const canvas = Object.assign(document.createElement("canvas"), { width: video.videoWidth, height: video.videoHeight });
  canvas.getContext("2d").drawImage(video, 0, 0);
  owner.photoPending = true;
  canvas.toBlob((blob) => {
    if (!captureCurrent(owner)) { resetCapture(owner); return; }
    owner.photoPending = false;
    if (!blob) { showCaptureStep("webcam", t("capture.emptyPhoto")); setCapMain(t("capture.take"), () => takePhoto(owner)); return; }
    stopStream(owner);   // the camera light goes off as soon as the picture is taken
    reviewCapture(owner, "webcam", new File([blob], `webcam-${stamp()}.png`, { type: "image/png" }), "image");
  }, "image/png");
}

// the captured file, shown to be confirmed (Send) or redone (Retake)
function reviewCapture(owner, step, file, kind) {
  if (!captureCurrent(owner)) { resetCapture(owner); return; }
  showCaptureStep(step, t("capture.nothingSentYet"));
  owner.file = file;
  owner.url = URL.createObjectURL(file);
  const preview = capEl(kind);
  preview.src = owner.url;
  preview.hidden = false;
  capEl("retry").hidden = capEl("send").hidden = false;
  capEl("retry").onclick = () => {
    if (!captureCurrent(owner)) { resetCapture(owner); return; }
    const destination = owner.destination;
    resetCapture(owner, false);
    if (step === "webcam") startWebcam(destination);
    else showMicStart(destination);
  };
  capEl("send").onclick = () => {
    if (!captureCurrent(owner)) { resetCapture(owner); return; }
    if (!owner.file || !owner.destination) return;
    const sent = owner.file, destination = owner.destination, revision = owner.revision;
    resetCapture(owner, false);
    adlg.close();
    beginUpload([sent], destination, revision);
  };
}

// ---- microphone: "Record" (nothing is listened to before), a visible state, "Stop", then the file to confirm
function showMicStart(destination) {
  const owner = newCapture(destination);
  showCaptureStep("mic", t("capture.micIntro", { minutes: RECORDING_MAX_SECONDS / 60 }));
  setCapMain(t("capture.record"), () => startRecording(owner));
}

async function startRecording(owner) {
  if (localActionUnavailable()) return;
  if (!captureCurrent(owner) || owner.requesting || owner.recorder) return;
  owner.requesting = true;
  showCaptureStep("mic", t("capture.micStarting"));
  if (!(await openStream(owner, { audio: true }, "mic"))) { owner.requesting = false; return; }
  owner.requesting = false;
  const chunks = [];
  let recorder;
  try { recorder = new MediaRecorder(owner.stream); }
  catch (error) {
    stopStream(owner); showCaptureStep("mic", t("capture.recordingUnavailable", { error: error.name }));
    setCapMain(t("capture.record"), () => startRecording(owner)); return;
  }
  owner.recorder = recorder;
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => finishRecording(owner, recorder, chunks);
  try { recorder.start(); }
  catch (error) {
    owner.recorder = null; stopStream(owner);
    showCaptureStep("mic", t("capture.recordingFailed", { error: error.name }));
    setCapMain(t("capture.record"), () => startRecording(owner)); return;
  }
  showCaptureStep("mic", t("capture.recording", { minutes: RECORDING_MAX_SECONDS / 60 }));
  capEl("rec").hidden = false;
  setCapMain(t("capture.stop"),() => { if (captureCurrent(owner) && recorder.state === "recording") recorder.stop(); });
  const started = Date.now();
  const tick = () => {
    if (!captureCurrent(owner)) { resetCapture(owner); return; }
    const seconds = Math.floor((Date.now() - started) / 1000);
    capEl("time").textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    if (seconds >= RECORDING_MAX_SECONDS && recorder.state === "recording") recorder.stop();
  };
  tick();
  owner.ticker = setInterval(tick, 250);
}

function finishRecording(owner, recorder, chunks) {
  clearInterval(owner.ticker);
  owner.ticker = null;
  stopStream(owner);   // the microphone is released as soon as the recording ends
  if (!captureCurrent(owner)) { resetCapture(owner); return; }
  const type = recorder.mimeType || chunks[0]?.type || "audio/webm";
  const blob = new Blob(chunks, { type });
  if (!blob.size) {
    showCaptureStep("mic", t("capture.emptyRecording"));
    setCapMain(t("capture.record"), () => startRecording(owner));
    owner.recorder = null;
    return;
  }
  const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm";
  reviewCapture(owner, "mic", new File([blob], `mic-${stamp()}.${ext}`, { type }), "audio");
}

// ---------------------------------------------------------------- folder dialog
// The touch-friendly way to file and rename a session (no drag and drop on phones).

const fdlg = $("#dlg-folder"), fform = $("#form-folder");
let folderTarget = null, folderPick = null;
function openFolderDialog(id) {
  if (localActionUnavailable()) return;
  const s = find(id);
  if (s?.kind !== "mesh") return;
  folderTarget = id;
  folderPick = s.folder || null;
  fform.reset();
  fform.sessionlabel.value = s.label || "";
  fform.sessionlabel.placeholder = label({ ...s, label: null });
  $("#folder-session").textContent = label(s);
  const opts = [null, ...(data.folders || [])];
  $("#folder-choices").innerHTML = opts.map((f) =>
    `<button type="button" class="btn ${f === folderPick ? "primary" : ""}" data-pick="${esc(f ?? "")}">${f ? "📁 " + esc(f) : esc(t("folderDialog.noFolder"))}</button>`).join("");
  fdlg.showModal();
}
$("#folder-choices").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pick]");
  if (!b) return;
  folderPick = b.dataset.pick || null;
  for (const x of $("#folder-choices").children) x.classList.toggle("primary", x === b);
});
fform.addEventListener("submit", async (e) => {
  e.preventDefault();
  const s = find(folderTarget);
  const fresh = fform.newfolder.value.trim();
  if (fresh && !(await organize({ op: "folder-add", name: fresh }))) return;
  const folder = fresh || folderPick;
  if ((folder || null) !== (s.folder || null)) await organize({ op: "move", id: folderTarget, folder, before: null });
  if (fform.sessionlabel.value.trim() !== (s.label || "")) await organize({ op: "rename", id: folderTarget, label: fform.sessionlabel.value.trim() });
  fdlg.close();
  active?.focus();
});

// ---------------------------------------------------------------- file tree
// A directory clicked in a terminal (or 📂) opens here: folders unfold on
// demand; a file opens in the side panel (rendered for HTML/Markdown, Monaco
// for code), a right click opens a rendered type's source.

const tree = { root: null, parent: null, open: new Set(), cache: new Map(), hidden: store.get("treeHidden", false), sel: null };

async function listDir(path, bases) {
  const r = await requestLocal("/api/ls", { method: "POST", headers: { "Content-Type": "application/json" },
                                     body: JSON.stringify({ path, base: bases?.[0], bases: bases || [] }) });
  if (!r.ok) return { error: serverText(await r.text()), status: r.status };
  const data = await r.json();
  tree.cache.set(data.path, data);
  return data;
}

async function openTree(path, bases) {
  if (localActionUnavailable()) return;
  const data = await listDir(path, bases);
  if (data.error) {
    // not a directory: maybe a file without a known extension (Makefile, LICENSE)
    if (data.status === 404) return openWeb(path, bases);
    return flash(data.error);
  }
  tree.root = data.path;
  tree.parent = data.parent;
  tree.open = new Set([data.path]);
  $("#tree").hidden = false;
  if (narrow()) document.body.classList.add("drawer");
  renderTree();
}

const joinPath = (dir, name) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);
const humanSize = (n) => (n == null ? "" : n < 1024 ? t("units.bytes", { value: n }) : n < 1048576 ? `${(n / 1024).toFixed(0)} k` : `${(n / 1048576).toFixed(1)} M`);

function treeRows(dir, depth) {
  const data = tree.cache.get(dir);
  if (!data) return `<div class="tree-msg" style="padding-left:${8 + depth * 14}px">…</div>`;
  const rows = data.entries.filter((e) => tree.hidden || !e.name.startsWith("."));
  if (!rows.length) return `<div class="tree-msg" style="padding-left:${8 + depth * 14}px">${esc(t("tree.empty"))}</div>`;
  return rows.map((e) => {
    const full = joinPath(dir, e.name);
    const open = e.dir && tree.open.has(full);
    const row = `<button class="tree-row${e.name.startsWith(".") ? " hidden-file" : ""}${tree.sel === full ? " sel" : ""}"
        role="treeitem" data-path="${esc(full)}" data-dir="${e.dir ? 1 : ""}" style="padding-left:${8 + depth * 14}px"
        title="${esc(full)}"><span class="chev">${e.dir ? (open ? "▾" : "▸") : ""}</span>
        <span class="tname">${e.dir ? "📁" : ""} ${esc(e.name)}${e.link ? " ↪" : ""}</span>
        <span class="tsize">${e.dir ? "" : humanSize(e.size)}</span></button>`;
    return row + (open ? treeRows(full, depth + 1) : "");
  }).join("") + (data.truncated ? `<div class="tree-msg">${esc(t("tree.truncated"))}</div>` : "");
}

function renderTree() {
  if (!tree.root) return;
  $("#tree-path").textContent = short(tree.root);
  $("#tree-path").title = tree.root;
  $("#tree-up").disabled = !tree.parent;
  $("#tree-hidden").classList.toggle("on", tree.hidden);
  $("#tree-body").innerHTML = treeRows(tree.root, 0);
}

$("#tree-body").addEventListener("click", async (e) => {
  const row = e.target.closest(".tree-row");
  if (!row) return;
  const path = row.dataset.path;
  tree.sel = path;
  if (row.dataset.dir) {
    if (tree.open.has(path)) tree.open.delete(path);
    else {
      tree.open.add(path);
      renderTree();
      if (!tree.cache.has(path)) { const d = await listDir(path); if (d.error) { tree.open.delete(path); flash(d.error); } }
    }
    return renderTree();
  }
  renderTree();
  document.body.classList.remove("drawer");
  openWeb(path);
});
$("#tree-body").addEventListener("contextmenu", (e) => {
  const row = e.target.closest(".tree-row");
  if (!row || row.dataset.dir) return;
  e.preventDefault();
  tree.sel = row.dataset.path;
  renderTree();
  document.body.classList.remove("drawer");
  openWeb(row.dataset.path, undefined, { source: SOURCE_EXT.test(row.dataset.path) });
});
$("#tree-body").addEventListener("dblclick", (e) => {   // a folder becomes the root
  const row = e.target.closest(".tree-row");
  if (row?.dataset.dir) openTree(row.dataset.path);
});
$("#tree-up").addEventListener("click", () => tree.parent && openTree(tree.parent));
$("#tree-close").addEventListener("click", () => { $("#tree").hidden = true; tree.root = null; });
$("#tree-hidden").addEventListener("click", () => {
  tree.hidden = !tree.hidden;
  store.set("treeHidden", tree.hidden);
  renderTree();
});

// ---------------------------------------------------------------- web dialog

const wdlg = $("#dlg-web"), wform = $("#form-web");
async function openWebDialog() {
  if (localActionUnavailable()) return;
  wform.reset();
  $("#web-err").textContent = "";
  wdlg.showModal();
  wform.target.focus();
  try {
    const docs = await (await requestLocal("/api/docs")).json();
    $("#docs").innerHTML = docs.map((d) => `<option value="${esc(short(d))}">`).join("");
  } catch {}
}
$("#btn-web").addEventListener("click", openWebDialog);
wform.addEventListener("submit", async (e) => {
  e.preventDefault();
  const target = wform.target.value.trim();
  const d = await describeWeb(target, sessionBases(active?.id));
  if (!d) { $("#web-err").textContent = t("webDialog.notFound"); return; }
  wdlg.close();
  openWeb(target, sessionBases(active?.id));
});

// ---------------------------------------------------------------- new session

const dlg = $("#dlg-new"), form = $("#form-new");
let newDialogGeneration = 0;
const currentNewDialog = (generation) => generation === newDialogGeneration && dlg.open && localMeshEffectsAllowed();
let newAccountsReady = false, newAccountsFailed = false;
let newManagedAccountSelection;

const accountRetry = document.createElement("button");
accountRetry.type = "button"; accountRetry.className = "btn ghost sm"; accountRetry.hidden = true;
accountRetry.textContent = t("new.accountRetry");
$("#new-err").after(accountRetry);
let retryAccounts = () => {};
accountRetry.addEventListener("click", () => retryAccounts());
async function openNew() {
  if (localActionUnavailable() || dlg.open) return;
  const generation = ++newDialogGeneration;
  newAccountsFailed = false;
  accountRetry.textContent = t("new.accountRetry");
  accountRetry.hidden = true;
  form.reset();
  $("#new-err").textContent = "";
  // the last kind started (claude by default): what is wanted most of the time
  const last = store.get("preset", "claude");
  for (const r of form.querySelectorAll('[name="preset"]')) r.checked = r.value === last;
  if (!form.preset.value) form.preset.value = "claude";   // a stored kind that no longer exists
  form.command.value = store.get("command", "");
  form.command.hidden = form.preset.value !== "custom";
  form.options.value = "";
  form.optionsDefault.checked = false;
  $("#new-elevation-row").hidden = true;
  form.masterToken.value = "";
  delete dlg.dataset.pendingDefault;
  optionsPreset = null;
  const openButton = form.querySelector('button[value="ok"]');
  if (openButton) openButton.textContent = t("common.open");
  // Ordinary aliases are unknown until discovery, not missing. Only a
  // managed choice needs a provisional selection that cannot become default.
  const storedAccount = store.get("account", "");
  const rememberedAccount = newManagedAccountSelection ?? (typeof storedAccount === "string" ? storedAccount : "");
  const pendingManaged = rememberedAccount.startsWith("managed:");
  newAccounts = [];
  managedOffers = new Map();
  form.account.replaceChildren(new Option(t("new.accountDefault"), ""));
  if (pendingManaged) {
    form.account.add(new Option(t("common.loading"), rememberedAccount));
    form.account.value = rememberedAccount;
  }
  newAccountsReady = false;
  syncAccountChoice();
  syncOptionsRow();
  const cur = active?.id && find(active.id);
  form.cwd.value = short(cur?.cwd || data.home).replace(/^~/, data.home);
  dlg.showModal();
  form.cwd.select();
  folderSuggester.reset();
  Object.assign(folderField, { known: [], roots: [], walked: [], pristine: true, combo: { open: false, active: -1, count: 0 } });
  $("#new-folder-status").textContent = "";
  folderField.known = knownFoldersFrom([], [], []);
  renderFolderList();
  let listed = [], roots = [], recent = [];
  const current = () => currentNewDialog(generation);
  const updateFolders = () => {
    if (!current()) return;
    folderField.roots = roots;
    folderField.known = knownFoldersFrom(listed, roots, recent);
    renderFolderList();
  };
  // Folder migration and suggestions are optional and must not delay account selection.
  const hadRecentFolders = store.get(RECENT_FOLDERS_KEY, null) !== null;
  void moveRecentFoldersToRunner().then(async () => {
    if (!hadRecentFolders || !current()) return;
    const config = await readJson("/api/config", { cache: "no-store" });
    if (!current()) return;
    roots = MeshFolderState.workspaceRoots(config);
    recent = MeshFolderState.runnerRecentFolders(config) || [];
    updateFolders();
  }).catch(() => {});
  void readJson("/api/dirs").then(value => { if (Array.isArray(value)) listed = value; updateFolders(); }).catch(() => {});
  let requestGeneration = 0;
  retryAccounts = async () => {
    const request = ++requestGeneration;
    const keepCurrentSelection = pendingManaged || newAccountsReady;
    newAccountsReady = false; newAccountsFailed = false; accountRetry.hidden = true;
    try {
      const config = await readJson("/api/config", { cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (!current() || request !== requestGeneration) return;
      if (!Array.isArray(config?.accounts) || ("accounts_available" in config && config.accounts_available !== true)) throw new Error();
      rememberLaunchOptions(config.launch);
      fillAccounts(config.accounts, config.managed_profile_offers,
        keepCurrentSelection ? form.account.value : rememberedAccount);
      syncOptionsRow();
      roots = MeshFolderState.workspaceRoots(config);
      recent = MeshFolderState.runnerRecentFolders(config) || [];
      updateFolders();
    } catch {
      if (!current() || request !== requestGeneration) return;
      newAccountsFailed = true;
      $("#new-err").textContent = t("new.accountLoadFailed");
      accountRetry.hidden = false;
    }
  };
  await retryAccounts();
}
window.openNew = openNew;

// The options field belongs to a known agent: "shell" and "custom" have no argv Mesh builds.
// It holds only the arguments of THIS launch; the stored default is shown beside it and is added by
// the server, so an untouched dialog never sends the default twice.
let launchAgentOptions = {};      // preset -> the stored options, as /api/config reports them
let launchOptionsRevision = "";
let optionsPreset = null;         // the preset the field and its hint were last drawn for

function knownAgentPreset(value) {
  return Boolean(value) && value !== "shell" && value !== "custom";
}

function optionsText(preset) {
  const value = launchAgentOptions[preset];
  return typeof value === "string" ? value.trim() : "";
}

function syncOptionsRow() {
  const value = form.preset.value, known = knownAgentPreset(value) && !form.account.value.startsWith("managed:");
  $("#new-options-row").hidden = !known;
  $("#new-options-default-row").hidden = !known;
  $("#new-options-stored").hidden = !known;
  if (!known) { optionsPreset = null; return; }
  $("#new-options-default").textContent = t("new.optionsDefault", { agent: value });
  if (value !== optionsPreset) {
    // Another agent: this launch's field starts empty and the box starts unchecked, because the box
    // asks to make the text in the field the default of THIS agent.
    optionsPreset = value;
    form.optionsDefault.checked = false;
    form.options.value = "";
  }
  const stored = optionsText(value);
  $("#new-options-stored").textContent = stored
    ? t("new.optionsStored", { options: stored })
    : t("new.optionsStoredNone", { agent: value });
}

function rememberLaunchOptions(launch) {
  launchAgentOptions = launch && launch.agent_options && typeof launch.agent_options === "object" ? launch.agent_options : {};
  launchOptionsRevision = launch && typeof launch.agent_options_revision === "string" ? launch.agent_options_revision : "";
}

// Store (or clear) one agent's options. The elevation is asked for here, once, and only when the
// server says it is missing: the token is typed in the dialog and never kept by the page.
async function saveAgentOptions(preset, options, token, generation, revision) {
  const send = () => requestLocal("/api/config/launch-options", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision, agent_options: { [preset]: options } }),
  });
  if (token) {
    const elevated = await requestLocal("/api/config/elevate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    if (!elevated.ok) return { ok: false, error: "wrong-token" };
  }
  if (!currentNewDialog(generation)) return { ok: false, error: "obsolete" };
  const response = await send();
  const body = await response.json().catch(() => ({}));
  if (response.ok) return { ok: true, launch: body.launch };
  return { ok: false, error: String(body.error || response.status), message: typeof body.message === "string" ? body.message : null,
    revision: typeof body.revision === "string" ? body.revision : null };
}

// The "Account" choice: shown when the operator declared launchable profiles on the runner,
// sorted by label (the file's order among equal labels); the last alias chosen on this device is chosen
// again. An alias remembered here but no longer declared stays chosen, greyed, so that the session is refused
// instead of starting under the default account. The page sends an alias id, never a folder.
const ACCOUNT_PRESETS = { claude: "claude", codex: "codex", "codex-yolo": "codex", opencode: "opencode", pi: "pi" };
let newAccounts = [];
let managedOffers = new Map();
function fillAccounts(accounts, managed = [], last = form.account.value) {
  newAccounts = accounts.filter((a) => typeof a?.id === "string" && typeof a?.label === "string")
    .map((a, rank) => ({ ...a, rank }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) || a.rank - b.rank);
  const select = form.account;
  managedOffers = new Map();
  for (const p of Array.isArray(managed) ? managed : []) {
    if (p?.backend !== "codex" || p.managed !== true || p.enabled !== true ||
        typeof p.id !== "string" || !/^p-[a-f0-9]{16}$/.test(p.id) ||
        typeof p.context_revision !== "string" || !/^[a-f0-9]{64}$/.test(p.context_revision) ||
        typeof p.label !== "string") continue;
    managedOffers.set(`managed:${p.backend}:${p.id}`, p);
  }
  const available = managedOffers.has(last) || newAccounts.some((a) => a.id === last);
  const gone = last && !available ? new Option(t("new.accountGoneOption", { id: last }), last) : null;
  if (gone) gone.dataset.gone = "1";
  select.replaceChildren(new Option(t("new.accountDefault"), ""),
    ...newAccounts.map((a) => new Option(shortAccountLabel(a.label), a.id)),
    ...Array.from(managedOffers, ([value, profile]) => new Option(shortAccountLabel(profile.label), value)),
    ...(gone ? [gone] : []));
  select.value = gone || available ? last : "";
  syncAccountChoice();
  newAccountsReady = true;
  if ([t("common.loading"), t("new.accountLoadFailed")].includes($("#new-err").textContent)) $("#new-err").textContent = "";
}
function syncAccountChoice() {
  const agent = ACCOUNT_PRESETS[form.preset.value], offered = form.account.options.length > 1;
  $("#new-account-row").hidden = !offered;
  form.account.disabled = !offered || !agent;
  for (const option of form.account.options) {
    if (option.value.startsWith("managed:")) {
      option.disabled = !managedOffers.has(option.value) || form.preset.value !== "codex";
      continue;
    }
    const account = newAccounts.find((a) => a.id === option.value);
    option.disabled = !!option.value && !!agent && (!!option.dataset.gone || !account?.[agent]);
    if (account) {
      const label = account.backend_labels?.[agent === "opencode" ? "opencode-v2" : agent];
      option.textContent = shortAccountLabel(typeof label === "string" ? label : account.label);
    }
  }
}
// The alias to send: {} for the default account (or an agent without aliases), {id}, or {refused: message} when the
// chosen alias has no folder for this agent or is no longer declared. A greyed option stays selected but FormData
// leaves it out: it must never become the default account silently.
const ACCOUNT_AGENT_NAMES = { claude: "Claude", codex: "Codex", opencode: "OpenCode", pi: "Pi" };
function accountChoice() {
  const agent = ACCOUNT_PRESETS[form.preset.value], option = form.account.selectedOptions[0];
  if (!agent) return {};
  if (option?.value.startsWith("managed:")) {
    const p = managedOffers.get(option.value);
    if (!p || option.disabled || form.preset.value !== "codex") return {refused: t("new.managedProfileRefused")};
    return {managed: {backend: p.backend, id: p.id, context_revision: p.context_revision}, selection: option.value};
  }
  if (form.account.disabled || !agent || !option?.value) return {};
  if (option.dataset.gone) return { refused: t("new.accountGone", { id: option.value }) };
  if (option.disabled) return { refused: t("server.accountNoFolder", { label: option.text, agent: ACCOUNT_AGENT_NAMES[agent] }) };
  return { id: option.value };
}

// The recent folders were kept in this browser before they became a runner setting (recorded by the server when a
// session starts, shared by every device). The list kept here is sent once, then removed from this browser; it is
// also removed when this browser signs out (forgetKnownSessions) and by the sign-in page (static/login.js).
const RECENT_FOLDERS_KEY = "recentFolders";
async function moveRecentFoldersToRunner() {
  const key = `${meshContext?.storagePrefix ?? "mesh"}.${RECENT_FOLDERS_KEY}`;
  if (store.get(RECENT_FOLDERS_KEY, null) === null || !data.home) return;   // ~/x needs the home folder: the copy waits
  const folders = MeshFolderState.recentFoldersToImport(store.get(RECENT_FOLDERS_KEY, null), data.home);
  let status = 200;   // nothing usable to send: the copy goes all the same
  if (folders.length) {
    try {
      status = (await requestLocal("/api/dirs/recent", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folders }) })).status;
    } catch { status = 0; }
  }
  if (MeshFolderState.recentImportOutcome(status) === "clear") try { localStorage.removeItem(key); } catch {}
}

// The folder field is a combobox. Its list: while an absolute or ~/ path is typed, the sub-folders of the folder typed
// up to its last "/" (the file tree's listing, POST /api/ls), then the known folders ranked for the text: the allowed
// work folders (GET /api/config), the runner's recent folders (same answer), the folders of the open sessions, and
// GET /api/dirs (the allowed folders' sub-folders). It opens on a click, a tap or a focus; Tab completes (tabKey).
// static/folder-suggest.ts holds the logic; this is the page side. Text only: no markup is built from a path.
const folderList = $("#new-folder-list");
const folderField = { known: [], roots: [], walked: [], shown: [], pristine: true, combo: { open: false, active: -1, count: 0 } };
const sessionFolders = () => [...new Set((data.mesh || []).map((s) => s.cwd).filter(Boolean))];
async function readJson(url, options) {
  const response = await requestLocal(url, options);
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}
const knownFoldersFrom = (listed, roots, recent) => MeshFolderState.knownFolderList({ roots, recent,
  sessions: sessionFolders(), listed: listed.filter((d) => typeof d === "string") }, data.home);
function renderFolderList() {
  const typed = folderField.pristine ? "" : form.cwd.value;   // the folder the dialog opened with: the whole known list
  folderField.shown = MeshFolderState.folderSuggestions(typed, folderField.known, folderField.walked, folderField.roots, data.home);
  const count = folderField.shown.length;
  // open: wanted open, shown once there is an option; a new list has no chosen option (its index would name another folder)
  folderField.combo = { open: folderField.combo.open, active: -1, count };
  folderList.replaceChildren(...folderField.shown.map((folder, index) => {
    const option = document.createElement("li");
    option.id = `new-folder-${index}`;
    option.setAttribute("role", "option");
    option.dataset.index = String(index);
    option.textContent = folder;
    return option;
  }));
  syncFolderList();
}
function syncFolderList() {
  const { active: chosen } = folderField.combo;
  const open = folderField.combo.open && folderField.combo.count > 0;
  folderList.hidden = !open;
  form.cwd.setAttribute("aria-expanded", String(open));
  for (const option of folderList.children) option.setAttribute("aria-selected", String(option.dataset.index === String(chosen)));
  if (open && chosen >= 0) {
    form.cwd.setAttribute("aria-activedescendant", `new-folder-${chosen}`);
    folderList.children[chosen]?.scrollIntoView({ block: "nearest" });
  } else form.cwd.removeAttribute("aria-activedescendant");
}
function acceptFolder(index) {
  const folder = folderField.shown[index];
  if (folder === undefined) return;
  form.cwd.value = folder;   // type "/" next to go one level down
  folderField.pristine = false;
  folderField.combo = { ...folderField.combo, open: false, active: -1 };
  syncFolderList();
}
function openFolderList() {
  folderField.combo = { ...folderField.combo, open: true };   // also before the known folders arrive
  syncFolderList();
}
async function listFolderForSuggestions(path, signal) {
  const r = await requestLocal("/api/ls", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }), signal });
  return r.ok ? r.json() : null;
}
const folderSuggester = MeshFolderState.createFolderSuggester({ listFolder: listFolderForSuggestions,
  onSuggestions: (walked) => { folderField.walked = walked; renderFolderList(); },
  createAbort: () => new AbortController(),
  setTimer: (callback, ms) => setTimeout(callback, ms), clearTimer: (handle) => clearTimeout(handle) });
form.cwd.addEventListener("input", () => {
  folderField.pristine = false;
  folderField.combo = { open: true, active: -1, count: folderField.combo.count };
  renderFolderList();
  folderSuggester.input(form.cwd.value);
});
form.cwd.addEventListener("keydown", (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;   // Shift+Tab moves back as always
  const action = e.key === "Tab"
    ? MeshFolderState.tabKey(folderField.combo, { suggestions: folderField.shown, value: form.cwd.value, typed: !folderField.pristine, home: data.home })
    : MeshFolderState.comboboxKey(folderField.combo, e.key);
  folderField.combo = action.state;
  if (action.accept !== null) acceptFolder(action.accept);
  if (action.accept !== null && e.key === "Tab") $("#new-folder-status").textContent = t("new.folderCompleted", { folder: form.cwd.value });
  syncFolderList();
  if (action.handled) { e.preventDefault(); e.stopPropagation(); }   // Escape closes the list, not the dialog
});
form.cwd.addEventListener("click", openFolderList);   // a tap on a phone shows the list
form.cwd.addEventListener("focus", openFolderList);   // and so does reaching the field with Tab (openNew closes it at first)
form.cwd.addEventListener("blur", () => { folderField.combo = { ...folderField.combo, open: false, active: -1 }; syncFolderList(); });
folderList.addEventListener("mousedown", (e) => e.preventDefault());   // the field keeps the focus (a tap too)
folderList.addEventListener("click", (e) => {
  const option = e.target.closest('[role="option"]');
  if (option) acceptFolder(Number(option.dataset.index));
});
dlg.addEventListener("close", () => { if (!dlg.open) { newAccountsReady = false; folderSuggester.reset(); } });
$("#btn-new").addEventListener("click", () => { if (projecting) projectsController?.create(); else openNew(); });
form.account.addEventListener("change", () => {
  newManagedAccountSelection = form.account.value.startsWith("managed:") ? form.account.value : undefined;
});
form.addEventListener("change", () => { form.command.hidden = form.preset.value !== "custom"; syncOptionsRow(); syncAccountChoice(); });
let newSubmitGeneration = null;   // one submission per opening; an old completion cannot unlock a newer one

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const generation = newDialogGeneration;
  if (!currentNewDialog(generation) || newSubmitGeneration === generation) return;
  newSubmitGeneration = generation;
  try {
    await submitNew(generation);
  } finally {
    if (newSubmitGeneration === generation) newSubmitGeneration = null;
  }
});

async function submitNew(generation) {
  // A session was already started and only its default is left to store: this click finishes that,
  // and never starts a second session.
  const pending = dlg.dataset.pendingDefault ? JSON.parse(dlg.dataset.pendingDefault) : null;
  if (pending) {
    if (pending.close) {
      delete dlg.dataset.pendingDefault; dlg.close();
      await refresh();
      if (generation === newDialogGeneration) showCreatedSession(pending.id);
      return;
    }
    const token = form.masterToken.value;
    form.masterToken.value = "";
    if (!token) { $("#new-err").textContent = t("new.optionsCancelled"); return; }
    const saved = await saveAgentOptions(pending.preset, pending.options, token, generation, launchOptionsRevision)
      .catch(() => ({ ok: false, error: t("config.launch.err.network") }));
    if (!currentNewDialog(generation)) { await refresh(); return; }
    if (!saved.ok) {
      if (saved.error === "stale-revision") launchOptionsRevision = saved.revision ?? launchOptionsRevision;
      $("#new-err").textContent = saved.error === "wrong-token"
        ? t("config.launch.err.wrongToken") : t("new.optionsNotSaved", { message: saved.message || saved.error });
      return;
    }
    rememberLaunchOptions(saved.launch);
    delete dlg.dataset.pendingDefault;
    dlg.close();
    await refresh();
    if (generation === newDialogGeneration) showCreatedSession(pending.id);
    return;
  }
  if (ACCOUNT_PRESETS[form.preset.value] && !newAccountsReady
      && (form.preset.value !== "pi" || form.account.value || store.get("account", ""))) {
    $("#new-err").textContent = t(newAccountsFailed ? "new.accountLoadFailed" : "common.loading");
    return;
  }
  const body = Object.fromEntries(new FormData(form));
  const saveDefault = form.optionsDefault.checked && knownAgentPreset(body.preset);
  const optionsRevision = launchOptionsRevision;
  const accountSelected = !form.account.disabled;
  delete body.account;   // "" for the default account: the server takes an alias id or nothing
  delete body.masterToken;
  delete body.optionsDefault;
  if (!knownAgentPreset(body.preset)) delete body.options;   // hidden for shell and other: never sent
  const account = accountChoice();
  if (account.refused) { $("#new-err").textContent = account.refused; return; }
  if (account.id) body.account = account.id;
  if (account.managed) {
    delete body.command;
    delete body.options;
    body.managed_profile = account.managed;
  }
  const r = await requestLocal("/api/new", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) {
    const error = serverText(await r.text());
    if (currentNewDialog(generation)) $("#new-err").textContent = error;
    return;
  }
  const { id } = await r.json();
  if (!currentNewDialog(generation)) { await refresh(); return; }
  store.set("preset", body.preset);
  if (accountSelected) {
    store.set("account", account.selection || body.account || "");
    newManagedAccountSelection = undefined;
  }
  if (body.preset === "custom") store.set("command", body.command || "");   // the folder: recorded by the server
  // The session is started whatever happens next: a default that cannot be stored never blocks it.
  const wanted = saveDefault && !account.managed
    ? { preset: body.preset, options: body.options || "", id } : null;
  if (wanted) {
    const saved = await saveAgentOptions(wanted.preset, wanted.options, undefined, generation, optionsRevision)
      .catch(() => ({ ok: false, error: t("config.launch.err.network") }));
    if (!currentNewDialog(generation)) { await refresh(); return; }
    if (!saved.ok) {
      if (saved.error === "elevation-required") {
        $("#new-elevation-row").hidden = false;
        dlg.dataset.pendingDefault = JSON.stringify(wanted);
        const saveButton = form.querySelector('button[value="ok"]');
        if (saveButton) saveButton.textContent = t("new.optionsSaveDefault");
        $("#new-err").textContent = t("new.optionsNotSaved", { message: t("config.launch.err.expired") });
        form.masterToken.focus();
        return;   // the dialog stays open: the next click stores the default, with the token
      }
      if (saved.error === "stale-revision") launchOptionsRevision = saved.revision ?? launchOptionsRevision;
      $("#new-err").textContent = t("new.optionsNotSaved", { message: saved.message || saved.error });
      dlg.dataset.pendingDefault = JSON.stringify({ close: true, id });   // the next click opens the existing session
      return;
    }
    rememberLaunchOptions(saved.launch);
  }
  dlg.close();
  await refresh();
  if (generation === newDialogGeneration) showCreatedSession(id);
}

function showCreatedSession(id) {
  if (flowing) setFlow(false);
  document.body.classList.remove("drawer");
  active.show(id, false, { focusTerminal: true });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && projecting && !document.querySelector("dialog[open]")) { e.preventDefault(); return setProjects(false); }
  if (e.key === "Escape" && exploring && !document.querySelector("dialog[open]")) { e.preventDefault(); return setExplorer(false); }
  if (e.key === "Escape" && managing && !document.querySelector("dialog[open]")) { e.preventDefault(); return setManagement(false); }
  if (e.key === "Escape" && flowing && !document.querySelector("dialog[open]")) { e.preventDefault(); return setFlow(false); }
  if (e.ctrlKey || e.metaKey || e.altKey || document.activeElement !== document.body) return;
  if (e.key === "n") { e.preventDefault(); if (projecting) projectsController?.create(); else openNew(); }
  if (e.key === "o") { e.preventDefault(); openWebDialog(); }
});

// ---- keyboard shortcuts
// The table, its policy and the pure resolution are static/shortcuts.ts. This is the page side: what the
// focus is, one capture-phase listener that runs the action a key resolves to (and touches nothing else,
// so every other key reaches its target unchanged), and the actions. The terminal asks the same table
// from its key handler (see attachCustomKeyEventHandler).

const shortcutPlatform = MeshShortcuts.detectPlatform(navigator.platform);

function shortcutFocusKind(target) {
  if (document.querySelector("dialog[open]")) return "modal";
  if (!(target instanceof Element)) return "page";
  if (target.closest(".xterm")) return "terminal"; // shortcut focus: terminal
  if (target.closest("#line")) return "direct-line";
  if (target.closest("input, textarea, select, [contenteditable]") || target.isContentEditable) return "field";
  return "page";
}

let sessionSearchReturn = null;   // where the focus was, and whether the search opened the drawer

function openSessionSearch() {
  const from = document.activeElement;
  if (projecting) setProjects(false);
  const box = exploring ? $("#ex-q") : $("#filter");
  const openedDrawer = !exploring && narrow() && !document.body.classList.contains("drawer");
  if (!exploring && narrow()) document.body.classList.add("drawer");
  syncMobileChrome();
  sessionSearchReturn = { from: from && from !== document.body && from !== box ? from : null, drawer: openedDrawer };
  box.focus();
  box.select();
}

$("#filter").addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !sessionSearchReturn) return;
  e.preventDefault();
  e.stopPropagation();
  const { from, drawer } = sessionSearchReturn;
  sessionSearchReturn = null;
  if (drawer) { document.body.classList.remove("drawer"); syncMobileChrome(); }
  if (from?.isConnected) from.focus();
  else active?.focus();
});
$("#filter").addEventListener("blur", () => { sessionSearchReturn = null; });

function openShortcutHelp() {
  const list = $("#shortcuts-list");
  list.replaceChildren(...MeshShortcuts.helpEntries(MeshShortcuts.SHORTCUTS, shortcutPlatform).map((entry) => {
    const row = document.createElement("div");
    row.className = "shortcut-row";
    row.dataset.shortcut = entry.id;
    const keys = document.createElement("kbd");
    keys.textContent = entry.keys;
    const label = document.createElement("span");
    label.textContent = t(`shortcuts.${entry.id}`);
    const where = document.createElement("small");
    where.className = "mute";
    where.textContent = t(`shortcuts.context.${entry.context}`);
    row.append(keys, label, where);
    return row;
  }));
  $("#dlg-shortcuts").showModal();
}
$("#btn-shortcuts").addEventListener("click", openShortcutHelp);

// "Copy as shell command" (opt-in; the usual copy is unchanged). The rewrite is MeshTerminalLinks.shellCommandOfSelection;
// where the rows cannot be rebuilt it returns null and the selection is copied as it is.
async function copySelectionAsShell() {
  const pane = active;
  const sel = pane && (pane.term.getSelection() || pane.mobileSelection);
  if (!sel) return;   // nothing selected: silent, like copySelection()
  try {
    const rewritten = pane.term.hasSelection() ? MeshTerminalLinks.shellCommandOfSelection(pane.term) : null;
    await navigator.clipboard.writeText(rewritten ?? sel);
    flash(t("clipboard.copied"));
  } catch { flash(t("clipboard.copyDenied")); }
  pane.term.clearSelection();
  pane.mobileSelection = "";
}

const SHORTCUT_ACTIONS = { "sessions.search": openSessionSearch, "shortcuts.help": openShortcutHelp, "terminal.copyAsShell": copySelectionAsShell };

document.addEventListener("keydown", (e) => {
  const binding = MeshShortcuts.resolve(MeshShortcuts.SHORTCUTS, e, shortcutFocusKind(e.target), shortcutPlatform);
  if (!binding) return;
  e.preventDefault();
  e.stopPropagation(); // shortcut: the program never sees it
  SHORTCUT_ACTIONS[binding.action]();
}, true);

// ---------------------------------------------------------------- boot

// Service worker registration belongs to explicit local startup below.

// ---- push notifications
// 🔔 subscribes this browser (the server then notifies it when an agent waits or
// finishes, mesh closed or not), 🔕 unsubscribes it. A tap on a notification
// opens the mesh on that session (sw.js).

const pushBtn = $("#btn-push");
const pushDetailRow = $("#push-detail-row"), pushDetailBox = $("#push-detail");
let pushDetail = false;   // this device's choice: the detailed notification (agent text, command, choices); minimal by default
const pushSupported = () => localMeshEffectsAllowed() && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
async function currentSub() {
  requireLocalMesh();
  const reg = await navigator.serviceWorker.getRegistration("/");
  return reg ? reg.pushManager.getSubscription() : null;
}
// At launch, a subscription this browser holds is re-registered: the server may
// have dropped it (device limit, refused by the push service) or changed keys,
// and the 🔔 would otherwise stay on with nothing arriving.
async function syncPush() {
  if (!pushSupported()) return;
  try {
    const sub = await currentSub();
    if (!sub) return;
    const k = await (await requestLocal("/api/push/key")).json();
    const mine = sub.options.applicationServerKey;
    const same = k.available && mine && btoa(String.fromCharCode(...new Uint8Array(mine))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === k.key;
    if (!k.available) return;
    let current = sub;
    if (!same) {
      if (Notification.permission !== "granted") return;   // renewing needs it: leave it for a tap on 🔕/🔔
      await requestLocal("/api/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
      await sub.unsubscribe();
      current = await (await navigator.serviceWorker.ready).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(k.key) });
    }
    const r = await requestLocal("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription: current.toJSON() }) });
    if (r.ok) pushDetail = (await r.json()).detail === true;   // the server's record of this device's choice
  } catch {}
}
async function renderPush() {
  if (!pushSupported()) return;
  const sub = await currentSub().catch(() => null);
  pushBtn.hidden = false;
  pushDetailRow.hidden = !sub;
  pushDetailBox.checked = pushDetail;
  pushBtn.textContent = sub ? "🔔" : "🔕";
  pushBtn.title = sub ? t("push.titleOn") : t("push.titleOff");
}
const b64uBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
async function togglePush() {
  if (localActionUnavailable()) return;
  const post = (url, body) => requestLocal(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const sub = await currentSub();
    if (sub) {
      await post("/api/push/unsubscribe", { endpoint: sub.endpoint });
      await sub.unsubscribe();
      flash(t("push.disabled"));
      return;
    }
    const k = await (await requestLocal("/api/push/key")).json();
    if (!k.available) return flash(t("push.serverUnavailable"));
    if (await Notification.requestPermission() !== "granted") return flash(t("push.denied"));
    const reg = await navigator.serviceWorker.ready;
    const fresh = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(k.key) });
    const r = await post("/api/push/subscribe", { subscription: fresh.toJSON(), test: true });
    if (!r.ok) { await fresh.unsubscribe(); throw new Error(serverText(await r.text())); }
    pushDetail = (await r.json()).detail === true;
    flash(t("push.enabled"));
  } catch (e) {
    flash(t("push.error", { message: e.message }));
  } finally { renderPush(); }
}
pushBtn.addEventListener("click", togglePush);
pushDetailBox.addEventListener("change", async () => {
  const wanted = pushDetailBox.checked;
  try {
    const sub = await currentSub();
    if (!sub) throw new Error(t("push.notSubscribed"));
    const r = await requestLocal("/api/push/detail", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint, detail: wanted }) });
    if (!r.ok) throw new Error(serverText(await r.text()));
    pushDetail = wanted;
    flash(wanted ? t("push.detailed") : t("push.minimal"));
  } catch (e) { flash(t("push.error", { message: e.message })); }
  renderPush();
});

// a notification tapped while the mesh is open
async function handleLocalServiceWorkerMessage(e) {
  if (!localMeshEffectsAllowed()) return;
  if (e.data?.type !== "open" || typeof e.data.id !== "string") return;
  if (!find(e.data.id)) await refresh();
  if (find(e.data.id)) openSession(e.data.id);
}

async function restorePane(p, w) {
  if (w.grow) p.group.el.style.flexGrow = w.grow;
  if (w.back && find(w.back)) p.back = w.back;
  if (w.unavailable) { p.showUnavailable(w.unavailable, w.target, w.type); return; }
  const target = w.target ?? w.id;
  if (!localMeshEffectsAllowed()) return;
  if (isWebPane(target)) {
    const source = target.endsWith("#source");
    const d = await describeWeb(target.slice(4).replace(/#source$/, ""));
    if (d) p.show(source ? sourceEntry(d).id : d.id);
  }
  if (isBoardPane(target)) {
    const board = boardEntry(target.slice(6));
    if (board) p.show(board.id);
  }
}

function savedWorkspace() {
  let value = MeshWorkspaceSpec.readV2(store.get("workspace.v2", null));
  if (!value) {
    value = MeshWorkspaceSpec.migrateV1(store.get("workspace.v1", null));
    if (value) store.set("workspace.v2", value);
  }
  if (!value) return null;
  return MeshWorkspaceSpec.reconcile(value, (target) => {
    if (!localMeshEffectsAllowed()) return find(target)?.kind === "mesh";
    if (isHist(target) || isWebPane(target)) return true;
    if (isBoardPane(target)) return data.mesh.some((session) => session.id === target.slice(6));
    return !!find(target);
  });
}

// A malformed escape in a link's hash (#%E0%A4%A) names no pane: it is dropped, and the page
// starts with the rest instead of stopping on a URIError.
function hashPaneIds(hash) {
  return hash.slice(1).split(",").map((part) => {
    try { return decodeURIComponent(part); } catch { return ""; }
  });
}

// The sessions shown before the server's first answer: this device's last listing, plus the mesh
// sessions its saved layout names (a terminal attaches by name alone: /ws/{name}; a board names the
// session it belongs to).
function layoutSessionNames() {
  const v2 = MeshWorkspaceSpec.readV2(store.get("workspace.v2", null));
  const targets = [...(v2?.columns ?? []).flatMap((column) => column.tabs.map((tab) => tab.target)),
    ...store.get("layout", []).map((w) => w?.id), ...hashPaneIds(location.hash)];
  return targets.map((id) => (isBoardPane(id) ? id.slice(6) : id))
    .filter((id) => typeof id === "string" && id && !isAdjacentPane(id) && !isHist(id) && !/^t\d+$/.test(id));
}
function showKnownSessions() {
  data = Progress.provisionalListing(Progress.readKnown(store.get(KNOWN_KEY, null)), layoutSessionNames());
}

// Returns once the saved panes are restored, with the first listing still on its way: terminals attach
// without waiting for it (`firstListing` settles when it has been applied or has failed).
// The panes a link's hash names, or null. A link can carry any hash: a document pane in it must name
// an absolute path or be in this browser's own layout (a crafted #web:https://… link opens nothing;
// /api/view refuses web pages in any case).
function hashWantedPanes(saved) {
  const known = new Set(saved.map((w) => w.id));
  const fromHash = hashPaneIds(location.hash)
    .filter((id) => localMeshEffectsAllowed() || find(id)?.kind === "mesh")
    .filter((id) => !isWebPane(id) || id.startsWith("web:/") || known.has(id))
    .filter((id) => !isDemoPane(id))
    .filter((id) => !isBoardPane(id) || !!data.mesh.find((s) => s.id === id.slice(6)));
  return fromHash.some(Boolean) ? fromHash.map((id) => ({ id, back: saved.find((w) => w.id === id)?.back })) : null;
}

// Restores the saved columns and tabs in order (or the flat list of a link or an older layout). Each
// pane restored to a session the server has not listed yet is marked provisional at once.
async function restoreSavedPanes(workspace, flatList) {
  const unlisted = new Set(data.mesh.filter((s) => s.provisional).map((s) => s.id));
  if (!workspace) {
    const flat = flatList.slice(0, narrow() ? 1 : MAX_PANES);
    if (!flat.length) flat.push({ id: null });
    for (const w of flat) {
      const p = addPane(isAdjacentPane(w.id) ? null : w.id);
      await restorePane(p, w);
      markProvisional(p, unlisted);
    }
    return;
  }
  for (const column of workspace.columns) {
    const [first, ...rest] = column.tabs;
    const p = addPane(isAdjacentPane(first.target) ? null : first.target);
    if (!p) break;
    await restorePane(p, { ...first, grow: column.grow });
    markProvisional(p, unlisted);
    for (const tab of rest) {
      const q = addTab(p.group, isAdjacentPane(tab.target) ? null : tab.target);
      await restorePane(q, tab);
      markProvisional(q, unlisted);
    }
    p.group.select(p.group.tabs[Math.max(0, Math.min(p.group.tabs.length - 1, column.active || 0))], false);
  }
}

async function bootMesh() {
  showKnownSessions();
  setTab(tab);
  const firstListing = startInventory(meshContext);
  restoringWorkspace = true;
  // restore columns: from the URL hash (shareable) or the last layout
  const saved = store.get("layout", []);
  const wanted = hashWantedPanes(saved);
  const workspace = wanted && location.hash !== store.get("workspace.hash", null) ? null : savedWorkspace();
  await restoreSavedPanes(workspace, wanted || saved);
  layout();   // apply (and normalize) the restored widths
  const initial = (workspace?.active && workspaceGroups[workspace.active.column]?.tabs[workspace.active.tab]) || workspaceGroups[0]?.selected || panes[0];
  setActive(initial);
  restoringWorkspace = false;
  consumeOpens();   // requests to open a pane that arrived during the restore
  // opened from a notification: that session (once listed, if it was not known here)
  const opened = new URLSearchParams(location.search).get("open");
  if (opened) {
    history.replaceState(null, "", (localMeshEffectsAllowed() ? "/" : location.pathname) + location.hash);
    if (find(opened)) openSession(opened);
    else void firstListing.then(() => { if (find(opened)) openSession(opened); });
  }
  if (localMeshEffectsAllowed()) syncPush().finally(renderPush);
  return { firstListing };
}

function startLocalMesh() {
  const started = startMesh({ inventory: loadLocalInventory, storagePrefix: "mesh" });
  // the first page load after an update moves this browser's recent folders, before any sign-in page can drop them
  void started.then(moveRecentFoldersToRunner).catch(() => {});   // resolved once the first listing gave the home folder
  return started;
}

// The language setting (footer): the browser's language, or a forced one kept in
// this browser. A change reloads the catalogs, then the page, which rebuilds every
// text from them; the workspace is restored as on any reload.
whenTranslated(() => {
  MeshPaneActions.setTranslator(t);
  MeshDemoCatalog.setTranslator(t);
  const select = $("#lang-select");
  const auto = new Option(t("foot.languageAuto"), "");
  const offered = Object.entries(MeshI18n.languages).map(([code, name]) => new Option(name, code));
  select.replaceChildren(auto, ...offered);
  select.value = MeshI18n.preference() ?? "";
  select.addEventListener("change", async () => {
    if (!localMeshEffectsAllowed()) return;
    await MeshI18n.use(select.value || null);
    location.reload();
  });
});

// The colour theme (footer) and the custom palette (its own dialog), kept in this browser.
// static/themes.js applied both before the first paint; a change here or in another tab of this
// browser repaints the page and every open terminal at once, without a reload.
const PALETTE_OPTION = "palette";
meshThemes()?.runtime.onChange((colours) => {
  const theme = meshThemes().terminalTheme(colours);
  for (const pane of panes) if (pane.term) pane.term.options.theme = theme;
});

function renderThemeSelect(select) {
  const themes = meshThemes().runtime;
  const custom = Object.keys(themes.palette()).length > 0;
  const options = meshThemes().THEMES.map(({ id }) => {
    const name = t(meshThemes().themeLabelKey(id));
    return new Option(custom && id === themes.current() ? t("theme.withPalette", { name }) : name, id);
  });
  select.replaceChildren(...options, new Option(t("theme.customize"), PALETTE_OPTION));
  select.value = themes.current();
}

function paletteErrorText(result) {
  if (result.reason === "not-json") return t("theme.paletteNotJson");
  if (result.reason === "not-an-object") return t("theme.paletteNotObject");
  return result.errors.slice(0, 5).map(({ key, reason }) =>
    t(reason === "unknown-variable" ? "theme.paletteUnknown" : "theme.paletteNotColour", { key })).join(" · ");
}

function paletteStatusText(saved) {
  const themes = meshThemes().runtime;
  const count = Object.keys(themes.palette()).length;
  if (!saved) return t("theme.paletteNotSaved");
  if (!count) return t("theme.paletteCleared");
  const colours = themes.colours();
  const ratios = ["--bg", "--term", "--panel"].map((surface) => meshThemes().contrastRatio(colours["--fg"], colours[surface]));
  // NaN: a translucent background, whose contrast depends on what shows through it. A failure
  // measured on another surface is still reported.
  const measured = ratios.filter(Number.isFinite);
  const ratio = Math.min(...measured);
  const notes = [t("theme.paletteApplied", { n: count })];
  // Rounded down, so a failing 4.49 never reads as the 4.5 it misses.
  if (ratio < 4.5) notes.push(t("theme.paletteLowContrast", { ratio: fmtFixed(Math.floor(ratio * 10) / 10, 1) }));
  if (measured.length < ratios.length) notes.push(t("theme.paletteContrastUnknown"));
  return notes.join(" ");
}

function setupPaletteEditor() {
  const themes = meshThemes().runtime;
  const text = $("#palette-text");
  const status = $("#palette-status");
  const report = (message, bad) => { status.textContent = message; status.classList.toggle("bad", bad); };
  // Only a JSON or validation error marks the field invalid (not a storage refusal).
  const markInvalid = (invalid) => {
    if (invalid) { text.setAttribute("aria-invalid", "true"); text.setAttribute("aria-errormessage", "palette-status"); }
    else { text.removeAttribute("aria-invalid"); text.removeAttribute("aria-errormessage"); }
  };
  // The text last written from the saved palette: a change from another tab refreshes the field
  // only while it still holds that text, so an unsaved draft is never replaced.
  let rendered = "";
  const show = () => { rendered = meshThemes().formatPalette(themes.palette()); text.value = rendered; };
  // A status about the palette the field held no longer applies once another one replaces it.
  const refresh = () => {
    if (text.value !== rendered || meshThemes().formatPalette(themes.palette()) === rendered) return;
    show();
    report("", false);
  };
  // Each variable name is its own <code>, never broken across lines.
  const hint = $("#palette-hint");
  hint.textContent = t("theme.paletteHint", { names: "" });
  hint.append(...meshThemes().VARIABLES.flatMap((name, i) => {
    const code = document.createElement("code");
    code.textContent = name;
    return i ? [" ", code] : [code];
  }));
  show();
  $("#palette-apply").addEventListener("click", () => {
    const result = meshThemes().parsePalette(text.value);
    markInvalid(!result.ok);
    if (!result.ok) return report(paletteErrorText(result), true);
    const saved = themes.setPalette(result.palette);
    show();
    report(paletteStatusText(saved), !saved);
  });
  $("#palette-reset").addEventListener("click", () => {
    const saved = themes.setPalette({});
    markInvalid(false);
    show();
    report(paletteStatusText(saved), !saved);
  });
  $("#palette-fill").addEventListener("click", () => {
    text.value = meshThemes().formatPalette(themes.colours());
    markInvalid(false);
    text.focus();
  });
  return refresh;
}

whenTranslated(() => {
  const select = $("#theme-select");
  // Without static/themes.js only the default look exists: there is nothing to choose.
  if (!meshThemes()) { select.hidden = true; return; }
  const refreshPalette = setupPaletteEditor();
  renderThemeSelect(select);
  meshThemes().runtime.onChange(() => { renderThemeSelect(select); refreshPalette(); });
  // The arrow keys change a closed <select> at once. A change made by a key press on the select
  // itself only browses: passing over "Custom palette…" does not open the dialog. Choosing that
  // entry from the open list (pointer, or Enter in the list) does.
  let browsing = false;
  select.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") return;
    browsing = true;
    setTimeout(() => { browsing = false; }, 0);
  });
  select.addEventListener("change", () => {
    if (select.value !== PALETTE_OPTION) {
      // Applied either way; a refused write only means the next load forgets it.
      if (!meshThemes().runtime.use(select.value)) flashLong(t("theme.notSaved"));
      return;
    }
    select.value = meshThemes().runtime.current();
    if (browsing) return;
    const dialog = $("#dlg-palette");
    if (!dialog.open) dialog.showModal();
    $("#palette-text").focus();
  });
});

async function startMesh(context) {
  if (meshContext !== null) throw new Error("Mesh already started");
  meshContext = Object.freeze(context);
  await MeshI18n.ready;
  for (const init of translatedInits.splice(0)) init();
  // All eager store reads above used defaults while pending. Hydrate only the
  // selected namespace, before workspace/panes or any selected-context effect.
  fontSize = store.get("font", touch ? 12 : 13.5);
  folded.clear();
  for (const id of store.get("folded", [])) folded.add(id);
  for (const key of Object.keys(seen)) delete seen[key];
  Object.assign(seen, store.get("seen", {}) || {});
  seenSince = store.get("seenSince", null);
  tab = store.get("tab", "live");
  Object.assign(hf, histFilterDefaults(), store.get("hfilter", {}));
  tree.hidden = store.get("treeHidden", false);
  document.documentElement.style.setProperty("--side", `${store.get("side", 320)}px`);
  initializeLocalInputTab();
  startInlineDictation();
  sessionRequestTab = sessionRequestTabNonce();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  navigator.serviceWorker?.addEventListener("message", handleLocalServiceWorkerMessage);
  for (const button of document.querySelectorAll("[data-close-dialog]")) {
    button.addEventListener("click", () => {
      if (meshContext && !meshStopped) button.closest("dialog")?.close();
    });
  }
  // Notification links explicitly target Sessions. An ordinary reload keeps
  // the current primary view, independently of the saved terminal layout.
  const openFromNotification = new URLSearchParams(location.search).has("open");
  const restoreProjects = store.get("primaryView", "sessions") === "projects";
  const { firstListing } = await bootMesh();
  if (!meshStopped && localMeshEffectsAllowed() && restoreProjects && !openFromNotification) setProjects(true);
  await firstListing;
  return Object.freeze({
    refresh,
    dispose: disposeLocalPage,
  });
}

globalThis.MeshUI = Object.freeze({ startLocalMesh, forgetKnownSessions });
window.addEventListener("pagehide", (event) => {
  if (event.persisted && !meshPageFinal) suspendLocalPage();
  else disposeLocalPage();
});
window.addEventListener("pageshow", (event) => {if (event.persisted) void resumeLocalPage();});
// Cached focus must not overtake a choice made while inventory or the socket waited.
document.addEventListener("focusin", () => { meshCacheFocusRevision++; });
function retirePageInput(preserveDraft = false) {
  if (preserveDraft && composeOwner?.open && !composeOwner.pending && cdlg.open && ctext.value) {
    const pane = composeOwner.target.pane;
    const draft = pane.recoveredComposeOwner === composeOwner ? pane.recoveredComposeDraft : null;
    composeRecovery.push({target: composeOwner.target, text: ctext.value,
      ...(draft?.entry ? {entry: draft.entry} : {}),
      result: {kind: "refused", frames: 0, wireBytes: 0, reason: t("compose.recovery.pageSuspended")}});
    if (draft) pane.recoveredComposeDraft = null;
  }
  endDirectLine();
  inlineDictationView?.cancel(); inlineDictation?.hidden();
  if (capActive && !capActive.file) resetCapture(capActive);
  linePending?.operation?.cancel();
  for (const record of composeUploads) if (record.inserting) record.operation?.cancel();
  retireComposeOwner(composeOwner);
  if (cdlg.open) cdlg.close();
}
function disposeLocalPage() {
  meshPageFinal = true; meshStopped = true; meshPageEpoch++;
  meshPageCache = null;
  disposeBackendAccountSettings();
  flowGeneration++; flowing = false; flowController?.close();
  projectsGeneration++; workGeneration++;
  projectsController?.close(); workController?.close();
  retirePageInput();
  inlineDictation?.dispose(); inlineDictationView?.dispose();
  inventoryPoller?.stop(); listBatch.cancel(); sessionsStatus.dispose(); pageSignals?.dispose();
  navigator.serviceWorker?.removeEventListener("message", handleLocalServiceWorkerMessage);
  for (const pane of panes) {pane.invalidateActionView(); pane.detach();}
  for (const handle of localTerminalHandles) handle.dispose();
  disposeLocalInputScopes();
}
function suspendLocalPage() {
  if (!localMeshEffectsAllowed()) return;
  const bindings = new Map((meshPageCache?.bindings || []).filter(cachedTerminalCurrent)
    .map(binding => [binding.pane, {...binding}]));
  for (const pane of panes) if (pane.conn) bindings.set(pane, {pane, id: pane.id,
    name: pane.conn.name, created: pane.conn.created});
  meshPageCache = {bindings: [...bindings.values()], focus: document.activeElement};
  meshPageSuspended = true; meshPageEpoch++; dictationInventoryReady = false;
  disposeBackendAccountSettings();
  flowGeneration++; flowController?.close();
  projectsGeneration++; workGeneration++;
  projectsController?.close(); workController?.close();
  inventoryPoller?.stop(); listBatch.cancel(); pageSignals?.dispose();
  retirePageInput(true);
  inlineDictation?.suspendForPageCache();
  for (const pane of panes) {
    pane.invalidateActionView(); pane.detach();
    const binding = bindings.get(pane);
    if (binding) {
      binding.view = pane.actionView;
      // Inventory may report a move before reattachment or after it is refused.
      // Neither observation can select another terminal on behalf of the user.
      pane.cachedTerminalMoveBlockedId = binding.id;
    }
  }
  for (const handle of localTerminalHandles) handle.dispose();
  // Keep native lease history viable for fresh, inventory-validated sockets.
}
async function resumeLocalPage() {
  if (!meshPageSuspended || meshStopped || meshPageFinal || !meshPageCache) return;
  const epoch = meshPageEpoch, context = meshContext, flowTurn = flowGeneration;
  meshPageCache.focusRevision = meshCacheFocusRevision;
  meshPageSuspended = false;
  void startBackendAccountSettings();
  renderComposeStatus(); listBatch.request();
  inlineDictation?.resumeFromPageCache(); renderInlineDictation();
  await startInventory(context, true);
  if (!localMeshEffectsAllowed() || meshPageFinal || meshContext !== context || epoch !== meshPageEpoch) return;
  if (projecting) openProjectsPresentation();
  if (flowing && flowTurn === flowGeneration) void setFlow(true);
}
function restorePendingCachedTerminals() {
  if (!meshPageCache || !localMeshEffectsAllowed() || meshPageFinal) return;
  const cached = meshPageCache;
  meshPageCache = null;
  const bindings = cached.bindings.filter(binding => restoreCachedTerminal(binding, cached.focus, cached.focusRevision));
  if (bindings.length) meshPageCache = {...cached, bindings};
}
function cachedTerminalCurrent({pane, id, view}) {
  return panes.includes(pane) && pane.id === id && !pane.actionDisposed && pane.actionView === view;
}
function restoreCachedTerminal(binding, focus, focusRevision) {
  const {pane, id, name, created} = binding;
  // A live reconnect can follow a restarted name; a frozen page may only restore
  // its original target. pageshow is not user authority to select a replacement.
  if (!cachedTerminalCurrent(binding) || pane.conn || !Number.isFinite(created) || created <= 0) return false;
  const identity = paneTargets.identity(id);
  if (identity?.name !== name) return false;
  if (identity.created === null) return true;   // listed, but not yet an identified incarnation
  if (identity.created !== created) return false;
  pane.attach(id, {cacheRestore: true, cacheFocus: pane.el.contains(focus) ? focus : null, cacheFocusRevision: focusRevision});
  return false;
}
function disposeLocalInputScopes() {
  for (const scope of humanInputScopes.values()) scope.dispose();
  humanInputScopes.clear();
}
