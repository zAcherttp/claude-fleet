import type { View } from '../types'
import { classifyRaw, parseBoard } from './model'

const WEB = (n: number) => `https://github.com/northwind-industries/web/pull/${n}`
const DOCS = (n: number) => `https://github.com/northwind-industries/docs-site/pull/${n}`
const MOBILE = (n: number) => `https://github.com/northwind-industries/mobile-app/pull/${n}`
const COURSE = (n: number) => `https://github.com/university-team-7/game/pull/${n}`

const check = (name: string, conclusion: string) => ({ name, status: 'COMPLETED', conclusion })

export function worstView(now: number): View {
  const board = parseBoard(
    JSON.stringify({
      slots: [
        { scope: 'default', used: 6, max: 5 },
        { scope: 'coursework', used: 2, max: 5 },
        { scope: 'release-freeze', used: 0, max: 2, held: { note: "Aleksandra's production deploy on Friday: nothing starts in mobile-app until she confirms the release is out and checked", at: now } },
      ],
      running: [
        { id: 't097', scope: 'default', key: 'northwind-industries/web#981', label: 'Copy pass on 13 Vietnamese strings', state: 'question', pr: null, note: 'parked: waiting for Bartholomew to send the approved glossary (sha cf384d1e); wording approved, committed 81a92d7a4 locally' },
        { id: 't1003', scope: 'default', key: 'northwind-industries/web#2000-cleanup-billing', label: 'Delete the old billing, invoices, refunds and audit-export endpoints', state: 'question', pr: WEB(2145), note: 'web#2145 conflicts with main after web#2143; the sync tool needs the repository origin confirmed (Help → Troubleshooting → Review Pinned Git Origins) https://github.com/northwind-industries/web/pull/2145/files#diff-0b6f22c4e1a9d3b7f5e8c2a14d6b9e03' },
        { id: 't1004', scope: 'default', key: 'northwind-industries/web#2000-cleanup-tooling', label: 't1004', state: 'launching', pr: null, note: null },
        { id: 't1005', scope: 'default', key: 'northwind-industries/docs-site#239', label: 'Sửa nhãn «Ghi chú» trong hướng dẫn Lớp 11 — 13 chuỗi tiếng Việt chưa qua rà soát giọng văn', state: 'mergeable', pr: DOCS(239), note: null },
        { id: 't1006', scope: 'default', key: 'northwind-industries/web#2163', label: 'Cost headers read 0 for every budgeted route', state: 'working', pr: WEB(2163), note: null },
        { id: 't1007', scope: 'default', key: 'northwind-industries/mobile-app#1413', label: 'Call the API on /v2/services before the v1 sunset', state: 'mergeable', pr: MOBILE(1413), note: null },
        { id: 't113', scope: 'coursework', key: 'university-team-7/game#poc', label: 'Prototype hand-off setup', state: 'question', pr: null, note: 'Sound paused on 2026-10-05 for prototype clean-up; branch polish/sound pushed (3ab8c74); resume steps in the NOT-FINAL Sound section' },
        { id: 't260', scope: 'coursework', key: 'university-team-7/game#218', label: 'Stable springs 🌀 and a low-FPS animation fallback for school Chromebooks', state: 'working', pr: COURSE(218), note: null },
      ],
      queue: Array.from({ length: 14 }, (_, i) => ({
        scope: i === 13 ? 'release-freeze' : 'default',
        position: i === 13 ? 1 : i + 1,
        id: `t${1010 + i}`,
        key: `northwind-industries/web#${2170 + i}`,
        title: i === 0 ? 'Load audit: partners, resellers, and the admin console and content pipeline routes (performance pass, wave 4)' : `Load audit ${i + 1}: orders, refunds and invoices`,
      })),
      waiting: [
        { id: 't270', key: 'northwind-industries/web#usage-dashboard', title: 'Route usage: admin dashboard page', after: ['t269'] },
        { id: 't253', key: 'northwind-industries/web#2000-cleanup-tooling', title: 'Delete tooling-only routes; fix ledger cache-key callers', after: ['northwind-industries/web#2141', 'northwind-industries/docs-site#240'] },
      ],
      verifying: [{ id: 't196', key: 'northwind-industries/web#2078', pr: WEB(2082), note: 'merged 0bb90d843; waiting for the deploy and a production event tagged with the release' }],
      net: [
        { project: 'web', filed: Array(7).fill('x'), closed: Array(3).fill('x'), net: 4 },
        { project: 'mobile-app', filed: ['x'], closed: ['x'], net: 0 },
        { project: 'docs-site', filed: ['x'], closed: [], net: 1 },
        { project: 'payments-service', filed: [], closed: ['x'], net: -1 },
        { project: 'design-system', filed: [], closed: ['x'], net: -1 },
      ],
    }),
  )
  const prs = {
    [WEB(2145)]: classifyRaw(WEB(2145), { number: 2145, title: 't', state: 'OPEN', mergeStateStatus: 'DIRTY', statusCheckRollup: [check('ci', 'SUCCESS')] }),
    [DOCS(239)]: classifyRaw(DOCS(239), { number: 239, title: 't', state: 'OPEN', mergeStateStatus: 'CLEAN', statusCheckRollup: [check('lint', 'SUCCESS')] }),
    [WEB(2163)]: classifyRaw(WEB(2163), {
      number: 2163,
      title: 't',
      state: 'OPEN',
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [check('ci', 'FAILURE'), check('Static guards (blocking)', 'FAILURE'), check('deploy / build-and-test (ubuntu-26.04, node 24)', 'FAILURE'), check('secret-scan', 'FAILURE')],
    }),
    [MOBILE(1413)]: classifyRaw(MOBILE(1413), { number: 1413, title: 't', state: 'OPEN', mergeStateStatus: 'CLEAN', statusCheckRollup: [] }),
    [COURSE(218)]: { url: COURSE(218), number: 218, title: '', state: 'skipped' as const, failing: [] },
  }
  return {
    board,
    prs,
    titles: {},
    updatedAt: now - 2 * 60 * 60 * 1000,
    error: null,
    refreshing: false,
    timings: { boardMs: 1712, prsMs: 21640, totalMs: 23352, prCount: 4 },
  }
}
