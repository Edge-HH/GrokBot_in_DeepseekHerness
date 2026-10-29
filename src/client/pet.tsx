/**
 * GrokbotFigure — faithful SVG renderer ported from LaoA-GrokBot app.js.
 * PetView — draggable animated pet with physics, sounds, and notifications.
 *
 * Reads session state from the reactive PetStateStore (no host polling).
 * GrokBot expression data is imported as a JSON module.
 *
 * @module dsh-grokbot-pet/client/pet
 */
import { createElement, useEffect, useLayoutEffect, useRef, useState, useCallback, useSyncExternalStore } from 'react'
import type { PetStateStore, PetUsage } from './store.ts'
import css from './pet.module.css'
import {
  COLORS, SHAPES, PARTS, ACCESSORIES, DEFAULT_APPEARANCE,
  type AppearanceState,
} from './data.ts'
import { isDesktopApp, petTopLimit } from './platform.ts'
// @ts-ignore — JSON module bundled at build time
import rawData from './expressions.json'

// ── expression data (embedded at build time) ─────────────────────────

interface ExpressionData {
  exprs: Record<string, [number, number][][]>
  pools: Record<string, number[]>
  blink: Record<string, [number, number] | null>
  cadence: Record<string, [number, number]>
}

const EXPR_DATA: ExpressionData = rawData as unknown as ExpressionData

// ── helpers ──────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

const ringPath = (ring: [number, number][]) =>
  'M' + ring.map((p) => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join('L') + 'Z'

const centroid = (ring: [number, number][]) =>
  ring.reduce<[number, number]>((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0])

// ── localStorage helpers ─────────────────────────────────────────────

function lsGet<T>(key: string, fallback: T): T {
  try {
    const w = typeof window !== 'undefined' ? window : null
    if (w == null || w.localStorage == null) return fallback
    const raw = w.localStorage.getItem('dsh-pet:' + key)
    return raw == null ? fallback : (JSON.parse(raw) as T)
  } catch { return fallback }
}

function lsSet(key: string, value: unknown): void {
  try {
    const w = typeof window !== 'undefined' ? window : null
    if (w != null && w.localStorage != null) w.localStorage.setItem('dsh-pet:' + key, JSON.stringify(value))
  } catch { /* no-op */ }
}

// ── audio ────────────────────────────────────────────────────────────

let _audioCtx: AudioContext | null = null

function getAudio(): AudioContext | null {
  try {
    const w = typeof window !== 'undefined' ? window : null
    if (w == null) return null
    const AC = (w as any).AudioContext ?? (w as any).webkitAudioContext
    if (AC == null) return null
    if (_audioCtx == null) _audioCtx = new AC()
    if (_audioCtx != null && _audioCtx.state === 'suspended') {
      const p = _audioCtx.resume(); if (p != null && typeof p.catch === 'function') p.catch(() => {})
    }
    return _audioCtx
  } catch { return null }
}

function t(c: AudioContext, f0: number, f1: number | null, off: number, dur: number, type: OscillatorType, vol: number): void {
  try {
    const t0 = c.currentTime + off
    const o = c.createOscillator()
    const g = c.createGain()
    o.type = type
    o.frequency.setValueAtTime(f0, t0)
    if (f1 != null) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur)
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    o.connect(g); g.connect(c.destination)
    o.start(t0); o.stop(t0 + dur + 0.06)
  } catch { /* no-op */ }
}

function playSound(kind: string): void {
  const c = getAudio()
  if (c == null) return
  if (kind === 'request')  t(c, 1150, 1350, 0, 0.07, 'sine', 0.05)
  else if (kind === 'tool')     t(c, 620, 700, 0, 0.045, 'triangle', 0.028)
  else if (kind === 'start')    { t(c, 523.25, 587.33, 0, 0.09, 'sine', 0.06); t(c, 587.33, 783.99, 0.1, 0.12, 'sine', 0.06) }
  else if (kind === 'end')      { t(c, 783.99, 659.25, 0, 0.09, 'sine', 0.06); t(c, 659.25, 523.25, 0.1, 0.14, 'sine', 0.06) }
  else if (kind === 'sub')      t(c, 880, 880, 0, 0.05, 'square', 0.03)
  else if (kind === 'pet')      t(c, 880, 1320, 0, 0.06, 'sine', 0.07)
  else if (kind === 'bye')      t(c, 660, 440, 0, 0.1, 'sine', 0.05)
  else if (kind === 'throw')    t(c, 300, 640, 0, 0.12, 'sine', 0.05)
  else if (kind === 'bounce')   t(c, 240, 180, 0, 0.08, 'triangle', 0.06)
}

// ── notifications ────────────────────────────────────────────────────

function notifyApi(): (typeof Notification) | null {
  const w = typeof window !== 'undefined' ? window : null
  if (w == null) return null
  const N = (w as any).Notification
  return typeof N === 'function' ? N : null
}

function sendNotification(title: string, body: string, tag: string): void {
  const N = notifyApi()
  if (N == null || N.permission !== 'granted') return
  try { new N(title, { body, tag }) } catch { /* no-op */ }
}

function fmtElapsed(ms: number): string {
  return Math.max(0, Math.round(ms / 1000)) + 's'
}

// ── 用量金额 ─────────────────────────────────────────────────────────

/** DeepSeek 官方定价近似值（元 / 百万 tokens），仅用于估算展示。 */
const PRICE_PER_M: Record<keyof PetUsage, number> = {
  input: 2,
  output: 8,
  cacheRead: 0.5,
  cacheWrite: 2,
}

function usageTokens(u: PetUsage | null): number {
  return u == null ? 0 : u.input + u.output + u.cacheRead + u.cacheWrite
}

function usageCost(u: PetUsage | null): number {
  if (u == null) return 0
  return (u.input * PRICE_PER_M.input
    + u.output * PRICE_PER_M.output
    + u.cacheRead * PRICE_PER_M.cacheRead
    + u.cacheWrite * PRICE_PER_M.cacheWrite) / 1e6
}

function fmtTokens(n: number): string {
  return n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n))
}

function fmtCost(c: number): string {
  return '≈¥' + (c >= 0.01 ? c.toFixed(2) : c.toFixed(4))
}

// ── color/shape helpers ──────────────────────────────────────────────

function colorHex(a: AppearanceState): string {
  return COLORS.some((c) => c[2] === a.color) ? a.color : DEFAULT_APPEARANCE.color
}

function shapePath(a: AppearanceState): string {
  const found = SHAPES.find((s) => s[0] === a.shape)
  return found != null ? found[2] : SHAPES[0]![2]
}

