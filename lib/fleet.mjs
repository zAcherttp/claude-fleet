#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dayOf, netByProject, projectOf, readJournal, readJournalSince, readProfile, record, renderJournal, renderNet, saveProfile, signed } from "./journal.mjs";

const USAGE = `fleet — a pool of parallel Claude Code sessions, one task each

  enqueue --title <t> (--prompt <p> | --prompt-file <f>) [--key <k>] [--cwd <dir>] [--by <name>] [--notify <session>] [--scope <s>]
          [--after <task id>] [--after-pr <owner/repo#n>]   wait (not counted, not promoted) until that task is done / that PR merged
  next    [--scope <s>] [--for <session>]   sweep, then promote the scope's queued tasks into its free slots; print what to launch
  launch  <id> [--for <session>]        launch this queued task now, past max; nothing else is promoted
  bump    <id>                          move a queued task to the head of its scope's queue
  hold    [--scope <s>] [--note <text>] stop promotion in the scope; the queue stays
  unhold  [--scope <s>] [--for <session>]
  join    <id> --session <id> --name <n> --worktree <dir> [--takeover]   refused while another session holds the task
  state   <id> working|question|mergeable|verifying|done [--note <text>] [--pr <url|n>] [--closed <refs>] [--filed <refs>]
  release <id>                          give the task up without finishing it
  events  [--project <p> | --scope <s>] [--since <cursor>] [--for <session>]   done, released, lost, filed since the cursor; --for also claims that session's pending launches
  prompt  <id>                          the full launch text for a task
  board   [--scope <s> | --all] [--json]   slots, running sessions, overlaps, verifying, waiting, queue, net issues today
  sweep   [--scope <s>] [--for <session>]   release waits, requeue stale launches, mark gone worktrees lost and shared ones stale
  config  [--max <n>] [--launch-timeout-min <n>]
  config  --scope <s> [--projects <a,b>] [--paths <dir,dir>] [--max <n>] [--remove]
  journal [--project <p> | --scope <s>] [--days <n>]  what happened, bucketed by day (default today and yesterday)
  note    --project <p> --text <t>      add a line to the journal: a decision, a hand-off, a blocker
  dispatch save (--project <p> | --scope <s>) [--brief <file>] [--template <file>]   keep what makes a session the dispatcher
  resume  (--project <p> | --scope <s>) [--session <id>] [--days <n>]   brief, template, journal and board; --session retargets --notify
  hook-session-start                    context for a session whose worktree is a fleet task
  --self-test

State lives in $FLEET_HOME (default ~/.fleet). A slot is held while a task is
launching or working; question, mergeable, verifying and done free it.

A promoted task whose enqueuer (--notify) is another session is not handed to
the session that freed the slot: it waits as a pending launch that the enqueuer
claims with \`fleet events --for <its session>\`.

A scope groups projects into one pool with its own slots and queue. A task's
scope is its --scope, else the scope whose --projects names its project or whose
--paths holds its cwd, else "default". Without --scope, next, sweep, hold and
board act on the scope of the current directory.`;

