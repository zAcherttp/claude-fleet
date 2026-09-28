# claude-fleet

A Claude Code plugin for running several sessions in parallel, one task each,
without them stepping on each other.

- **Delegate from anywhere.** Any session can `fleet enqueue` a task.
- **Hear back.** Enqueue with `--notify <session>` and the task messages that
  session each time it stops: on a question, a mergeable PR, or done.
- **A pool, not a stampede.** At most 5 run at once (configurable); the rest queue.
- **No idle slots.** A session frees its slot the moment it halts — a question
  for you, a mergeable PR, or done — and launches the next queued task itself.
- **A shared board.** Every session sees who is running, on what, which files
  each one has touched (read live from git), and where two overlap.
- **Talk, don't collide.** On an overlap, sessions message each other by name
  before editing.
- **Clean up after merge.** Every session tears down what it started once its PR
  lands.

```
slots 4/5
NAME   TASK  KEY              STATE      BRANCH             PR     FILES  OVERLAP
alder  t001  acme/api#1650    mergeable  claude/alder-3f1   #1731  6      —
birch  t002  acme/api#1652    working    claude/birch-9c2   —      3      src/routes/sessions.ts ← cedar
cedar  t003  acme/api#1655    working    claude/cedar-11a   —      2      src/routes/sessions.ts ← birch
dogw   t004  acme/web#88      question   claude/dogw-7d0    —      1      —
notes
  dogw: should the empty state link to settings or to docs?
queue (2)
  1. t006 acme/api#1661 Fix the export timeout
  2. t007 acme/api#1664 Retry the webhook on 502
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

States: `queued → launching → working → question | mergeable → done`, plus
`released` (given up) and `lost` (worktree deleted). Only `launching` and
`working` count against the pool.

## Check it

```bash
fleet --self-test
```

12 checks: the pool limit, the queue position, duplicate keys refused, a halt
freeing its slot and returning the next launch, the enqueuer named on every halt
and on nothing else, stale launches requeued, lost
worktrees, overlap detection, a held lock blocking a writer, a dead holder's lock
taken over, and six concurrent enqueues of one key producing exactly one task.

## License

MIT
