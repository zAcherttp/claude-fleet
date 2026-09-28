---
name: fleet
description: >-
  Run several Claude Code sessions in parallel, one task each, without them
  stepping on each other. Use when asked to "fan out", "parallelise these issues",
  "run these in parallel sessions", "delegate this to another session", or when a
  task you are on turns up separate work that should not wait. Covers queueing a
  task from any session, the pool limit (default 5 running), launching the next
  queued task the moment a session halts, the shared board of who holds which
  files, messaging another session by name, and cleaning up after a merge.
---

# Fleet

A pool of parallel sessions, one task each. Any session can add work; at most
`max` run at once (default 5, `fleet config --max <n>`); the rest wait in a queue.
A session **holds a slot while `launching` or `working`** and frees it the moment
it halts — on a question for the user, on a mergeable PR, or done — and whoever
frees a slot launches the next task.

`fleet` is on PATH while this plugin is enabled (`"${CLAUDE_PLUGIN_ROOT}"/bin/fleet`
otherwise). Every command prints JSON; a `launch` array in any result is work you
must launch now (below).

## Delegate a task (any session)

```bash
fleet enqueue --title "<imperative, under 60 chars>" --key <owner/repo#123> --cwd <repo root> --prompt-file <file> --notify <your session id>
```

- `--notify` is how you hear back. The app only tells a spawning session when a
  task *ends*; a PR turning mergeable or a session stopping on a question is
  otherwise invisible until someone reads the board. Pass your own session id
  (the session-info tool gives it) whenever you are waiting on the result.
- `--key` names the thing being worked on (an issue, a ticket). A key already
  queued or running is refused with who holds it — do not start it yourself.
- The prompt file must stand alone: what to do, where, how to know it is done,
  and anything this conversation knows that the new session cannot.
- Result `state: "launching"` → launch it now. `state: "queued", position: n` →
  the pool is full; it starts when a slot frees. Tell the user which.

## Launch (whoever got a `launch` entry)

For each entry, start a new session in `cwd`, in its own worktree, with this prompt:

```
You are fleet task <id> (<key>). Your first command: fleet join <id> --session <your session id> --name <your session name> --worktree "$PWD"
Then follow the fleet skill for the whole task.

<the task's prompt>
```

Use the first launcher available: a start-session tool (no click); the desktop
app's task chip (`spawn_task` — the user clicks once; say so); otherwise print the
prompt for the user to paste into a new session. A launch nobody joins within 30
minutes goes back to the queue (`fleet sweep`).

## Inside a fleet session

1. **Join first.** `fleet join <id> ...` with your session id and name (the
   session-info tool gives both). A SessionStart hook reminds you which task
   you are when you resume.
2. **Read the board before editing a file you did not create**, and at the start
   of every resumed turn:

   ```bash
   fleet board
   ```

   It shows `slots used/max`, every running session (name, task, key, state,
   branch, PR, files touched, overlaps) and the queue. Files touched are read
   live from each worktree's git state, so they are never stale.
3. **Overlap → message before editing.** A file on another session's list:
   message that session by name (`SendMessage`, names from `ListAgents`), agree
   who takes it, and wait for the answer. Never edit it silently.
4. **Questions stay here.** Ask the user in this session; do not relay through
   another session. Before ending the turn on a question:
   `fleet state <id> question --note "<the question, one line>"` — this frees
   your slot, so **launch whatever it returns** first.
5. **Open the PR the repo's way** (its CLAUDE.md or PR skill), with CI auto-fix
   armed when the app offers it. When checks are green and review threads are
   resolved: `fleet state <id> mergeable --pr <url>`, launch what it returns, and
   end the turn with one line saying the PR is ready.
6. **Tell the enqueuer.** When `join` or a halting `state` (question, mergeable,
   done) returns a `notify` session id, send that session one line
   (`SendMessage` to the id): task id, new state, and the PR link or the
   one-line question. It is a notice, not a relay: the user still answers here.
   Don't wait for a reply.
7. **Resuming after an answer:** `fleet state <id> working` first. If the pool is
   full it still records you — the slot count may briefly exceed `max`; that is
   the only way a halted session gets back to work.

## After the merge — every session, every time

1. Stop every process this session started (dev servers, databases, instances),
   using the repo's own teardown if it documents one.
2. Delete the merged branch locally, and on the remote if the merge did not.
3. Leave the worktree: `git worktree remove <path>` from the main checkout, or
   let the app remove it when the session is archived.
4. `fleet state <id> done`, launch what it returns, and tell the `notify`
   session if it names one.
5. Archive this session when the app allows it (the PR monitor's
   auto-archive-on-close switch does it on merge).

Remove only what this session created; another session's worktree, servers and
databases are never yours to clean.

## Commands

| Command | Does |
|---|---|
| `fleet enqueue --title --key --cwd --prompt-file [--notify]` | add a task; launches it if a slot is free |
| `fleet next` | fill free slots from the queue; prints what to launch |
| `fleet join <id> --session --name --worktree` | bind this session to its task |
| `fleet state <id> working\|question\|mergeable\|done [--note] [--pr]` | report; halting states free the slot and return the next launch |
| `fleet release <id>` | give a task up unfinished |
| `fleet board [--json]` | slots, running sessions, overlaps, queue |
| `fleet sweep` | requeue launches nobody joined; mark tasks whose worktree is gone `lost` |
| `fleet config [--max n] [--launch-timeout-min n]` | pool settings |
| `fleet --self-test` | prove the pool, queue, lock and overlap rules still hold |

State lives in `$FLEET_HOME` (default `~/.fleet`), one JSON file per task, written
atomically under a lock that a dead process cannot hold forever.