const HOLDS_SLOT = new Set(["launching", "working"]);
const ACTIVE = new Set(["waiting", "queued", "launching", "working", "question", "mergeable", "verifying"]);
const IN_WORKTREE = new Set(["launching", "working", "question", "mergeable"]);
const SESSION_STATES = new Set(["working", "question", "mergeable", "verifying", "done"]);
const NOTIFY_ON = new Set(["done"]);
const EVENT_KINDS = new Set(["done", "released", "lost", "stale", "verifying", "requeued", "unwait", "hold", "unhold"]);
const DEFAULT_SCOPE = "default";
const PR_REF = /^([^/\s#]+\/[^/\s#]+)#(\d+)$/;

export function home(env = process.env) {
  return env.FLEET_HOME || path.join(os.homedir(), ".fleet");
}

const paths = (root) => ({
  root,
  tasks: path.join(root, "tasks"),
  lock: path.join(root, "lock"),
  config: path.join(root, "config.json"),
  cursors: path.join(root, "cursors"),
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
  const defaults = { max: 5, launchTimeoutMin: 30, scopes: {}, holds: {} };
  if (!fs.existsSync(p.config)) return defaults;
  return { ...defaults, ...JSON.parse(fs.readFileSync(p.config, "utf8")) };
}

export function fromMsys(p, platform = process.platform) {
  const m = platform === "win32" && typeof p === "string" ? /^\/([a-zA-Z])(\/.*)?$/.exec(p) : null;
  return m ? `${m[1].toUpperCase()}:${(m[2] ?? "/").replace(/\//g, "\\")}` : p;
}

export function under(dir, prefix, platform = process.platform) {
  const P = platform === "win32" ? path.win32 : path.posix;
  const fold = (x) => (platform === "win32" ? P.normalize(x).replace(/[\\/]+$/, "").toLowerCase() : x);
  const d = fold(dir);
  const f = fold(prefix);
  return d === f || d.startsWith(f + P.sep);
}

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
  let at = path.resolve(fromMsys(p));
  while (!fs.existsSync(at) && path.dirname(at) !== at) {
    rest.unshift(path.basename(at));
    at = path.dirname(at);
  }
  return path.join(fs.realpathSync.native(at), ...rest);
}

const saveTask = (p, t) => writeAtomic(path.join(p.tasks, `${t.id}.json`), { ...t, updatedAt: Date.now() });

function findTask(p, id) {
  const file = path.join(p.tasks, `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`fleet: no task ${id}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export const readTask = (root, id) => findTask(paths(root), id);

function newId(tasks) {
  const n = tasks.reduce((m, t) => Math.max(m, Number(t.id.slice(1)) || 0), 0) + 1;
  return `t${String(n).padStart(3, "0")}`;
}

const queueOrder = (a, b) =>
  (b.bumpedAt ?? 0) - (a.bumpedAt ?? 0) || (a.queuedAt ?? a.createdAt) - (b.queuedAt ?? b.createdAt) || a.id.localeCompare(b.id);
const queueOf = (config, tasks, scope) => tasks.filter((t) => t.state === "queued" && scopeOfTask(config, t) === scope).sort(queueOrder);
const usedIn = (config, tasks, scope) => tasks.filter((t) => HOLDS_SLOT.has(t.state) && scopeOfTask(config, t) === scope).length;

function promotable(p, scope) {
  const config = readConfig(p);
  if (config.holds?.[scope]) return [];
  const tasks = readTasks(p);
  return queueOf(config, tasks, scope).slice(0, Math.max(0, maxOf(config, scope) - usedIn(config, tasks, scope)));
}

const projectOfTask = (t) => t.project ?? projectOf(t.cwd);
const scopeOfTask = (config, t) => t.scope ?? scopeOfProject(config, projectOfTask(t), t.cwd ? real(t.cwd) : null);
const log = (p, t, event, extra = {}) =>
  record(p.root, { project: projectOfTask(t), scope: scopeOfTask(readConfig(p), t), id: t.id, key: t.key, event, ...extra });

const launchView = (config) => (t) => ({ id: t.id, title: t.title, cwd: t.cwd, key: t.key, scope: scopeOfTask(config, t), prompt: t.prompt });

function launchesFor(p, scope, { now = Date.now(), caller = null, keep = null, route = true } = {}) {
  const config = readConfig(p);
  const launch = [];
  const nudge = new Map();
  for (const t of promotable(p, scope)) {
    const toEnqueuer = route && t.id !== keep && t.notify && t.notify !== caller && t.unclaimedBy !== t.notify;
    const next = { ...t, state: "launching", launchedAt: now, pendingFor: toEnqueuer ? t.notify : null, handedTo: toEnqueuer ? null : caller };
    saveTask(p, next);
    log(p, t, "launch", { note: toEnqueuer ? `pending for ${t.notify}` : caller ? `to ${caller}` : null });
    if (toEnqueuer) nudge.set(t.notify, [...(nudge.get(t.notify) ?? []), t.id]);
    else launch.push(launchView(config)(next));
  }
  return { launch, nudge: [...nudge].map(([session, ids]) => ({ session, ids })) };
}

const withNudge = (r, { launch, nudge }) => ({ ...r, launch, ...(nudge.length ? { nudge } : {}) });

export function ghPrState(ref, { env = process.env } = {}) {
  const m = PR_REF.exec(ref ?? "");
  if (!m) return null;
  try {
    const out = execFileSync("gh", ["pr", "view", m[2], "--repo", m[1], "--json", "state", "--jq", ".state"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env, timeout: 15_000 });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function prStatesFor(root, prState, extra = []) {
  const p = paths(root);
  fs.mkdirSync(p.tasks, { recursive: true });
  const refs = new Set([...extra, ...readTasks(p).filter((t) => t.state === "waiting" && t.afterPr).map((t) => t.afterPr)]);
  return new Map([...refs].map((r) => [r, prState(r)]));
}

function releaseWaits(p, prStates, now) {
  const changed = [];
  for (const t of readTasks(p)) {
    if (t.state !== "waiting") continue;
    const dep = t.after && fs.existsSync(path.join(p.tasks, `${t.after}.json`)) ? findTask(p, t.after) : null;
    const pr = t.afterPr ? (prStates.get(t.afterPr) ?? t.afterPrState ?? null) : null;
    const ready = (!t.after || dep?.state === "done") && (!t.afterPr || pr === "MERGED");
    if (ready) {
      saveTask(p, { ...t, state: "queued", queuedAt: now, afterPrState: pr });
      changed.push(`${t.id} waiting → queued (${[t.after && `${t.after} done`, t.afterPr && `${t.afterPr} merged`].filter(Boolean).join(", ")})`);
      log(p, t, "unwait", { note: [t.after, t.afterPr].filter(Boolean).join(" ") });
    } else if (t.afterPr && pr && pr !== t.afterPrState) saveTask(p, { ...t, afterPrState: pr });
  }
  return changed;
}

function sweepIn(p, { now = Date.now(), prStates = new Map() } = {}) {
  const { launchTimeoutMin } = readConfig(p);
  const changed = releaseWaits(p, prStates, now);
  const notify = [];
  const end = (t, state, note) => {
    saveTask(p, { ...t, state });
    changed.push(`${t.id} ${t.state} → ${state} (${note})`);
    log(p, t, state, { note });
    if (t.notify) notify.push({ session: t.notify, id: t.id, key: t.key, state });
  };
  for (const t of readTasks(p)) {
    if (t.state === "launching" && now - (t.launchedAt ?? 0) > launchTimeoutMin * 60_000) {
      saveTask(p, { ...t, state: "queued", launchedAt: null, handedTo: null, pendingFor: null, ...(t.pendingFor ? { unclaimedBy: t.pendingFor } : {}) });
      changed.push(`${t.id} launching → queued (${t.pendingFor ? `never claimed by ${t.pendingFor}` : "never joined"})`);
      log(p, t, "requeued", { note: t.pendingFor ? `never claimed by ${t.pendingFor}` : "never joined" });
    } else if (IN_WORKTREE.has(t.state) && t.worktree && !fs.existsSync(t.worktree)) end(t, "lost", "worktree gone");
  }
  const byWorktree = new Map();
  for (const t of readTasks(p)) if (IN_WORKTREE.has(t.state) && t.worktree) byWorktree.set(t.worktree, [...(byWorktree.get(t.worktree) ?? []), t]);
  for (const shared of byWorktree.values()) {
    if (shared.length < 2) continue;
    const [newest, ...older] = shared.sort((a, b) => (b.joinedAt ?? 0) - (a.joinedAt ?? 0));
    for (const t of older) end(t, "stale", `worktree now held by ${newest.id}`);
  }
  return { changed, notify };
}

const swept = (s) => (s.changed.length ? { swept: s } : {});

export function enqueue(root, { title, prompt, key = null, cwd = process.cwd(), by = null, notify = null, scope = null, after = null, afterPr = null, now = Date.now(), prState = ghPrState }) {
  if (!title || !prompt) throw new Error("fleet: enqueue needs --title and a prompt");
  if (afterPr && !PR_REF.test(afterPr)) throw new Error("fleet: --after-pr takes <owner/repo#n>");
  const prStates = prStatesFor(root, prState, afterPr ? [afterPr] : []);
  return withLock(root, (p) => {
    const tasks = readTasks(p);
    const dup = key && tasks.find((t) => t.key === key && ACTIVE.has(t.state));
    if (dup) throw new Error(`fleet: ${key} is already ${dup.state} as ${dup.id}${dup.session?.name ? ` (${dup.session.name})` : ""}`);
    if (after) findTask(p, after);
    const waits = after || afterPr ? { after, afterPr } : {};
    const task = { id: newId(tasks), key, title, prompt, cwd: path.resolve(cwd), project: projectOf(cwd), ...(scope ? { scope } : {}), by, notify, ...waits, state: after || afterPr ? "waiting" : "queued", createdAt: now, queuedAt: now };
    saveTask(p, task);
    log(p, task, "enqueue", { note: [title, after && `after ${after}`, afterPr && `after ${afterPr}`].filter(Boolean).join(" · ") });
    const s = sweepIn(p, { now, prStates });
    const config = readConfig(p);
    const mine = scopeOfTask(config, task);
    const routed = launchesFor(p, mine, { now, keep: task.id });
    const latest = findTask(p, task.id);
    const position = queueOf(config, readTasks(p), mine).findIndex((t) => t.id === task.id);
    return withNudge({ id: task.id, scope: mine, state: latest.state, position: position === -1 ? null : position + 1, ...swept(s) }, routed);
  });
}

export function next(root, { scope = null, cwd = process.cwd(), caller = null, now = Date.now(), prState = ghPrState } = {}) {
  const prStates = prStatesFor(root, prState);
  return withLock(root, (p) => {
    const s = sweepIn(p, { now, prStates });
    const sc = scope ?? scopeOfDir(readConfig(p), cwd);
    return { scope: sc, launch: launchesFor(p, sc, { now, caller, route: false }).launch, ...swept(s) };
  });
}

export function launch(root, id, { caller = null, now = Date.now() } = {}) {
  return withLock(root, (p) => {
    const t = findTask(p, id);
    const claiming = t.state === "launching" && t.pendingFor;
    if (t.state !== "queued" && !claiming) throw new Error(`fleet: ${id} is ${t.state}; launch takes a queued task or a pending launch`);
    const config = readConfig(p);
    const scope = scopeOfTask(config, t);
    const used = usedIn(config, readTasks(p), scope) + (claiming ? 0 : 1);
    const max = maxOf(config, scope);
    const next = { ...t, state: "launching", launchedAt: now, pendingFor: null, handedTo: caller };
    saveTask(p, next);
    log(p, t, "launch", { note: claiming ? `claimed by ${caller ?? "hand"}` : `override ${used}/${max}${caller ? ` to ${caller}` : ""}` });
    return { id, scope, used, max, launch: [launchView(config)(next)] };
  });
}

export function bump(root, id, { now = Date.now() } = {}) {
  return withLock(root, (p) => {
    const t = findTask(p, id);
    if (t.state !== "queued") throw new Error(`fleet: ${id} is ${t.state}; only a queued task can be bumped`);
    saveTask(p, { ...t, bumpedAt: now });
    log(p, t, "bump");
    const config = readConfig(p);
    const scope = scopeOfTask(config, t);
    return { id, scope, position: queueOf(config, readTasks(p), scope).findIndex((x) => x.id === id) + 1 };
  });
}

export function hold(root, { scope = null, cwd = process.cwd(), note = null, on = true, caller = null, now = Date.now() } = {}) {
  return withLock(root, (p) => {
    const c = readConfig(p);
    const s = scope ?? scopeOfDir(c, cwd);
    const holds = { ...c.holds };
    if (on) holds[s] = { note, at: now };
    else delete holds[s];
    writeAtomic(p.config, { ...c, holds });
    record(p.root, { project: null, scope: s, event: on ? "hold" : "unhold", note }, now);
    return on ? { scope: s, held: true, note } : withNudge({ scope: s, held: false }, launchesFor(p, s, { now, caller }));
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
    saveTask(p, { ...t, state: "working", pendingFor: null, session: { id: session ?? null, name: name ?? null }, worktree: wt, joinedAt: Date.now() });
    log(p, t, holder && holder !== session ? "takeover" : "join", { note: name ?? null });
    return { id, state: "working", notify: t.notify ?? null };
  });
}

const refList = (v) => (v == null ? [] : (Array.isArray(v) ? v : String(v).split(",")).map((x) => x.trim()).filter(Boolean));
const union = (a, b) => [...new Set([...(a ?? []), ...b])];

export function setState(root, id, state, { note = null, pr = null, closed = null, filed = null, now = Date.now() } = {}) {
  if (!SESSION_STATES.has(state)) throw new Error(`fleet: state must be one of ${[...SESSION_STATES].join("|")}`);
  const c = refList(closed);
  const f = refList(filed);
  return withLock(root, (p) => {
    const t = findTask(p, id);
    const net = c.length || f.length ? { closed: union(t.closed, c), filed: union(t.filed, f) } : {};
    saveTask(p, { ...t, state, note: note ?? t.note ?? null, pr: pr ?? t.pr ?? null, ...net });
    log(p, t, state, { pr: pr ?? null, note: note ?? null, ...(c.length ? { closed: c } : {}), ...(f.length ? { filed: f } : {}) });
    if (state === "done") releaseWaits(p, new Map(), now);
    const routed = launchesFor(p, scopeOfTask(readConfig(p), t), { now, caller: t.session?.id ?? null });
    return withNudge({ id, state, notify: NOTIFY_ON.has(state) ? (t.notify ?? null) : null, ...net }, routed);
  });
}

export function release(root, id, { now = Date.now() } = {}) {
  return withLock(root, (p) => {
    const t = findTask(p, id);
    saveTask(p, { ...t, state: "released" });
    log(p, t, "released");
    const routed = launchesFor(p, scopeOfTask(readConfig(p), t), { now, caller: t.session?.id ?? null });
    return withNudge({ id, state: "released", notify: t.notify ?? null }, routed);
  });
}

export function sweep(root, { scope = null, cwd = process.cwd(), caller = null, now = Date.now(), prState = ghPrState } = {}) {
  const prStates = prStatesFor(root, prState);
  return withLock(root, (p) => {
    const { changed, notify } = sweepIn(p, { now, prStates });
    const s = scope ?? scopeOfDir(readConfig(p), cwd);
    return withNudge({ changed, notify, scope: s }, launchesFor(p, s, { now, caller }));
  });
}

const cursorFile = (p, session) => path.join(p.cursors, `${String(session).replace(/[^\w.-]/g, "_")}.json`);

export function events(root, { project = null, scope = null, since = null, caller = null, now = Date.now() } = {}) {
  if (project && scope) throw new Error("fleet: events takes --project or --scope, not both");
  return withLock(root, (p) => {
    const config = readConfig(p);
    const filter = project ? `project:${project}` : scope ? `scope:${scope}` : "all";
    const stored = caller && fs.existsSync(cursorFile(p, caller)) ? JSON.parse(fs.readFileSync(cursorFile(p, caller), "utf8")) : {};
    const from = since ?? stored[filter] ?? `${dayOf(now)}:0`;
    const { entries, cursor } = readJournalSince(root, from);
    const picked = entries
      .filter((e) => EVENT_KINDS.has(e.event) || e.filed?.length || e.closed?.length)
      .filter((e) => (project ? e.project === project : scope ? (e.scope ?? scopeOfProject(config, e.project)) === scope : true));
    const launch = [];
    if (caller) {
      for (const t of readTasks(p).filter((x) => x.state === "launching" && x.pendingFor === caller)) {
        const claimed = { ...t, pendingFor: null, handedTo: caller, launchedAt: now };
        saveTask(p, claimed);
        log(p, t, "launch", { note: `claimed by ${caller}` });
        launch.push(launchView(config)(claimed));
      }
      fs.mkdirSync(p.cursors, { recursive: true });
      writeAtomic(cursorFile(p, caller), { ...stored, [filter]: cursor });
    }
    return { since: from, cursor, events: picked, launch };
  });
}

export function launchText(t) {
  return `You are fleet task ${t.id} (${t.key ?? t.title}). Your first command: fleet join ${t.id} --session <your session id> --name <your session name> --worktree "$PWD"
Then follow the fleet skill for the whole task.

${t.prompt}`;
}

export function prompt(root, id) {
  return launchText(findTask(paths(root), id));
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
          saveTask(p, { ...t, notify: session, ...(t.pendingFor ? { pendingFor: session } : {}) });
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

const netOfTask = (t) => (t.filed?.length ?? 0) - (t.closed?.length ?? 0);

export function board(root, live = [], { scope = null, all = false, cwd = process.cwd(), now = Date.now() } = {}) {
  const p = paths(root);
  fs.mkdirSync(p.tasks, { recursive: true });
  const config = readConfig(p);
  const only = all ? null : (scope ?? scopeOfDir(config, cwd));
  const tagged = readTasks(p).map((t) => ({ t, scope: scopeOfTask(config, t) }));
  const tasks = tagged.filter((x) => !only || x.scope === only).map((x) => x.t);
  const scopes = only ? [only] : [...new Set([DEFAULT_SCOPE, ...Object.keys(config.scopes ?? {}), ...tagged.map((x) => x.scope)])];
  const liveBy = new Map(live.map((s) => [s.sessionId ?? s.id, s]));
  const running = tasks.filter((t) => IN_WORKTREE.has(t.state));
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
      net: netOfTask(t),
      ...(t.pendingFor ? { pendingFor: t.pendingFor } : {}),
      repo: repoOf(t.worktree),
      files: filesTouched(t.worktree),
    };
  });
  const ov = overlaps(rows);
  const stateOf = (id) => (fs.existsSync(path.join(p.tasks, `${id}.json`)) ? findTask(p, id).state : "missing");
  const today = journal(root, { days: 1, now }).filter((e) => !only || e.scope === only);
  return {
    scope: only,
    slots: scopes.map((s) => ({ scope: s, used: usedIn(config, tasks, s), max: maxOf(config, s), ...(config.holds?.[s] ? { held: config.holds[s] } : {}) })),
    running: rows.map((r) => ({ ...r, repo: undefined, overlap: ov.get(r.label) })),
    verifying: tasks.filter((t) => t.state === "verifying").map((t) => ({ scope: scopeOfTask(config, t), id: t.id, key: t.key, pr: t.pr ?? null, note: t.note ?? null })),
    waiting: tasks.filter((t) => t.state === "waiting").map((t) => ({
      scope: scopeOfTask(config, t), id: t.id, key: t.key, title: t.title,
      after: [t.after && `${t.after} (${stateOf(t.after)})`, t.afterPr && `${t.afterPr} (${t.afterPrState ?? "unchecked"})`].filter(Boolean),
    })),
    queue: scopes.flatMap((s) => queueOf(config, tasks, s).map((t, i) => ({ scope: s, position: i + 1, id: t.id, key: t.key, title: t.title, by: t.by }))),
    net: netByProject(today),
  };
}

export function sessionStartContext(root, cwd) {
  const p = paths(root);
  if (!fs.existsSync(p.tasks)) return "";
  const here = real(cwd);
  const mine = readTasks(p).find((t) => t.worktree && ACTIVE.has(t.state) && under(here, t.worktree));
  if (!mine) return "";
  const scope = scopeOfTask(readConfig(p), mine);
  const enqueuer = mine.notify
    ? `Your enqueuer is session ${mine.notify}: message it by that id. A session missing from ListAgents is not offline, and a send that lands in its inbox is delivered.`
    : null;
  return [`You are fleet task ${mine.id} (${mine.key ?? mine.title}), scope ${scope}, state ${mine.state}. Follow the fleet skill.`, enqueuer, renderBoard(board(root, [], { scope }))].filter(Boolean).join("\n\n");
}

export function renderBoard(b) {
  const one = b.slots.length === 1;
  const held = (s) => (s.held ? ` HELD${s.held.note ? ` (${s.held.note})` : ""}` : "");
  const lines = [one && b.slots[0].scope === DEFAULT_SCOPE ? `slots ${b.slots[0].used}/${b.slots[0].max}${held(b.slots[0])}` : `slots ${b.slots.map((s) => `${s.scope} ${s.used}/${s.max}${held(s)}`).join(" · ")}`];
  const scoped = !one;
  const cols = [...(scoped ? ["SCOPE"] : []), "NAME", "TASK", "KEY", "STATE", "BRANCH", "PR", "NET", "FILES", "OVERLAP"];
  const rows = b.running.map((r) => [...(scoped ? [r.scope] : []), r.label, r.id, r.key ?? "—", r.pendingFor ? "pending" : r.state, r.branch ?? "—", r.pr ?? "—", r.net ? signed(r.net) : "—", String(r.files.length), r.overlap.length ? r.overlap.join("; ") : "—"]);
  const w = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
  const fmt = (r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join("  ");
  if (rows.length) lines.push(fmt(cols), ...rows.map(fmt));
  else lines.push("no running sessions");
  const notes = b.running.filter((r) => r.note).map((r) => `  ${r.label}: ${r.note}`);
  if (notes.length) lines.push("notes", ...notes);
  const pre = (x) => (scoped ? `${x.scope} ` : "");
  const item = (s) => `  ${s.replace(/\s+/g, " ").trim()}`;
  if (b.verifying?.length) lines.push(`verifying (${b.verifying.length})`, ...b.verifying.map((v) => item(`${pre(v)}${v.id} ${v.key ?? ""} ${v.pr ? `PR ${v.pr} ` : ""}${v.note ? `— ${v.note}` : ""}`)));
  if (b.waiting?.length) lines.push(`waiting (${b.waiting.length})`, ...b.waiting.map((x) => item(`${pre(x)}${x.id} ${x.key ?? ""} ${x.title} — after ${x.after.join(", ")}`)));
  lines.push(b.queue.length ? `queue (${b.queue.length})` : "queue empty", ...b.queue.map((q) => item(`${pre(q)}${q.position}. ${q.id} ${q.key ?? ""} ${q.title}`)));
  if (b.net?.length) lines.push("net issues today", ...renderNet(b.net).map((l) => `  ${l}`));
  return lines.join("\n");
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
  const caller = opt("--for");
  switch (cmd) {
    case "enqueue": {
      const promptFile = opt("--prompt-file");
      const prompt = opt("--prompt") ?? (promptFile ? fs.readFileSync(promptFile, "utf8") : null);
      return print(enqueue(root, { title: opt("--title"), prompt, key: opt("--key"), cwd: opt("--cwd") ?? process.cwd(), by: opt("--by"), notify: opt("--notify"), scope: opt("--scope"), after: opt("--after"), afterPr: opt("--after-pr") }));
    }
    case "next": return print(next(root, { scope: opt("--scope"), caller }));
    case "launch": return print(launch(root, id, { caller }));
    case "bump": return print(bump(root, id));
    case "hold": return print(hold(root, { scope: opt("--scope"), note: opt("--note") }));
    case "unhold": return print(hold(root, { scope: opt("--scope"), on: false, caller }));
    case "join": return print(join(root, id, { session: opt("--session"), name: opt("--name"), worktree: opt("--worktree") ?? process.cwd(), takeover: argv.includes("--takeover") }));
    case "state": return print(setState(root, id, argv[2], { note: opt("--note"), pr: opt("--pr"), closed: opt("--closed"), filed: opt("--filed") }));
    case "release": return print(release(root, id));
    case "events": return print(events(root, { project: opt("--project"), scope: opt("--scope"), since: opt("--since"), caller }));
    case "prompt": return print(prompt(root, id));
    case "sweep": return print(sweep(root, { scope: opt("--scope"), caller }));
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
    case "--self-test": return (await import("./self-test.mjs")).selfTest();
    case "hook-session-start": return print(sessionStartContext(root, process.cwd()));
    default:
      console.log(USAGE);
      process.exit(cmd ? 2 : 0);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(e.message ?? String(e));
    process.exit(1);
  });
}
