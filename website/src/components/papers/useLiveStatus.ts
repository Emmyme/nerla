import { useEffect, useRef, useState } from "react"
import type { HocuspocusProvider } from "@hocuspocus/provider"

/**
 * A doc connection's own events: its first sync, drops, and the server's answer each time it signs in again. Signing
 * in again after the first time, or being refused, calls `onAccessChange`
 */
export function useLiveStatus(provider: HocuspocusProvider | null, onAccessChange?: () => void) {
  const [syncedOn, setSyncedOn] = useState<HocuspocusProvider | null>(null)
  const [offline, setOffline] = useState(false)
  const [denied, setDenied] = useState(false)
  const accessChange = useRef(onAccessChange)
  accessChange.current = onAccessChange

  useEffect(() => {
    setOffline(false)
    setDenied(false)
    if (!provider) return
    let signedIn = provider.isAuthenticated
    const onSynced = () => setSyncedOn(provider)
    const onStatus = ({ status }: { status: string }) => setOffline(status === "disconnected")
    const onAuthenticated = () => {
      setDenied(false)
      if (signedIn) accessChange.current?.()
      signedIn = true
    }
    const onDenied = () => {
      setDenied(true)
      accessChange.current?.()
    }
    if (provider.isSynced) setSyncedOn(provider)
    provider.on("synced", onSynced)
    provider.on("status", onStatus)
    provider.on("authenticated", onAuthenticated)
    provider.on("authenticationFailed", onDenied)
    return () => {
      provider.off("synced", onSynced)
      provider.off("status", onStatus)
      provider.off("authenticated", onAuthenticated)
      provider.off("authenticationFailed", onDenied)
    }
  }, [provider])

  const synced = !!provider && (syncedOn === provider || provider.isSynced)
  return { synced, offline, denied }
}
