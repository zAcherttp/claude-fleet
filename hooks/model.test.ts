import { describe, expect, test } from 'claude-code/testing'

import { bandLine, changes, classifyPr, emptyView, parseBoard, prRef, trackedPrs } from './model'

const boardJson = JSON.stringify({
  slots: [
    { scope: 'default', used: 5, max: 5 },
    { scope: 'release-freeze', used: 0, max: 2, held: { note: 'swap', at: 1 } },
  ],
  running: [
    { id: 't401', scope: 'default', key: 'northwind-industries/web#3100-photos', label: 'Archive old product photos', state: 'mergeable', pr: 'https://github.com/northwind-industries/web/pull/4146', note: null },
    { id: 't402', scope: 'default', key: 'northwind-industries/web#3101-exports', label: 'Archive old order exports', state: 'working', pr: null, note: null },
  ],
  queue: [{ scope: 'default', position: 1, id: 't403', key: 'northwind-industries/web#3151', title: 'Fix the checkout walkthrough', by: null }],
  waiting: [{ id: 't404', key: 'k', title: 'Unused feature flags', after: ['northwind-industries/web#2141'] }],
  verifying: [{ id: 't405', key: 'northwind-industries/web#2078', pr: null, note: 'awaiting deploy' }],
  net: [{ project: 'web', filed: ['a', 'b', 'c'], closed: ['d'], net: 2 }],
})

const pr = (state: string, mergeStateStatus: string, checks: object[]) =>
  JSON.stringify({ number: 4146, title: 't', state, mergeStateStatus, statusCheckRollup: checks })

const URL = 'https://github.com/northwind-industries/web/pull/4146'

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
    expect(prRef(URL)).toBe('web#4146')
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
      ...next.running.map(t => (t.id === 't402' ? { ...t, state: 'question', note: 'which window?' } : t)),
      { id: 't403', scope: 'default', key: 'k', label: 'Fix the checkout walkthrough', state: 'launching', pr: null, note: null },
    ]
    const after = { board: next, prs: { [URL]: classifyPr(URL, pr('OPEN', 'CLEAN', [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }])) }, titles: {}, updatedAt: 2, error: null }
    expect(changes(before, after)).toEqual([
      'web#4146 is green and ready to merge',
      't402 has a question: which window?',
      't403 ready to launch: Fix the checkout walkthrough',
    ])
    expect(changes(after, after)).toEqual([])
  })
})

import { parsePrUrl, prQuery, readPrQuery } from './model'

describe('batched PR query', () => {
  const urls = ['https://github.com/northwind-industries/web/pull/4146', 'https://github.com/northwind-industries/web/pull/4149', 'https://github.com/northwind-industries/docs-site/pull/239']
  const refs = urls.map(u => parsePrUrl(u)!)

  test('one query, one repository block per repo, one alias per PR', async () => {
    const q = prQuery(refs)
    expect(q.match(/repository\(/g)?.length).toBe(2)
    expect(q).toContain('pr4146: pullRequest(number: 4146)')
    expect(q).toContain('pr239: pullRequest(number: 239)')
  })

  test('reads each PR back by its alias and classifies it; a missing node is left out', async () => {
    const checks = (conclusion: string) => ({ nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion }] } } } }] })
    const json = JSON.stringify({ data: {
      r0: { pr4146: { number: 4146, title: 'a', state: 'OPEN', mergeStateStatus: 'CLEAN', commits: checks('SUCCESS') }, pr4149: { number: 4149, title: 'b', state: 'OPEN', mergeStateStatus: 'BLOCKED', commits: checks('FAILURE') } },
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

import { boardFailure, prFailure } from './model'

describe('failure messages', () => {
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })
  const failed = (exitCode: number, stderr: string) => ({ exitCode, stdout: '', stderr })

  test('fleet board: each way it can fail gets its own plain message, and success gets none', async () => {
    expect(boardFailure(ok('{"slots":[]}'))).toBeNull()
    expect(boardFailure({ error: 'spawn node ENOENT' })).toMatch(/Node\.js isn't on the PATH/)
    expect(boardFailure(failed(127, ''))).toMatch(/Node\.js isn't on the PATH/)
    expect(boardFailure({ error: 'process timed out after 10000 ms' })).toMatch(/took longer than 10 s/)
    expect(boardFailure(failed(1, 'SyntaxError: Unexpected token ?'))).toMatch(/Node 18 or newer/)
    expect(boardFailure(failed(1, 'fleet: lock held by pid 4242\n'))).toBe('`fleet board` failed (exit 1): fleet: lock held by pid 4242')
    expect(boardFailure(ok('Warning: something odd'))).toMatch(/something other than JSON \("Warning: something odd"\)/)
  })

  test('gh: missing, signed out, rate limited, offline and unknown each read differently', async () => {
    expect(prFailure(ok('{}'))).toBeNull()
    expect(prFailure({ error: 'spawn gh ENOENT' })).toMatch(/install `gh`/)
    expect(prFailure(failed(4, 'To get started with GitHub CLI, please run:  gh auth login'))).toMatch(/isn't signed in/)
    expect(prFailure(failed(1, 'HTTP 401: Bad credentials'))).toMatch(/isn't signed in/)
    expect(prFailure(failed(1, 'GraphQL: API rate limit exceeded'))).toMatch(/rate limit/)
    expect(prFailure(failed(1, 'dial tcp: lookup api.github.com: no such host'))).toMatch(/Couldn't reach GitHub/)
    expect(prFailure({ error: 'timed out' })).toMatch(/within 10 s/)
    expect(prFailure(failed(1, 'something new\nmore'))).toBe('PR status unavailable: something new')
  })
})
