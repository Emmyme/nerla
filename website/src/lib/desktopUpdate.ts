import { toast } from "sonner"
import { inCall } from "@/lib/socket"

const CALL_POLL_MS = 3000

async function installAndRestart(install: () => Promise<void>): Promise<void> {
  try {
    await install()
  } catch (err) {
    console.error("[desktopUpdate] install failed", err)
    toast.error("The update could not be installed. It will be tried again next time Nerla starts.")
    return
  }
  try {
    const { relaunch } = await import("@tauri-apps/plugin-process")
    await relaunch()
  } catch (err) {
    console.error("[desktopUpdate] relaunch failed", err)
    toast.info("Nerla is updated. Close and open it again to finish.")
  }
}

function restartWhenCallEnds(install: () => Promise<void>): void {
  if (!inCall()) {
    void installAndRestart(install)
    return
  }
  toast.info("It restarts when the call ends.")
  const timer = setInterval(() => {
    if (inCall()) return
    clearInterval(timer)
    void installAndRestart(install)
  }, CALL_POLL_MS)
}

/** Checks once at start and downloads in the background. Without updater settings or a release it logs and does nothing. */
export async function startDesktopUpdateCheck(): Promise<void> {
  try {
    const { check } = await import("@tauri-apps/plugin-updater")
    const update = await check()
    if (!update) return
    await update.download()
    toast(`Nerla ${update.version} is ready.`, {
      duration: Infinity,
      action: { label: "Restart now", onClick: () => restartWhenCallEnds(() => update.install()) },
    })
  } catch (err) {
    console.warn("[desktopUpdate] update check failed", err)
  }
}
