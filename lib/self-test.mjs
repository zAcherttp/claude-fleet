import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { board, bump, configure, enqueue, events, ghPrState, hold, join, journal, launch, next, note, overlaps, prompt, readTask, release, renderBoard, resume, sessionStartContext, setState, sweep, withLock } from "./fleet.mjs";
import { projectOf, readJournal, record, renderJournal, saveProfile } from "./journal.mjs";

export function selfTest() {
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
      secondRefused && rejoined.state === "working" && readTask(r1, a.id).session.id === "s-a");
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
      taken.state === "working" && readTask(r1, b.id).session.id === "s-new"
      && readJournal(r1, {}).some((e) => e.id === b.id && e.event === "takeover"));
    const gone = path.join(tmp, "gone");
    fs.mkdirSync(gone);
    join(r1, b.id, { session: "s-new", name: "birch2", worktree: gone });
    fs.rmSync(gone, { recursive: true });
    const swept = sweep(r1, { cwd: tmp });
    check("a task whose worktree is gone is marked lost, and its enqueuer is named for the sweeper to tell",
      swept.changed.some((l) => l.startsWith(b.id)) && readTask(r1, b.id).state === "lost" && swept.notify.some((n) => n.id === b.id && n.session === "s-dispatch"));
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
    check("enqueue, launch, join and every state change land in the day's journal under the task's project",
      readJournal(r4, { project: P }).filter((e) => e.id === j1.id).map((e) => e.event).join() === "enqueue,launch,join,mergeable"
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
      && readTask(r4, j1.id).notify === "s-new"
      && readTask(r4, j2.id).notify === "s-old"
      && readTask(r4, j3.id).notify === "s-old"
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
      seResume.retargeted.includes(early.id) && readTask(r5, w2.id).notify === null);

    const dir = (name) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); return d; };
    const tick = () => { const t0 = Date.now(); while (Date.now() === t0); };
    const ids = (list) => (list ?? []).map((t) => t.id).join();
    const noGh = () => null;

    const r6 = path.join(tmp, "route");
    configure(r6, { max: 1 });
    const x = enqueue(r6, { title: "X", prompt: "x", key: "r#1", cwd: tmp });
    join(r6, x.id, { session: "s-x", name: "ex", worktree: dir("wx") });
    const y = enqueue(r6, { title: "Y", prompt: "y", key: "r#2", cwd: tmp, notify: "s-enq" });
    const halt = setState(r6, x.id, "question");
    check("a halting session is not handed a task that has an enqueuer: it waits as a pending launch and the result names whom to nudge",
      halt.launch.length === 0 && halt.nudge?.[0].session === "s-enq" && halt.nudge[0].ids.join() === y.id
      && readTask(r6, y.id).state === "launching" && readTask(r6, y.id).pendingFor === "s-enq");
    const claimed = events(r6, { caller: "s-enq" });
    const again = events(r6, { caller: "s-enq" });
    check("the enqueuer claims its pending launch through events --for, exactly once",
      ids(claimed.launch) === y.id && again.launch.length === 0 && readTask(r6, y.id).handedTo === "s-enq" && !readTask(r6, y.id).pendingFor);
    const z = enqueue(r6, { title: "Z", prompt: "z", key: "r#3", cwd: tmp, notify: "s-gone" });
    join(r6, y.id, { session: "s-y", name: "why", worktree: dir("wy") });
    setState(r6, y.id, "question");
    const orphan = sweep(r6, { cwd: tmp, now: Date.now() + 31 * 60_000 });
    check("a pending launch its enqueuer never claims is requeued and then handed to whoever frees or sweeps the slot",
      orphan.changed.some((l) => l.startsWith(`${z.id} launching → queued (never claimed`)) && orphan.launch.some((t) => t.id === z.id));

    const r7 = path.join(tmp, "override");
    configure(r7, { max: 1 });
    const k1 = enqueue(r7, { title: "k1", prompt: "k", key: "k#1", cwd: tmp });
    const k2 = enqueue(r7, { title: "k2", prompt: "k", key: "k#2", cwd: tmp });
    const k3 = enqueue(r7, { title: "k3", prompt: "k", key: "k#3", cwd: tmp });
    const forcedL = launch(r7, k3.id, { caller: "s-d" });
    check("launch <id> starts that queued task past max, journals the override, and promotes nothing else",
      ids(forcedL.launch) === k3.id && forcedL.used === 2 && forcedL.max === 1 && readTask(r7, k2.id).state === "queued"
      && journal(r7, {}).some((e) => e.id === k3.id && e.event === "launch" && e.note.startsWith("override 2/1")));
    const k4 = enqueue(r7, { title: "k4", prompt: "k", key: "k#4", cwd: tmp });
    const bumped = bump(r7, k4.id);
    const queueAfterBump = board(r7, [], { cwd: tmp }).queue.map((q) => q.id).join();
    setState(r7, k1.id, "done");
    check("bump moves a queued task to the head of its scope's queue and the next free slot takes it",
      bumped.position === 1 && queueAfterBump === `${k4.id},${k2.id}` && ids(setState(r7, k3.id, "done").launch) === k4.id);

    const r8 = path.join(tmp, "hold");
    configure(r8, { max: 2 });
    const h1 = enqueue(r8, { title: "h1", prompt: "h", key: "h#1", cwd: tmp });
    hold(r8, { cwd: tmp, note: "until the three finish" });
    const h2 = enqueue(r8, { title: "h2", prompt: "h", key: "h#2", cwd: tmp });
    const heldBoard = board(r8, [], { cwd: tmp });
    check("hold stops promotion in its scope, keeps the queue, and the board shows HELD",
      h2.state === "queued" && setState(r8, h1.id, "done").launch.length === 0 && heldBoard.queue.length === 1
      && renderBoard(heldBoard).startsWith("slots 1/2 HELD (until the three finish)"));
    const unheld = hold(r8, { cwd: tmp, on: false });
    check("unhold resumes promotion and hands back what it launched", ids(unheld.launch) === h2.id && !board(r8, [], { cwd: tmp }).slots[0].held);
    const a1 = enqueue(r8, { title: "a1", prompt: "a", key: "h#3", cwd: tmp, after: h2.id });
    const waitBoard = board(r8, [], { cwd: tmp });
    check("--after waits: not counted, not promoted while a slot is free, shown under waiting with its dependency",
      a1.state === "waiting" && next(r8, { cwd: tmp, prState: noGh }).launch.length === 0 && waitBoard.slots[0].used === 1
      && waitBoard.waiting.map((w) => `${w.id} ${w.after}`).join() === `${a1.id} ${h2.id} (launching)`);
    check("when the task it waits on is done it joins the queue, and that done launches it", ids(setState(r8, h2.id, "done").launch) === a1.id);
    let pr = "OPEN";
    const stub = () => pr;
    const p1 = enqueue(r8, { title: "p1", prompt: "p", key: "h#4", cwd: tmp, afterPr: "o/r#12", prState: stub });
    const stillOpen = next(r8, { cwd: tmp, prState: stub });
    pr = "MERGED";
    const merged = next(r8, { cwd: tmp, prState: stub });
    check("--after-pr waits while the PR is open and joins the queue once it has merged",
      p1.state === "waiting" && stillOpen.launch.length === 0 && ids(merged.launch) === p1.id && readTask(r8, p1.id).afterPrState === "MERGED");
    let badRef = false;
    try { enqueue(r8, { title: "bad", prompt: "b", key: "h#5", cwd: tmp, afterPr: "not-a-pr", prState: stub }); } catch { badRef = true; }
    check("with gh missing the PR check answers nothing instead of failing, and a malformed ref is refused",
      ghPrState("o/r#1", { env: { PATH: "" } }) === null && badRef);

    const r9 = path.join(tmp, "events");
    configure(r9, { max: 5 });
    const P9 = projectOf(tmp);
    const e1 = enqueue(r9, { title: "e1", prompt: "e", key: "e#1", cwd: tmp });
    setState(r9, e1.id, "done", { filed: "e#9" });
    const e2 = enqueue(r9, { title: "e2", prompt: "e", key: "e#2", cwd: dir("other") });
    release(r9, e2.id);
    const ev1 = events(r9, { caller: "s-d", project: P9 });
    const ev2 = events(r9, { caller: "s-d", project: P9 });
    const e3 = enqueue(r9, { title: "e3", prompt: "e", key: "e#3", cwd: tmp });
    setState(r9, e3.id, "done");
    const ev3 = events(r9, { caller: "s-d", project: P9 });
    check("events returns what happened since the session's cursor, once, filtered by project",
      ev1.events.map((e) => `${e.id}:${e.event}:${e.filed ?? ""}`).join() === `${e1.id}:done:e#9` && ev2.events.length === 0 && ev3.events.map((e) => e.id).join() === e3.id);
    check("each session keeps its own cursor, and --since replays from a given point",
      events(r9, { caller: "s-other" }).events.map((e) => e.id).join() === [e1.id, e2.id, e3.id].join()
      && events(r9, { since: ev1.since }).events.length === 3);

    const r10 = path.join(tmp, "verify");
    configure(r10, { max: 1 });
    const vwt = dir("vwt");
    const v1 = enqueue(r10, { title: "v1", prompt: "v", key: "v#1", cwd: tmp });
    join(r10, v1.id, { session: "s-v", name: "vee", worktree: vwt });
    const v2 = enqueue(r10, { title: "v2", prompt: "v2 prompt text", key: "v#2", cwd: tmp });
    const ver = setState(r10, v1.id, "verifying", { note: "post-deploy probe", pr: "9" });
    fs.rmSync(vwt, { recursive: true });
    sweep(r10, { cwd: tmp, prState: noGh });
    const vb = board(r10, [], { cwd: tmp });
    check("verifying frees the slot, has its own board section, and survives its worktree being removed",
      ids(ver.launch) === v2.id && vb.verifying.map((v) => v.id).join() === v1.id && !vb.running.some((r) => r.id === v1.id)
      && readTask(r10, v1.id).state === "verifying" && renderBoard(vb).includes(`verifying (1)\n  ${v1.id} v#1 PR 9 — post-deploy probe`));
    let dupV = false;
    try { enqueue(r10, { title: "v1 again", prompt: "v", key: "v#1", cwd: tmp }); } catch { dupV = true; }
    check("a verifying task still holds its key, and done ends it",
      dupV && setState(r10, v1.id, "done").state === "done" && board(r10, [], { cwd: tmp }).verifying.length === 0);
    const text = prompt(r10, v2.id);
    check("prompt prints the launch header followed by the stored prompt",
      text.startsWith(`You are fleet task ${v2.id} (v#2). Your first command: fleet join ${v2.id} --session <your session id>`) && text.endsWith("\n\nv2 prompt text"));

    const r11 = path.join(tmp, "auto");
    configure(r11, { max: 2 });
    const u1 = enqueue(r11, { title: "u1", prompt: "u", key: "u#1", cwd: tmp });
    const n1 = next(r11, { cwd: tmp, now: Date.now() + 31 * 60_000, prState: noGh });
    check("next sweeps first: a launch nobody joined is requeued and relaunched in the same call",
      n1.swept?.changed.some((l) => l.startsWith(`${u1.id} launching → queued`)) && ids(n1.launch) === u1.id);
    const gwt = dir("gwt");
    join(r11, u1.id, { session: "s-u1", name: "you", worktree: gwt });
    fs.rmSync(gwt, { recursive: true });
    const u2 = enqueue(r11, { title: "u2", prompt: "u", key: "u#2", cwd: tmp, prState: noGh });
    check("enqueue sweeps first: a task whose worktree is gone is marked lost and its slot goes to the new task",
      u2.swept?.changed.some((l) => l.startsWith(`${u1.id} working → lost`)) && readTask(r11, u1.id).state === "lost" && u2.state === "launching");
    const shared = dir("shared");
    const u3 = enqueue(r11, { title: "u3", prompt: "u", key: "u#3", cwd: tmp, notify: "s-d", prState: noGh });
    join(r11, u3.id, { session: "s-u3", name: "old", worktree: shared });
    tick();
    join(r11, u2.id, { session: "s-u2", name: "new", worktree: shared });
    const sw = sweep(r11, { cwd: tmp, prState: noGh });
    check("two active tasks recording one worktree: the older is marked stale and its enqueuer named",
      readTask(r11, u3.id).state === "stale" && readTask(r11, u2.id).state === "working"
      && sw.notify.some((n) => n.id === u3.id && n.state === "stale" && n.session === "s-d"));

    const r12 = path.join(tmp, "net");
    configure(r12, { max: 2 });
    const t12 = enqueue(r12, { title: "n1", prompt: "n", key: "n#1", cwd: tmp });
    join(r12, t12.id, { session: "s-n", name: "en", worktree: dir("nwt") });
    setState(r12, t12.id, "working", { filed: "lms#1,lms#2,lms#3" });
    const runningNet = board(r12, [], { cwd: tmp }).running[0].net;
    const fin = setState(r12, t12.id, "done", { closed: "lms#7", filed: "lms#3,lms#4" });
    check("filed and closed refs land on the task and in the journal, and a running task shows its net",
      runningNet === 3 && fin.filed.join() === "lms#1,lms#2,lms#3,lms#4" && fin.closed.join() === "lms#7"
      && journal(r12, {}).find((e) => e.id === t12.id && e.event === "done").filed.join() === "lms#3,lms#4");
    const nb = board(r12, [], { cwd: tmp });
    check("board and journal show today's net per project, each ref counted once",
      nb.net[0].net === 3 && renderBoard(nb).includes(`${P9} +3 (filed 4, closed 1)`) && renderJournal(journal(r12, {})).includes(`${P9} +3 (filed 4, closed 1)`));

    const r13 = path.join(tmp, "compat");
    configure(r13, { max: 1 });
    const old = (id, state, createdAt, extra = {}) =>
      fs.writeFileSync(path.join(r13, "tasks", `${id}.json`), JSON.stringify({ id, key: `c#${id}`, title: id, prompt: id, cwd: tmp, project: P9, by: null, notify: "s-d", state, createdAt, updatedAt: createdAt, ...extra }));
    old("t001", "launching", 1, { launchedAt: Date.now() });
    old("t003", "queued", 3);
    old("t002", "queued", 2);
    const compatClaim = events(r13, { caller: "s-d" });
    setState(r13, "t001", "done");
    check("0.4.1 task files keep working: a launch already handed out is not claimed again, and the queue keeps createdAt order",
      compatClaim.launch.length === 0 && board(r13, [], { cwd: tmp }).queue.map((q) => q.id).join() === "t003" && readTask(r13, "t002").pendingFor === "s-d");

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
    const script = `import(${JSON.stringify(new URL("./fleet.mjs", import.meta.url).href)}).then(m => { try { m.enqueue(process.argv[1], { title: "race", prompt: "p", key: "repo#9", cwd: process.argv[1] }); console.log("won"); } catch { console.log("lost"); } })`;
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
