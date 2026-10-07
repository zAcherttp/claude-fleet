---
name: fleet
description: >-
  Run several Claude Code sessions in parallel, one task each, without them
  stepping on each other. Use when asked to "fan out", "parallelise these issues",
  "run these in parallel sessions", "delegate this to another session", or when a
  task you are on turns up separate work that should not wait. Covers queueing a
  task from any session, the pool limit (default 5 running), who launches the next
  queued task when a session halts, holding a pool, tasks that wait on another task
  or a PR, the event feed a dispatcher reads, the shared board of who holds which
  files, messaging another session by name, and cleaning up after a merge.
---

# Fleet

A pool of parallel sessions, one task each. Any session can add work; at most
`max` run at once (default 5, `fleet config --max <n>`); the rest wait in a queue.
A session **holds a slot while `launching` or `working`** and frees it the moment
it halts — on a question for the user, on a mergeable PR, while verifying in
production, or done. **A halting session reports; the enqueuer launches**: the
task promoted into the freed slot goes to the session that enqueued it
(`--notify`), not to whichever session happened to halt.

**Scopes.** Projects that belong together (one course, one client, one
company) can share a scope with its own slots and queue, so a freed slot never
hands one project's session another project's work:

```bash
fleet config --scope <name> --projects <repo,repo> [--paths <dir>] [--max <n>]
```

A task's scope is its `--scope` on enqueue, else the scope whose `--projects`
names its repo or whose `--paths` holds its `cwd`, else `default` (sized by the
plain `fleet config --max`). Tasks queued before a scope existed join it as soon
as it is configured. With no scope configured, everything is `default` and the
fleet behaves as one pool. `next`, `sweep`, `hold` and `board` act on the scope of
the current directory unless given `--scope` (`board --all` shows every scope).

`fleet` is on PATH while this plugin is enabled (`"${CLAUDE_PLUGIN_ROOT}"/bin/fleet`
otherwise). Every command prints JSON. In any result:

- a `launch` array is work **you** must launch now (below);
- a `nudge` array names enqueuers whose tasks were just promoted: send each
  `session` one line (`SendMessage`, no reply awaited): "fleet: <ids> ready to
  launch — run `fleet events --for <your session id>`". Do not launch them yourself;
