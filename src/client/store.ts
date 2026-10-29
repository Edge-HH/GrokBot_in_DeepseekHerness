/**
 * Reactive store bridging the active Session to PetState.
 *
 * Two client generations are supported, selected by capability detection:
 *
 *  - **legacy** (dsh <= 0.1.x, browser Web profile): SessionListState carries
 *    the selected `current` id and `binding.session` is a ConversationSnapshot
 *    with `running`, `partial`, `runningCalls`, `turnTimings` and `nodes`.
 *  - **event** (dsh >= 0.2.x, including the Desktop app): SessionListState has
 *    no selected id; the active Session is the row retained by the `mainView`
 *    source (`retainedBy.mainView > 0`, the same projection the shell's own
 *    document title uses). `binding.session` only owns lifecycle state
 *    (`running`, `removed`, …) while turn/step/tool/usage facts come from the
 *    Session event window on `binding.eventSource`.
 *
 * @module dsh-grokbot-pet/client/store
 */

/** Provider-reported token usage of one finalized turn (buckets the pet prices). */
export interface PetUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Derived pet state computed from the active session. */
export interface PetState {
  running: boolean
  currentTool: string | null
  step: number | null
  turn: number | null
  elapsedMs: number
  turnCount: number
  hasSession: boolean
  /** Newest finalized assistant message's provider usage, when any. */
  lastUsage: PetUsage | null
}

const ZERO_STATE: PetState = {
  running: false,
  currentTool: null,
  step: null,
  turn: null,
  elapsedMs: 0,
  turnCount: 0,
  hasSession: false,
  lastUsage: null,
}

// ── observable contracts (structural, so either client generation matches) ──

interface SnapshotSource<T> {
  subscribe(listener: () => void): () => void
  getSnapshot(): T
}

interface SessionBindingLike {
  session: SnapshotSource<unknown>
  eventSource?: SnapshotSource<unknown>
}

/** The subset of `ctx.sessions` this store reads. */
export interface SessionSourceLike {
  list: SnapshotSource<unknown>
  binding(id: unknown): SessionBindingLike | undefined
}

type Mode = 'legacy' | 'event'

// ── small numeric helpers ────────────────────────────────────────────

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object'
}

/** A numeric `turn`/`step` member, or null when absent. */
function asIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Resolve the active Session id for either list generation.
 *
 * Legacy lists publish `current`. Current lists publish every row and mark the
 * shell's main-view retention per row, which is the projection `ui-layout`
 * itself uses to pick the document title.
 */
export function activeSessionId(listSnapshot: unknown): unknown {
  if (!isRecord(listSnapshot)) return undefined
  if (listSnapshot.current !== undefined && listSnapshot.current !== null) return listSnapshot.current
  const byId = listSnapshot.byId
  if (byId == null || typeof byId !== 'object') return undefined
  for (const summary of Object.values(byId as Record<string, unknown>)) {
    if (!isRecord(summary)) continue
    const retained = summary.retainedBy
    const mainView = isRecord(retained) ? asNumber(retained.mainView) : 0
    if (mainView > 0 && summary.id !== undefined) return summary.id
  }
  return undefined
}

/** Host-reported running state for one list row, when that generation publishes it. */
function selectedRunningOf(listSnapshot: unknown, id: unknown): boolean {
  if (!isRecord(listSnapshot) || id === undefined) return false
  const byId = listSnapshot.byId
  if (byId == null || typeof byId !== 'object') return false
  const summary = (byId as Record<string, unknown>)[String(id)]
  return isRecord(summary) && summary.running === true
}

/** Legacy ConversationSnapshot → PetState (unchanged semantics). */
function deriveLegacy(snap: unknown): PetState {
  if (!isRecord(snap)) return ZERO_STATE

  const running = snap.running === true
  const partial = isRecord(snap.partial) ? snap.partial : null
  const step = partial == null ? null : asIndex(partial.step)
  const turn = partial == null || step == null ? null : asIndex(partial.turn)

  // Current tool: first entry from runningCalls (non-subagent)
  const calls = Array.isArray(snap.runningCalls) ? snap.runningCalls : []
  let currentTool: string | null = null
  for (const call of calls) {
    if (!isRecord(call) || typeof call.name !== 'string') continue
    if (call.name.startsWith('subagent') || call.name.startsWith('workflow')) continue
    currentTool = call.name
    break
  }

  // Elapsed: from the latest turn start
  let elapsedMs = 0
  let turnCount = 0
  const timings = snap.turnTimings
  if (timings != null && typeof (timings as { values?: unknown }).values === 'function') {
    const entries = Array.from((timings as Map<unknown, unknown>).values())
    turnCount = entries.length
    const latest = entries[entries.length - 1]
    if (isRecord(latest)) {
      const start = asNumber(latest.startTime)
      const end = latest.endTime == null ? null : asNumber(latest.endTime)
      elapsedMs = (end ?? Date.now()) - start
    }
  }

  // Newest finalized assistant message carrying provider usage.
  let lastUsage: PetUsage | null = null
  const nodes = Array.isArray(snap.nodes) ? snap.nodes : []
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]
    if (!isRecord(node) || node.kind !== 'assistant') continue
    const raw = node.usage
    if (!isRecord(raw)) continue
    const input = asNumber(raw.inputTokens)
    const output = asNumber(raw.outputTokens)
    const cacheRead = asNumber(raw.cacheReadTokens)
    const cacheWrite = asNumber(raw.cacheWriteTokens)
    if (input + output + cacheRead + cacheWrite > 0) {
      lastUsage = { input, output, cacheRead, cacheWrite }
      break
    }
  }

  return { running, currentTool, step, turn, elapsedMs: Math.max(0, elapsedMs), turnCount, hasSession: true, lastUsage }
}

