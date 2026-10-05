#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectOf, readJournal, readProfile, record, renderJournal, saveProfile } from "./journal.mjs";

const USAGE = `fleet — a pool of parallel Claude Code sessions, one task each

  enqueue --title <t> (--prompt <p> | --prompt-file <f>) [--key <k>] [--cwd <dir>] [--by <name>] [--notify <session>] [--scope <s>]
  next    [--scope <s>]                 promote the scope's queued tasks into its free slots; print what to launch
  join    <id> --session <id> --name <n> --worktree <dir> [--takeover]   refused while another session holds the task
  state   <id> working|question|mergeable|done [--note <text>] [--pr <url|n>]
  release <id>                          give the task up without finishing it
  board   [--scope <s> | --all] [--json]   slots, running sessions, overlaps, queue
  sweep   [--scope <s>]                 requeue stale launches, free tasks whose worktree is gone
  config  [--max <n>] [--launch-timeout-min <n>]
  config  --scope <s> [--projects <a,b>] [--paths <dir,dir>] [--max <n>] [--remove]
  journal [--project <p> | --scope <s>] [--days <n>]  what happened, bucketed by day (default today and yesterday)
  note    --project <p> --text <t>      add a line to the journal: a decision, a hand-off, a blocker
  dispatch save (--project <p> | --scope <s>) [--brief <file>] [--template <file>]   keep what makes a session the dispatcher
  resume  (--project <p> | --scope <s>) [--session <id>] [--days <n>]   brief, template, journal and board; --session retargets --notify
  hook-session-start                    context for a session whose worktree is a fleet task
  --self-test

State lives in $FLEET_HOME (default ~/.fleet). A slot is held while a task is
launching or working; question, mergeable and done free it.

A scope groups projects into one pool with its own slots and queue. A task's
scope is its --scope, else the scope whose --projects names its project or whose
--paths holds its cwd, else "default". Without --scope, next, sweep and board
act on the scope of the current directory.`;

const HOLDS_SLOT = new Set(["launching", "working"]);
const ACTIVE = new Set(["queued", "launching", "working", "question", "mergeable"]);
const SESSION_STATES = new Set(["working", "question", "mergeable", "done"]);
const NOTIFY_ON = new Set(["done"]);
const DEFAULT_SCOPE = "default";

export function home(env = process.env) {
  return env.FLEET_HOME || path.join(os.homedir(), ".fleet");
}

const paths = (root) => ({
  root,
  tasks: path.join(root, "tasks"),
  lock: path.join(root, "lock"),
  config: path.join(root, "config.json"),
});

function writeAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withLock(root, fn, { timeoutMs = 10_000 } = {}) {
  const p = paths(root);
  fs.mkdirSync(p.tasks, { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(p.lock);
      fs.writeFileSync(path.join(p.lock, "pid"), String(process.pid));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const holder = Number(fs.readFileSync(path.join(p.lock, "pid"), "utf8").trim() || 0);
      if (holder && !pidAlive(holder)) {
        fs.rmSync(p.lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > timeoutMs) throw new Error(`fleet: lock held by pid ${holder || "?"}`);
      sleepMs(25);
    }
  }
  try {
    return fn(p);
  } finally {
    fs.rmSync(p.lock, { recursive: true, force: true });
  }
}

function readConfig(p) {
  const defaults = { max: 5, launchTimeoutMin: 30, scopes: {} };
  if (!fs.existsSync(p.config)) return defaults;
  return { ...defaults, ...JSON.parse(fs.readFileSync(p.config, "utf8")) };
}

const under = (dir, prefix) => dir === prefix || dir.startsWith(prefix + path.sep);

function scopeOfProject(config, project, dir = null) {
  for (const [name, s] of Object.entries(config.scopes ?? {})) {
    if ((s.projects ?? []).includes(project)) return name;
    if (dir && (s.paths ?? []).some((prefix) => under(dir, prefix))) return name;
  }
  return DEFAULT_SCOPE;
}

const maxOf = (config, scope) => config.scopes?.[scope]?.max ?? config.max;
const scopeOfDir = (config, dir) => scopeOfProject(config, projectOf(dir), real(dir));

function readTasks(p) {
  return fs
    .readdirSync(p.tasks)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(p.tasks, f), "utf8")))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

