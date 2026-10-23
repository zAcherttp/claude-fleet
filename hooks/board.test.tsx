import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const MINUTE = 60_000

const BAND = { plugin: 'fleet', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const

const board = JSON.stringify({ slots: [{ scope: 'default', used: 0, max: 5 }], running: [], queue: [], waiting: [], verifying: [], net: {} })

function world(on: On, env: Record<string, string> = {}) {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, env)
  const open = new Set<string>()
  const polls = { count: 0 }
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('ui.open', async (_$, e) => {
    open.add(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('ui.panes', async () => ({ value: [...open].map(id => ({ id, title: 'Fleet', isShown: true, isFocused: false, isPlaced: true })) }))
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'node' && e.argv.includes('board')) polls.count += 1
    return { value: { exitCode: 0, stdout: board, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { clock, polls }
}

const openBoard = ($: Engine) =>
  $.command.run({ command: 'fleet-board', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

describe('board is opt-in', () => {
  test('by default no band renders and no poll fires', async ($, on) => {
    const { clock, polls } = world(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.advance(5 * MINUTE)
    expect(polls.count).toBe(0)
    const band = await $.ui.mount(BAND)
    expect(await band.find({ key: 'hide' })).toBeUndefined()
    await band.unmount()
  })

  test('after /fleet-board the band renders and the poll runs, and hiding the band leaves it running while the pane is up', async ($, on) => {
    const { clock, polls } = world(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await openBoard($)
    expect(polls.count).toBe(1)
    await clock.advance(2 * MINUTE)
    expect(polls.count).toBe(3)
    const band = await $.ui.mount(BAND)
    expect(await band.find({ key: 'hide' })).toBeDefined()
    await band.press({ key: 'hide' })
    await clock.advance(2 * MINUTE)
    expect(polls.count).toBe(5)
    await band.unmount()
  })

  test('with FLEET_BOARD=on the band shows from session start', async ($, on) => {
    const { clock, polls } = world(on, { FLEET_BOARD: 'on' })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(polls.count).toBe(1)
    await clock.advance(MINUTE)
    expect(polls.count).toBe(2)
    const band = await $.ui.mount(BAND)
    expect(await band.find({ key: 'hide' })).toBeDefined()
    await band.unmount()
  })

  test('hiding the band with no pane up stops the poll', async ($, on) => {
    const { clock, polls } = world(on, { FLEET_BOARD: 'on' })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.advance(MINUTE)
    expect(polls.count).toBe(2)
    const band = await $.ui.mount(BAND)
    await band.press({ key: 'hide' })
    await band.unmount()
    await clock.advance(5 * MINUTE)
    expect(polls.count).toBe(2)
  })
})
