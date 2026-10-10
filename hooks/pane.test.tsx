import { describe, expect, mock, test } from 'claude-code/testing'

import type { View } from '../types'
import { classifyPr, layout, parseBoard } from './model'

const URL = 'https://github.com/northwind-industries/web/pull/2146'

const boardJson = JSON.stringify({
      slots: [
        { scope: 'default', used: 2, max: 5 },
        { scope: 'coursework', used: 1, max: 5 },
        { scope: 'release-freeze', used: 0, max: 2, held: { note: 'Release freeze: no mobile-app merges', at: 1 } },
      ],
      running: [
        { id: 't249', scope: 'default', key: 'northwind-industries/web#2000-courses', label: 'Delete v1 course routes', state: 'mergeable', pr: URL, note: null },
        { id: 't256', scope: 'default', key: 'northwind-industries/web#2151', label: 't256', state: 'launching', pr: null, note: null },
        { id: 't113', scope: 'coursework', key: 'university-team-7/game#poc', label: 'POC handoff setup', state: 'question', pr: null, note: 'paused for polish' },
      ],
      queue: [
        { scope: 'default', position: 1, id: 't257', key: 'k', title: 'School Admin time zone' },
        { scope: 'release-freeze', position: 1, id: 't240', key: 'k', title: 'Mobile onboarding screen' },
      ],
      waiting: [],
      verifying: [{ id: 't196', key: 'northwind-industries/web#2078', pr: null, note: 'awaiting deploy' }],
      net: [{ project: 'web', filed: ['a'], closed: [], net: 1 }],
})

const prJson = JSON.stringify({ number: 2146, title: 't', state: 'OPEN', mergeStateStatus: 'CLEAN', statusCheckRollup: [] })
const graphJson = JSON.stringify({ data: { r0: { pr2146: { number: 2146, title: 't', state: 'OPEN', mergeStateStatus: 'CLEAN', commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] } } } }] } } } } })

const fixture = (): View => {
  const board = parseBoard(boardJson)
  const pr = classifyPr(URL, JSON.stringify({ number: 2146, title: 't', state: 'OPEN', mergeStateStatus: 'CLEAN', statusCheckRollup: [] }))
  return { board, prs: { [URL]: pr }, titles: { t256: 'Fix the learner walks' }, updatedAt: 0, error: null }
}

describe('layout', () => {
  test('groups tasks by scope, keeps each queue apart, and names a launching task by its title', async () => {
    const plan = layout(fixture(), 'all')
    expect(plan.cards.map(c => [c.slot.scope, c.running.map(t => t.id), c.queue.map(q => q.id)])).toEqual([
      ['default', ['t249', 't256'], ['t257']],
      ['coursework', ['t113'], []],
      ['release-freeze', [], ['t240']],
    ])
    expect(plan.attention.map(a => `${a.pr ? 'pr' : 'question'}:${a.id}`)).toEqual(['pr:t249', 'question:t113'])
    expect(plan.cards[2]?.slot.holdNote).toBe('Release freeze: no mobile-app merges')
  })

  test('the scope filter narrows every section', async () => {
    const plan = layout(fixture(), 'coursework')
    expect(plan.cards.map(c => c.slot.scope)).toEqual(['coursework'])
    expect(plan.attention.map(a => a.id)).toEqual(['t113'])
    expect(plan.verifying).toEqual([])
  })
})

const PANE = { component: 'Pane', requestId: 'fleet-board', props: { title: 'Fleet', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } } as const

describe('pane', () => {
  test('draws on the terminal and the desktop, and a row press opens its note', async ($, on) => {
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    on('process.run', async (_$, e) => {
      if (e.argv[0] === '/bin/sh') return out('/fake/gh\n')
      if (e.argv[1] === 'board') return out(boardJson)
      if (e.argv[1] === 'api') return out(graphJson)
      return out('', 1)
    })
    mock.clock(on)
    mock.store(on)
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))
    await $.command.run({ command: 'fleet-board', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'fleet', surface, ...PANE })
      expect(await ui.find({ text: /^Needs you$/ })).toBeDefined()
      expect(await ui.find({ text: /^1 ready$/ })).toBeDefined()
      expect(await ui.find({ text: /web#2151/ })).toBeDefined()
      expect(await ui.find({ text: /ready to merge/ })).toBeDefined()
      expect(await ui.find({ text: /Release freeze: no mobile-app merges/ })).toBeDefined()
      expect(await ui.find({ text: /university-team-7\/game#poc/ })).toBeUndefined()
      await ui.press({ key: 'task-t113' })
      expect(await ui.find({ text: /university-team-7\/game#poc/ })).toBeDefined()
      await ui.press({ key: 'task-t113' })
      await ui.unmount()
    }
  })
})

describe('pane width', () => {
  test('a docked width the person dragged to is reopened at, and an inline pane does not overwrite it', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    const opened: Array<number | undefined> = []
    on('ui.open', async (_$, e) => {
      opened.push(e.columns)
      return { value: { isPlaced: true as const } }
    })
    on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: 'offline', isStdoutTruncated: false, isStderrTruncated: false } }))
    const run = () => $.command.run({ command: 'fleet-board', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    await run()
    const docked = await $.ui.mount({ plugin: 'fleet', surface: 'desktop', ...PANE, props: { ...PANE.props, bodyColumns: 64, placement: 'dock' } })
    await docked.unmount()
    const inline = await $.ui.mount({ plugin: 'fleet', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 120, placement: 'inline' } })
    await inline.unmount()
    await run()
    expect(opened).toEqual([undefined, 64])
  })
})
