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
        { scope: 'release-freeze', used: 0, max: 2, held: { note: "Aleksandra's holiday-sale deploy on Friday: nothing starts in mobile-app until she confirms the release is out and checked", at: now } },
      ],
      running: [
        { id: 't1001', scope: 'default', key: 'northwind-industries/web#3081', label: 'Translate the 13 checkout error messages into Vietnamese', state: 'question', pr: null, note: 'parked: waiting for Bartholomew Fitzgerald-Oyelaran to send the approved glossary (sha cf384d1e); wording approved, committed 81a92d7a4 locally' },
        { id: 't1003', scope: 'default', key: 'northwind-industries/web#3090', label: 'Remove the legacy coupon, gift-card, loyalty-points and partner-voucher endpoints', state: 'question', pr: WEB(4512), note: 'web#4512 conflicts with main after web#4509; the sync tool needs the repository origin confirmed (Help → Troubleshooting → Review Pinned Git Origins) https://github.com/northwind-industries/web/pull/4512/files#diff-0b6f22c4e1a9d3b7f5e8c2a14d6b9e03' },
        { id: 't1004', scope: 'default', key: 'northwind-industries/web#3100-legacy-cleanup', label: 't1004', state: 'launching', pr: null, note: null },
        { id: 't1005', scope: 'default', key: 'northwind-industries/docs-site#288', label: 'Cập nhật hướng dẫn đổi trả hàng — 13 mục câu hỏi thường gặp chưa qua rà soát chính tả', state: 'mergeable', pr: DOCS(288), note: null },
        { id: 't1006', scope: 'default', key: 'northwind-industries/web#3112', label: 'Shipping estimate shows 0 days for every international order', state: 'working', pr: WEB(4530), note: null },
        { id: 't1007', scope: 'default', key: 'northwind-industries/mobile-app#1977', label: 'Show the saved-cards list on the order summary screen', state: 'mergeable', pr: MOBILE(1977), note: null },
        { id: 't1101', scope: 'coursework', key: 'university-team-7/game#editor', label: 'Level editor hand-off', state: 'question', pr: null, note: 'Music paused on 2026-10-05 for clean-up; branch polish/music pushed (3ab8c74); resume steps in the TODO Music section' },
        { id: 't1102', scope: 'coursework', key: 'university-team-7/game#19', label: 'Smoother camera springs 🌀 and a low-FPS fallback for older tablets', state: 'working', pr: COURSE(19), note: null },
      ],
      queue: Array.from({ length: 14 }, (_, i) => ({
        scope: i === 13 ? 'release-freeze' : 'default',
        position: i === 13 ? 1 : i + 1,
        id: `t${1010 + i}`,
        key: `northwind-industries/web#${3200 + i}`,
        title: i === 0 ? 'Performance pass: product listing, search filters, recommendations and wishlist pages (wave 4)' : `Performance pass ${i + 1}: cart, checkout and receipts`,
      })),
      waiting: [
        { id: 't1201', key: 'northwind-industries/web#sales-dashboard', title: 'Sales dashboard: weekly revenue chart', after: ['t1200'] },
        { id: 't1202', key: 'northwind-industries/web#3150', title: 'Remove unused feature flags; fix stale cache keys', after: ['northwind-industries/web#4501', 'northwind-industries/docs-site#290'] },
      ],
      verifying: [{ id: 't1301', key: 'northwind-industries/web#3060', pr: WEB(4480), note: 'merged 0bb90d843; waiting for the deploy and one production order with the new tax rounding' }],
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
    [WEB(4512)]: classifyRaw(WEB(4512), { number: 4512, title: 't', state: 'OPEN', mergeStateStatus: 'DIRTY', statusCheckRollup: [check('ci', 'SUCCESS')] }),
    [DOCS(288)]: classifyRaw(DOCS(288), { number: 288, title: 't', state: 'OPEN', mergeStateStatus: 'CLEAN', statusCheckRollup: [check('lint', 'SUCCESS')] }),
    [WEB(4530)]: classifyRaw(WEB(4530), {
      number: 4530,
      title: 't',
      state: 'OPEN',
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [check('ci', 'FAILURE'), check('lint (blocking)', 'FAILURE'), check('e2e / checkout-flow (ubuntu-26.04, node 24)', 'FAILURE'), check('secret-scan', 'FAILURE')],
    }),
    [MOBILE(1977)]: classifyRaw(MOBILE(1977), { number: 1977, title: 't', state: 'OPEN', mergeStateStatus: 'CLEAN', statusCheckRollup: [] }),
    [COURSE(19)]: { url: COURSE(19), number: 19, title: '', state: 'skipped' as const, failing: [] },
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
