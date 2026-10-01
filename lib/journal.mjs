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

export function renderJournal(entries) {
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
    const detail = [e.event, e.state && e.state !== e.event ? e.state : null, e.pr, e.note].filter(Boolean).join(" · ");
    lines.push(`- ${time} ${e.project ?? "-"} ${subject ? subject + " " : ""}${detail}`.replace(/\s+/g, " ").trim());
  }
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
