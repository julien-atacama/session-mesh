# Operating session-mesh

This page is for the person who runs session-mesh on their machine, after the installation described in
[install.md](install.md). Most operations only touch the web server and leave the sessions
alone. The exceptions say so: restarting or replacing the PTY host ends every mesh session.

The two systemd user units are:

| Unit | Process | Restarting it |
|---|---|---|
| `session-mesh` | the web server (`server.py`) | safe: sessions keep running, pages reconnect |
| `session-mesh-pty` | the PTY host, which owns the sessions | ends every mesh session |

On macOS the same two processes are the launchd jobs `io.session-mesh.web` and
`io.session-mesh.pty`. Each procedure below gives the macOS command next to the Linux one. In them,
`<domain>` is where the jobs are loaded: `gui/$(id -u)` under a graphical login, `user/$(id -u)`
for agents installed without one, and `system` for boot-time daemons, whose commands need `sudo`
([macOS](#macos)).

- [Upgrading](#upgrading): the update notice, a release install, rolling back, a source install
- [Source installs](#source-installs): moving between a clone, an extracted bundle and a release
- [Restoring sessions after a PTY host restart](#restoring-sessions-after-a-pty-host-restart)
- [Replacing the PTY host](#replacing-the-pty-host)
- [macOS](#macos)
- [Complete removal](#complete-removal)
- [Logging out devices and replacing the token](#logging-out-devices-and-replacing-the-token)
- [Answer buttons in notifications](#answer-buttons-in-notifications)
- [Whisper dictation](#whisper-dictation)
- [Documents opened with mesh-open](#documents-opened-with-mesh-open)
- [Making every new terminal a mesh session](#making-every-new-terminal-a-mesh-session)
- [Using another port than 7690](#using-another-port-than-7690)
- [HTTPS on a VPN address with a reverse proxy](#https-on-a-vpn-address-with-a-reverse-proxy)
- [Restricting folders and agents](#restricting-folders-and-agents)
- [Debugging the agent hook](#debugging-the-agent-hook)
- [A second mesh for testing](#a-second-mesh-for-testing)
- [Installer limits](#installer-limits)

## Upgrading

How you upgrade depends on how session-mesh was installed: a *release install* (the `install.sh`
of a release, the default in [install.md](install.md)) runs from
`~/.local/share/session-mesh/current`; a *source install* runs a git checkout in place
([Source installs](#source-installs)).

### Update notice

A release install tells you when a newer release is published: the interface shows a banner
("Session Mesh v0.2.0 is available", a link to the release notes and the upgrade command), the PTY
host writes the same sentence once in its log, when it first announces a release
(`journalctl --user -u session-mesh-pty`),
and `./mesh` (its help and `./mesh doctor`) prints it too. Closing the banner hides it in that
browser until a newer release appears (until the page is reloaded, when the browser's storage is
blocked). Nothing is downloaded or installed: you upgrade with the command shown,
[as below](#upgrading-a-release-install).

How it works:

- The PTY host (`mesh-ptyhost`) runs the check, in a background task, at startup and then whenever
  three hours have passed. It keeps the latest answer in memory; the web server asks the host for it
  (the `update_notice` request) when it lists the sessions and relays it to the page. A web server
  or a host from before the check shows nothing: an older host answers that request with an error,
  and an older web server never sends it. The check is the one `mesh-platform update-check` runs
  by hand, from the cache: a restart within three hours of the last answer makes no request. The
  host runs `curl` as a child process with a time limit of 30 seconds (curl's own limit is 20),
  killed and reaped when it is exceeded and when the host stops, so a slow network never delays
  the sessions or a shutdown, and every failure is ignored. The child's standard input and error go
  to `/dev/null` and only its first 64 bytes of output are read, so a misbehaving `curl` cannot
  fill the host's memory, and the time limit holds even if a killed process leaves a descendant
  holding the pipe. The host writes only the cache below (and its short-lived working files
  `update-fetch.*` and `update-check.json.<pid>.tmp`, in the same directory, removed after each request
  and, when a killed process left them, at startup); it only reads the settings file; the PTY host is not restarted by an
  upgrade, so it follows `current` to report the release you have installed, not the one it was
  started from. It asks GitHub's public releases list
  (`https://api.github.com/repos/Session-Mesh/session-mesh/releases`, first page) with `curl`,
  without credentials, and keeps the answer in `~/.cache/session-mesh/update-check.json`
  (`MESH_CACHE_DIR`). The next request sends the answer's ETag back (`If-None-Match`), so an
  unchanged list costs a small `304` answer. Without an `Authorization` header a `304` still counts
  against GitHub's rate limit (60 unauthenticated requests per hour per IP address); at one request
  every three hours an installation makes at most 8 a day, far below it, which is why the interval is
  three hours. The browser never contacts GitHub.
- What the request carries: `GET` of that URL over HTTPS with the headers `Accept:
  application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent:
  session-mesh-update-check` (fixed, no version, host name or user name) and, once an answer is
  cached, `If-None-Match`. `curl` is started with `-q`, so a `~/.curlrc` (an `Authorization`
  header, `--netrc`) cannot change it; curl still honours the usual proxy environment variables.
  GitHub sees the installation's IP address, as for any request. `./mesh` (help, `doctor`) only
  reads the cache: it never makes a request.
- "What's new", in the banner, shows the release notes of the announced release in a panel of the
  page, rendered like a Markdown document (headings, lists, tables, code, links, images); the link
  to the GitHub release page stays next to it. The notes come from the same releases list: the host
  keeps each release's notes (at most 64 KiB; longer notes end with a pointer to GitHub) in the
  cache and hands those of the announced release to the web server (`GET /api/update/notes`), so
  showing them makes no request. Their images are fetched only when the panel shows them, by the
  web server, never by the browser (`GET /api/update/image`, which runs
  `mesh-platform update-image`): only `https` URLs written in the notes, on `github.com` or a
  `*.githubusercontent.com` name, resolved to public addresses, PNG, JPEG, GIF or WebP up to
  5 MiB, with the same fixed `User-Agent` and no credentials. `curl` makes that request, connected
  to the address that was checked (`--resolve`), and each redirect is checked again before it is
  followed. It goes directly (`--noproxy '*'`), without the proxy environment variables the
  releases request honours; an image that cannot be fetched becomes a link. At most 60 images are
  fetched per ten minutes, counted in `update-image-fetches` beside the cache. A cache written by an earlier version has no notes: its ETag is not sent
  back once, so the next request brings the full list. With `check=0` or `notice=none` there is no
  banner, so no "What's new".
- Drafts and pre-releases are ignored. With no published release, nothing is shown.
- The installed version is the release directory the programs run from
  (`releases/<tag>/`). A source install or an extracted bundle has no such directory: it makes no
  request and shows nothing.
- A failed request (no network, GitHub unreachable, `curl` missing) shows nothing and is retried
  three hours later; `mesh-platform update-check --debug` prints the reason, and the host logs it
  too when `MESH_UPDATE_DEBUG=1` is in its environment. A cache directory that cannot be written
  makes no request at all (the attempt could not be dated), and a request is never made more than
  once in three hours by one host, whatever the cache holds.

Two settings control it, and they apply **without restarting the PTY host** (a restart ends the mesh
sessions). They are lines of a small file, `update-notice`, in the configuration directory
(`~/.config/session-mesh/update-notice`, or `$MESH_CONF_DIR/update-notice`: the directory of the
token and the other settings, [Configuration](configuration.md)):

```
# ~/.config/session-mesh/update-notice
check=0
notice=security
```

- `check=1` or `check=0`: `0` turns the feature off.
- `notice=` one of `all`, `minor`, `major`, `security`, `none` (the table below).
- One `key=value` per line, each key at most once; blank lines, lines starting with `#` and keys
  other than these two are ignored. A key with another value, or set twice, makes the whole file
  unusable.
- The file is optional. Make it with your own user and mode 0600 (`chmod 600`): it is ignored when it
  is a symbolic link, not a regular file, owned by another user, writable by group or others, or
  larger than 4096 bytes. An ignored file changes nothing: the environment values below apply, and
  the reason is logged under `MESH_UPDATE_DEBUG=1` (or shown by `mesh-platform update-check --debug`).

The PTY host reads the file at startup and again at every look (every ten minutes), so the next look
after you save it takes it into account. With `check=0` or `notice=none` that look makes no
request and drops the announcement the host holds: the banner is gone at the next refresh of the
session list, and the next `./mesh` line is empty. Removing the file, or the line, goes back to the
environment values. `mesh-platform update-check` (which `./mesh help` and `./mesh doctor` run with
`--cache-only`) reads the same file, so its line agrees with the host's.

The file **overrides** the host's environment, whose variables remain the defaults when the file
does not set the key (`systemctl --user edit session-mesh-pty`, lines `Environment=NAME=value`; these
are read when the host starts, so changing them applies at its next restart, which ends the mesh
sessions: [Replacing the PTY host](#replacing-the-pty-host)). To disable the check without
restarting anything: `printf 'check=0\n' > ~/.config/session-mesh/update-notice && chmod 600 ~/.config/session-mesh/update-notice`.

| `notice` / `MESH_UPDATE_NOTICE` | Announces |
|---|---|
| `all` (default) | any newer release, patch releases included |
| `minor` | a newer minor or major release |
| `major` | a newer major release |
| `security` | only releases marked as security fixes |
| `none` | nothing, and makes no request |

A release marked as a security fix is announced at every level except `none`, and the banner and
log line say so. When the newest release is not announced at your level but an earlier one newer
than yours is (level `security`, latest `v0.1.5` an ordinary release, `v0.1.4` a security fix), the
notice names that earlier release. The banner and log line carry the security label only when the release they name is itself marked, and the displayed command is `--upgrade --to <that tag>`, so it installs the release the notice names. A newer release is not assumed to contain a fix published on an older line: read the release notes.
A release is marked as a security fix by a line `Security: yes` in its release notes
([CONTRIBUTING.md](../CONTRIBUTING.md#branches-and-versions)).

`check=0` in the file turns the whole feature off: no request, no banner, no line.
`MESH_UPDATE_CHECK=0` in the environment does the same, unless the file says `check=1`, which takes
precedence over it. A misspelt key in the file is ignored without a message, so check that `check=0`
took effect (no announcement at the next poll).

### Upgrading a release install

```sh
~/.local/share/session-mesh/current/install.sh --upgrade            # the latest published release
~/.local/share/session-mesh/current/install.sh --upgrade --to v0.3.0 # a given release
```

A nightly pre-release of `main` (`v<next minor>.0-nightly.<YYYYMMDD>`, published once a night when
CI is green; see [Nightly pre-releases](development.md#nightly-pre-releases)) is installed the same
way, by naming its tag: `install.sh --upgrade --to v0.2.0-nightly.20261118`. A plain `--upgrade`
and the update notice never offer it, because both ignore pre-releases. It is built and attested by
the same workflow as a release and checked the same way, and no user has run it before you:
`--rollback` returns to the previous release.

A nightly installation gets no update notice at all, security notices included: the notice is
only produced for a stable release install (`ocaml/lib/mesh_update_report.ml` ignores a
pre-release). To leave the nightly track, run `install.sh --upgrade --to <stable tag>`, for example
`--to v0.1.1`: a plain `--upgrade` refuses while the latest stable release is older than the
installed nightly (a stable 0.1.x is older than 0.2.0-nightly), and works once a stable release
newer than the nightly is published. From then on the notice works as for any stable install.

`--upgrade` asks GitHub for the latest published release (`/releases/latest`, which never names a
draft or a pre-release), downloads that release's `SHA256SUMS` and `install.sh` over HTTPS, checks
the installer against `SHA256SUMS` and runs it. The new installer checks that the hashes stamped in
it are the lines of that `SHA256SUMS`, then installs its own release as a first install does: the
bundle of your platform (or, for a release without one, its native programs and code archive),
checked against its stamp and extracted into `releases/<tag>/`, beside the release that runs. When `gh` is on your `PATH` and logged in, the
build attestation of the new `install.sh` and of every downloaded file is checked too, against the
release workflow and the tag being installed, and any failure stops the upgrade. Without `gh`, or
with `gh` not logged in, the installer says once that the attestation was not checked and prints
the command to run by hand (`gh attestation verify FILE --repo Session-Mesh/session-mesh
--signer-workflow Session-Mesh/session-mesh/.github/workflows/release.yml --source-ref
refs/tags/<tag>`). Set `MESH_REQUIRE_ATTESTATION=1` to make that a refusal instead: nothing is
installed unless every attestation was checked.

The check needs a `gh` recent enough to support `--source-ref` (tested with gh 2.102.1). An
older `gh` rejects the option; the installer counts that as a failed check and installs nothing,
whatever `MESH_REQUIRE_ATTESTATION` is set to (that variable only decides what happens when `gh` is
missing or not logged in). Update `gh`, or take it off your `PATH` to install with the SHA-256
checks only.

Only then does it change anything:

1. It points `current` at the new release (the old one becomes `previous`) and restarts the web
   server (`session-mesh`), which does not end sessions. Open pages notice the new version and
   reload when nothing is being typed, or on the "⟳ Reload" button of the sidebar footer.
2. If the web server does not answer within about 6 seconds, it points `current` back, restores the
   web unit as it was, restarts the web server on the previous release, and stops with an error. A
   first release install over a source install does the same: it removes `current`, restores the
   checkout's units (on macOS, its web job's plist) and restarts the checkout's web server.
3. It never restarts the PTY host: that ends every mesh session. It says whether `mesh-ptyhost`
   differs between the two releases and, if it does, gives the command to run when you are ready
   (`systemctl --user restart session-mesh-pty`; on macOS `launchctl kickstart -k
   <domain>/io.session-mesh.pty`), after taking the snapshot as in [Restoring sessions
   after a PTY host restart](#restoring-sessions-after-a-pty-host-restart)). `--restart-pty` makes
   the installer run it. Until then the running host keeps the version it started with.
4. It keeps `current` and `previous`, and deletes older releases. On Linux it also keeps the
   release the running PTY host was started from (read from `/proc/<pid>/exe` of the
   `session-mesh-pty` unit's main process), so that a host left running across two upgrades keeps
   its files. macOS has no such record: there an older release is deleted even if the running host
   came from it. The running host is not stopped by that (its program stays loaded), and its next
   restart runs `current`.

**Refusals.** Nothing changes when one of these happens:

- A release older than the one installed: `--upgrade` refuses a downgrade unless `--to` names that
  release. `--upgrade` to the installed release does nothing.
- Services that run another extracted bundle ([Moving from an extracted
  bundle](#moving-from-an-extracted-bundle)): `--upgrade` refuses; run the release's `install.sh`
  with `--switch-from-bundle` instead.
- A unit the installer did not write. The installer acts only on units it wrote itself: the file in
  `~/.config/systemd/user/` with no drop-in, running a program under
  `~/.local/share/session-mesh/current/` (on macOS, the plist's program). A `session-mesh-pty` unit
  with another host, or a drop-in made with `systemctl --user edit`, makes `--upgrade` stop and say
  what to do: to keep the customisation, upgrade by hand; to hand the unit back to the installer,
  remove it and run the release's `install.sh` without `--upgrade` (for the PTY unit, this ends
  every mesh session).
- A source install: `--upgrade` refuses and says to run `git pull`.
- A `SHA256SUMS` that is missing or malformed, an `install.sh` that differs from it, a stamp it does
  not list, a downloaded file that differs from its stamp, or an attestation that fails.

**What the checks rely on.** The installer and `SHA256SUMS` come from the project's GitHub
repository over HTTPS. The SHA-256 checks catch a corrupted or truncated download, not a release
whose files were replaced together with its `SHA256SUMS`. The attestation proves that a file was
built by the repository's release workflow from the tag being installed. Both rely on GitHub and on
everyone who can push to the repository, as described in [What you are
trusting](#prebuilt-binaries).

**Offline.** `--assets-dir /absolute/dir` takes the files of a release from a directory instead of
GitHub: the bundle of your platform (`mesh-linux-x86_64.tar.gz`, `mesh-linux-arm64.tar.gz` or
`mesh-macos-arm64.tar.gz`), or, for a release without one, the eleven native programs of your
platform and `session-mesh-<tag>.tar.gz`; and, for an upgrade, `SHA256SUMS` and `install.sh`. An upgrade from a directory needs `--to`, since the latest release can only be asked
from GitHub.

### Rolling back

```sh
~/.local/share/session-mesh/current/install.sh --rollback
```

`--rollback` points `current` back at `previous` (they swap), restarts the web server, checks that
it answers, and reports the PTY host as an upgrade does; `--restart-pty` restarts it too. It
downloads nothing and needs the previous release still on disk. Installed `mesh-open` and
`mesh-logout-all` links follow the release restored. This also covers older releases that
keep the original Python scripts in `current/app/bin/`.

The server that approves agent mail before waking recipients upgrades `agent-mail.json` to
format 4. Back up that file privately before upgrading if you may return to an older server.
An older server sets the newer file aside instead of using it; do not restore a backup over
the current file without first preserving any mail received since the upgrade.

### Recovering a blocked legacy agent-mail migration

A legacy mailbox migration can stop if a claimed wake covers more than 32 messages,
or if splitting pending wakes would exceed the wake limit. The original mailbox is
left in place. Do not edit the file or delete wakes: a claimed wake might already
have been delivered.

First inspect the affected notifications and **handle their messages manually**.
Recovery marks the selected wake ranges as completed; it does not send them again.
Overlapping parts of other pending ranges are also excluded from future wakes, while
their remaining messages can still wake. Messages and existing permissions are
preserved, but recovery cannot determine whether a previous wake was delivered.

Use the same user, configuration directory and Python environment as the web server.
For a release install, run `cd ~/.local/share/session-mesh/current/app` and use
`../bin/mesh-python` for `python` below. For a source install, run from the checkout
and use its configured Python. Set `MESH_CONF_DIR` to the server's value if it uses
a non-default directory. Coordinate with other mailbox writers while inspecting and
recovering. This makes a private, exclusive backup and prints its SHA-256 and wake
IDs, states and ranges without printing message text:

```sh
python - <<'PY'
import hashlib, json, os
import agentmail

with agentmail._locked():
    data = agentmail.FILE.read_bytes()
    mailbox = json.loads(data)
    backup = agentmail.FILE.with_name("agent-mail.pre-recovery.json")
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    print("Private backup:", backup)
    print("SHA-256:", hashlib.sha256(data).hexdigest())
    for wake in mailbox.get("wakes", []):
        print(wake.get("notification_id"), wake.get("state"), wake.get("target"),
              wake.get("from_seq"), wake.get("through_seq"))
PY
```

The mailbox and backup contain private message text; keep the backup private and do
not publish it. If the backup already exists, choose a new name rather than
overwriting it. Inspect it securely to identify the messages and target session for
each selected range. After handling those ranges, copy the printed digest and selected
notification IDs into these variables and run:

```sh
export MESH_RECOVERY_DIGEST='<printed SHA-256>'
export MESH_RECOVERY_IDS='<notification-id>[,<notification-id>...]'
python - <<'PY'
import os, agentmail
print(agentmail.recover_legacy_wakes(
    notification_ids=os.environ["MESH_RECOVERY_IDS"].split(","),
    expected_digest=os.environ["MESH_RECOVERY_DIGEST"],
    acknowledge_manual_handling=True))
PY
```

The digest is checked while holding the mailbox lock. If the mailbox changed, the
selection is invalid, or another migration blocker remains, recovery fails without
writing: inspect and back up the current file again before deciding what to do. Keep
the backup until migration and message handling have been verified.
### Recovering an orphaned account-switch input fence

If a switch was interrupted, inspect the terminal and both accounts before releasing
its input fence. Releasing the fence does not resume the switch or establish which
account is active. Fence receipts are private: do not publish their contents.

If the request is no longer visible, use the same user and `MESH_CONF_DIR` as the
server. From the server's application directory and Python environment, list the
session name and its original incarnation alongside each recovery handle (no secret is printed).
The incarnation is the one before the stop; a successful stop advances it. The server
checks terminal continuity using the private creation receipt, not this timestamp alone:

```sh
python - <<'PY'
import json, os, re, stat
import meshpaths

for path in sorted((meshpaths.CONF_DIR / 'switch-fences').glob('*.json')):
    if not re.fullmatch(r'[0-9a-f]{64}\.json', path.name):
        continue
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError('not a regular file')
            raw = stream.read(4097)
        if len(raw) > 4096:
            raise ValueError('receipt too large')
        receipt = json.loads(raw)
        if not isinstance(receipt.get('name'), str) or not isinstance(receipt.get('created'), (int, float)):
            raise ValueError('invalid identity')
        print('sha256-' + path.stem, repr(receipt['name']), receipt['created'])
    except (OSError, ValueError, TypeError, AttributeError):
        print('sha256-' + path.stem, 'unreadable; inspect locally')
PY
```

After identifying and inspecting the exact session, open the authenticated Mesh
page's developer console and replace `HANDLE` with its printed `sha256-…` handle:

```js
await fetch('/api/session-actions/HANDLE/recover-fence', {
  method: 'POST', headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({action: 'release_fence'})
}).then(async r => ({status: r.status, result: await r.json().catch(() => null)}))
```

The server refuses a running switch or a replaced terminal. A refused or uncertain
release needs further inspection; it is not permission to replay the switch.

### Inspecting an interrupted legacy account switch

An interrupted legacy switch leaves `.backend-profiles.legacy-switch` in the
server's configuration directory. Its JSON names the original session and request;
the file intentionally blocks migration and another legacy switch after a crash.
The marker does not prove whether the agent stopped, whether the conversation was
copied, or which account is now active. Inspect the session and both account stores
before deciding how to recover; never replay the switch just because a reply was lost.

After resolving the outcome, stop the web server and ensure no migration command is
running. Back up the private marker, then remove it from the same configuration
directory and start the server again. Do not remove `.backend-profiles.lock`.
The marker coordinates only cooperating versions; manual registry writes and older
programs do not honor it.

### Upgrading a source install

```sh
git pull
./install.sh
```

`./install.sh` rewrites the web unit and restarts the web server; `systemctl --user restart
session-mesh` alone is enough when only the code changed. `mesh-open` and `mesh-logout-all` are native programs
taken from the opam switch. When `./install.sh` reports that either is missing from the switch (for
example after a `git pull` from a version where it was a Python script), build the programs with
`MESH_OPAM_SWITCH=<switch> bash scripts/bootstrap.sh --install-only`, then run
`MESH_OPAM_SWITCH=<switch> ./install.sh` again with the same switch. On macOS the latter is `launchctl
kickstart -k <domain>/io.session-mesh.web` (with `sudo` for the `system` domain).

A change to the PTY host itself (a rebuilt `mesh-ptyhost`) takes effect only when that process
restarts, which ends the sessions. Do it deliberately, with the procedure below.

An installation from a version with the Python PTY host has a `session-mesh-pty` unit that runs
`ptyhost.py`. After `git pull`, `./install.sh` refuses to continue until that unit is replaced, and
if the unit restarts first, `ptyhost.py` exits with status 78 and prints the commands, so
`systemctl --user status session-mesh-pty` shows it failed and no PTY host runs. Replace it as in
[Replacing the PTY host](#replacing-the-pty-host), or move to a release install, whose installer
replaces that unit itself ([Moving a source install to a
release](#moving-a-source-install-to-a-release)).

## Source installs

A source install runs a git checkout in place: the web unit runs `<checkout>/server.py`, and the
native programs come from `--ptyhost`, from `PATH` or from your opam switch
([Native PTY host](install.md#native-pty-host)). It is the developer path; `--upgrade`, `--rollback`,
`--restart-pty` and `--assets-dir` belong to release installs and are refused there.

A *bundle install* runs an extracted bundle in place: `./mesh install` in that directory runs its
`app/install.sh`, and the units run `<bundle>/bin/mesh-python <bundle>/app/server.py` and
`<bundle>/bin/mesh-ptyhost`, with the bundle's own Python and programs. It follows the rules of a
source install, except that the bundle brings its PTY host (`--ptyhost` is refused) and is not
upgraded in place: extract the newer bundle elsewhere and move to it as below, or install a
release. In an installed release (`~/.local/share/session-mesh/current/mesh install`), `./mesh
install` runs that release's own `install.sh` instead.

### Moving a source install to a release

Run a release's `install.sh` as for a first install. It recognises the units that an earlier
installer wrote for a checkout, says that it replaces them, and points them at
`~/.local/share/session-mesh/current`:

- the web unit that runs `<checkout>/server.py`, keeping its port;
- a PTY unit that runs the removed Python host (`<checkout>/ptyhost.py`). The unit file is
  rewritten, and the host is not restarted: a running one keeps running, and the installer gives the
  restart command.

A PTY unit that runs a native `mesh-ptyhost` you chose (from `--ptyhost`, `PATH` or the opam
switch) is left as it is, with a warning: the web server then runs from the release and the PTY host
stays yours. `--upgrade` refuses until that unit is replaced ([Replacing the PTY
host](#replacing-the-pty-host)). No configuration or data moves, and the checkout is not changed.

### Moving from an extracted bundle

An account may already run session-mesh from an extracted bundle: an earlier `./mesh install`, or
a bundle unpacked by hand, for example under `~/.local/libexec/session-mesh/releases/<name>/`. The
installer recognises those services by their shape: a web unit that runs `<D>/bin/mesh-python
<D>/app/server.py`, or a PTY unit that runs `<D>/bin/mesh-ptyhost`, where `<D>` holds the bundle's
`env.sh` and `libexec/mesh-ptyhost`. A release install, a bundle install of another directory or a
source install then leaves them as they are: it stops before changing any unit and names the
option. (A release install has already extracted and checked its release under `releases/<tag>/`
by then; no service uses it.)

```sh
bash install.sh --switch-from-bundle      # a release's install.sh; also ./mesh install, ./install.sh
```

With `--switch-from-bundle`, the installer says what moves and what stays, then:

- rewrites the web unit for the new installation and restarts the web server, keeping its port;
  if the new web server does not answer, it restores both unit files and restarts the old web
  server, never the PTY host (on macOS, only a release install goes back this way);
- on Linux, rewrites the PTY unit for the new installation without restarting it: the running PTY
  host and its sessions keep running the old bundle's program until it restarts (which ends every
  mesh session), and the installer gives the command; on macOS, the PTY job is preserved, since
  launchd cannot point it elsewhere without stopping the host;
- never deletes anything of the old bundle. Remove `<D>` yourself, only after no unit runs from
  it and the PTY host has restarted (`systemctl --user show session-mesh-pty -p MainPID`, then
  `readlink /proc/<pid>/exe`, names the program it runs).

Configuration and data (`~/.config/session-mesh`, `~/.cache/session-mesh`) do not move, and the
token is kept. `--switch-from-bundle` cannot be combined with `--upgrade`, `--rollback` or
`--uninstall`.

**Drop-ins on the units.** A drop-in of `session-mesh.service` or `session-mesh-pty.service` (a
`.conf` file under `~/.config/systemd/user/<unit>.d/`, such as one made with `systemctl --user
edit`) that sets `ExecStart=`, `Environment=`, `EnvironmentFile=`, `UnsetEnvironment=` or
`PassEnvironment=` overrides the command and environment the installer writes: after a switch, the
unit would keep running what the drop-in says and the installer could not tell. On Linux, a release
install, a bundle install and every switch therefore stop before changing a unit or `current`, and
name the drop-in and the settings it overrides; a release install has by then downloaded and
checked its release into `releases/<tag>`, which a rerun uses. When the drop-in sets `MESH_PORT`,
the refusal says so. The
installation's own unit then provides the server, so the migration is by hand and happens before
the switch: move the drop-in aside (or remove it), reload systemd, and run the installer again.

```sh
mv -- ~/.config/systemd/user/session-mesh.service.d/override.conf{,.disabled}
systemctl --user daemon-reload
bash install.sh --switch-from-bundle
```

systemd reads only `*.conf` files, so the renamed file no longer applies and stays for reference.
A port the drop-in set is given to the installer instead (`MESH_PORT=7691 bash install.sh
--switch-from-bundle`). Any drop-in, even one without those settings, makes a later `--upgrade`
refuse (see "Refusals" in [Upgrading a release install](#upgrading-a-release-install)), so other
customisation is kept by hand. The installer never edits or removes a drop-in. A source install
still reads `MESH_PORT` from a drop-in.

### Moving a release install to a clone

From the checkout, run `./install.sh --from-source` (or `--ptyhost /absolute/path`). Without one of
them, the installer refuses and names both choices. It says what it does, then removes the link
`~/.local/share/session-mesh/current`, keeping the release directories, and from then on everything
runs from the clone: the web unit, the mesh commands, and the board MCP server, which agents now
take from the opam switch. The PTY unit the release install wrote is rewritten for the clone's host
and not restarted; the running host keeps the release's program until you restart it. A PTY unit
the release install did not write is left as it is. If the clone's web server does not answer, the
installer points `current` at the release again, restores both unit files and restarts the
release's web server, never the PTY host.

## Restoring sessions after a PTY host restart

While it runs, the web server keeps a snapshot of the sessions in
`~/.config/session-mesh/sessions-snapshot.json` (mode 0600, refreshed every 10 seconds, even with no
page open): name, folder and, for a Claude Code or Codex session, the conversation id and its
options. After a PTY host restart, the sidebar offers to restore them. Nothing restarts without a
click, so an agent launched with permissive options never comes back on its own.

1. `systemctl --user restart session-mesh` (macOS: `launchctl kickstart -k
   <domain>/io.session-mesh.web`), so that the web server runs the current code and writes the
   snapshot. Sessions are not touched.
2. Check that `~/.config/session-mesh/sessions-snapshot.json` exists (about 10 seconds) and lists
   your sessions.
3. `systemctl --user restart session-mesh-pty` (macOS: `launchctl kickstart -k
   <domain>/io.session-mesh.pty`). The sessions end.
4. Reload the page, keep the sessions you want checked and click "Restore N sessions". Each session
   returns under the same name and in the same folder. An agent resumes **the same conversation**
   (`claude --resume <id>` or `codex resume <id>`, with its options); other programs (an editor, a
   build) come back as a plain shell. "Ignore" dismisses the offer.

   A Codex session started as `codex resume <id>` (every Codex the mesh restores or resumes) that
   holds no rollout file open gets its conversation id from its launch arguments, read from the
   running process. The launch arguments say where the session started, not always what it runs
   now: after `/new` or `/resume` inside Codex they can name an older conversation. So the id is
   withheld when the session's folder has a later conversation: a rollout of another id written
   since the process started and after the named one, which no other running Codex holds open or
   was launched on. The session then gets the folder rule below (an id only for the one Codex of the
   folder). A `/resume` of a conversation of another folder leaves no such trace, and the restore
   then reopens the conversation the session was launched on. While the Codex holds a rollout open,
   that rollout is used (the web server log says once per process when it differs from the
   arguments). Each listing of the sessions reads the id again, so the snapshot keeps what the last
   listing saw.

   An id read from the launch arguments is withheld, and no id is inferred from the folder either,
   when another running Codex may run the same conversation: one of its arguments is that id (case
   ignored), it was started as `codex resume` with no readable id (the picker, `--last`, an option
   that is not in Codex's option table), or it holds that rollout open. A helper process of the same
   Codex is not another Codex. When another session reports the same id from any source, both lose
   it. The snapshot marks this id `argv`, but for Codex that changes nothing: the restore reopens it
   exactly like an id from an open rollout or from the folder rule.

   A Codex session that holds no rollout file open and was not started as `codex resume <id>` has no
   certain conversation: the server infers it
   from the newest rollout written in the folder, and only when exactly one Codex runs in that folder,
   no other Codex of the host holds that rollout open, and the process table could be read. In any
   other case (two Codex in one folder, an unreadable process table or file list of a Codex of the
   same user, the same inferred id reported by two sessions) the session has no conversation id and
   is restored as a plain shell rather than possibly resuming another session's conversation. A
   conversation id observed exactly (rollout held open, reported by a hook) is never dropped this
   way, except when it collides with an id read from launch arguments.

   Limits: the rule protects an idle Codex only while the other Codex is still running. If that
   other Codex has already exited after writing its rollout, or if a `codex exec` run in the same
   folder has finished (its rollout `source` is the plain string `exec`, not recognised as a
   sub-agent), the idle Codex can still be given that rollout's conversation. The identity registry
   below keeps an id once it is known exactly, but a session it does not know still gets this rule.

   **The identity registry.** Next to the snapshot, `~/.config/session-mesh/session-identities.json`
   (mode 0600, replaced atomically under a lock, at most 400 entries) keeps the conversation of each
   session once it is known exactly, with where it came from: named by the mesh before the agent
   started (`chosen`), reported by the agent's hook (`hook`), or seen without doubt by a listing
   (`observed`: the rollout a Codex holds open, the file Claude writes for its process). A guess is
   never written there. The snapshot is rebuilt from each listing; the registry is not: a Codex that
   held its rollout open once keeps that id after it closes it. A later exact fact for the same
   session replaces the earlier one (`/clear`, `/new`, an agent started again in the terminal), with
   two exceptions. A listing never replaces an id that a hook reported or the mesh chose for the same
   agent process, because it may have been read before that report; a listing of a process started
   later does. "Later" means more than two seconds after the start time the entry holds, or, when it
   holds none, after the entry was written. A report that carries no start time (a hook) leaves the
   entry with none: it does not say which process sent it, since the agent may have been started
   again in the terminal since the known start. A late report from a process older than the one
   recorded is ignored. When the
   400-entry cap is reached, the entries of sessions the PTY host no longer lists are dropped first.

   When the file is created, the exact ids already in the snapshot are copied into it as `observed`:
   the ones a hook reported, and a Claude id, which only Claude's process file gives. A launch argument
   and a Codex id stored without a source (possibly the pick of the lone Codex in a folder) are not
   copied. A restore reads the registry first, and the snapshot's id only for a session the registry
   does not know, so these sessions still restore as before. The restore offers on the page are
   computed the same way, so an offer shown as resumable is one the restore resumes. A file written
   by a newer version, whatever its content, is read as empty and left untouched. A file that cannot
   be used (not valid JSON, nested too deeply, not a private regular file, too large) is read as empty
   and replaced by the next write (a directory in its place is read as empty too, and each write fails
   and is logged; a launch then starts nothing); the server log then has one line saying so, without ids or paths.

   The mesh records `chosen` ids before the agent starts: a new Claude session is launched with
   `claude --session-id <uuid>` (a random UUID the mesh picks), and a restore or a resume from the
   History records the conversation it reopens. Nothing is started when that record cannot be written,
   or when another running session holds the conversation, in the listing or in the registry, whatever
   the source of its entry. The registry also covers a session that no listing can identify, such as
   an idle Codex that has closed its rollout. The refusal reads `This conversation is already running
   (another session): nothing was started`. A launch refused by the PTY host drops its record; a
   launch whose outcome is unknown, or which was cancelled after its request was sent, keeps it,
   because the session may still appear. The Claude hooks the mesh installs send the conversation id
   each hook carries, so the registry follows a `/clear`. The hooks of OpenCode, Gemini, Antigravity,
   Copilot and Vibe send theirs already. As in the session list, those of Gemini, Antigravity and Vibe
   only fill in a missing id and never replace the one the registry holds. No Codex hook is installed:
   a Codex's id comes from its launch or from a rollout seen open.

   When two sessions claim one conversation, the stronger source keeps it: `chosen` over `hook` over
   `observed`, then the session that holds the rollout open, and when they are equal the session that
   held it first. The other session is *contested*: it has no conversation until it reports another
   one or the holder goes. A holder the PTY host no longer lists (a lost offer, a session that ended)
   loses to any claim of a session it lists, whatever the sources, as it is no holder for a launch
   either. A listing compares with the host list it read; a hook report compares with the newest host
   list recorded, or with none when that list is more than 25 seconds old (a silent host). Either way,
   a session whose entry was written after that list was read (one launched since) counts as listed.

   One id has one active holder among the sessions a merge compares. A launch over a lost offer may
   leave two `active` entries of one id (the offer's entry is set aside for the launch, then kept as
   it was); no case runs two agents on it, because a launch and a restore are refused while a listed
   session holds the id. Two limits remain, as before the registry. A live session that is contested
   but still runs the conversation (an idle Codex that closed its rollout) does not hold it, so a
   restore may start a second agent on it. A restore that races the first hook report of a live
   session nobody could identify starts a second agent, and that session then becomes contested.

   An agent is never relaunched on a conversation that is contested, unknown, or no longer on disk
   (no Claude transcript, no Codex rollout of that id, looked for under `$CLAUDE_CONFIG_DIR` and
   `$CODEX_HOME` as well as in the home folder; when none of these folders exists, nothing is taken
   to be gone): the session comes back as a plain shell in its
   folder, with one line typed there that says why, for example `Session Mesh: codex not relaunched:
   its conversation is claimed by another session (contested)`; the restore result carries the same
   reason. A new conversation is never started in its place. A guarded restore (below) refuses such an
   offer instead (`not-resumable`), and refuses with `expected-mismatch` when the registry names
   another conversation than the expected one, or names one when the offer expected none.

### Restoring exactly one offer (for tools)

A tool that must never restore twice, or from an outdated offer, first reads `restore_guard` in
the answer of `GET /api/sessions` (`"exact-v1"` on a server that implements the guard below) and
**never targets a server that does not announce it**: an older server runs the same body as a
page restore, without any guard (it answers `ok: true` even when the name is taken or `expected`
is wrong, and can start a second agent on the conversation), and checking `guarded: true` in the
answer comes after the damage. The check is made before the send, not on the answer. It then sends
the offer it saw in `restorable` with its precondition: `POST /api/restore` with the body
`{"names": [N], "expected": {"name": N, "created", "agent_kind", "resume_id", "cwd"}}` and nothing
else (cookie or master Bearer token, as for the page; never a session token). `names` is exactly
the one name `N`. `created` is the finite number of the offer (not a boolean), `cwd` its exact
path, `agent_kind` is `shell` (an offer without agent) or one of the resumable agent types the
server knows (`respawn.AGENT_TYPES`: today `claude`, `codex`, `pi`, `opencode`, `gemini`, `agy`, `copilot`, `vibe`; the list grows with it), `resume_id` the
conversation id, or `null` (always for `shell`). The server restores that offer only if it still
equals `expected`, the target name is exactly free (the session is created under `N`: no `-2`
suffix and no `unique_name`; a collision in the PTY host is a refusal too) and the conversation is
not running. An identified agent offer that has no conversation id is **not** degraded to a shell:
it is refused. All checks run under the restore and organisation locks, before the PTY is created.

The answer keeps the page's envelope, with status 200 (the one exception is a 5xx raised by the
checks before the intent is written, see below): `{"results": {N: result}}`. Success:

```json
{"ok": true, "id": N, "created": <the new session's creation date>, "resumed": true,
 "guarded": true, "previous": {"name": N, "created": <the offer's date>}}
```

`created` is the real incarnation just created, the identity to bind later requests to. Any
failure is `{"ok": false, "code", "phase", "error", ...}`; `phase` says what **this request** may
have created (`not-started`: nothing; an earlier request of the same tool may have):

| `phase` | `code` | Meaning |
| --- | --- | --- |
| `not-started` | `not-found` | no such offer: unknown name, already restored or discarded, or its folder is gone. After a success whose answer was lost, or a `completion-failed` whose retry finds the offer already dropped, the session **exists**: look for it by name |
| `not-started` | `expected-mismatch` | the offer differs; `mismatched` lists the fields (`created`, `agent_kind`, `resume_id`, `cwd`) |
| `not-started` | `target-occupied` | a session already has that name, or a restore of this very offer was sent by the page a moment ago (under 120 seconds) and its outcome is unknown: the session may be about to take it |
| `not-started` | `conversation-running` | the conversation is already running, was restored (or its creation attempted) in the last 120 seconds, or is being resumed from the history |
| `not-started` | `not-resumable` | an identified agent whose conversation id is unknown |
| `not-started` | `launch-refused` | refused for good: before anything was sent to the PTY host (policy: folder outside the allowed roots, unreadable conversation, Gemini settings; Pi unavailable; the host's listing failed) or by an error reply of the host to the creation; `status` is the refusal's HTTP status (503 for the Pi and listing cases). The intent is withdrawn so that repeating is allowed; if withdrawing it fails to be written the intent stays and a repeat answers `restore-interrupted` |
| `not-started` | `not-restored` | the restore intent could not be written; no session was created. Repeat the same request. The write may nevertheless have reached the file (only the directory sync failing): the server then withdraws it, and if that fails too the repeat answers `restore-interrupted` (use "Ignore"); the message says so |
| `created` | `completion-failed` | the session exists (`id`, `created`) but the board transfer or the snapshot update failed: repeat the same request |
| `uncertain` | `restore-interrupted` | the offer is marked as being restored but no session carrying its nonce is running (it ended, another session holds the name, the creation never happened, or the host does not show it yet): repeat the request, or use "Ignore" |
| `uncertain` | `host-error` | the PTY host did not confirm the creation (timeout or transport error), or did not answer the check that follows it: the session may exist or appear later; repeat the same request |

A malformed body (shape, `names` other than `[expected.name]`, types, lengths, a number too large
for a float) is a 400 with a plain-text message; authentication failures keep the route's 401 or
403. A 5xx from a failure before the intent is written (the PTY host cannot be listed) means
nothing was created. Once the intent is written, no PTY host error is ever a 5xx: it is a
`host-error` answer (`uncertain`), or `completion-failed` (`created`), in the usual envelope.

What the mechanism guarantees, and its limits:

- Before creating the shell, the server writes (and fsyncs, directory included) an intent on the
  offer: `restoring: {"nonce"}`. The same nonce is put in the session's host meta (visible in the
  host's `list`). If that write fails nothing is created and the code is `not-restored`
  (**repeating is allowed**, with the caveat of the table above).
- A request cancelled between the intent write and the creation (a handler cancelled in that
  instant, for example by a shutdown) leaves an intent with no session: the offer then answers
  `restore-interrupted` for good, which is safe (nothing runs) but needs "Ignore".
- If the session was created but its board transfer or the snapshot update failed, the code is
  `completion-failed` (`phase: "created"`, with `id` and `created`); **repeating the same
  request** finds the session by its nonce and completes the transfer without a second shell. A
  server crash after the intent is written is covered the same way.
- If no session carrying the nonce runs (it ended, the creation never happened, or another session
  took the name), the code is `restore-interrupted`: the server cannot tell "never created"
  from "created and ended", so it never recreates. Use "Ignore" and restore from a fresh offer.
- The intent is withdrawn only on a **final refusal**: an error reply of the host to the creation,
  or a refusal raised before anything is sent (the name is taken, folder outside the allowed roots,
  Pi unavailable, the host's listing before the creation failing). A timeout, a cancelled request
  or any transport error after the creation was sent is **not** final: the host may still create
  the session (the native host does so in a fiber while it already serves `list`). The intent
  stays, the conversation is held for 120 seconds, the answer is `host-error` (`uncertain`), and
  every later request, the exact one or the page's, is resolved by the nonce. If withdrawing the
  intent fails to be written it stays too.
- The same rule holds for every path that starts an agent on a conversation, and the 120-second
  hold is shared: after a creation sent to the host whose outcome is unknown (timeout, transport
  error, cancellation), the page's "Restore" and the History's "resume" hold the conversation
  exactly like the exact restore does, so no path starts a second agent on it. The same holds after
  a reply of the host that the server cannot read (a malformed answer, after the send), and after a
  History resume that succeeded (the new agent shows in no listing until it has opened its
  transcript). The page's restore of an offer without conversation (a shell) holds the offer itself
  for the same 120 seconds, so a second click after a timed-out one starts no second shell; the
  offer is held as well when the session was created and the listing that confirms it, or the end
  of the path, then fails or never answers (the session exists, the offer is not settled). A
  refusal that came before the send holds nothing, and a connection to the host that fails before
  anything is written counts as such a refusal: nothing was created, so the guarded restore
  withdraws its intent and a retry is allowed (it does not answer `restore-interrupted`). A resume cancelled while it waits for a lock is held too (it
  cannot tell it from a cancelled send).
- What is held is in the memory of the web server: the conversations of `recent_conversations` and
  the offers held for a shell (`HELD_OFFERS`) are forgotten when the web server restarts, and after
  120 seconds. A restart of the web server in the middle of a page restore therefore loses the hold;
  the durable protection is the intent of the guarded restore (`restoring`, written before the
  creation), which a tool uses instead of the page's button when "never twice" matters.
- "Ignore" deletes the offers **and the agent mail retained for them** (mail is kept for an offered
  incarnation for 24 hours; with the offer gone nothing can receive it, and it is pruned). The bar
  says so under its buttons. After a restoration that returned warnings (the mail was not
  transferred and stays at the old identity, or the session came back under another name), the page
  shows them next to the result by session name; the offer stays until it is restored again or
  ignored. A transfer that cannot complete is repeated by the same restore request of the guarded
  path; `agentmail.transfer_incarnation` is idempotent and can be run by hand from the owner's
  account to move the mail of an old incarnation to the new one.
- `restore_lock` and `organisation_lock` are held across the calls to the PTY host (each with a 5
  second limit; the worst case of one exact restore is about 6 calls), so a slow host delays every
  other restore, move and rename for that long. They are not changed here. A History resume
  records its conversation in the 20-second guard before it gets `restore_lock`: a restore that
  arrives while the resume still waits is refused as `conversation-running`, safely but earlier
  than strictly needed.
- A session listing that takes the organisation lock (the page's, the snapshot loop, the
  restores' own) reads the PTY host inside it. Read before the lock, a listing that waited for a
  restore pruned the organisation with a list older than the restore, and erased the label, folder
  and rank the restore had just given the new session (seen with a client polling `/api/sessions`
  while exact restores ran). The visible consequence: such a listing now waits behind a restore or
  a move in progress, for the duration of their host calls. Lock order is unchanged:
  `restore_lock`, then `organisation_lock`.
- `new_session(exact=True)` lists the host again before the creation; the exact restore has
  already checked the name, so that second listing is redundant (it only narrows the window between
  check and creation, and its failure is a refusal before the send).
- A session the owner renamed has a label (in `mesh.json`); the host keeps the generated name, and
  the History row shows the label. A History resume starts a new incarnation under a free generated
  name and gives it back the label the conversation last had (kept in `conversation-names.json`,
  bound to the conversation id of Claude, Codex or Pi, so it survives a stop and a server restart).
  The last label wins, including a cleared one. A label belongs to the conversation the session was in when
  it was given (not to the ones that ran in it before a `/clear` or a resume), and a label given while the
  conversation is not known (Pi after `/new` with two transcripts, or a Codex that holds no rollout open, whose conversation the
  mesh can only guess) is applied to none. Known limit: the mesh learns of a switch of conversation (`/clear`, `/new`) from its
  next inventory of the sessions, so a rename made before that inventory has seen the switch is still recorded on the earlier
  conversation. When a live session already shows that label (as
  its label or its host name) the resume does not apply it, and the session keeps its generated
  name. Only the label is carried: a session stopped on purpose leaves no folder or rank to restore.
  A failure to apply the label is logged and never fails the resume (the agent is already started).
- A conversation restored in the last 120 seconds (or whose creation was attempted without a
  confirmation) is refused as `conversation-running` even if no listing shows its agent yet, so two
  offers sharing one `resume_id` never start two agents. The History's "resume" and the restore
  consult each other: a resume within those 120 seconds answers 409, and a restore of a
  conversation the History is resuming (during its 20-second guard) is refused. This memory is
  kept in the server's memory only: **a server restart forgets it**, and for up to 120 seconds
  after the restart an agent just started that no listing shows yet is not protected (the intent
  marker on the offer, which is in the snapshot file, still is).
- The page's restore (`{"names": [...]}`) refuses an offer carrying the intent ("An exact restore
  is in progress for this offer: repeat the exact request, or discard the offer") and creates
  nothing.
- Retrying after a success whose answer was lost finds `not-found` (phase `not-started`: this
  request created nothing): the restore happened (look for the session by name), but the tool
  cannot tell it from an offer restored by someone else.
- Rolling back to an older server: it does not know the intent. Its snapshot validation keeps the
  offer but drops the `restoring` marker in memory; it writes the file only when the state changes,
  so the marker stays on disk and reappears when the new server returns. The offer is restorable
  again from the page of the older server: it creates a suffixed session (`N-2`), and for an agent
  offer it starts a second agent on the same conversation whenever its `running_conversations`
  does not see the first one (an agent just started shows in no listing yet). Finish or ignore
  marked offers before rolling back.

What is lost: the screen content and any work in progress at the moment of the restart. A folder
deleted in the meantime is not recreated (the session goes to the top of the list). If step 1 was
skipped and the web server still ran older code, there may be no snapshot and nothing is offered.
The last session of a mesh that ended on its own may also be offered by mistake: use "Ignore".

Agent mail (messages between agent sessions) is kept for 24 hours after the loss and moves to the
restored session of the same conversation. The offer itself lasts 14 days: a restoration after 24
hours succeeds without the mail and says "mail expired". Pending mail counts against the mailbox
limits meanwhile, so many unrestored agents can make senders get "mailbox full": ignore the offers
you do not want. If the mail could not be moved, the restored session is running and the result
carries a warning; the offer stays and the mail waits for the old identity (ignore the offer to
release it).

## Replacing the PTY host

The PTY host is the native `mesh-ptyhost`. The installer chooses it only when no `session-mesh-pty`
unit exists, and otherwise refuses `--ptyhost` and `--from-source` (except when moving a release
install to a clone, [Source installs](#source-installs)). Replacing it, for example handing a PTY
unit you wrote back to a release install, or moving a source install from the Python host of an
earlier version (a source install recognises a unit that runs `ptyhost.py` and refuses with these
commands), means removing that unit first, which **ends every mesh session** (take the snapshot
first, as in steps 1 and 2 above):

```sh
systemctl --user disable --now session-mesh-pty
rm ~/.config/systemd/user/session-mesh-pty.service
systemctl --user daemon-reload
systemctl --user reset-failed session-mesh-pty   # only if the unit had failed; see below
~/.local/share/session-mesh/current/install.sh   # release install; from a clone: ./install.sh [--ptyhost PATH]
```

A source install needs the native host first, built or obtained ([Native PTY host](install.md#native-pty-host)). The installer
creates a PTY unit only when systemd no longer knows it at all: a unit that had failed keeps its
"failed" state after its file is removed, and the installer refuses with "PTY configuration is
masked, incomplete or ambiguous" until `systemctl --user reset-failed session-mesh-pty` clears it.
A drop-in directory `~/.config/systemd/user/session-mesh-pty.service.d/` blocks it in the same way;
remove it too if you created one.

The PTY host's socket is `<runtime>/session-mesh/ptyhost.sock`, where `<runtime>` is the first of
these that is set and non-empty:

1. `MESH_RUNTIME_DIR`;
2. `XDG_RUNTIME_DIR`;
3. a default: on Linux `/run/user/<uid>`; on macOS
   `~/Library/Application Support/session-mesh/run`, where `~` is your home directory as the user
   database records it (not `$HOME`, so that a program run with another `HOME` still finds the
   socket). Other systems have no default and need one of the variables.

The server, the clients and `install.sh` apply the same order, without validation
(on macOS, a rerun of `install.sh` first keeps the directory of an installed PTY job), so on both
systems every program of your account finds the socket without any variable set. Only the native
host (`mesh-ptyhost`) validates the directory, and on macOS it also creates the default one:
`~/Library/Application Support` must exist (it does on every macOS account), and the `session-mesh`
and `run` directories below it are created with mode 0700, a symbolic link in their place being
refused. It refuses to start, with one `not starting` line and status 1, unless the directory is an
absolute canonical path (equal to its real path: a trailing slash or a symlink is refused), a
directory owned by you, writable neither by group nor by others, and short enough for the platform's
socket path limit (`sun_path`): the socket path `<runtime>/session-mesh/ptyhost.sock` may have at
most 107 bytes on Linux and 103 on macOS. On macOS the default directory fits for a user name of up
to 25 bytes; with a longer one, the host and the installer refuse and ask for a shorter
`MESH_RUNTIME_DIR`. The `/run/user/<uid>` guess must also be mode exactly 0700. An invalid
`MESH_RUNTIME_DIR` is an error, never a reason to try `XDG_RUNTIME_DIR`. Sessions keep
`MESH_RUNTIME_DIR`, so `mesh-attach` and `mesh-rename` inside them find the same socket (an isolated
agent, started under another account, gets neither variable). `mesh-platform runtime-dir` prints the
directory the native host would use ([macOS](#macos)).

A stopped PTY host can leave its socket, `<runtime>/session-mesh/ptyhost.sock`, behind: a
host killed with SIGKILL, or a unit written by an installer older than `RuntimeDirectory=` (units
written now let systemd remove that directory when the host stops). When the PTY unit is stopped,
the installer removes that file only if it is a socket of your account on which nothing accepts a
connection, and says so. Otherwise it refuses and prints the remedy: check that
`systemctl --user status session-mesh-pty` shows the unit inactive and that no PTY host started by
hand is running, then remove the file with `rm --` and run the installer again.

### Terminal modes in a cut replay

A browser that opens a session first receives the last 2 MiB of its output, the replay. A
full-screen program such as pi, OpenCode, Copilot or Antigravity turns on the alternate screen and
mouse reporting once, when it starts; after it has written more than 2 MiB, those sequences are no
longer in the replay. The PTY host follows a small set of terminal modes in the output it trims
(alternate screen, mouse tracking and its encoding, focus reports, bracketed paste, autowrap,
cursor visibility, application cursor keys and keypad) and starts a cut replay with the sequences
that set them as they were where the replay starts. A browser opened late is then in the program's
modes, and the wheel reaches the program. Nothing is sent to the program, and a replay that still
holds the whole output is unchanged. This is done by the PTY host, so it takes effect after a PTY
host restart, which ends every session. The menu action that restores the full-screen scroll by hand
stays, for older hosts.

The modes are those of the terminal in the browser (xterm.js 5.5), which the host follows as that
terminal parses the output. Alternate scroll (mode 1007) is not restored, because xterm.js 5.5 does
not implement it. When the replay starts inside a title, a DCS payload or another string sequence,
the rest of that sequence is not sent, so it does not appear as text, provided its end (or the
start of another sequence) lies within the first 4096 bytes of the replay; otherwise the replay is
sent whole and that rest may appear as text. One family of cases is not followed: an eight-bit
control introducer written as UTF-8 (bytes C2 9B for a CSI, C2 9D for an OSC, and so on, rather than
`ESC [` or `ESC ]`) outside any sequence. Programs do not send them, and looking for them would slow
the host's scan of all non-ASCII output. Two consequences follow. A C2 9B inside a string that an
eight-bit introducer opened is not seen by the host, although xterm.js applies it. And a replay
that starts inside a string opened by an eight-bit introducer shows the rest of that string as text,
as it did before.

## macOS

macOS support is best effort: the project fixes what blocks it, and further work follows issues and
pull requests. The limits are listed below.

On macOS the native PTY host, the web server, the installer, agent detection in mesh sessions and
in other terminals, recovery from a stale socket, and the `/view` document viewer work as on Linux.
Besides your home directory and `/tmp`, the viewer also serves documents from your private
temporary directory (`/var/folders/…/T`), where macOS programs write their temporary files. The
server asks the system for it once at start (`getconf DARWIN_USER_TEMP_DIR`) and does not read
`$TMPDIR`, which a launchd job may not have. It is used only if that directory lies under
`/private/var/folders`, is yours and no other user can write to it; otherwise only home and `/tmp`
are served. Like your home directory, and unlike `/tmp`, it is searched for a relative document
name.

The viewer serves a file only under the exact name the system reports for it, so on macOS a few
documents get 404:

- a path written in a case other than the one on disk, on a case-insensitive volume;
- a name stored decomposed (an accent as a separate character, NFD) and requested composed (NFC),
  or the reverse;
- rarely, a file with several hard links, when another program opens it through another of its
  names at the same moment (macOS then reports that other name). Reloading the document works.

A Mac used only over SSH, with nobody logged in at the screen, is the normal server case and is
supported: see [Running at boot on a headless Mac](#running-at-boot-on-a-headless-mac).
Limitations:

- the isolated agent and the demo sandbox are Linux-only;
- there is no macOS CI yet;
- a release publishes a bundle for Apple silicon (macOS 13.5 or newer) and the native programs
  (macOS 13 or newer), and its `install.sh` installs them like on Linux ([Prebuilt
  binaries](#prebuilt-binaries)); an Intel Mac installs from a clone, with the native programs
  built from source (below). The macOS release files are qualified on GitHub's macOS runner; no
  macOS CI runs the rest of the test suite.

Prerequisites on macOS:

- macOS 12.3 or later for a source install: the installer relies on `plutil -extract … raw`
  (macOS 12) and `readlink -f` (macOS 12.3), and refuses an older system. A release needs macOS
  13.0 or later (its native programs are built for macOS 13), and its bundle macOS 13.5 or later
  (the bundled Node 24); on macOS 13.0 to 13.4 the release installer installs the native programs
  and the code, run with your Python.
- Python 3.10 or later with `aiohttp` 3.x for the web server, for example from a virtual
  environment: `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`, then pass
  `MESH_PYTHON="$PWD/.venv/bin/python"` to the installer ([Python from a virtual
  environment](install.md#python-from-a-virtual-environment)). The `/usr/bin/python3` of the
  Command Line Tools is often older than 3.10 and has no `aiohttp`; the installer refuses it for the
  server and prints the Homebrew and venv commands. The commands it links into `~/.local/bin`
  (`mesh-attach`, `mesh-rename`) use only the standard library and run with the first `python3`
  on `PATH`, including the system Python 3.9. The bootstrap installs the native programs
  `mesh-open` and `mesh-logout-all` in the opam switch.
- Xcode Command Line Tools (`xcode-select --install`) for the C compiler the OCaml build needs,
  and [opam](https://opam.ocaml.org/), for example from Homebrew (`brew install python opam`). If
  opam asks for system packages, install Homebrew `gmp` and `pkg-config`.
- An opam switch with OCaml 5.3, created before the bootstrap:
  `opam switch create session-mesh ocaml-base-compiler.5.3.0`. The bootstrap needs network access
  to fetch its dependencies ([Native PTY host](install.md#native-pty-host)).

### Installing on macOS

No release publishes a macOS bundle yet, so a release's `install.sh` refuses on a Mac and names
the platforms it has. Build the native host into the switch, then run the installer of a clone
with the same switch:

```sh
MESH_OPAM_SWITCH=session-mesh bash scripts/bootstrap.sh --install-only
MESH_OPAM_SWITCH=session-mesh MESH_PYTHON="$PWD/.venv/bin/python" ./install.sh --from-source
```

A source install takes the native host from `--ptyhost`, else `mesh-ptyhost` on `PATH`, else the
switch's `bin` directory. The installer writes two launchd jobs and loads them with `launchctl bootstrap`:

| Job | Runs | Log |
|---|---|---|
| `io.session-mesh.pty` | the native PTY host, which owns the sessions | `~/Library/Logs/session-mesh/pty.log` |
| `io.session-mesh.web` | the web server on `127.0.0.1:MESH_PORT` (default 7690) | `~/Library/Logs/session-mesh/web.log` |

Without options they are **agents** in `~/Library/LaunchAgents/`, installed without `sudo`. Where
they are loaded decides how long they live:

- **Under a graphical login** (`gui/<uid>`), they start at each login. Logging out stops them, and
  with the PTY host every mesh session.
- **Without a graphical login**, over SSH for example, they are loaded in the background domain
  `user/<uid>`. They keep running after you disconnect, but only until the Mac restarts: after a
  restart nothing loads them again until you rerun `./install.sh` or run
  `launchctl bootstrap user/$(id -u) ~/Library/LaunchAgents/io.session-mesh.pty.plist` and the same
  for `io.session-mesh.web.plist`. The installer says so when it finishes.

Both jobs are restarted when they exit with an error or are killed (`KeepAlive` on an unsuccessful
exit). A start that fails again, for example on an unusable runtime directory, is retried at most
every 30 seconds (`ThrottleInterval`). They run with a `PATH` made of `current/bin` (a release
install) or the switch's `bin` directory (a source install),
`~/.local/bin`, Homebrew's directories and the system's, because launchd itself gives only
`/usr/bin:/bin:/usr/sbin:/sbin`, and with a `LANG`: the installer's, else the one already installed,
else your region's (`defaults read -g AppleLocale`, for example `fr_FR.UTF-8`) when that locale
exists, else `en_US.UTF-8`. Without it the mesh shells would run in the C locale, which an SSH login
often has.

As on Linux, rerunning `./install.sh` replaces the web job, keeps the installed port without
`MESH_PORT`, loads the PTY job only when it is not running and never restarts it, so the sessions
keep running. It refuses `--ptyhost` once a PTY job exists. When `LANG` or
`PATH` change, it rewrites them in the PTY plist, but a running PTY host keeps its environment
(launchd applies a plist when it loads the job, also for a restart after a crash) until the job is
loaded again: at the next login or boot, or at once with `launchctl bootout` then
`launchctl bootstrap`, which ends every mesh session. The installer says which values changed.

Both jobs always share one domain. A rerun keeps the session type of the installed PTY agent: an
agent installed without a graphical login stays in `user/<uid>`, even when you rerun the installer
from a graphical session. An agent installed under a graphical login cannot be loaded without one;
the installer then stops before changing anything and gives two remedies: rerun it while logged in
graphically, or remove the PTY agent and reinstall.

**Runtime directory.** Both jobs receive the same `MESH_RUNTIME_DIR`: the value of an installed PTY
job, else the order of the hosts and clients: `MESH_RUNTIME_DIR` from the installer's environment,
else `XDG_RUNTIME_DIR`, else the macOS default, `~/Library/Application Support/session-mesh/run`,
created as the native host creates it. This is Apple's per-user location for application data, which
the system does not purge (unlike the per-user temporary directory). The installer refuses a
directory that the native host would refuse (see [Replacing the PTY
host](#replacing-the-pty-host)), including a socket path over 103 bytes, and a
`MESH_RUNTIME_DIR` that differs from the installed PTY job's. It checks the directory before it
removes a socket left there by a killed host, as on Linux. `mesh-attach`, `mesh-rename` and the
server find the same socket with no variable set. In this section `~` is your home directory as the
user database records it, not `$HOME`: it holds the agents, the logs, the command links in
`~/.local/bin` and the default runtime directory.

**Stopping and uninstalling.** `./install.sh --uninstall` unloads the web job from every domain it
is loaded in and removes its plist, and removes this service's `tailscale serve` publication as on
Linux; the PTY host and its sessions keep running. For a boot-time web daemon it asks before running
`sudo`, and without a terminal it prints the two commands to run instead. To stop everything, which
**ends every mesh session**:

```sh
./install.sh --uninstall
launchctl bootout gui/$(id -u)/io.session-mesh.pty    # user/$(id -u) when installed without a graphical session
rm ~/Library/LaunchAgents/io.session-mesh.pty.plist
# boot-time daemons instead:
#   sudo launchctl bootout system/io.session-mesh.pty
#   sudo rm /Library/LaunchDaemons/io.session-mesh.pty.plist
```

The uninstaller prints the exact command for your installation. The rest of
[Complete removal](#complete-removal) (commands in `~/.local/bin`, `~/.config/session-mesh`,
`~/.cache/session-mesh`) applies unchanged; also remove `~/Library/Logs/session-mesh` and
`~/Library/Application Support/session-mesh` if you want.

With `--tailscale`, the installer uses `tailscale` on `PATH`, else the command inside the
Tailscale app. It runs no `sudo` for Tailscale on macOS: if `tailscale serve` is refused, it stops
and says so.

### Running at boot on a headless Mac

Agents in `user/<uid>` stop at a restart. To have the mesh start at boot with nobody logged in, as
`loginctl enable-linger` does on Linux, install the two jobs once as **boot-time daemons**:

```sh
MESH_OPAM_SWITCH=session-mesh MESH_PYTHON="$PWD/.venv/bin/python" ./install.sh --at-boot
```

The installer prepares and checks everything first, then lists every command it will run with
`sudo` (on a rerun also the `bootout`, `bootstrap` or `kickstart` of a job already loaded) and asks
for one confirmation, a `y` typed on the terminal; without a terminal, or with any other answer,
it changes nothing. It runs each of them by its absolute path (`/usr/bin/install`, `/bin/launchctl`,
`/bin/rm`), not through `PATH`. It
writes `/Library/LaunchDaemons/io.session-mesh.pty.plist` and `io.session-mesh.web.plist` (owner
root, mode 644, which launchd requires there) and loads them in the `system` domain. Each daemon
runs as your account (`UserName`, `GroupName`) with the environment a login would give it, which
launchd gives a daemon none of: `HOME`, `USER`, `LOGNAME`, `SHELL`, plus the same `PATH`, `LANG`
and `MESH_RUNTIME_DIR` as the agents. Logs, configuration and runtime directory stay in your home.

Verified on macOS 15 (Apple silicon): both daemons ran as your account, never as root, and the
login page answered after a restart with nobody logged in.

Once daemons are installed, run the installer again with `--at-boot` (it asks again before
`sudo`); without it, it refuses. It does not move existing agents to daemons, because that ends
every mesh session. To move deliberately:

```sh
./install.sh --uninstall
launchctl bootout user/$(id -u)/io.session-mesh.pty    # gui/$(id -u) under a graphical login; ends every mesh session
rm ~/Library/LaunchAgents/io.session-mesh.pty.plist
./install.sh --at-boot
```

With FileVault on, a restart waits until the disk is unlocked before any daemon starts, so after a
power cut the mesh comes back only once someone unlocks the Mac. A daemon runs outside any login
session, so the login keychain is locked unless you are logged in: an agent that keeps its
credentials only in the keychain may need another way to log in (this was not tested).

The installer does not use a user crontab `@reboot` entry to load the agents without `sudo`:
Apple does not document whether cron runs such an entry at boot before any login, nor whether it
may load agents into `user/<uid>` from there, and it was not verified.

### Starting by hand for development

Both processes need the same private runtime directory, and the native host validates it as
described in [Replacing the PTY host](#replacing-the-pty-host). The server also needs
`MESH_OPAM_SWITCH`: without it, it looks for `mesh-board-mcp` in the switch of its own opam
environment, or else in `<checkout>/_opam/bin`, so agents started by the mesh do not find it.

```sh
export MESH_RUNTIME_DIR="$HOME/.local/state/session-mesh-dev"   # any private directory you own, not the installed jobs' default
export MESH_OPAM_SWITCH=session-mesh   # the switch the bootstrap installed into
mkdir -p -m 700 "$MESH_RUNTIME_DIR"
opam exec --switch=session-mesh -- mesh-ptyhost &
MESH_PORT=7699 .venv/bin/python server.py   # in another terminal with the same MESH_RUNTIME_DIR
```

Use another runtime directory and port than the installed agents, or unload them first.

### Diagnostics

The native host answers a read-only `processes` request on its socket (refused for the isolated
agent); on macOS the server takes its process facts from it, where on Linux it keeps reading
`/proc`.

`mesh-platform`, installed with the release programs (`~/.local/share/session-mesh/current/bin`) or
with the OCaml package, shows what the platform layer sees:
`capabilities`, `runtime-dir`, `snapshot`, `process PID`, `command-line PID` and `require FEATURE`
(exit status 0 when available, 78 when refused). Use it first when something does not work.

## Complete removal

`install.sh --uninstall` (`~/.local/share/session-mesh/current/install.sh` for a release install,
`./install.sh` in a clone) removes only the web unit and this service's own `tailscale serve`
publication. To remove the rest, which **ends every mesh session**:

The uninstaller recognises its `tailscale serve` publication by the port it proxies to, read from
the installed web unit (or from `MESH_PORT` when the unit has none), and leaves any other
publication in place.

```sh
~/.local/share/session-mesh/current/install.sh --uninstall   # or, in a clone: ./install.sh --uninstall
systemctl --user disable --now session-mesh-pty
rm ~/.config/systemd/user/session-mesh-pty.service
rm -r ~/.config/systemd/user/session-mesh.service.d    # only if you used systemctl --user edit
systemctl --user daemon-reload
rm ~/.local/bin/mesh-open ~/.local/bin/mesh-attach ~/.local/bin/mesh-rename ~/.local/bin/mesh-logout-all
rm -r ~/.config/session-mesh                          # token, snapshot, names
rm -r ~/.local/share/session-mesh                     # the installed releases, if any
if [ -d ~/.cache/session-mesh ]; then rm -r ~/.cache/session-mesh; fi   # uploads, history index, rollout cache
```

The web server creates `~/.cache/session-mesh` when it first saves the history index, which it
builds right after starting as soon as a conversation of any of the eight History agents (Claude
Code, Codex, Pi, OpenCode, Gemini, Antigravity, Copilot, Vibe) exists, when a file is uploaded, or
at the first session listing that reads a Codex rollout to identify a session; hence the test in the last line.

That directory holds the index in two forms: `history.json` (the cache of the parse state) and
`history.sqlite` (the full-text database kept by the `mesh-history` helper). Both hold prompts and
replies and are rebuilt from the transcripts, so removing them loses nothing. It also holds
`codex-rollout-meta.json`: the folder and conversation id from the first line of each recent Codex
rollout (at most 8 192, no transcript text), so that the first session listing after a restart does
not read every rollout again. A row is used only while its rollout keeps the same device, inode,
size and modification time; a rollout whose first line was rewritten in place with its size and
modification time kept would keep its old id even across restarts of the web server. To clear such
a row, stop the web server, delete this file, then start the web server: deleting it while the
server runs does not help (the server keeps the row in memory and writes it back at the next
listing that reads a new rollout), nor does deleting it after the restart (it is read once per
process). Removing it loses nothing: it is rebuilt at the next listing. A transcript that exists
but cannot be opened (permission, descriptor limit) no longer aborts the listing: that one session
shows `updated` 0 and, for Codex, idle, until it can be read.

The web server also uses `mesh-history` for the separate conversation-name registry in the
configuration directory. This native helper is required for session listings, renames and History
name operations, even when the optional History database is disabled. Install it with the other
native programs using `scripts/bootstrap.sh`, or use the bundled release. If the helper is missing
or incompatible, those operations report an error rather than changing the registry themselves.
`MESH_HISTORY_CMD` selects the History index helper only; it does not select the conversation-name
registry helper. To override the registry helper, set `MESH_MESH_HISTORY_CMD` to an absolute path.
An executable wrapper at that path must preserve inherited file descriptors when it starts
`mesh-history`; a wrapper that closes them is refused, so an orphaned helper cannot write later.

- **Helper stopped.** The log line `history: database helper stopped: <reason>` means the helper
  failed (timeout, locked or corrupt file). The in-memory index and ripgrep answer meanwhile, and
  the helper is started again after 30 s.
- **Quarantine.** A database the helper finds corrupt is renamed `history.sqlite.corrupt-<UTC
  stamp>` (mode 0600, with its `-wal` and `-shm` files) and a new one is built; only the newest is
  kept. Delete it once you have looked at it.
- **Downgrade.** A `mesh-history` older than the database (schema 2) refuses to open it. That
  is logged as above, History falls back to the in-memory index and ripgrep, and the helper is
  tried again every 300 s. Nothing is lost: the newer helper resumes from the same file.
- **Unreadable transcripts.** A scan that fails on one file, one OpenCode conversation or one
  step skips it and logs it once (the path and the error type, never the content). The History tab
  shows how many transcripts are left out; if it is non-zero for every file of one agent, a reader
  is failing on that agent's format: report it. When the scan itself fails, `/api/history` still
  answers with the last good index and `degraded: true`.

An operator right granted to your user with `sudo tailscale set --operator=…` during installation,
if any, stays in Tailscale's settings: the uninstaller does not touch it.

## Logging out devices and replacing the token

A lost or stolen phone stays logged in until you act. The login cookie asks the browser to keep it
30 days, but the server does not check its age: the value is an HMAC of the token and of a
generation counter (`cookiegen.py`), the same for every device, and it is accepted for as long as
neither changes. "Sign out this device" only deletes the cookie from that browser. To log out every
browser at once without changing the token:

```sh
mesh-logout-all
```

The same is available in the page: the ⏻ button at the bottom of the sidebar offers "All devices…"
(after a confirmation; this browser is logged out too) and "Sign out this device". Each device then
logs in again with the token. The command goes through the running mesh; when the mesh is stopped,
it raises the `cookie-generation` counter in `~/.config/session-mesh` directly. It does so only
when nothing answers on the mesh's port: the connection is refused or closed, or 10 seconds pass,
without one byte of an answer. A refusal from the mesh (for example a wrong token) is reported and
changes nothing on disk, and so is an answer that begins and then stops, or that is not a complete
HTTP response (`the mesh gave an unreadable answer`): stop the mesh, then run the command again.
The master token, the sessions' own tokens and the running terminals do not change.

If the token itself may have leaked (for example a shared `?token=` link, which also stays in the
history of the browser that opened it), replace it: delete
`~/.config/session-mesh/token` and restart the web server, which creates a new one.

```sh
rm ~/.config/session-mesh/token
systemctl --user restart session-mesh
cat ~/.config/session-mesh/token
```

The login cookies are derived from the token, so every browser must log in again. The session
tokens (`MESH_SESSION_TOKEN`) that running sessions received at their start are derived from it
too, and stop being accepted. Until each session is restarted, inside it:

- `mesh-open` fails ("session token refused");
- the agent hook `mesh-event` is refused; it fails silently and the agent carries on;
- `mesh-board-mcp`, the agents' board and messaging tools, is refused by the server.

`mesh-rename` keeps working, because it reads the new master token from
`~/.config/session-mesh/token`.

## Answer buttons in notifications

**Answering from a notification is off by default.** The buttons ("1", "2" on a Claude Code
question) type the choice into the terminal. They rely on an undocumented value of Claude Code's
state; if a permission prompt ever reported the same value, a tap could approve a command. To turn
them on, set `MESH_ANSWER_BUTTONS=1` in the web server's environment and restart it:

```sh
systemctl --user edit session-mesh        # add under [Service]: Environment=MESH_ANSWER_BUTTONS=1
systemctl --user restart session-mesh
```

Only the value `1` turns them on, and nothing in the page or the API can change it. Even then, the
buttons only reach devices that ticked "details" in the sidebar footer. When they are off, no
notification carries buttons and `/api/push/act` answers 403.

## Whisper dictation

Voice dictation is disabled unless the web service has `MESH_WHISPER_URL`. Set the full URL of a
Whisper-compatible transcription endpoint. HTTPS is required for remote endpoints; HTTP is accepted
only for `localhost` and loopback IP addresses. URL credentials and fragments are refused and
redirects are not followed. The URL is operator-controlled, shared by all sessions, and cannot be
supplied by a browser request.

For a systemd install, use `systemctl --user edit session-mesh.service`, for example:

```ini
[Service]
Environment="MESH_WHISPER_URL=https://transcription.example.invalid/audio/transcriptions"
Environment="MESH_WHISPER_LANGUAGE=en"
```

Replace the illustrative URL with your service, then run `systemctl --user daemon-reload` and
`systemctl --user restart session-mesh.service`. On macOS, set the variables in the web job's
`EnvironmentVariables` and restart that job as described under [macOS](#macos). Restart only the
web service, not the PTY host: terminal sessions stay running, but in-flight recognition is lost.
Source installs need Node 22.13 or later in the 22.x line, or Node 24 or later, on the web
service's PATH or at the absolute executable path in `MESH_NODE`;
bundles select their bundled Node without changing the Node available to agents.
The optional typed worker owns its private socket directory and listener; the web bridge
reaps that direct child and retains browser authentication and final authorization checks.

Dictation is optional: invalid configuration or worker startup failure disables only dictation,
not the web server. The authenticated, same-origin `GET /api/transcribe/config` returns
`{"enabled":false,"disabled_reason":"CODE"}` when disabled (`HEAD` has the same status and
headers without a body). The closed reason codes are `not_configured`, `invalid_configuration`,
`runtime_unavailable`, `startup_timeout` and `worker_failed`. They contain no endpoint, runtime
path or child output; clients translate them locally. Unexpected worker exit also disables
dictation. Correct the configuration/runtime and restart the web service to retry.

Audio preparation does not start inference until the bridge commits it against a live session.
Matching retries share a completed preparation: a failed commit leaves it available for another attempt,
or until its 15-second preparation deadline. During that interval, a fresh recording for the same
session can be refused as busy.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MESH_WHISPER_URL` | unset | Complete transcription endpoint; unset disables dictation. |
| `MESH_WHISPER_LANGUAGE` | unset | Auto-detect when unset; an explicit language (for example `fr`) is forwarded. |
| `MESH_WHISPER_MAX_BYTES` | `8388608` | Maximum audio bytes per recording (8 MiB). |
| `MESH_WHISPER_AGGREGATE_BYTES` | `67108864` | Maximum retained audio bytes (64 MiB). |
| `MESH_WHISPER_QUEUE_SIZE` | `16` | Maximum queued jobs. |
| `MESH_WHISPER_WORKERS` | `1` | Concurrent transcription requests. |
| `MESH_WHISPER_TIMEOUT` | `60` | Active-request timeout, seconds. |
| `MESH_WHISPER_QUEUE_TTL` | `600` | Queue-wait deadline, seconds. |
| `MESH_WHISPER_RESULT_TTL` | `1800` | Ready-result retention, seconds. |
| `MESH_WHISPER_CAPTURE_SECONDS` | `120` | Browser recording-duration limit, seconds. |

The endpoint receives a multipart POST containing only `file`, `response_format=json` and,
when explicitly configured, `language`, without Mesh credentials. Enabled public configuration
reports `language: null` for auto-detection, or the configured language string. A successful response must have status 200 and
contain JSON with a `text` string, or `text/plain`. The response body is capped at 64 KiB and the
normalized transcript at 32 KiB; terminal control characters are rejected. API-key headers, model
selection and provider-specific parameters are not implemented. See
[Voice dictation](features.md#voice-dictation) for the desktop and phone editing flows.

## Documents opened with mesh-open

- **From a mesh session**, the document opens next to the pane showing that session, and only in
  the pages that show it. It uses the session's own token (`MESH_SESSION_TOKEN`), which the agent
  hook, the `mesh-board` tools (whiteboard, demos, messages, session requests) and the Pi extension
  use too, each on that session's data only; the complete list is in
  [SECURITY.md](../SECURITY.md#what-session-mesh-defends-against). The mesh's master token never
  enters a session. Without `MESH_SESSION_TOKEN`, `mesh-open` refuses rather than use the master
  token when `MESH_SESSION` is set or when the PTY host lists a session whose shell is one of its
  ancestors. Otherwise (outside the mesh, when no PTY host answers, in a sandbox that hides the
  ancestry, or in a process that left the session's process tree, such as a detached process or a
  multiplexer whose server was started elsewhere), `mesh-open` uses the master token and opens the
  document in every page.
- Running `mesh-open FILE` again reloads the document; `--reload` says so explicitly; `--watch`
  reloads it whenever the file changes on disk (the file itself, not its stylesheets or images; the
  page must stay open).
- A document's `/view/…` link (new tab, Ctrl+click) **expires after 12 hours**; opening the document
  again from the mesh gives a fresh one.
- A link gives access to the document, plus the relative files it uses (stylesheets, images) up to
  two subdirectories below it, never in a hidden directory nor through `../`. For a document placed
  directly in `~`, `/tmp` or the macOS private temporary directory, or in a hidden directory, only
  the document itself is served: put a report and its files in a subdirectory. An HTML, SVG or
  Markdown document that `mesh-open` opened from a session is also served alone, without the files
  next to it, for 12 hours, even when you open it yourself meanwhile.
  `~/.config/session-mesh`, `~/.ssh`, `~/.gnupg` and the other credential files listed in [SECURITY.md](../SECURITY.md) are never served.
- Remote images and scripts loaded from a CDN do not display in the panel.
- A link works without the login cookie, for anyone who has it and reaches the server's port.
  The script of an HTML document can send its own link out, with what it can read: open only
  documents you trust ([SECURITY.md](../SECURITY.md#documents-that-send-data-out)).
- A mesh on another port than 7690 needs `MESH_PORT` exported in the shell where `mesh-open` runs,
  except in sessions started by the web server, which receive it
  ([Using another port than 7690](#using-another-port-than-7690)).

## Making every new terminal a mesh session

Added at the end of `~/.bashrc`, this makes each new Terminator window or tab a mesh session. If the
PTY host does not answer, the normal shell continues; `NO_MESH=1 terminator` opens a terminal
outside the mesh.

```bash
# session-mesh: new Terminator terminals are mesh sessions
if [[ $- == *i* && -t 0 && -t 1 && -n "$TERMINATOR_UUID" && -z "$NO_MESH" ]] && command -v mesh-attach >/dev/null; then
  mesh-attach && exit
  export NO_MESH=1   # fallback shell (ptyhost down): its child shells do not try again
fi
```

Mesh shells are started by the PTY host without `TERMINATOR_UUID`, so the rule does not fire a
second time inside them. Adapt the test to the variable your terminal emulator sets.

## Using another port than 7690

`MESH_PORT=7700 ./install.sh` writes `MESH_PORT=7700` into the web unit (on macOS, into the web
job's plist), and the web server listens there. Running `./install.sh` again without `MESH_PORT`
keeps 7700. The clients do not learn it from the server: `mesh-open`, `mesh-rename`,
`mesh-logout-all`, the agent hook `mesh-event`, `mesh-board-mcp` and the Pi extension each read
`MESH_PORT` from their own environment and use 7690 when it is unset.

- **In a session started by the web server** (sidebar, "New session", restore), the server hands
  the session the port it listens on, in `MESH_PORT`, together with `MESH_CONF_DIR`. The tools and
  agents of that session reach the right mesh.
- **Outside a mesh session**, and **in a session started by `mesh-attach`**, the variable comes from
  your shell. `mesh-attach` creates its session through the PTY host directly, and the PTY host
  starts the shell with a cleaned environment that keeps no `MESH_*` variable. Without the variable,
  these tools send their requests to port 7690 and fail, or reach whatever listens there.

To make every client use the same port, export it in your shell's startup files. Each mesh session
starts an interactive login shell, and agents are typed into that shell, so this also covers the
sessions of `mesh-attach`. For bash, put the line in a file a login shell reads (`~/.bash_profile`
or `~/.profile`, or `~/.bashrc` if your profile sources it):

```sh
export MESH_PORT=7700
```

Sessions that were already running keep their old environment until they are restarted.

## HTTPS on a VPN address with a reverse proxy

This section lets you open session-mesh from another machine on a VPN that is not Tailscale
(WireGuard, for example), over HTTPS with a certificate your browsers accept, while the server keeps
listening on loopback only. The proxy is [Caddy](https://caddyserver.com/docs/): it listens on the
VPN address, holds the certificate, and forwards to `http://127.0.0.1:7690`. `MESH_HOST` stays at
its default (the server still refuses a non-loopback address), and neither
`MESH_ALLOW_NON_LOOPBACK` nor `MESH_TRUST_PROXY` is set.

Why HTTPS and not plain HTTP on the VPN: the service worker, push notifications, the clipboard and
the microphone only work in a secure context, and the login cookie is marked `Secure` only when the
server learns that the browser used HTTPS. A self-signed certificate that the browser has to be told
to accept does not give the service worker a secure context; use a certificate from an authority the
browser already trusts.

In the examples, `mesh.example.com` is a name you control, `192.0.2.1` stands for this machine's VPN
address (a documentation address from RFC 5737: write your own), and the name resolves to that
address (a DNS `A` record in your zone, or in the DNS that your VPN clients use). Some resolvers drop
a public record that points to a private address, as a protection against DNS rebinding (dnsmasq
`stop-dns-rebind`, Pi-hole, Unbound `private-address`): if the name does not resolve on a client,
add an exception for your zone (dnsmasq `rebind-domain-ok=/example.com/`, Unbound
`private-domain: "example.com"`) or publish the record in the VPN's own DNS.

### What the proxy must do

The server decides whether a request comes from its own page from `Host`, `X-Forwarded-Host` and
`X-Forwarded-Proto`, and believes the forwarded ones only on a connection that comes from this
machine. For every request, the websocket upgrade of a terminal included, the proxy must:

| The proxy... | Because |
|---|---|
| keeps the browser's `Host` unchanged | the server compares the page's `Origin` with `Host`; a rewritten `Host` makes every action answer 403 |
| sets `X-Forwarded-Host` to that same `Host`, overwriting any client value | with a forwarded host different from `Host`, the server ignores the forwarded scheme |
| sets `X-Forwarded-Proto: https`, overwriting any client value | the cookie is marked `Secure`, and the `https://` `Origin` of POSTs and websockets matches |
| passes websocket upgrades and request bodies unchanged | terminals use `/ws/<name>`; uploads are plain POSTs |

Caddy's `reverse_proxy` does all of this by default: it forwards the original `Host`, writes
`X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` itself (overwriting what a client sent,
as long as you declare no `trusted_proxies`), and proxies websockets without configuration. The
Caddyfiles below therefore set none of them, and no server setting is needed. Do not add
`header_up Host ...`, which breaks the first row, and do not add `trusted_proxies` unless Caddy
itself sits behind another proxy you control.

`MESH_TRUST_PROXY=1` is for proxies that rewrite `Host` (nginx's default); leave it unset with
Caddy. The interface has no server-sent events or long polling, only that websocket, so no buffering
or timeout setting is needed. Caddy applies no request-size limit by default; the server's own
limits apply.

### Caddy's admin endpoint: set it in the global options

By default Caddy serves an administration API on `localhost:2019`, and its documentation describes
no authentication for it. Any local user of this machine can therefore send it a new configuration
(`POST /load`) that routes `mesh.example.com` to a program of their own. The proxy terminates TLS
with your certificate, so that program would receive the token typed at the next login and the
cookie that follows. Before the proxy, a local user could reach `127.0.0.1:7690` but could not
sign in; with an open admin endpoint, they can obtain the credential. Caddy's documentation
itself recommends a permissioned Unix socket when untrusted code runs on the machine.

Both Caddyfiles below start with a global options block that moves the admin endpoint to a socket
that only the `caddy` user (and root) can open. **This syntax needs Caddy 2.7.3 or later**: the
`|mode` suffix of a Unix socket address came with that release, whose notes mark it experimental.
Check with `caddy version` before you rely on it: the Caddy packaged by Debian 12 and Ubuntu 24.04
is 2.6.2, which probably takes `|0200` as part of the file name instead of a mode (not run on that
version). On such a version, install a current Caddy from Caddy's own package repository, or use
`admin off` (below) and restart instead of reloading.

```caddyfile
{
	admin unix//run/caddy/admin.sock|0200
}
```

`0200` is the file mode of the socket (writing to it is what opens a connection). Caddy documents it
as the default mode of Unix sockets in network addresses; the examples state it so that nothing
depends on a default. The `caddy` user must be able to create the socket in `/run/caddy`: if your
service unit does not already create that directory (the unit Caddy ships has no
`RuntimeDirectory`), run `sudo systemctl edit caddy` and add, in the drop-in it opens:

```ini
[Service]
RuntimeDirectory=caddy
RuntimeDirectoryMode=0700
```

The first switch from the default port 2019 to the socket needs `sudo systemctl daemon-reload`
(for the drop-in) and then `sudo systemctl restart caddy`, not a reload: the running instance still
listens on 2019, and the new `RuntimeDirectory` only takes effect at a start. Later Caddyfile
changes can use `reload`. Check the socket once Caddy runs with the final Caddyfile (step 1 of
"Checking that it works" below): `ls -l /run/caddy/admin.sock` must show `s-w-------` with owner
`caddy`.

The other safe choice is `admin off`. Caddy's documentation says config changes are then impossible
without stopping and starting the server, and that `caddy reload` needs the admin endpoint.
How you apply a change then depends on the choice:

- With the socket, `sudo systemctl reload caddy` works. The packaged unit runs
  `caddy reload --config /etc/caddy/Caddyfile --force` as the `caddy` user. That command reads
  the admin address from the Caddyfile it is given (`DetermineAdminAPIAddress`), and the function
  that sends the request (`AdminAPIRequest`) drops the `|0200` suffix, through
  `SplitUnixSocketPermissionsBits`, before it connects. The socket belongs to `caddy`, so the
  command can open it: no `--address` is needed (source: `cmdReload`, `DetermineAdminAPIAddress` and
  `AdminAPIRequest` in Caddy's `cmd/commandfuncs.go`; read in source, not run). `--force` also makes
  Caddy reload certificate files, which is how a renewed certificate file is picked up.
- With `admin off`, `caddy reload` fails: apply every Caddyfile change, and every renewed
  certificate file, with `sudo systemctl restart caddy`. A restart cuts the browser connections for
  a moment; the sessions keep running in the server.

Do not leave the admin endpoint at its default, and do not give the socket a mode that lets other
users write to it.

### Caddyfile with a certificate issued by Caddy (DNS-01)

A VPN address is not reachable from the internet, so the certificate authority cannot validate it
over HTTP. The DNS-01 challenge proves control of the name with a DNS record instead. It needs:

- a Caddy build that includes the plugin of your DNS provider: the standard binary does not, so use
  `xcaddy build --with github.com/caddy-dns/<provider>` or a package that includes it;
- an API token that can edit records of that zone.

Caddy then obtains a certificate from Let's Encrypt and renews it before it expires, without a
reload. For the provider plugin, the CA account (`email`) and the ZeroSSL fallback, follow Caddy's
own documentation (`tls` directive, automatic HTTPS); only what concerns the token is specific to
session-mesh and kept below.

```caddyfile
{
	admin unix//run/caddy/admin.sock|0200
	auto_https disable_redirects
}

mesh.example.com {
	bind 192.0.2.1
	tls {
		dns <provider> {env.DNS_API_TOKEN}
	}
	reverse_proxy 127.0.0.1:7690
}
```

The parameters after `dns <provider>` depend on the plugin: take them from its documentation.
`{env.DNS_API_TOKEN}` is read while Caddy runs and is the form Caddy's own `tls` documentation shows,
but not every module accepts placeholders. If yours does not, write `{$DNS_API_TOKEN}`, which is
replaced before the Caddyfile is parsed. The token then becomes part of the configuration that Caddy
keeps on disk (its `autosave.json`) and serves on its admin endpoint, which is one more reason to
restrict that endpoint as above. Put the token in the Caddy service's environment, not in the
Caddyfile, with the precautions of the next subsection.

#### Keep the token out of the journal

The packaged unit (`caddyserver/dist`, `init/caddy.service`) starts Caddy with
`ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile`. `--environ` makes
`printEnvironment` (`cmd/main.go`) write the whole environment, one `NAME=value` line per variable,
to standard output, which systemd sends to the journal. The token therefore lands in the journal at
every start, where members of `adm`, `systemd-journal` or `wheel` (depending on the distribution)
can read it, and in every journal backup. This holds for any secret you put in Caddy's environment,
not only this token (source read, not run).

Put the token in a file read with `EnvironmentFile=`; unlike `Environment=`, its content does not
appear in `systemctl show caddy`. systemd reads that file as root, so `caddy` needs no access to it.
Create it empty with the right owner and mode, so that the token never goes through your shell
history, then edit it:

```sh
sudo install -m 600 -o root -g root /dev/null /etc/caddy/dns.env
sudoedit /etc/caddy/dns.env
```

The file holds one line, with the variable name used in the Caddyfile and no quotes:
`DNS_API_TOKEN=<the token>`. Then, in the drop-in opened by `sudo systemctl edit caddy`, clear
`ExecStart=` and redefine it without `--environ`:

```ini
[Service]
EnvironmentFile=/etc/caddy/dns.env
ExecStart=
ExecStart=/usr/bin/caddy run --config /etc/caddy/Caddyfile
```

The empty `ExecStart=` is required: without it systemd refuses a second `ExecStart=` in a service
whose type is not `oneshot`, and the unit fails to load. Take the `ExecStart=` line from your own
unit (`systemctl show -p ExecStart caddy` before the change; a distribution package may use another
path) and keep everything except `--environ`. After
`sudo systemctl daemon-reload && sudo systemctl restart caddy`, check that the flag is gone and that
the token is not logged: `systemctl show -p ExecStart caddy` must not contain `--environ`, and
`sudo journalctl -u caddy --since -5min | grep -c DNS_API_TOKEN` (adapt the name to your variable)
must print 0.

The unit's output also reaches other places than the journal: on Debian and Ubuntu, rsyslog writes
it to `/var/log/syslog` and its rotated `.gz` files (group `adm`), and a remote log collector may
hold copies. Journals and logs written before this change may already hold the token. Count the
lines without printing them: `sudo journalctl -u caddy | grep -c DNS_API_TOKEN` and
`sudo zgrep -c DNS_API_TOKEN /var/log/syslog*`. If a count is not zero, treat the token as exposed:

1. create a new token at your DNS provider and replace the content of `/etc/caddy/dns.env`;
2. run `sudo systemctl restart caddy`: `EnvironmentFile=` is read only at start, so without the
   restart Caddy keeps the old token and the renewal, about 30 days before the certificate
   expires, fails without any visible sign;
3. revoke the old token at your provider. From then on the leaked value is useless.

Deleting the old entries is optional and depends on your retention policy. `journalctl` cannot
purge one unit: `sudo journalctl --rotate && sudo journalctl --vacuum-time=1s` removes every
archived journal of the machine, audit evidence included. The same restart is needed after any
later rotation of the token.

`bind 192.0.2.1` makes the site listen on the VPN address only. Caddy's documentation says that
`default_bind` does not apply to the server it creates on port 80 to redirect to HTTPS, and says
nothing for `bind`. In `modules/caddyhttp/autohttps.go`, that redirect listener is built from the
address of the HTTPS listener with only the port replaced, so with `bind` it would be
`192.0.2.1:80`, not every interface (source read, not run). `auto_https disable_redirects` removes
that server anyway, which is the safe choice: nothing listens on port 80, and a browser that types
`http://mesh.example.com` gets a refused connection, so type or bookmark the `https://` address. If
you want the redirect on the VPN address, drop that line and add an explicit site block, which
Caddy documents as the way to configure the redirect server:

```caddyfile
http://mesh.example.com {
	bind 192.0.2.1
	redir https://mesh.example.com{uri}
}
```

(This variant was not run: check it with step 1 below.) Never write `0.0.0.0`, and do not remove
`bind`: without it Caddy listens on every interface. If step 1 shows the UDP listener of HTTP/3 on
another address, add `servers { protocols h1 h2 }` to the global options to switch HTTP/3 off. Your
host name appears in the Certificate Transparency logs: choose a name that discloses nothing you
want private. The name resolves to a private address only inside your network, but the zone itself
is public.

### Caddyfile with a certificate you already have

If you obtain the certificate another way, point Caddy at the files. Use the full chain (the
certificate followed by its intermediates) as the certificate file: some mobile browsers do not
fetch missing intermediates. Caddy does not renew certificates loaded from files, and it does not
manage a certificate for that name while a loaded one covers it. Renew the files yourself, then run
`sudo systemctl reload caddy` (with the admin socket; `--force` makes Caddy read the files again)
or `sudo systemctl restart caddy` (with `admin off`).

```caddyfile
{
	admin unix//run/caddy/admin.sock|0200
	auto_https disable_redirects
}

mesh.example.com {
	bind 192.0.2.1
	tls /etc/caddy/certs/mesh.example.com.fullchain.pem /etc/caddy/certs/mesh.example.com.key
	reverse_proxy 127.0.0.1:7690
}
```

The key must be readable by the `caddy` user and by nobody else who should not be able to
impersonate the name. The remarks above on port 80 and on the bind address apply here too.

### If the VPN address is absent at boot

Caddy fails to start when `192.0.2.1` does not exist yet, which happens when the WireGuard interface
comes up after it. Order the units with a drop-in (`sudo systemctl edit caddy`); `vpn.service`
stands for the unit that creates your VPN interface (with `wg-quick`, the instance of its template
unit for your interface name):

```ini
[Unit]
After=network-online.target vpn.service
Wants=network-online.target
Requires=vpn.service
```

`Requires=` also stops Caddy when the VPN stops, which is the intent. If systemd does not manage
your VPN, you can allow binding an address that is not configured yet, and accept that Caddy then
starts before the VPN is up. That setting is machine-wide: every program on the machine, not only
Caddy, can then bind any address it does not own. Make it persistent in a file such as
`/etc/sysctl.d/90-nonlocal-bind.conf` and load it with `sudo sysctl --system`:

```ini
net.ipv4.ip_nonlocal_bind = 1
# only if the VPN address is IPv6:
net.ipv6.ip_nonlocal_bind = 1
```

Session-mesh is not affected either way: it listens on loopback and does not depend on the VPN.

### Checking that it works

Each step says where it runs. Replace `mesh.example.com` and `192.0.2.1` with your values.

1. On the server. The server is still loopback only and Caddy listens where you meant:
   - `ss -ltn 'sport = :7690'` shows `127.0.0.1:7690` and nothing else;
   - `ss -ltn 'sport = :443'` and `ss -lun 'sport = :443'` (HTTP/3 uses UDP) show `192.0.2.1:443`
     only;
   - `ss -ltn 'sport = :80'` shows nothing, or only `192.0.2.1:80` if you chose the `http://` block;
   - `ss -ltn 'sport = :2019'` shows nothing (the admin endpoint is on the socket or off), and, with
     the socket, `ls -l /run/caddy/admin.sock` shows `s-w-------`.
2. On a machine on the VPN. `curl -sS -o /dev/null -w '%{http_code}\n' https://mesh.example.com/login`
   prints `200` with no certificate warning.
3. On the server, which holds the token file. Sign in from the command line and read the cookie flags.
   The file ends with a newline, which the server does not strip from what it receives, so the pipe
   removes it. The token goes through standard input: it is neither in the command line nor in the
   shell history.

   ```bash
   tr -d '\n' < ~/.config/session-mesh/token \
     | curl -si --data-urlencode token@- https://mesh.example.com/login \
     | grep -i -E '^(set-cookie|location):'
   ```

   It shows a `set-cookie` line with `Secure`, `HttpOnly` and `SameSite=Strict`. A
   `location: /login?bad=1` line and no cookie mean that the token was wrong or still had its
   newline. The command resolves the name on the server. If the name exists only in the VPN's DNS and the server does not use it, add
   `--resolve mesh.example.com:443:192.0.2.1` to the `curl` options. To run it on another machine,
   copy the token file there first and use its path.
4. In a browser, sign in, open a terminal and upload a file. If the page loads but every action
   answers 403, the proxy changed `Host`, or does not send `X-Forwarded-Host`, or does not send
   `X-Forwarded-Proto: https` (the `https://` origin of the page is then compared with `http://`).

### What this protects, and what it does not

- It encrypts the token, the cookie and the terminals between the browser and the VPN address, and
  gives the page a secure context.
- It authenticates nobody. Every machine that the VPN lets reach `192.0.2.1:443` gets the login page;
  the token stays the only credential. Limit the VPN's own rules (WireGuard `AllowedIPs`, firewall)
  to the devices that need it, and read
  [SECURITY.md](../SECURITY.md#reverse-proxy-on-a-vpn-address).
- Any local user of this machine can still reach `127.0.0.1:7690` directly, as before, but cannot
  sign in without the token, with the reservations of
  [Other users on the same machine](../SECURITY.md#other-users-on-the-same-machine): other routes to
  the credential exist, and a user who occupies `127.0.0.1:7690` while the server is stopped,
  starting or restarting receives what your login sends (through the proxy as well). The proxy
  must not widen that reach: while Caddy's admin endpoint is open on
  `localhost:2019`, a local user can make the proxy forward to their own program and read the token
  and the cookie at the next login (see above). Restricting that endpoint is part of this setup.
- Caddy becomes one more program that holds your certificate key and sees the traffic in clear: keep
  it updated and run it under its own user.
- Caddy's logs can contain the `/login?token=…` URL if the server is down or fails while someone
  signs in through a link (the same limit as in
  [SECURITY.md](../SECURITY.md#other-limits)). Access logs are off unless you add `log` to a site.
  To strip the token from logged URLs, you can add this to the global options (not run: check it
  with `caddy validate`). The global `log` option configures Caddy's `default` logger, which also
  carries its runtime messages, not only requests. `wrap json` keeps their format, because Caddy's
  default encoder is JSON when its output is not a terminal, as under systemd; with `wrap console`
  they would switch to the console format:

  ```caddyfile
  log {
  	format filter {
  		wrap json
  		request>uri query {
  			delete token
  		}
  	}
  }
  ```

  Caddy's documentation says the global `log` option configures the `default` logger when it has
  no name, and that the site `log` directive configures access logs in a logger of its own (`log0`,
  `log1`, ...). A `log` directive that you add to the site block with its own `output` or `format`
  therefore escapes this filter and can record `?token=`: put the same `query { delete token }`
  filter inside it. Not run: the page does not say whether a bare `log` directive goes through the
  `default` logger's filter.

### What was tested

`tests/vpn-tls-proxy.test.ts` runs the real server on a throwaway port and home, without
`MESH_TRUST_PROXY`, behind a small Node HTTPS proxy with a throwaway certificate that mimics Caddy's
`reverse_proxy` defaults (Host kept, the three forwarded headers written by the proxy). It checks
the login, including the command-line login of step 3 (token with its newline removed, passed on
standard input and URL-encoded; the same file posted unstripped is refused), the `Secure` cookie, an
authenticated call, a same-origin POST and upload accepted, cross-origin and wrong-scheme ones
refused, forged `X-Forwarded-Host` and `X-Forwarded-Proto` sent by a client replaced by the proxy
without changing what the server answers, and a websocket upgrade accepted from the page origin
(that last case needs the native PTY host, `MESH_PTYHOST_CMD`, and is skipped without it).
The forged-header case shows what the server answers when the proxy overwrites those headers, and
that the test proxy does overwrite them; it does not show that Caddy does (that is Caddy's documented
behaviour, checked by step 4).
**Caddy itself, the Caddyfiles above, the admin socket, the redirect and HTTP/3 listeners, and the
certificate issuance were not run in CI.** The statements about Caddy come from its documentation
and source: confirm them with the checks above the first time you set it up.

## Restricting folders and agents

By default "New session" accepts any existing folder and offers every integrated agent. To narrow
that, write a JSON file and give its absolute path in the web server's environment as
`MESH_LAUNCH_SETTINGS` (with `systemctl --user edit session-mesh`, as in
[configuration.md](configuration.md#environment-variables)), then restart the web server:

```json
{"v": 1, "workspace_roots": ["/home/USER/projects"], "enabled_agents": ["claude", "pi"]}
```

- `workspace_roots`: 1 to 16 existing directories under your home directory. A session, or a
  session an agent asks to create, can only start in one of them or below. This holds for every
  way a session starts: "New session", a conversation resumed from the history, a session restored
  after a restart, an agent moved in from another terminal (it is left running there), and a
  restart. A refused one says "Folder outside the allowed workspace roots". Sessions already
  running elsewhere are not stopped, and a shell can still `cd` anywhere.
- `enabled_agents`: the agent presets offered, among `claude`, `codex`, `codex-yolo` (Codex
  without approvals or sandbox), `pi`, `opencode`, `agy`, `copilot` and `gemini`. The shell and a custom command remain available. It filters the presets
  of "New session" and of agents' requests only: resuming, restoring or moving in a conversation of
  another agent is not refused.

The file is read at startup, and rewritten by "Configuration" when you edit these two settings
there (after typing the master token): the rewrite is atomic, keeps the file's mode, and takes
effect for the next session without a restart. The file is identified by a revision (the SHA-256
of its bytes): a save made from a page that loaded an older revision is refused, and so is any
save while the file holds bytes this server did not write (you edited it by hand: restart the web
server to apply your edit). It must contain exactly these three fields. The web server does
not start when the variable names a missing, malformed or symbolic-link file (the reason is in
`journalctl --user -u session-mesh`). `python3 launchsettings.py`, run from the checkout with the
same variable set, prints the settings as the server reads them.

## Extra options per agent

"New session" has an **Options** field for every agent preset (not for `shell`, not for `other`).
What you type there is appended, as separate arguments, after the arguments Mesh gives the agent:
for Pi it loads an extension without losing the two Mesh adds.

```sh
# in the Options field of a Pi session
-e /home/USER/dev/my-extension.mjs
```

The field applies to that session only, and holds only these arguments: the stored default is shown
beside it and is added by the server, so it is never sent twice. Tick **Make this the default for
`<agent>`** to store what the field holds as that agent's default (an empty field clears it): the
same arguments are then added to every new session of that agent, including a session an agent asks
Mesh to create. Storing needs the master token, typed in the dialog once (ten minutes of
grace, as in Configuration); if it is refused the session still starts and the dialog says the
default was not saved.

"Configuration", section **Agents**, edits the same values for every preset at once, and clearing a
field removes that agent's entry. The values live in `agent-launch-options.json` in Mesh's
configuration folder (`~/.config/session-mesh`), one JSON array of arguments per preset:

```json
{
  "v": 1,
  "options": {"pi": ["-e", "/home/USER/dev/my-extension.mjs"]}
}
```

- **Where they apply.** Only to a new launch: "New session" and a session an agent asks for. A
  resumed conversation, a session restored after a PTY host restart and an agent moved in from
  another terminal keep the arguments that conversation already runs with.
- **What is refused.** Nothing else is checked, except the arguments that would turn the agent into
  the "no approvals, no sandbox" preset (for Codex `--yolo`,
  `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`, `-a never`,
  `-s danger-full-access`, `-c approval_policy="never"`, `-c sandbox_mode="danger-full-access"`;
  for Claude `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`,
  `--permission-mode bypassPermissions`) and the ones that pick the conversation
  (`--session-id`, `--continue`, `--resume`, `--fork-session`, Pi's `--session`, `--session-dir`,
  `--fork`, and a Codex subcommand). The check reads the parsed arguments, so `--sandbox=…`,
  `-a=never` and `-c 'approval_policy="never"'` are recognised like their spaced forms. A refused
  recognized argument is refused both when you save it and again just before a launch. The check
  does not model every form an agent CLI may accept; it is a guard rail, not a complete block.
- **When the file cannot be read.** The server keeps running, but every agent launch is refused with
  the reason: Mesh cannot know which presets an unreadable file grants options to, and starting
  without a restrictive argument would widen what the agent may do. The shell and `other` still
  start. Fix the file, or remove it, then restart the web server to read it again.
- **A session an agent asks for** is shown with the stored arguments of its preset; the approval is
  bound to the revision of that file, so a save made after the confirmation is shown asks again
  instead of launching the new arguments unseen.
- **Checking a change.** The behaviour is covered by `tools/check-launch-options.ts`, one named case
  per check (`node --experimental-strip-types tools/check-launch-options.ts <case>`; exit 0 passes,
  1 fails the assertion, 2 means the harness itself could not run). A representative subset runs
  with the Node suite; the full list is in the header of `tests/launch-options-checks.test.ts`.
- **Edits made by hand** are read at startup. A save from Configuration or a session dialog is
  refused while the file holds bytes this server did not write (the page says the revision is
  stale), so restart the web server after editing the file.

## Account aliases: separate Claude and Codex accounts

An account alias lets a session run Claude or Codex under another login than your usual one, for
example several work accounts and clients beside a personal one. You can declare any number of
aliases, up to 64, each Claude-only, Codex-only or both. An alias has an id, a label and up to two
folders: a Claude configuration folder (given to Claude as `CLAUDE_CONFIG_DIR`) and a Codex home
(given to Codex as `CODEX_HOME`). A session started without an alias, and every session when no
alias is declared, runs exactly as before.

Each folder holds that account's own login, settings, history and conversations: a conversation
started under an alias is not in the default account's history, and the reverse. Mesh never opens
the login files in these folders (`.credentials.json`, `.claude.json`, `auth.json`), never copies
them, and refuses them in `/view`. It does read, as it does for the default account:

- the alias's Claude `settings.json`, when a Claude session starts (to decide whether Claude
  delivers Mesh's wake line by itself);
- the names of the alias's Claude transcripts (`projects/*/<id>.jsonl`), when a session is
  restored, to check that its conversation is still there;
- the Codex rollout an alias's Codex keeps open (`sessions/YYYY/MM/DD/rollout-*.jsonl`), to show
  the conversation's last messages and state in the session list.

### Declaring aliases

For the native registry, open **Accounts and confirmations → Add account** and supply an alias
and existing runner directories for the selected backend. This does not sign in to the provider.
See [Backend account profiles](backend-account-profiles.md#register-an-alias) for creation and recovery.

This legacy format applies before explicit migration to `backend-profiles.json`. A configured profile
registry takes precedence; editing `accounts.json` after migration does not update that registry.

Write `accounts.json` in the Mesh configuration folder (`~/.config/session-mesh/`, or
`$MESH_CONF_DIR`) on the runner, by hand:

```json
{"v": 1, "accounts": [
  {"id": "work", "label": "Atacama",
   "claude_config_dir": "/home/USER/.agent-accounts/work/.claude",
   "codex_home": "/home/USER/.agent-accounts/work/.codex"},
  {"id": "perso", "label": "Perso", "codex_home": "/home/USER/.agent-accounts/perso/.codex"}]}
```

- `id`: 1 to 32 characters among `a-z`, `0-9` and `-`; `default` is reserved; unique.
- `label`: what the session list and the pane header show, 1 to 24 characters, at least one that
  is not a space, with no control, format (zero-width, bidirectional mark), line or paragraph
  separator character. Two aliases may not have the same label (ignoring the case of `A-Z`).
- `claude_config_dir`, `codex_home`: at least one, each declared by one alias only. An absolute
  path made of `A-Z a-z 0-9 . _ + @ / -` only (it is written on the agent's command line), with no
  symbolic link in it. Every folder above it, from `/` down, must belong to you or to root and not
  be writable by group or others, unless it is sticky like `/tmp`. An existing folder must be yours
  and not writable by group or others; a missing one is created with mode 0700 at the first
  launch, if its parent exists, is yours and is writable by you only.

`accounts.json` itself must be yours and not writable by group or others. More than 64 aliases,
or any invalid part, refuses the whole file. A declared folder whose parent does not exist also
refuses the whole file, as soon as it is read, not only when that alias is used.

The file is checked by `mesh-platform accounts list ~/.config/session-mesh/accounts.json`, which
prints the aliases as Mesh reads them, or why the file is refused. An invalid file offers no alias
at all (the reason is in `journalctl --user -u session-mesh`). The web server reads the file again
when it changes, the next time the New session dialog opens: no restart is needed.

`mesh-platform accounts resolve ~/.config/session-mesh/accounts.json claude|codex NAME` prints the
account of that agent that `NAME` designates, as `{"account": {"backend", "id", "label"}}`, without
any folder: the account whose id is exactly `NAME` (`default` included), otherwise the one whose
label is `NAME` ignoring the case of `A-Z`. It never accepts a prefix or an account of the other
agent, and creates nothing. A refusal exits 1 with `{"kind": "accounts", "error", "code"}`, where
the message names no folder (a path is shown as `<path>`) and `code` is one of:

- `accounts_refused`: the file is refused, as `accounts list` would say;
- `account_unknown`: no account of that agent has this id or label;
- `account_no_agent`: the id is declared, for the other agent only;
- `account_ambiguous`: several accounts match, listed in `candidates`. This includes a name that
  is one account's id and another account's label: name the account by its other name (its id or
  its label), or change that label.

Mesh remembers every folder an alias has declared (in `accounts-protected.json`, next to
`accounts.json`) and keeps refusing their login files in `/view` after the alias is removed or the
file refused: the logins stay on disk until you delete them.

Do not point an alias at a folder made of symbolic links into `~/.claude`: Claude keeps the
account's identity in `.claude.json` inside the folder, and a shared file would switch every
account at the next login.

### Moving aliases to backend profiles

With the same `MESH_CONF_DIR` as the web server, run `mesh-profile migrate` on the runner. It preserves
alias IDs, creates one profile per declared backend, and leaves the original file and agent folders
unchanged. It does not log in, copy conversations, stop agents or restart the PTY host. An existing
registry is never overwritten. A matching private migration intent can complete an interrupted
publication after identity and content checks; other existing registries refuse.

Success reports alias/profile counts. The retirement marker prevents a removed registry from silently
reactivating legacy aliases; an uncertain publication needs inspection, not a blind repeat. See the
[native migration contract](backend-account-profiles.md#explicit-migration-and-account-source-selection)
for source selection, recovery limits and deliberate rollback.

### Logging in once per account

Mesh does not handle logins. Log in once per alias, in any terminal on the runner (a Mesh shell
session works):

```sh
CLAUDE_CONFIG_DIR=/home/USER/.agent-accounts/work/.claude claude    # then /login, and /exit
CODEX_HOME=/home/USER/.agent-accounts/work/.codex codex login
```

Create the folders first if no session has used the alias yet, private at every level:
`(umask 077; mkdir -p /home/USER/.agent-accounts/work/.claude)`. A plain `mkdir -p -m 700` sets
0700 on the last folder only; under a `umask` of 002 the folders above it are writable by your
group, and the file is refused. `claude` then `/status`, or `codex login status`, run with the same
variable, shows which account the folder holds.

A credential in the environment comes before the login kept in the folder. When a session starts
under an alias, Mesh unsets, for that agent only, the variables that would override it, even if
your login shell's profile exports them: for Claude `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`,
`CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `AWS_BEARER_TOKEN_BEDROCK` and
`ANTHROPIC_FOUNDRY_API_KEY`; for Codex `OPENAI_API_KEY`, `CODEX_API_KEY` and `CODEX_ACCESS_TOKEN`.
If an account must use such a credential (an API key rather than a login), set it in that
account's own configuration (for Claude, the `env` block or `apiKeyHelper` of the alias's
`settings.json`), not in your profile, or do not declare aliases for that agent. Sessions under the
default account keep your environment as it is.

### Using an alias

When at least one alias is declared, New session shows an **Account** choice for Claude and Codex,
sorted by label. The browser remembers the last alias chosen on that device. A session started with
an alias shows its label as a badge on its row in the session list and in its pane header. The
alias is fixed when the session starts; to change it, start another session.

The page only sends the alias id; the folders stay on the runner. A launch is refused, never moved
to the default account, when the alias is unknown, has no folder for that agent (it is then shown
greyed in the list), is chosen for a shell, a custom command or another agent, or when one of its
folders fails the checks above at launch (the reason is in the server log, not in the page). An
alias remembered on a device but removed from the runner since stays selected, marked "no longer
declared", and is refused until you choose another account.

A restore after a PTY host restart keeps the alias: the conversation is looked for in the alias's
folder only, and the agent is relaunched with it. If the alias was removed from `accounts.json`
meanwhile, the restore of that session is refused. A restart that an agent requests and you
approve keeps the alias of the session too.

A Claude or Codex agent can also ask to continue its conversation under another account (its
`session.account_switch_request` tool, used when you ask for it in the conversation). The page
asks for your approval: the whole conversation is then copied into the other account's folder and
sent to that account's provider. Once approved, Mesh stops the agent, copies the conversation
with `mesh-platform accounts carry` (the transcript only, never a login or settings file) and
resumes it under the other account in the same session and terminal. When the copy fails (for
example the other account already holds a different copy of that conversation), the conversation
resumes under its own account, in the same terminal too, and the request records why. Codex
resumes a conversation from its copied rollout alone, and Claude from its copied
transcript alone (tried with codex-cli 0.170.0 and Claude Code 2.1.330 on throwaway accounts);
`session.accounts` still reports `switch_qualified: false`.

**Same terminal.** A switch, and a restart an agent requests, stop only the agent: the session
keeps its name, its shell, its terminal output and every open tab or pane. The PTY host sends
SIGHUP to the agent's foreground job, then SIGKILL after 3 seconds, and answers once the shell holds
the terminal again and no process of that job is left; only then is the conversation copied and
the agent started again, so two processes never run one conversation. The session then counts as
a new incarnation, as after a new launch: what belonged to the previous one (its wake state, the
status of a request it made) is not carried over, except the name you gave the session, its folder
and its place in the list, which the new incarnation keeps. This needs a PTY host from this release
or later (restarting it ends every mesh session, see
[Restoring sessions](#restoring-sessions-after-a-pty-host-restart)); with an older one, the agent
still resumes in a new session, which takes that name, folder and place. A session replaced as a
whole (`no_shell` below) also gives its name, folder and place to the new one.

While the agent is stopped and its conversation copied, open tabs show the shell's prompt. A line
someone starts typing there is erased before the agent's command is typed (Ctrl-E then Ctrl-U:
readline, zsh and fish in their default emacs mode, and the terminal's own line-kill key in a
shell without a line editor), so it is never joined to that command. This assumes an emacs-mode
line editor, or a vi-mode one still in insert mode. A vi-mode shell (`set -o vi`, `bindkey -v`,
`fish_vi_key_bindings`) left in command mode (Escape pressed at that prompt) reads those keys and
the command as vi commands: the line is not erased, and a mangled line may run instead of the
agent's command (for example `o: command not found`). Do not leave such a shell in command mode
during a restart. The keys typed are always the same two and the command; a line left open (an
unclosed quote) also takes the command as its continuation. A Claude restarted this way
keeps its wake socket's path (it follows from the session): the server removes the socket file the
stopped Claude left there before starting the next one.

When the PTY host cannot stop the agent alone, it signals nothing and says why; the server then
either falls back or refuses. It falls back only when the agent is the session's own program: a
stop of the whole session signals the shell's process group and sends SIGKILL only while the shell
lives, so in any other case an agent that ignores SIGHUP could outlive its shell and run the
conversation beside the new one:

| Reason | Meaning | What happens |
| --- | --- | --- |
| `no_shell` | The agent is the session's own program, with no shell around it. | The whole session is replaced by a new one, as before this release. An agent that ignores SIGHUP is killed (about 12 s later) before the new one resumes the conversation. |
| `no_job_control` | The shell runs the agent in the shell's own process group (job control off), with whatever else runs there. | Nothing is stopped; the request fails: quit the agent in that terminal, then resume the conversation. Closing the session is no substitute: it signals the shell's group only.. |
| `no_terminal`, `process_scan_failed` | The host cannot see what holds the terminal. | Nothing is stopped; the request fails: quit the agent in that terminal, then resume the conversation. Closing the session is no substitute: it signals the shell's group only.. |
| `unsupported_foreground` | Another program holds the terminal (an editor, `make`, `ssh`...), with job control on. | Nothing is stopped; the request fails: quit that program, or bring the agent back to the foreground, then ask again. |
| `agent_not_foreground` | The agent runs in the background, or beside a second agent. | Nothing is stopped; the request fails: bring it to the foreground (`fg`), then ask again. |
| `agent_starting`, `agent_still_running`, `stale_incarnation` | A launch is under way, the agent outlived SIGKILL, or the session changed since the request. | Nothing is started; the request fails with that reason. |

A program that Mesh does not recognise as the agent is never stopped: Mesh recognises an agent by
its process name or the name it was started under (`claude`, `codex`, ...), the same way in the
session list and in the PTY host. A Claude started as `node cli.js` is therefore not listed as an
agent at all, and a restart is refused before anything is stopped ("Agent to resume unavailable").

The server waits up to 15 seconds for the stop (the host answers within about 4). If it still has
no answer, it reads the session list: when the agent was stopped meanwhile, the request says so
("Conversation stopped; its agent could not be started again in session …"): the session and its
shell are still there, and you can resume the conversation from that terminal. Before this release
the server waited 5 seconds and reported the PTY host as not responding.

A Claude transcript or a Codex rollout whose last line was cut (an agent killed while writing it)
is copied as it is by the switch: the other account reads exactly what this one would, and the
source is never changed.

**First launch of an alias in a folder.** The first time an alias opens a working folder, the agent
asks in the session's terminal whether you trust that folder: Claude shows "Accessing workspace"
with "Yes, I trust this folder" (the preselected answer is "No, exit"), Codex shows "Trust this
folder?" with "1. Trust and continue" (in a git repository). Answer it once per alias and folder:
the agent keeps the answer in that alias's own files (`.claude.json` in the Claude folder,
`config.toml` in the Codex folder) and does not ask again. Mesh never writes these answers for you.
A conversation carried to another account (`mesh-platform accounts carry`) meets the same
question when that account resumes it; if "No, exit" is chosen by mistake, the conversation is
already in the account's folder and a restart resumes it. To avoid the question, open each alias
once in the folders you use, for example `cd <folder>`, then
`CLAUDE_CONFIG_DIR=/home/USER/.agent-accounts/work/.claude claude` or
`CODEX_HOME=/home/USER/.agent-accounts/work/.codex codex`, answer, and exit.

Limits of this version:

- The variable is set on the agent's command line, not in the session's shell: after the agent
  exits, a `claude` typed in the same pane runs under the default account.
- The history panel, "Resume" from the history, and moving in an agent running in another terminal
  only know the default account's folders.
- Waking Codex with `codex queue` (below) reaches the default Codex home, not an alias's.
- A new session that an agent requests (and you approve) starts under the default account, even
  when the requesting session runs under an alias.
- The session list's details for a Claude session under an alias (its conversation id and last
  messages) come from the default account's `~/.claude/sessions`: they may be missing.
- A restored alias session whose Claude folder has no `projects/` folder yet is relaunched with
  `claude --resume`, which then fails in the pane instead of being refused before launch.
- The agent is started with `env`, so a `claude` or `codex` available only as a shell alias or
  function is not found under an alias.
- Mesh does not check that `.claude.json` or the login files in an alias's folder are not symbolic
  links into another account's folder (see the warning above).
- Per-alias colours, the alias in the browser tab title, and a login helper are not part of this
  version.

## Codex hooks: trust once per Codex home

Mesh starts every Codex session with one hook, read-only and stopped after 1.5 s, that tells Codex which
tracked tasks are linked to the session's folder ([Codex](agent-hooks.md#codex)). Codex runs a hook only
once you have trusted it, and Mesh never trusts it for you. The first Codex session that Mesh starts with a
given Codex home shows:

```text
Hooks need review
1 hook is new or changed.
Hooks can run outside the sandbox after you trust them.
› 1. Review hooks
  2. Trust all and continue
  3. Continue without trusting (hooks won't run)
```

- **Trust all and continue** (or **Review hooks**, then trust it there): Codex records the trust in the
  `config.toml` of that Codex home and does not ask again. The session then starts as usual; the hook's
  sentence goes to the model, not to the screen.
- **Continue without trusting**: the session starts without the hook and Codex records nothing, so the
  screen comes back at the next session. Nothing else changes: Codex works as it did before.

The trust belongs to one Codex home. Your default `~/.codex` (or `$CODEX_HOME`) and the Codex home of
each account alias ([Account aliases](#account-aliases-separate-claude-and-codex-accounts)) are trusted
separately: the first Mesh session under each alias asks once more. Codex asks again when the hook
changes, which happens when the installation directory changes (for example after moving from a source
install to a release) or when a later version of Mesh changes the hook.

A session Codex starts without its interactive screen (`codex exec`) never shows the question and
skips an untrusted hook silently. `MESH_PROJECT_HOOKS=0` in the web server's environment stops adding
the hook to the Codex (and Claude and Vibe) sessions started or restored afterwards.

## Debugging the agent hook

Claude Code sessions started by the mesh report their state (busy, waiting, finished) through the
hook `bin/mesh-event`. It never prints anything and always exits successfully, so a
failure cannot disturb the agent. To see why it fails, export `MESH_EVENT_DEBUG=1` in the shell of
the session before starting the agent: the hook then writes its error on standard error.

## Waking Codex with codex queue

This wake is **off by default**. Delivery through `codex queue` to a Codex already open in a terminal
has not been tried on a real session (`docs/agent-integration.md`, criterion 8), so until the owner has done that trial a Codex session is never woken
and its messages wait in the inbox. To turn it on, export `MESH_CODEX_QUEUE_WAKE=1` in the environment of
the web server (for example `systemctl --user edit session-mesh` with `Environment=MESH_CODEX_QUEUE_WAKE=1`)
and restart it; any other value leaves it off. The setting is read once at start-up.

Trial before turning it on, on a disposable Codex session (a scratch folder and a throw-away
`CODEX_HOME`, never a conversation that matters): start the web server with the setting, open a Codex
session, send it one message from another session, and check that the notice reaches the already
open terminal while Codex is idle, that it does not disturb a turn in progress and an open permission
dialog, and that reading the inbox clears any unconfirmed mark. Turn the setting off again if any of
these fails.

With the setting on, the mesh wakes a Codex session by running `codex queue --thread <conversation id> --message <fixed
line>` (no `--resume`) for the exact conversation the session holds open. It uses the `codex` first on
the PATH that sessions get (`~/.local/bin` included) as an absolute path, with a short environment
(no `MESH_*` name, no secret) and at most 15 seconds and 64 KiB of output. Each attempt is recorded
in `codex-queue-wakes.json` in the configuration folder (0600) before the process starts and is never
repeated: a session whose attempt failed shows the unconfirmed mark until its inbox is read. A session
that was alive when the state file was found damaged (the file is kept next to it as
`codex-queue-wakes.json.damaged-<time>`) stays unconfirmed until it ends, whatever is read, and so does a
wake withheld because 1024 attempts are in doubt (until a later wake succeeds). To stop waking Codex, unset
`MESH_CODEX_QUEUE_WAKE` (or remove `codex` from the PATH sessions see); with it unset, the state file is
neither read nor written.
`MESH_CODEX_QUEUE_TIMEOUT_SECONDS` (1 to 60) shortens the limit for tests, and `MESH_CODEX_QUEUE_MAX_TRACKED` (1 to 1024) the number of attempts kept.

Known limits of this wake: one `codex queue` is run per notification (the notifications of one Codex
turn are not grouped); the conversation is checked again just before the attempt is recorded, not between
that record and the exec; two servers sharing one configuration folder are not supported for this wake; and
the `codex` found first on the PATH that sessions get is trusted, as is every directory of that PATH;
and a wake withheld because every one of the 1024 kept attempts is in doubt is retried like a transport
failure, so the retry backoff (up to 60 seconds) applies to the wakes of every agent until room exists
(theoretical: it takes 1024 sessions with an unconfirmed attempt).

## Settings reserved for tests

`MESH_HISTORY_RESUME_GRACE` is not an operating setting: leave it unset. After a conversation is
resumed from the History, the web server keeps that conversation marked as "just resumed" for 20
seconds, so that a second click cannot start a second agent while the first has not yet opened its
transcript. The variable, read once at start-up in the web server's environment, replaces those 20
seconds with a number of seconds from 1 to 60, so that a test need not wait the whole delay. A
value that is not a number in that range is ignored: the server logs it once, uses 20 seconds and
starts normally. A shorter delay only weakens the protection against a double click.

## A second mesh for testing

To try a branch without touching the mesh you use, `scripts/preprod.sh` starts, from the current
checkout, a second PTY host and web server that share nothing with it:

```sh
scripts/preprod.sh start     # http://127.0.0.1:7691, token in ~/.cache/session-mesh-preprod/conf/token
scripts/preprod.sh status
scripts/preprod.sh stop      # ends its sessions, then stops its two processes, and only them
```

It has its own port (7691), configuration directory (`MESH_CONF_DIR`), cache directory
(`MESH_CACHE_DIR`) and runtime directory under `/tmp` (both `MESH_RUNTIME_DIR` and
`XDG_RUNTIME_DIR`), hence its own PTY host socket. `HOME` does not
change, so the agents keep their logins. **Push notifications are off** there (`MESH_PUSH=0`). The
script refuses to start when the port, socket or configuration directory are those of the main
mesh, or when the port is taken; `scripts/preprod.sh check` runs only those checks. Variables:
`MESH_PREPROD_PORT`, `MESH_PREPROD_DIR`, `MESH_PREPROD_RUNTIME`. It installs no systemd unit, so it
does not come back after a reboot.

Sessions of that mesh receive `MESH_CONF_DIR` and `MESH_PORT`, so `mesh-open` there reaches that
mesh.

## Installer limits

`install.sh` checks these before changing anything, and stops with a message when one fails:

- It runs only as an ordinary account, never as root or with `sudo`. On Linux it also needs a
  systemd user session: when `systemctl --user` cannot reach the user manager (a container or WSL
  without systemd), it stops with "session-mesh needs a systemd user session".
- A release installer runs from a file, on a platform for which the release publishes a bundle or
  the native programs, and installs only files whose SHA-256 (and, with `gh` logged in,
  attestation) matches, and a bundle only when its native programs match its manifest
  ([Installing a release](#installing-a-release)).
- A source install, or a release installed from its native programs, needs Python 3.10 or newer
  with the dependencies of `requirements.txt`; an install from a bundle runs the bundle's own
  Python and asks nothing of the machine's.
- Services that run another extracted bundle are left as they are unless `--switch-from-bundle`
  ([Moving from an extracted bundle](#moving-from-an-extracted-bundle)).
- On Linux, a release install, a bundle install or a switch refuses while a drop-in of either unit
  sets `ExecStart=`, `Environment=`, `EnvironmentFile=`, `UnsetEnvironment=` or
  `PassEnvironment=` ([Moving from an extracted
  bundle](#moving-from-an-extracted-bundle), "Drop-ins on the units").
- `MESH_PORT` (default: the port of the installed web unit, otherwise 7690) must be a number from 1
  to 65535 without a leading zero.
- systemd does not accept quotes, backslashes or glob characters (`*`, `?`, `[`) in an executable
  path: the installer refuses such a path for the Python interpreter or the native PTY host. Spaces,
  `%` and `$` are supported. The checkout path may not contain control characters.
- On macOS: the system must be macOS 12.3 or later; the PTY socket path must fit in 103 bytes;
  agents and boot-time daemons are never mixed, and the session type of an installed PTY agent
  must be loadable from the current login ([macOS](#macos)).
- The installer refuses to proceed when the PTY unit is in transition, is masked, waits for
  `systemctl --user daemon-reload`, or when a file other than a stale socket of your account sits
  where its socket goes while the unit is stopped ([Replacing the PTY host](#replacing-the-pty-host)
  gives the remedy).

### Prebuilt binaries

A release of session-mesh carries its own installer, a *bundle* per platform (an archive that runs
session-mesh without Python, Node, opam or a compiler on the machine;
[docs/binary-bundles.md](binary-bundles.md) describes its content and how it is built), and the
native programs of each platform with the code of the tagged commit. Releases are on the
[releases page](https://github.com/Session-Mesh/session-mesh/releases) of the repository. Check
`install.sh` as shown below before you run it; once running, it installs the bundle of your
platform when your system meets the bundle's floor (table below), otherwise the release's native
programs and the code, run with your Python (`MESH_PYTHON`, else `python3` on `PATH`, 3.10 or later
with `aiohttp`), and says why. It checks every file it downloads against the checksum stamped into
it. On Linux it reads the glibc version with `getconf GNU_LIBC_VERSION`; where that fails (musl, as
on Alpine) it installs the native programs, which are static. A Mac older than macOS 13.0 is
refused, with the floors named: install from a clone there.

**What a release contains.**

| File | Content |
|---|---|
| `install.sh` | the installer of that release, with the release tag and the SHA-256 of every other file written into it |
| `mesh-<platform>.tar.gz` | the bundle of a platform: the code of the tagged commit, its own CPython and Node runtimes with the locked Python dependencies, and the native programs `mesh-ptyhost`, `mesh-board-mcp`, `mesh-read`, `mesh-platform`, `mesh-history`, `mesh-logout-all`, `mesh-open`, `mesh-profile`, `work-read`, `work-mcp` and `work-write`; `mesh-macos-arm64.tar.gz` only when its build passed (the release notes say whether it is there) |
| `<program>-<platform>` | each of the eleven native programs alone, for `linux-x86_64`, `linux-aarch64` and `macos-arm64` |
| `session-mesh-<tag>.tar.gz` | the code of the tagged commit (`git archive`), which the native programs run with |
| `SHA256SUMS` | the SHA-256 of every file above, `install.sh` included |

Every one of these files also carries a build provenance attestation, stored by GitHub rather than
attached to the release (see the trust model below).

| Platform | Bundle | Native programs | Built and qualified on |
|---|---|---|---|
| Linux, x86-64 | `mesh-linux-x86_64.tar.gz`: glibc 2.28 or newer | `<program>-linux-x86_64`: static, any libc | bundle in the `manylinux_2_28` image (AlmaLinux 8, glibc 2.28) on Ubuntu 22.04; programs in an Alpine container on Ubuntu 24.04 |
| Linux, arm64 (aarch64) | `mesh-linux-arm64.tar.gz`: glibc 2.28 or newer | `<program>-linux-aarch64`: static, any libc | the same, on the arm64 runners |
| macOS, Apple silicon | `mesh-macos-arm64.tar.gz`: macOS 13.5 or newer | `<program>-macos-arm64`: macOS 13.0 or newer | macOS 14 runner |

The floors are written once, in `install.sh` (`BUNDLE_GLIBC_FLOOR`, `BUNDLE_MACOS_FLOOR`,
`PROGRAMS_MACOS_FLOOR`): the installer checks your machine against them, and the release workflow
checks the files against the same values (`scripts/release-floor.sh`).

Every file is built and qualified by its own job of the release workflow, on that platform's
runner, and the release is published only when every job passed in the same run, with one
exception: when the macOS bundle's job fails, the release is published without
`mesh-macos-arm64.tar.gz`, and a Mac then installs the macOS native programs and the code. No other
file may be missing. What the jobs check:

- the Linux bundles are built in the `manylinux_2_28` image of their architecture, pinned by digest;
  no ELF file of a bundle may require a glibc symbol version newer than 2.28
  (`scripts/release-check-glibc.sh`, which reads the symbol versions with `objdump -T`), and each
  bundle is run, extracted, in that image (glibc 2.28) as well as on the runner;

- the static Linux programs are built in an Alpine image pinned by digest, checked to be statically
  linked, and started (`scripts/release-smoke.sh`: the PTY host answers on its socket, the other
  programs start);
- the macOS programs are built for macOS 13, checked to link `/usr/lib/libSystem.B.dylib` only and
  to hold no object built for a newer macOS (`scripts/release-check-macos.sh`), and started the
  same way;
- each bundle is run, extracted, on the runner that built it (`scripts/smoke-bundle.sh`: HTTP, a
  native PTY session and the board MCP server, with nothing but the system's utilities on `PATH`);
  the macOS bundle's native programs pass the checks of the macOS programs, every Mach-O file of it
  is checked against macOS 13.5, and its build refuses any library outside the system's
  (`/usr/lib`, `/System/Library`). The Linux bundles' runtimes and native programs use the system
  glibc, which is why they are built against the oldest supported one.

Intel Macs get neither a bundle nor native programs: install from a clone there
([Installing on macOS](#installing-on-macos)).

A tag with a suffix (`v1.3.0-rc.1`) is published as a pre-release: GitHub never reports it as the
latest release, so only someone who names that tag installs it.

**What you are trusting.** A release is built and published by the release workflow
(`.github/workflows/release.yml`) on GitHub's runners, with no step by hand and no signing key of
ours. Three things protect what you download:

- HTTPS from GitHub delivers the files as GitHub stores them.
- `SHA256SUMS`, from the same release, detects a corrupted or incomplete download. It does not
  detect a tampered release: whoever could replace a file could replace `SHA256SUMS` too.
- The build provenance attestation (GitHub artifact attestations, Sigstore, keyless) is a signed
  statement, bound to the workflow run's identity, that this exact file was built by the release
  workflow of `Session-Mesh/session-mesh` from the tag named in the check below
  (`--source-ref refs/tags/<tag>`). A file uploaded by hand, built by any other workflow, or built
  from another tag fails that check.

The attestation says which workflow built a file and from which tag; it does not say that the tag
names a reviewed commit of `main`. The release workflow does refuse a tag whose commit is not on
`main`, but that check is part of the workflow file of the tagged commit itself: anyone who can push
to the repository can push a tag on a commit whose workflow lacks the check, and the release built
from it carries a valid attestation. Anyone holding a token with `contents: write` can also replace
the files of a published release, `SHA256SUMS` included; files uploaded by hand fail the attestation
check, so run it.

**So the trust rests on GitHub and on every credential that can push to the repository**: the
maintainers' accounts and every token they hold, including the tokens stored on machines where
agents run. Two-factor authentication protects the interactive sign-in only, not those tokens. A
compromised credential with push access is not defended against: it can publish a release that
passes every check, attestation included. The attestation also does not prove that the source is
free of defects.

The repository owner can narrow this with two GitHub settings, which this document does not claim
are enabled: immutable releases (the files of a published release can no longer be replaced or
deleted), and a tag ruleset that restricts who may create `v*` tags.

**Checking `install.sh` before running it.** Download `install.sh` and `SHA256SUMS` of one release
into an empty directory, then check both the checksum and the provenance:

```sh
tag=v1.2.3   # the release you install
base="https://github.com/Session-Mesh/session-mesh/releases/download/$tag"
curl -fsSLO "$base/install.sh" -O "$base/SHA256SUMS"
sha256sum -c --ignore-missing SHA256SUMS      # macOS: shasum -a 256 -c --ignore-missing SHA256SUMS
gh attestation verify install.sh --repo Session-Mesh/session-mesh \
  --signer-workflow Session-Mesh/session-mesh/.github/workflows/release.yml \
  --source-ref "refs/tags/$tag"
bash install.sh
```

The checksum check must report `install.sh: OK` (in an English locale); `--ignore-missing` skips
the files you did not download. The macOS command has not been run on a Mac. `gh attestation
verify` needs the [`gh` CLI](https://cli.github.com/), recent enough to support `--source-ref`
(tested with 2.102.1), logged in (`gh auth login`), and network access; keep `--signer-workflow`,
without which any workflow of the repository would be accepted, and `--source-ref`, without
which a file built from any other tag would be accepted. Without `gh`, skip that line: you then rely on HTTPS and the checksum,
which do not detect a tampered release.
Once running, the installer applies the same two checks to the bundle it downloads: the hash stamped
into it and, when `gh` is on your `PATH` and logged in, the attestation with the same
`--signer-workflow` and `--source-ref` ([Installing a release](#installing-a-release)). A bundle
downloaded by hand is checked the same way (both commands, with its name instead of `install.sh`),
then used as in [docs/binary-bundles.md](binary-bundles.md).

#### Installing a release

The release workflow stamps into `install.sh` the release tag and the `SHA256SUMS` line of every
bundle of the release. From those values only (never a value from the environment), the installer
picks the bundle of this machine (`uname -s`, `uname -m`), builds its URL
`https://github.com/Session-Mesh/session-mesh/releases/download/<tag>/mesh-<platform>.tar.gz`,
downloads it into a staging directory `~/.local/share/session-mesh/releases/.stage-<tag>.*`, checks
its hash, then (with `gh` logged in) its attestation, against the release workflow and
`refs/tags/<tag>`. Only then does it extract the archive, check that it holds one bundle
`mesh-<platform>/` whose eleven native programs have the hashes recorded in its `bundle.json`, and
rename that directory to `releases/<tag>`.

- Without `gh`, or with `gh` not logged in, the attestation is not checked: the installer says
  so once, with the command to check a file by hand. With `MESH_REQUIRE_ATTESTATION=1` in the
  environment it refuses instead, and installs nothing. Any other failure of `gh attestation
  verify` refuses the release.
- An archive that differs, a bundle that does not match its manifest, a missing asset or a network
  failure: the staging directory is deleted, nothing of the release is installed, and the installer
  exits with an error that names the file. It never falls back to another source.
- The directories `~/.local`, `~/.local/share`, `session-mesh` and `releases` are created with mode
  0755; an existing one that is not yours, or is writable by group or others, is refused, and
  `session-mesh` and `releases` must not be symbolic links. Nothing in a release directory is
  writable by group or others.
- A release already on disk is reused when its `release.sha256` names the stamped archive and its
  native programs still match its `bundle.json`; otherwise the installer refuses and says how to
  remove it. The check is that and no more: `release.sha256` is written by the installer, and the
  rest of the bundle (`app/`, `runtime/`) is not compared with its archive again, so a modified file
  there is reused without a warning. Only the account that owns the installation can modify it,
  which is the same account that runs the services; to be sure of a release directory, remove it and
  reinstall it. A release branch built from the repository has the same limit.
- The installer keeps a copy of itself in `releases/<tag>/install.sh`, the command for
  `--upgrade`, `--rollback` and `--uninstall`. It must run from a file: piped into `bash`, it
  refuses.
- A machine for which the release publishes neither a bundle nor the native programs (an Intel
  Mac, another architecture): the installer names the platforms the release has and downloads
  nothing; use a source install.

A release with a bundle runs the web unit as `current/bin/mesh-python current/app/server.py`.
The `current/bin/mesh-ptyhost` wrapper executes `current/libexec/mesh-ptyhost`.
The links in `~/.local/bin` point to native executables for `mesh-open` and `mesh-logout-all`,
and to wrappers that run the bundle's Python for `mesh-attach` and `mesh-rename`.
Each wrapper sources the bundle's `env.sh`, which sets `MESH_BIN_DIR` to the bundle's `bin/`.

**A release without a bundle for this platform.** The installer prefers the bundle. When the release
has none for this machine but publishes its native programs, it installs those instead: the code
archive `session-mesh-<tag>.tar.gz` and the eleven programs `<program>-<platform>`
(`linux-x86_64`, `linux-aarch64` or `macos-arm64`), each checked against the stamp (and its
attestation) before anything is unpacked, then laid out as `releases/<tag>/app` (the code) and
`releases/<tag>/bin` (the programs). The web unit then runs this machine's Python
(`MESH_PYTHON`, else `python3` on `PATH`, checked as for a source install) on
`current/app/server.py`. The PTY unit runs `current/bin/mesh-ptyhost`.
The `~/.local/bin` links for `mesh-open` and `mesh-logout-all` point to the executables in
`current/bin`. The release's `app/bin/work-read` and `app/bin/work-write` link to the programs
in its `bin/`, where the web server looks for them (`/api/work/v1`). Upgrades and rollbacks can
move between a release with a bundle and a release of native programs.

#### Where the native programs are found

The web server gives agents the board MCP server `MESH_BIN_DIR/mesh-board-mcp` when `MESH_BIN_DIR`
is set, which a release or bundle install always does through `env.sh`: agents of a release
install use the `mesh-board-mcp` of the release the web server runs. Without `MESH_BIN_DIR` (a
source install, or a release installed from its native programs, whose `app/bin/mesh-board-mcp`
links to the release's own), `agentmcp.py` uses `bin/mesh-board-mcp` beside the code when it exists, otherwise
the `bin` directory of the opam switch: `MESH_OPAM_SWITCH`, otherwise the switch of the current
opam environment, otherwise a local switch in the checkout (`_opam/`). The PTY host is the
exception: its unit or job runs the exact file the installer chose (`current/bin/mesh-ptyhost`
for a release install). The web server finds `work-read`, which answers `/api/work/v1`, in the same
places: `MESH_WORK_READ_CMD` when set, otherwise `bin/work-read` of `MESH_BIN_DIR` or beside the
code (`app/bin/work-read` of a release installed from its native programs links to the release's
own), otherwise, only when `MESH_BIN_DIR` is not set, the opam switch's
([work-read.md](work-read.md)). It finds `work-write`, which records the owner's answers from the
Projects view, the same way, with `MESH_WORK_WRITE_CMD`. `mesh-read`, `mesh-platform` and `work-mcp` are commands you run, or
that you add to an agent's configuration, by their path in one of these places.

Building from source with `scripts/bootstrap.sh` ([install.md](install.md#native-pty-host)) remains
supported and installs the same programs into an opam switch.

#### MCP call tracing

Set `MESH_MCP_TRACE_JOURNAL` on the Mesh server to an absolute path to opt in to the
built-in MCP call journal for the board and work servers of newly launched agent sessions. Leave
it unset to disable this journal. The containing directory must already exist; the journal is created private
to the server user, and an existing file must be a private regular file owned by that user.
The server rejects symbolic links and hard links. This works in the statically linked Linux
release as well as source builds.

The journal records call timing, protocol method, registered tool and subcommand, and outcome.
It does not contain tool arguments, responses or session tokens. Board calls use a digest of the
session credential; work calls have no session identity in this journal. Journal writes can fail
independently of a call, so the file is not an exhaustive
audit record. A writer that cannot acquire the journal lock promptly drops the event; the MCP server
reports a write failure to its standard error and continues serving.
The operator is responsible for the journal's location, retention and removal.

On a dynamically linked build, `MESH_MCP_TRACE_PLUGIN` may instead name an absolute path to an
OCaml tracing plugin for `mesh-board-mcp`. When both variables are set, the plugin takes precedence
for board calls; work calls continue to use the built-in journal. A plugin load failure is reported
and board calls continue without tracing. Dynamically loading a plugin is not supported by the
statically linked Linux release; use the built-in journal there.

#### Publishing a release

A maintainer publishes a release by pushing a tag on a commit of `main`; nothing else:

```sh
git switch main && git pull --ff-only
git tag v1.2.3            # or v1.3.0-rc.1 for a pre-release
git push origin v1.2.3
```

The workflow then refuses a tag of another form (`vX.Y.Z` or `vX.Y.Z-suffix` only) and a tag whose
commit is not on `main`, before any build. On each platform's runner it builds and qualifies the
native programs and the bundle as [Prebuilt binaries](#prebuilt-binaries) describes; any build or
check that fails stops the release, the macOS bundle's included. It takes from each build only the
files of its own target (`scripts/release-assets.sh collect` and `collect-bundle`), adds the code
archive, assembles the stamped `install.sh` and `SHA256SUMS` (`scripts/release-assets.sh bundle`),
checks them, attests every file and publishes the release. A release older than the current latest
one (`v1.2.4` published after `v1.3.0`) is published with `--latest=false`, so that whoever asks
GitHub for the latest release gets the newest one; versions are compared as semantic versions,
`v1.10.0` after `v1.9.0` and `rc.10` after `rc.9`. It never creates a tag and never modifies
an existing release: a second run for the same tag fails. If publishing fails part-way (an upload
error), a draft may remain; delete it on the releases page, then re-run the workflow. A manual run
(the "Run workflow" button) is a dry run: it builds and keeps the files as a workflow artifact for
14 days, and never creates a tag or a release; run on `main`, it also fills the build caches that
the next tag run reads.

The native programs are built from the opam repository at the commit fixed in
`scripts/release-pins.sh`, the static Linux ones in an Alpine image pinned by digest whose packages
are not pinned (`scripts/release-build-static.sh`); the bundle's Python dependencies are locked with hashes in
`scripts/bundle/requirements.lock`, and its CPython and Node versions are fixed by
`scripts/build-bundle.sh`. The runner images and their system packages are not pinned, so two
builds of one commit may differ.