- a `swept.notify` (or `sweep`'s `notify`) list names enqueuers of tasks found
  `lost` or `stale`: send each one line naming the task and its state.

## Delegate a task (any session)

```bash
fleet enqueue --title "<imperative, under 60 chars>" --key <owner/repo#123> --cwd <repo root> --prompt-file <file> --notify <your session id>
```

- `--notify <your session id>` (the session-info tool gives it) makes you the
  task's enqueuer: you launch it when a slot frees, and you hear what you can
  act on — finished, given up, lost, stale, and the issues it filed. Questions
  and "PR ready" are not sent; the task's own session puts those to the user.
- `--key` names the thing being worked on (an issue, a ticket). A key already
  waiting, queued, running or verifying is refused with who holds it — do not
  start it yourself.
- The prompt must stand alone: what to do, where, how to know it is done, and
  anything this conversation knows that the new session cannot. It is stored in
  the fleet; launchers read it back with `fleet prompt <id>`, so the prompt file
  can be a scratch file.
- **Work that can only start later waits in the fleet, not in your memory:**
  `--after <task id>` waits until that task is `done`; `--after-pr <owner/repo#n>`
  waits until that PR is merged (checked with `gh` on every `next`, `enqueue` and
  `sweep`). A waiting task is not counted and not promoted; it joins the tail of
  the queue when its condition holds.
- Result `state: "launching"` → launch it now. `"queued", position: n` → the pool
  is full; it starts when a slot frees and you get the launch. `"waiting"` → it
  joins the queue later. Tell the user which.

## Launch

Who launches:

- **The enqueuer.** When a slot frees, a promoted task with a `--notify` becomes
  a *pending launch* for that session. Claim it with
  `fleet events --for <your session id>` — the result's `launch` array holds it,
  and a pending launch is handed out exactly once. Run it at the start of every
  turn while you have tasks in the fleet, and whenever a fleet nudge arrives.
- **Whoever freed the slot, for a task with no enqueuer** (no `--notify`), and for
  a pending launch its enqueuer did not claim within the launch timeout.
- **You, explicitly:** `fleet next [--scope <name>]` fills the scope's free slots
  and hands you everything it promotes. `fleet launch <id>` starts that one
  queued task now, even past `max` — a journaled override that promotes nothing
  else; never raise `--max` to get one task started. `fleet launch <id>` on a
  pending launch claims it.

Order and pauses: `fleet bump <id>` moves a queued task to the head of its
scope's queue (never release and re-enqueue to reorder). `fleet hold --scope <s>
--note "<why>"` stops promotion in a scope — the queue stays and the board shows
HELD — and `fleet unhold --scope <s>` resumes it and returns what it launched.

For each entry in a `launch` array, start a new session in `cwd`, in its own
worktree, with this prompt:

```
Run `fleet prompt <id>` and treat its output as your instructions.
```

`fleet prompt <id>` prints the full launch text: the "You are fleet task … join …"
header and the stored prompt. Use the first launcher available: a start-session
tool (no click); the desktop app's task chip (`spawn_task` — the user clicks
once; say so); otherwise print `fleet prompt <id>`'s output for the user to paste
into a new session. A launch nobody joins within 30 minutes goes back to the
queue on the next `next`, `enqueue` or `sweep`.

## Dispatching: one session that keeps a project's (or a scope's) pool full

A dispatcher is an ordinary session whose job is picking work, enqueueing it and
reporting what lands. What makes it one is written down, so any session can take
the role and the old one can be archived:

- **Start or take over:** `fleet resume --project <name> --session <your session id>`.
  It prints the saved brief, where the task template is, today's and yesterday's
  journal for that project, and the board. With `--session` it retargets
  `--notify` (and any pending launch) on that project's open tasks to you, so
  their launches and notices reach you and not an archived dispatcher. A
  dispatcher for several repos takes the scope instead:
  `fleet resume --scope <name> --session <id>`.
- **Every turn, read the events:** `fleet events --project <name> --for <your
  session id>` (or `--scope`). It returns every done, release, lost, stale,
  verifying and filed/closed issue since your last call — your cursor is stored
  per session, so nothing is missed while you were busy — and claims your
  pending launches. Messages are only a nudge to run it; the events are the
  record. `--since <cursor>` replays from an earlier point.
- **Keep the role current:** `fleet dispatch save --project <name> --brief <file>
  --template <file>` whenever the user changes how the work should be picked or
  what every task prompt must say. The brief is the user's standing instructions;
  the template is the rules block every task prompt carries.
- **The journal is automatic:** enqueue, launch, join, every state change,
  release, requeue, lost, stale, hold and bump are recorded per day under
  `$FLEET_HOME/journal/`, with each task's filed and closed issues; `board` and
  `journal` show today's net issues per project. Add what the events can't say
  with `fleet note --project <name> --text "<decision, hand-off or blocker>"`.
  Read it with `fleet journal --project <name> [--days n]`, or `--scope <name>`.
- Resume from the events, the journal and the board, never by re-reading old
  transcripts.

## Inside a fleet session

1. **Join first.** `fleet join <id> ...` with your session id and name (the
   session-info tool gives both). A SessionStart hook reminds you which task
   you are when you resume. **If join refuses because another session already
   holds the task, stop at once**: change nothing, tell the user in one line
   which session holds it, and end. `--takeover` is for a task whose holding
   session is gone (archived or deleted), and only when the user says so. Join
   from the worktree you will work in: if two active tasks record the same
   worktree, the older one is marked `stale`.
2. **Read the board before editing a file you did not create**, and at the start
   of every resumed turn:

   ```bash
   fleet board
   ```

   It shows your scope's `slots used/max` (and HELD), every running session
   (name, task, key, state, branch, PR, net issues, files touched, overlaps), the
   tasks verifying in production, the tasks waiting on another task or a PR, the
   queue, and today's net issues. Files touched are read live from each
   worktree's git state, so they are never stale.
3. **Overlap → message before editing.** A file on another session's list:
   message that session by name (`SendMessage`, names from `ListAgents`), agree
   who takes it, and wait for the answer. Never edit it silently.
4. **Questions stay here.** Ask the user in this session; do not relay through
   another session. Before ending the turn on a question:
   `fleet state <id> question --note "<the question, one line>"` — this frees
   your slot; launch any `launch` it returns and send any `nudge`.
5. **Open the PR the repo's way** (its CLAUDE.md or PR skill), with CI auto-fix
   armed when the app offers it. When checks are green and review threads are
   resolved: `fleet state <id> mergeable --pr <url>`, handle `launch`/`nudge`,
   and end the turn with one line saying the PR is ready.
6. **Work you turn up, you enqueue.** A new issue that stems from this task is
   yours to hand on, not the enqueuer's to pick up: file it, record it with
   `fleet state <id> working --filed <owner/repo#n>`, then `fleet enqueue` it
   with `--key <owner/repo#n>` and `--notify` set to the `notify` that `join` gave
   you (not your own id: you will be gone before it finishes). If it can only
   start after your PR merges, enqueue it now with `--after-pr <your PR>`. If it
   needs a decision nobody has made, file it and do not enqueue it.
7. **Tell the enqueuer only what it acts on.** `join` returns `notify`, the
   session that delegated this task. Send it one line (`SendMessage` to the id,
   no reply awaited) when you file an issue, and when `done` or `release`
   returns `notify`. The line names the task id, state, the PR, the issues
   closed, and for each issue filed either the task id you enqueued it as or why
   you did not. Never for a question or a mergeable PR: those go to the user here.
   The same facts are in `fleet events`, so a missed message is not lost.
8. **Resuming after an answer:** `fleet state <id> working` first. If the pool is
   full it still records you — the slot count may briefly exceed `max`; that is
   the only way a halted session gets back to work.

## After the merge — every session, every time

1. Stop every process this session started (dev servers, databases, instances),
   using the repo's own teardown if it documents one.
2. Delete the merged branch locally, and on the remote if the merge did not.
3. Leave the worktree: `git worktree remove <path>` from the main checkout, or
   let the app remove it when the session is archived.
4. **Still waiting on production** (a probe run, a post-deploy check, a flag
   flip)? `fleet state <id> verifying --note "<what is awaited>"`: it holds no
   slot and stays on the board until you run `done`.
5. `fleet state <id> done --closed <refs> --filed <refs>` (comma lists like
   `lms#1,lms#2`; leave out what is empty), handle `launch`/`nudge`, and send the
   `notify` session its one line.
6. Archive this session when the app allows it (the PR monitor's
   auto-archive-on-close switch does it on merge).

Remove only what this session created; another session's worktree, servers and
databases are never yours to clean.

## Commands

| Command | Does |
|---|---|
| `fleet enqueue --title --key --cwd --prompt-file [--notify] [--scope] [--after <id>] [--after-pr <o/r#n>]` | add a task; launches it if its scope has a free slot; waits on a task or PR |
| `fleet next [--scope] [--for]` | sweep, then fill the scope's free slots; prints what to launch |
| `fleet launch <id> [--for]` | launch one queued task now, past `max`; or claim a pending launch |
| `fleet bump <id>` | move a queued task to the head of its scope's queue |
| `fleet hold [--scope] [--note]` / `fleet unhold [--scope]` | stop / resume promotion in a scope |
| `fleet join <id> --session --name --worktree [--takeover]` | bind this session to its task; refused while another session holds it |
| `fleet state <id> working\|question\|mergeable\|verifying\|done [--note] [--pr] [--closed] [--filed]` | report; halting states free the slot and return `launch` / `nudge` |
| `fleet release <id>` | give a task up unfinished; tell the `notify` session why |
| `fleet events [--project \| --scope] [--since <cursor>] [--for <session>]` | what happened since the cursor; `--for` keeps the cursor and claims pending launches |
| `fleet prompt <id>` | the full launch text for a task |
| `fleet board [--scope \| --all] [--json]` | slots, running sessions, overlaps, verifying, waiting, queue, net issues today |
| `fleet journal [--project \| --scope] [--days]` | what happened, bucketed by day, with today's net issues |
| `fleet note --project --text` | add a decision, hand-off or blocker to the journal |
| `fleet dispatch save --project\|--scope [--brief] [--template]` | keep what makes a session the dispatcher |
| `fleet resume --project\|--scope [--session]` | brief, template, journal and board; retargets `--notify` |
| `fleet sweep [--scope] [--for]` | release waits, requeue launches nobody joined or claimed, mark gone worktrees `lost` and shared ones `stale` |
| `fleet config [--max n] [--launch-timeout-min n]` | pool settings (`max` sizes the `default` scope) |
| `fleet config --scope <s> [--projects a,b] [--paths dir] [--max n] [--remove]` | define, resize or remove a scope |
| `fleet --self-test` | prove the pool, queue, routing, waits, events, scope, lock and overlap rules still hold |

States: `waiting → queued → launching → working → question | mergeable →
verifying → done`, plus `released` (given up), `lost` (worktree deleted) and
`stale` (another task joined the same worktree). Only `launching` and `working`
count against the pool.

State lives in `$FLEET_HOME` (default `~/.fleet`), one JSON file per task, written
atomically under a lock that a dead process cannot hold forever.
