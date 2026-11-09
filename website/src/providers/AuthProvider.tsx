import React, { createContext, useContext, useState, useEffect } from "react"
import { isTauri } from "@tauri-apps/api/core"
import { toast } from "sonner"
import { ApiError } from "@/lib/api/request"
import { authAPI, usersAPI, type User } from "@/lib/api/users"
import { loadApp } from "@/lib/appPath"
import { busyRetryMs } from "@/lib/authFlow"
import { deviceTimeZone } from "@/lib/dates"
import { getToken, removeToken } from "@/lib/authToken"
import { initializeSocket, disconnectSocket } from "@/lib/socket"
import { startPresence, stopPresence } from "@/lib/presenceStore"
import { setChatUser } from "@/lib/chatLive"
import { startNotifications, stopNotifications } from "@/lib/notificationStore"
import { startAiStore, stopAiStore } from "@/lib/aiStore"
import { messageOf } from "@/lib/taskStore"
import { clearDock } from "@/components/chat/dockWindows"
import { adoptAccountAccessibility, leaveAccountAccessibility } from "@/lib/accessibility"

interface AuthContextType {
  user: User | null
  loading: boolean
  /** The session check got a 429 and is waiting to ask again */
  busy: boolean
  logout: () => void
  refreshUser: () => Promise<void>
}

const SIGN_OUT_FAILED = "Couldn't sign you out everywhere. Try again."
// The desktop drops its own token, while the web's HttpOnly cookie only goes when the server answers
const signOutUnreachable = () =>
  isTauri()
    ? "Couldn't reach the server, so this device is signed out but the session may stay active until it expires."
    : "Couldn't reach the server, so this browser may still be signed in. Sign out again once you're back online."

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    const check = async () => {
      // Desktop authenticates with the stored Bearer token, web sends its HttpOnly cookie
      let token: string | null = null
      if (isTauri()) {
        token = await getToken()
        if (cancelled) return
      }
      if (!isTauri() || token) {
        try {
          const userData = await authAPI.getCurrentUser()
          if (cancelled) return
          adoptAccountAccessibility(userData.accessibility)
          setUser(userData)
          setChatUser(userData)
          // With no zone saved, the server would read every time as UTC, so this device's zone is saved, as Settings already shows it
          if (userData.id && !userData.timeZone) {
            usersAPI.updateProfile({ timeZone: deviceTimeZone() }).then(
              (saved) => !cancelled && setUser(saved),
              () => undefined,
            )
          }
          if (userData.id && userData.email) {
            initializeSocket(token ?? undefined)
            startPresence(userData.id)
            startNotifications()
            startAiStore()
          }
        } catch (err) {
          if (cancelled) return
          // A busy server is still there, so the session waits instead of signing out
          const wait = err instanceof ApiError ? busyRetryMs(err.status, err.retryAfter) : null
          if (wait !== null) {
            setBusy(true)
            retry = setTimeout(() => void check(), wait)
            return
          }
          // Only a refused token is dropped, so starting offline keeps the session for later
          if (token && err instanceof ApiError && err.status === 401) await removeToken()
        }
      }
      if (!cancelled) {
        setBusy(false)
        setLoading(false)
      }
    }
    void check()
    return () => {
      cancelled = true
      clearTimeout(retry)
    }
  }, [])

  const logout = () => {
    const userId = user?.id
    void (async () => {
      setUser(null)
      leaveAccountAccessibility()
      stopPresence()
      stopNotifications()
      stopAiStore()
      disconnectSocket()
      setChatUser(null)
      if (userId) clearDock(userId)
      // The desktop token goes only after the request carried it, so the server can revoke it. Web: the server clears the cookie
      const failure = await authAPI.logout().then(
        () => null,
        (err: unknown) => (!(err instanceof ApiError) ? signOutUnreachable() : err.status === 401 ? null : messageOf(err, SIGN_OUT_FAILED)),
      )
      await removeToken().catch(console.error) // desktop: clears the stored token, web: no-op
      const leave = () => typeof window !== "undefined" && loadApp("/sign-in")
      // A failure is said before the page reloads
      if (failure) toast.error(failure, { onAutoClose: leave, onDismiss: leave })
      else leave()
    })()
  }

  const refreshUser = async () => {
    // Desktop without a stored token isn't logged in, web relies on the cookie.
    if (isTauri() && !(await getToken())) return
    try {
      const userData = await authAPI.getCurrentUser()
      setUser(userData)
      setChatUser(userData)
    } catch (error) {
      console.error("Failed to refresh user:", error)
    }
  }

  return <AuthContext.Provider value={{ user, loading, busy, logout, refreshUser }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider")
  }
  return context
}

export function useUser() {
  const { user, loading } = useAuth()
  return {
    user: user
      ? {
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          emailAddresses: [{ emailAddress: user.email }],
          imageUrl: user.avatarUrl,
          role: user.role,
          createdAt: user.createdAt,
        }
      : null,
    isLoaded: !loading,
    isSignedIn: !!user,
  }
}