function toggleId(list: string[], id: string): string[] {
  return list.indexOf(id) >= 0 ? list.filter((x) => x !== id) : [...list, id]
}

/** 6 种快捷动作（原版「果冻感快捷动作」）：[状态名, 显示名]。 */
const QUICK_ACTIONS: ReadonlyArray<readonly [string, string]> = [
  ['happy', '开心'],
  ['surprised', '惊讶'],
  ['listening', '倾听'],
  ['thinking', '思考'],
  ['working', '工作'],
  ['idle', '待机'],
] as const

// ── GrokbotFigure ────────────────────────────────────────────────────

interface FigureProps {
  petState: string
  data: ExpressionData | null
  simHolder: { current: any | null }
}

function GrokbotFigure({ petState, data, simHolder }: FigureProps) {
  const appearance = useAppearance()
  const eye0Ref = useRef<SVGPathElement>(null)
  const eye1Ref = useRef<SVGPathElement>(null)
  const applyStateRef = useRef<((name: string) => void) | null>(null)
  const clipId = useRef('dsh-pet-clip-' + Math.random().toString(36).slice(2, 9)).current

  useEffect(() => {
    if (data == null || data.exprs == null) return
    const s: any = {
      current: data!.exprs['0']!.map((r: any) => r.map((p: any) => [p[0], p[1]])),
      target: data.exprs['0'],
      exprIdx: 0, morph: 1, velocity: 0, last: 0,
      blinkStart: 0, gazeX: 0, gazeY: 0, turn: 0, state: 'idle',
      nextExprAt: 0, nextBlinkAt: 0,
    }
    simHolder.current = s

    const blinkNow = () => { s.blinkStart = performance.now() }
    const chooseExpression = (index: number) => {
      s.current = s.current.map((ring: any, e: number) =>
        ring.map((p: any, i: number) => [
          p[0] + (s.target[e][i][0] - p[0]) * clamp(s.morph, 0, 1),
          p[1] + (s.target[e][i][1] - p[1]) * clamp(s.morph, 0, 1),
        ]))
      s.target = data!.exprs[String(index)]
      s.exprIdx = index; s.morph = 0; s.velocity = 0
    }
    const applyState = (name: string) => {
      if (name === s.state) return
      s.state = name
      const pool = (data!.pools[name] || [0]).filter((i: number) => data!.exprs[String(i)] != null)
      if (pool.length === 0) return
      const next = pool.find((i: number) => i !== s.exprIdx)
      chooseExpression(next != null ? next : pool[0]!)
      const cadence = data!.cadence[name]
      s.nextExprAt = performance.now() + (cadence == null ? 4000 : cadence[0])
      s.nextBlinkAt = performance.now() + 4600
      if (name === 'surprised') blinkNow()
    }
    applyStateRef.current = applyState
    s.nextExprAt = performance.now() + 9000
    s.nextBlinkAt = performance.now() + 4600

    let raf = 0
    const frame = (now: number) => {
      if (s.last === 0) s.last = now
      const dt = Math.min((now - s.last) / 1000, 0.1)
      s.last = now
      s.velocity += (-14 * s.velocity - 49 * (s.morph - 1)) * dt
      s.morph += s.velocity * dt
      if (!Number.isFinite(s.morph)) { s.morph = 1; s.velocity = 0 }
      const shown = s.current.map((ring: any, e: number) =>
        ring.map((p: any, i: number) => [
          p[0] + (s.target[e][i][0] - p[0]) * clamp(s.morph, 0, 1),
          p[1] + (s.target[e][i][1] - p[1]) * clamp(s.morph, 0, 1),
        ]))
      let bs = 1
      if (s.blinkStart !== 0) {
        const blinkT = (now - s.blinkStart) / 320
        if (blinkT >= 1) { s.blinkStart = 0; bs = 1 }
        else bs = Math.max(blinkT < 0.42 ? 1 - blinkT / 0.42 : (blinkT - 0.42) / 0.58, 0.04)
      }
      const rad = s.turn * Math.PI / 180
      shown.forEach((ring: any, i: number) => {
        const c = centroid(ring)
        const base = Math.asin(clamp((c[0] - 114.2705) / 105, -1, 1))
        const longitude = base + rad
        const depth = Math.cos(longitude)
        const perspective = Math.max(depth, 0.02) / Math.max(Math.cos(base), 0.02)
        const x = 114.2705 + 105 * Math.sin(longitude) + s.gazeX
        const y = c[1] + s.gazeY
        const el = i === 0 ? eye0Ref.current : eye1Ref.current
        if (el != null) {
          el.setAttribute('d', ringPath(ring))
          el.setAttribute('transform',
            `translate(${x} ${y}) scale(${clamp(perspective, 0.02, 2.4)} ${bs}) translate(${-c[0]} ${-c[1]})`)
          el.style.opacity = depth > 0.02 ? '1' : '0'
        }
      })
      if (now >= s.nextBlinkAt) {
        if (data!.blink[s.state]) blinkNow()
        s.nextBlinkAt = now + 4600
      }
      if (now >= s.nextExprAt) {
        const pool = (data!.pools[s.state] || [0]).filter((i: number) => data!.exprs[String(i)] != null)
        if (pool.length > 1) chooseExpression(pool[Math.floor(Math.random() * pool.length)]!)
        const cadence = data!.cadence[s.state]
        s.nextExprAt = now + (cadence == null ? 4000 : cadence[0])
      }
      raf = window.requestAnimationFrame(frame)
    }
    raf = window.requestAnimationFrame(frame)
    return () => { window.cancelAnimationFrame(raf); applyStateRef.current = null; simHolder.current = null }
  }, [data])

  useEffect(() => { if (applyStateRef.current != null) applyStateRef.current(petState) }, [petState])

  const color = colorHex(appearance)
  const shape = shapePath(appearance)
  const { accessories, parts } = appearance

  return createElement('svg', { className: css.figure, viewBox: '0 0 229 229', 'aria-hidden': 'true' },
    createElement('defs', null,
      createElement('clipPath', { id: clipId }, createElement('path', { d: shape }))),
    // back accessories
    accessories.includes('cape') ? createElement('g', { fill: '#7657d8', opacity: 0.88 },
      createElement('path', { d: 'M25 79Q-2 119 13 210Q65 192 90 168ZM204 79Q231 119 216 210Q164 192 139 168Z' })) : null,
    // body parts (behind body per original DOM order)
    parts.includes('antenna') ? createElement('g', { className: css.part, stroke: color },
      createElement('path', { d: 'M114 18V-5' }),
      createElement('circle', { cx: 114, cy: -12, r: 8, fill: color, stroke: 'none' })) : null,
    parts.includes('tail') ? createElement('path', { className: css.part, stroke: color, d: 'M205 154C246 151 254 181 230 198C216 208 214 220 227 228' }) : null,
    parts.includes('hands') ? createElement('g', { className: css.part, stroke: color },
      createElement('path', { d: 'M25 132C5 136-8 148-17 165' }),
      createElement('path', { d: 'M204 132C224 136 237 148 246 165' }),
      createElement('circle', { cx: -20, cy: 170, r: 10, fill: color, stroke: 'none' }),
      createElement('circle', { cx: 249, cy: 170, r: 10, fill: color, stroke: 'none' })) : null,
    parts.includes('feet') ? createElement('g', { className: css.part, stroke: color },
      createElement('path', { d: 'M72 202V224' }),
      createElement('path', { d: 'M157 202V224' }),
      createElement('ellipse', { cx: 62, cy: 230, rx: 24, ry: 10, fill: color, stroke: 'none' }),
      createElement('ellipse', { cx: 167, cy: 230, rx: 24, ry: 10, fill: color, stroke: 'none' })) : null,
    // body + eyes
    createElement('path', { d: shape, fill: color, className: css.bodypath }),
    createElement('g', { clipPath: `url(#${clipId})`, className: css.eyes },
      createElement('path', { className: css.eye, ref: eye0Ref }),
      createElement('path', { className: css.eye, ref: eye1Ref })),
    // front accessories
    accessories.includes('straw-hat') ? createElement('g', { fill: '#e9bd57', stroke: '#b57b24', strokeWidth: 3 },
      createElement('path', { d: 'M63 28Q72-24 114-28Q156-24 165 28Z' }),
      createElement('ellipse', { cx: 114, cy: 31, rx: 91, ry: 18, fill: '#efcb70' }),
      createElement('path', { d: 'M64 10Q114 22 164 10L166 27Q114 38 62 27Z', fill: '#d94b5d', stroke: 'none' })) : null,
    accessories.includes('glasses') ? createElement('g', { fill: 'none', stroke: '#171813', strokeWidth: 8, strokeLinecap: 'round', strokeLinejoin: 'round' },
      createElement('circle', { cx: 72, cy: 108, r: 37, fill: 'rgba(255,255,255,0.12)' }),
      createElement('circle', { cx: 157, cy: 108, r: 37, fill: 'rgba(255,255,255,0.12)' }),
      createElement('path', { d: 'M109 106Q114 99 120 106' }),
      createElement('path', { d: 'M35 102L12 94' }),
      createElement('path', { d: 'M194 102L217 94' })) : null,
    accessories.includes('bowtie') ? createElement('g', { fill: '#ff2d8b', stroke: 'none' },
      createElement('path', { d: 'M114 172L78 151Q62 143 64 176Q65 205 82 194L114 178ZM114 172L150 151Q166 143 164 176Q163 205 146 194L114 178Z' }),
      createElement('circle', { cx: 114, cy: 175, r: 12 })) : null,
  )
}