function real(p) {
  const rest = [];
  let at = path.resolve(p);
  while (!fs.existsSync(at) && path.dirname(at) !== at) {
    rest.unshift(path.basename(at));
    at = path.dirname(at);
  }
  return path.join(fs.realpathSync(at), ...rest);
}

const saveTask = (p, t) => writeAtomic(path.join(p.tasks, `${t.id}.json`), { ...t, updatedAt: Date.now() });

function findTask(p, id) {
  const file = path.join(p.tasks, `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`fleet: no task ${id}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function newId(tasks) {
  const n = tasks.reduce((m, t) => Math.max(m, Number(t.id.slice(1)) || 0), 0) + 1;
  return `t${String(n).padStart(3, "0")}`;
}

function promote(p, scope, now = Date.now()) {
  const config = readConfig(p);
  const max = maxOf(config, scope);
  const tasks = readTasks(p).filter((t) => scopeOfTask(config, t) === scope);
  let used = tasks.filter((t) => HOLDS_SLOT.has(t.state)).length;
  const launch = [];
  for (const t of tasks) {
    if (used >= max) break;
    if (t.state !== "queued") continue;
    const next = { ...t, state: "launching", launchedAt: now };
    saveTask(p, next);
    launch.push(next);
    used++;
  }
  return launch;
}

const projectOfTask = (t) => t.project ?? projectOf(t.cwd);
const scopeOfTask = (config, t) => t.scope ?? scopeOfProject(config, projectOfTask(t), t.cwd ? real(t.cwd) : null);
const log = (p, t, event, extra = {}) =>
  record(p.root, { project: projectOfTask(t), scope: scopeOfTask(readConfig(p), t), id: t.id, key: t.key, event, ...extra });

const launchView = (config) => (t) => ({ id: t.id, title: t.title, cwd: t.cwd, key: t.key, scope: scopeOfTask(config, t), prompt: t.prompt });
const launchesFor = (p, scope, now) => promote(p, scope, now).map(launchView(readConfig(p)));

export function enqueue(root, { title, prompt, key = null, cwd = process.cwd(), by = null, notify = null, scope = null }) {
  if (!title || !prompt) throw new Error("fleet: enqueue needs --title and a prompt");
  return withLock(root, (p) => {
    const tasks = readTasks(p);
    const dup = key && tasks.find((t) => t.key === key && ACTIVE.has(t.state));
    if (dup) throw new Error(`fleet: ${key} is already ${dup.state} as ${dup.id}${dup.session?.name ? ` (${dup.session.name})` : ""}`);
    const now = Date.now();
    const task = { id: newId(tasks), key, title, prompt, cwd: path.resolve(cwd), project: projectOf(cwd), ...(scope ? { scope } : {}), by, notify, state: "queued", createdAt: now };
    saveTask(p, task);
    log(p, task, "enqueue", { note: title });
    const config = readConfig(p);
    const mine = scopeOfTask(config, task);
    const launch = launchesFor(p, mine, now);
    const position = readTasks(p).filter((t) => t.state === "queued" && scopeOfTask(config, t) === mine).findIndex((t) => t.id === task.id);
    return { id: task.id, scope: mine, state: launch.some((t) => t.id === task.id) ? "launching" : "queued", position: position === -1 ? null : position + 1, launch };
  });
}

export function next(root, { scope = null, cwd = process.cwd() } = {}) {
  return withLock(root, (p) => {
    const s = scope ?? scopeOfDir(readConfig(p), cwd);
    return { scope: s, launch: launchesFor(p, s) };
  });
}

export function join(root, id, { session, name, worktree, takeover = false }) {
  return withLock(root, (p) => {
    const t = findTask(p, id);
    if (!["launching", "working", "question"].includes(t.state)) throw new Error(`fleet: ${id} is ${t.state}, not joinable`);
    const holder = t.session?.id;
    if (holder && session && holder !== session && !takeover)
      throw new Error(`fleet: ${id} is already held by ${t.session.name ?? holder} (${holder}); this session must stop. Pass --takeover only if that session is gone`);
    const wt = worktree ? real(worktree) : null;
    saveTask(p, { ...t, state: "working", session: { id: session ?? null, name: name ?? null }, worktree: wt, joinedAt: Date.now() });
    log(p, t, holder && holder !== session ? "takeover" : "join", { note: name ?? null });
    return { id, state: "working", notify: t.notify ?? null };
  });
}

export function setState(root, id, state, { note = null, pr = null } = {}) {
  if (!SESSION_STATES.has(state)) throw new Error(`fleet: state must be one of ${[...SESSION_STATES].join("|")}`);
  return withLock(root, (p) => {
    const t = findTask(p, id);
    saveTask(p, { ...t, state, note: note ?? t.note ?? null, pr: pr ?? t.pr ?? null });
    log(p, t, state, { pr: pr ?? null, note: note ?? null });
    return { id, state, notify: NOTIFY_ON.has(state) ? (t.notify ?? null) : null, launch: launchesFor(p, scopeOfTask(readConfig(p), t)) };
  });
}

export function release(root, id) {
  return withLock(root, (p) => {
    const t = findTask(p, id);
    saveTask(p, { ...t, state: "released" });
    log(p, t, "released");
    return { id, state: "released", notify: t.notify ?? null, launch: launchesFor(p, scopeOfTask(readConfig(p), t)) };
  });
}

export function sweep(root, { scope = null, cwd = process.cwd(), now = Date.now() } = {}) {
  return withLock(root, (p) => {
    const { launchTimeoutMin } = readConfig(p);
    const changed = [];
    const notify = [];
    for (const t of readTasks(p)) {
      if (t.state === "launching" && now - (t.launchedAt ?? 0) > launchTimeoutMin * 60_000) {
        saveTask(p, { ...t, state: "queued", launchedAt: null });
        changed.push(`${t.id} launching → queued (never joined)`);
        log(p, t, "requeued", { note: "never joined" });
      } else if (ACTIVE.has(t.state) && t.worktree && !fs.existsSync(t.worktree)) {
        saveTask(p, { ...t, state: "lost" });
        changed.push(`${t.id} ${t.state} → lost (worktree gone)`);
        log(p, t, "lost", { note: "worktree gone" });
        if (t.notify) notify.push({ session: t.notify, id: t.id, key: t.key, state: "lost" });
      }
    }
    const s = scope ?? scopeOfDir(readConfig(p), cwd);
    return { changed, notify, scope: s, launch: launchesFor(p, s, now) };
  });
}

export function journal(root, { project = null, scope = null, days = 2, now = Date.now() } = {}) {
  const config = readConfig(paths(root));
  return readJournal(root, { project, days, now }).filter((e) => !scope || (e.scope ?? scopeOfProject(config, e.project)) === scope);
}

export function note(root, { project, text, now = Date.now() }) {
  if (!project || !text) throw new Error("fleet: note needs --project and --text");
  record(root, { project, scope: scopeOfProject(readConfig(paths(root)), project), event: "note", note: text }, now);
  return { project, noted: text };
}

export function resume(root, { project = null, scope = null, session = null, days = 2, now = Date.now() }) {
  if (!project === !scope) throw new Error("fleet: resume needs --project or --scope");
  const name = project ?? scope;
  const ours = (config, t) => (project ? projectOfTask(t) === project : scopeOfTask(config, t) === scope);
  const retargeted = session
    ? withLock(root, (p) => {
        const config = readConfig(p);
        const moved = [];
        for (const t of readTasks(p)) {
          if (!ACTIVE.has(t.state) || !ours(config, t) || !t.notify || t.notify === session) continue;
          saveTask(p, { ...t, notify: session });
          moved.push(t.id);
        }
        const where = project ? { project, scope: scopeOfProject(config, project) } : { project: null, scope };
        record(root, { ...where, event: "resume", note: `dispatcher is now ${session}${moved.length ? `; retargeted ${moved.join(" ")}` : ""}` }, now);
        return moved;
      })
    : [];
  return { profile: readProfile(root, name), retargeted, journal: journal(root, { project, scope, days, now }) };
}

export function configure(root, { max, launchTimeoutMin, scope = null, projects = null, dirs = null, remove = false }) {
  return withLock(root, (p) => {
    const c = readConfig(p);
    if (scope) {
      if (scope === DEFAULT_SCOPE && (projects || dirs)) throw new Error(`fleet: "${DEFAULT_SCOPE}" holds whatever no scope claims; name another scope`);
      if (remove) delete c.scopes[scope];
      else {
        const s = { ...(c.scopes[scope] ?? {}) };
        if (projects != null) s.projects = projects;
        if (dirs != null) s.paths = dirs.map((d) => real(d));
        if (max != null) s.max = Math.max(1, Number(max));
        c.scopes = { ...c.scopes, [scope]: s };
      }
    } else if (max != null) c.max = Math.max(1, Number(max));
    if (launchTimeoutMin != null) c.launchTimeoutMin = Math.max(1, Number(launchTimeoutMin));
    writeAtomic(p.config, c);
    return c;
  });
}

function git(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function filesTouched(worktree) {
  if (!worktree || !fs.existsSync(worktree)) return [];
  const base =
    git(worktree, ["merge-base", "HEAD", "origin/HEAD"]) ??
    git(worktree, ["merge-base", "HEAD", "@{upstream}"]) ??
    git(worktree, ["rev-parse", "HEAD"]);
  const committed = base ? (git(worktree, ["diff", "--name-only", base, "HEAD"]) ?? "") : "";
  const dirty = (git(worktree, ["status", "--porcelain"]) ?? "").split("\n").map((l) => l.slice(3).split(" -> ").pop());
  return [...new Set([...committed.split("\n"), ...dirty].filter(Boolean))].sort();
}

const repoOf = (worktree) => (worktree && fs.existsSync(worktree) ? path.resolve(worktree, git(worktree, ["rev-parse", "--git-common-dir"]) ?? ".") : worktree);

export function overlaps(rows) {
  const owners = new Map();
  for (const r of rows) for (const f of r.files) {
    const k = `${r.repo}\u0000${f}`;
    owners.set(k, [...(owners.get(k) ?? []), r.label]);
  }
  const out = new Map(rows.map((r) => [r.label, []]));
  for (const [k, labels] of owners) {
    if (labels.length < 2) continue;
    const file = k.split("\u0000")[1];
    for (const l of labels) out.get(l).push(`${file} ← ${labels.filter((x) => x !== l).join(", ")}`);
  }
  return out;
}

export function board(root, live = [], { scope = null, all = false, cwd = process.cwd() } = {}) {
  const p = paths(root);
  fs.mkdirSync(p.tasks, { recursive: true });
  const config = readConfig(p);
  const only = all ? null : (scope ?? scopeOfDir(config, cwd));
  const tagged = readTasks(p).map((t) => ({ t, scope: scopeOfTask(config, t) }));
  const tasks = tagged.filter((x) => !only || x.scope === only).map((x) => x.t);
  const scopes = only ? [only] : [...new Set([DEFAULT_SCOPE, ...Object.keys(config.scopes ?? {}), ...tagged.map((x) => x.scope)])];
  const liveBy = new Map(live.map((s) => [s.sessionId ?? s.id, s]));
  const running = tasks.filter((t) => ["launching", "working", "question", "mergeable"].includes(t.state));
  const rows = running.map((t) => {
    const s = t.session?.id ? liveBy.get(t.session.id) : null;
    return {
      label: t.session?.name ?? t.id,
      id: t.id,
      scope: scopeOfTask(config, t),
      key: t.key,
      state: t.state,
      branch: s?.branch ?? (t.worktree ? git(t.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]) : null),
      pr: t.pr ?? s?.pr ?? null,
      note: t.note ?? null,
      repo: repoOf(t.worktree),
      files: filesTouched(t.worktree),
    };
  });
  const ov = overlaps(rows);
  const queued = (s) => tasks.filter((t) => t.state === "queued" && scopeOfTask(config, t) === s);
  return {
    scope: only,
    slots: scopes.map((s) => ({ scope: s, used: tasks.filter((t) => HOLDS_SLOT.has(t.state) && scopeOfTask(config, t) === s).length, max: maxOf(config, s) })),
    running: rows.map((r) => ({ ...r, repo: undefined, overlap: ov.get(r.label) })),
    queue: scopes.flatMap((s) => queued(s).map((t, i) => ({ scope: s, position: i + 1, id: t.id, key: t.key, title: t.title, by: t.by }))),
  };
}

export function sessionStartContext(root, cwd) {
  const p = paths(root);
  if (!fs.existsSync(p.tasks)) return "";
  const here = real(cwd);
  const mine = readTasks(p).find((t) => t.worktree && ACTIVE.has(t.state) && (here === t.worktree || here.startsWith(t.worktree + path.sep)));
  if (!mine) return "";
  const scope = scopeOfTask(readConfig(p), mine);
  return [`You are fleet task ${mine.id} (${mine.key ?? mine.title}), scope ${scope}, state ${mine.state}. Follow the fleet skill.`, renderBoard(board(root, [], { scope }))].join("\n\n");
}

function renderBoard(b) {
  const one = b.slots.length === 1;
  const lines = [one && b.slots[0].scope === DEFAULT_SCOPE ? `slots ${b.slots[0].used}/${b.slots[0].max}` : `slots ${b.slots.map((s) => `${s.scope} ${s.used}/${s.max}`).join(" · ")}`];
  const scoped = !one;
  const cols = [...(scoped ? ["SCOPE"] : []), "NAME", "TASK", "KEY", "STATE", "BRANCH", "PR", "FILES", "OVERLAP"];
  const rows = b.running.map((r) => [...(scoped ? [r.scope] : []), r.label, r.id, r.key ?? "—", r.state, r.branch ?? "—", r.pr ?? "—", String(r.files.length), r.overlap.length ? r.overlap.join("; ") : "—"]);
  const w = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
  const fmt = (r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join("  ");
  if (rows.length) lines.push(fmt(cols), ...rows.map(fmt));
  else lines.push("no running sessions");
  const notes = b.running.filter((r) => r.note).map((r) => `  ${r.label}: ${r.note}`);
  if (notes.length) lines.push("notes", ...notes);
  lines.push(b.queue.length ? `queue (${b.queue.length})` : "queue empty", ...b.queue.map((q) => `  ${scoped ? `${q.scope} ` : ""}${q.position}. ${q.id} ${q.key ?? ""} ${q.title}`.replace(/\s+/g, " ")));
  return lines.join("\n");
}

function selfTest() {
  const results = [];
  const check = (name, ok) => results.push([name, Boolean(ok)]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-selftest-"));
  try {
    const r1 = path.join(tmp, "pool");
    configure(r1, { max: 2 });
    const a = enqueue(r1, { title: "A", prompt: "a", key: "repo#1", cwd: tmp });
    const b = enqueue(r1, { title: "B", prompt: "b", key: "repo#2", cwd: tmp, notify: "s-dispatch" });
    const c = enqueue(r1, { title: "C", prompt: "c", key: "repo#3", cwd: tmp });
    check("first two tasks launch, the third queues at position 1", a.state === "launching" && b.state === "launching" && c.state === "queued" && c.position === 1);
    let dupRefused = false;
    try { enqueue(r1, { title: "A again", prompt: "a", key: "repo#1", cwd: tmp }); } catch { dupRefused = true; }
    check("an active key cannot be enqueued twice", dupRefused);
    join(r1, a.id, { session: "s-a", name: "alder", worktree: tmp });
    let secondRefused = false;
    try { join(r1, a.id, { session: "s-dup", name: "dup", worktree: tmp }); } catch { secondRefused = true; }
    const rejoined = join(r1, a.id, { session: "s-a", name: "alder", worktree: tmp });
    check("a second session cannot join a task another session holds; the holder can rejoin",
      secondRefused && rejoined.state === "working" && findTask(paths(r1), a.id).session.id === "s-a");
    check("a session starting inside a task's worktree is told which task it is; any other directory gets nothing",
      sessionStartContext(r1, path.join(tmp, "sub")).includes(`fleet task ${a.id}`) && sessionStartContext(r1, os.homedir()) === "");
    const halted = setState(r1, a.id, "question", { note: "which table?" });
    check("a session halting on a question frees its slot and hands back the next launch", halted.launch.length === 1 && halted.launch[0].id === c.id);
    check("the board counts only launching and working against the pool", board(r1, [], { cwd: tmp }).slots[0].used === 2);
    const joinedB = join(r1, b.id, { session: "s-b", name: "birch", worktree: tmp });
    const backToWork = setState(r1, b.id, "working");
    const readyB = setState(r1, b.id, "mergeable", { pr: "1" });
    check("--notify names the enqueuer on join, and a question, mergeable or working names nobody",
      joinedB.notify === "s-dispatch" && readyB.notify === null && backToWork.notify === null && halted.notify === null);
    setState(r1, b.id, "working");
    const taken = join(r1, b.id, { session: "s-new", name: "birch2", worktree: tmp, takeover: true });
    check("--takeover hands a held task to a new session and journals it as a takeover",
      taken.state === "working" && findTask(paths(r1), b.id).session.id === "s-new"
      && readJournal(r1, {}).some((e) => e.id === b.id && e.event === "takeover"));
    const gone = path.join(tmp, "gone");
    fs.mkdirSync(gone);
    join(r1, b.id, { session: "s-new", name: "birch2", worktree: gone });
    fs.rmSync(gone, { recursive: true });
    const swept = sweep(r1, { cwd: tmp });
    check("a task whose worktree is gone is marked lost, and its enqueuer is named for the sweeper to tell",
      swept.changed.some((l) => l.startsWith(b.id)) && findTask(paths(r1), b.id).state === "lost" && swept.notify.some((n) => n.id === b.id && n.session === "s-dispatch"));
    const d = enqueue(r1, { title: "D", prompt: "d", key: "repo#4", cwd: tmp, notify: "s-dispatch" });
    const e = enqueue(r1, { title: "E", prompt: "e", key: "repo#5", cwd: tmp, notify: "s-dispatch" });
    check("done and release name the enqueuer", setState(r1, d.id, "done").notify === "s-dispatch" && release(r1, e.id).notify === "s-dispatch");
    const stale = sweep(r1, { cwd: tmp, now: Date.now() + 31 * 60_000 });
    check("a launch nobody joined within the timeout goes back to the queue and is relaunched", stale.changed.some((l) => l.startsWith(c.id)) && stale.launch.some((t) => t.id === c.id));
    const ov = overlaps([
      { label: "x", repo: "r", files: ["a.ts", "b.ts"] },
      { label: "y", repo: "r", files: ["b.ts"] },
      { label: "z", repo: "other", files: ["b.ts"] },
    ]);
    check("the same file in the same repo is an overlap; another repo is not", ov.get("x").join() === "b.ts ← y" && ov.get("z").length === 0);

    const r4 = path.join(tmp, "journal");
    configure(r4, { max: 5 });
    const elsewhere = path.join(tmp, "elsewhere");
    fs.mkdirSync(elsewhere);
    const P = projectOf(tmp);
    const j1 = enqueue(r4, { title: "J1", prompt: "j", key: "p#1", cwd: tmp, notify: "s-old" });
    join(r4, j1.id, { session: "s-j1", name: "jay", worktree: tmp });
    setState(r4, j1.id, "mergeable", { pr: "7" });
    const j2 = enqueue(r4, { title: "J2", prompt: "j", key: "p#2", cwd: tmp, notify: "s-old" });
    setState(r4, j2.id, "done");
    const j3 = enqueue(r4, { title: "J3", prompt: "j", key: "q#1", cwd: elsewhere, notify: "s-old" });
    check("enqueue, join and every state change land in the day's journal under the task's project",
      readJournal(r4, { project: P }).filter((e) => e.id === j1.id).map((e) => e.event).join() === "enqueue,join,mergeable"
      && readJournal(r4, { project: "elsewhere" }).every((e) => e.id === j3.id));
    record(r4, { project: P, event: "note", note: "three days ago" }, Date.now() - 3 * 86_400_000);
    check("the journal reads only the days asked for",
      !readJournal(r4, { project: P, days: 2 }).some((e) => e.note === "three days ago")
      && readJournal(r4, { project: P, days: 4 }).some((e) => e.note === "three days ago"));
    saveProfile(r4, P, { brief: "the brief", template: "the template" });
    const resumed = resume(r4, { project: P, session: "s-new" });
    check("resume hands over the brief and template and retargets only that project's open tasks",
      resumed.profile.brief === "the brief" && resumed.profile.template === "the template"
      && resumed.retargeted.join() === j1.id
      && findTask(paths(r4), j1.id).notify === "s-new"
      && findTask(paths(r4), j2.id).notify === "s-old"
      && findTask(paths(r4), j3.id).notify === "s-old"
      && resumed.journal.at(-1).event === "resume");

    const r5 = path.join(tmp, "scopes");
    const game = path.join(tmp, "game");
    const core = path.join(tmp, "course", "roblox-core");
    const work = path.join(tmp, "work");
    for (const d of [game, core, work]) fs.mkdirSync(d, { recursive: true });
    configure(r5, { max: 1 });
    const early = enqueue(r5, { title: "early", prompt: "e", key: "game#0", cwd: game, notify: "s-se" });
    check("with no scope configured every task shares one pool", early.scope === "default" && early.state === "launching");
    setState(r5, early.id, "question");
    configure(r5, { scope: "se", projects: ["game"], dirs: [path.join(tmp, "course")], max: 1 });
    check("a task enqueued before its scope existed takes its scope from its project",
      board(r5, [], { scope: "se" }).running.some((r) => r.id === early.id) && !board(r5, [], { scope: "default" }).running.some((r) => r.id === early.id));
    const w1 = enqueue(r5, { title: "w1", prompt: "w", key: "work#1", cwd: work });
    const w2 = enqueue(r5, { title: "w2", prompt: "w", key: "work#2", cwd: work });
    const s1 = enqueue(r5, { title: "s1", prompt: "s", key: "core#1", cwd: core });
    const s2 = enqueue(r5, { title: "s2", prompt: "s", key: "game#2", cwd: game });
    const forced = enqueue(r5, { title: "forced", prompt: "f", key: "work#3", cwd: work, scope: "se" });
    check("each scope fills its own slots: a full default pool does not hold back se, matched by project and by path",
      w1.state === "launching" && w2.state === "queued" && w2.position === 1 && s1.scope === "se" && s1.state === "launching" && s2.state === "queued" && s2.position === 1);
    check("an explicit --scope wins over the project", forced.scope === "se" && forced.position === 2);
    const freedDefault = setState(r5, w1.id, "question");
    check("a halting session launches only its own scope's queue", freedDefault.launch.map((t) => t.id).join() === w2.id);
    check("next for a scope with no free slot launches nothing, and never another scope's task",
      next(r5, { scope: "se" }).launch.length === 0 && next(r5, { cwd: work }).launch.length === 0);
    const freedSe = setState(r5, s1.id, "done");
    check("next and the launch list name the scope", freedSe.launch.map((t) => `${t.id}:${t.scope}`).join() === `${s2.id}:se`);
    const seBoard = board(r5, [], { scope: "se" });
    check("board --scope shows only that scope's sessions, queue and slots",
      seBoard.running.every((r) => r.scope === "se") && seBoard.queue.map((q) => q.id).join() === forced.id
      && seBoard.slots.length === 1 && seBoard.slots[0].used === 1 && seBoard.slots[0].max === 1);
    check("board without --scope shows the scope of the current directory; --all shows every scope",
      board(r5, [], { cwd: core }).running.every((r) => r.scope === "se") && board(r5, [], { all: true }).slots.length === 2);
    note(r5, { project: "game", text: "se note" });
    const seJournal = journal(r5, { scope: "se" });
    check("journal --scope reads every project of the scope and nothing else",
      ["game", "roblox-core"].every((pr) => seJournal.some((e) => e.project === pr)) && seJournal.some((e) => e.note === "se note")
      && seJournal.every((e) => e.project !== "work" || e.id === forced.id));
    const seResume = resume(r5, { scope: "se", session: "s-se2" });
    check("resume --scope retargets only that scope's open tasks",
      seResume.retargeted.includes(early.id) && findTask(paths(r5), w2.id).notify === null);

    const r3 = path.join(tmp, "locked");
    fs.mkdirSync(path.join(r3, "lock"), { recursive: true });
    fs.writeFileSync(path.join(r3, "lock", "pid"), String(process.pid));
    let blocked = false;
    try { withLock(r3, () => {}, { timeoutMs: 150 }); } catch { blocked = true; }
    check("a lock held by a live process blocks a writer", blocked);
    fs.mkdirSync(path.join(r3, "lock"), { recursive: true });
    fs.writeFileSync(path.join(r3, "lock", "pid"), "2147483646");
    check("a lock left by a dead process is taken over", withLock(r3, () => "in", { timeoutMs: 150 }) === "in");

    const r2 = path.join(tmp, "race");
    configure(r2, { max: 50 });
    const script = `import(${JSON.stringify(new URL(import.meta.url).href)}).then(m => { try { m.enqueue(process.argv[1], { title: "race", prompt: "p", key: "repo#9", cwd: process.argv[1] }); console.log("won"); } catch { console.log("lost"); } })`;
    const outs = Array.from({ length: 6 }, () => new Promise((res) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, r2]);
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("close", () => res(out.trim()));
    }));
    return Promise.all(outs).then((o) => {
      check("six concurrent enqueues of one key: exactly one wins", o.filter((x) => x === "won").length === 1);
      return finish(results, tmp);
    });
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

function finish(results, tmp) {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [name, ok] of results) console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}`);
  const bad = results.filter(([, ok]) => !ok).length;
  console.log(bad ? `\n${bad} of ${results.length} failed` : `\n${results.length} self-tests passed`);
  process.exit(bad ? 1 : 0);
}

const argv = process.argv.slice(2);
const opt = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1];
};
const print = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

async function main() {
  const root = home();
  const [cmd, id] = argv;
  switch (cmd) {
    case "enqueue": {
      const promptFile = opt("--prompt-file");
      const prompt = opt("--prompt") ?? (promptFile ? fs.readFileSync(promptFile, "utf8") : null);
      return print(enqueue(root, { title: opt("--title"), prompt, key: opt("--key"), cwd: opt("--cwd") ?? process.cwd(), by: opt("--by"), notify: opt("--notify"), scope: opt("--scope") }));
    }
    case "next": return print(next(root, { scope: opt("--scope") }));
    case "join": return print(join(root, id, { session: opt("--session"), name: opt("--name"), worktree: opt("--worktree") ?? process.cwd(), takeover: argv.includes("--takeover") }));
    case "state": return print(setState(root, id, argv[2], { note: opt("--note"), pr: opt("--pr") }));
    case "release": return print(release(root, id));
    case "sweep": return print(sweep(root, { scope: opt("--scope") }));
    case "config": {
      const list = (flag) => (opt(flag) == null ? null : opt(flag).split(",").map((x) => x.trim()).filter(Boolean));
      return print(configure(root, { max: opt("--max"), launchTimeoutMin: opt("--launch-timeout-min"), scope: opt("--scope"), projects: list("--projects"), dirs: list("--paths"), remove: argv.includes("--remove") }));
    }
    case "board": {
      const live = process.stdin.isTTY ? [] : (() => { const s = fs.readFileSync(0, "utf8").trim(); return s ? JSON.parse(s) : []; })();
      const b = board(root, Array.isArray(live) ? live : live.sessions ?? [], { scope: opt("--scope"), all: argv.includes("--all") });
      return print(argv.includes("--json") ? b : renderBoard(b));
    }
    case "journal": return print(renderJournal(journal(root, { project: opt("--project"), scope: opt("--scope"), days: Number(opt("--days") ?? 2) })));
    case "note": return print(note(root, { project: opt("--project"), text: opt("--text") }));
    case "dispatch": {
      const name = opt("--project") ?? opt("--scope");
      if (id !== "save" || !name) throw new Error("fleet: dispatch save (--project <p> | --scope <s>) [--brief <file>] [--template <file>]");
      const read = (flag) => (opt(flag) ? fs.readFileSync(opt(flag), "utf8") : null);
      return print(saveProfile(root, name, { brief: read("--brief"), template: read("--template") }));
    }
    case "resume": {
      const r = resume(root, { project: opt("--project"), scope: opt("--scope"), session: opt("--session"), days: Number(opt("--days") ?? 2) });
      return print([
        `# dispatcher for ${r.profile.project}`,
        r.retargeted.length ? `retargeted --notify on ${r.retargeted.join(" ")}` : "no open task needed retargeting",
        `## brief (${r.profile.dir}/brief.md)`, r.profile.brief ?? "none saved: fleet dispatch save --project <p> --brief <file>",
        `## template (${r.profile.dir}/template.md)`, r.profile.template ? "saved; read it before writing a task prompt" : "none saved",
        "## journal", renderJournal(r.journal),
        "## board", renderBoard(board(root, [], opt("--scope") ? { scope: opt("--scope") } : {})),
      ].join("\n\n"));
    }
    case "--self-test": return selfTest();
    case "hook-session-start": return print(sessionStartContext(root, process.cwd()));
    default:
      console.log(USAGE);
      process.exit(cmd ? 2 : 0);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  main().catch((e) => {
    console.error(e.message ?? String(e));
    process.exit(1);
  });
}
