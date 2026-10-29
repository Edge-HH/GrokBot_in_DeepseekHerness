/**
 * Host-surface detection for the pet.
 *
 * The same client bundle runs in two shells:
 *  - the browser Web GUI (plain `http(s)://` page), and
 *  - the DSH Desktop app, which renders the Web client inside Electron from
 *    the privileged `dsh-app://app/` scheme and marks `<html data-platform>`.
 *
 * Desktop adds native window chrome (a titlebar drag strip) above the shell's
 * floating layer, so the pet must keep clear of it and use host-appropriate
 * copy for system notifications.
 *
 * @module dsh-grokbot-pet/client/platform
 */

/** Whether the client is running inside the DSH Desktop Electron shell. */
export function isDesktopApp(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  try {
    if (window.location?.protocol === 'dsh-app:') return true
  } catch { /* opaque location */ }
  return document.documentElement.hasAttribute('data-windows-titlebar')
}

/** Desktop host platform, or null in a plain browser tab. */
export function desktopPlatform(): 'darwin' | 'win32' | 'linux' | null {
  if (typeof document === 'undefined') return null
  const value = document.documentElement.dataset.platform
  return value === 'darwin' || value === 'win32' || value === 'linux' ? value : null
}

/**
 * Top inset (px) of the shell's floating layer, below any native window chrome.
 *
 * The Desktop shell exposes `--dsh-frame-overlay-top` (titlebar clearance plus
 * the shell's own gutter) and zeroes it in fullscreen. The variable is absent
 * in a browser tab, where the floating layer starts at the viewport edge.
 * Results are memoized briefly because pointer handlers consult this per move.
 */
const INSET_CACHE_MS = 500
let insetCache: { value: number; at: number } | null = null

export function overlayTopInset(force = false): number {
  if (typeof document === 'undefined' || document.body === null) return 0
  const now = Date.now()
  if (!force && insetCache !== null && now - insetCache.at < INSET_CACHE_MS) return insetCache.value
  const probe = document.createElement('div')
  probe.setAttribute('aria-hidden', 'true')
  probe.style.cssText = 'position:absolute;top:0;left:0;width:0;height:var(--dsh-frame-overlay-top,0px);visibility:hidden;pointer-events:none'
  document.body.appendChild(probe)
  let height = 0
  try { height = probe.getBoundingClientRect().height } finally { probe.remove() }
  const value = Number.isFinite(height) ? Math.max(0, Math.round(height)) : 0
  insetCache = { value, at: now }
  return value
}

/** Smallest Y the pet may occupy so it stays clickable below window chrome. */
export function petTopLimit(): number {
  return Math.max(8, overlayTopInset())
}