// ── appearance store (localStorage-backed, shared with appearance.ts) ──

type AppListener = (a: AppearanceState) => void

let _appearance: AppearanceState = (() => {
  const saved = lsGet<Partial<AppearanceState>>('appearance', {} as any)
  const shapeOk = SHAPES.some((s) => s[0] === saved.shape)
  const colorOk = COLORS.some((c) => c[2] === saved.color)
  return {
    shape: shapeOk ? saved.shape! : DEFAULT_APPEARANCE.shape,
    color: colorOk ? saved.color! : DEFAULT_APPEARANCE.color,
    accessories: Array.isArray(saved.accessories) ? saved.accessories.filter((id) => ACCESSORIES.some((a) => a[0] === id)) : [],
    parts: Array.isArray(saved.parts) ? saved.parts.filter((id) => PARTS.some((p) => p[0] === id)) : [],
    name: typeof saved.name === 'string' && saved.name.trim() !== '' ? saved.name.trim() : DEFAULT_APPEARANCE.name,
    gazeAlways: typeof saved.gazeAlways === 'boolean' ? saved.gazeAlways : DEFAULT_APPEARANCE.gazeAlways,
  }
})()

const _appListeners = new Set<AppListener>()

export function setAppearance(next: AppearanceState): void {
  _appearance = next
  lsSet('appearance', next)
  _appListeners.forEach((fn) => { try { fn(_appearance) } catch { /* no-op */ } })
}

export function subscribeAppearance(fn: AppListener): () => void {
  _appListeners.add(fn)
  return () => { _appListeners.delete(fn) }
}

function useAppearance(): AppearanceState {
  const [val, setVal] = useState(_appearance)
  useEffect(() => subscribeAppearance(setVal), [])
  return val
}

/**
 * 对话输入框（composer）右上方的默认落点：宠物底部悬于输入框上沿、
 * 右侧对齐输入框右缘。输入框尚未渲染/不可见时返回 null。
 */
function composerPos(): { x: number; y: number } | null {
  const d = typeof document !== 'undefined' ? document : null
  if (d == null) return null
  const card = d.querySelector('[data-composer-card]') as HTMLElement | null
  if (card == null) return null
  const r = card.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return null
  const w = typeof window !== 'undefined' ? window : null as any
  const vw = w == null ? 1200 : w.innerWidth
  const vh = w == null ? 800 : w.innerHeight
  const top = petTopLimit()
  return {
    x: clamp(r.right - 84 - 8, 8, Math.max(8, vw - 92)),
    y: clamp(r.top - 84 - 10, top, Math.max(top, vh - 92)),
  }
}

// ── PetView ──────────────────────────────────────────────────────────

interface PetViewProps {
  store: PetStateStore
  ctx: any
}

