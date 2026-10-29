import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  activeSessionId,
  createPetStateStore,
  foldEventWindow,
} from '../src/client/store.ts'

/** Minimal observable matching the client store contract. */
function observable<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next: T) {
      value = next
      listeners.forEach((listener) => listener())
    },
  }
}

const tick = (ms = 160) => new Promise((resolve) => setTimeout(resolve, ms))

/** Assert that `actual` matches every own key of `expected` (recursively). */
function assertPartial(actual: unknown, expected: Record<string, unknown>): void {
  assert.ok(actual != null && typeof actual === 'object', 'expected an object')
  for (const [key, value] of Object.entries(expected)) {
    const observed = (actual as Record<string, unknown>)[key]
    if (value != null && typeof value === 'object') {
      assertPartial(observed, value as Record<string, unknown>)
    } else {
      assert.equal(observed, value, `member "${key}"`)
    }
  }
}

const usageEvent = (inputTokens: number, outputTokens: number, cacheReadTokens = 0) => ({
  type: 'event',
  event: {
    type: 'assistant/message',
    seq: 6,
    time: Date.now(),
    data: { turn: 1, step: 1, usage: { inputTokens, outputTokens, cacheReadTokens } },
  },
})

describe('activeSessionId', () => {
  it('reads the legacy selected id', () => {
    assert.equal(activeSessionId({ current: 'legacy-1' }), 'legacy-1')
  })

  it('selects the row retained by the main view on current lists', () => {
    const list = {
      ids: ['a', 'b'],
      byId: {
        a: { id: 'a', retainedBy: { mainView: 1 } },
        b: { id: 'b', retainedBy: { sidebar: 2 } },
      },
      phase: 'ready',
    }
    assert.equal(activeSessionId(list), 'a')
  })

  it('returns undefined without a selection', () => {
    assert.equal(activeSessionId({ ids: [], byId: {}, phase: 'empty' }), undefined)
    assert.equal(activeSessionId(null), undefined)
  })
})

