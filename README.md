# claude-fleet

A Claude Code plugin for running several sessions in parallel, one task each,
without them stepping on each other.

- **Delegate from anywhere.** Any session can `fleet enqueue` a task.
- **The enqueuer launches.** Enqueue with `--notify <session>` and that session
  owns the task: when a slot frees, the task becomes a pending launch for it
  (claimed once with `fleet events --for <session>`), instead of a chip from
  whichever session happened to halt. Tasks with no enqueuer launch as before.
- **Pull, don't wait for messages.** `fleet events --for <session>` returns
  everything since that session's stored cursor — done, released, lost, stale,
  verifying, issues filed and closed — so a busy dispatcher misses nothing.
  Messages are only a nudge. Questions and "PR ready" stay with the task's own
  session.
- **Prompts live in the fleet.** `fleet prompt <id>` prints the full launch text,
  so a launcher never points at a file in another session's scratchpad.
- **A dispatcher you can hand over.** The brief and task template live in the fleet,
  every task event is journaled per day, and `fleet resume` gives a fresh session
  the role, the last two days and the board, and retargets open tasks to it.
- **Findings enqueue themselves.** A session that turns up a new issue files it
  and enqueues it, and tells the enqueuer the task id, so nobody picks it up twice.
- **A pool, not a stampede.** At most 5 run at once (configurable); the rest queue.
  `fleet launch <id>` starts one named task past the limit (journaled, nothing
  else promoted), `fleet bump <id>` moves one to the head of the queue, and
  `fleet hold` / `unhold` pauses a scope's promotion without touching its queue.
- **Wait in the fleet, not in memory.** `--after <task>` and `--after-pr
  <owner/repo#n>` keep a task `waiting` (not counted, not promoted) until that
  task is done or that PR has merged.
- **Scopes keep projects apart.** Group repos into a scope with its own slots and
  queue (`fleet config --scope course --projects game,core --max 2`), so a work
  session never launches a side project's task, and `board`, `next` and
  `journal` take `--scope`.
- **No idle slots.** A session frees its slot the moment it halts — a question
  for you, a mergeable PR, verifying in production, or done. `next`, `enqueue`
  and `sweep` also requeue launches nobody joined, mark a task whose worktree is
  gone `lost`, and mark the older of two tasks recording one worktree `stale`.
- **Net issues per task.** `fleet state <id> done --closed web#1 --filed web#2`
  (or `working --filed …` mid-task) records what a task closed and filed;
  `board` and `journal` show today's net per project, so a task that grows the
  backlog shows while it runs.
- **A shared board.** Every session sees who is running, on what, which files
  each one has touched (read live from git), and where two overlap.
- **Talk, don't collide.** On an overlap, sessions message each other by name
  before editing.
- **Clean up after merge.** Every session tears down what it started once its PR
  lands.

```
slots 4/5
NAME   TASK  KEY              STATE      BRANCH             PR     NET  FILES  OVERLAP
alder  t001  acme/api#1650    mergeable  claude/alder-3f1   #1731  −1   6      —
birch  t002  acme/api#1652    working    claude/birch-9c2   —      +2   3      src/routes/sessions.ts ← cedar
cedar  t003  acme/api#1655    working    claude/cedar-11a   —      —    2      src/routes/sessions.ts ← birch
dogw   t004  acme/web#88      question   claude/dogw-7d0    —      —    1      —
notes
  dogw: should the empty state link to settings or to docs?
verifying (1)
  t005 acme/api#1640 PR #1720 — post-deploy probe on the export job
waiting (1)
  t008 acme/api#1670 Drop the old export path — after acme/api#1731 (OPEN)
queue (2)
  1. t006 acme/api#1661 Fix the export timeout
  2. t007 acme/api#1664 Retry the webhook on 502
net issues today
  api +1 (filed 2, closed 1)
```

## Install

```bash
claude plugin marketplace add zAcherttp/claude-fleet
claude plugin install fleet@claude-fleet
```

Needs Node 18+ and git. Launching without a click needs a session-starting tool;
in the Claude desktop app the fallback is one task chip per launch.

## How it works

- `bin/fleet` (on PATH while the plugin is enabled) keeps one JSON file per task
  in `$FLEET_HOME` (default `~/.fleet`), written atomically under a directory
  lock that is taken over when its holder has died.
- `skills/fleet` tells Claude when and how to enqueue, launch, join, report
  state, handle overlaps and clean up.
- A `SessionStart` hook tells a session inside a task's worktree which task it
  is, with the current board.
- `hooks/register.tsx` is a Claude Code mod (function hooks) that draws the
  board live: a band above the prompt, a pane (`/fleet-board`) and toasts. It
  reads `fleet board --all --json` and one batched `gh api graphql` query for
  every task's PR each minute, and never runs `fleet events`, so it claims no
  launches. A PR in a repository the signed-in `gh` account cannot read shows
  "no access" rather than failing the refresh.

### The board

![The fleet board in Claude Code's desktop app, showing the synthetic worst-case data](docs/board.png)

The pane lists what needs you first (a PR that is ready to merge, red or in
conflict, and every task with a question), then one card per scope with its
slot meter, its running tasks in fixed columns (id · state · title · PR · PR
status) and its queue (first five, the rest behind "+N more"). Waiting and
verifying tasks fold to one line. Status icons are drawn on the desktop; the
terminal shows the same badges as text. A refresh that takes five seconds or
more says where the time went, and a `gh` failure is shown, not swallowed.

For layout work, `FLEET_BOARD_FIXTURES=1` enables `/fleet-board worst`, which
swaps in a synthetic worst-case board (long and non-Latin titles, four-digit
ids, an over-capacity scope, a held scope, a red PR with four failing checks,
fourteen queued tasks), and `/fleet-board live` to go back.

States: `waiting → queued → launching → working → question | mergeable →
verifying → done`, plus `released` (given up), `lost` (worktree deleted) and
`stale` (another task joined the same worktree). Only `launching` and `working`
count against the pool.

## Check it

```bash
fleet --self-test
claude plugin test .
```

`claude plugin test` runs the board's 17 tests on the terminal and desktop
surfaces, including the worst-case board at 48 and 100 columns.

51 checks: the pool limit, the queue position, duplicate keys refused, a second session refused on a held task (and `--takeover` for a gone one), a halt
freeing its slot, the enqueuer named on done, release and a lost worktree but never on a question or mergeable, stale launches requeued, lost
worktrees, overlap detection, the journal and dispatcher hand-over, per-scope slots and queues, a held lock blocking a writer, a dead holder's lock
taken over, six concurrent enqueues of one key producing exactly one task; and for 0.5.0: a promoted task with an enqueuer becomes that enqueuer's
pending launch, claimed exactly once, and handed to the next halting session if never claimed; `launch` past `max` promotes nothing else; `bump`;
`hold`/`unhold`; `--after` and `--after-pr` waits (and `gh` missing); `events` cursors per session and per filter; `verifying` holding no slot and
surviving its worktree; `prompt`; `next` and `enqueue` sweeping; the older of two tasks in one worktree marked `stale`; filed/closed refs and today's
net; and 0.4.1 task files still working.

## License

MIT
