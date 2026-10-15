import fs from "node:fs";

const GATED = /(?:^|[;&|(\n]|\/)\s*(?:\w+=\S*\s+)*fleet(?:\.mjs)?["']?\s+state\s+(\S+)\s+(mergeable|done)(?=$|[\s;&|)])/m;
const isPlan = (name) => typeof name === "string" && /(?:^|__)update_plan$/.test(name);
const isTodo = (name) => name === "TodoWrite";

export function gatedCommand(command) {
  const m = typeof command === "string" ? GATED.exec(command) : null;
  return m ? { id: m[1], state: m[2] } : null;
}

export function* lines(file, { chunk = 1 << 16 } = {}) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(chunk);
    let rest = "";
    for (;;) {
      const n = fs.readSync(fd, buf, 0, chunk, null);
      if (n === 0) break;
      const parts = (rest + buf.toString("utf8", 0, n)).split("\n");
      rest = parts.pop();
      yield* parts;
    }
    if (rest) yield rest;
  } finally {
    fs.closeSync(fd);
  }
}

function applyPlan(list, input) {
  let items = list;
  if (Array.isArray(input.items)) items = input.items.map((x) => ({ content: String(x?.content ?? ""), status: x?.status ?? "pending" }));
  if (!items) return null;
  items = items.map((x) => ({ ...x }));
  for (const n of Array.isArray(input.done) ? input.done : []) if (items[n - 1]) items[n - 1].status = "completed";
  if (input.advance) {
    const at = items.findIndex((x) => x.status === "in_progress");
    if (at !== -1) items[at].status = "completed";
    const next = items.findIndex((x, i) => i > at && x.status === "pending");
    if (next !== -1) items[next].status = "in_progress";
  }
  if (Number.isInteger(input.start) && items[input.start - 1]) items[input.start - 1].status = "in_progress";
  return items;
}

export function lastChecklist(file) {
  const ops = [];
  const failed = new Set();
  for (const line of lines(file)) {
    const plan = line.includes("update_plan");
    const todo = line.includes("TodoWrite");
    const error = line.includes('"is_error":true');
    if (!plan && !todo && !error) continue;
    const entry = JSON.parse(line);
    if (entry.isSidechain) continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === "tool_use" && (isPlan(b.name) || isTodo(b.name))) ops.push({ id: b.id, todo: isTodo(b.name), input: b.input ?? {} });
      else if (b?.type === "tool_result" && b.is_error) failed.add(b.tool_use_id);
    }
  }
  let list = null;
  for (const op of ops) {
    if (failed.has(op.id)) continue;
    list = op.todo
      ? (Array.isArray(op.input.todos) ? op.input.todos : []).map((x) => ({ content: String(x?.content ?? ""), status: x?.status ?? "pending" }))
      : applyPlan(list, op.input);
  }
  return list;
}

const warn = (text) => ({ systemMessage: text, hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } });

export function planGate(input) {
  try {
    const gated = input?.tool_name === "Bash" ? gatedCommand(input?.tool_input?.command) : null;
    if (!gated) return null;
    const what = `fleet state ${gated.id} ${gated.state}`;
    if (!input.transcript_path) return warn(`fleet: no transcript_path in the hook input, so the checklist for ${what} was not checked.`);
    const list = lastChecklist(input.transcript_path);
    if (!list) return warn(`fleet: this session never posted a checklist (update_plan or TodoWrite), so ${what} was let through unchecked.`);
    const open = list.filter((x) => x.status !== "completed");
    if (!open.length) return null;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `fleet: ${what} is refused while the checklist has open items:\n${open.map((x) => `- ${x.content} (${x.status})`).join("\n")}\nFinish them, or split or rename them if the task changed, mark every item completed with update_plan or TodoWrite, then run the command again.`,
      },
    };
  } catch (e) {
    return warn(`fleet: the checklist gate could not read this session's transcript (${e?.message ?? e}), so the command was let through unchecked.`);
  }
}

export function hookPlanGate(stdin) {
  let input;
  try {
    input = JSON.parse(stdin);
  } catch (e) {
    return warn(`fleet: the checklist gate got hook input it could not parse (${e?.message ?? e}), so the command was let through unchecked.`);
  }
  return planGate(input);
}
