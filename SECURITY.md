# Security policy

session-mesh lets a browser type into terminals that run as your user. Whoever holds its token, or
a valid login cookie, can therefore run any command with your rights. This page explains how the
project protects that access, which risks remain by design, and how to report a vulnerability.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: on the
[Session-Mesh/session-mesh](https://github.com/Session-Mesh/session-mesh) repository, open the
**Security** tab and choose **Report a vulnerability**
([direct link](https://github.com/Session-Mesh/session-mesh/security/advisories/new)). This
creates a private advisory visible only to you and the maintainers. There is no security e-mail
address. Please do not open a public issue or pull request for a vulnerability.

A useful report says which version or commit you tested, how session-mesh was installed (default
loopback, `--tailscale`), what an attacker needs beforehand (a local
account, a position on the tailnet, a document opened in the interface…) and what they obtain.

session-mesh is an alpha project maintained in spare time: reports are handled on a best-effort
basis, with no guaranteed response time. Fixes go to the `main` branch first. The maintenance
branch `release/latest` follows the current published minor line (0.1.x today): fixes labelled
`semver: patch`, security fixes among them, are backported to it and released as a patch version.
The supported versions are the latest release of that line and the latest `main`, for a source
install.

## Threat model

### What is trusted

- **Your user account.** Any process running as you can read `~/.config/session-mesh/token` and
  drive the mesh, exactly as it could already open a shell. session-mesh does not defend against
  software that already runs as you.
- **The agents you start.** Claude Code, Codex, Pi or any other program in a mesh session run with
  your rights. session-mesh does not sandbox them.
- **An optional transcription service.** Enabling dictation sends the recorded audio and configured
  language to the fixed endpoint the operator selected. A remote endpoint receives that audio
  off-host; HTTPS is required except for loopback HTTP endpoints. Mesh login cookies and
  bearer/session tokens are not forwarded. The returned
  transcript is untrusted text, not permission to execute it: the header microphone inserts it
  without Enter on desktop and stages it in an editable field on phones. Review it before submitting
  manually.
  This does not attest that the service transcribed the recording accurately. Endpoint configuration
  and the current API contract are documented under [Whisper dictation](docs/operations.md#whisper-dictation).
- **GitHub and everyone who can push to the repository**, for a release install. A release is
  built and published by the repository's release workflow when a `v*` tag is pushed. The build
  attestation that the installer checks (with `gh` logged in) proves that a file was built by that
  workflow from the tag being installed, not that the tag names a reviewed commit of `main`: the
  workflow's own check of `main` can be removed by whoever pushes the tag. Any credential with push
  access, a maintainer's token stored on a machine included, can therefore publish a release that
  passes every check, and a token with `contents: write` can replace a published release's files.
  Two-factor authentication does not protect those tokens. Immutable releases and a tag ruleset
  restricting `v*` tags narrow this; the repository owner decides whether they are enabled
  ([what you are trusting](docs/operations.md#prebuilt-binaries)). Nightly pre-releases are
  published by the same release workflow, started by a scheduled workflow on a tag it creates on a
  commit of `main` after checking that the required checks passed on it; they carry the same
  attestations, and no installation offers them by itself. That check belongs to the scheduled
  workflow only: `release.yml` itself re-verifies that the tag is the built commit and that this
  commit is `main`'s head or an ancestor of it, not the checks, and a person with write access can
  run it on a nightly-shaped tag, or move the tag between the two steps. The boundary that matters
  is therefore write access to the repository, as for stable releases.

### What session-mesh defends against

- **Other machines on your network.** The web server listens on `127.0.0.1` by default. At startup
  it refuses any `MESH_HOST` that is not a loopback address (`127.0.0.0/8`, `::1`, `localhost`),
  unless `MESH_ALLOW_NON_LOOPBACK=1` is set, in which case it prints a warning: without a TLS proxy
  in front of every request, the token and the cookie would then cross the network in clear.
- **Requests without the token.** Every page and API call needs the login cookie or the token,
  with three exceptions. The login page and a few static files (icons, manifest, service worker)
  are public. The JavaScript libraries the document viewer uses (`/viewlib/…`) are served to
  anyone, as they hold no secret. A document link (`/view/…`) needs no cookie: the link itself is
  a signed capability, valid 12 hours, for one file or one directory, and whoever holds it can use
  it for that time ([Documents that send data out](#documents-that-send-data-out)). The token is created with mode 0600 in a 0700
  directory. The cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` when the request came over
  HTTPS. Requests that change state are refused when their `Origin` header names another site.
- **Cookie lifetime.** The browser is asked to keep the cookie 30 days (`max_age`), but the server
  does not limit its age. Its value is an HMAC of the token and of a generation counter
  (`cookiegen.py`), identical on every device, and the server accepts it, without time limit, until
  `mesh-logout-all` raises the generation or the token is replaced. A copied or stolen cookie
  therefore works until one of those two actions; "Sign out this device" only deletes the cookie
  from that browser.
- **Command-line tools talking to the wrong server.** `mesh-open`, `mesh-rename`, `mesh-logout-all`
  and the agent hook `mesh-event` send their credentials only to `http://127.0.0.1:<port>`, never
  through an HTTP proxy from the environment, and treat a redirection as an error instead of
  following it. The OpenCode plugin does the same (it uses `node:http`, which ignores proxy
  variables, and an OpenCode configuration cannot change the port the board bridge talks to).
  Antigravity reports through `mesh-event` too; its plugin (installed by the user with
  `scripts/agy-setup.sh`, which only runs `agy plugin install`) holds no credential and the bridge and hook
  read the token from the terminal's environment. Antigravity offers no per-session configuration, so a
  project's own `.agents/mcp_config.json` could declare a server of the same name that receives that
  environment: the same exposure as any other process an agent starts in the terminal.
  The Copilot CLI hooks run `mesh-event`, and the Copilot board bridge's `env` block pins the port, so a
  project's `.mcp.json` cannot point it elsewhere.
  Vibe's hooks run `bin/mesh-event`, which does the same.
  Vibe starts its MCP servers with only the environment their entry lists, so the board bridge cannot inherit
  the session token as it does for the other agents: it is passed in the entry of `VIBE_MCP_SERVERS`, set on the
  command as the word `"$MESH_SESSION_TOKEN"` of a `/bin/sh -c` script, which the inner shell expands before it execs Vibe. It is in Vibe's process environment (as it already is in the
  terminal's) and in no command line, file or Vibe session store (checked in `tests/vibe-real.test.ts`).
- **Vibe's `--add-dir` widens the agent's workspace.** Vibe reads its state hooks from the `.vibe/hooks.toml` of
  every directory given with `--add-dir`, and that flag also makes the directory a project root and a workspace
  root of the agent: an `AGENTS.md` there reaches the model's prompt, `.vibe/tools`, `.vibe/plugins`,
  `.vibe/agents` and `.agents/skills` there are loaded, and the `accept-edits` agent writes there without asking.
  The mesh therefore hands each Vibe launch its own directory (`mesh-vibe-hooks/vibe-<nonce>`, built anew,
  holding only `.vibe/hooks.toml`, mode 0500 for the directories and 0400 for the file, under a 0700 parent),
  deleted when the session is gone, so a session cannot leave instructions for the next ones. The modes are not
  a boundary against a shell: the parent directory is writable by the same user, so an agent that has a shell
  (auto-approve, or an approval for one shell command) can change those modes, rename its own launch directory
  and recreate it with an `AGENTS.md`, and alter the directory of every other live Vibe session (`chmod u+w`,
  then rewrite its `hooks.toml` or add an `AGENTS.md`). The damage is bounded by the user's own rights and by
  the lifetime of the sessions (a launch id is a 96-bit nonce, never reused, and an existing directory is
  deleted before it is built), but it is not confined to the agent's own launch. Hooks of the same name are deduplicated by Vibe, first one wins: a trusted project can mask the
  mesh's `session-mesh-*` hooks (it then controls the state reported for that session).
- **Vibe's "Allow always" is on `run_typescript`.** Vibe exposes the MCP tools through one `run_typescript`
  sandbox, and the approval is asked for that tool: "Allow always" approves every later program, hence every
  `mesh-board` call and any other tool the sandbox offers, not one MCP tool. Use "Allow once" or "for the
  session" to keep a decision per call.
- **A session reaching beyond itself.** Each mesh session receives its own token
  (`MESH_SESSION_TOKEN`), valid only while that session lives; a session opened with `mesh-attach`
  while the master token cannot be read receives none. The master token is never placed in a
  session. Without `MESH_SESSION_TOKEN`, `mesh-open` refuses instead of reading the master token
  when `MESH_SESSION` is set or when the PTY host lists a session whose shell is one of its
  ancestors. When neither shows a session, it uses the master token: no PTY host answers, a sandbox
  hides the ancestry, or the process left the session's process tree (a detached process, a
  terminal multiplexer whose server was started outside the session, `nohup` after the shell
  ended). This stops an accidental use, not a process that reads the master token file with your
  rights. The session token cannot type into a terminal, read another
  session's output, start or stop a session by itself, or read files through the server. It is
  accepted only for these
  actions, each on the session's own data (the list is `ROUTES` in `sessionauth.py`):
  - open or reload a document next to the session's pane, and ask whether the documents it opened
    changed on disk (for `--watch`); it never receives the document's `/view` link;
  - report the agent's state (busy, waiting, finished) through the agent hook, or, for OpenCode,
    its plugin, for Gemini CLI and Mistral Vibe, their hooks (they also report the conversation to resume), or, for Copilot CLI,
    the hooks of the per-session plugin (`mesh-event copilot`);
  - read, replace, restore and open the session's whiteboard and its revisions;
  - create, update, list, open and restore the session's demos;
  - exchange messages with other agents: list peers, send, reply, read its inbox and acknowledge
    (reading a message needs your consent in the page), and, for Pi, receive message notices;
  - ask to create a new agent session in its folder or to restart its own conversation, and read
    the status of that request; nothing happens until you approve it in the page;
  - inspect its own execution state and explicit launch settings, or request a model or reasoning
    effort for an identified Codex or Claude Code conversation. Mesh rechecks the conversation
    before the owner-approved restart and uses the same permissions and account as a normal resume.

  The token is in the environment of the agent, so every MCP server and every hook it starts
  inherits it, whether the server or the hook comes from the project, from a plugin or from your
  own configuration (for Claude Code and for Copilot CLI alike; Copilot's project and plugin hooks
  and each MCP server it launches included). Such a process can use it for the actions above, for
  as long as the session lives, and for nothing else. Mesh cannot withhold it from them: do not
  trust a project's or a plugin's hooks and servers more than the agent that runs them. The
  tracker server the mesh adds beside the board (`mesh-work`, the `work-mcp` program) never reads
  the token and empties it in its own process at start, so the `git` it runs does not inherit it;
  Codex, Gemini CLI and Vibe do not pass it to that server at all ([docs/work-mcp.md](docs/work-mcp.md#registration)).
- **Documents written by agents.** HTML, Markdown and source files shown in the interface are served
  from an opaque-origin sandbox with a restrictive Content Security Policy. A document cannot read
  the login cookie, drive the terminals or call the mesh's API. Its script cannot use `fetch`, XHR,
  WebSocket or beacons, cannot submit forms, open windows or dialogs, and cannot load remote images,
  styles, fonts or scripts. This does not stop every way out: see
  [Documents that send data out](#documents-that-send-data-out).
- **Well-known credential files.** The document panel and the file tree never show, sign a link for
  or serve the mesh's own configuration directory (`~/.config/session-mesh`, or `MESH_CONF_DIR`),
  nor these files and directories, whether reached by their name, through a symbolic link or
  through a hard link (the list is `DENY_UNDER_HOME` in `view.py`). A hard link is recognised by
  the file's identity (device and inode), on the path when the request is checked and again on the
  file actually opened: a file that is protected at either moment is refused, even if a hard link
  to it replaced the requested file in between. The directories between the opened file and its
  view root are compared with the protected directories as well, so a protected directory renamed
  into place in between, or reached through a symbolic link, gets 404. For the directories refused
  by name only below, this covers the protected directory itself, not the directories inside it
  (see the limits after the list):
  - keys and password stores: `~/.ssh`, `~/.gnupg`, `~/.password-store`,
    `~/.local/share/keyrings`, `~/.config/op`, `~/.config/sops/age`;
  - cloud and cluster logins: `~/.aws`, `~/.kube`, `~/.docker`, `~/.azure`, `~/.oci`,
    `~/.config/gcloud`, `~/.boto`, `~/.s3cfg`, `~/.config/rclone`,
    `~/.terraform.d/credentials.tfrc.json`, `~/.vault-token`;
  - coding agents' logins: `~/.claude/.credentials.json`, `~/.claude.json`, `~/.codex/auth.json`,
    `~/.gemini/oauth_creds.json`, `~/.pi/agent/auth.json`;
  - forges and package registries: `~/.config/gh`, `~/.config/glab-cli`, `~/.config/hub`,
    `~/.netrc`, `~/.git-credentials`, `~/.config/git/credentials`, `~/.npmrc`, `~/.yarnrc.yml`,
    `~/.pypirc`, `~/.cargo/credentials.toml`, `~/.cargo/credentials`, `~/.gem/credentials`,
    `~/.config/containers/auth.json`, `~/.composer/auth.json`, `~/.config/composer/auth.json`;
  - databases: `~/.pgpass`, `~/.my.cnf`, `~/.mylogin.cnf`;
  - shell and REPL histories: `~/.bash_history`, `~/.zsh_history`,
    `~/.local/share/fish/fish_history`, `~/.python_history`, `~/.node_repl_history`,
    `~/.psql_history`, `~/.mysql_history`, `~/.sqlite_history`, `~/.lesshst`;
  - browser profiles: `~/.mozilla`, `~/.config/google-chrome`, `~/.config/chromium`,
    `~/.config/BraveSoftware`, `~/.config/microsoft-edge`, `~/.config/vivaldi`, `~/.librewolf`,
    the Flatpak ones `~/.var/app/org.mozilla.firefox`, `~/.var/app/com.google.Chrome`,
    `~/.var/app/org.chromium.Chromium`, `~/.var/app/com.brave.Browser`, and the Snap ones
    `~/snap/firefox`, `~/snap/chromium`. These are refused by name and through a symbolic link, not
    through a hard link: they hold too many files to be checked one by one at each request;
  - on macOS, the login keychains `~/Library/Keychains`, refused by name, through a symbolic link
    and through a hard link like the keys above; and the following data, refused by name and
    through a symbolic link only, like the browser profiles. Browsers: `~/Library/Cookies`,
    `~/Library/HTTPStorages`, `~/Library/Safari`, `~/Library/Containers/com.apple.Safari`,
    `~/Library/Application Support/Firefox`, `~/Library/Application Support/Google/Chrome`,
    `~/Library/Application Support/Google/Chrome Beta`,
    `~/Library/Application Support/Google/Chrome Canary`,
    `~/Library/Application Support/Chromium`, `~/Library/Application Support/BraveSoftware`,
    `~/Library/Application Support/Microsoft Edge`, `~/Library/Application Support/Vivaldi`,
    `~/Library/Application Support/librewolf`, `~/Library/Application Support/Arc`,
    `~/Library/Application Support/com.operasoftware.Opera`. Mail, messages, contacts, calendars,
    notes and accounts: `~/Library/Mail`, `~/Library/Containers/com.apple.mail`,
    `~/Library/Thunderbird`, `~/Library/Messages`, `~/Library/Application Support/AddressBook`,
    `~/Library/Calendars`, `~/Library/Group Containers/group.com.apple.calendar`,
    `~/Library/Group Containers/group.com.apple.notes`,
    `~/Library/Accounts`. Password managers: `~/Library/Group Containers/2BUA8C4S2C.com.1password`
    (1Password 8), `~/Library/Containers/com.agilebits.onepassword7` and
    `~/Library/Group Containers/2BUA8C4S2C.com.agilebits` (1Password 7),
    `~/Library/Application Support/Bitwarden`, `~/Library/Containers/com.bitwarden.desktop`. Chat
    apps: `~/Library/Application Support/Signal`, `~/Library/Application Support/Slack`,
    `~/Library/Containers/com.tinyspeck.slackmacgap`. The list is the same on every system:
    a folder that does not exist is simply absent.

  Two substitutions involving a directory refused by name only are not detected. Both need a
  process that can already rename the user's own directories:
  - a directory inside it (a browser profile, for example) renamed into the place of a directory
    the requested file is reached through, at any moment between the checks and the open. One
    rename is enough: nothing below a directory refused by name only is recorded, which is also
    why a hard link into one is not recognised;
  - the protected directory itself, in place when the file is opened, moved away while the
    directories are compared and moved back before the opened file's name is checked one last
    time. That takes two renames within a few system calls.

  A directory refused by name only that the system forbids the server to read ("Operation not
  permitted") stays refused by name and through a symbolic link, and the server logs it once. On
  macOS this happens to a server without Full Disk Access, which may get that error on the Mail,
  Messages or Safari data: other documents are still served. Any other failure to check a protected
  entry refuses every document until it is resolved: that error on an entry checked file by file,
  such as `~/.ssh` or `~/Library/Keychains`, where an unreadable folder would hide a hard link to
  one of its files, or a folder made unreadable by its own file permissions. Failing to check the
  requested file itself, or a directory it is reached through, refuses that request.

  This list covers well-known places only. Any other secret under your home directory, `/tmp` or,
  on macOS, your private temporary directory (`/var/folders/…/T`) (a project's `.env`, another
  browser's profile, another tool's token) is a file like any other: the panel shows it to whoever
  can open documents in the interface.
- **Messages between agents** are stored as untrusted data and their text is never typed into a
  terminal; an agent has to ask to read its inbox. You can read the retained messages of a
  session in that pane's mailbox, with your browser's sign-in only: no agent credential reaches
  that route, the text is shown as plain text (no markup, no link), and reading it grants the
  agent nothing. Depositing a message or reply asks for your approval in the page, unless you
  already allowed that exact sender-to-recipient direction. Only approved messages can trigger
  a wake. What the mesh does type, into Claude Code, OpenCode, Gemini CLI and Mistral Vibe only,
  is a fixed notice that messages are waiting, followed by `Enter`. An `Enter` that reached an
  approval prompt would answer it, so the
  notice is typed only when Claude is known to be idle at its prompt: its last hook event is the
  end of a turn (`Stop` with no background task; for OpenCode, its plugin's `session.idle`, for Gemini its
  `AfterAgent` hook, for Vibe the end-of-turn notification of its hooks, and a later working, permission or question event closes the gate), no input has reached the terminal since that
  event (the PTY host checks this when it queues the notice), and you have no unsent input in it.
  Otherwise the notice waits for the next finished turn. The notice contains no digit, which a
  numbered menu could read as a choice. Codex and Antigravity get no typed notice: the mesh has no
  reliable signal that they are idle (Antigravity sends no `Stop` during a permission prompt, but also none
  after a refused one, so its idle state is guessed from silence), so their messages wait in their inbox until they
  check. A hook or plugin that every instance of an agent runs (Antigravity's, installed globally) also
  runs in an agent started inside a session and inherits its token: the server ignores an event whose
  source is not the session's own agent, so the finished turn of a nested agent of another type cannot open the
  gate. For a nested agent of the same type the source does not tell them apart: Claude Code is safe only
  because its hooks are injected per session (`--settings`), not installed globally, and Antigravity's plugin is
  global, so only the first conversation it reports counts (a nested `agy` that reports before the session's own
  is not told apart). Pi receives notices
  through its extension, not the terminal. A hook may date its event up to a minute ahead, but the
  server never dates an event later than its arrival, and any other event that follows the end of
  a turn closes the gate whatever its date.

  Copilot CLI gets no typed notice either. Its `agentStop` carries nothing like Claude's
  `background_tasks == []`: Mesh cannot tell that a background shell or a sub-agent still runs when
  the turn ends, and nobody has observed what `agentStop` means in autopilot, where Copilot keeps going
  by itself, and which a Shift+Tab inside Copilot can enter without any change to its arguments. So no
  notice is ever typed into a Copilot, whatever its arguments: its messages wait in the inbox until it
  checks `mail.inbox`. Its state, its conversation and its mailbox work as for the other agents.

  Codex has an optional wake that types nothing: `codex queue`. It is off by default and turns on
  only when the web server starts with `MESH_CODEX_QUEUE_WAKE=1`. For a Codex session whose
  conversation the mesh knows exactly (the rollout file the process holds open, never a name), the
  server then runs `codex queue --thread <conversation id> --message <fixed line>` once per
  notification, with a short allow-list of environment variables and never a `MESH_*` name or a
  secret. The line holds no message text. The trust this opt-in extends: the server runs the first
  `codex` found on the `PATH` that sessions get, so it trusts every directory of that `PATH`. A
  program that can write an executable named `codex` into one of them gets it run by the server,
  as your user, whenever a Codex session is woken. That is no new right for a program that already
  runs as you, but it is a way to run code at a moment you did not choose, so enable it only when
  your sessions' `PATH` holds directories you control. Delivery to a Codex open in a terminal has not
  been verified on a real session.

  The text of the notice is typed at once and its `Enter` 250 ms later (Claude Code reads a burst
  ending with `Enter` as a paste, not as a submission). Two things withdraw that `Enter` during
  the delay. The first is any input that reaches the terminal (your keystrokes included), which
  is then preceded by `Ctrl-U` to erase the notice's line; replies the terminal sends on its own
  (focus in and out, mouse reports, cursor-position and device-status replies) are not typing:
  they pass through unchanged and leave the `Enter` in place. The second is any hook event that
  replaces the end of turn the notice relied on, which leaves the text unsent in Claude's prompt.
  The server tells the PTY host as it applies the event and, because that event may arrive while
  the notice is still on its way, checks again once the PTY host has accepted the notice. The
  messages stay in the inbox; that notice is not typed again.

  Limits:
  - the hook events come from processes of the session itself, so a program running in that
    session can report a false end of turn (it already runs as your user and could reach the PTY
    host anyway);
  - a turn that Claude starts on its own within the 250 ms is caught only if its hook event (a
    prompt, a tool, a permission request) reaches the server, and the server's withdrawal reaches
    the PTY host, before the `Enter` is written; one that shows an approval prompt without a hook
    event first is not. In particular, a `Stop` hook of your own
    that blocks the end of the turn after Mesh's own `Stop` hook has reported it keeps Claude
    working while the mesh believes it idle, until Claude's next hook event;
  - the PTY host compares the wall-clock time of the last input with the wall-clock time of the
    end of the turn, both read on the same machine. A clock set back after the end of a turn would
    date later input before it, so the server withdraws an end of turn once the wall clock has
    fallen behind its monotonic clock by more than a second since the event arrived (until the
    next one); a step back of less than a second can still hide input typed within that second.
  - the behaviour with the real Claude Code interface is untested: that `Ctrl-U` erases its input
    line, and that it does not merge the notice and the `Enter` into one paste. The tests use a
    fake agent reading a terminal in canonical or raw mode.

  A Claude Code session that the mesh launched on Claude Code 2.1.325 or later can be woken without
  typing: the mesh starts it with `--messaging-socket-path`, then writes one fixed line on that
  socket (see [Messages between agents](docs/features.md)). Claude itself labels the line as coming
  from another session, not from you. Once the line is written, the mesh types nothing in that
  terminal for that wake, so no approval dialog Claude opens can be answered by the mesh. The
  boundaries:
  - **the mesh does not change Claude's cross-session messaging setting.** It never writes
    `crossSessionInbound`, neither in the settings it passes nor anywhere else; Claude applies
    your choice, or its default;
  - **when a session gets a socket.** The mesh reads, in Claude's order (the administrator's
    policy files, the command's `--settings`, your Claude user settings in `$CLAUDE_CONFIG_DIR` or
    `~/.claude`, then the project's settings, which can only tighten), what Claude will do with
    the line. The project's settings are read where Claude reads them: `.claude/settings.json` in
    the session's folder (the physical one: its path is resolved with `realpath`, a `..` after a
    symbolic link included, as the terminal host's `chdir` does); `.claude/settings.local.json` in the canonical root of the folder's git
    repository (the main checkout, for a linked worktree, found by reading `.git`, `commondir` and
    `gitdir` as Claude does) when you own that root, its `.git` and its `.claude`, and also the
    older `.claude/settings.local.json` of the session's folder. If the root cannot be determined
    with certainty (an unusual `.git`, an inconsistent worktree pointer) the session gets no
    socket. Settings of a folder that Claude ignores for another reason (it is inside a
    `connector-downloads` folder) are still read, which can only deny a socket. The session gets a socket only if that
    value is `accept`, or if there is none and the session does not bypass permissions
    (`--dangerously-skip-permissions`, `--permission-mode bypassPermissions`, or a bypass default
    in the settings read). In every other case, and whenever a file cannot be read with certainty
    (unreadable, over 1 MiB, malformed, a FIFO or another file that is not regular), it gets no
    socket and keeps the typed notice. A policy delivered by MDM or by your organisation's server
    is not a file the mesh can read: the delivery confirmation below covers it;
  - **delivery confirmation, and no typing after a line.** A line written on the socket counts as
    a wake only if the agent then looks at its inbox, through the route of the `mail.inbox`
    tool. Claude may hold the line for your approval, in a dialog of its own terminal that
    nothing signals to the mesh (it happens with a `hold`, and with a line from a sender that
    states no permission mode in a session that bypasses permissions). A typed notice and `Enter`
    could answer that dialog, for this message or for another session's held one, so **once a line
    has been written the mesh never types anything in that terminal for that wake.** If the inbox
    has not been read 20 seconds after the line, the wake becomes "unconfirmed": the page shows
    it (a mark on the session in the list, and a line in the Mailbox panel of its "Info"), it is
    not counted as delivered, and no second line is written for it. Looking at the inbox, at any
    time, confirms it. The line you see held in Claude's dialog is yours to decide. The
    remembered state is a small file (`wake-lines.json`, mode `0600`) in the private socket
    directory, so that a restart of the server neither writes a second line nor forgets an
    unconfirmed one. A line is recorded there before it is sent. If that file is lost or damaged,
    or if the directory stops being private (deleted, or opened to others) after a line was
    recorded, the mesh does not assume that no line was written: every session that is alive at
    that moment is put in doubt. The doubt lasts **until that session restarts**, and nothing
    lifts it earlier: no read of the inbox is known to close a dialog that holds the earlier
    line, so a read does not clear it. A session in doubt gets neither a new line nor a typed
    notice, and its wakes show as "unconfirmed" in the page. The price is real: **no incarnation
    that was alive when the state file was lost, with or without a socket, is woken by any means
    until it restarts.** An invalid entry is dropped on its own without discarding the valid
    ones. Outside the doubt, the typed notice, under the guards above (the session idle, and the
    PTY host's `agent_wake_v1` and `human_input_lease_v1` capabilities), remains for sessions
    that have no socket, and for a line that could not be written at all. A session also gets no
    socket when the mesh's board bridge is not installed, or when the command does not carry the
    bridge's `--mcp-config` entry (the `mail.inbox` tool that confirms a wake comes from it),
    nor when the command carries `--project-config-root`, which moves where Claude reads the
    project's settings. A restart of the server while the directory is already missing or open to
    others cannot tell that lines were written: no session has a socket then, and the typed
    notice is kept;
  - **the `claude` that really runs.** The mesh checks the `claude` first on the PATH it gives the
    PTY host, but the PTY host starts your login shell (`$SHELL -l`) and types the command into it:
    your shell's startup files can change what runs. An alias that adds
    `--dangerously-skip-permissions`, a different `claude` first on the PATH, or an exported
    `CLAUDE_CONFIG_DIR` are not seen by the mesh. A bypass added that way, with no explicit
    `accept`, leaves the line to Claude's parity rule (below) and to the confirmation above. A
    `claude` that does not know the option would print `error: unknown option` and exit, as
    2.1.319 does for any unknown option (observed), and the session would stay at its shell
    prompt, so a launch can fail because of the option in that case; the mesh cannot test the
    shell's `claude` without typing into it, so it does not try. Claude 2.1.319 and 2.1.323
    accept the option, but the mesh adds it only from 2.1.325, the version it checked;
  - the socket directory, `<runtime directory>/session-mesh/claude-wake/`, is created with mode
    `0700`; where a socket path would not fit there (a Unix socket path holds 103 bytes on macOS,
    and the default runtime directory there is longer) the mesh uses
    `/tmp/session-mesh-<uid>-<8 hex of that directory's path>/`, created and checked the same way.
    A directory that is a symbolic link, belongs to another user or is open to others is refused
    (another user who creates the `/tmp` name first can only keep the session on the typed
    notice), and so is a socket that is not a socket of your user. Claude creates the socket
    itself, with mode `0600`; the mesh removes, from that directory only, sockets that no listed
    session owns and that are over a minute old (left by a Claude killed abruptly);
  - the server connects only to the path it derives, for the live incarnation, from that
    incarnation's nonce (which only the server mints and only the PTY host's listing returns),
    never to a path taken from a request. No HTTP route writes to a socket;
  - the line holds a fixed sentence and the number of waiting messages. Nothing an agent sends
    (text, sender, identifiers) is relayed on it;
  - **Claude creates a messaging socket for every session anyway, and registers it for its other
    sessions.** Without the option it listens at `$XDG_RUNTIME_DIR/cc-socks/<pid>.sock` (or
    `/tmp/cc-socks-<uid>/<pid>.sock` when that path is too long), also visible to its peers. The
    mesh's option only chooses the path; it adds no listener and no exposure. Another Claude Code
    session of yours can therefore send any session a turn, with or without the mesh. Whether
    that turn runs without your approval is Claude's choice, set by `crossSessionInbound`. With no
    value, Claude applies a permission-mode parity: a sender whose permission class differs from
    the session's is held for your approval (`mode-mismatch`), and a sender that states no class,
    as the mesh does, is held only if the session bypasses permissions (`no-mode-asserted`). This
    is why a bypass session gets a socket only with an explicit `accept`. How Claude
    authenticates what is written to the socket was not verified for this document: the mesh does
    not rely on it. Other processes running as your user can already type into the terminal
    through the PTY host, so do not run code you do not trust as your user.

## Known limits

### Other users on the same machine

**Do not use session-mesh on a machine shared with local users you do not trust.**

The server and its clients meet on a local TCP port, and nothing identifies the process that
listens on it. If another local user binds `127.0.0.1:<port>` while session-mesh is stopped,
starting or restarting, that user can:

- receive the master token sent by the command-line tools, and the session tokens sent by agent
  hooks and integrations;
- receive the browser's login cookie or a `?token=` login, whether the browser connects directly to
  `127.0.0.1` or through `tailscale serve`;
- serve their own page under the origin your browser trusts, not only receive data.

With a port other than 7690, the tools in sessions started by `mesh-attach`, and every tool outside
a session, send their credentials to port 7690 (the session token, or the master token for
`mesh-rename`) unless `MESH_PORT` is exported in your shell's startup files
([details](docs/operations.md#using-another-port-than-7690)); whoever listens on 7690 receives them.
Sessions started by the web server receive the right port.

Refusing proxies protects the command-line tools from a misconfigured environment, not from this.
A Unix socket would close only the command-line and agent half, since a browser cannot speak HTTP to
a Unix socket.

If you suspect this happened, log out every device with `mesh-logout-all` **and** replace the master
token, because revoking cookies does not change it: delete `~/.config/session-mesh/token` and
restart the web server ([procedure](docs/operations.md#logging-out-devices-and-replacing-the-token)).

### Documents that send data out

**Open in the viewer only documents you trust, especially with `--tailscale`.**

The sandbox blocks the network APIs a script would normally use, but at least two channels stay
open, as the comments in `view.py` and two expected-failure browser tests
(`tests/browser/test_view_review_browser.py`) record:

- **Navigating its own frame.** A Content Security Policy cannot stop a page from replacing
  itself: a script can set `location` to a URL on another server, with any data in that URL.
- **WebRTC.** Chromium applies no Content Security Policy to WebRTC, so a script can send data
  over UDP.

A script in an HTML or SVG document can therefore send out whatever it can read: its own content,
the files next to it that its link covers, and its own `/view/…` link. That link is a bearer
capability, valid 12 hours without a cookie: for a document you opened, it covers the files up to
two subdirectories below it ([details](docs/operations.md#documents-opened-with-mesh-open)).
Whoever receives it can read those files, from any machine that reaches the server's port, which
with `--tailscale` means the devices of your tailnet. A document that an agent opens with its
session token is limited to its own file, which narrows what the link exposes but not the
channels themselves. That limit lasts 12 hours from the agent's request and survives a restart of
the server; if the server cannot tell which documents agents opened (its record is full or
unreadable), every document is limited to its own file until those 12 hours have passed. After
them, a document you open or reload yourself gets the wider link again, whoever wrote it.
Markdown runs no script of its own.

### The login cookie and other local servers

Browsers do not separate cookies by port. Any other web server on the same host name
(`127.0.0.1`, or your node's `ts.net` name) receives the login cookie when the browser visits it,
and can then use it against session-mesh. Do not run untrusted web servers on the same host name
you use for session-mesh, and log out every device with `mesh-logout-all` if one may have seen the
cookie.

### Editing the launch settings

"Configuration" can rewrite the launch settings file (`MESH_LAUNCH_SETTINGS`): the enabled agents
and the allowed work folders. Three routes carry this: `POST /api/config/elevate`,
`POST /api/config/elevate/revoke` and `POST /api/config/launch`. All three need the owner's login
cookie alone: a master token, a session token or any `Authorization` header is refused with 401,
even beside the cookie. They refuse another site's `Origin` (403) and any content type but
`application/json` (415). The body is limited to 4 KiB on `/elevate` and `/elevate/revoke`
(`/revoke` expects `{}`) and to 32 KiB on `/launch` (413 beyond; the declared `Content-Length` is
checked first, then the bytes actually read). A request without an `Origin` header is accepted: it
does not come from a page of another site, and the `SameSite=Strict` cookies are what stop one.

- **Elevation.** Writing also needs a short elevation: you type the master token again. The server
  compares it in constant time, never stores, logs or returns it, and allows five wrong attempts per
  five minutes (then 429; "log out everywhere" resets the count). The grant is a random value in an
  `HttpOnly`, `SameSite=Strict` cookie limited to `/api/config`, valid 10 minutes, bound to the
  current login: `mesh-logout-all`, a restart, the expiry or "Lock" end it. A write checks it again
  just before the file is replaced. **What it is and is not.** It is a confirmation: it stops an
  edit made by mistake, or by a page or a tap that was not meant, and it keeps the master token
  out of the stored page state. It is **not a boundary against whoever holds the login cookie.**
  That cookie already gives a shell (see above: "New session" with the `custom` preset runs any
  command), and a shell can read the token file and edit the settings file directly, so a stolen
  cookie or an unlocked phone can also obtain the token and elevate. Treat the cookie as the key to
  these settings, and revoke it with `mesh-logout-all` if it may have leaked.
- **What can be written.** Exactly two fields, never a path to a binary, a command, a URL or an
  environment variable. Agents must be names of the launch catalogue. Folders must be absolute,
  existing directories whose real path (symbolic links resolved) is under your home folder; a link
  that leaves it is refused; at most 16 folders of at most 1024 characters. The places `/view`
  refuses (`~/.ssh`, the credential stores listed above) and Mesh's own configuration folder
  cannot be a work folder; your home folder itself still can, as it is the default.
- **Concurrent edits.** The file is replaced atomically (temporary file, `fsync`, rename), with its
  current mode, and only if the page's revision is the current one; two tabs cannot overwrite each
  other silently.

### Extra launch options per agent

The "Options" field of "New session" can supply arguments for that launch alone. When saved as
a default, there or in the per-agent editor of "Configuration", Mesh adds them to each new launch
of that preset, including a session an agent asks for.
Saving defaults uses the same elevation as the launch settings
(`POST /api/config/launch-options`, owner cookie only, elevation re-checked inside the write lock,
32 KiB body, revision checked so two tabs cannot overwrite each other).

- **What is checked.** Only the arguments that would make the agent run without approvals and
  without a sandbox (the "codex-yolo" class, listed in
  [Extra options per agent](docs/operations.md#extra-options-per-agent)) and the ones that pick a
  conversation. The check reads the parsed arguments and runs again before each launch. It refuses
  recognized forms, but does not model every argument spelling an agent CLI may accept; treat it
  as a guard rail, not a complete security boundary.
- **What is not checked, and what it means.** Everything else is accepted, by design: `--settings`
  (Claude hooks), `--mcp-config` (an MCP server naming any command), `codex -c mcp_servers.…`
  overrides, an extension path for Pi, or a flag an extension registers. Each of those is code the
  agent or its tooling will run. Stored, it runs at **every** launch of that preset, without a new
  prompt, and a session an agent asks for inherits it: the owner authorised it once, in the
  configuration. Treat this file as owner-trusted configuration, like a shell rc file, and keep it
  out of reach of anything you would not let run commands as you. The confirmation of an
  agent-requested session names the stored arguments, so consent covers what will actually run; the
  approval carries the revision of the options file it was shown, and a save in between makes the
  server refuse it and ask again rather than launch arguments the owner never saw.
- **Restart and downgrade.** The accepted revision and arguments are stored with the decision in the
  private session-request database. A restart uses those arguments, not newly saved defaults. An old
  approved create request without an argument snapshot fails rather than launching; request it again.
  After a downgrade, older servers cannot execute newly bound approvals or approve new create requests
  in that database. Upgrade again to handle them. Restart and account-switch requests are unaffected.
- **A file that cannot be read** refuses agent launches rather than dropping the arguments, because
  one of them may be restrictive (`--no-tools`); the shell keeps working.

### The Codex preset

The "Codex" preset of "New session" starts Codex with its own approvals and sandbox defaults. The
"Codex (no approvals)" preset starts Codex with `--yolo`, Codex's short form of
`--dangerously-bypass-approvals-and-sandbox`: Codex runs every command it decides on without
asking you, and without its own sandbox. Restoring or resuming a Codex session keeps the option it
was started with. Use the second preset only in folders where you accept that. In a launch
settings file, `codex` and `codex-yolo` are enabled separately. That setting governs only the
creation of new sessions: resuming, restoring or adopting a session keeps the command line it was
started with (a session started with `--yolo` stays so), and the "other" preset, a free command,
is never filtered. An agent can never request a `codex-yolo` session through `mesh-board`, even
when the preset is enabled: the request is refused, so one agent cannot obtain an unconfined
sibling. Only you start one, from "New session".

### Native switch input fence (not a checkpoint)

The PTY host accepts private `switch_input_acquire` and
`switch_input_release` control requests with an exact `name`, `created`,
`creation_receipt` and opaque `fence_id`. Acquisition refuses queued or
in-flight PTY input **and any attached legacy raw-input client**; it never
clears the queue. While fenced, new legacy attachments are refused. An
acquired fence stays in host memory across control-socket disconnects and
rejects human input and typed agent notices. A same-terminal
`stop_agent_if` advances the incarnation but retains the fence; while fenced,
`stop_agent_if` and `start_if` require the same `fence_id`. The owned start
command is a distinct control frame that can reach the PTY while ordinary
input remains fenced; release requires that frame to drain and the **new**
incarnation. A wrong owner or stale incarnation cannot release.
If an acknowledgment is lost, the coordinator must reconcile the live
incarnation and retry with its original `fence_id`; a second owner cannot
claim the fence. An explicit release is also the recovery operation when
the switch is abandoned, including after a successful stop (the shell then
has no running agent). There is no orphan timeout or automatic release.
Host/session termination ends the fence together with the PTY.

This is **only** a native input-admission barrier. It does not inspect an
agent's editor, flush buffered input in the browser, establish a durable
checkpoint, or qualify any backend for live switching. Existing raw
attachments have no acknowledgment/retry protocol for `D` frames. A switch
coordinator cannot use this fence with an active legacy terminal attachment;
it needs a negotiated, end-to-end retained-input protocol before an attached
browser can participate. The dormant raw-`D` refusal is defense in depth,
**not** a lossless retry mechanism. A control frame's PTY write does not
prove that the agent started correctly or that its editor was flushed.

### The OpenCode preset

- **OpenCode 1.x and 2.x are supported; any other major is launched bare.** The mesh
  resolves `opencode` (`~/.local/bin`, then the web server's `PATH`), reads `opencode --version` (short
  timeout, no Mesh variable in that process) and names that same executable in the launch line, so the
  version read is the one that runs. For a major other than 1 and 2, or a version it cannot read, it
  injects no configuration, bridge or plugin and starts the agent with `env -u MESH_SESSION_TOKEN`, so the
  token is not in its environment; it warns in the session list and never resumes a conversation for it.
  The shell of the session still holds the token: an OpenCode that you start by hand in that terminal
  inherits it. Likewise, `env -u` removes the token only from the agent's own environment: the shell
  that launched it keeps it, and `/proc/<pid>/environ` of that shell is readable by the same user,
  which is within the "your user account" trust above.
- **OpenCode 2 is always started with `--standalone`.** By default OpenCode 2 runs through one background
  service on a fixed local port that is not bound to `HOME`: the configuration and `MESH_SESSION_TOKEN` of an
  agent would be those of the process that started the service, so one session could act with another
  session's token. With `--standalone` the server, its plugin and the board bridge are children of the
  terminal's own process, with its environment. Earlier terminal-isolation tests on 2.3.0 checked that two
  terminals at once each had their own token in their bridge and plugin reports, and a terminal without
  a token had none. Those tests do not qualify the configuration probe below. Never install OpenCode 2
  with its `curl … | bash` shortcut: it replaces the 1.x binary.
- **Your choices on the board server are kept.** OpenCode 2 replaces the whole `mesh-board` server object
  with the injected one, so a `disabled: true` (1.x: `enabled: false`) would be lost. The mesh reads the
  documents OpenCode reads (global, project, inline) with `opencode api get <target> --standalone`, where
  `<target>` is `/api/config` with a URL-encoded `location[directory]` query parameter naming the working
  directory. This uses a private server, the selected `HOME`, `XDG_*` and `OPENCODE_*` context, and no
  `MESH_*` variables. The mesh does not inject the server when any document disables it, or when the
  probe fails, times out or returns an unreadable response; there is no shared-service fallback. Your
  `permissions` rules are never touched. The same holds for the tracker server, `mesh-work`.
- **The private API probe has version-specific evidence.** The native check was run on
  `2.0.28-native1m.1`, with fresh private `HOME`, XDG directories and a working directory containing
  spaces and punctuation, without system or ancestor configuration. Both the raw API and the Mesh
  adapter preserved disabled `mesh-board` and `mesh-work` entries; no model, account or authentication
  request, real profile or shared service was used. OpenCode 2.3.0 is not verified for this API probe:
  the earlier terminal-isolation and legacy merge tests do not establish that the new command exists
  or works on that version. The fake-CLI probe tests check the adapter contract, not release compatibility.
- **A resumed OpenCode 2 conversation is checked first.** OpenCode 2 creates an empty conversation for an
  unknown `--session`; the mesh looks the id up in OpenCode's store and refuses the resume (and a restore,
  and an adoption, which is checked before the agent is stopped) when it is not there. Options 2.x does not
  have are dropped when they only tune the display or the model, and refuse the launch when they restrict
  the agent (`--pure`, `--agent`) or move it (`--server`).
- **The launch line is visible.** OpenCode takes the board server and the Mesh plugin from the
  environment variable `OPENCODE_CONFIG_CONTENT`. The mesh sets it by typing
  `env OPENCODE_CONFIG_CONTENT='{…}' <opencode> [--standalone]` into the session's interactive shell (the terminal
  host forwards only `MESH_*` variables, and `env` keeps the line valid in csh and tcsh, which
  reject `VAR=value command`). That line therefore appears on the terminal screen, in the replay
  a browser receives when it reconnects, and in the shell's history. For that reason no secret
  may ever enter that block: it holds the path of the board bridge, the mesh port, the
  configuration directory and the plugin path, and the session token reaches the bridge through
  the terminal's environment instead. A test fails if a session token is found in any file of
  a test instance.
- **A project can add a plugin.** An OpenCode configuration inside a project (`opencode.json`) can
  list a plugin, and a plugin runs with the permissions of OpenCode, so it can read the
  environment variables of OpenCode and of the board bridge, which include
  `MESH_SESSION_TOKEN`. OpenCode does not ask you to trust a folder before loading its
  configuration, as Claude Code does for a project's `.mcp.json`. Start OpenCode only in folders
  whose configuration you have read. The token is valid for that session only and allows the
  session-scoped actions listed above, never terminal input. In 1.x, `--pure` starts OpenCode without
  external plugins, which also disables the Mesh plugin; 2.x has no `--pure`.
- **The SQLite store.** For an OpenCode not started by the mesh, and to check a conversation before it
  is resumed, the mesh reads OpenCode's SQLite file (`opencode.db`) to find its conversation. That file also
  holds provider credentials. The mesh opens it read-only, creates nothing when it is missing, and queries
  only the `session`, `message` and `part` tables (1.x) and `session_v2` and `session_message` (2.x); tests
  check each of those points.

### The Gemini CLI preset

- **What is linked, and what Gemini can write there.** A Gemini started by the mesh reads its
  settings from a private directory (`GEMINI_CLI_HOME`, under the mesh configuration directory).
  The mesh itself only reads `~/.gemini`: it copies `settings.json` (with the board server and the
  state hooks added) and creates symbolic links to your other entries, such as `oauth_creds.json`,
  `GEMINI.md`, `extensions`, `commands` and `policies`. Gemini, however, writes through those
  links, into your own `~/.gemini`: an "Allow always" saved in `policies/auto-saved.toml` (which
  then applies to every Gemini you run), an installed extension, a command, `GEMINI.md` changed
  with `/memory`, refreshed credentials. Only the conversations, the checkpoint store and the
  project and state files stay private to the private directory.
- **Trusted folders.** `trustedFolders.json` is not linked: `GEMINI_CLI_TRUSTED_FOLDERS_PATH` names
  your real file, so a trust decision made in any Gemini is shared at once. A revocation is not:
  Gemini keeps the trust it read at start-up in memory, so it applies only to the Gemini sessions
  started afterwards. Gemini enables a folder's MCP servers, hooks and settings only when the folder is
  trusted, and a Mesh-started Gemini follows the same rule.
- **The state hooks cannot block Gemini.** Gemini denies a prompt or a tool when a hook fails with
  output. The hook command ends with `>/dev/null 2>&1 || true`, so it exits 0 without output
  whatever happens to `mesh-event`; a hook that cannot run only leaves the session without state.
- **Token redaction.** With `security.environmentVariableRedaction.enabled` in your settings, Gemini
  removes `MESH_SESSION_TOKEN` from the environment of hooks: the state and the wake notice then
  stop working for that session (the safe direction; nothing is sent without the token).
- **The session token is a reference.** The overlay's `settings.json` holds the text
  `$MESH_SESSION_TOKEN`, never its value.

### Tailscale

`./install.sh --tailscale` is optional. It publishes the web server at the HTTPS root of your node
on your tailnet with `tailscale serve` (never Tailscale Funnel, which would publish it on the
internet). Once enabled:

- every device and user that your tailnet's access rules allow to reach that node on port 443 gets
  the login page; the token is still required, and the cookie is marked `Secure` when the proxy
  reports HTTPS (`X-Forwarded-Proto: https`). The server believes `X-Forwarded-*` headers only on
  a connection from this machine, and only from a proxy that, like `tailscale serve`, keeps the
  browser's `Host` and repeats it in `X-Forwarded-Host`; another kind of local proxy has to be
  declared with `MESH_TRUST_PROXY=1`. Requests that change something must come from the page's
  own origin, scheme included;
- the token, a stolen cookie or a lost logged-in phone gives a shell from anywhere on the tailnet:
  use `mesh-logout-all` for a lost device and replace the token if it may have been seen;
- the installer refuses to publish when the node's HTTPS root already serves something else, and
  `--uninstall` removes only a publication that is exactly its own.

### Reverse proxy on a VPN address

[Serving session-mesh through Caddy on a VPN
address](docs/operations.md#https-on-a-vpn-address-with-a-reverse-proxy) is optional and changes
nothing in the server: it still listens only on loopback, and the proxy must keep `Host` and write
`X-Forwarded-Host` and `X-Forwarded-Proto` itself. Once enabled:

- every machine that the VPN lets reach the proxy's address gets the login page; the token is still
  required, and the same advice as for Tailscale applies to a stolen cookie or a lost device;
- the proxy holds the certificate key and sees the traffic in clear, so it is part of what you
  trust; bind it to the VPN address, never to every interface;
- Caddy's administration API listens by default on `localhost:2019`, and its documentation describes
  no authentication for it. A local user of the machine could load a configuration that sends the
  site to their own program and read the token and the cookie at your next login. Before the proxy,
  that user could reach the server on loopback but could not sign in, except through the routes in
  [Other users on the same machine](#other-users-on-the-same-machine); with the default admin
  endpoint, the proxy adds one more route from that reach to the credential. Move it to a Unix
  socket that only the `caddy` user can open, or turn it off (the operations guide gives the
  settings and puts them in both example Caddyfiles);
- a secret placed in Caddy's environment (the DNS API token of the certificate challenge) is printed
  to the journal at each start by the packaged unit, which runs `caddy run --environ`, and from
  there to `/var/log/syslog` and its rotated files where rsyslog is installed, and to any remote
  log collector: the operations guide shows how to remove that flag and what to do about copies
  already written;
- the server believes the forwarded headers only on a connection from this machine, so anyone who
  can run a program on the machine can already reach the login page directly, without the proxy:
  that reach is not a login;
- the occupation of `127.0.0.1:7690` by another local user while the server is stopped, starting or
  restarting, described in
  [Other users on the same machine](#other-users-on-the-same-machine), applies behind the proxy too:
  the proxy then forwards your login and cookie to that user's program.

### Other limits

- A `?token=` login link (`/login?token=…`) puts the master token in the URL, so it stays in the
  history of the browser that opened it. Prefer pasting the token on the login page, and replace
  the token if such a link was shared.
- On the default loopback installation, the browser talks plain HTTP to `127.0.0.1`. The cookie is
  then not marked `Secure`; this matters only to software on the same machine, which the section on
  local users covers.
- Push notifications go through your browser vendor's push service. They are encrypted and padded,
  and by default carry only the session name and the kind of event; the per-device "details" option
  adds the agent's text, which then appears on that device's lock screen. Answer buttons in
  notifications are off unless `MESH_ANSWER_BUTTONS=1` is set
  ([why](docs/operations.md#answer-buttons-in-notifications)).
- The history index `~/.cache/session-mesh/history.json` contains conversation text and is created
  with mode 0600; the agents' own transcripts keep the permissions those agents give them.
- A release install checks for a newer release at startup and then at most every three hours, from
  the PTY host (a background task of the process that owns the sessions; it starts `curl` as a child
  with a time limit, standard input and error discarded; it writes only `update-check.json` and
  its short-lived working files (`update-fetch.*`, `update-check.json.<pid>.tmp`) in
  `~/.cache/session-mesh`, and only reads the settings file `update-notice` of the configuration
  directory): one
  unauthenticated `GET` of GitHub's public releases API over HTTPS. It sends the headers `Accept`,
  `X-GitHub-Api-Version`, `If-None-Match` (the ETag GitHub gave) and the fixed `User-Agent:
  session-mesh-update-check`, with no version, host name or user data; `curl` ignores any `~/.curlrc`
  (`-q`). GitHub sees the installation's IP address.
  It never downloads or runs anything. It is turned off, without restarting the host (a restart
  ends the sessions), by a line `check=0` in the file `update-notice` of the configuration directory
  (`~/.config/session-mesh`, or `MESH_CONF_DIR`), which the host re-reads at every look; the file is
  ignored when it is a symbolic link, not a regular file of the same user, writable by group or
  others, or larger than 4096 bytes. `MESH_UPDATE_CHECK=0` in the host's environment is the default
  when the file does not say ([Update notice](docs/operations.md#update-notice)).
- The release notes shown by the banner's "What's new" come from that same answer: the host keeps
  the notes of each release (at most 64 KiB each, control characters removed) in
  `update-check.json` and gives those of the announced release to the web server on request; the
  page renders them with the document viewer's sanitizer (DOMPurify: no script, frame, form, style,
  SVG, `id`, `name` or `class`; links only to `http(s)`, opened in a new tab without opener or
  referrer). The notes' images are fetched only when the panel shows them, by the web server
  (`GET /api/update/image`, the owner's cookie only), which has `mesh-platform update-image` check
  and fetch them: an `https` URL that is written in the notes, on `github.com` or a
  `*.githubusercontent.com` name (never an address), resolved to public addresses only and
  fetched from the address checked, at most three redirects each checked the same way, PNG, JPEG, GIF or WebP whose
  bytes match the type (never SVG), at most 5 MiB, no cookie or credential sent, 60 fetches per ten
  minutes at most. The browser itself never contacts GitHub; another image becomes a link.
