// ============================================================================
// windowErrors.ts — webContents error capture, split out of windows.ts (Task #13).
// ============================================================================
//
// A PURE MOVE. Both functions below came out of `windows.ts` unchanged when that file reached the
// 400-code-line ceiling; the repo's answer to that is a split, not a widened threshold (the same
// call `usageStore.ts`, `AnalyticsBits.tsx` and `releaseHealth.ts` all made). Nothing here is new
// behaviour — the only edit the move required is the one described under `captureMainWindowErrors`.
//
// WHY THIS IS THE RIGHT CUT. `windows.ts` is about CREATING windows and owns the trust boundary
// (`WEB_PREFERENCES`, `hardenWebContents`, `hardenSession` — all of which stay there, beside the
// only code that constructs a BrowserWindow). What is here is the other thing that file had grown:
// the plumbing that makes a broken renderer AUDIBLE rather than a blank rectangle. It is attached
// to a webContents, it talks only to `errorLog`, and it decides nothing about how a window is made.
//
// It is also the natural home for the renderer-crash HEALTH COUNTER (JOS-96): the crash count and
// the crash log are the same event observed twice, and they now sit in the same handler.

import { join } from 'path'
import { logError } from './errorLog'
import { noteRendererCrash } from './telemetry'

/** How the capture reaches the window it may need to reload. Injected rather than imported so
 *  this module does not import `windows.ts` back and close a cycle. */
export type WindowRef = () => Electron.BrowserWindow | null

/**
 * Forward renderer console warnings/errors (level >= 2) into main stdout +
 * errors.log so agents reading the dev task output see renderer-side errors too.
 * level: 0=verbose 1=info 2=warning 3=error.
 *
 * Electron's `console-message` listener is five positional arguments wide; the four fields
 * are taken as a rest tuple so the callback stays inside the project's max-params ceiling.
 * `tag` is the errors.log source tag ('renderer:console' / 'overlay:console').
 */
export function forwardConsoleMessages(wc: Electron.WebContents, tag: string): void {
  wc.on('console-message', (_e, ...rest) => {
    const [level, message, line, sourceId] = rest
    if (level < 2) return
    logError(tag, { level, message, source: `${sourceId}:${line}` })
  })
}

/**
 * webContents error capture for the MAIN window (Task #13). Each of these would otherwise
 * leave a blank window with no console trace. Log everything to errors.log + dev stdout, and
 * self-heal once where it's safe.
 *
 * THE ONE EDIT THE SPLIT REQUIRED: the module-local `mainWindow` this used to close over is now
 * the `window` argument. Every read is still a fresh call, so the late-crash guards
 * (`!window() || window().isDestroyed()`) mean exactly what they meant when they read a mutable
 * module variable — which is the property that matters, since every one of them fires long after
 * this function has returned.
 */
export function captureMainWindowErrors(wc: Electron.WebContents, window: WindowRef): void {
  // The renderer process died/crashed (OOM, GPU crash, killed). Log the reason,
  // then reload the window ONCE so a transient crash doesn't strand the user.
  let renderProcessReloaded = false
  wc.on('render-process-gone', (_e, details) => {
    // ONE CRASH IS ONE COUNT (JOS-96) — counted here rather than off `logError`, because this
    // handler writes TWO log lines per crash (the details, then the recovery reload) and counting
    // lines would report every crash as two. `mainErrorLogLines` still sees both, correctly.
    // MAIN WINDOW ONLY: overlays get `forwardConsoleMessages` but no crash handler, so an overlay
    // crash is invisible to this counter and `telemetry/health.ts` says so.
    noteRendererCrash()
    logError('main:render-process-gone', details)
    const win = window()
    if (!renderProcessReloaded && win && !win.isDestroyed()) {
      renderProcessReloaded = true
      logError('main:render-process-gone', 'reloading window once to recover')
      win.reload()
    }
  })

  // The page (or dev server) failed to load. Retry ONCE — most common in dev when
  // the window opens a beat before electron-vite's renderer server is ready.
  // (Rest tuple for the same max-params reason as forwardConsoleMessages.)
  let didFailReloaded = false
  wc.on('did-fail-load', (_e, ...rest) => {
    const [errorCode, errorDescription, validatedURL, isMainFrame] = rest
    // errorCode -3 (ABORTED) is a benign navigation cancel; don't spam or retry.
    if (errorCode === -3) return
    logError('main:did-fail-load', { errorCode, errorDescription, validatedURL, isMainFrame })
    const win = window()
    if (isMainFrame && !didFailReloaded && win && !win.isDestroyed()) {
      didFailReloaded = true
      setTimeout(() => {
        // RE-READ, never the `win` captured above: 300 ms is long enough for the window to have
        // gone, and this guard is the whole reason the delay is safe.
        const live = window()
        if (!live || live.isDestroyed()) return
        const url = process.env.ELECTRON_RENDERER_URL
        if (url) void live.loadURL(url)
        else void live.loadFile(join(__dirname, '../renderer/index.html'))
      }, 300)
    }
  })

  // A preload script threw while initializing (the contextBridge/api is then
  // missing — a classic invisible cause of a broken renderer).
  wc.on('preload-error', (_e, preloadPath, error) => {
    logError('main:preload-error', { preloadPath, error })
  })

  forwardConsoleMessages(wc, 'renderer:console')
}
