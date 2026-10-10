import { describe, expect, test } from 'claude-code/testing'

import { bandLine, changes, classifyPr, emptyView, parseBoard, prRef, trackedPrs } from './model'

const boardJson = JSON.stringify({
  slots: [
    { scope: 'default', used: 5, max: 5 },
    { scope: 'release-freeze', used: 0, max: 2, held: { note: 'swap', at: 1 } },
  ],
  running: [
    { id: 't249', scope: 'default', key: 'northwind-industries/web#2000-v1-wave3-courses', label: 'Delete v1 course routes', state: 'mergeable', pr: 'https://github.com/northwind-industries/web/pull/2146', note: null },
    { id: 't251', scope: 'default', key: 'northwind-industries/web#2000-v1-wave3-assignments', label: 'Delete v1 assignment routes', state: 'working', pr: null, note: null },
  ],
  queue: [{ scope: 'default', position: 1, id: 't256', key: 'northwind-industries/web#2151', title: 'Fix the learner walks', by: null }],
  waiting: [{ id: 't253', key: 'k', title: 'Tooling routes', after: ['northwind-industries/web#2141'] }],
  verifying: [{ id: 't196', key: 'northwind-industries/web#2078', pr: null, note: 'awaiting deploy' }],
  net: [{ project: 'web', filed: ['a', 'b', 'c'], closed: ['d'], net: 2 }],
})

const pr = (state: string, mergeStateStatus: string, checks: object[]) =>
  JSON.stringify({ number: 2146, title: 't', state, mergeStateStatus, statusCheckRollup: checks })

const URL = 'https://github.com/northwind-industries/web/pull/2146'

describe('classifyPr', () => {
  test('green and clean is ready to merge', async () => {
    expect(classifyPr(URL, pr('OPEN', 'CLEAN', [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }])).state).toBe('ready')
  })
  test('a conflict wins over green checks', async () => {
    expect(classifyPr(URL, pr('OPEN', 'DIRTY', [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }])).state).toBe('conflict')
  })
  test('a failed check with nothing pending is red and names the check', async () => {
    const info = classifyPr(URL, pr('OPEN', 'BLOCKED', [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }]))
    expect(info.state).toBe('red')
    expect(info.failing).toEqual(['ci'])
  })
  test('a pending check is CI running, never ready', async () => {
    expect(classifyPr(URL, pr('OPEN', 'CLEAN', [{ name: 'ci', status: 'IN_PROGRESS' }])).state).toBe('running')
  })
  test('merged is merged', async () => {
    expect(classifyPr(URL, pr('MERGED', 'UNKNOWN', [])).state).toBe('merged')
  })
})

describe('board', () => {
  test('parses slots, holds, waiting and net', async () => {
    const board = parseBoard(boardJson)
    expect(board.slots[1]?.held).toBe(true)
    expect(board.waiting[0]?.after).toBe('northwind-industries/web#2141')
    expect(board.net[0]).toEqual({ project: 'web', net: 2, filed: 3, closed: 1 })
    expect(trackedPrs(board)).toEqual([URL])
    expect(prRef(URL)).toBe('web#2146')
  })

  test('the band line counts what needs you', async () => {
    const board = parseBoard(boardJson)
    const line = bandLine({ board, prs: { [URL]: classifyPr(URL, pr('OPEN', 'CLEAN', [])) }, titles: {}, updatedAt: 1, error: null })
    expect(line).toBe('fleet 5/5 · 1 ready to merge · queue 1 · waiting 1 · net today web +2')
  })
})

describe('changes', () => {
  test('nothing is announced on the first read', async () => {
    const board = parseBoard(boardJson)
    expect(changes(emptyView, { board, prs: {}, titles: {}, updatedAt: 1, error: null })).toEqual([])
  })

  test('a PR turning green, a new launch and a question are each announced once', async () => {
    const board = parseBoard(boardJson)
    const before = { board, prs: { [URL]: classifyPr(URL, pr('OPEN', 'CLEAN', [{ name: 'ci', status: 'IN_PROGRESS' }])) }, titles: {}, updatedAt: 1, error: null }
    const next = parseBoard(boardJson)
    next.running = [
      ...next.running.map(t => (t.id === 't251' ? { ...t, state: 'question', note: 'which window?' } : t)),
      { id: 't256', scope: 'default', key: 'k', label: 'Fix the learner walks', state: 'launching', pr: null, note: null },
    ]
    const after = { board: next, prs: { [URL]: classifyPr(URL, pr('OPEN', 'CLEAN', [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }])) }, titles: {}, updatedAt: 2, error: null }
    expect(changes(before, after)).toEqual([
      'web#2146 is green and ready to merge',
      't251 has a question: which window?',
      't256 ready to launch: Fix the learner walks',
    ])
    expect(changes(after, after)).toEqual([])
  })
})

import { parsePrUrl, prQuery, readPrQuery } from './model'

describe('batched PR query', () => {
  const urls = ['https://github.com/northwind-industries/web/pull/2146', 'https://github.com/northwind-industries/web/pull/2149', 'https://github.com/northwind-industries/docs-site/pull/239']
  const refs = urls.map(u => parsePrUrl(u)!)

  test('one query, one repository block per repo, one alias per PR', async () => {
    const q = prQuery(refs)
    expect(q.match(/repository\(/g)?.length).toBe(2)
    expect(q).toContain('pr2146: pullRequest(number: 2146)')
    expect(q).toContain('pr239: pullRequest(number: 239)')
  })

  test('reads each PR back by its alias and classifies it; a missing node is left out', async () => {
    const checks = (conclusion: string) => ({ nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion }] } } } }] })
    const json = JSON.stringify({ data: {
      r0: { pr2146: { number: 2146, title: 'a', state: 'OPEN', mergeStateStatus: 'CLEAN', commits: checks('SUCCESS') }, pr2149: { number: 2149, title: 'b', state: 'OPEN', mergeStateStatus: 'BLOCKED', commits: checks('FAILURE') } },
      r1: { pr239: null },
    } })
    const read = readPrQuery(refs, json).prs
    expect(read[urls[0]!]?.state).toBe('ready')
    expect(read[urls[1]!]?.state).toBe('red')
    expect(read[urls[1]!]?.failing).toEqual(['ci'])
    expect(read[urls[2]!]).toBeUndefined()
  })
})

describe('repositories this account cannot read', () => {
  test('a null repository is left out while the rest still read, and no data at all is a failure', async () => {
    const refs = ['https://github.com/acme/web/pull/1', 'https://github.com/someone-else/private/pull/2'].map(u => parsePrUrl(u)!)
    const partial = JSON.stringify({ data: { r0: { pr1: { number: 1, title: 'a', state: 'MERGED', mergeStateStatus: 'UNKNOWN', commits: { nodes: [] } } }, r1: null }, errors: [{ type: 'NOT_FOUND', path: ['r1'] }] })
    const read = readPrQuery(refs, partial)
    expect(read.ok).toBe(true)
    expect(Object.keys(read.prs)).toEqual(['https://github.com/acme/web/pull/1'])
    expect(readPrQuery(refs, '').ok).toBe(false)
    expect(readPrQuery(refs, JSON.stringify({ errors: [{ message: 'Bad credentials' }] })).ok).toBe(false)
  })
})
