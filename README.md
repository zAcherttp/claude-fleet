# claude-fleet

A small helper for running a few Claude Code sessions side by side, one task each.

![The fleet board in Claude Code](docs/board.png)

You queue the work; fleet starts the next task when a session frees up, and keeps a board of what each one is doing and what is waiting on you.

## What it might help with

- **Handing work off.** Any session can pass a task along with `fleet enqueue`, and it waits its turn in the queue.
- **Keeping things moving.** A few sessions run at once. When one finishes, stops to ask you something or opens a PR, the next task can start. The default of five is simply what one laptop handles comfortably; raise or lower it with `fleet config --max <n>`, per scope if you like.
- **Sessions that know about each other.** Each session can see the board, so if you send a message to the wrong one, it will usually point you to the session that owns that task and offer to pass the message on.
- **Overlaps noticed early.** Worktrees keep edits apart, but two tasks changing the same file can still conflict when they merge. Fleet notices the overlap while both are running, so the sessions can talk it through.
- **A quiet view of what needs you.** A line above your prompt and a `/fleet-board` pane show PRs that are ready, red or in conflict, and any open questions. A small toast appears when something changes.
- **Waiting and pausing.** A task can wait for another task or for a PR to merge, a project can be held during a release, and one task can be moved to the front.
- **Picking up where you left off.** The brief, the task template and a daily journal are kept with the fleet, so a new session can take over the coordinating role.

### "Couldn't I just open the sessions myself?"

You can, and for two or three tasks that works well. Past that, you tend to become the bottleneck: noticing which session finished, remembering which one had which issue, choosing what comes next, and checking each PR for its status. Fleet takes care of that bookkeeping and lets you know when a person is actually needed.

### A note before installing

Fleet is ephemeral software. It was written for one person's day-to-day work and changes as that work changes. Commands, file formats and the board may shift between versions without a migration path, and parts of it may be retired once Claude Code does the same job natively. If you depend on it, pin a version and read the release notes before updating.

## Install

```bash
claude plugin marketplace add zAcherttp/claude-fleet
claude plugin install fleet@claude-fleet
```

Then ask Claude to *"fan these issues out in parallel"*, or open the board with `/fleet-board`.

Needs Node 18+, git and the GitHub CLI (`gh`) for PR status.

<details>
<summary>The terminal view</summary>

```
slots 4/5
NAME   TASK  KEY              STATE      BRANCH             PR     NET  FILES  OVERLAP
alder  t001  acme/api#1650    mergeable  claude/alder-3f1   #1731  −1   6      —
birch  t002  acme/api#1652    working    claude/birch-9c2   —      +2   3      src/routes/sessions.ts ← cedar
cedar  t003  acme/api#1655    working    claude/cedar-11a   —      —    2      src/routes/sessions.ts ← birch
dogw   t004  acme/web#88      question   claude/dogw-7d0    —      —    1      —
queue (2)
  1. t006 acme/api#1661 Fix the export timeout
  2. t007 acme/api#1664 Retry the webhook on 502
```

</details>

<details>
<summary>How it works</summary>

- `bin/fleet` keeps one JSON file per task in `~/.fleet`, written atomically under a lock that recovers from a crashed holder.
- `skills/fleet` teaches Claude when to enqueue, launch, join, report state and clean up after a merge.
- `hooks/register.tsx` is a Claude Code mod that draws the board. It reads the board and **one** batched GraphQL query for every PR (about a second), and shows "no access" for repos your `gh` account can't read.
- A task moves through `waiting → queued → launching → working → question | mergeable → verifying → done`. Only `launching` and `working` take a slot.

</details>

<details>
<summary>Tested</summary>

`fleet --self-test` runs 51 checks: the pool limit, queue order, held tasks, dependencies, locks, hand-over and six concurrent enqueues producing exactly one task. `claude plugin test .` runs 17 board tests on the terminal and the desktop at 36, 48 and 100 columns, including a worst-case board (`FLEET_BOARD_FIXTURES=1`, `/fleet-board worst`).

</details>

MIT licensed.
