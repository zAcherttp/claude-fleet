import { describe, expect, mock, test } from 'claude-code/testing'

import type { View } from '../types'
import { classifyPr, layout, parseBoard } from './model'

const URL = 'https://github.com/northwind-industries/web/pull/4146'

const boardJson = JSON.stringify({
      slots: [
        { scope: 'default', used: 2, max: 5 },
        { scope: 'coursework', used: 1, max: 5 },
        { scope: 'release-freeze', used: 0, max: 2, held: { note: 'Release freeze: no mobile-app merges', at: 1 } },
      ],
      running: [
        { id: 't401', scope: 'default', key: 'northwind-industries/web#3100-photos', label: 'Archive old product photos', state: 'mergeable', pr: URL, note: null },
        { id: 't403', scope: 'default', key: 'northwind-industries/web#3151', label: 't403', state: 'launching', pr: null, note: null },
        { id: 't406', scope: 'coursework', key: 'university-team-7/game#editor', label: 'Level editor hand-off', state: 'question', pr: null, note: 'paused for polish' },
      ],
      queue: [
        { scope: 'default', position: 1, id: 't407', key: 'k', title: 'Store time zone setting' },
        { scope: 'release-freeze', position: 1, id: 't408', key: 'k', title: 'Mobile onboarding screen' },
      ],
      waiting: [],
      verifying: [{ id: 't405', key: 'northwind-industries/web#2078', pr: null, note: 'awaiting deploy' }],
      net: [{ project: 'web', filed: ['a'], closed: [], net: 1 }],
})

const prJson = JSON.stringify({ number: 4146, title: 't', state: 'OPEN', mergeStateStatus: 'CLEAN', statusCheckRollup: [] })
const graphJson = JSON.stringify({ data: { r0: { pr4146: { number: 4146, title: 't', state: 'OPEN', mergeStateStatus: 'CLEAN', commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] } } } }] } } } } })

const fixture = (): View => {
  const board = parseBoard(boardJson)
  const pr = classifyPr(URL, JSON.stringify({ number: 4146, title: 't', state: 'OPEN', mergeStateStatus: 'CLEAN', statusCheckRollup: [] }))
  return { board, prs: { [URL]: pr }, titles: { t403: 'Fix the checkout walkthrough' }, updatedAt: 0, error: null }
}

describe('layout', () => {
  test('groups tasks by scope, keeps each queue apart, and names a launching task by its title', async () => {
    const plan = layout(fixture(), 'all')
    expect(plan.cards.map(c => [c.slot.scope, c.running.map(t => t.id), c.queue.map(q => q.id)])).toEqual([
      ['default', ['t401', 't403'], ['t407']],
      ['coursework', ['t406'], []],
      ['release-freeze', [], ['t408']],
    ])
    expect(plan.attention.map(a => `${a.pr ? 'pr' : 'question'}:${a.id}`)).toEqual(['pr:t401', 'question:t406'])
    expect(plan.cards[2]?.slot.holdNote).toBe('Release freeze: no mobile-app merges')
  })

  test('the scope filter narrows every section', async () => {
    const plan = layout(fixture(), 'coursework')
    expect(plan.cards.map(c => c.slot.scope)).toEqual(['coursework'])
    expect(plan.attention.map(a => a.id)).toEqual(['t406'])
    expect(plan.verifying).toEqual([])
  })
})

const PANE = { component: 'Pane', requestId: 'fleet-board', props: { title: 'Fleet', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } } as const

describe('pane', () => {
  test('draws on the terminal and the desktop, and a row press opens its note', async ($, on) => {
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const envs: Array<Record<string, string> | undefined> = []
    on('process.run', async (_$, e) => {
      envs.push(e.init?.env)
      if (e.argv[0] === 'node' && e.argv.includes('board')) return out(boardJson)
      if (e.argv[0] === 'gh') return out(graphJson)
      return out('', 1)
    })
    mock.clock(on)
    mock.store(on)
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))
    await $.command.run({ command: 'fleet-board', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    expect(envs.length).toBeGreaterThan(0)
    expect(envs.some(env => env !== undefined && 'PATH' in env)).toBe(false)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'fleet', surface, ...PANE })
      expect(await ui.find({ text: /^Needs you$/ })).toBeDefined()
      expect(await ui.find({ text: /^1 ready$/ })).toBeDefined()
      expect(await ui.find({ text: /web#3151/ })).toBeDefined()
      expect(await ui.find({ text: /ready to merge/ })).toBeDefined()
      expect(await ui.find({ text: /Release freeze: no mobile-app merges/ })).toBeDefined()
      expect(await ui.find({ text: /university-team-7\/game#editor/ })).toBeUndefined()
      await ui.press({ key: 'task-t406' })
      expect(await ui.find({ text: /university-team-7\/game#editor/ })).toBeDefined()
      await ui.press({ key: 'task-t406' })
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

describe('failure paths', () => {
  test('a missing node is explained on the pane instead of a bare exit code', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))
    on('process.run', async () => ({ deny: 'spawn node ENOENT' }))
    await $.command.run({ command: 'fleet-board', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'fleet', surface, ...PANE })
      expect(await ui.find({ text: /Node\.js isn't on the PATH/ })).toBeDefined()
      await ui.unmount()
    }
  })
})
