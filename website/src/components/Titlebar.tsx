import { useLayoutEffect, useSyncExternalStore, type ReactNode } from "react"
import { isTauri } from "@tauri-apps/api/core"
import { WindowControls } from "@/components/shell/WindowControls"
import { cn } from "@/lib/utils"

/** The desktop window's drag strip, --titlebar-h tall. It stays usable while a modal sheet blocks the page. Children opt out of dragging themselves */
export function TitleStrip({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <div
      data-tauri-drag-region
      className={cn("app-region-drag pointer-events-auto flex h-titlebar shrink-0 items-stretch justify-end select-none", className)}
    >
      {children}
    </div>
  )
}

let shells = 0
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const inShell = () => shells > 0

/** The shell and the call draw their own strips, so the standalone title bar steps aside while either is mounted */
export function useShellTitlebar() {
  useLayoutEffect(() => {
    shells += 1
    listeners.forEach((listener) => listener())
    return () => {
      shells -= 1
      listeners.forEach((listener) => listener())
    }
  }, [])
}

/** The title bar for screens outside the shell, such as sign-in, join and the meeting window before the call */
export default function Titlebar() {
  const hidden = useSyncExternalStore(subscribe, inShell, inShell)
  if (!isTauri() || hidden) return null

  return (
    <TitleStrip className="sticky top-0 z-40 bg-app-bg">
      <WindowControls />
    </TitleStrip>
  )
}