// ── event-window fold (dsh >= 0.2.x) ─────────────────────────────────

type TurnTimes = { turn: number | null; start: number; end: number | null }

interface EventFacts {
  currentTool: string | null
  step: number | null
  turn: number | null
  elapsedMs: number
  turnCount: number
  lastUsage: PetUsage | null
}

/**
 * Fold one Session event window into the facts the pet renders.
 *
 * The window is a contiguous slice of history plus the live tail, ordered by
 * `seq`; transient `assistant/live-chunk` rows carry no lifecycle facts, so
 * only durable event types are consumed here.
 */
export function foldEventWindow(entries: readonly unknown[], now: number): EventFacts {
  let turnCount = 0
  let openTurn: number | null = null
  let openTurnStart = 0
  let lastTurn: TurnTimes | null = null
  let step: number | null = null
  let lastUsage: PetUsage | null = null
  const activeCalls = new Map<string, string>()

  for (const entry of entries) {
    const event = isRecord(entry) && isRecord(entry.event) ? entry.event : entry
    if (!isRecord(event) || typeof event.type !== 'string') continue
    const data = isRecord(event.data) ? event.data : {}
    const time = asNumber(event.time)

    switch (event.type) {
      case 'turn/start': {
        const turn = asIndex(data.turn)
        turnCount += 1
        openTurn = turn
        openTurnStart = time
        lastTurn = { turn, start: time, end: null }
        step = null
        activeCalls.clear()
        break
      }
      case 'turn/end': {
        const turn = asIndex(data.turn)
        if (lastTurn != null) {
          const current: TurnTimes = lastTurn
          if (current.turn === turn) lastTurn = { turn: current.turn, start: current.start, end: time }
        }
        openTurn = null
        openTurnStart = 0
        step = null
        break
      }
      case 'step/start':
        step = asIndex(data.step)
        break
      case 'step/end':
        if (step != null && step === asIndex(data.step)) step = null
        break
      case 'tool/call': {
        const callId = typeof data.callId === 'string' ? data.callId : null
        const name = typeof data.name === 'string' ? data.name : null
        if (callId != null && name != null) activeCalls.set(callId, name)
        break
      }
      case 'tool/result': {
        const message = isRecord(data.message) ? data.message : null
        const callId = message != null && typeof message.toolCallId === 'string' ? message.toolCallId : null
        if (callId != null) activeCalls.delete(callId)
        break
      }
      case 'assistant/message': {
        const usage = isRecord(data.usage) ? data.usage : null
        if (usage == null) break
        const input = asNumber(usage.inputTokens)
        const output = asNumber(usage.outputTokens)
        const cacheRead = asNumber(usage.cacheReadTokens)
        const cacheWrite = asNumber(usage.cacheWriteTokens)
        if (input + output + cacheRead + cacheWrite > 0) lastUsage = { input, output, cacheRead, cacheWrite }
        break
      }
      default:
        break
    }
  }

  // The most recently started call that has not produced a result.
  let currentTool: string | null = null
  for (const name of activeCalls.values()) {
    if (name.startsWith('subagent') || name.startsWith('workflow')) continue
    currentTool = name
  }

  const elapsedMs = openTurnStart > 0
    ? Math.max(0, now - openTurnStart)
    : lastTurn != null
      ? Math.max(0, (lastTurn.end ?? lastTurn.start) - lastTurn.start)
      : 0

  return {
    currentTool,
    step,
    turn: openTurn ?? lastTurn?.turn ?? null,
    elapsedMs,
    turnCount,
    lastUsage,
  }
}

// ── state equality ───────────────────────────────────────────────────

function sameUsage(left: PetUsage | null, right: PetUsage | null): boolean {
  if (left === right) return true
  if (left == null || right == null) return false
  return left.input === right.input && left.output === right.output
    && left.cacheRead === right.cacheRead && left.cacheWrite === right.cacheWrite
}

function sameState(left: PetState, right: PetState): boolean {
  return left.running === right.running
    && left.currentTool === right.currentTool
    && left.step === right.step
    && left.turn === right.turn
    && left.elapsedMs === right.elapsedMs
    && left.turnCount === right.turnCount
    && left.hasSession === right.hasSession
    && sameUsage(left.lastUsage, right.lastUsage)
}

