import { dlopen, ptr } from "bun:ffi"

const STD_INPUT_HANDLE = -10
const ENABLE_PROCESSED_INPUT = 0x0001

const kernel = () =>
  dlopen("kernel32.dll", {
    GetStdHandle: { args: ["i32"], returns: "ptr" },
    GetConsoleMode: { args: ["ptr", "ptr"], returns: "i32" },
    SetConsoleMode: { args: ["ptr", "u32"], returns: "i32" },
    SetConsoleCtrlHandler: { args: ["ptr", "i32"], returns: "i32" },
  })

let k32: ReturnType<typeof kernel> | undefined

function load() {
  if (process.platform !== "win32") return false
  try {
    k32 ??= kernel()
    return true
  } catch {
    return false
  }
}

/**
 * Clear ENABLE_PROCESSED_INPUT on the console stdin handle.
 */
export function win32DisableProcessedInput() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  const buf = new Uint32Array(1)
  if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return

  const mode = buf[0]!
  if ((mode & ENABLE_PROCESSED_INPUT) === 0) return
  k32!.symbols.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT)
}

/**
 * Tell Windows to ignore CTRL_C_EVENT for this process.
 *
 * SetConsoleCtrlHandler(NULL, TRUE) makes the process ignore Ctrl+C
 * signals at the OS level. Belt-and-suspenders alongside disabling
 * ENABLE_PROCESSED_INPUT.
 */
export function win32IgnoreCtrlC() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return

  k32!.symbols.SetConsoleCtrlHandler(null, 1)
}

let unhook: (() => void) | undefined

/**
 * Keep ENABLE_PROCESSED_INPUT disabled.
 *
 * On Windows, Ctrl+C becomes a CTRL_C_EVENT (instead of stdin input) when
 * ENABLE_PROCESSED_INPUT is set. Various runtimes can re-apply console modes
 * (sometimes on a later tick), and the flag is console-global, not per-process.
 *
 * We combine:
 * - A `setRawMode(...)` hook to re-clear after known raw-mode toggles.
 * - A low-frequency poll as a backstop for native/external mode changes.
 */
export function win32InstallCtrlCGuard() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return
  if (unhook) return unhook

  const stdin = process.stdin as any
  const original = stdin.setRawMode

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  const buf = new Uint32Array(1)

  const enforce = () => {
    if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return
    const mode = buf[0]!
    if ((mode & ENABLE_PROCESSED_INPUT) === 0) return
    k32!.symbols.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT)
  }

  // Some runtimes can re-apply console modes on the next tick; enforce twice.
  const later = () => {
    enforce()
    setImmediate(enforce)
  }

  if (typeof original === "function") {
    stdin.setRawMode = (mode: boolean) => {
      const result = original.call(stdin, mode)
      later()
      return result
    }
  }

  // Ensure it's cleared immediately too (covers any earlier mode changes).
  later()

  const interval = setInterval(enforce, 100)

  unhook = () => {
    clearInterval(interval)
    if (typeof original === "function") {
      stdin.setRawMode = original
    }
    unhook = undefined
  }

  return unhook
}