describe('foldEventWindow', () => {
  it('folds turn, step, tool, usage and elapsed facts', () => {
    const start = Date.now() - 5_000
    const entries = [
      { type: 'event', event: { type: 'turn/start', seq: 1, time: start, data: { turn: 2 } } },
      { type: 'event', event: { type: 'step/start', seq: 2, time: start + 10, data: { turn: 2, step: 1 } } },
      { type: 'event', event: { type: 'tool/call', seq: 3, time: start + 20, data: { turn: 2, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' } } },
      { type: 'event', event: { type: 'assistant/message', seq: 4, time: start + 30, data: { turn: 2, step: 1, usage: { inputTokens: 30, outputTokens: 10, cacheReadTokens: 5 } } } },
      { type: 'transient', event: { type: 'assistant/live-chunk', seq: 5, time: start + 40, data: {} } },
    ]
    const facts = foldEventWindow(entries, Date.now())
    assert.equal(facts.turnCount, 1)
    assert.equal(facts.turn, 2)
    assert.equal(facts.step, 1)
    assert.equal(facts.currentTool, 'pwsh')
    assert.deepEqual(facts.lastUsage, { input: 30, output: 10, cacheRead: 5, cacheWrite: 0 })
    assert.ok(facts.elapsedMs >= 4_900, `elapsed ${facts.elapsedMs}`)
  })

  it('clears the tool when its result arrives and ignores subagent calls', () => {
    const entries = [
      { type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } },
      { type: 'event', event: { type: 'tool/call', seq: 2, time: 2, data: { turn: 1, step: 1, callId: 'sub', name: 'subagent', arguments: '{}' } } },
      { type: 'event', event: { type: 'tool/call', seq: 3, time: 3, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' } } },
      { type: 'event', event: { type: 'tool/result', seq: 4, time: 4, data: { turn: 1, step: 1, message: { toolCallId: 'c1', role: 'tool' } } } },
    ]
    assert.equal(foldEventWindow(entries, Date.now()).currentTool, null)
  })
})

describe('createPetStateStore — legacy client', () => {
  it('derives state from a ConversationSnapshot and reacts to updates', async () => {
    const list = observable<any>({ current: 's1' })
    const session = observable<any>({
      running: true,
      partial: { step: 2, turn: 1 },
      runningCalls: [{ name: 'read' }],
      turnTimings: new Map([['t1', { startTime: 1_000, endTime: 4_000 }]]),
      nodes: [{ kind: 'assistant', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 } }],
    })
    const store = createPetStateStore({
      list,
      binding: () => ({ session }),
    })

    assertPartial(store.getSnapshot(), {
      running: true,
      currentTool: 'read',
      step: 2,
      turn: 1,
      elapsedMs: 3_000,
      turnCount: 1,
      hasSession: true,
      lastUsage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0 },
    })

    session.set({
      running: false,
      partial: null,
      runningCalls: [],
      turnTimings: new Map([['t1', { startTime: 1_000, endTime: 4_000 }]]),
      nodes: [{ kind: 'assistant', usage: { inputTokens: 20, outputTokens: 8 } }],
    })
    await tick()

    assertPartial(store.getSnapshot(), {
      running: false,
      currentTool: null,
      step: null,
      lastUsage: { input: 20, output: 8, cacheRead: 0, cacheWrite: 0 },
    })
    store.dispose()
  })
})

describe('createPetStateStore — current client', () => {
  it('follows the main-view session and folds its event window', async () => {
    const start = Date.now() - 3_000
    const list = observable<any>({
      ids: ['s1'],
      byId: { s1: { id: 's1', retainedBy: { mainView: 1 }, running: true } },
      phase: 'ready',
    })
    const session = observable<any>({ running: true, openState: 'open' })
    const events = observable<any>({
      entries: [
        { type: 'event', event: { type: 'turn/start', seq: 1, time: start, data: { turn: 1 } } },
        { type: 'event', event: { type: 'step/start', seq: 2, time: start + 50, data: { turn: 1, step: 1 } } },
        { type: 'event', event: { type: 'tool/call', seq: 3, time: start + 60, data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' } } },
        usageEvent(100, 40, 7),
      ],
      hasMore: false,
      revision: 1,
      change: { kind: 'replace', entries: [] },
    })

    const store = createPetStateStore({
      list,
      binding: () => ({ session, eventSource: events }),
    })

    assertPartial(store.getSnapshot(), {
      running: true,
      currentTool: 'pwsh',
      step: 1,
      turn: 1,
      turnCount: 1,
      hasSession: true,
      lastUsage: { input: 100, output: 40, cacheRead: 7, cacheWrite: 0 },
    })
    assert.ok(store.getSnapshot().elapsedMs >= 2_900)

    // Turn ends: the store follows the session lifecycle and event window.
    events.set({
      entries: [
        ...events.getSnapshot().entries.slice(0, 2),
        { type: 'event', event: { type: 'tool/result', seq: 4, time: start + 70, data: { turn: 1, step: 1, message: { toolCallId: 'c1' } } } },
        { type: 'event', event: { type: 'turn/end', seq: 5, time: start + 80, data: { turn: 1, reason: { kind: 'stop' } } } },
        usageEvent(200, 60),
      ],
      hasMore: false,
      revision: 2,
      change: { kind: 'append', entries: [] },
    })
    session.set({ running: false, openState: 'open' })
    await tick()

    const settled = store.getSnapshot()
    assert.equal(settled.running, false)
    assert.equal(settled.currentTool, null)
    assert.equal(settled.step, null)
    assert.equal(settled.turn, 1)
    assert.deepEqual(settled.lastUsage, { input: 200, output: 60, cacheRead: 0, cacheWrite: 0 })
    store.dispose()
  })

  it('uses the host row running state before the session snapshot reports one', () => {
    const list = observable<any>({
      ids: ['s1'],
      byId: { s1: { id: 's1', retainedBy: { mainView: 1 }, running: true } },
      phase: 'ready',
    })
    const session = observable<any>({ openState: 'loading' })
    const events = observable<any>({ entries: [] })
    const store = createPetStateStore({
      list,
      binding: () => ({ session, eventSource: events }),
    })

    assertPartial(store.getSnapshot(), { running: true, hasSession: true, turnCount: 0 })
    store.dispose()
  })

  it('rebinds when the selected session changes', () => {
    const list = observable<any>({
      ids: ['a', 'b'],
      byId: {
        a: { id: 'a', retainedBy: { mainView: 1 } },
        b: { id: 'b', retainedBy: {} },
      },
      phase: 'ready',
    })
    const sessionA = observable<any>({ running: true })
    const sessionB = observable<any>({ running: false })
    const eventsA = observable<any>({ entries: [{ type: 'event', event: { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } } }] })
    const eventsB = observable<any>({ entries: [] })
    const store = createPetStateStore({
      list,
      binding: (id) => (id === 'a' ? { session: sessionA, eventSource: eventsA } : { session: sessionB, eventSource: eventsB }),
    })

    assert.equal(store.getSnapshot().running, true)

    list.set({
      ids: ['a', 'b'],
      byId: {
        a: { id: 'a', retainedBy: {} },
        b: { id: 'b', retainedBy: { mainView: 1 } },
      },
      phase: 'ready',
    })

    assertPartial(store.getSnapshot(), { running: false, turnCount: 0, hasSession: true })
    store.dispose()
  })

  it('disposes cleanly with no selection', () => {
    const list = observable<any>({ ids: [], byId: {}, phase: 'empty' })
    const store = createPetStateStore({ list, binding: () => undefined })
    assert.equal(store.getSnapshot().hasSession, false)
    store.dispose()
  })
})
