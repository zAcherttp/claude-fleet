import type { Board, PrInfo, PrState, QueuedTask, RunningTask, Slot, VerifyingTask, View, WaitingTask } from '../types'

type Raw = Record<string, any>

export const emptyView: View = { board: null, prs: {}, titles: {}, updatedAt: 0, error: null }

const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)

export function parseBoard(json: string): Board {
  const raw: Raw = JSON.parse(json)
  const list = (value: unknown): Raw[] => (Array.isArray(value) ? value : [])
  return {
    slots: list(raw.slots).map(s => ({ scope: String(s.scope), used: Number(s.used ?? 0), max: Number(s.max ?? 0), held: Boolean(s.held), holdNote: text(s.held?.note) })),
    running: list(raw.running).map(t => ({
      id: String(t.id),
      scope: String(t.scope ?? 'default'),
      key: String(t.key ?? ''),
      label: String(t.label ?? t.id),
      state: String(t.state ?? ''),
      pr: text(t.pr),
      note: text(t.note),
    })),
    queue: list(raw.queue).map(t => ({ id: String(t.id), scope: String(t.scope ?? 'default'), key: String(t.key ?? ''), title: String(t.title ?? ''), position: Number(t.position ?? 0) })),
    waiting: list(raw.waiting).map(t => ({ id: String(t.id), key: String(t.key ?? ''), title: String(t.title ?? ''), after: list(t.after).map(String).join(', ') })),
    verifying: list(raw.verifying).map(t => ({ id: String(t.id), key: String(t.key ?? ''), pr: text(t.pr), note: text(t.note) })),
    net: list(raw.net).map(n => ({ project: String(n.project), net: Number(n.net ?? 0), filed: list(n.filed).length, closed: list(n.closed).length })),
  }
}

const isRed = (c: Raw) => ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(c.conclusion) || ['FAILURE', 'ERROR'].includes(c.state)
const isPending = (c: Raw) => (c.status !== undefined && c.status !== 'COMPLETED') || c.state === 'PENDING' || c.state === 'EXPECTED'

export function classifyPr(url: string, json: string): PrInfo {
  return classifyRaw(url, JSON.parse(json))
}

