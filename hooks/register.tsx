import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { PrInfo, PrState, RunningTask, Slot, View } from '../types'
import type { IconKind, PrRef } from './model'
import { worstView } from './worst'
import { bandLine, changes, classifyPr, counts, emptyView, layout, meterSvg, meterText, parseBoard, prLabel, prRef, ago, iconSvg, parsePrUrl, prShort, prQuery, stateIcon, readPrQuery, rememberTitles, titleOf, trackedPrs } from './model'

const PANE = 'fleet-board'
const POLL_MS = 60_000
const view = atom({ plugin: 'fleet', key: 'view' } as const, emptyView)
const isBandHidden = atom({ plugin: 'fleet', key: 'isBandHidden' } as const, false)
const expanded = atom({ plugin: 'fleet', key: 'expanded' } as const, [] as string[])
const scopeFilter = atom({ plugin: 'fleet', key: 'scopeFilter' } as const, 'all')
const fixture = atom({ plugin: 'fleet', key: 'fixture' } as const, 'live')
const openSections = atom({ plugin: 'fleet', key: 'openSections' } as const, [] as string[])

const prTone: Record<PrState, 'success' | 'error' | 'warning' | 'merged' | 'subtle'> = {
  ready: 'success',
  red: 'error',
  conflict: 'warning',
  running: 'subtle',
  merged: 'merged',
  closed: 'subtle',
  blocked: 'warning',
  unknown: 'subtle',
  skipped: 'subtle',
}

const COL = { id: 7, state: 12, link: 16, pr: 16 } as const
const QUEUE_SHOWN = 5
const LINK_TAB = 18

const shortLabel: Record<PrState, string> = { ready: 'ready', red: 'red', conflict: 'conflict', running: 'CI running', merged: 'merged', closed: 'closed', blocked: 'blocked', unknown: 'checking', skipped: 'no access' }

const centre = (label: string, width: number) => {
  const room = Math.max(0, width - label.length)
  const left = Math.floor(room / 2)
  return ' '.repeat(left) + label + ' '.repeat(room - left)
}

const stateTone = (state: string) =>
  state === 'question' ? 'warning' : state === 'mergeable' ? 'success' : state === 'launching' ? 'claude' : 'subtle'

let busy = false
let again = false
let tools: { fleet: string; gh: string } | null = null

const QUIET_ENV = { GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1', NO_COLOR: '1', PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' }

async function locate($: EngineInterface) {
  if (tools) return tools
  const found = await $.process.run(['/bin/sh', '-c', 'command -v gh'], { env: QUIET_ENV, timeoutMs: 5_000 })
  const gh = found.stdout.trim()
  if (!gh) throw new Error('gh not found on PATH')
  tools = { fleet: `${$.plugin.root}/bin/fleet`, gh }
  return tools
}

async function poll($: EngineInterface) {
  if (busy) {
    again = true
    return
  }
  busy = true
  await update($, view, v => ({ ...v, refreshing: true }))
  try {
    const started = await $.clock.now()
    const { fleet, gh } = await locate($)
    const boardRun = await $.process.run([fleet, 'board', '--all', '--json'], { env: QUIET_ENV, timeoutMs: 10_000 })
    if (boardRun.exitCode !== 0) throw new Error(`fleet board exited ${boardRun.exitCode}`)
    const board = parseBoard(boardRun.stdout)
    const boardDone = await $.clock.now()
    const before: View = await read($, view)
    const refs = trackedPrs(board).map(parsePrUrl).filter((r): r is PrRef => r !== null)
    const prs: Record<string, PrInfo> = {}
    let prError: string | null = null
    if (refs.length > 0) {
      const run = await $.process.run([gh, 'api', 'graphql', '-f', `query=${prQuery(refs)}`], { env: QUIET_ENV, timeoutMs: 10_000 })
      const answer = readPrQuery(refs, run.stdout)
      if (!answer.ok) prError = (run.stderr.trim().split('\n')[0] || `gh exited ${run.exitCode}`).slice(0, 200)
      for (const r of refs) {
        prs[r.url] = answer.prs[r.url] ?? (answer.ok ? { url: r.url, number: r.number, title: '', state: 'skipped', failing: [] } : (before.prs[r.url] ?? { url: r.url, number: r.number, title: '', state: 'unknown', failing: [] }))
      }
    }
    const ended = await $.clock.now()
    const after: View = {
      board,
      prs,
      titles: rememberTitles(board, before.titles ?? {}),
      updatedAt: ended,
      error: null,
      refreshing: false,
      prError,
      timings: { boardMs: boardDone - started, prsMs: ended - boardDone, totalMs: ended - started, prCount: refs.length },
    }
    await update($, view, () => after)
    for (const line of changes(before, after)) $.ui.toast(line)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, view, v => ({ ...v, error: message, refreshing: false }))
  } finally {
    busy = false
    if (again) {
      again = false
      void poll($)
    }
  }
}

