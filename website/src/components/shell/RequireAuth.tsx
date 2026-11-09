import { useEffect } from "react"
import { useLocation, useNavigate } from "react-router"
import { LoadingSpinner } from "@/components/ui/spinner"
import { useAuth } from "@/providers/AuthProvider"
import { signInPath } from "@/lib/signInReturn"
import { BUSY_MESSAGE } from "@/lib/authFlow"

export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { user, loading, busy } = useAuth()

  useEffect(() => {
    if (!loading && !user) navigate(signInPath(pathname), { replace: true })
  }, [user, loading, navigate, pathname])

  if (loading) {
    return (
      <div className="flex min-h-window flex-col items-center justify-center gap-3 bg-app-bg">
        <LoadingSpinner size="lg" />
        <p aria-live="polite" className="text-ui text-muted-foreground">
          {busy ? BUSY_MESSAGE : ""}
        </p>
      </div>
    )
  }

  if (!user) return null

  return <>{children}</>
}