export function classifyRaw(url: string, raw: Raw): PrInfo {
  const checks: Raw[] = Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : []
  const failing = checks.filter(isRed).map(c => String(c.name ?? c.context ?? 'check'))
  const pending = checks.some(isPending)
  const merge = String(raw.mergeStateStatus ?? 'UNKNOWN')
  const state: PrState =
    raw.state === 'MERGED' ? 'merged'
    : raw.state === 'CLOSED' ? 'closed'
    : merge === 'DIRTY' ? 'conflict'
    : failing.length > 0 && !pending ? 'red'
    : pending ? 'running'
    : ['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(merge) ? 'ready'
    : merge === 'BLOCKED' ? 'blocked'
    : 'unknown'
  return { url, number: Number(raw.number ?? prNumber(url)), title: String(raw.title ?? ''), state, failing }
}

export function prNumber(url: string): number {
  const match = /\/pull\/(\d+)/.exec(url)
  return match ? Number(match[1]) : 0
}

export function prRef(url: string): string {
  const match = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(url)
  return match ? `${match[1]}#${match[2]}` : url
}

export function trackedPrs(board: Board): string[] {
  return [...new Set(board.running.map(t => t.pr).filter((pr): pr is string => pr !== null && pr.includes('/pull/')))]
}

export const prLabel: Record<PrState, string> = {
  ready: 'ready to merge',
  red: 'red',
  conflict: 'conflict',
  running: 'CI running',
  merged: 'merged',
  closed: 'closed',
  blocked: 'blocked',
  unknown: 'checking',
  skipped: 'no access',
}

export type Counts = { used: number; max: number; ready: number; red: number; conflict: number; queued: number; waiting: number; questions: number; net: string }

export function counts(view: View): Counts {
  const board = view.board
  const prs = Object.values(view.prs)
  const main = board?.slots.find(s => s.scope === 'default') ?? board?.slots[0]
  return {
    used: main?.used ?? 0,
    max: main?.max ?? 0,
    ready: prs.filter(p => p.state === 'ready').length,
    red: prs.filter(p => p.state === 'red').length,
    conflict: prs.filter(p => p.state === 'conflict').length,
    queued: board?.queue.length ?? 0,
    waiting: board?.waiting.length ?? 0,
    questions: board?.running.filter(t => t.state === 'question').length ?? 0,
    net: (board?.net ?? []).map(n => `${n.project} ${n.net > 0 ? '+' : ''}${n.net}`).join(', '),
  }
}

export function bandLine(view: View): string {
  if (view.board === null) return view.error ? `fleet: ${view.error}` : 'fleet: reading the board…'
  const c = counts(view)
  const parts = [`fleet ${c.used}/${c.max}`]
  if (c.ready) parts.push(`${c.ready} ready to merge`)
  if (c.red) parts.push(`${c.red} red`)
  if (c.conflict) parts.push(`${c.conflict} conflict`)
  if (c.questions) parts.push(`${c.questions} question${c.questions === 1 ? '' : 's'}`)
  parts.push(`queue ${c.queued}`)
  if (c.waiting) parts.push(`waiting ${c.waiting}`)
  if (c.net) parts.push(`net today ${c.net}`)
  return parts.join(' · ')
}

export function changes(before: View, after: View): string[] {
  if (before.board === null || after.board === null) return []
  const out: string[] = []
  for (const [url, pr] of Object.entries(after.prs)) {
    const was = before.prs[url]?.state
    if (was === undefined || was === pr.state) continue
    if (pr.state === 'ready') out.push(`${prRef(url)} is green and ready to merge`)
    if (pr.state === 'red') out.push(`${prRef(url)} went red: ${pr.failing.slice(0, 3).join(', ')}`)
    if (pr.state === 'conflict') out.push(`${prRef(url)} conflicts with main`)
    if (pr.state === 'merged') out.push(`${prRef(url)} merged`)
  }
  const old = new Map(before.board.running.map(t => [t.id, t.state]))
  for (const task of after.board.running) {
    const was = old.get(task.id)
    if (was === undefined && task.state === 'launching') out.push(`${task.id} ready to launch: ${task.label}`)
    else if (was !== undefined && was !== task.state && task.state === 'question') out.push(`${task.id} has a question: ${task.note ?? task.label}`)
  }
  const still = new Set(after.board.running.map(t => t.id))
  for (const task of before.board.running) {
    if (!still.has(task.id) && after.board.verifying.every(v => v.id !== task.id)) out.push(`${task.id} left the pool: ${task.label}`)
  }
  return out
}

export function rememberTitles(board: Board, known: Record<string, string>): Record<string, string> {
  const titles = { ...known }
  for (const q of board.queue) titles[q.id] = q.title
  for (const w of board.waiting) titles[w.id] = w.title
  for (const t of board.running) if (t.label !== t.id) titles[t.id] = t.label
  return titles
}

export function titleOf(task: RunningTask, titles: Record<string, string>): string {
  return task.label !== task.id ? task.label : (titles[task.id] ?? (task.key ? task.key.replace(/^[^/]+\//, '') : task.id))
}

export type Attention = { id: string; scope: string; title: string; pr: PrInfo | null; note: string | null }

export type ScopeCard = { slot: Slot; running: RunningTask[]; queue: QueuedTask[] }

export type Layout = {
  attention: Attention[]
  cards: ScopeCard[]
  waiting: WaitingTask[]
  verifying: VerifyingTask[]
  scopes: string[]
}

const attentionRank = { conflict: 0, red: 1, ready: 2 } as const

export function layout(view: View, filter: string): Layout {
  const board = view.board
  if (board === null) return { attention: [], cards: [], waiting: [], verifying: [], scopes: [] }
  const shown = (scope: string) => filter === 'all' || filter === scope
  const attention: Attention[] = []
  for (const task of board.running) {
    if (!shown(task.scope)) continue
    const found = task.pr ? view.prs[task.pr] : undefined
    const pr = found && (found.state === 'ready' || found.state === 'red' || found.state === 'conflict') ? found : null
    const note = task.state === 'question' ? (task.note ?? '') : null
    if (pr || note !== null) attention.push({ id: task.id, scope: task.scope, title: titleOf(task, view.titles), pr, note })
  }
  const rank = (a: Attention) => (a.pr ? attentionRank[a.pr.state as keyof typeof attentionRank] : 3)
  attention.sort((a, b) => rank(a) - rank(b))
  const cards = board.slots
    .filter(slot => shown(slot.scope))
    .map(slot => ({
      slot,
      running: board.running.filter(t => t.scope === slot.scope),
      queue: board.queue.filter(q => q.scope === slot.scope).sort((a, b) => a.position - b.position),
    }))
  return {
    attention,
    cards,
    waiting: filter === 'all' || filter === 'default' ? board.waiting : [],
    verifying: filter === 'all' || filter === 'default' ? board.verifying : [],
    scopes: ['all', ...board.slots.map(s => s.scope)],
  }
}

export function meterSvg(slot: Slot): string {
  const cell = 14
  const gap = 4
  const count = Math.max(slot.max, slot.used, 1)
  const width = count * cell + (count - 1) * gap
  const used = slot.held ? '#d29922' : slot.used >= slot.max ? '#8b949e' : '#3fb950'
  const cells = Array.from({ length: count }, (_, i) => {
    const x = i * (cell + gap)
    const over = i >= slot.max
    const filled = i < slot.used
    const colour = over ? '#f0883e' : used
    const fill = filled ? colour : 'none'
    const stroke = filled ? colour : '#8b949e'
    const dash = (slot.held && !filled) || over ? ' stroke-dasharray="3 2"' : ''
    return `<rect x="${x + 0.5}" y="0.5" width="${cell - 1}" height="9" rx="3" fill="${fill}" stroke="${stroke}" stroke-opacity="0.8"${dash}/>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="10" viewBox="0 0 ${width} 10">${cells.join('')}</svg>`
}

export function meterText(slot: Slot): string {
  const inside = Math.min(slot.used, slot.max)
  return '\u25a0'.repeat(inside) + '\u25a1'.repeat(Math.max(0, slot.max - slot.used)) + (slot.used > slot.max ? ' +' + (slot.used - slot.max) : '')
}

export function prShort(url: string): string {
  const match = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(url)
  return match ? `${match[1]}#${match[2]}` : url
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

export type PrRef = { url: string; owner: string; repo: string; number: number }

export function parsePrUrl(url: string): PrRef | null {
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url)
  return match ? { url, owner: match[1]!, repo: match[2]!, number: Number(match[3]) } : null
}

const PR_FIELDS = 'number title state mergeStateStatus commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }'

export function prQuery(refs: readonly PrRef[]): string {
  const repos = new Map<string, PrRef[]>()
  for (const ref of refs) repos.set(`${ref.owner}/${ref.repo}`, [...(repos.get(`${ref.owner}/${ref.repo}`) ?? []), ref])
  const blocks = [...repos.entries()].map(([, list], i) => {
    const first = list[0]!
    const prs = list.map(r => `pr${r.number}: pullRequest(number: ${r.number}) { ${PR_FIELDS} }`).join(' ')
    return `r${i}: repository(owner: ${JSON.stringify(first.owner)}, name: ${JSON.stringify(first.repo)}) { ${prs} }`
  })
  return `query { ${blocks.join(' ')} }`
}

export function readPrQuery(refs: readonly PrRef[], json: string): { ok: boolean; prs: Record<string, PrInfo> } {
  let parsed: Raw
  try {
    parsed = JSON.parse(json)
  } catch {
    return { ok: false, prs: {} }
  }
  const data: Raw | null = parsed?.data ?? null
  if (data === null) return { ok: false, prs: {} }
  const order = [...new Set(refs.map(r => `${r.owner}/${r.repo}`))]
  const out: Record<string, PrInfo> = {}
  for (const ref of refs) {
    const node: Raw | undefined = data[`r${order.indexOf(`${ref.owner}/${ref.repo}`)}`]?.[`pr${ref.number}`]
    if (!node) continue
    const contexts: Raw[] = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []
    out[ref.url] = classifyRaw(ref.url, { number: node.number, title: node.title, state: node.state, mergeStateStatus: node.mergeStateStatus, statusCheckRollup: contexts })
  }
  return { ok: true, prs: out }
}

export type IconKind = 'working' | 'question' | 'mergeable' | 'launching' | 'ready' | 'red' | 'conflict' | 'running' | 'merged' | 'queued' | 'held' | 'skipped' | 'closed' | 'blocked' | 'unknown'

const ICON_COLOR: Record<IconKind, string> = {
  working: '#58a6ff', question: '#d29922', mergeable: '#3fb950', launching: '#a371f7', ready: '#3fb950', red: '#f85149', conflict: '#d29922',
  running: '#8b949e', merged: '#a371f7', queued: '#8b949e', held: '#d29922', skipped: '#8b949e', closed: '#8b949e', blocked: '#d29922', unknown: '#8b949e',
}

const ICON_PATH: Record<IconKind, string> = {
  working: '<path d="M12 3a9 9 0 1 0 9 9"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14"/><circle cx="12" cy="17.2" r=".6" fill="C"/>',
  mergeable: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16.5 9"/>',
  launching: '<circle cx="12" cy="12" r="9"/><path d="m10 8.5 5.5 3.5-5.5 3.5z" fill="C"/>',
  ready: '<circle cx="12" cy="12" r="9" fill="C" fill-opacity=".18"/><path d="m8 12.5 2.8 2.8L16.5 9"/>',
  red: '<circle cx="12" cy="12" r="9" fill="C" fill-opacity=".18"/><path d="m9 9 6 6m0-6-6 6"/>',
  conflict: '<path d="M12 3.5 21 19.5H3z" fill="C" fill-opacity=".18"/><path d="M12 10v4"/><circle cx="12" cy="17" r=".6" fill="C"/>',
  running: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
  merged: '<circle cx="7" cy="6" r="2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="12" r="2"/><path d="M7 8v8M7 8c0 3 3 4 8 4"/>',
  queued: '<circle cx="6" cy="12" r="1.3" fill="C"/><circle cx="12" cy="12" r="1.3" fill="C"/><circle cx="18" cy="12" r="1.3" fill="C"/>',
  held: '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
  skipped: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12h7"/>',
  closed: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
  blocked: '<circle cx="12" cy="12" r="9"/><path d="m6 18 12-12"/>',
  unknown: '<circle cx="12" cy="12" r="9" stroke-dasharray="3 3"/>',
}

export function iconSvg(kind: IconKind): string {
  const color = ICON_COLOR[kind]
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATH[kind].replaceAll('"C"', `"${color}"`)}</svg>`
}

export function stateIcon(state: string): IconKind {
  return (['working', 'question', 'mergeable', 'launching', 'queued'] as const).find(k => k === state) ?? (state === 'verifying' ? 'running' : 'unknown')
}

export type RunOutcome = { exitCode: number; stdout: string; stderr: string } | { error: string }

const firstLine = (text: string) => text.trim().split('\n').find(line => line.trim().length > 0)?.trim().slice(0, 200) ?? ''

const isMissing = (o: RunOutcome) =>
  'error' in o ? /ENOENT|not found|no such file|cannot find|not recognized/i.test(o.error) : o.exitCode === 127 || o.exitCode === 9009

const isTimeout = (o: RunOutcome) => 'error' in o && /time ?out|timed out|ETIMEDOUT|killed/i.test(o.error)

export function boardFailure(o: RunOutcome): string | null {
  if (isMissing(o)) return "Can't run fleet: Node.js isn't on the PATH Claude Code started with. Install Node 18 or newer, or start Claude Code from a terminal where `node --version` works."
  if (isTimeout(o)) return '`fleet board` took longer than 10 s. Another fleet command may be holding the lock; `fleet sweep` clears a stale one.'
  if ('error' in o) return `Couldn't start \`fleet board\`: ${firstLine(o.error)}`
  if (o.exitCode !== 0) {
    if (/SyntaxError|Unexpected token|ERR_UNKNOWN_FILE_EXTENSION/.test(o.stderr)) return 'fleet needs Node 18 or newer; the `node` Claude Code found is older. Check `node --version`.'
    return `\`fleet board\` failed (exit ${o.exitCode}): ${firstLine(o.stderr) || 'no error output'}`
  }
  try {
    JSON.parse(o.stdout)
    return null
  } catch {
    return `\`fleet board\` printed something other than JSON ("${firstLine(o.stdout).slice(0, 80)}"). Run \`fleet board --all --json\` in a terminal to see why.`
  }
}

export function prFailure(o: RunOutcome): string | null {
  if (isMissing(o)) return 'PR status needs the GitHub CLI: install `gh`, then run `gh auth login`.'
  if (isTimeout(o)) return "Couldn't reach GitHub within 10 s; showing the last known PR status."
  const text = 'error' in o ? o.error : o.stderr
  if ('exitCode' in o && o.exitCode === 0) return null
  if (/auth login|not logged in|authentication|HTTP 401|Bad credentials/i.test(text)) return "`gh` isn't signed in, so PR status is unavailable. Run `gh auth login`."
  if (/rate limit/i.test(text)) return "GitHub's API rate limit was reached; PR status resumes on its own."
  if (/could not resolve host|network|ECONN|dial tcp|i\/o timeout/i.test(text)) return "Couldn't reach GitHub; showing the last known PR status."
  return `PR status unavailable: ${firstLine(text) || 'gh gave no reason'}`
}