const flip = (ids: string[], id: string) => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id])

let savedColumns: number | null = null

async function openPane($: EngineInterface) {
  const columns = await $.store.get('paneColumns')
  return $.ui.open({ id: PANE, title: 'Fleet', ...(typeof columns === 'number' && columns >= 30 ? { columns } : {}) })
}

async function rememberWidth($: EngineInterface, placement: string, columns: number) {
  if (placement !== 'dock' || columns < 30 || columns === savedColumns) return
  savedColumns = columns
  await $.store.set('paneColumns', columns)
}

async function shown($: EngineInterface): Promise<View> {
  return (await read($, fixture)) === 'worst' ? worstView(await $.clock.now()) : read($, view)
}

async function toggleRow($: EngineInterface, id: string) {
  await update($, expanded, ids => flip(ids, id))
}

async function toggleSection($: EngineInterface, id: string) {
  await update($, openSections, ids => flip(ids, id))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'fleet-board', description: 'Open the live fleet board (slots, tasks, PR readiness, queue)' })
    $.clock.every(POLL_MS, () => void poll($))
    void poll($)
    return next(e)
  })

  on('command.run', { command: 'fleet-board' }, async ($, e) => {
    const arg = e.args.trim()
    if ((arg === 'worst' || arg === 'live') && (await $.env.get('FLEET_BOARD_FIXTURES')) === '1') {
      await update($, fixture, () => arg)
      await openPane($)
      return { text: arg === 'worst' ? 'Fleet board: showing the worst-case fixture. /fleet-board live to go back.' : 'Fleet board: showing live data.' }
    }
    await update($, isBandHidden, () => false)
    await poll($)
    await openPane($)
    return { text: 'Fleet board opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isBandHidden))) return next(e)
    const current = await shown($)
    const { Box, Button, Text } = $.ui.resolve(e)
    const c = counts(current)
    return (
      <Box gap={1}>
        <Text color={c.red || c.conflict ? 'warning' : c.ready ? 'success' : 'subtle'} wrap="truncate-end">{bandLine(current)}</Text>
        <Button key="open" plain onPress={() => void openPane($)}>board</Button>
        <Button key="hide" plain onPress={() => void update($, isBandHidden, () => true)}>hide</Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    void rememberWidth($, e.props.placement, e.props.bodyColumns)
    const current = await shown($)
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    if (current.board === null) {
      return <Text dimColor>{current.error ? `Could not read the board: ${current.error}` : 'Reading the board…'}</Text>
    }
    const filter = await read($, scopeFilter)
    const open = await read($, openSections)
    const rowsOpen = await read($, expanded)
    const plan = layout(current, filter)
    const age = ago((await $.clock.now()) - current.updatedAt)
    const idWidth = Math.max(COL.id, 3 + Math.max(0, ...(current.board?.running ?? []).map(t => t.id.length), ...(current.board?.queue ?? []).map(q => q.id.length)))
    const c = counts(current)
    const wide = (e.props.bodyColumns ?? 80) >= 72
    const compact = (e.props.bodyColumns ?? 80) < 44

    let picker: RenderChildren = null
    if (e.surface !== 'mobile') {
      const { Select } = $.ui.resolve(e)
      picker = <Select key="scope" label="Show" options={plan.scopes.map(s => ({ value: s, label: s === 'all' ? 'all groups' : s }))} value={filter} onSelect={(value: string) => void update($, scopeFilter, () => value)} />
    }
    let meter = (slot: Slot) => <Text color={slot.held ? 'warning' : 'success'}>{meterText(slot)}</Text>
    let icon = (_kind: IconKind): RenderChildren => null
    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      icon = (kind: IconKind) => <Box width={2} flexShrink={0} alignSelf="flex-start"><Svg source={iconSvg(kind)} alt={kind} width={14} height={14} /></Box>
      meter = (slot: Slot) => <Svg source={meterSvg(slot)} alt={`${slot.used} of ${slot.max} slots in use${slot.held ? ', held' : ''}`} height={10} />
    }

    const badge = (label: string, tone: string, width?: number, key?: string) => (
      <Box key={key} width={width} flexShrink={0} backgroundColor={tone} paddingX={1} flexDirection="column" justifyContent="center" alignItems="center">
        <Text color="inverseText" bold wrap="truncate-end">{label}</Text>
      </Box>
    )
    const indent = idWidth + 1 + (e.surface === 'desktop' ? 3 : 0) + COL.state + 1
    const cell = (width: number, child: RenderChildren, key?: string) => (
      <Box key={key} width={width} flexShrink={0} alignSelf="flex-start">{child}</Box>
    )
    const prCells = (url: string | null, pr: PrInfo | undefined) =>
      wide
        ? [
            cell(COL.link, url ? <Link href={url}>{prShort(url)}</Link> : <Text> </Text>, 'link'),
            url ? icon(pr?.state ?? 'unknown') : cell(2, <Text> </Text>, 'pr-icon'),
            url ? badge(prLabel[pr?.state ?? 'unknown'], prTone[pr?.state ?? 'unknown'], COL.pr, 'pr') : cell(COL.pr, <Text> </Text>, 'pr'),
          ]
        : []

    const taskRow = (task: RunningTask) => {
      const isOpen = rowsOpen.includes(task.id)
      const pr = task.pr ? current.prs[task.pr] : undefined
      return (
        <Box key={`row-${task.id}`} flexDirection="column" hover={{ scope: task.id, backgroundColor: 'subtle' }}>
          <Box gap={1}>
            {cell(idWidth, <Button key={`task-${task.id}`} label={`${isOpen ? '▾' : '▸'} ${task.id}`} plain onPress={() => void toggleRow($, task.id)} />)}
            {icon(stateIcon(task.state))}
            {badge(task.state, stateTone(task.state), COL.state)}
            {!compact && <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={8}>
              <Text wrap="truncate-end">{titleOf(task, current.titles)}</Text>
              {!wide && task.pr && (
                <Box gap={1}>
                  <Box width={LINK_TAB} flexShrink={1} minWidth={6} overflow="hidden"><Link href={task.pr}>{prShort(task.pr)}</Link></Box>
                  <Box flexGrow={1} />
                  {icon(pr?.state ?? 'unknown')}
                  {badge(prLabel[pr?.state ?? 'unknown'], prTone[pr?.state ?? 'unknown'])}
                  <Box width={1} flexShrink={0} />
                </Box>
              )}
            </Box>}
            {prCells(task.pr, pr)}
          </Box>
          {isOpen && (
            <Box flexDirection="column" paddingLeft={compact ? 2 : indent}>
              {compact && <Text wrap="wrap">{titleOf(task, current.titles)}</Text>}
              {compact && task.pr && <Text><Link href={task.pr}>{prShort(task.pr)}</Link> <Text color={prTone[pr?.state ?? 'unknown']}>{prLabel[pr?.state ?? 'unknown']}</Text></Text>}
              <Text dimColor wrap="truncate-end">{task.key}</Text>
              {task.note && <Text wrap="wrap">{task.note}</Text>}
              {pr && pr.failing.length > 0 && <Text color="error" wrap="wrap">failing: {pr.failing.join(', ')}</Text>}
            </Box>
          )}
        </Box>
      )
    }

    const header = (label: string, count?: number) => (
      <Box gap={1}>
        <Text bold>{label}</Text>
        {count !== undefined && <Text dimColor>{count}</Text>}
      </Box>
    )

    const ready = plan.attention.filter(a => a.pr?.state === 'ready').length
    const red = plan.attention.filter(a => a.pr?.state === 'red').length
    const conflict = plan.attention.filter(a => a.pr?.state === 'conflict').length
    const questions = plan.attention.filter(a => a.note !== null).length

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column" gap={1}>
          <Box gap={1} flexWrap="wrap" alignItems="center">
            <Button key="refresh" plain onPress={() => void poll($)}>{current.refreshing ? 'Refreshing…' : 'Refresh'}</Button>
            <Text dimColor>updated {age}</Text>
            {current.timings && current.timings.totalMs >= 5000 && (
              <Text color="warning" hover={{ scope: 'slow-refresh', underline: true }}>· took {(current.timings.totalMs / 1000).toFixed(0)}s</Text>
            )}
            {picker}
          </Box>
          {current.prError && <Text color="error" wrap="wrap">PR status unavailable: {current.prError}</Text>}
          <Box gap={1} flexWrap="wrap">
            {badge(`${c.used}/${c.max} running`, c.used > c.max ? 'warning' : c.used === c.max ? 'subtle' : 'success', undefined, 's')}
            {ready > 0 && badge(`${ready} ready`, 'success', undefined, 'r')}
            {red > 0 && badge(`${red} red`, 'error', undefined, 'x')}
            {conflict > 0 && badge(`${conflict} conflict`, 'warning', undefined, 'c')}
            {questions > 0 && badge(`${questions} question${questions === 1 ? '' : 's'}`, 'warning', undefined, 'q')}
          </Box>
        </Box>

        <Box flexDirection="column" borderStyle="round" borderColor={plan.attention.length ? 'warning' : 'subtle'} paddingX={1}>
          {header('Needs you', plan.attention.length)}
          {plan.attention.length === 0 && <Text dimColor>Nothing waiting on you.</Text>}
          {plan.attention.map(item => (
            <Box key={`att-${item.id}`} gap={1} hover={{ scope: item.id, backgroundColor: 'subtle' }}>
              {cell(idWidth, <Text bold>{item.id}</Text>)}
              {icon(item.pr ? item.pr.state : 'question')}
              {item.pr ? badge(shortLabel[item.pr.state], prTone[item.pr.state], COL.state) : badge('question', 'warning', COL.state)}
              {!compact && <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={8}>
                <Text wrap="truncate-end">{item.title}</Text>
                {item.pr && !wide && (
                  <Box gap={1}>
                    <Box width={LINK_TAB} flexShrink={1} minWidth={6} overflow="hidden"><Link href={item.pr.url}>{prShort(item.pr.url)}</Link></Box>
                    <Box flexGrow={1} />
                    {item.scope !== 'default' && <Text dimColor>{item.scope}</Text>}
                    <Box width={1} flexShrink={0} />
                  </Box>
                )}
                {!item.pr && !wide && item.scope !== 'default' && <Text dimColor>{item.scope}</Text>}
                {item.pr && item.pr.failing.length > 0 && (
                  <Text color="error" wrap="truncate-end">failing: {item.pr.failing.slice(0, 3).join(', ')}{item.pr.failing.length > 3 ? ` +${item.pr.failing.length - 3}` : ''}</Text>
                )}
                {item.note !== null && (
                  <Box gap={1}>
                    {item.pr && <Text color="warning">question:</Text>}
                    <Box flexGrow={1} flexShrink={1} minWidth={8}><Text dimColor wrap="truncate-end">{item.note.replace(/\s+/g, ' ')}</Text></Box>
                  </Box>
                )}
              </Box>}
              {wide && cell(COL.link, item.pr ? <Link href={item.pr.url}>{prShort(item.pr.url)}</Link> : <Text dimColor wrap="truncate-end">{item.scope !== 'default' ? item.scope : ''}</Text>)}
            </Box>
          ))}
        </Box>

        {plan.cards.map(card => (
          <Box key={`card-${card.slot.scope}`} flexDirection="column" borderStyle="round" borderColor={card.slot.held ? 'warning' : 'subtle'} paddingX={1}>
            <Box gap={1}>
              <Text bold>{card.slot.scope}</Text>
              {meter(card.slot)}
              <Text dimColor>{card.slot.used}/{card.slot.max}</Text>
              {card.slot.held && icon('held')}
              {card.slot.held && badge('held', 'warning', 6)}
            </Box>
            {card.slot.held && card.slot.holdNote && (
              <Box gap={1}>
                <Button key={`hold-${card.slot.scope}`} label={open.includes(`hold-${card.slot.scope}`) ? '▾' : '▸'} plain onPress={() => void toggleSection($, `hold-${card.slot.scope}`)} />
                <Box flexGrow={1} flexShrink={1} minWidth={8}>
                  <Text color="warning" wrap={open.includes(`hold-${card.slot.scope}`) ? 'wrap' : 'truncate-end'}>{card.slot.holdNote}</Text>
                </Box>
              </Box>
            )}
            {card.running.length === 0 && card.queue.length === 0 && <Text dimColor>Empty.</Text>}
            {card.running.map(taskRow)}
            {card.queue.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text dimColor bold>Up next</Text>
                {(open.includes(`queue-${card.slot.scope}`) ? card.queue : card.queue.slice(0, QUEUE_SHOWN)).map(q => (
                  <Box key={`q-${q.id}`} gap={1}>
                    {cell(idWidth, <Text dimColor>{q.position}. {q.id}</Text>)}
                    {icon('queued')}
                    {badge('queued', 'subtle', COL.state)}
                    {!compact && <Box flexGrow={1} flexShrink={1} minWidth={8}><Text wrap="truncate-end">{q.title}</Text></Box>}
                  </Box>
                ))}
                {card.queue.length > QUEUE_SHOWN && (
                  <Button key={`fold-queue-${card.slot.scope}`} label={open.includes(`queue-${card.slot.scope}`) ? 'Show fewer' : `+${card.queue.length - QUEUE_SHOWN} more`} plain onPress={() => void toggleSection($, `queue-${card.slot.scope}`)} />
                )}
              </Box>
            )}
          </Box>
        ))}

        {(plan.waiting.length > 0 || plan.verifying.length > 0) && (
          <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
            {plan.waiting.length > 0 && (
              <Button key="fold-waiting" label={`${open.includes('waiting') ? '▾' : '▸'} Waiting on another task or PR · ${plan.waiting.length}`} plain onPress={() => void toggleSection($, 'waiting')} />
            )}
            {open.includes('waiting') && plan.waiting.map(w => (
              <Box key={`w-${w.id}`} gap={1}>
                {cell(idWidth, <Text>{w.id}</Text>)}
                {icon('running')}
                {badge('waiting', 'subtle', COL.state)}
                {!compact && (
                  <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={8}>
                    <Text wrap="truncate-end">{w.title}</Text>
                    <Text dimColor wrap="truncate-end">after {w.after.split(', ').map(ref => ref.replace(/^[^/]+\//, '')).join(', ')}</Text>
                  </Box>
                )}
              </Box>
            ))}
            {plan.verifying.length > 0 && (
              <Button key="fold-verifying" label={`${open.includes('verifying') ? '▾' : '▸'} Verifying after merge · ${plan.verifying.length}`} plain onPress={() => void toggleSection($, 'verifying')} />
            )}
            {open.includes('verifying') && plan.verifying.map(v => (
              <Box key={`v-${v.id}`} gap={1}>
                {cell(idWidth, <Text>{v.id}</Text>)}
                {icon('merged')}
                {badge('verifying', 'merged', COL.state)}
                {!compact && (
                  <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={8}>
                    <Text wrap="truncate-end">{v.key.replace(/^[^/]+\//, '')}</Text>
                    {v.note && <Text dimColor wrap="truncate-end">{v.note}</Text>}
                  </Box>
                )}
              </Box>
            ))}
          </Box>
        )}
        {c.net && <Text dimColor wrap="wrap">Net issues today: {c.net}</Text>}
      </Box>
    )
  })
}
