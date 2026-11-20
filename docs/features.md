# session-mesh features

This page describes what you can do in the session-mesh interface once it is installed, organised
by task: keyboard shortcuts, sessions and history, documents and the file tree, the whiteboard and
demos, messages between agents, notifications and the phone layout. Installation and configuration
are in [install.md](install.md) and [configuration.md](configuration.md); upgrades, restores and other maintenance are in
[docs/operations.md](operations.md); the security model is in [SECURITY.md](../SECURITY.md).

Interface labels are quoted as they appear in the English interface.

## Contents

- [Keyboard and mouse shortcuts](#keyboard-and-mouse-shortcuts)
- [Starting and finding sessions](#starting-and-finding-sessions)
- [The Projects view and the project tracker](#the-projects-view-and-the-project-tracker)
- [Projects and recorded Roster state](#projects-and-recorded-roster-state)
- [Organising the sidebar](#organising-the-sidebar)
- [Observed directories](#observed-directories)
- [Working in a terminal](#working-in-a-terminal)
- [Voice dictation](#voice-dictation)
- [Columns and panes](#columns-and-panes)
- [Documents beside the terminals](#documents-beside-the-terminals)
- [Browsing files](#browsing-files)
- [Conversation history](#conversation-history)
- [Whiteboard and demos](#whiteboard-and-demos)
- [Messages and requests from agents](#messages-and-requests-from-agents)
- [Pi sessions](#pi-sessions)
- [OpenCode sessions](#opencode-sessions)
- [Gemini CLI sessions](#gemini-cli-sessions)
- [Antigravity sessions](#antigravity-sessions)
- [GitHub Copilot CLI sessions](#github-copilot-cli-sessions)
- [Mistral Vibe sessions](#mistral-vibe-sessions)
- [Notifications](#notifications)
- [Phone](#phone)
- [Language, reload, source code and sign-out](#language-reload-source-code-and-sign-out)
- [Colour themes and custom palette](#colour-themes-and-custom-palette)

## Keyboard and mouse shortcuts

`n` and `o` work only when nothing on the page has the focus (not a text field, a terminal or a
button) and none of `Ctrl`, `Meta` or `Alt` is held.

| Where | Keys | Effect |
|---|---|---|
| Page | `n` | "New session" dialog. |
| Page | `o` | "Open a page alongside" dialog. |
| Page | `?` | Lists the shortcuts (also the `?` button at the foot of the sidebar). |
| Page | `Ctrl+K` (`Cmd+K` on macOS) | Moves the focus to the session search (the sidebar filter, or the explorer's search when the explorer is open) and selects its text. Opens the sidebar on a phone-width screen, and leaves the projects view for the sessions. `Esc` in the search gives the focus back to where it was. Works only when the focus is not in a terminal, a text field, the phone input line or a dialog: in those the key goes unchanged to the application. |
| Anywhere | `Ctrl+Shift+K` (`Cmd+Shift+K` on macOS) | Same effect as `Ctrl+K`, including from a terminal, where the key is not sent to the program. Not active while a dialog is open. |
| Explorer, "Mesh management" | `Esc` | Back to the panes. |
| Terminal | `Shift+Enter` or `Alt+Enter` | New line without sending. The mesh sends what the agent expects: a line feed for Codex, `Esc` then `Enter` (Meta+Enter) for the others. |
| Terminal | `Ctrl+C` | Copies when text is selected; otherwise sends `^C`. |
| Terminal | `Ctrl+Shift+C` | Always copies the selection. |
| Terminal | `Ctrl+Shift+X` (`Cmd+Shift+X` on macOS) | Copies the selection as a shell command, so that pasting it into bash or zsh runs it as one command. Rows the terminal soft-wrapped are joined with no break; a line break gets a trailing `\` only when the next row is indented and starts with an option (`-x`, `--long`), and every row after the first one in the same block of non-blank rows is such an option row (or follows a row that already ends in `\`). A continuation row that does not start with an option is not joined, and nothing is ever guessed from indentation: when unsure, the text is copied as it is. A row that already ends in `\`, separate commands, comments, heredocs, quoted multi-line strings and rows ending in an operator are left as they are. A selection that starts with a prompt, or ends inside a quote or heredoc, is copied unchanged. When the rows cannot be rebuilt (a column selection) the plain selection is copied. The usual copy is not affected, unless the `copyAsShell` preference is on (see [Working in a terminal](#working-in-a-terminal)). |
| Terminal | `Ctrl+V` | Pastes text; when the program in the terminal supports bracketed paste, multi-line text arrives in one block. Pasting a file or an image uploads it instead (see [Working in a terminal](#working-in-a-terminal)). |
| Terminal | Right-click on a selection | Copies it. |
| Terminal | `Shift`+drag (`Option`+drag on macOS) | Selects text even when the program in the terminal captures the mouse. |
| Terminal | Click on a path or link | Opens it beside the terminal: a document, a source file, or the file tree for a directory. A web URL opens in a new browser tab. |
| Terminal | Click on a task, project or question id (`T-…`, `P-…`, `N-…`) | Opens the Projects view on it, when the tracker knows that id. |
| Terminal | `Ctrl`+click (`Cmd`+click) on a document path | Opens the document in a new browser tab. |
| Terminal | Right-click on a path to an HTML, Markdown or SVG file | Opens its source in the code viewer. |
| Terminal | Right-click on a web URL | "Open in the external browser": opens it in the browser of the machine running the mesh. |
| "Write in the terminal" dialog | `Ctrl+Enter` | Sends the text. |
| Phone input line | `Enter` / `Shift+Enter` | Sends / new line. |
| Session list | `Menu` key or `Shift+F10` | Session menu. Arrows, `Home` and `End` move in it, `Esc` closes it. |
| Session name in the list, pane title | Double-click | Rename. A folder is renamed with its ✎ button ("Rename folder"). |
| Column separator | Double-click | Gives equal widths to the two columns on either side of it. |
| Sidebar edge | Double-click | Resets the sidebar width. |

### How shortcuts are bound

Shortcuts are declared in one table (`static/shortcuts.ts`, built into `static/shortcuts.js`): an
identifier, the chord per platform, a validity context, an action and the catalog key of its
label. One capture-phase listener on the document resolves a keydown against the table and the
current focus (terminal, text field, phone input line, dialog, plain page); the terminal's key
handler asks the same table before xterm sees a key. A key that resolves to nothing is not touched:
it is neither prevented nor stopped, so it reaches its target as usual.

The contexts are `outside-terminal` (the page itself has the focus), `anywhere` (every focus except
a dialog, the terminal included) and `terminal-captured` (only a terminal). `npm run
check:shortcuts` checks the table against these rules:

- two entries whose contexts overlap never share a chord, on either platform;
- a binding has a modifier, except one valid only outside a terminal (`n`, `o`, `?`);
- a binding that reaches a terminal needs the primary modifier and Shift, and may never be a key
  that terminal programs read (`Ctrl+A`, `E`, `K`, `U`, `W`, `R`, `C`, `D`, `L`, `Z`, `Alt+B`,
  `Alt+F`, `Ctrl`+arrows, `Esc`, `Tab`...);
- a binding is not one of the chords the browser keeps (`Ctrl+T`, `Ctrl+N`, `Ctrl+W`...).

`Ctrl+K` is "kill to end of line" in readline and Emacs, and agents' TUIs read it, so it is bound
only outside a terminal. On macOS the shortcut is `Cmd+K`, and `Ctrl+K` still goes to the terminal.
The shortcuts that already exist elsewhere in the code (terminal copy and paste, the newline keys,
`n`, `o`) are in the table as external entries: the listener does not run them, but they reserve
their chords and appear in the help. Per-user overrides are not implemented; the table is the
single place they would apply.

Known limits. `Ctrl+Shift+K` opens the web console in Firefox; whether a page can take that chord
from Firefox was not tested, and if it cannot, `Ctrl+K` outside a terminal or the filter field
itself remain. The automated tests dispatch key events to the page, so they cannot show that a
browser's own shortcut (Chrome's `Ctrl+K` address-bar search, Firefox's search bar) is overridden:
that was not checked in a headed browser, and macOS was not tested.

## Starting and finding sessions

"+ New" (or `n`) opens the "New session" dialog: a folder, then what to launch (shell, claude,
Codex, Codex (no approvals), Pi, OpenCode, Gemini CLI, Antigravity, Copilot CLI, Mistral Vibe or any other command), and an optional name made of letters,
digits, `-` and `_`. The "Codex" preset starts Codex with its own approvals and sandbox. The
"Codex (no approvals)" preset starts it with `--yolo`, without approvals or sandbox
([SECURITY.md](../SECURITY.md#the-codex-preset)). Both are Codex for the mesh: resume, restore,
adoption and `mesh-board` treat them alike, and resuming a session keeps the option it was started
with. Fresh and resumed Codex sessions use ordinary rich rendering with
`--no-alt-screen`; saved commands from older Mesh versions no longer force raw output.
Claude, Codex, Pi, OpenCode, Gemini CLI, Copilot CLI and Mistral Vibe started by a preset receive the
mesh's MCP server, `mesh-board`, without losing their other MCP servers (Antigravity has it through its plugin, see below); it provides the
whiteboard, demos and agent messages described below. Its `control` group can read the session's
execution state and request a model or reasoning effort for a Codex or Claude Code conversation
restart that you approve in the page. Its `agent_guide_read` tool, whose
description tells the agent that it runs in session-mesh, returns the
[agent guide](agent-guide.md): what the agent can show you and how, in one read. The server's
instructions ask the agent to call it once, unconditionally: that read costs about 3,500 tokens of
the agent's context in every session, a cost accepted so that an agent knows these features before
it needs them rather than never discovering them.

An agent that receives `mesh-board` also receives the project tracker, `mesh-work` (the `work-mcp`
program, 19 `work_*` tools over the tracker the Projects view reads), when the installation holds
it; an older installation launches agents without it. The server's instructions say how to use it,
and the agent guide's "Track your work" section says which system to use for what: the tracker
for the agent's own work, the Projects view's projects for the owner's configuration, Roster's
commands for a Roster pipeline. The tracker adds its tool declarations (about 4,000 tokens) and its
server instructions (about 1,000) to an agent's context. See [work-mcp.md](work-mcp.md#registration).
At the start of a Claude or Vibe session, a read-only hook adds one sentence with the ids of the session's
tasks and the counts of its questions, never their text; a Codex session gets the ids of its folder's tasks, once
you have trusted the hook in Codex ([The project context hook](agent-hooks.md#the-project-context-hook);
`MESH_PROJECT_HOOKS=0` turns it off). Which hooks each agent receives is in [agent-hooks.md](agent-hooks.md).

The "Folder" field of the "New session" dialog starts with the folder of the session you are
looking at (the home folder when there is none). It is a combobox: its list of suggestions opens
when you click or tap the field, when you reach it with Tab, when you type, or when you press the
down arrow. It stays closed when the dialog opens.

- **Known folders:** the allowed work folders when they are configured ([Restricting folders and
  agents](operations.md#restricting-folders-and-agents), read from `GET /api/config`), then the
  recent folders, the folders of your open sessions, then the folders of `GET /api/dirs`. Both
  requests are sent each time the dialog opens; if one fails, the list goes on without what it
  would have given. Until you
  type, the list holds them all; once you type, it holds those that match the text, best first:
  the path starts with it, then the folder name does, then the path contains it, then the path
  holds its letters in order (`dvap` finds `~/dev/alpha`). Case is ignored and `~` stands for
  your home folder.
- **`GET /api/dirs`:** your home folder (unless work folders exclude it) and the allowed work folders, then the sub-folders of each
  allowed work folder (of `~/dev` when no work folder is configured), the 80 most recently modified
  of each folder first, at most 200 in all. The server keeps only folders a session may start in:
  inside an allowed work folder once symbolic links are resolved, inside your home folder, and not
  protected (`~/.ssh`, the mesh's own configuration, the other places the file tree refuses). It
  leaves out names that start with a dot, files, broken links, and links that lead outside these
  places. It reads at most 2000 entries of each folder, and no further folder once 200 are listed.
  The answer is a plain list of paths.
- **Recent folders:** the 8 folders in which the last sessions were started from the dialog, newest
  first, once each. They belong to the runner, not to the browser: every device signed in to it
  sees the same list (`runner_settings` of `GET /api/config`). The server records the folder itself
  (resolved) when your signed-in browser starts a session with `POST /api/new`, if `GET /api/dirs`
  could list it (a start in `/etc` or `~/.ssh`, where the server allows it, is not recorded, and such an
  entry is not offered if the file holds one); a start with the master token from a script is not
  recorded. The configuration editor cannot change them. When
  `settings.json` cannot be read whole (not valid JSON, not an object, over 16 KiB, unreadable,
  written by another version), the server leaves it exactly as it is: the session starts all the
  same, the folder is not recorded, and the server log says so. A browser that kept recent folders
  before this version sends them once (`POST /api/dirs/recent`, after the runner's own; only folders
  `GET /api/dirs` could list are kept) and then removes its copy; it keeps the copy for a later try
  when that request fails (including a 503 for a settings file that cannot be read). Signing out
  removes that copy too, and so does the
  sign-in page, which a device revoked by "Log out everywhere" lands on the next time it opens the
  interface; a revoked device cannot read the runner's list.
- **While you type a path:** once the text is an absolute path or starts with `~/`, the page lists the
  folder you have typed up to its last `/` with the same listing as the file tree (`POST /api/ls`,
  no dedicated route) and suggests first its sub-folders whose name starts with the text after that `/`,
  case-insensitively. The folder part of a suggestion is written as you typed it, the folder
  name keeps its casing on disk (`~/al` gives `~/Alpha`). Type a `/` after a suggestion to go one level
  down. The request is sent 150 ms after the last key, a request for an older text is cancelled and its
  answer dropped, the listing of a folder is reused for 5 seconds (a refused or failed listing is not
  reused), at most 50 folders are suggested, and folders whose name starts with a dot only when you type the dot.
- **Keys:** the up and down arrows move in the list, Enter puts the chosen folder in the field (the
  dialog stays open), Escape closes the list (a second Escape closes the dialog). With no folder
  chosen, Enter opens the session, as without the list. On a phone, tap a folder.
- **Tab completes, as in a shell:** while the list is shown, Tab puts the chosen folder in the field,
  or, when none is chosen, the first suggestion that starts with what you typed (`~` expanded, same
  case), closes the list and keeps the focus in the field; a screen reader announces the completed
  folder. A suggestion that only matches part of a name or its letters in order is never put in the
  field by Tab, nor is a suggestion still shown for an earlier text while the listing of the new one
  is on its way: `~/dev/api` then Tab keeps `~/dev/api` even when `~/dev/alpha-pi` is suggested.
  Tab moves the focus on, as without the list, when the list is closed, when no suggestion starts
  with the text, when the field already holds that suggestion (so a second Tab moves on), and when
  nothing has been typed yet: the folder the dialog opened with is not replaced by a key pressed to
  leave the field, unless you chose a folder with the arrows. Shift+Tab always moves back. Type `/`
  after a completion to go one level down.
- **Allowed work folders:** when they are configured, the list leaves out a known folder outside
  them, and a listed sub-folder unless it is inside one of them or on the way to one (`~/` still
  offers `~/work` when `~/work` is allowed). For the folders of `POST /api/ls` and of the open
  sessions this is a comparison of the paths as written: a link inside an allowed folder that leads
  outside it can still be suggested. `GET /api/dirs` resolves links itself.
- **What is never listed:** what the file tree refuses: a folder outside your home folder and
  `/tmp`, a protected one (`~/.ssh`, the mesh's own configuration), or one that does not exist or
  cannot be read; these give no suggestion. The listing returns at most 2000 entries, files
  included, so in a folder with more entries some sub-folders may be missing from the suggestions.
- **Limits:** the suggestions do not check that a folder is usable for the agent you choose. The
  folder is checked when you start the session, as before: it must exist, and when work folders are
  configured it must be inside one of them, otherwise the server refuses it ("Folder outside the
  allowed workspace roots"), even if it was suggested. A recent folder that was moved or deleted
  stays in the list until newer ones push it out.

The "Live" tab of the sidebar lists the mesh's own sessions under "Mesh — interactive", with each
conversation's title, last prompt and state. Sessions that need you are also repeated at the top in
three groups: "Waiting for you" (a question or a permission), "Finished, unread" (until you open the
session on this device) and "Active". Below come the other terminals of the machine, grouped by
origin (SSH, tmux, terminal emulators). "Filter…" narrows the list.

The page does not wait for the list. While the server prepares it, for example after a restart, the
terminals of the saved layout attach at once. The sidebar shows the sessions this browser knew at its
last visit, marked "loading". A line above the list says where things stand: the list is loading,
the server is unreachable and when the next attempt is (with "Retry now"), the server restarted, or
the terminal host is not answering. That line is empty when the list is complete. Each tab asks for
the list one request at a time, and after a slow answer it waits at least as long as that answer took, so open tabs
do not pile requests onto a slow server. Long lists render only the rows near the visible part. See
[sessions-loading.md](sessions-loading.md).

Those other terminals can be seen but not read from the browser: their own emulator owns the
terminal. Clicking one shows what runs in it and, for a recognized agent whose conversation the mesh knows, offers to move it
into the mesh: "Restart now" stops the agent and resumes the conversation in a mesh session.
"Restart once it is idle" waits for its task to finish first; it is offered only for Claude Code,
Codex and OpenCode, whose idle state the mesh can observe. A Copilot started outside the mesh has no
hooks to report its conversation, so no restart is offered for it
([agents.md](agents.md#agents-running-outside-the-mesh)).

From any shell, `mesh-attach` opens a mesh session in the current terminal and `mesh-attach NAME`
joins an existing one; see the [command-line tools](configuration.md#command-line-tools).

## The Projects view and the project tracker

**Projects**, the main mode beside **Sessions**, opens on the Projects view by default. It shows the
project tracker that agents write through `mesh-work`, read only:

- **Pending questions.** Above the overview of the products, one folded line "Pending questions n" counts the
  questions agents asked with `work_ask` that are still open; the browser tab remembers whether it
  is unfolded. Unfolded, it lists them classified by zone (the category of the product), product,
  project and task, each group with its count, the oldest question first. A project is shown once,
  under its own product, even when one of its tasks was moved to another product. A row shows the
  whole text (a long one folded behind "Show more"), "Decision" when its answer form offers choices
  (options to pick, or Yes / No) and "Open question" when it asks for free text, its age, the session and agent that asked it, where it stands (product,
  project, task), the options, the assumption (folded), and one way in: "Open in task" opens the task
  sheet over its project's Questions tab, at that question, beside the task's notes, blockers and
  events; a question about a project opens that project's Questions tab; a task in no project opens
  its sheet alone. The list has no answer form: the operator answers where the context is. Questions
  attached to no task or project, or to one the tracker does not know, are grouped under "Without
  context" by the session that asked them, with a note that they should be attached; each opens its
  own sheet with its whole text and its answer form.
  Back (the view's button, the browser's, or Escape) returns to the list. The list reads every open
  question, the oldest first, 20 at a time: a note counts the more recent ones not shown yet, and
  "Show more questions" adds the next 20 (the counts of the groups cover the questions shown; the
  line's count is every open question). When an answer is recorded but the sheet that shows it cannot
  be read again, the sheet says "Answer recorded" in place of the form, with "Try again", and what is
  announced says the sheet could not be read again. The **Projects**
  button (and its entry in the phone's menu) carries the number of open questions, as read the last time the view or the session
  marker read it: when the view opens, on "Refresh", after an answer, and with the marker below. An
  unknown number shows nothing.
- **Questions on the sessions.** In the Sessions view, a session with open questions shows "? n" on
  its row in the list, and a "? n" button in its header (named with the count). n counts, once each,
  the open questions the session asked, those about a task it is linked to, and those about the
  project of such a task. The button opens the Projects view where the questions are: the task's
  sheet with its answer form when they are all about one task of a project, the project's Questions
  tab when they are all in one project, else the first screen (also for a task in no project,
  whose sheet opens from the first screen's list). The page reads them (`session-questions` of [work-read](work-read.md)) after a
  session listing, at most once a minute while it is visible, and again when the Projects view is
  left (the Sessions button alone does not read); when the tracker cannot be read, nothing is shown.
  The count on the Projects button is written by this read and by the Projects view. A question
  answered in the Projects view leaves the markers and that count at once, and they are read again
  then (not a minute later), as they are when the view reads another count of open questions (for
  example after "Refresh") or fails to read it. Sessions are matched by name: a session restored
  under another name loses its questions, and a later session that takes an earlier one's name gets
  them.
- **References in the terminals.** A task, project or question id printed in a terminal (`T-1a2b`,
  `P-5e6f`, `N-0000abcd`, as a whole word: not inside a path, a URL or a file name) is a link when
  the tracker has that id; any other text of that shape, such as "T-12", stays text. Hovering shows
  its title; clicking it, with the same rules as the other links of the terminal (a program that
  captures the mouse still lets the click through, `Shift`, or `Option` on macOS, selects text
  instead), opens the Projects view on it: a task on its project's Board with its sheet, a project
  on its "Pick up" tab, a question where it is answered (the sheet of its task, the Questions tab
  of its project, or the first screen, whose list opens the sheet of a question about a task in no
  project or about nothing). The page knows the ids from one read (`ids` of [work-read](work-read.md)) after a
  session listing while terminals are shown, at most once a minute while it is visible, and again
  when the Projects view opens; checking a word sends no request. It keeps the ids and titles in
  memory only, and forgets them when the credential is refused. When the tracker cannot be read,
  nothing is a link; a read that is only busy or too slow keeps the ids already known. On a very
  large tracker the read is cut, and an id it leaves out becomes a link once a later read lists it.
  Session names are not links: they are ordinary words as often as names.
- **Products and projects.** While the Projects view is shown, the sidebar (where the Sessions view
  lists its sessions; on a phone, the drawer the "Projects" button of the top bar opens) holds a
  tree: "Overview", then the zones in the order of the taxonomy, their products (a child product
  under its parent) and each product's projects, with the open tasks of each and, once the open
  questions were read, their count as the pending questions classify them ("? n"), as many as the
  first screen lists ("Show more" included). Both counts of a product cover its child products.
  Projects whose
  product the tracker does not list stand in a last group. Choosing "Overview" shows the first
  screen, a product shows its view, a project opens it;
  choosing a zone, or the arrow beside a product, folds or unfolds it (on a phone the arrow is a
  touch target of its own, as large as a row). The item of the place shown
  is selected and its group unfolded, whether it was reached from the tree or from the main area.
  The tree is an ARIA tree: `Tab` reaches its current item, the up and down arrows, `Home` and
  `End` move, the right arrow unfolds (or goes to the first item inside), the left arrow folds (or
  goes to the group), `Enter` or `Space` chooses, and the focus stays in the tree. On a phone the
  drawer closes on a choice. The first screen keeps the pending questions and, below them, an
  overview: each zone with its products and their progress, each a way to the product's view.
- **A product, in three tabs.** "Overview" (its projects with their progress, done tasks over all
  tasks, and number of blockers, its tasks in no project, its child products), "Board" and
  "Timeline" (in French "Aperçu", "Tableau" and "Frise"). Board and Timeline show every task of
  the product and of its child products, the scope of the product's count in the tree, read when
  one of them is first shown: the Board in the columns of a project's Board, each card with its
  project ("No project" for a task in none), the Timeline with the bars, colours and legend of a
  project's Timeline, one group per project (its tasks in no project last), each group folded or
  unfolded by its heading. Without a filter, the open columns add up to the product's count in the
  tree. Above both tabs, the same filters: a search in the id and title, and lists of checkboxes
  for project, status, priority, owner and tag (a filter whose value no task has is left out),
  "Clear the filters", and the number of tasks shown. A column or a group shows 50 tasks, then
  "Show more". The reader lists at most 1000 tasks of a product: beyond, a notice says the view is
  partial, without a filter the column counters still count every task, and the filters and the Timeline see the
  tasks read. A card or a row opens the task sheet, as in a project. The filters of each product
  (the last 20 products filtered) are kept with the place.
- **A project, in five tabs.** "Pick up" (in progress, blocked or waiting, due soon, no recent
  activity, open questions, milestones, risks), "Board" (columns to do, in progress, blocked or
  waiting, done, and "Other" for any other status, shown only when it holds tasks), "Timeline"
  (a bar from creation to done or today, with due dates and estimates; each bar takes the colour and
  pattern of its task's status, to do hatched, in progress and done solid, waiting dashed, blocked
  with an end cap, dropped hollow, a legend line lists them, and each bar is named with its status
  for screen readers), "Dependencies" (the tasks
  by dependency level, cycles labelled) and "Questions" (the project's questions, open and
  answered, grouped by task, then "Without a task" for those about the project itself, each with
  the answer form; at most 20, open ones first). The French interface names them "Reprise",
  "Tableau", "Frise", "Dépendances" and "Questions". An answer given in the Questions tab, in the
  task sheet or in a sheet opened from the first screen shows in the other places once they are
  read again; an
  answered question is never shown in the colour of the open ones.
- **Recorded task sessions.** A task sheet lists the sessions recorded on that task, with the agent,
  branch, repository name and last recorded activity when supplied. These are historical links:
  current activity is unknown, and a name may refer to several sessions. Names stay plain text and
  do not open a live session.
- **The way back.** The view has three levels: the first screen, a product or a project on one of
  its tabs, and a task sheet over that tab (from a product's Board or Timeline too). A choice in the tree is a step like the same choice in
  the main area. The sheet's first button ("Back to the Board tab", named after the
  tab) returns to the tab, scrolled where it was on a phone, with the focus on the task that
  opened the sheet; "Back to products" in the product's view and in the project header returns to
  the first screen, with the focus on the overview's row of the product that holds the place left
  (a child product's parent; for a project of no listed product, its group in the tree when the
  tree is shown). `Esc`, in the main area or in the tree,
  and the browser's Back (a phone's back gesture) go up one level the same way; on the first
  screen `Esc` leaves Projects, and the browser's Back does what it did before. A sheet opened from
  a session's "? n" button or from the first screen's questions returns to its project's Questions
  tab. The sheet of a task in no project and the sheet of a question about nothing, opened from the
  first screen's list, are one level above it: going back returns to the list, with the focus on
  the question's "Open" button. `Esc` in a text field that holds text does nothing, so a draft
  answer is not lost.
- **Coming back.** Leaving Projects (the Sessions button, a session, `Esc`, a link) and coming
  back, or reloading the tab, shows the view as it was left, read again: the product or the
  project, its tab, the filters of the products, the open task sheet (with its level of the way back), or the sheet opened from
  the first screen, where they were scrolled, the items of the tree unfolded or folded (on the
  first visit the zones are unfolded and the products folded; those of products and projects that
  no longer exist are forgotten), the pending questions unfolded or
  not, and every answer not yet sent,
  under each question typed in, in any sheet or tab. A project or a task that no longer exists, or
  a question answered since, shows the first screen; a session's "? n" button still opens its own
  place. The
  drafts stay in the browser tab only (its `sessionStorage`, at most 40 of them and 64 KiB): they
  are never sent until the answer is, and they are removed when it is recorded, when the field is
  emptied, and when the browser signs out or shows the sign-in page.
- **A task.** Selecting a task opens its sheet: blockers, dependencies, the sessions that worked on
  it, its notes, its events and its questions. An answer given with the sheet's answer button
  reads "answered by the owner in this view (signed in)". Any other answer reads as the owner's
  answer relayed by the session that recorded it, not verified, with when it was recorded; a `by`
  other than `owner` (free text) appears only as the stated answerer. Under an open question, and
  under one answered only by relayed answers, the sheet has an answer form; your answer then
  replaces the relayed one, which stays visible, struck through. The answer is the only thing
  the view writes (next paragraph but one). The sheet also lists the task's links (`links`).
- **Links and documents.** In question, answer, note, blocker and event text, and in a task's
  links, a web address (`https://` or `http://`) becomes a link that opens in a new tab, and the
  path of a document (`~/…` or `/…`, ending in `.html`, `.htm`, `.md`, `.markdown`, `.svg`,
  `.pdf`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.txt`, `.diff` or `.patch`) becomes a button
  with the file's name. The button opens the document in a panel beside the view (over it on a
  phone); Escape or "Close the document" closes it and gives the focus back to the button, and
  "Open in a new tab" shows it alone. The panel shows the files the [document
  panel](#documents-beside-the-terminals) shows, with the same limits; any other path shows "not
  available". An HTML or SVG page is shown as a picture: its styles and inline diagrams, never its
  scripts. Markdown, diffs and text use the document panel's viewers. Only plain ASCII text is
  recognised: a path with a space, an accent or a relative path, and an address with another
  scheme (`javascript:`, `data:`, `file:`) or a user name, stay text.
- **The old view.** The "Old view" button in the Projects header shows the previous Projects
  workspace (next section) and "New view" comes back; the choice is remembered by the browser.

**Where the data lives.** The tracker is a local git repository: `WL_HOME` when it is set (a
leading `~/` is expanded), else `~/worklog-data`, else an older `~/worklog`; when both
`~/worklog-data` and `~/worklog` are repositories, nothing is read and `WL_HOME` must choose. The
view reads it through `POST /api/work/v1`, which runs the `work-read` program with only the web
server's `HOME` and `WL_HOME` in its environment; the browser never reads a file
([work-read.md](work-read.md)). An agent's `work-mcp` uses the `HOME` and `WL_HOME` of the agent's
own environment. If you set `WL_HOME`, set the same absolute path for the web server and for the
sessions, otherwise the view and the agents use different repositories (a `~/` path expands against
each process's own `HOME`). The web server takes it from its service environment
([configuration.md](configuration.md#environment-variables)). Sessions do not inherit it from the
web server or the PTY host: a session's shell receives only a fixed list of variables (`HOME`,
`PATH`, the locale and a few others) and starts as a login shell, so set `WL_HOME` in the
startup file your login shell reads (for example `~/.profile`, `~/.bash_profile` or `~/.zprofile`).
A change of `WL_HOME` for the view takes effect after the web server restarts. Two cases keep the
view empty: a non-empty directory that is not a tracker (it holds no
`taxonomy.yaml`) cannot be initialised by an agent, and if the web server has `WL_HOME` but the
sessions do not, agents create `~/worklog-data`, which the view never reads. Nothing is pushed
anywhere; the data format is in [worklog-format.md](worklog-format.md).

**First use.** On a new installation there is no repository, and the view shows "No tracker found"
with "Try again" and "Use the old view". The repository is created by the first `work_*` tool call
of an agent started by the mesh, when the place it looks first (`WL_HOME`, else `~/worklog-data`)
is an empty directory or does not exist and its parent does. It starts with one product,
`general`. To see a first project, ask an agent in a mesh session to create it, for example with
`work_add_product` then `work_add_project`, and to add tasks with `work_add_task`; "Try again"
then shows it.

**How agents write.** Every agent started by the mesh that receives `mesh-board` also receives
`mesh-work`, the `work-mcp` program with 19 tools ([work-mcp.md](work-mcp.md#tools)): reading
(`work_resume`, `work_list_products`, `work_list_projects`, `work_list_tasks`, `work_get`), writing
(`work_add_product`, `work_add_project`, `work_add_task`, `work_update`, `work_log`, `work_block`,
`work_unblock`), sessions (`work_find_sessions`, `work_get_session`) and questions (`work_ask`,
`work_answer`, `work_list_questions`, `work_open_view`) and attempts (`work_attempt`: the end of a
pass of work on a task, with its outcome and, for a failure, its reason). The "Track your work" section of the
[agent guide](agent-guide.md) gives the agent its rule in short: `work_resume` at the start,
`work_log` as it goes and before it stops, `work_ask` for a question that does not block it.

**Answering an agent's question.** `work_ask` does not wait: the agent records the question with
the assumption it adopts and carries on. You answer in an agent session with `mesh-work` (the
asking session or another), in the conversation, and the agent records your words with
`work_answer`, which needs a session identity (`answered_by` defaults to
`owner`). The question then shows as answered in `work_resume`, `work_list_questions`, `work_get`
and the task sheet. A question has one answer: a different second answer is refused, the same one
repeated is accepted without writing again. The agent is told to relay only what you said; nothing
checks that the words are yours, and the answer records which session wrote it
([work-mcp.md](work-mcp.md#answering-a-question)). Such an answer is therefore shown as relayed,
not verified.

You can also answer in the view, under the question, wherever it is shown with its context: the task
sheet, the project's Questions tab, or the sheet of a question attached to nothing. Type the
answer and press "Send answer". The browser sends it to `POST /api/work/v1`, and the web server
runs the `work-write` program for it only when the request carries your signed-in browser's cookie and no token: an
agent's session token and the master token are refused, and so is a request from another site.
The sheet then reads the task again and shows your answer as "answered by the owner in this
view". An answer an agent relayed earlier, mistaken or forged, does not lock you out: yours
replaces it. When the agent gave options, they appear above the field: click one (radio buttons;
it fills the field, which you can still change) or tick every option that applies (checkboxes,
for a question the agent marked `multi`), or Yes / No for a yes-or-no question, then press "Send
answer"; the field stays for any other answer. A question you answered shows "Edit answer": your
correction is recorded as a new answer, and the earlier one stays in the history, folded under
"Earlier answers", while the current one is marked "edited". What you ticked or typed and did not
send yet, a correction included, comes back when you return to the view, like any other unsent
answer. "Verified" means written through your signed-in browser; it is a marker in the tracker's
log, not a signature, so a process of your user that writes the log directly can still
imitate it ([trust model](work-mcp.md#trust-model)). A release ships `work-write`; on an
installation without it the form is replaced by a note that answering from the view needs
`work-write`.

`work_open_view` does not open anything yet: it checks its target and answers that the view is not
available.

**What a release needs.** Release bundles, nightly ones included, ship `work-read` and
`work-mcp`. Without `work-read`, Projects shows the old view once per page load with the notice
"The tracker reader is not installed here, so the old view is shown."; without `work-mcp`, agents
start without `mesh-work`.

## Projects and recorded Roster state

This section describes the previous Projects workspace, which the "Old view" button shows.

**Projects** is a main mode beside **Sessions**, with its own project sidebar and **+ New**
action. Create a project by name, then add repository and source settings when needed.
The native runner stores these settings and checks concurrent edits. Explicitly enabled
Git/Roster observations refresh the selected project's context asynchronously; startup
configuration for the trusted collector is described in [Projects](projects.md).
The existing generated local JSON catalog remains available separately.
Roster is optional; other source
kinds are metadata links rather than connected accounts. Public Roster roadmap observation is
supported at the qualified revision. Pipeline observation retains an experimental profile;
the different public pipeline format currently remains explicitly unavailable. See [Projects](projects.md)
for configuration and the explicit provider executable options.

Pipeline detail separates recorded phase history from current review and QA reports, including
missing, conflicting and partial observations. It does not start work, approve a gate or prove that
an agent is currently running. Observations are snapshots, with source provenance and freshness
shown separately from transport verification. Refresh is explicit.

**Back to Sessions** returns to the mounted workspace without closing terminals. Session
associations are inert references until their runtime identity can be verified. External account
connectors, harness installation and advanced workflow actions remain future work.

## Changing a live session's account

For a qualified, idle Claude Code, Codex or Pi session on Linux, the account badge in its terminal
header opens an account picker. It offers enabled, non-managed profiles of the **same backend**.
Choose a destination and confirm: Mesh copies the conversation transcript to that account's
folder and sends it to its provider, then resumes the agent in the same terminal. Opening or
cancelling the picker changes nothing. The badges in the sidebar and pinned rows remain labels
because those rows are themselves navigation buttons. Historical, unbound, busy and unsupported
sessions cannot use this control. Pi needs two named native profiles and the Mesh extension's
activity reports; the default account is not eligible for Pi switches.

The confirmation is required for every switch from this picker. Saved account confirmation
preferences do not currently bypass it; an agent's own switch request still requires separate
human approval. A transcript copy does not promise preservation of unsent drafts, pending
approvals or in-flight work. If a request fails or its outcome is uncertain, inspect the session
and request status before trying again. Acceptance of a request is not completion: the picker
shows the durable result (including failure or unknown outcome), and retains the receipt when
closed and reopened in the same browser tab. A missing response remains uncertain and cannot
be submitted again from that session's picker. If the agent starts working after confirmation
but before its bound stop, a fresh observable idle check refuses the operator's switch without
stopping it; this is not an atomic checkpoint against every possible new input. A default-account
source requires a recorded context revision; an unbound default session cannot use the picker.

## Organising the sidebar

- **Folders.** "+ Folder" creates a folder. Drag a session onto a folder to file it, onto another
  session to reorder, and drag folders to reorder them. A folder shows how many sessions it holds
  and folds away. Deleting a folder moves its sessions back into the list.
- **Names.** Double-click a session name, or use "Rename" in the session menu, to rename a session;
  rename a folder with the ✎ button ("Rename folder") on its row. An empty name restores the
  default. From inside a session, `mesh-rename NAME` and
  `mesh-rename --folder FOLDER` do the same.
- **Shared by every device.** Names, folders and order are kept by the server, so every device sees
  the same list; only which groups are folded is kept per browser. They survive a restart of the
  web server and a restart of the session's agent (an account switch or an approved restart), and
  come back with a session restored after a PTY host restart.
- **Pins.** "Pin on this device", in the session menu or on a history card, keeps a conversation of any
  supported agent (Claude, Codex, Pi, OpenCode, Gemini, Antigravity, Copilot, Vibe) in a "Pinned · this
  device" group, even after its session has ended. Pins are kept in this browser only, up to 100. The
  session menu offers the pin when Mesh knows the conversation id: the one the agent's hooks or process
  report or, for Gemini, Antigravity and Copilot when those name none yet, the one conversation the History
  index holds for the session's folder written since the agent started (never a choice among several). A
  session without an id is not pinnable. On an agent without hooks the pin is therefore derived, not
  reported: it is the folder's newest conversation started after the agent, which may be another
  session's. Such a pin is saved as "guessed", listed with "Guessed from the folder", and its History card
  says so; the guess never resumes anything by itself, and Mesh does not use it to restart the session
  or to restore it (a restart or restore of that session starts the agent afresh, as for an agent that
  reported no id). The folder's one new conversation can also belong to an agent started outside Mesh in the same
  folder; that is accepted, because a guessed id is only displayed and pinned, never acted on by itself. It still counts as a possibly running agent, so as not to start a second one on the
  conversation: a History delete or resume of it is refused (409) while a session holds it, as is a restore
  of a conversation with that id; a session whose id the agent reported is preferred to a guessing one. While the conversation runs in the mesh the pin opens its
  terminal; once closed it opens the conversation's History card, which shows what it is before it is
  resumed (and says "not found" if the agent's store no longer holds it). Resume from the card follows the
  rules of the History section above. Pins made by earlier versions for Copilot and OpenCode keep working:
  they open a card too.
- **Session menu.** Right-click a session (long press on a phone) for "Rename", "Move to ›",
  "Open in a new column", "Redraw the terminal", "Reset mouse/focus modes" and "Close the
  session…", which kills its processes after a confirmation.

## Observed directories

Between the mesh sessions and the other terminals, the "Live" tab groups the mesh sessions by
working directory. Its labels say what the mesh observed and what it did not look at:

- **"Observed directories"** lists each working directory of a live mesh session, with its number
  of sessions. A session whose directory could not be read is counted apart, never filed under a
  guessed project.
- **"worktrees: unavailable"** means the optional Git observer, `gitwright-worktree-observe` in the
  checkout's `_opam/bin`, is not installed, so no Git worktree was read. With it, the line reads
  "worktrees: N observed" and "Contextual diff" buttons appear.
- **"Facts and provenance"** unfolds the raw facts behind the list: where each fact comes from
  (the PTY host and `/proc`, or the Git observer), when it was read and, per worktree, its path,
  HEAD, branch and flags.
- **"history: not collected"** says that past conversations are not joined to these directories:
  the list reflects live sessions only. The "History" tab holds past conversations.

## Working in a terminal

The terminal is xterm.js connected to the session's raw output; the last 2 MiB are replayed when a
browser reconnects, and several browsers can show the same session at once. After a reconnection
the replay replaces what the terminal showed, so the history appears once; a full-screen program on
the alternate screen is redrawn in place instead. When the host supplies a size hint, the
browser reads the replay at that size and rewraps it to the pane's width. After a resize with no
new terminal output, the host omits the hint and the browser uses the pane's own size.

- **Several browsers on one session: who sets the size.** A session has one terminal size, and a
  program such as Claude Code redraws its footer for that width only; a browser narrower than it
  used to keep copies of the footer in its scrollback. So one browser owns the size, and the
  others show the terminal at that size, clipped (the last rows stay visible). By default the
  device in use takes the size by itself, with no banner: a click, a tap or a key in its terminal
  (or in the phone input line and key bar) sends a take-over. So does its terminal getting the
  focus, or its page shown again, but only while its window has the focus and only right after a
  person's action on that page (the browser's `navigator.userActivation.isActive`): a focus
  that a script gives the terminal takes nothing. A timer, a window resize or a page
  that only stays open and visible sends none, so two open devices do not fight; a browser sends
  at most one take-over every two seconds per pane. A program that does not redraw when its
  window size changes (it ignores SIGWINCH) can leave copies of its footer in a device's
  scrollback after automatic switches (measured: 39 copies after 4 switches, with a footer
  redrawn in place every 250 ms by such a program); a program that redraws on resize leaves
  exactly one, and the manual mode never resizes. The per-browser preference "Terminal size
  with several devices" (Configuration, Terminal section; client store key `sizeTakeover`,
  `"manual"` or `"auto"`, the default) switches a browser to the manual mode: the banner
  "Terminal sized by another device" and its button "Take the size back", the only way it then
  takes the size. The rule, applied by the PTY host:
  - the first browser that opens the session while no other one owns the size sets it and owns
    it; a browser that opens it later does not change it;
  - the owner's own changes (window resized, phone keyboard, font size) apply; a size sent by a
    browser that does not own it (a fit, a focus, the page coming back) changes nothing;
  - a take-over (automatic, or "Take the size back") always applies and makes that browser the
    owner: the last take-over wins. `mesh-attach` and other clients that predate this rule take
    the size when they attach or resize, as before;
  - when the owner closes the session (or its page), nobody owns the size, and the next browser
    that sends its size takes it.

  A browser alone on a session owns its size: nothing changes for it. The symbols that Claude
  Code and other programs draw (such as "⏵", which no Android font has) come from a bundled
  font, Noto Sans Symbols 2, loaded only when the terminal shows one of them.
- **Long messages.** "Write" in the pane header opens "Write in the terminal", a multi-line field
  sent in one block like a paste. "Insert" pastes without pressing Enter; "Send ⏎" pastes and
  submits.
- **Files and images.** Paste a file, drop it on the terminal, or use the 📎 menu: the file is
  uploaded to `~/.cache/session-mesh/uploads/<date>/` on the machine and its path is pasted into
  the session, which is how Claude Code and Codex receive images. The 📎 menu offers "📷 Camera",
  "🖼 Gallery" and "📄 File" on a phone, "📄 File" and "📷 Webcam photo" on a computer, and
  "🎙 Microphone recording" (5 minutes at most) wherever the browser allows it. Nothing is sent
  before you confirm, and the camera and microphone stop when the capture ends.
- **Font size.** "A−" and "A+" in the top bar.
- **Copy on select.** Selecting text in a terminal copies it to the clipboard when you release the
  mouse button, or lift your finger after a long-press selection on a phone; the text stays
  selected. It is on by default and is a per-browser preference, kept in the page's client store
  (browser local storage) under the key `copyOnSelect` (`false` turns it off, anything else keeps
  it on); the Configuration dialog has no control for it yet. Nothing is copied for an empty selection,
  from a hidden pane or page, or while a program tracks the mouse, unless you force the selection
  with `Shift`+drag (`Option`+drag on macOS). Browsers only let a page write the clipboard from a
  user gesture in a secure context (HTTPS or localhost); when the browser refuses, the page says
  so once and keeps working. `Ctrl+C`, `Ctrl+Shift+C`, right-click and the phone "Copy" button
  still copy as before, and clear the selection afterwards.
- **Copy as shell command for every copy.** A per-browser preference, off by default, kept in the
  client store under the key `copyAsShell` (only `true` turns it on; the Configuration dialog has
  no control for it yet). When it is on, `Ctrl+C`, `Ctrl+Shift+C`, right-click, the phone "Copy"
  button and copy on select write what `Ctrl+Shift+X` writes (see the shortcut table): soft-wrapped
  rows joined, and a trailing `\` added only before an indented option row. The selection itself
  is not changed. Whenever the rows cannot be rebuilt from the terminal (a column selection, a
  phone selection the terminal no longer holds), the text is copied as it is.
- **Garbled display.** "Redraw the terminal" (pane "More" menu or session menu) briefly changes the
  terminal size so the program redraws itself; from a browser that does not own the size (see
  above), it does so at the owner's size, which stays the owner's. With a PTY host older than the
  size rule, the session has the size of the browser that sent it last, and output drawn for
  another width can look garbled here. A terminal you come back to (click in it, or return to
  the page) then does the same redraw by itself only if output arrived while it was not in use
  (another element focused or the page hidden) and another browser or `mesh-attach` was
  attached. A terminal that stayed focused on a visible page while another device drove the
  session does not: use "Redraw the terminal". Leaving the page and coming back repairs it only
  if the program writes something while the page is hidden. "Reset mouse/focus modes" resets the browser
  terminal's mouse and focus handling when a program left it in the wrong state. For Codex, Pi and
  OpenCode, "Enable Codex scrollback", "Restore Pi full-screen scrolling" and "Restore OpenCode
  full-screen scrolling" appear when they apply. OpenCode draws on the alternate screen and asks
  for mouse reports, so the wheel and a swipe on a phone scroll its own conversation view, and no
  scrollback is kept in the page; a long replay can lose those mouse modes, and "Restore OpenCode
  full-screen scrolling" asks for them again (it never enters the alternate screen).
  Copilot CLI behaves the same way: for it, as for Pi and OpenCode, "Restore Copilot full-screen
  scrolling" appears in the actions when a replay cut at 2 MiB has lost the mouse modes.
  Codex scrollback explicitly enables `/raw on`; you can also enter `/raw on` yourself.
- **Stopping.** "Close pane" only hides the pane; the session keeps running. "Stop the session…"
  in the "More" menu kills it after a confirmation.

## Voice dictation

Hold the microphone in a local terminal's header to record; release it to transcribe. The operator
must first [enable the Whisper relay](operations.md#whisper-dictation), and the browser must allow
microphone access in a secure context (HTTPS, or a browser-trusted local origin). The initial
supported targets are foreground Claude Code, Codex and Pi sessions at their normal input prompt.
A disabled microphone has an explanatory title and status message.

- **Desktop:** the transcript is inserted into the original terminal prompt without Enter. Edit it
  there and submit manually. Recognition can finish on a retained original connection after you
  switch panes; it never reconnects by name to send a late result.
- **Phone:** the transcript fills the existing editable input line. Correct it and press Send or
  Enter yourself; dictation never activates Direct mode. The field must be empty, Direct and Ctrl
  modes must be off, and no native input may be pending. Editing the field or changing the active
  session during recognition prevents a late result from replacing the current input. Once staged,
  the draft stays bound to its original pane and session incarnation, including after corrections.
  Switching panes or replacing that session refuses Send without deleting the text; return to the
  original destination or explicitly clear the field before starting a different message.

Transcription-job cleanup is automatic; it does not submit or clear the terminal's pending input.
Clearing a phone draft permits another recording without a separate Discard action. Speech that is
already in a native prompt is not moved back into the phone field.

An upload whose acknowledgement is lost is recovered by its original request id, never by uploading
the audio again. A first "not found" response does not prove that the upload was never admitted.
After its 30-second recovery window, explicit Discard (or a fresh header-microphone recovery hold)
can release the local recording after its delivery channel is revoked; a late result cannot be
inserted. This is local abandonment, not proof that the remote job never existed, and the service
can still report that the original session is busy.

## Columns and panes

"⊞ Column" adds a column, up to three; clicking a session opens it in the active column. Drag the
separator to resize columns. A column can hold several tabs ("Add a tab to this column") and can be
moved left or right. The layout, tabs included, is remembered by the browser. While no column has
more than one tab, the open sessions are also written in the page URL after `#`, so a bookmark
reopens them.

The pane header shows the agent's state and the connection. "Info" shows the pane's identity and,
for a mesh session, its name. The envelope button opens the session's mailbox (see
[Messages and requests from agents](#messages-and-requests-from-agents)).
"More" holds the actions that apply to the pane: "Attach", "Write in the terminal…" (the long,
multi-line message dialog; on a phone the ✎ key and the input line stay), "Browse files", "Redraw the terminal",
"Open this session's demo", "Move to a folder" and "Stop the session…" for a terminal; "Reload",
"Open in an external tab" and "Watch the file" for a document.

## Documents beside the terminals

A column can show a document instead of a terminal: HTML, Markdown (tables, highlighted code,
Mermaid diagrams, relative images), PDF, images or a source file. A column never shows a web
page: a link printed in a terminal opens in a browser tab, and `mesh-open` refuses `http://` and
`https://` targets. There are three ways to open a document:

- click a path printed in a terminal;
- "🌐 Page" (or `o`), which also suggests recent documents found under `~/notes` and `~/dev`;
- `mesh-open FILE` from any shell. Run from a mesh session, it opens the document next to the pane
  showing that session, which lets an agent show you the report it has just written. An HTML,
  SVG or Markdown document opened this way is served alone, without the stylesheets and images
  next to it.

Source files (for example `src/app.py`, `lib/a.ml:42`, `x.ts:10-20`) open read-only in the Monaco
code viewer, with syntax highlighting, search (`Ctrl+F`), folding, and a jump to the highlighted
line or range. Files over 4 MiB are served as plain text.

Unified diffs (`.diff` and `.patch` files, as written by `git diff`, `git show`,
`git format-patch` or `diff -u`) open in a diff viewer: one block per file, folded with a click,
with its status (renamed, copied, new, deleted, binary), its mode when the diff gives one (such as
`mode 100644 → 100755` for a file made executable, even without a change in the content) and its
count of added and removed lines; line
numbers on both sides; the changed words of each modified line highlighted; and "unified" and
"split" buttons to switch between one column and two columns side by side. A commit message
before the first file is shown above it. A large diff is built in parts: "show more" adds the
next lines of a file, and the files past the first screens start folded; switching from "split" to
"unified" keeps a fully loaded file fully shown. "source" shows the plain
text; a line target such as `changes.diff:42` opens the code viewer at that line of the patch
(up to 4 MiB, without a NUL byte). Diffs over 4 MiB, or holding a NUL byte, are served as plain text; a diff of more
than 50,000 lines or 2,000 files is not rendered: the page says so and links to its plain text. The agent guide
asks agents to show a diff this way when you ask for one.

**Following a document as it changes.** "Watch the file" in the "More" menu of a document reloads
it whenever the file changes on disk, keeping the reading position for Markdown and source files.
The last choice becomes the default for documents opened afterwards in this browser.
`mesh-open --watch FILE` turns it on from a shell.

Documents are served in a sandbox: an HTML page written by an agent cannot read your login, drive
the terminals, make network requests or load remote images and scripts. Its script can still send
out what it can read, including its own link, by navigating its own frame or through WebRTC, so
open only documents you trust ([SECURITY.md](../SECURITY.md#documents-that-send-data-out)). Which
files can be served, and how long a document link lasts, are described in
[docs/operations.md](operations.md#documents-opened-with-mesh-open).

The few labels of the Markdown, code and diff viewers ("source", "↩ wrap", "N lines", "split")
and of demo scenes stay in English whatever the interface language: these pages run in the
sandbox, which has no access to the interface's language catalogs.

## Browsing files

Clicking a directory path in a terminal (any path ending in `/`, such as `./src/`) opens a file
tree in the sidebar; "Browse files" in a terminal's "More" menu opens it on the session's folder.
Click a folder to unfold it, double-click to make it the root; "↑" goes to the parent folder and
".*" shows hidden files. Clicking a file opens it beside the terminals (rendered for HTML and
Markdown, in the code viewer for source files); right-clicking an HTML, Markdown or SVG file opens
its source. The tree follows the same limits as documents: only under your home directory and
`/tmp`, never the protected folders.

## Conversation history

The "History" tab lists past conversations of every supported agent (Claude Code, Codex, Pi, OpenCode,
Gemini CLI, Antigravity, GitHub Copilot CLI and Mistral Vibe), grouped by folder. Each agent's own
store is read, never written, with one exception: "Delete" (below) removes a transcript file of Claude,
Codex, Pi or Gemini, which includes a Gemini chat in your own `~/.gemini`. Nothing of an agent's credentials
is opened.

| Agent | Read from | Title | Folder | Search |
|---|---|---|---|---|
| Claude Code, Codex, Pi | their JSONL transcripts | their own titles, else the first prompt | the transcript | transcripts |
| OpenCode (1.x, 2.x) | `$XDG_DATA_HOME/opencode/opencode.db` (or `OPENCODE_DB`), opened read-only; only the session, message and part tables | session title (a "New session - …" placeholder is dropped) | the session's directory | inside the database |
| Gemini CLI | `<GEMINI_CLI_HOME or ~>/.gemini/tmp/*/chats/session-*.jsonl`, and Mesh's private overlay home | the chat's summary, else the first prompt | the project's `.project_root` marker | transcripts |
| Antigravity (`agy`) | `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl` | the first prompt | only the latest conversation of a workspace (`cache/last_conversations.json`) | transcripts |
| Copilot CLI | `<COPILOT_HOME or ~/.copilot>/session-state/<id>/events.jsonl` | `workspace.yaml` (`name`, else `summary`) | the `session.start` event | transcripts |
| Mistral Vibe | `<VIBE_HOME or ~/.vibe>/logs/session/unified/<id>/`: `meta.json`, and the newest generation's checkpoint chunks | `meta.json` title | `meta.json` | the chunk files |

Limits, said plainly:

- **Resume** starts the agent with its own resume command (`claude --resume`, `codex resume`, `pi --session`,
  `opencode --session`, `gemini --resume`, `agy --conversation`, `copilot --resume=`, `vibe --resume`), in the
  conversation's folder, with a conversation id checked against a strict pattern and passed as one argument.
  Two cases are not offered, and the card shows the command to run yourself: a Gemini conversation of your own
  `~/.gemini` (Mesh-started Gemini runs in a private home, so it would not find it), and an Antigravity conversation
  that is not the latest of its workspace (agy does not record its folder).
- **Delete** exists for Claude, Codex, Pi and Gemini (one transcript file each). It is not offered for OpenCode (a
  database row), Antigravity, Copilot and Vibe (a directory holding other files): remove those with the agent itself.
- **Gemini** chats written as a single `.json` by older versions are not listed (0.68 writes `.jsonl`), and a
  rewound conversation (`/rewind`) may count a few messages too many.
- **OpenCode** reads `opencode.db` only; a channel-specific database (`opencode-<channel>.db`) is not read. The 2.x
  tables (`session_v2`, `session_message`) are read from their documented shape in `discover.py`, not checked against
  a 2.x release: their tokens and models are not shown.
- **Antigravity**: the transcript format (`USER_INPUT` / `PLANNER_RESPONSE` steps) comes from the client's own
  bundled documentation; sources disagree on whether the data directory is `~/.gemini/antigravity-cli` or
  `~/.gemini/antigravity`, so both are read. Conversation names given in Mesh are bound only to Claude, Codex and Pi
  conversations.

- **Search.** The filter matches mesh names, titles, folders and branches; from three characters it
  also searches the full text of the transcripts, two ways merged: the full-text database (`mesh-history`,
  when its binary is installed and synced) lists its ranked hits first, then a literal case-insensitive scan of
  the transcripts (ripgrep, else grep) adds what the database does not find: a substring, an exact phrase, a
  tool output the database does not hold. Without the database the literal scan answers alone. The database is
  never waited for: a busy one is skipped and the in-memory index and the scan answer. A database file the helper finds corrupt is set aside as `history.sqlite.corrupt-<stamp>` (mode 0600, it holds prompts) and a new one is built from the transcripts; only the newest such file is kept. A conversation
  carrying a lone UTF-16 surrogate in its text is still indexed (it is replaced by U+FFFD). Chips restrict the list by agent, show
  `codex exec` runs (hidden by default) or keep "active only".
- **Recently closed.** "Recently closed · Mesh" lists the last 20 mesh sessions that ended, under
  the name they had in the mesh, and says whether the conversation can be resumed.
- **Conversation card.** Clicking a conversation opens a card in a pane: recap, duration, messages,
  tokens, models, last exchanges and compaction summary. From there, "Resume here" or "Resume in a
  column" resumes it in the mesh, "Open the terminal" goes to it if it is still running, "Copy"
  copies the command that resumes it, and "Delete" erases its transcript from disk.
- **Explorer.** "▤ Explorer" shows the history as a table in place of the panes (`Esc` to go back),
  sortable by date, size, messages or tokens, with multiple selection and "Delete…". A running
  conversation cannot be deleted, nor one whose transcript changed less than 2 minutes ago.

The first indexing of a large history can take a few minutes; the list fills in meanwhile.

"Management" next to "▤ Explorer" opens "Mesh management", a compact read-only list of the active
Mesh sessions, heaviest first (resident memory, then CPU), with the observed duration. Where a
figure was measured is a tooltip, not a line. External sessions are only counted: no identity is
collected for them. A second list shows the sessions recently stopped or lost; those are
observations, not exit times, kept 14 days (200 entries at most). There are no filters and no
control.

"Configuration" next to it opens a read-only dialog with what this mesh is using: the effective
paths (configuration, runtime, terminal host socket, cache and uploads, installation and commands
folders, launch settings file, `mesh-open`, `mesh-board-mcp`), the page version and the installation
folder's name, the terminal host (native or Python, announced capabilities), the agents found in the server's `PATH`, the port and listening address,
whether the request looks like Tailscale (inferred from the `.ts.net` address, not checked), the
number of subscribed notification devices and the interface language. Each path has a "Copy"
button. No agent or host binary is run, so versions read "not detected".
The host's state "accepting connections" means a process accepts connections on its socket, not
that every session is healthy; a host that accepts but answers with something that is not valid is
reported as such, never as an error of the page. Its capabilities are the union of those the
running sessions announce, so they read "none announced" while no session runs. The host
implementation is detected from the process on Linux only; elsewhere it reads "unknown". It never shows a token,
a key, a cookie, a file's content or the path of a secret file.

**Editing launch settings.** The dialog opens read-only. Two settings can be changed: the enabled
agents (check boxes) and the allowed work folders for "New session" (a list with add and remove).
Press "Edit" and type the master token: editing is unlocked for 10 minutes, with a countdown and a
"Lock" button. This is a confirmation against an edit made by mistake, not a protection against
someone who holds your login cookie: that cookie already opens a shell, which can read the token.
If "Lock" cannot reach the server, the dialog says so and stays unlocked until the countdown ends.
"Default value" under each field restores the factory value (every agent; your home
folder). "Save" checks the whole edit: only known agents, at least one; absolute folders that exist,
under your home folder after symbolic links are resolved, not a credential store (`~/.ssh`...) nor
Mesh's own configuration folder, no duplicates, 16 folders at most. If
another tab or device saved since the dialog loaded, nothing is written and the dialog shows the
current values with a message. The change applies to the next session you start, with no restart;
running sessions are not touched, but restarting one whose folder is no longer allowed is refused.
There must be a settings file (`MESH_LAUNCH_SETTINGS`); without one the dialog says how to create it.

**Operator name.** The "Appearance" section has an "Operator name" field. When it is set, the
Projects view names you in the labels that say whose answer a question waits for or who answered
it ("Waiting for an answer from Camille" instead of "Waiting for an answer from the owner"; in
French, "En attente de la réponse de Camille" instead of "… de l'opérateur"). It is a runner
setting: the server keeps it in `settings.json` of the configuration folder (`MESH_CONF_DIR`), so
every device signed in to this runner shows the same name; the page reads it through the
configuration API each time Projects opens, and at once after a save. Saving asks for the master
token when editing is not unlocked yet, as the launch settings do; it works without a launch
settings file. Editing unlocked this way serves that one save and is locked again right after it;
editing you had already unlocked from the launch settings stays unlocked. The name is normalised
to NFC and trimmed, then holds at most 40 characters (counted as Unicode code points), no control,
invisible, filler or bidirectional character, and at most three combining marks in a row; an
empty name, or one that cannot be read, gives the wording without a name. The page shows it as
text only, isolated from the direction of the sentence around it, and never sends it anywhere
else: it is not written to the project tracker. In French, "de" becomes "d'" before a vowel, an
"h" (taken as mute, as in most first names: "d'Hélène") and a "y" followed by a consonant
("d'Yves", but "de Yann").

The port, listen address, trusted proxy and notification settings live in the server's environment
and stay read-only, as do the system folders. Each read-only value says where it is stored and
how to change it: the port, listen address, trusted proxy, configuration, cache and runtime
folders and the settings file path are `MESH_*` variables of the web server's systemd unit
(`systemctl --user edit session-mesh`, then restart the web server; sessions keep running), which
the page never writes. The page has no restart button for the web server and never restarts the
terminal host.

## Whiteboard and demos

**Whiteboard.** "Whiteboard" in a terminal's header opens an Excalidraw board attached to that
session. You and the session's agent share it: the agent reads and replaces it through the
`mesh-board` MCP server, and the header says "Whiteboard changed" when it did. Each save keeps a
revision the agent can compare or restore. If the agent changes the board while you are drawing,
your drawing stays local until you choose "Keep my drawing" or "Reload the remote version". Images
and embedded files are not supported yet.

**Demos.** An agent can build a demo: a small declarative scene (no HTML, CSS or script) shown in a
pane, opened with "Open this session's demo". A session can hold several named demos, chosen from
the "Demo" selector. Every update is a new revision; "History" lists them, and restoring an old one
adds it as a new revision without erasing the current one. The three scene formats an agent can
write are described in [demo-scene-v0.md](demo-scene-v0.md) (a static layout),
[demo-scene-v1.md](demo-scene-v1.md) (states and choices) and
[demo-scene-v2.md](demo-scene-v2.md) (v1 plus a gear drawing).

## Messages and requests from agents

The Deck groups its MCP calls under `whiteboard`, `demo`, `mail` and `session`. Each group
lists its actions and schemas when called with no arguments or with `{"action":"describe"}`. See the
[Deck MCP migration guide](deck-mcp-migration.md) for the calling format and client permission rules.

Agents started by the mesh can message each other through the `mesh-board` MCP server: an agent
lists its peers, deposits a message or a task in a peer's inbox, and replies to messages it has
received. Mesh asks you to approve a message or reply as soon as it is sent, unless you already
allowed that exact sender-to-recipient direction. A message awaiting approval cannot wake the
recipient or expose its text to them. The recipient can read approved messages without asking you
again. Approval to read does not make the message an instruction from you.

The wake notice tells the recipient you approved reading mail, never what the messages say.
The inbox shows which messages are approved and whether each grant is for one read or for
future messages from that exact sender. For Claude
Code, the mesh types `# Mesh: new message(s) waiting; …` into the terminal, followed by `Enter`,
only when Claude is idle at its prompt: it has reported the end of its last turn, nothing
has been typed into the terminal since, and you have no unsent input in it. While a turn runs, or
after you have typed something, the notice waits for the end of the next turn; at most one notice
is typed per idle period. OpenCode, Gemini CLI and Mistral Vibe are treated the same way: the Mesh plugin of
OpenCode and the hooks of Gemini and Vibe report the end of each turn, so the notice is typed only while
they are idle at their prompt. Antigravity and Copilot CLI get no typed notice, because the mesh has no reliable signal that
they are idle (an `Enter` typed during an approval prompt would answer it): their messages wait in the
inbox until they check `mail.inbox`. Codex is never typed into either, but it can be woken without
a keystroke, once the owner has turned that on (`MESH_CODEX_QUEUE_WAKE=1`, off by default until it has been
tried on a real session; see `docs/operations.md`): when the mesh knows the exact conversation a Codex session is in (the rollout file the
process holds open, never a guess and never a name), it runs `codex queue --thread <conversation id>
--message <fixed line>` once per notification, with the `codex` that sessions find on their PATH and a
minimal environment. The line has no message text and no digit. If `codex queue` fails, times out,
prints too much or the server restarts meanwhile, the mesh does not try again: the session shows the
same mark as an unconfirmed Claude wake until its inbox is read, and the message stays in the inbox.
A Codex whose conversation is not exact gets nothing. Whether the line reaches a Codex already open in
a terminal has not been verified on a real session. For Antigravity this is a precaution: nobody has yet observed whether
its `Stop` hook is silent while a permission prompt is open. Pi is notified by its extension.
[SECURITY.md](../SECURITY.md#what-session-mesh-defends-against) gives the reasons and the limits
of this check.

With Claude Code 2.1.325 or later, a session the mesh launched after the web server was updated
(a new session, a conversation resumed from the history, a resume, a restore or an approved
restart) can be woken without typing anything. The mesh starts Claude with its own messaging
socket (`--messaging-socket-path`, in a private directory next to the PTY host's socket, or in a
short one under `/tmp` where a socket path would not fit, as on macOS) and wakes it by writing one
line on that socket:
`Mesh: N new message(s) in your inbox; the user approved reading mail. Please check mail.inbox and read authorized entries without asking again.`
Claude shows it as a message from another Claude session and starts a turn, or reads it after the
running turn. The line carries only the number of waiting messages. One line is sent per batch of
messages, once the running turn has ended.

The mesh does not change how Claude treats messages from other sessions: it never writes
`crossSessionInbound`, and leaves Claude's default or your own choice in force. It therefore
gives a session a socket only when Claude will deliver that line without asking:

- the effective `crossSessionInbound` is `accept`, read in Claude's order (the administrator's
  policy files, the `--settings` of the command, your Claude user settings in `$CLAUDE_CONFIG_DIR`
  or `~/.claude`; the project's settings can only tighten: `.claude/settings.json` of the
  session's folder, and `.claude/settings.local.json` of the git repository's root, which is the
  main checkout for a linked worktree, plus the older copy in the session's folder), or
- there is no value and the session does not bypass permissions (`--dangerously-skip-permissions`,
  `--permission-mode bypassPermissions`, or a bypass default in the settings).

A `refuse`, a `hold`, a value Claude does not know, a bypass session without an explicit
`accept`, an older Claude, a settings file the mesh cannot read with certainty, and a session
started before the update all keep the typed notice described above. Claude creates a messaging
socket for every session anyway and registers it for its other sessions; the option only chooses
its path, so it adds no exposure. With no `crossSessionInbound` value, Claude holds a message for
your approval when its sender's permission class differs from the session's, and holds a sender
that states no class (the mesh) only in a bypass session.

A line on the socket counts as a wake only once the agent looks at its inbox afterwards (the
`mail.inbox` tool). Claude may hold the line in an approval dialog of its terminal, which the
mesh cannot see, and a typed notice with its `Enter` could answer that dialog. So after a line has
been written the mesh **never types anything** in that terminal for that wake. If the inbox has not
been read 20 seconds after the line, the wake is shown as unconfirmed: a mark (an envelope with a
question mark) on the session in the list and a line in the "Mailbox" entry of its "Info". It is
not counted as delivered, and reading the inbox, whenever it happens, clears it. If Claude itself
asks you to allow the wake notice, answer in that terminal; that is separate from mail approval
in Mesh. The state survives a restart of the server, which writes no second line. If the
remembered state is lost or damaged, or its directory stops being private after a line was
recorded, the mesh cannot know whether a line was written, so every session alive at that moment
is put in doubt **until that session restarts**: no line and no
typed notice, with or without a socket, and its wakes stay shown as unconfirmed even after the
agent reads its inbox (no read is known to close a dialog that holds a line). That is the price:
such a session is not woken by any means until you restart it. Outside the doubt, the typed notice
remains for sessions that have no socket (and for a line that could not be written), with the
guards above: the session must be idle and its PTY host must announce the wake capabilities. A
session gets no socket when the board bridge is not installed, when its command lacks the
bridge's `--mcp-config` entry (the `mail.inbox` tool that confirms a wake), or when its command
carries `--project-config-root`, which moves where Claude reads the project's settings. One line
is sent per batch; messages that arrive meanwhile form the next batch and get their own line, once
the earlier wake is confirmed. The sockets of sessions that no longer exist are removed.

The mesh checks the `claude` first on the PATH it gives the PTY host, but your shell's startup
files run before the command is typed: an alias, another `claude` first on the PATH, or an
exported `CLAUDE_CONFIG_DIR` can change what really runs and are not seen. An older `claude` that
does not know `--messaging-socket-path` would refuse to start with an "unknown option" error.

The page's "Message from another agent" dialog names the sender. "Later" leaves the message held;
"Refuse" deletes it; "Read this time" grants one read; and "Always for this exact session" grants
standing permission from that exact sending session to that exact receiving session, not in the
reverse direction. Once a one-read grant is used or standing permission is revoked, another read
needs a new Mesh grant. Every open window of the mesh asks; the first answer counts, and
the question closes in the other windows at their next refresh of the session list (the page says
"Message request decided elsewhere; the prompt was closed."). The next pending request, if any,
is then asked, and its prompt says "The previous message request was decided elsewhere; its prompt
was closed." in its own status line. An answer given in another window before that refresh, or
overtaken by it, changes nothing, and that window says so.

The envelope button in a terminal pane's header opens that session's mailbox: the messages it
received and sent that are still kept (sender or recipient, type, time and text), the approval
requests that concern it with the same choices ("Refuse", "Read this time", "Always for this exact
session"), and its permanent permissions, each with a "Revoke" button. A badge on the button counts
the pending approval requests for that session. The panel loads when you open it and again when
those requests change, never on a timer. Messages from another agent are marked as such and shown
as plain text: nothing in them is run and links are not clickable. Characters that have no visible
glyph of their own appear as `<U+XXXX>` (the hexadecimal code point, four digits or more) instead
of passing unseen: the C0 and C1 control characters except newline and tab, the line and paragraph
separators (U+2028, U+2029), every Unicode format character (category Cf, which includes the
text-direction controls and isolates, zero-width space, joiners and non-joiner, word joiner,
soft hyphen, the Arabic letter mark U+061C and the byte-order mark U+FEFF), the whole tag block
(U+E0000 to U+E007F) and every variation selector (U+180B to U+180D, U+180F, U+FE00 to U+FE0F,
U+E0100 to U+E01EF). A legitimate emoji sequence that uses a joiner or a variation selector is
therefore shown with those marks too. Other look-alike or blank characters (for example the Hangul
fillers) are not marked. Reading a message here gives the agent no permission to read it. Only the
newest 64 messages per direction are listed. The envelope button appears only on a session the app
launched as an agent (Claude, Codex or Pi); a plain shell has no mailbox and no button, and "Write
in the terminal…" stays in its "More" menu. If a request was already decided, or a permission
already revoked, from another window, the panel says so and refreshes its list.

An agent can also ask to create a new agent session in its folder, or to restart its own
conversation (for example with another model). Nothing happens until you confirm the request in
the page, which names the preset as "New session" does. An agent cannot ask for a "Codex (no
approvals)" session: that request is refused.

Not verified: whether the `mesh-board` MCP server can reach the mesh from inside Codex's default
sandbox (the "Codex" preset). It was not tested with an authenticated Codex; if the sandbox blocks
its local connection, messages, whiteboard and requests are unavailable to that Codex session.

## Pi sessions

"New session" offers Pi with the mesh's MCP server; Pi 1.3.0 or later is required, and the mesh's
configuration is added for that session only, without modifying your own Pi MCP configuration.
Resuming a Pi conversation is refused when the mesh cannot identify it unambiguously. A Pi process
receives the MCP server and the wake-up extension below only when the mesh starts or resumes it.

New Pi sessions load a small extension that brings message notices to the agent, even while it is
working. The notice carries no message content: it tells the agent the user approved reading
mail and to read authorized entries from `mail.inbox` without asking again. Delivery guarantees:

- **At least once, not exactly once.** As long as the same mesh session stays alive, an unconfirmed
  notice is sent again, at most every 10 seconds and only while Pi is idle with no queued input,
  under the same identifier. A repeated notice with the same identifier refers to the same
  messages, so a rare duplicate is recognisable.
- **Confirmation means "recorded by Pi".** The mesh counts a notice as delivered once it appears in
  Pi's session file. That does not guarantee it was flushed to disk (`fsync`) or survives a power
  cut.
- **Not covered:** closing or replacing the mesh session, which drops pending notices, and another
  Pi extension that blocks Pi indefinitely, which can prevent delivery.

## OpenCode sessions

**OpenCode 1.x and 2.x are supported (version tested: 2.3.0); any other major is launched bare.** The mesh
resolves `opencode` (in `~/.local/bin`, then `~/.opencode/bin`, where its installer puts it, then the `PATH` of the web server, which under a systemd unit can be shorter than your shell's: an OpenCode that only your shell finds is launched bare, with a notice), reads `opencode --version` (short timeout, no Mesh variable in that process) and names
that same executable in the launch line. For a major other than 1 and 2, or a version it cannot read
(or no `opencode` found), it injects nothing: no configuration, no board bridge, no plugin, and
`MESH_SESSION_TOKEN` is removed from the agent's environment (`env -u MESH_SESSION_TOKEN opencode`). The agent
starts as an ordinary program of the terminal, tagged `opencode` but without a mailbox, wake notice or state,
and the session list says either that this version is not supported (1.x and 2.x are) or that OpenCode was not
found or its version could not be read. A conversation is never resumed for it: a launch with `--session`, `-s`,
`--continue` or `--fork` is refused, and after a PTY host restart the session comes back as an ordinary shell.

**OpenCode 2.** The mesh starts it as `opencode --standalone` (a private server instead of the shared background
service, which is not bound to `HOME`), with an inline configuration in the 2.x shape (`mcp.servers`, `plugins`)
and a state plugin (`opencode-mesh-plugin-v2/`). Differences from 1.x:

- **The board is called through `execute`.** The model reaches MCP tools by writing code for OpenCode 2's single
  `execute` tool (`tools["mesh-board"]["mail"]({action: "inbox"})`); the inbox, consent, read and reply work the same.
- **Your choices stay.** If you disabled `mesh-board` (`disabled: true`, or 1.x's `enabled: false`, in your global
  or the project's configuration), the server is not injected; your `permissions` rules apply.
- **State.** The plugin reports working, waiting for a permission, waiting for a question and the end of a turn.
  Sub-agents have their own sessions: the state is computed from all of them, so a finished sub-agent never makes
  the terminal look idle, and a wake notice is only typed when nothing runs and nothing waits.
- **Resume and restore.** `opencode --standalone --session <id>`, after checking that the conversation is in
  OpenCode's store (2.x would create an empty one); a conversation that is gone is refused, also when it is
  adopted from another terminal (checked before that agent is stopped) and on a restore, which keeps its entry.
  Use a single session selector for the conversation you want to reopen.
  Options 2.x does not have (`--model`, `--mini`, `--replay-limit`, `--no-replay`) are dropped; `--pure`, `--agent`,
  `--server` and unknown options refuse the launch.
- **Terminal.** Same alternate screen, mouse and bracketed paste; 2.x also sets focus reports, synchronized
  output, grapheme clusters and colour-scheme reports. A replay cut at 2 MiB loses the modes, and "Restore
  OpenCode full-screen scrolling" restores the wheel, as for 1.x (it does not restore bracketed paste).
- **Not supported.** Never install OpenCode 2 with its `curl … | bash` shortcut: it replaces the 1.x binary.

The rest of this section describes the common behaviour, written for 1.x.

"New session" offers OpenCode. The mesh adds, for that session only, an inline configuration
(`OPENCODE_CONFIG_CONTENT`) with the `mesh-board` MCP server and a small plugin. Your own
`opencode.json`, project configuration and `auth.json` are neither read nor changed, and the
session token is not written into the configuration: the MCP server inherits it from the terminal.
What you configure for `mesh-board` stays in force where it only restricts: `enabled: false` and
your `permission` rules (for example `"mesh-board_*": "ask"`) still apply, because OpenCode merges
the mesh's block over yours key by key. `--pure` (no external plugins) also disables the plugin: the
board tools still work, but the state is then guessed from OpenCode's own store and no notice is typed.

- **The launch line is visible.** OpenCode reads its configuration from the environment, which the
  terminal host does not forward, so the mesh types `env OPENCODE_CONFIG_CONTENT='{…}' opencode`
  into the session's shell (`env` keeps it valid in csh and tcsh). The line is therefore on the
  screen, in the replay and in the shell's history: the block holds only paths and the mesh port,
  never a secret, and nothing that is a secret may ever be added to it
  ([SECURITY.md](../SECURITY.md#the-opencode-preset)). In csh and tcsh a `!` in the block would be
  expanded by the shell's history; the block holds none today.
- **State.** The plugin reports working, waiting for a question or a permission, and finished
  turns; the sidebar uses them. Each report carries a sequence number, and the mesh ignores one
  older than the last it applied, so a `working` arriving late cannot replace the `done` that
  followed it. Only the conversation you are in speaks for the terminal, except that a permission
  asked by a sub-agent shows the session as waiting for a permission (the sub-agent is not named).
  A question asked by a sub-agent is not reported.
- **An OpenCode started elsewhere.** Without the plugin (an OpenCode started in another terminal and
  adopted), the mesh reads OpenCode's SQLite store, `opencode.db` in OpenCode's data directory, to
  find the conversation and its state. This is kept on purpose: that store is the only place the
  conversation of such a process can be read. The file also holds provider credentials, so it is
  opened read-only (it is never written and never created), and only the `session`, `message` and
  `part` tables (1.x), `session_v2` and `session_message` (2.x) are queried. A turn is open while the
  conversation was set busy after it was last set idle (2.x), or while the newest message is the
  user's or an assistant message not completed (1.x), **however long the store has been quiet**: a long
  tool call writes nothing for many minutes, and "Restart when idle" would stop it. Only a mark
  written before the process started is ignored (another process left it). The mesh reports a busy
  turn as busy for as long as the process lives; a process that hangs mid-turn is not restarted
  by "when idle" either: use "Restart now" for it.
- **Resume and restore.** A conversation is resumed with `opencode --session <id>` (2.x: `--standalone` too), after a PTY host
  restart and from "Restart now". Kept: the model, the agent, `--auto`, `--pure`, `--mini` and the
  display options. Dropped: `--continue`, `--session`, `--fork`, the prompt and the server options
  (`--port`, `--hostname`, `--mdns`, `--cors`). `--auto false` is kept as written, so a session
  started with the flag turned off does not resume with it on. A resume is refused when an option
  it cannot read could be `--pure` or `--agent`, and `opencode run` is never resumed. The
  conversation is the one the plugin reported, which wins over the others (unless the report predates the
  OpenCode process, as when you quit it and type `opencode --session C` yourself): for instance, after a
  restore with `--session A`, opening conversation B in OpenCode makes B the one that is resumed.
  Without a report it is the one the process names with `--session`, or the single root
  conversation in its folder since it started.
- **History.** The "History" tab lists OpenCode conversations, read from its SQLite store (read-only;
  see "Conversation history"). Resume and pins work; delete is not offered.
- **Messages.** OpenCode sessions can message each other like Claude and Codex ones. OpenCode
  gives the model only the text of a tool result, so the mailbox and session-request actions of
  `mesh-board` repeat their JSON after the summary.
- **Not covered.** Remote provisioning of held presets (Claude and Codex only) does not include
  OpenCode.

## Gemini CLI sessions

"New session" offers Gemini CLI (0.68 and later hooks). Gemini has no per-session configuration
option, and its system settings file must belong to root, so the mesh starts it with
`GEMINI_CLI_HOME` set to a private directory under the mesh configuration directory
(`gemini-home/.gemini`). That directory holds your `settings.json` with the `mesh-board` MCP server
and five state hooks added, and links to your other `~/.gemini` entries (credentials, `GEMINI.md`,
extensions, `commands`, `policies`...). The mesh only reads your `~/.gemini`, but Gemini writes
through those links, into your own directory: an "Allow always" saved in `policies/auto-saved.toml`
(it then applies to every Gemini you run), an installed extension, a command, `GEMINI.md` changed
with `/memory`, refreshed credentials. Restrictions you set (`mcp.excluded`, `hooksConfig.enabled`,
tool exclusions...) are copied and stay in force. The session token is a `$MESH_SESSION_TOKEN`
reference in that file, never a value. The conversations (`tmp`), the checkpoint store and the
project and state files stay private to the overlay; a conversation started in a mesh session is
therefore resumed in a mesh session, not from a plain `gemini` run.

- **Settings.** The overlay's `settings.json` is rewritten at every launch from your own: a setting
  changed inside a Mesh-started Gemini (with `/settings`, for instance) is lost at the next launch;
  change it in `~/.gemini/settings.json`. Your own `mesh-board` entry under `mcpServers`, if you have
  one, is replaced by the mesh's. A settings file that cannot be read faithfully refuses the launch
  with a message instead of starting Gemini without your settings: not strict JSON (comments, `NaN`),
  not an object, larger than 1 MiB, a dangling link, or not a regular file (a FIFO...). A link to a
  regular file is read.
- **Trusted folders.** Gemini disables MCP servers, yours included, in a folder it does not trust.
  The `mesh-board` tools appear only in folders you have trusted in Gemini. The trust file is not
  linked: `GEMINI_CLI_TRUSTED_FOLDERS_PATH` names your real `~/.gemini/trustedFolders.json`, so a
  decision made in any Gemini is shared at once. A revocation is not: Gemini keeps the trust it read at
  start-up in memory, so it applies only to the Gemini sessions started afterwards, not to those already
  running.
- **Not in the home directory.** Gemini reads a project's own settings from `<folder>/.gemini`.
  Started in the home directory, that is your real `~/.gemini`, which is not the overlay it uses as
  its user directory (`GEMINI_CLI_HOME`): it would be taken for a project, so settings would be
  loaded twice, hooks run twice and `~/.agents/skills` would not be found. The mesh therefore refuses to start Gemini with the home directory as working folder
  ("Choose a subfolder", HTTP 400); this also applies to a restore, a restart and an agent moved in
  from a terminal.
- **Hooks never block Gemini.** The hook command ends with `>/dev/null 2>&1 || true`: a moved
  binary, a missing `python3` or a sandbox leave the session without state but never make Gemini
  deny a prompt or a tool. A hook of yours on `AfterAgent` runs next to the mesh's, not after it:
  the mesh can report the turn as finished, and type a wake notice, while your hook is still running.
- **Token redaction.** With `security.environmentVariableRedaction.enabled`, Gemini removes
  `MESH_SESSION_TOKEN` from the environment of hooks: the state and the wake notice are then lost
  for that session (the safe side: nothing is reported without the token).
- **State.** The hooks report working (prompt, tools), waiting for a permission (`Notification`) and
  finished turns (`AfterAgent`), and the conversation id. A Gemini started elsewhere has no state
  and no conversation id, so it cannot be moved into the mesh.
- **Resume and restore.** `gemini --resume <id>`, with an allow-list of options. The sandbox, approval
  mode, policies and tool or MCP allow-lists are kept, and a resume that cannot read one of them is
  refused. The prompt, `--worktree` and the session pickers are dropped. Gemini keeps a conversation
  only after a model reply: a session that never had one cannot be resumed ("No previous sessions
  found") and is left at a shell prompt.
- **Terminal.** By default Gemini draws in the normal buffer: the wheel and swipes scroll the page's
  own scrollback, and a pasted `/mcp` is accepted (a first Enter selects the completion, a second runs
  it). With `ui.useAlternateBuffer` the screen would be the alternate one; the "Restore ... full-screen
  scrolling" recovery is offered for Pi and OpenCode only.
- **Mailbox and wake.** Like Claude and OpenCode: a notice is typed only after the hooks reported a
  finished turn. The mailbox results carry their JSON in the text, as for OpenCode.
- **History.** The "History" tab lists Gemini chats (`chats/session-*.jsonl`, in your own `~/.gemini` and in
  Mesh's private overlay home); only the overlay's are resumable from Mesh (see "Conversation history").
- **Remote provisioning.** Not available for Gemini.
- **Sign-in.** On 2026-11-15 Gemini 0.68.0 refused the Google sign-in of an individual account ("This
  client is no longer supported ... migrate to the Antigravity suite"); an API key or Vertex AI is
  needed.

## Antigravity sessions

"New session" offers Antigravity (`agy`, version 1.5.9 checked). It starts as the bare command, in the
interactive terminal interface. Unlike the other agents, `agy` accepts no per-session configuration: no
flag, no inline setting (`--settings` refuses a key it does not know) and no variable naming another
configuration directory. Its MCP servers and hooks come from files, so the mesh cannot add its own for one
session, and it does not edit your `~/.gemini` files. Instead it ships one plugin that you install once:

```sh
scripts/agy-setup.sh install     # validates the plugin, then runs `agy plugin install`
scripts/agy-setup.sh status      # `agy plugin list`
scripts/agy-setup.sh uninstall   # `agy plugin uninstall session-mesh`
# The preset is offered whether or not the plugin is installed (the mesh does not look in `~/.gemini`):
# `status` tells. Without the plugin, `agy` starts with no board tools and no state.
```

The plugin names the absolute paths of `mesh-board-mcp` and `mesh-event`: install again after moving the
checkout or the installed binaries. It holds no credential. The bridge and the hook read the session token
and the port from the terminal's environment. `install` fails, and installs nothing, when the bridge
(`mesh-board-mcp`) is not executable. The plugin is global to `agy`, so it also runs in an `agy` that Mesh
did not start. Outside a mesh terminal the hook does nothing, but the bridge exits with the error
`MESH_SESSION_TOKEN is required` (code 78): that `agy` starts a `mesh-board` MCP server that fails. Inside
a mesh terminal every `agy` is affected, a nested one included (`agy -p` run by another agent): it
inherits the terminal's token and reports under it. The server therefore keeps an event only when it
comes from the agent the session was launched as, and, for an `agy` session, only from the first
conversation it reported; the others are ignored and logged (`event: ignored ...`). `uninstall` leaves
what `agy plugin install` created itself, `~/.gemini/config/import_manifest.json` (`{"imports": null}`)
and an empty `plugins/` directory; Mesh does not delete them. Without the plugin, Antigravity still
starts, but without the board tools and the state.

- **State.** Two hooks report the start of a model invocation (busy) and the end of a turn with nothing left
  running (idle, and the conversation). Tool hooks are not used: their answer decides the permission, and the
  mesh never answers for you. Observed with a signed-in `agy`: it sends no `Stop` while a permission
  prompt is open, and none either after a refused or cancelled prompt, when it is back at its input line
  ("Interrupted · What should Antigravity CLI do instead?"). No hook marks either moment, so the last report
  stays "working". Mesh therefore shows a session as waiting for you (and sends the "waiting" notification)
  when it reported "working" and its terminal has printed nothing for 30 seconds (`MESH_AGY_QUIET_SECONDS`, 1 to 600; any other value is ignored with a log line and 30 is used);
  a model call or a command that stays that silent shows the same, wrongly, until its output resumes.
  The wake notice is never typed into Antigravity (it stays in the inbox): the open prompt sends no `Stop`,
  which would make typing it safe, but the interrupted state is only guessed from silence, so it stays off
  until `agy` reports an interruption itself. A fresh Antigravity that has had no turn reports nothing.
- **Resume and restore.** A conversation is resumed with `agy --conversation <id>`, after a PTY host restart
  and from "Restart now". Kept: the model, effort, project, `--add-dir`, `--sandbox`, `--mode`, `--agent`,
  `--settings` and `--dangerously-skip-permissions`. Dropped: `--continue`, `--conversation`, the prompt, the
  print mode and its output options, the log file and the remote connection. A resume is refused when an
  option it cannot read could be `--sandbox`, `--mode`, `--agent` or `--settings`. As in Go, `-sandbox`
  and `--sandbox`, `-mode=plan` and `--mode=plan` are the same option, and are kept either way. Your own `settings.json`
  (tool permission, sandbox, permission rules) is read by `agy` itself and stays in force.
- **Terminal.** By default `agy` runs on the normal screen, with no alternate screen and no mouse reports
  (observed: mode 1049 is on only during sign-in and the trust prompt; bracketed paste stays on), so its
  output goes to the page's scrollback and scrolls there. "Restore Antigravity full-screen scrolling" only
  concerns the setting `altScreenMode: always`.
- **History.** The "History" tab lists Antigravity conversations from their `transcript.jsonl`. The transcript
  does not name its folder: only the latest conversation of each workspace has one, so only that one is
  resumed from Mesh (see "Conversation history").
- **Messages.** Antigravity sessions can message each other. The tools are named
  `session-mesh_mesh-board` by the plugin; a permission rule for them is `mcp(session-mesh_mesh-board/*)`.
  Observed: `agy` loads MCP tools lazily (the model reads a schema under
  `~/.gemini/antigravity-cli/mcp/mesh-board/` first, then calls `<server>/<tool>`), every MCP call asks for a
  permission, and the MCP server and the hooks inherit the terminal's session token. A message must be
  replied to before it is acknowledged: the acknowledgement deletes it.
- **Trust.** The first `agy` in a new folder asks "Do you trust the contents of this project?", and a
  project's `.agents/mcp_config.json` is read only for a trusted project. Signing in needs a D-Bus session
  bus.
- **Checked.** With a signed-in `agy` (1.5.9): the state hooks, the conversation id, the token inherited
  by the bridge and the hooks, the permission prompt, and the interruption above.
- **Not covered.** Remote provisioning of held presets; the state and conversation of an `agy` started in
  another terminal (only `--conversation` in its command line is read: nothing under `~/.gemini` is).

## GitHub Copilot CLI sessions

"New session" offers Copilot CLI (`copilot`). For that session only, the mesh adds two options to
the command: `--additional-mcp-config` with the `mesh-board` MCP server (Copilot documents it as
augmenting your own MCP configuration for that run), and `--plugin-dir` with a small plugin kept in
the mesh's checkout (`copilot-mesh-plugin/`) whose hooks report the state. Nothing is written to
`~/.copilot`, your settings, hooks, MCP file and GitHub sign-in are neither read nor changed, and the
session token is written nowhere: the MCP server and the hooks inherit it from the terminal. The
only trace in your Copilot home is an empty directory, `plugin-data/_direct/<hash>`, that Copilot
itself creates for the plugin (one per plugin path, reused by every session, and not removed when
Copilot exits). What you configure stays in force where it only restricts: a server turned off in
`disabledMcpServers` (or `--disable-mcp-server mesh-board`) stays off, `--deny-tool`,
`--available-tools` and the other permission options are kept when a session is restored, and
`"disableAllHooks": true` silences the plugin (the board tools still work; the state is then not
reported and no notice is typed).

- **State.** The hooks report that you submitted a prompt, that a tool finished, that a permission
  prompt or a question is on screen (`notification`, the only event that says so: `permissionRequest`
  also fires for an auto-approved tool), and the end of a turn; the sidebar uses them. A fresh
  Copilot reports nothing until its first prompt (its `sessionStart` fires with it), so no notice is
  typed before then.
- **Resume and restore.** A conversation is resumed with `copilot --resume=<id>`, after a PTY host
  restart and from "Restart now"; the conversation is the one the hooks last reported (a `/new` or
  `/resume` inside Copilot changes it), or the one the process names with `--resume=<uuid>` or
  `--session-id`; the last conversation the hooks reported is the one a restore resumes. Kept: the model, `--allow-all`/`--yolo` and its parts, `--allow-tool`, `--deny-tool`,
  `--allow-url`, `--deny-url`, `--available-tools`, `--excluded-tools`, `--add-dir`, `--mode`, `--plan`,
  `--autopilot`, `--disable-mcp-server`, `--secret-env-vars`, `--max-ai-credits` and the display
  options, `--no-remote` and `--no-remote-export`. Dropped: `--continue`, `--resume`, `--session-id`,
  `--name`, `--remote`, `--remote-export`, the prompt options and `--output-format`. A resume is refused when an option it cannot read could be one that restricts
  (`--deny-tool`, `--available-tools`, `--disable-mcp-server`, `--disallow-temp-dir`...), and a
  `copilot -p` or `--acp` run is never resumed.
- **Terminal.** Copilot draws on the alternate screen with mouse reports and bracketed paste: the
  wheel and a swipe on a phone scroll its own timeline, and the phone input line pastes a `/` command
  in one block. "Restore Copilot full-screen scrolling" is offered like Pi's and OpenCode's.
- **History.** The "History" tab lists Copilot conversations from `session-state/<id>/events.jsonl` (title from
  `workspace.yaml`). Resume and pins work; delete is not offered (the directory also holds checkpoints and plans).
- **Messages.** Copilot sessions can message each other like Claude and Codex ones. The bridge
  repeats the JSON of its results after the summary, as for OpenCode.
- **Autopilot and wake.** No message notice is ever typed into a Copilot, whatever its arguments (its messages
  wait in the inbox until it calls `mail.inbox`): Copilot enters autopilot from its status bar without any
  change to its arguments, and what its end-of-turn hook means there has not been observed.
- **Version.** `copilot` runs the newest version it downloaded; the integration was tested on
  1.0.86 only (the bundled one, in an isolated Copilot home, without auto-update). The newer version
  the launcher runs in normal use was not exercised.
- **Not covered.** Remote provisioning of held presets (Claude and Codex only) does not include
  Copilot. A Copilot started in another terminal is not moved into the mesh: "Restart now" is refused and
  the agent keeps running, because nothing there reports its conversation, and the one named by its
  `--resume` argument may have been changed since it started by `/new` or `/resume`. It reports no idle
  state either, so "when idle" is never offered.

## Mistral Vibe sessions

"New session" offers Mistral Vibe (`vibe`, the `mistral-vibe` package, tested on 3.1.2). For that session
only, the mesh sets `VIBE_MCP_SERVERS` (the `mesh-board` MCP server) and gives Vibe one extra directory with
`--add-dir`: Vibe reads the `.vibe/hooks.toml` of every directory it is given, and the mesh's file there
holds the state hooks and the project context hook ([agent-hooks.md](agent-hooks.md)). That flag also makes the directory a workspace root of the agent, so the mesh creates
one read-only directory per session, holding nothing else, and deletes it when the session ends. Your `~/.vibe/config.toml`, `~/.vibe/hooks.toml` and project `.vibe` directory are
changed in no way, and no credential is read. Vibe replaces a configured MCP server of the same name as a
whole, so what you set on `mesh-board` (`disabled`, `disabled_tools`, in your user or project
configuration) is read and repeated in the injected entry: a stricter choice stays in force. Vibe starts
MCP servers with only the environment their entry lists, so the session token travels in that entry (set
on the command as `"$MESH_SESSION_TOKEN"`, expanded by the terminal's shell): it is in Vibe's process
environment and in no command line or file.

- **State.** The hooks report working (a prompt or a tool), waiting for a permission or a question, and
  the end of a turn or a failure; the sidebar uses them. A sub-agent never speaks for the terminal.
  Without the hooks (a Vibe started elsewhere) no state is reported.
- **Resume and restore.** A conversation is resumed with `vibe --resume <id>`, after a PTY host restart
  and from "Restart now". Kept: `--agent`, `--auto-approve`/`--yolo`, `--smart-approve`,
  `--enabled-tools`, `--disabled-tools` and your own `--add-dir`. Dropped: `--continue`, `--resume`,
  `--workdir`, `--model`, `--trust`, the worktree option, the headless options and the prompt. A resume is
  refused when an option it cannot read could be `--agent` or a tool list, and a one-shot run
  (`-p`, `--prompt`, `--prompt-file`) is never resumed. Vibe's parser refuses abbreviated options
  (`--ag plan` is an error, tested on 3.1.2), so a saved command holds none that ran: an abbreviation is an
  unknown option, never read as the restrictive or one-shot option it resembles. The conversation is the
  one the hooks reported,
  or the one the process names with `--resume`, or the single conversation of its folder written since
  it started in Vibe's session store (only its `meta.json` is read). The restart runs the `vibe` found in the
  terminal's `PATH` (the running binary is not probed) and reads `VIBE_HOME` in the server's environment, not in
  the terminal's shell. "Restart when idle" is not offered for Vibe (it reports no reliable idle state): use
  "Restart now". The session folder's `.vibe/config.toml` is read for what it restricts on `mesh-board`; a
  file that is not a regular file, is larger than 1 MiB or restricts more than 256 tools refuses the launch.
  An interrupted turn sends no end-of-turn notification: the session stays "working" until the next prompt.
- **History.** The "History" tab lists Vibe conversations from its unified session store (`meta.json`, and the
  checkpoint's message chunks for the counts and the first prompt: that layout is versioned and internal to Vibe
  3.1.2, so a conversation whose chunks cannot be read is still listed by its title). Resume and pins work;
  delete is not offered (a directory).
- **Messages and wake.** Vibe sessions message each other like the others. A notice is typed only while
  Vibe is idle at its prompt (its end-of-turn notification); a permission or a question closes the gate.
- **Terminal.** Vibe draws on the alternate screen with mouse reports: the wheel and a swipe scroll its
  own view, as for OpenCode.
- **Not covered.** Remote provisioning of held presets (Claude and Codex only) does not include Vibe;
  "Restart now" of a Vibe running in another terminal is the path shared with the other agents and was
  not run against a real Vibe.

## Notifications

The notification button at the bottom of the sidebar subscribes the device to push notifications
when an agent starts waiting for you or has finished. By default a notification carries only the
session name and the kind of event; ticking "details" on that device adds the agent's text, the
command or URL at stake and the choices, which then appear on the lock screen. Answer buttons in
notifications are off unless the owner turns them on; see
[docs/operations.md](operations.md#answer-buttons-in-notifications).

Claude Code and OpenCode report a permission prompt or a question, and notify at once. Antigravity
reports neither (its hooks have none): its notification "is waiting for you" comes only after its
terminal has been silent for 30 seconds since the last report (see
[Antigravity sessions](#antigravity-sessions)), and its question is not told apart from a permission.

## Projects

The Projects mode opens on the Projects view, described in
[The Projects view and the project tracker](#the-projects-view-and-the-project-tracker); this
section describes the old view.

**Projects** sits beside **Sessions** as a main mode. Its sidebar lists projects and **+ New**
asks for a name. Settings add optional local folders, a repository and source references;
the native host persists them privately. These references do not inspect folders, run Git or
connect external accounts. A stale save preserves the draft, and an interrupted save offers
reconciliation with the original request. Returning to Sessions keeps the terminal workspace
mounted. The isolated-agent profile keeps Sessions available without native
project editing. Existing catalogs remain readable. See [Projects](projects.md).

## Phone

On a narrow screen the page shows one column, and "Sessions" opens the sidebar as a drawer. An input
line ("Write to the agent… (⏎ sends)") replaces typing into the terminal, and a key bar provides
Esc, Tab, Ctrl, arrows, "↵ line", ^C, "Copy", "Paste", ✎ (the multi-line composer), 📎 and ⏎.
A key of the bar other than ✎ and 📎 (which open their own dialog) never opens or closes the
phone keyboard: the focus stays where it was. With the keyboard closed, the arrows move through
an agent's menus and lists with the whole screen visible; with it open, it stays open. After
arming Ctrl with the keyboard closed, tap the input line to type the letter. "Panes" lists the
open panes and "Actions" holds the top-bar buttons. A long press on a session opens its menu.

When an older terminal host is in **limited mode**, buffered Send and composer insertion are
unavailable on that connection. **Use live keyboard** in the terminal's banner opens its direct
keyboard once replay has finished. Keys go immediately to that live terminal; any text already
in the phone input line stays there and is not submitted. Selecting another connection restores
the ordinary phone input line. This does not enable dictation or queued input on a limited host.

**Direct writing.** A phone keyboard composes words and corrects them, so the input line holds
your text and sends it as one paste. Agents, however, show their command and skill completion
while you type, which needs each key at the terminal. So in a session whose foreground program is
Claude Code, Codex or Pi, an empty input line that receives `/` as its first character (or `$`, in
Codex only, which names skills with it) switches to *direct writing*. A "Direct" chip and an accent
border on the line show the mode.

In this mode the input line is not a copy of the agent's line. What you type is sent to the
terminal as it arrives, and the field is emptied at once and keeps the focus, so the keyboard stays
open. What you see is the agent's own line in the terminal, as in an ordinary terminal, with its
completion menu; nothing is held in the field. Backspace on the empty field erases a character in
the agent's line. A word composed by the keyboard is sent when the composition ends. The keyboard's
corrections do not apply: while the mode is on the field asks for no capital, no autocorrection and
no spell check (browsers that ignore this may still offer them), and a correction that would
replace a word is refused with a message and sent nowhere, because the terminal already has the
original word and the correction would be added to it, not substituted. Esc, Tab and the arrows of
the key bar go to the agent and keep the mode, to choose among the completions. "↵ line" (a line
break inside the agent's line, without submitting it) does the same and keeps the mode too.
Every key of the bar that writes into the agent's line follows one rule, the same as Enter: the
mode and the foreground are checked first (if the agent had already left, the mode ends and the
key is not sent), then any text the field still holds is delivered as typed, and only then does
the key go. Nothing goes before the text that precedes it. While a word is still being composed,
the key is refused with a message; so is a key that follows held text that could not be delivered
as typed (a message says why, and the key is not sent). Arming Ctrl in this mode follows the same
rule, so a held word is never taken for the letter Ctrl would turn into a control key.

A text with several lines never reaches the terminal as keys, whatever its source (typed
insertion, paste, drop, dictation): in direct writing it is sent as one bracketed paste, or refused
with a message when the program has not asked for bracketed paste or the text holds a control
character other than a line break or a tab; as the first thing typed it does not start the mode,
and stays in the field as an ordinary line. The key bar's "Paste" in this mode is checked like the
other keys: held text goes first, then the clipboard is sent as one bracketed paste (or refused as
above); an empty clipboard or a paste that was not delivered shows a message. Outside the mode,
"Paste" and "↵ line" behave as they always did and never start it.

The mode ends, sending nothing more, when:

- you press Enter (the keyboard's Enter, the send button or the key bar's ⏎): it sends Enter to
  the agent's line as the terminal shows it, after delivering, in order, any text the field still
  holds (a word whose composition just ended and has not been sent yet). Enter never goes before
  that text. While a word is still being composed, Enter from the send button or the key bar is
  refused with a message and nothing is sent; confirm the word, then press Enter. Some keyboards
  keep the Enter key for themselves during a composition (it confirms the word): it then never
  reaches the page, nothing is sent and no message appears, which is safe. If the text or Enter
  cannot be delivered, or the text is refused (control characters, several lines without bracketed
  paste), a message says so and Enter is not sent after it;
- a control key is sent: ^C, or Ctrl armed followed by a letter (Ctrl and `m` is Enter and ends the
  line like it);
- you send from the composer (✎) or the attachment menu (📎): what they send is not typed at the
  agent's line, so the field becomes an ordinary line again, with or without Enter;
- you tap the "Direct" chip: nothing is sent, and what was typed stays in the agent's line,
  visible in the terminal;
- you select another pane or session, or switch to Projects, Explorer or Management;
- the connection is lost (a message says so), or a key cannot be delivered (a message says so);
- the agent leaves the foreground (it exited, or the shell is back): the state is checked against
  the latest session list, refreshed when the mode starts, and before each key typed in the field
  and each key of the bar. The list
  is at most a few seconds old: a key typed in the interval before it catches up still reaches
  whatever program has the terminal, and the message says so ("keys typed in the last seconds may
  have reached the program, check the terminal's line before writing"). Because of that, the first
  ordinary line sent afterwards (or the key bar's ⏎ outside the mode) is held back once with a
  warning while the input lease is dirty: check the terminal's line, then press Enter again. The
  hold lasts 30 seconds after the agent was seen to leave; a line sent later is not held. Only
  Enter (the line's, or the bar's ⏎ outside the mode) ends the hold: keys, pastes and text typed
  in the field do not. The hold is one global slot, not one per pane: the next Enter on any pane
  ends it, and it only holds back a line sent from the pane the agent left.

The mode does not start when the field already held text before the `/`, including text that a
keyboard composed (the cursor at the start of "fix" and a composed `/x` stay one ordinary line),
nor while the connection to the session is not open yet: the word stays in the field.

Any other first character, a pasted line, and a shell session (where a line starting with `/` is
usually a path) keep the ordinary input line. There is no change on a computer.

## Language, reload, source code and sign-out

The footer of the sidebar holds:

- the **language** selector: "🌐 Auto" follows the browser's preferred languages, otherwise English
  or Français, remembered by this browser;
- the **colour theme** selector, remembered by this browser
  ([Colour themes and custom palette](#colour-themes-and-custom-palette));
- "**Source code**", a link to the source of this interface, which the AGPL-3.0-or-later licence
  makes available to its users;
- "**⟳ Reload**", which fetches the latest version of the page. When the server has a newer version,
  a "New version: reload" bar appears; the page postpones an automatic reload while you have unsent
  text or an operation in progress. On a release install, a banner at the top also says when a
  newer Session Mesh release is published, with its release notes and the upgrade command
  ("What's new" shows the notes in the page, rendered like a Markdown document); × hides
  it in this browser until the next release
  ([Update notice](operations.md#update-notice), off with `MESH_UPDATE_CHECK=0`);
- **⏻**: "Sign out this device", or "All devices…", which signs out every browser without changing
  the token or the sessions ([docs/operations.md](operations.md#logging-out-devices-and-replacing-the-token)).

## Colour themes and custom palette

The theme selector, next to the language selector in the sidebar footer, offers the default dark
theme, a light theme, Solarized Dark, Solarized Light, Gruvbox Dark and Nord. The page and every
open terminal change at once, without a reload; other tabs of the same browser follow. The choice
is kept in this browser, like the language, and applied before the page is drawn on the next load.

The terminals use the theme's own colours: background, text, cursor, selection and the 16 ANSI
colours. Where a source palette had no shade for an interface element (a second panel, a muted
text), the theme uses one derived from it, chosen so that text keeps a WCAG AA contrast (4.5:1).

"Custom palette…", the last entry of the selector, opens an editor for overrides laid over the
chosen theme: a JSON object of colour variables, for example

```json
{ "--bg": "#002b36", "--term": "#001e26", "--ansi-red": "#ff5f5f" }
```

The interface variables are `--bg`, `--term` (terminal background), `--panel`, `--panel-2`,
`--line`, `--line-2`, `--fg`, `--fg-2`, `--mute`, `--accent`, `--on-accent`, `--raise`, `--busy`,
`--idle`, `--wait`, `--off` and `--danger`; the terminal ones are `--cursor`, `--selection` and
`--ansi-black` to `--ansi-white` with their `--ansi-bright-…` forms. Only those names and only
hexadecimal colours (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`) are accepted; anything else is
refused with the offending names, and nothing is applied. "Start from the current theme" fills the
editor with every variable of the theme in use; "Reset" removes the overrides. After "Apply", the
editor warns when the text falls below a 4.5:1 contrast on the backgrounds, measuring a translucent
text as it shows; a translucent background cannot be measured, so it says so, and still reports a
failure measured on the other backgrounds. Choosing a theme that this browser refuses to store
still applies it, with a notice that the next load will not keep it. The
palette is stored in this browser's local storage (`localStorage`) only: another browser or device keeps its
own. Keeping it in a file under `~/.config/session-mesh/`, shared by every browser, is planned for a
later phase.

In this phase the theme applies to the main page and its terminals. The sign-in page, the
whiteboard and the code and Markdown views keep the default dark colours.

The arrow keys browse the closed selector without opening the editor: "Custom palette…" opens only
when it is chosen from the open list.
