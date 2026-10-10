export type PrState = 'ready' | 'red' | 'conflict' | 'running' | 'merged' | 'closed' | 'blocked' | 'unknown' | 'skipped'

export type PrInfo = { url: string; number: number; title: string; state: PrState; failing: string[] }

export type RunningTask = { id: string; scope: string; key: string; label: string; state: string; pr: string | null; note: string | null }

export type QueuedTask = { id: string; scope: string; key: string; title: string; position: number }

export type WaitingTask = { id: string; key: string; title: string; after: string }

export type VerifyingTask = { id: string; key: string; pr: string | null; note: string | null }

export type Slot = { scope: string; used: number; max: number; held: boolean; holdNote: string | null }

export type NetRow = { project: string; net: number; filed: number; closed: number }

export type Board = {
  slots: Slot[]
  running: RunningTask[]
  queue: QueuedTask[]
  waiting: WaitingTask[]
  verifying: VerifyingTask[]
  net: NetRow[]
}

export type Timings = { boardMs: number; prsMs: number; totalMs: number; prCount: number }

export type View = { board: Board | null; prs: Record<string, PrInfo>; titles: Record<string, string>; updatedAt: number; error: string | null; refreshing?: boolean; prError?: string | null; timings?: Timings }

declare module 'claude-code' {
  interface PluginState {
    'fleet': { view: View; isBandHidden: boolean; expanded: string[]; scopeFilter: string; openSections: string[]; fixture: string }
  }
}
