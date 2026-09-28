#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const USAGE = `fleet — a pool of parallel Claude Code sessions, one task each

  enqueue --title <t> (--prompt <p> | --prompt-file <f>) [--key <k>] [--cwd <dir>] [--by <name>] [--notify <session>]
  next                                  promote queued tasks into free slots; print what to launch
  join    <id> --session <id> --name <n> --worktree <dir>
  state   <id> working|question|mergeable|done [--note <text>] [--pr <url|n>]
  release <id>                          give the task up without finishing it
  board   [--json]                      slots, running sessions, overlaps, queue
  sweep                                 requeue stale launches, free tasks whose worktree is gone
  config  [--max <n>] [--launch-timeout-min <n>]
  hook-session-start                    context for a session whose worktree is a fleet task
  --self-test

State lives in $FLEET_HOME (default ~/.fleet). A slot is held while a task is
launching or working; question, mergeable and done free it.`;

const HOLDS_SLOT = new Set(["launching", "working"]);
const ACTIVE = new Set(["queued", "launching", "working", "question", "mergeable"]);
const SESSION_STATES = new Set(["working", "question", "mergeable", "done"]);
const HALTS = new Set(["question", "mergeable", "done"]);

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
  const defaults = { max: 5, launchTimeoutMin: 30 };
  if (!fs.existsSync(p.config)) return defaults;
  return { ...defaults, ...JSON.parse(fs.readFileSync(p.config, "utf8")) };
}

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

function promote(p, now = Date.now()) {
  const { max } = readConfig(p);
  const tasks = readTasks(p);
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

const launchView = (t) => ({ id: t.id, title: t.title, cwd: t.cwd, key: t.key, prompt: t.prompt });

export function enqueue(root, { title, prompt, key = null, cwd = process.cwd(), by = null, notify = null }) {
  if (!title || !prompt) throw new Error("fleet: enqueue needs --title and a prompt");
  return withLock(root, (p) => {
    const tasks = readTasks(p);
    const dup = key && tasks.find((t) => t.key === key && ACTIVE.has(t.state));
    if (dup) throw new Error(`fleet: ${key} is already ${dup.state} as ${dup.id}${dup.session?.name ? ` (${dup.session.name})` : ""}`);
    const now = Date.now();
    const task = { id: newId(tasks), key, title, prompt, cwd: path.resolve(cwd), by, notify, state: "queued", createdAt: now };
    saveTask(p, task);
    const launch = promote(p, now);
    const position = readTasks(p).filter((t) => t.state === "queued").findIndex((t) => t.id === task.id);
    return { id: task.id, state: launch.some((t) => t.id === task.id) ? "launching" : "queued", position: position === -1 ? null : position + 1, launch: launch.map(launchView) };
  });
}

export function next(root) {
  return withLock(root, (p) => ({ launch: promote(p).map(launchView) }));
}

export function join(root, id, { session, name, worktree }) {
  return withLock(root, (p) => {
    const t = findTask(p, id);
    if (!["launching", "working", "question"].includes(t.state)) throw new Error(`fleet: ${id} is ${t.state}, not joinable`);
    const wt = worktree ? real(worktree) : null;
    saveTask(p, { ...t, state: "working", session: { id: session ?? null, name: name ?? null }, worktree: wt, joinedAt: Date.now() });
    return { id, state: "working", notify: t.notify ?? null };
  });
}

export function setState(root, id, state, { note = null, pr = null } = {}) {
  if (!SESSION_STATES.has(state)) throw new Error(`fleet: state must be one of ${[...SESSION_STATES].join("|")}`);
  return withLock(root, (p) => {
    const t = findTask(p, id);
    saveTask(p, { ...t, state, note: note ?? t.note ?? null, pr: pr ?? t.pr ?? null });
    return { id, state, notify: HALTS.has(state) ? (t.notify ?? null) : null, launch: promote(p).map(launchView) };
  });
}

export function release(root, id) {
  return withLock(root, (p) => {
    const t = findTask(p, id);
    saveTask(p, { ...t, state: "released" });
    return { id, state: "released", launch: promote(p).map(launchView) };
  });
}

export function sweep(root, now = Date.now()) {
  return withLock(root, (p) => {
    const { launchTimeoutMin } = readConfig(p);
    const changed = [];
    for (const t of readTasks(p)) {
      if (t.state === "launching" && now - (t.launchedAt ?? 0) > launchTimeoutMin * 60_000) {
        saveTask(p, { ...t, state: "queued", launchedAt: null });
        changed.push(`${t.id} launching → queued (never joined)`);
      } else if (ACTIVE.has(t.state) && t.worktree && !fs.existsSync(t.worktree)) {
        saveTask(p, { ...t, state: "lost" });
        changed.push(`${t.id} ${t.state} → lost (worktree gone)`);
      }
    }
    return { changed, launch: promote(p, now).map(launchView) };
  });
}

export function configure(root, { max, launchTimeoutMin }) {
  return withLock(root, (p) => {
    const c = readConfig(p);
    if (max != null) c.max = Math.max(1, Number(max));
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

export function board(root, live = []) {
  const p = paths(root);
  fs.mkdirSync(p.tasks, { recursive: true });
  const { max } = readConfig(p);
  const tasks = readTasks(p);
  const liveBy = new Map(live.map((s) => [s.sessionId ?? s.id, s]));
  const running = tasks.filter((t) => ["launching", "working", "question", "mergeable"].includes(t.state));
  const rows = running.map((t) => {
    const s = t.session?.id ? liveBy.get(t.session.id) : null;
    return {
      label: t.session?.name ?? t.id,
      id: t.id,
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
  return {
    slots: { used: tasks.filter((t) => HOLDS_SLOT.has(t.state)).length, max },
    running: rows.map((r) => ({ ...r, repo: undefined, overlap: ov.get(r.label) })),
    queue: tasks.filter((t) => t.state === "queued").map((t, i) => ({ position: i + 1, id: t.id, key: t.key, title: t.title, by: t.by })),
  };
}

export function sessionStartContext(root, cwd) {
  const p = paths(root);
  if (!fs.existsSync(p.tasks)) return "";
  const here = real(cwd);
  const mine = readTasks(p).find((t) => t.worktree && ACTIVE.has(t.state) && (here === t.worktree || here.startsWith(t.worktree + path.sep)));
  if (!mine) return "";
  return [`You are fleet task ${mine.id} (${mine.key ?? mine.title}), state ${mine.state}. Follow the fleet skill.`, renderBoard(board(root))].join("\n\n");
}

function renderBoard(b) {
  const lines = [`slots ${b.slots.used}/${b.slots.max}`];
  const cols = ["NAME", "TASK", "KEY", "STATE", "BRANCH", "PR", "FILES", "OVERLAP"];
  const rows = b.running.map((r) => [r.label, r.id, r.key ?? "—", r.state, r.branch ?? "—", r.pr ?? "—", String(r.files.length), r.overlap.length ? r.overlap.join("; ") : "—"]);
  const w = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
  const fmt = (r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join("  ");
  if (rows.length) lines.push(fmt(cols), ...rows.map(fmt));
  else lines.push("no running sessions");
  const notes = b.running.filter((r) => r.note).map((r) => `  ${r.label}: ${r.note}`);
  if (notes.length) lines.push("notes", ...notes);
  lines.push(b.queue.length ? `queue (${b.queue.length})` : "queue empty", ...b.queue.map((q) => `  ${q.position}. ${q.id} ${q.key ?? ""} ${q.title}`.replace(/\s+/g, " ")));
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
    check("a session starting inside a task's worktree is told which task it is; any other directory gets nothing",
      sessionStartContext(r1, path.join(tmp, "sub")).includes(`fleet task ${a.id}`) && sessionStartContext(r1, os.homedir()) === "");
    const halted = setState(r1, a.id, "question", { note: "which table?" });
    check("a session halting on a question frees its slot and hands back the next launch", halted.launch.length === 1 && halted.launch[0].id === c.id);
    check("the board counts only launching and working against the pool", board(r1).slots.used === 2);
    const joinedB = join(r1, b.id, { session: "s-b", name: "birch", worktree: tmp });
    const backToWork = setState(r1, b.id, "working");
    const readyB = setState(r1, b.id, "mergeable", { pr: "1" });
    check("a task enqueued with --notify names the enqueuer on join and on every halt, and on nothing else",
      joinedB.notify === "s-dispatch" && readyB.notify === "s-dispatch" && backToWork.notify === null && halted.notify === null);
    setState(r1, b.id, "working");
    const gone = path.join(tmp, "gone");
    fs.mkdirSync(gone);
    join(r1, b.id, { session: "s-b", name: "birch", worktree: gone });
    fs.rmSync(gone, { recursive: true });
    const swept = sweep(r1);
    check("a task whose worktree is gone is marked lost", swept.changed.some((l) => l.startsWith(b.id)) && findTask(paths(r1), b.id).state === "lost");
    const stale = sweep(r1, Date.now() + 31 * 60_000);
    check("a launch nobody joined within the timeout goes back to the queue and is relaunched", stale.changed.some((l) => l.startsWith(c.id)) && stale.launch.some((t) => t.id === c.id));
    const ov = overlaps([
      { label: "x", repo: "r", files: ["a.ts", "b.ts"] },
      { label: "y", repo: "r", files: ["b.ts"] },
      { label: "z", repo: "other", files: ["b.ts"] },
    ]);
    check("the same file in the same repo is an overlap; another repo is not", ov.get("x").join() === "b.ts ← y" && ov.get("z").length === 0);

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
      return print(enqueue(root, { title: opt("--title"), prompt, key: opt("--key"), cwd: opt("--cwd") ?? process.cwd(), by: opt("--by"), notify: opt("--notify") }));
    }
    case "next": return print(next(root));
    case "join": return print(join(root, id, { session: opt("--session"), name: opt("--name"), worktree: opt("--worktree") ?? process.cwd() }));
    case "state": return print(setState(root, id, argv[2], { note: opt("--note"), pr: opt("--pr") }));
    case "release": return print(release(root, id));
    case "sweep": return print(sweep(root));
    case "config": return print(configure(root, { max: opt("--max"), launchTimeoutMin: opt("--launch-timeout-min") }));
    case "board": {
      const live = process.stdin.isTTY ? [] : (() => { const s = fs.readFileSync(0, "utf8").trim(); return s ? JSON.parse(s) : []; })();
      const b = board(root, Array.isArray(live) ? live : live.sessions ?? []);
      return print(argv.includes("--json") ? b : renderBoard(b));
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
