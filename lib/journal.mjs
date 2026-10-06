import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DAY_MS = 86_400_000;

export function projectOf(cwd) {
  try {
    const top = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const common = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return path.basename(path.basename(common) === ".git" ? path.dirname(common) : top);
  } catch {
    return path.basename(path.resolve(cwd));
  }
}

export function dayOf(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const journalDir = (root) => path.join(root, "journal");
const profileDir = (root, project) => path.join(root, "dispatch", project);

export function record(root, entry, now = Date.now()) {
  fs.mkdirSync(journalDir(root), { recursive: true });
  const line = JSON.stringify({ at: now, ...entry });
  fs.appendFileSync(path.join(journalDir(root), `${dayOf(now)}.jsonl`), line + "\n");
}

export function readJournal(root, { project = null, days = 2, now = Date.now() } = {}) {
  const wanted = new Set(Array.from({ length: Math.max(1, days) }, (_, i) => dayOf(now - i * DAY_MS)));
  if (!fs.existsSync(journalDir(root))) return [];
  return fs
    .readdirSync(journalDir(root))
    .filter((f) => f.endsWith(".jsonl") && wanted.has(f.slice(0, -6)))
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(journalDir(root), f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
    .filter((e) => !project || e.project === project)
    .sort((a, b) => a.at - b.at);
}

const CURSOR = /^(\d{4}-\d{2}-\d{2})(?::(\d+))?$/;

export function readJournalSince(root, cursor) {
  const m = CURSOR.exec(cursor ?? "");
  if (!m) throw new Error("fleet: --since takes a cursor (YYYY-MM-DD:offset) or a day (YYYY-MM-DD)");
  const [, day, offset] = m;
  if (!fs.existsSync(journalDir(root))) return { entries: [], cursor };
  const entries = [];
  let at = cursor;
  for (const f of fs.readdirSync(journalDir(root)).filter((x) => x.endsWith(".jsonl") && x.slice(0, -6) >= day).sort()) {
    const d = f.slice(0, -6);
    const buf = fs.readFileSync(path.join(journalDir(root), f));
    const start = d === day ? Number(offset ?? 0) : 0;
    const end = buf.lastIndexOf(0x0a) + 1;
    if (end <= start) continue;
    entries.push(...buf.subarray(start, end).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
    at = `${d}:${end}`;
  }
  return { entries, cursor: at };
}

export function netByProject(entries) {
  const by = new Map();
  for (const e of entries) {
    if (!e.filed?.length && !e.closed?.length) continue;
    const n = by.get(e.project) ?? { project: e.project, filed: new Set(), closed: new Set() };
    for (const r of e.filed ?? []) n.filed.add(r);
    for (const r of e.closed ?? []) n.closed.add(r);
    by.set(e.project, n);
  }
  return [...by.values()].map((n) => ({ project: n.project, filed: [...n.filed], closed: [...n.closed], net: n.filed.size - n.closed.size }));
}

export const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0");

export function renderNet(net) {
  return net.map((n) => `${n.project ?? "-"} ${signed(n.net)} (filed ${n.filed.length}, closed ${n.closed.length})`);
}

export function renderJournal(entries, now = Date.now()) {
  if (!entries.length) return "journal empty for this window";
  const lines = [];
  let day = null;
  for (const e of entries) {
    const d = dayOf(e.at);
    if (d !== day) {
      lines.push(`## ${d}`);
      day = d;
    }
    const time = new Date(e.at).toTimeString().slice(0, 5);
    const subject = [e.id, e.key].filter(Boolean).join(" ");
    const refs = [e.closed?.length && `closed ${e.closed.join(",")}`, e.filed?.length && `filed ${e.filed.join(",")}`];
    const detail = [e.event, e.state && e.state !== e.event ? e.state : null, e.pr, e.note, ...refs].filter(Boolean).join(" · ");
    lines.push(`- ${time} ${e.project ?? "-"} ${subject ? subject + " " : ""}${detail}`.replace(/\s+/g, " ").trim());
  }
  const net = netByProject(entries.filter((e) => dayOf(e.at) === dayOf(now)));
  if (net.length) lines.push("## net issues today", ...renderNet(net).map((l) => `- ${l}`));
  return lines.join("\n");
}

export function saveProfile(root, project, { brief = null, template = null }) {
  const dir = profileDir(root, project);
  fs.mkdirSync(dir, { recursive: true });
  if (brief != null) fs.writeFileSync(path.join(dir, "brief.md"), brief);
  if (template != null) fs.writeFileSync(path.join(dir, "template.md"), template);
  return { project, brief: path.join(dir, "brief.md"), template: path.join(dir, "template.md") };
}

export function readProfile(root, project) {
  const dir = profileDir(root, project);
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf8") : null);
  return { project, dir, brief: read("brief.md"), template: read("template.md") };
}
