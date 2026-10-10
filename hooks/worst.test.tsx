import { describe, expect, mock, test } from 'claude-code/testing'

const pane = (bodyColumns: number) => ({ component: 'Pane', requestId: 'fleet-board', props: { title: 'Fleet', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 120 }, view: {} } }) as const

describe('worst case', () => {
  test('every surface and width draws the worst-case fixture without a refused tree', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    mock.env(on, { FLEET_BOARD_FIXTURES: '1' })
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))
    await $.command.run({ command: 'fleet-board', args: 'worst', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    for (const surface of ['terminal', 'desktop'] as const) {
      for (const width of [36, 48, 100]) {
        const ui = await $.ui.mount({ plugin: 'fleet', surface, ...pane(width) })
        expect(await ui.find({ text: /updated 2 h ago/ })).toBeDefined()
        expect(await ui.find({ text: /took 23s/ })).toBeDefined()
        expect(await ui.find({ text: /^6\/5 running$/ })).toBeDefined()
        expect((await ui.find({ key: 'fold-queue-default' }))?.props.label).toBe('+8 more')
        expect((await ui.drawn()) && (await ui.find({ text: /Performance pass 7:/ }))).toBeUndefined()
        if (width === 36) {
          expect(await ui.find({ text: /Shipping estimate shows 0/ })).toBeUndefined()
          await ui.unmount()
          continue
        }
        expect(await ui.find({ type: 'Link', text: /pull\/288docs-site#288$/ })).toBeDefined()
        expect(await ui.find({ type: 'Link', text: /pull\/1977mobile-app#1977$/ })).toBeDefined()
        expect(await ui.find({ text: /^web#3100-legacy-cleanup$/ })).toBeDefined()
        if (surface === 'terminal') expect(await ui.find({ text: /\+1$/ })).toBeDefined()
        expect(await ui.find({ text: /Needs you/ })).toBeDefined()
        expect(await ui.find({ text: /^6$/ })).toBeDefined()
        await ui.unmount()
      }
    }
  })
})