// ── store ────────────────────────────────────────────────────────────

export interface PetStateStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): PetState
  dispose(): void
}

/** Throttle window for refolding the event log while tokens stream. */
const FOLD_DELAY_MS = 120
/** Elapsed clock refresh while a turn is open. */
const ELAPSED_TICK_MS = 1000

/**
 * Create a store that reactively tracks the active Session, whichever client
 * generation provides it.
 */
export function createPetStateStore(sessions: SessionSourceLike): PetStateStore {
  let currentId: unknown = undefined
  let binding: SessionBindingLike | undefined
  let mode: Mode = 'legacy'
  let snapshot: PetState = ZERO_STATE
  /** Host-reported running fallback for the selected row (0.2.x list summary). */
  let selectionRunning = false
  const listeners = new Set<() => void>()

  let offSession: (() => void) | undefined
  let offEvents: (() => void) | undefined
  let foldTimer: ReturnType<typeof setTimeout> | undefined
  let elapsedTimer: ReturnType<typeof setInterval> | undefined

  const notify = () => { listeners.forEach((fn) => { try { fn() } catch { /* listener isolation */ } }) }

  const publish = (next: PetState) => {
    if (sameState(next, snapshot)) return
    snapshot = next
    syncElapsedTimer()
    notify()
  }

  const syncElapsedTimer = () => {
    const wanted = snapshot.running && snapshot.hasSession
    if (wanted && elapsedTimer === undefined) {
      elapsedTimer = setInterval(() => { recompute() }, ELAPSED_TICK_MS)
    } else if (!wanted && elapsedTimer !== undefined) {
      clearInterval(elapsedTimer)
      elapsedTimer = undefined
    }
  }

  const detach = () => {
    offSession?.(); offEvents?.()
    offSession = undefined; offEvents = undefined
    if (foldTimer !== undefined) { clearTimeout(foldTimer); foldTimer = undefined }
    binding = undefined
  }

  /** Recompute from the live binding. */
  const recompute = () => {
    if (binding === undefined) {
      publish(ZERO_STATE)
      return
    }

    const sessionSnap = safeSnapshot(binding.session)

    if (mode === 'legacy') {
      publish(deriveLegacy(sessionSnap))
      return
    }

    const running = isRecord(sessionSnap) && typeof sessionSnap.running === 'boolean'
      ? sessionSnap.running
      : selectionRunning
    const window = safeSnapshot(binding.eventSource)
    const entries = isRecord(window) && Array.isArray(window.entries) ? window.entries : []
    const facts = foldEventWindow(entries, Date.now())
    publish({
      running,
      currentTool: running ? facts.currentTool : null,
      step: running ? facts.step : null,
      turn: facts.turn,
      elapsedMs: facts.elapsedMs,
      turnCount: facts.turnCount,
      hasSession: true,
      lastUsage: facts.lastUsage,
    })
  }

  const schedule = (run: () => void) => {
    if (foldTimer !== undefined) return
    foldTimer = setTimeout(() => { foldTimer = undefined; run() }, FOLD_DELAY_MS)
  }

  const onBindChange = () => { schedule(recompute) }

  const attach = (id: unknown, next: SessionBindingLike) => {
    detach()
    binding = next
    // A ConversationSnapshot exposes `nodes`; the 0.2.x SessionSnapshot does not.
    const first = safeSnapshot(next.session)
    mode = isRecord(first) && Array.isArray(first.nodes) ? 'legacy' : 'event'
    offSession = next.session.subscribe(onBindChange)
    if (mode === 'event' && next.eventSource !== undefined) {
      offEvents = next.eventSource.subscribe(onBindChange)
    }
    recompute()
  }

  const onListUpdate = () => {
    const listSnap = sessions.list.getSnapshot()
    const id = activeSessionId(listSnap)
    selectionRunning = selectedRunningOf(listSnap, id)
    if (id !== currentId) {
      currentId = id
      detach()
      if (id === undefined) {
        publish(ZERO_STATE)
        return
      }
      const next = sessions.binding(id)
      if (next !== undefined) attach(id, next)
      else recompute()
      return
    }
    // Same selection: the binding can materialize after the list row appears.
    if (binding === undefined && id !== undefined) {
      const next = sessions.binding(id)
      if (next !== undefined) { attach(id, next); return }
    }
    recompute()
  }

  const listUnsub = sessions.list.subscribe(onListUpdate)
  onListUpdate()

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot() { return snapshot },
    dispose() {
      listUnsub()
      detach()
      if (elapsedTimer !== undefined) { clearInterval(elapsedTimer); elapsedTimer = undefined }
      listeners.clear()
    },
  }
}

/** Defensive snapshot read: a source that throws must not break the pet. */
function safeSnapshot(source: SnapshotSource<unknown> | undefined): unknown {
  if (source === undefined) return undefined
  try { return source.getSnapshot() } catch { return undefined }
}