export function PetView({ store, ctx }: PetViewProps) {
  const appearance = useAppearance()
  const simHolder = useRef<any>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const ghostRefs = useRef<(HTMLDivElement | null)[]>([null, null, null])
  const posRef = useRef({ x: 0, y: 0 })
  const dragSamplesRef = useRef<{ t: number; x: number; y: number }[]>([])
  const flightRef = useRef({ active: false, vx: 0, vy: 0, last: 0, trail: [] as any[], raf: 0, lastBounceSound: 0 })
  const [pos, setPos] = useState(() => {
    const w = typeof window !== 'undefined' ? window : null as any
    const vw = w == null ? 1200 : w.innerWidth
    const vh = w == null ? 800 : w.innerHeight
    const top = petTopLimit()
    const saved = lsGet<{ x: number; y: number } | null>('pos', null)
    if (saved != null && typeof saved.x === 'number') {
      return {
        x: clamp(saved.x, 0, Math.max(0, vw - 84)),
        y: clamp(typeof saved.y === 'number' ? saved.y : 0, top, Math.max(top, vh - 84)),
      }
    }
    // 首次启动默认位置：对话输入框右上方；输入框尚未渲染时先落右下角兜底
    return composerPos() ?? { x: Math.max(0, vw - 100), y: Math.max(top, vh - 130) }
  })
  const [visible, setVisible] = useState(() => lsGet<boolean>('visible', true))
  const [soundOn, setSoundOn] = useState(() => lsGet<boolean>('sound', true))
  const [notifyOn, setNotifyOn] = useState(() => {
    const N = notifyApi()
    return N != null && N.permission === 'granted' && lsGet<boolean>('notify', true)
  })
  const [bubbleOpen, setBubbleOpen] = useState(false)
  const [hearts, setHearts] = useState<{ id: number; dx: number; delay: number }[]>([])
  const [action, setAction] = useState<{ name: string; until: number }>({ name: '', until: 0 })
  const [hovering, setHovering] = useState(false)
  const [flying, setFlying] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; ready: boolean } | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [motionCls, setMotionCls] = useState('')
  const soundOnRef = useRef(soundOn)
  const notifyOnRef = useRef(notifyOn)
  const prevRunningRef = useRef<boolean | null>(null)
  const prevPetStateRef = useRef<string | null>(null)
  const dragRef = useRef<any>(null)
  const heartSeqRef = useRef(0)
  // 首次启动（无保存位置）才会执行自动归位
  const placedRef = useRef(lsGet<{ x: number; y: number } | null>('pos', null) != null)
  soundOnRef.current = soundOn
  notifyOnRef.current = notifyOn
  if (!flightRef.current.active) posRef.current = pos

  // Subscribe to pet state store
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const running = snap.running

  // Audio unlock on any gesture
  useEffect(() => {
    const w = typeof window !== 'undefined' ? window : null as any
    if (w == null) return
    const unlock = () => { getAudio() }
    w.addEventListener('pointerdown', unlock, { capture: true, passive: true })
    w.addEventListener('keydown', unlock, { capture: true, passive: true })
    return () => {
      w.removeEventListener('pointerdown', unlock, { capture: true })
      w.removeEventListener('keydown', unlock, { capture: true })
    }
  }, [])

  // Transition detection (start/end turn)
  useEffect(() => {
    const was = prevRunningRef.current
    prevRunningRef.current = running
    if (was == null) return
    if (running && !was) {
      if (soundOnRef.current && !documentHidden()) playSound('start')
      sendNotification(`${appearance.name} · 请求已开始`, `已累计 ${snap.turnCount} 轮请求`, 'dsh-pet-start')
      setAction({ name: '', until: 0 })
    } else if (!running && was) {
      if (soundOnRef.current && !documentHidden()) playSound('end')
      const secs = Math.max(0, Math.round(snap.elapsedMs / 1000))
      sendNotification(`${appearance.name} · 请求完成`, `用时约 ${secs} 秒 · 共 ${snap.turnCount} 轮请求`, 'dsh-pet-end')
      setAction({ name: 'happy', until: Date.now() + 2600 })
      // 每轮结束后自动弹出气泡展示本轮用量，6 秒后自动收起
      setBubbleOpen(true)
      ctx.timeout(() => setBubbleOpen(false), 6000)
    }
  }, [running])

  // 始终注视：不悬停也跟随鼠标（设置开关控制）
  useEffect(() => {
    const w = typeof window !== 'undefined' ? window : null as any
    if (w == null || !appearance.gazeAlways) {
      const s = simHolder.current
      if (s != null) { s.gazeX = 0; s.gazeY = 0 }
      return
    }
    const onMove = (ev: globalThis.PointerEvent) => {
      const s = simHolder.current
      if (s == null) return
      const cx = posRef.current.x + 42
      const cy = posRef.current.y + 42
      s.gazeX = clamp((ev.clientX - cx) / 220, -1, 1) * 20
      s.gazeY = clamp((ev.clientY - cy) / 220, -1, 1) * 14
    }
    w.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      w.removeEventListener('pointermove', onMove)
      const s = simHolder.current
      if (s != null) { s.gazeX = 0; s.gazeY = 0 }
    }
  }, [appearance.gazeAlways])

  // Persist position
  useEffect(() => { lsSet('pos', pos) }, [pos])

  // Desktop windows can be resized, maximized, or toggled fullscreen: keep the
  // pet inside the new viewport and below the native titlebar chrome.
  useEffect(() => {
    const onResize = () => {
      const vw = window.innerWidth, vh = window.innerHeight
      const top = petTopLimit()
      const next = {
        x: clamp(posRef.current.x, 0, Math.max(0, vw - 84)),
        y: clamp(posRef.current.y, top, Math.max(top, vh - 84)),
      }
      if (next.x !== posRef.current.x || next.y !== posRef.current.y) {
        posRef.current = next
        setPos(next)
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 首次启动定位：输入框尚未渲染时等它出现，再归位到其右上方；用户一开始拖拽即放弃
  useEffect(() => {
    if (placedRef.current) return
    let timer = 0
    let tries = 0
    let settled = false
    const done = () => {
      settled = true
      placedRef.current = true
      if (timer !== 0) { window.clearTimeout(timer); timer = 0 }
    }
    const place = () => {
      if (settled) return
      const next = composerPos()
      if (next != null) { setPos(next); done(); return }
      if (++tries > 30) { done(); return }
      timer = window.setTimeout(place, 250)
    }
    const w = typeof window !== 'undefined' ? window : null as any
    if (w != null) w.addEventListener('pointerdown', done, { once: true, capture: true })
    place()
    return () => {
      done()
      if (w != null) w.removeEventListener('pointerdown', done, { capture: true })
    }
  }, [])

  // Right-click menu close
  const menuOpen = menu != null
  useEffect(() => {
    if (!menuOpen) return
    const w = typeof window !== 'undefined' ? window : null as any
    if (w == null) return
    const close = (ev: Event) => {
      const target = ev.target as any
      if (target != null && typeof target.closest === 'function' && target.closest('.dsh-pet-panel') != null) return
      setMenu(null)
    }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setMenu(null) }
    w.addEventListener('pointerdown', close, { capture: true })
    w.addEventListener('keydown', onKey)
    return () => {
      w.removeEventListener('pointerdown', close, { capture: true })
      w.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  // 右键菜单定位：先渲染（隐藏）实测尺寸，再避开宠物与屏幕边框放置。
  // 优先级：宠物右侧 → 左侧 → 下方 → 上方 → 兜底钳制到视口内。
  useLayoutEffect(() => {
    if (menu == null || menu.ready) return
    const el = menuRef.current
    const w = typeof window !== 'undefined' ? window : null as any
    if (el == null || w == null) return
    const rect = el.getBoundingClientRect()
    const mw = rect.width, mh = rect.height
    const vw = w.innerWidth, vh = w.innerHeight
    const GAP = 8
    const clampX = (v: number) => clamp(v, GAP, Math.max(GAP, vw - GAP - mw))
    const clampY = (v: number) => clamp(v, GAP, Math.max(GAP, vh - GAP - mh))
    const petL = posRef.current.x, petT = posRef.current.y
    const petR = petL + 84, petB = petT + 84
    let x = clampX(petL)
    let y = clampY(petT)
    if (petR + GAP + mw <= vw - GAP) { x = petR + GAP; y = clampY(petT) }
    else if (petL - GAP - mw >= GAP) { x = petL - GAP - mw; y = clampY(petT) }
    else if (petB + GAP + mh <= vh - GAP) { x = clampX(petL); y = petB + GAP }
    else if (petT - GAP - mh >= GAP) { x = clampX(petL); y = petT - GAP - mh }
    setMenu({ x, y, ready: true })
  }, [menu])

  const spawnHearts = useCallback(() => {
    heartSeqRef.current += 1
    const batch = heartSeqRef.current
    const items = [0, 1, 2].map((i) => ({ id: batch * 10 + i, dx: (i - 1) * 15, delay: i * 70 }))
    setHearts((prev) => [...prev, ...items])
    ctx.timeout(() => setHearts((prev) => prev.filter((h) => Math.floor(h.id / 10) !== batch)), 1200)
  }, [ctx])

  // 手动触发一种快捷动作（点击随机 / 右键菜单选择共用）
  const triggerAction = useCallback((name: string) => {
    if (name === 'happy') spawnHearts()
    if (name === 'surprised') {
      const s = simHolder.current
      if (s != null) s.blinkStart = performance.now()
    }
    setAction({ name, until: Date.now() + 1800 })
  }, [spawnHearts])

  const flashNotice = useCallback((text: string) => {
    setNotice(text)
    ctx.timeout(() => setNotice(null), 2600)
  }, [ctx])

  const stopFlight = useCallback(() => {
    const f = flightRef.current
    if (!f.active) return
    f.active = false
    if (f.raf !== 0) window.cancelAnimationFrame(f.raf)
    f.raf = 0; f.trail = []
    setFlying(false)
    if (bodyRef.current != null) bodyRef.current.style.filter = ''
    ghostRefs.current.forEach((g) => { if (g != null) g.style.display = 'none' })
    setPos(posRef.current)
  }, [])

  const startFlight = useCallback((vx: number, vy: number) => {
    const f = flightRef.current
    f.active = true; f.vx = vx; f.vy = vy
    f.last = performance.now(); f.trail = []; f.lastBounceSound = 0
    setFlying(true)
    const bounceFx = () => {
      const nowT = performance.now()
      if (soundOnRef.current && !documentHidden() && nowT - f.lastBounceSound > 140) {
        f.lastBounceSound = nowT; playSound('bounce')
      }
      setMotionCls(css.bodyActPulse ?? '')
      ctx.timeout(() => setMotionCls((cur) => (cur === (css.bodyActPulse ?? '') ? '' : cur)), 900)
    }
    const step = (now: number) => {
      if (!f.active) return
      const dt = Math.min((now - f.last) / 1000, 0.05)
      f.last = now
      f.vx *= Math.exp(-0.9 * dt); f.vy *= Math.exp(-0.9 * dt)
      let x = posRef.current.x + f.vx * dt
      let y = posRef.current.y + f.vy * dt
      const vw = window.innerWidth, vh = window.innerHeight
      const minX = 8, maxX = Math.max(8, vw - 92), minY = petTopLimit(), maxY = Math.max(minY, vh - 92)
      if (x < minX) { x = minX; if (f.vx < 0) { f.vx = -f.vx * 0.7; if (Math.abs(f.vx) > 60) bounceFx() } }
      else if (x > maxX) { x = maxX; if (f.vx > 0) { f.vx = -f.vx * 0.7; if (Math.abs(f.vx) > 60) bounceFx() } }
      if (y < minY) { y = minY; if (f.vy < 0) { f.vy = -f.vy * 0.7; if (Math.abs(f.vy) > 60) bounceFx() } }
      else if (y > maxY) { y = maxY; if (f.vy > 0) { f.vy = -f.vy * 0.7; if (Math.abs(f.vy) > 60) bounceFx() } }
      // Composer collision
      const card = document.querySelector('[data-composer-card]') as HTMLElement | null
      if (card != null) {
        const r = card.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) {
          const pL = x + 8, pT = y + 8, pR = x + 76, pB = y + 76
          if (pR > r.left && pL < r.right && pB > r.top && pT < r.bottom) {
            const oL = pR - r.left, oR = r.right - pL, oT = pB - r.top, oB = r.bottom - pT
            if (Math.min(oL, oR) < Math.min(oT, oB)) {
              if (oL < oR) { x = r.left - 84; if (f.vx > 0) { f.vx = -f.vx * 0.7; bounceFx() } }
              else { x = r.right + 8; if (f.vx < 0) { f.vx = -f.vx * 0.7; bounceFx() } }
            } else {
              if (oT < oB) { y = r.top - 84; if (f.vy > 0) { f.vy = -f.vy * 0.7; bounceFx() } }
              else { y = r.bottom + 8; if (f.vy < 0) { f.vy = -f.vy * 0.7; bounceFx() } }
            }
          }
        }
      }
      posRef.current = { x, y }
      if (rootRef.current != null) { rootRef.current.style.left = x + 'px'; rootRef.current.style.top = y + 'px' }
      const speed = Math.hypot(f.vx, f.vy)
      if (bodyRef.current != null) bodyRef.current.style.filter = `drop-shadow(0 5px 4px rgba(35,48,80,.2)) blur(${clamp(speed / 240, 0, 4).toFixed(2)}px)`
      f.trail.unshift({ x, y }); if (f.trail.length > 3) f.trail.pop()
      ghostRefs.current.forEach((g, i) => {
        if (g == null) return
        const tp = f.trail[i + 1]
        if (tp == null) { g.style.display = 'none'; return }
        g.style.display = 'block'; g.style.left = (tp.x - x + 10) + 'px'; g.style.top = (tp.y - y + 14) + 'px'
        g.style.opacity = String(0.32 - i * 0.1)
      })
      if (speed < 14) {
        f.active = false; f.trail = []; setFlying(false)
        if (bodyRef.current != null) bodyRef.current.style.filter = ''
        ghostRefs.current.forEach((g) => { if (g != null) g.style.display = 'none' })
        setPos(posRef.current); return
      }
      f.raf = window.requestAnimationFrame(step)
    }
    f.raf = window.requestAnimationFrame(step)
  }, [ctx])

  useEffect(() => () => {
    const f = flightRef.current
    if (f.active && f.raf !== 0) window.cancelAnimationFrame(f.raf)
    f.active = false
  }, [])

  // Pointer handlers
  const onPointerDown = (ev: globalThis.PointerEvent) => {
    if (typeof ev.button === 'number' && ev.button !== 0) return
    getAudio()
    stopFlight()
    const s = simHolder.current
    if (s != null) s.blinkStart = performance.now()
    dragRef.current = { sx: ev.clientX, sy: ev.clientY, ox: posRef.current.x, oy: posRef.current.y, moved: false }
    dragSamplesRef.current = [{ t: performance.now(), x: ev.clientX, y: ev.clientY }]
    if (typeof (ev.currentTarget as any).setPointerCapture === 'function') {
      try { (ev.currentTarget as any).setPointerCapture(ev.pointerId) } catch { /* no-op */ }
    }
  }

  const onPointerMove = (ev: globalThis.PointerEvent) => {
    const drag = dragRef.current
    if (drag == null) return
    const dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return
    drag.moved = true
    const w = typeof window !== 'undefined' ? window as any : null
    const vw = w == null ? 1200 : w.innerWidth, vh = w == null ? 800 : w.innerHeight
    const top = petTopLimit()
    const next = {
      x: clamp(drag.ox + dx, 0, Math.max(0, vw - 84)),
      y: clamp(drag.oy + dy, top, Math.max(top, vh - 84)),
    }
    posRef.current = next; setPos(next)
    const samples = dragSamplesRef.current
    samples.push({ t: performance.now(), x: ev.clientX, y: ev.clientY })
    if (samples.length > 12) samples.shift()
  }

  const onPointerUp = (ev: globalThis.PointerEvent) => {
    const drag = dragRef.current; dragRef.current = null
    if (drag == null) return
    if (!drag.moved) {
      if (soundOnRef.current) playSound('pet')
      // 点击：从 6 种快捷动作中随机触发一种
      const picked = QUICK_ACTIONS[Math.floor(Math.random() * QUICK_ACTIONS.length)]![0]
      triggerAction(picked)
      setBubbleOpen((o) => !o)
      return
    }
    // 距离判定：拖得太短只是移动位置，不甩出
    const totalDist = Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy)
    if (totalDist < 24) return
    const nowT = performance.now()
    const samples = dragSamplesRef.current.filter((sp) => nowT - sp.t <= 120)
    if (samples.length < 2 || nowT - samples[samples.length - 1]!.t > 100) return
    const first = samples[0]!, last = samples[samples.length - 1]!
    const dt = last.t - first.t
    if (dt <= 8) return
    // 速度匹配：甩出速度 = 松手瞬间的鼠标速度，不加增益
    let vx = (last.x - first.x) / dt * 1000
    let vy = (last.y - first.y) / dt * 1000
    const speed = Math.hypot(vx, vy)
    if (speed < 120) return
    if (speed > 3800) { const s = 3800 / speed; vx *= s; vy *= s }
    startFlight(vx, vy)
    if (soundOnRef.current && !documentHidden()) playSound('throw')
    setAction({ name: 'surprised', until: Date.now() + 900 })
  }

  const onBoxMove = (ev: globalThis.PointerEvent) => {
    if (appearance.gazeAlways) return
    const s = simHolder.current
    if (s == null) return
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
    s.gazeX = clamp((ev.clientX - rect.left) / rect.width * 2 - 1, -0.6, 0.6) * 22
    s.gazeY = clamp((ev.clientY - rect.top) / rect.height * 2 - 1, -0.6, 0.6) * 14
  }

  const onBoxLeave = () => {
    setHovering(false)
    if (appearance.gazeAlways) return
    const s = simHolder.current
    if (s != null) { s.gazeX = 0; s.gazeY = 0 }
  }

  const onContextMenu = (ev: globalThis.MouseEvent) => {
    ev.preventDefault()
    if (typeof ev.button === 'number' && ev.button !== 2) return
    getAudio(); stopFlight()
    // 先放在光标处（隐藏）占位，尺寸测好后由 useLayoutEffect 重定位
    setMenu({ x: ev.clientX, y: ev.clientY, ready: false })
  }

  // Settings
  const toggleSound = () => { const next = !soundOnRef.current; soundOnRef.current = next; setSoundOn(next); lsSet('sound', next); if (next) { getAudio(); playSound('pet') } }
  const toggleNotify = () => {
    const N = notifyApi()
    const desktop = isDesktopApp()
    if (N == null) { flashNotice(desktop ? '当前环境不支持系统通知' : '此浏览器不支持桌面通知'); return }
    if (N.permission === 'denied') { flashNotice(desktop ? '通知被系统阻止' : '通知被浏览器阻止'); return }
    if (N.permission === 'granted') {
      const next = !notifyOnRef.current; notifyOnRef.current = next; setNotifyOn(next); lsSet('notify', next)
      if (next) sendNotification('DSH · 通知已开启', '请求开始/完成时发送通知', 'dsh-pet-hello')
      else flashNotice('桌面通知已关闭'); return
    }
    const done = (permission: string) => {
      if (permission === 'granted') { notifyOnRef.current = true; setNotifyOn(true); lsSet('notify', true); sendNotification('DSH · 通知已开启', '', 'dsh-pet-hello') }
      else if (permission === 'denied') flashNotice(desktop ? '通知权限被系统拒绝' : '通知权限被拒绝')
    }
    try { const r = N.requestPermission(done); if (r != null && typeof r.then === 'function') r.then(done).catch(() => {}) } catch { flashNotice('无法请求通知权限') }
  }

  const hidePet = () => { stopFlight(); setMenu(null); setHovering(false); if (soundOnRef.current) playSound('bye'); setVisible(false); setBubbleOpen(false); lsSet('visible', false) }
  const showPet = () => { setVisible(true); lsSet('visible', true); if (soundOnRef.current) { getAudio(); playSound('pet') } }

  const nowRender = Date.now()
  const actionActive = action.name !== '' && action.until > nowRender
  const petState = flying ? 'surprised'
    : actionActive ? action.name
    : running ? (snap.currentTool != null ? 'working' : 'thinking')
    : hovering ? 'listening' : 'idle'

  useEffect(() => {
    const prev = prevPetStateRef.current; prevPetStateRef.current = petState
    if (prev == null || prev === petState) return
    const map: Record<string, string> = {
      surprised: css.bodyActGlitch ?? '', happy: css.bodyActBounce ?? '', listening: css.bodyActTilt ?? '',
      thinking: css.bodyActTilt ?? '', working: css.bodyActScan ?? '',
    }
    const cls = map[petState] ?? ''
    setMotionCls(cls)
    if (cls !== '') ctx.timeout(() => setMotionCls((cur) => (cur === cls ? '' : cur)), 1100)
  }, [petState, ctx])

  const bodyClass = css.body + (motionCls !== '' ? ' ' + motionCls : '')
  const toolName = snap.currentTool ?? '模型推理'
  const petName = appearance.name

  // Bubble content
  const bubbleEl = running
    ? createElement('div', { className: css.bubble },
      createElement('div', { className: css.bubbleTitle }, `正在思考 · ${fmtElapsed(snap.elapsedMs)}`),
      createElement('div', { className: css.bubbleLine }, `执行 ${toolName}`),
      createElement('div', { className: css.bubbleSub }, `第 ${snap.turn ?? '?'} 轮 · 第 ${snap.step ?? '?'} 步 · 已 ${snap.turnCount} 轮`),
      createElement('div', { className: css.bar }, createElement('div', { className: css.barFill })))
    : createElement('div', { className: css.bubble },
      createElement('div', { className: css.bubbleTitle }, petName),
      createElement('div', { className: css.bubbleLine }, !snap.hasSession ? '正在连接…' : `就绪 · 已完成 ${snap.turnCount} 轮`),
      snap.lastUsage != null
        ? createElement('div', { className: css.bubbleSub },
          `上次用量 ${fmtTokens(usageTokens(snap.lastUsage))} tokens · ${fmtCost(usageCost(snap.lastUsage))}`)
        : null)

  // 顶层始终返回 .root，隐藏/显示只靠 CSS 类切换（.box 与恢复按钮都保持挂载），
  // 不做顶层元素类型切换，避免隐藏/恢复时界面不即时更新。
  return createElement('div', { className: css.root, style: { left: pos.x, top: pos.y }, ref: rootRef },
    createElement('div', {
      className: css.box + (visible ? '' : ' ' + css.hidden),
      onPointerEnter: () => setHovering(true), onPointerLeave: onBoxLeave, onPointerMove: onBoxMove,
    },
      (bubbleOpen || running) ? bubbleEl : null,
      hearts.map((h) => createElement('span', { key: h.id, className: css.heart, style: { '--dx': h.dx + 'px', animationDelay: h.delay + 'ms' } as any }, '♥')),
      ghostRefs.current.map((_, i) => createElement('div', {
        key: 'ghost' + i, ref: (n: HTMLDivElement | null): void => { ghostRefs.current[i] = n },
        className: css.ghost, style: { background: colorHex(appearance) },
      })),
      createElement('div', {
        className: bodyClass, ref: bodyRef, role: 'img',
        'aria-label': running ? `${petName}：正在处理请求` : `${petName}：就绪`,
        title: `${petName} · 左键拖动/点击 · 右键换装`,
        onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onContextMenu,
      }, createElement(GrokbotFigure, { petState, data: EXPR_DATA, simHolder })),
      notice != null ? createElement('div', { className: css.notice }, notice) : null,
    ),
    menuOpen ? createElement('div', {
      ref: menuRef,
      className: css.panelWrap + ' dsh-pet-panel' + (menu!.ready ? '' : ' ' + css.panelMeasuring),
      style: { left: menu!.x, top: menu!.y },
    },
      createElement(AppearancePanelInner, {
        variant: 'menu',
        soundOn, notifyOn,
        onToggleSound: toggleSound,
        onToggleNotify: toggleNotify,
        onHide: hidePet,
      })) : null,
    // 恢复按钮：始终挂载，宠物可见时用 .hidden 隐藏（不再依赖条件渲染出现）
    createElement('button', {
      type: 'button',
      className: css.reshow + (visible ? ' ' + css.hidden : ''),
      title: '显示 DSH 桌宠',
      onClick: showPet,
    }, '🐾'),
  )
}

// ── AppearancePanel（右键换装 / 设置页共用）──────────────────────────

interface AppearancePanelProps {
  /** 'menu'：右键换装（仅颜色/形状/部件/配饰 + 控制）；'settings'：设置页（另含名字/眼睛跟随/快捷动作）。 */
  variant?: 'menu' | 'settings'
  /** 手动触发快捷动作的回调（仅设置页传入）。 */
  onAction?: (name: string) => void
  /** 音效开关状态与回调（仅右键菜单传入）。 */
  soundOn?: boolean
  notifyOn?: boolean
  onToggleSound?: () => void
  onToggleNotify?: () => void
  /** 隐藏桌宠（仅右键菜单传入）。 */
  onHide?: () => void
}

function AppearancePanelInner({ variant = 'menu', onAction, soundOn, notifyOn, onToggleSound, onToggleNotify, onHide }: AppearancePanelProps) {
  const a = useAppearance()
  const color = colorHex(a)
  const settings = variant === 'settings'
  return createElement('div', { className: css.panel },
    createElement('div', { className: css.panelTitle }, settings ? '桌宠外观' : '换装'),
    settings ? createElement('div', { className: css.panelLabel }, createElement('strong', null, '名字'), createElement('span', null, '点击宠物时显示')) : null,
    settings ? createElement('input', {
      className: css.nameInput, type: 'text', value: a.name, maxLength: 24, placeholder: DEFAULT_APPEARANCE.name,
      onChange: (ev: { target: { value: string } }) => setAppearance({ ...a, name: ev.target.value }),
      onBlur: (ev: { target: { value: string } }) => {
        const t = ev.target.value.trim()
        if (t === '') setAppearance({ ...a, name: DEFAULT_APPEARANCE.name })
      },
    }) : null,
    createElement('div', { className: css.panelLabel }, createElement('strong', null, '颜色'), createElement('span', null, COLORS.find((c) => c[2] === color)?.[1] ?? '')),
    createElement('div', { className: css.panelRow },
      ...COLORS.map((c) => createElement('button', {
        key: c[0], type: 'button', title: c[1], 'aria-pressed': String(a.color === c[2]),
        className: css.dot + (a.color === c[2] ? ' ' + css.dotOn : ''),
        style: { '--swatch': c[2] } as any,
        onClick: () => setAppearance({ ...a, color: c[2] }),
      }))),
    createElement('div', { className: css.panelLabel }, createElement('strong', null, '形状'), createElement('span', null, SHAPES.find((s) => s[0] === a.shape)?.[1] ?? '')),
    createElement('div', { className: css.panelRow },
      ...SHAPES.map((s) => createElement('button', {
        key: s[0], type: 'button', title: s[1], 'aria-pressed': String(a.shape === s[0]),
        className: css.shapeBtn + (a.shape === s[0] ? ' ' + css.shapeBtnOn : ''),
        onClick: () => setAppearance({ ...a, shape: s[0] }),
      }, createElement('svg', { viewBox: '0 0 229 229' },
        createElement('path', { d: s[2], fill: color }),
        createElement('ellipse', { cx: 87, cy: 102, rx: 9, ry: 21, fill: '#fffdf7' }),
        createElement('ellipse', { cx: 143, cy: 102, rx: 9, ry: 21, fill: '#fffdf7' }),
      )))),
    createElement('div', { className: css.panelLabel }, createElement('strong', null, '身体部件'),
      createElement('span', null, a.parts.length > 0 ? PARTS.filter((p) => a.parts.includes(p[0])).map((p) => p[1]).join('、') : '默认无部件')),
    createElement('div', { className: css.toggleBtn },
      ...PARTS.map((p) => createElement('button', {
        key: p[0], type: 'button', title: p[1], 'aria-pressed': String(a.parts.includes(p[0])),
        onClick: () => setAppearance({ ...a, parts: toggleId(a.parts, p[0]) }),
      }, createElement('b', null, p[2]), createElement('span', null, p[1])))),
    createElement('div', { className: css.panelLabel }, createElement('strong', null, '趣味配饰'),
      createElement('span', null, a.accessories.length > 0 ? ACCESSORIES.filter((ac) => a.accessories.includes(ac[0])).map((ac) => ac[1]).join('、') : '默认无配饰')),
    createElement('div', { className: css.toggleBtn },
      ...ACCESSORIES.map((ac) => createElement('button', {
        key: ac[0], type: 'button', title: ac[1], 'aria-pressed': String(a.accessories.includes(ac[0])),
        onClick: () => setAppearance({ ...a, accessories: toggleId(a.accessories, ac[0]) }),
      }, createElement('b', null, ac[2]), createElement('span', null, ac[1])))),
    // 控制（音效/通知/隐藏）——原悬停球合并进右键菜单
    !settings
      ? createElement('div', null,
        createElement('div', { className: css.panelLabel }, createElement('strong', null, '控制')),
        createElement('div', { className: css.toggleBtn + ' ' + css.ctlRow },
          createElement('button', {
            type: 'button', title: soundOn ? '关闭音效' : '开启音效', 'aria-pressed': String(soundOn ?? false),
            onClick: () => onToggleSound?.(),
          }, createElement('b', null, soundOn ? '✓' : '—'), createElement('span', null, '音效')),
          createElement('button', {
            type: 'button', title: isDesktopApp() ? '桌面通知（系统通知）' : '桌面通知（Chrome → Windows）', 'aria-pressed': String(notifyOn ?? false),
            onClick: () => onToggleNotify?.(),
          }, createElement('b', null, notifyOn ? '✓' : '—'), createElement('span', null, '通知')),
          createElement('button', {
            type: 'button', title: '隐藏桌宠',
            onClick: () => onHide?.(),
          }, createElement('b', null, '👋'), createElement('span', null, '隐藏')),
        ))
      : null,
    settings ? createElement('div', { className: css.panelLabel }, createElement('strong', null, '眼睛跟随'),
      createElement('span', null, a.gazeAlways ? '始终注视鼠标' : '仅悬停时注视')) : null,
    settings ? createElement('div', { className: css.toggleBtn },
      createElement('button', {
        key: 'gaze', type: 'button', title: '鼠标不在宠物身上时，眼睛也跟随鼠标', 'aria-pressed': String(a.gazeAlways),
        onClick: () => setAppearance({ ...a, gazeAlways: !a.gazeAlways }),
      }, createElement('b', null, a.gazeAlways ? '✓' : '—'), createElement('span', null, '始终注视'))) : null,
    settings && onAction != null
      ? createElement('div', null,
        createElement('div', { className: css.panelLabel }, createElement('strong', null, '快捷动作'),
          createElement('span', null, '在上方预览中立即触发')),
        createElement('div', { className: css.actionRow },
          ...QUICK_ACTIONS.map(([name, label]) => createElement('button', {
            key: name, type: 'button', className: css.actionBtn, title: `触发「${label}」`,
            onClick: () => { onAction(name) },
          }, label))),
      )
      : null,
    createElement('button', { type: 'button', className: css.resetBtn, onClick: () => setAppearance({ ...DEFAULT_APPEARANCE }) }, '恢复默认'),
  )
}

function documentHidden(): boolean {
  const d = typeof document !== 'undefined' ? document : null
  return d != null && d.hidden === true
}

/** Settings page panel for the pet appearance. */
export function PetSettingsPage() {
  const [previewState, setPreviewState] = useState('idle')
  const previewTimerRef = useRef(0)
  const triggerPreview = (name: string) => {
    setPreviewState(name)
    if (previewTimerRef.current !== 0) window.clearTimeout(previewTimerRef.current)
    previewTimerRef.current = window.setTimeout(() => { setPreviewState('idle') }, 1800)
  }
  useEffect(() => () => {
    if (previewTimerRef.current !== 0) window.clearTimeout(previewTimerRef.current)
  }, [])
  return createElement('div', { className: css.settings },
    createElement('h3', null, '桌宠外观设置'),
    createElement('div', { className: css.settingsPreview },
      createElement('div', { className: css.settingsFigure },
        createElement(GrokbotFigure, { petState: previewState, data: EXPR_DATA, simHolder: { current: null } }))),
    createElement('div', { style: { height: 10 } }),
    createElement(AppearancePanelInner, { variant: 'settings', onAction: triggerPreview }),
    createElement('div', { className: css.settingsFoot },
      '外观即时同步到桌宠，并自动保存。造型与表情数据严格移植自 LaoA-GrokBot（MIT License），配饰与部件支持多选叠穿 — 也可以在桌宠上右键直接换装。'),
  )
}
