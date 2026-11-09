import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, Navigate, Outlet, useLocation } from "react-router"
import { ArrowLeft, ChevronRight } from "@/components/icons"
import { LoadError, LoadingRows } from "@/components/settings/LoadState"
import { adminRedirect, sectionAt, settingsSections } from "@/components/settings/settingsSections"
import { ProblemBadge } from "@/components/settings/SetupCheck"
import { SettingsOrgContext, type SettingsOrg } from "@/components/settings/useSettingsOrg"
import { PageHeader } from "@/components/shell/PageHeader"
import { useIsDesktop } from "@/lib/useMediaQuery"
import { Skeleton } from "@/components/ui/skeleton"
import { organizationsAPI, type Organization } from "@/lib/api/organizations"
import { aiVisibleOf, useAiAccess } from "@/lib/aiAccess"
import { loadSetupCheck, useSetupCheck } from "@/lib/setupCheck"
import { messageOf } from "@/lib/taskStore"
import { useBusyRetry } from "@/lib/useBusyRetry"
import { useDocumentTitle } from "@/lib/useDocumentTitle"
import { publishWorkspaceName } from "@/lib/useWorkspaceName"
import { cn } from "@/lib/utils"

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
const LOAD_FAILED = "Couldn't load your workspace. Check your connection and try again."

export default function SettingsLayout() {
  const { pathname } = useLocation()
  const desktop = useIsDesktop()
  const [org, setOrg] = useState<Organization | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const live = useRef(true)
  const { busy, waitIfBusy, done } = useBusyRetry()

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await organizationsAPI.getCurrentOrganization()
      if (!live.current) return
      setOrg(next)
      publishWorkspaceName(next?.name ?? null)
      setError(null)
    } catch (err) {
      if (!live.current || waitIfBusy(err, () => void refresh())) return
      setError(messageOf(err, LOAD_FAILED))
    }
    done()
    setLoading(false)
  }, [waitIfBusy, done])

  useEffect(() => {
    live.current = true
    void refresh()
    return () => {
      live.current = false
    }
  }, [refresh])

  const isAdmin = org?.role === "admin"
  const setup = useSetupCheck()
  // Members never ask, the server would refuse them
  useEffect(() => {
    if (isAdmin) void loadSetupCheck()
  }, [isAdmin])
  const value = useMemo<SettingsOrg>(() => ({ org, isAdmin, loading, error, refresh }), [org, isAdmin, loading, error, refresh])
  const ai = useAiAccess()
  const aiVisible = aiVisibleOf(ai.me)
  const sections = settingsSections({ isAdmin, aiVisible })
  const current = sectionAt(pathname)
  const atIndex = pathname.replace(/\/+$/, "") === "/settings"
  useDocumentTitle(current?.label, "Settings")
  // A failed load is not proof of being a member, so it shows the error rather than sending an admin away
  const redirect = adminRedirect(pathname, isAdmin, loading || !!error)

  if (redirect) return <Navigate to={redirect} replace />
  // A load that failed says nothing about the AI being off, so the page stays and offers Try again
  if (current?.ai && ai.loaded && !ai.failed && !aiVisible) return <Navigate to={desktop ? "/settings/profile" : "/settings"} replace />
  if (!current && (desktop || !atIndex)) return <Navigate to={desktop ? "/settings/profile" : "/settings"} replace />
  if (current && pathname.replace(/\/+$/, "") !== current.path) return <Navigate to={current.path} replace />

  const content = !current?.admin ? (
    <Outlet />
  ) : loading ? (
    <LoadingRows label="Loading" busy={busy}>
      <Skeleton className="h-[1.25rem] w-[10rem] rounded-sm" />
      <Skeleton className="h-[2.75rem] rounded-lg" />
      <Skeleton className="h-[2.75rem] rounded-lg" />
    </LoadingRows>
  ) : error ? (
    <LoadError
      message={error}
      onRetry={() => {
        setLoading(true)
        void refresh()
      }}
    />
  ) : (
    <Outlet />
  )

  // The section content keeps its place in the tree on both layouts, so crossing 64rem never remounts a form
  return (
    <SettingsOrgContext.Provider value={value}>
      <div className="flex flex-col gap-6 max-lg:gap-4">
        {desktop || !current ? (
          <PageHeader title="Settings" />
        ) : (
          <div className="flex flex-col gap-1">
            <Link
              to="/settings"
              aria-label="Back to settings"
              className={cn(
                "-ml-2 inline-flex h-11 items-center gap-1.5 self-start rounded-md px-2 text-ui font-medium text-muted-foreground hover:bg-app-hover hover:text-foreground",
                FOCUS,
              )}
            >
              <ArrowLeft aria-hidden="true" className="size-[1rem]" />
              Settings
            </Link>
            <PageHeader title={current.label} />
          </div>
        )}
        <div className="flex items-start gap-10">
          {desktop && (
            <nav aria-label="Settings" className="w-[12rem] shrink-0">
              <ul className="flex flex-col gap-0.5">
                {sections.map((section) => {
                  const active = current?.id === section.id
                  return (
                    <li key={section.id}>
                      <Link
                        to={section.path}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex min-h-[1.75rem] items-center gap-2 rounded-md px-2 py-1 text-body transition-colors",
                          FOCUS,
                          active
                            ? "bg-app-selected font-medium text-foreground"
                            : "text-muted-foreground hover:bg-app-hover hover:text-foreground",
                        )}
                      >
                        <span className="truncate">{section.label}</span>
                        {section.id === "setup-check" && <ProblemBadge items={setup.items} />}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </nav>
          )}
          {!desktop && !current && (
            <nav aria-label="Settings" className="min-w-0 flex-1">
              <ul className="overflow-hidden rounded-lg ring-[0.0625rem] ring-border">
                {sections.map((section) => (
                  <li key={section.id} className="border-b-[0.0625rem] border-border last:border-b-0">
                    <Link
                      to={section.path}
                      className={cn(
                        "flex h-11 items-center gap-2 bg-card px-3.5 text-body text-foreground hover:bg-app-hover",
                        FOCUS,
                        "focus-visible:-outline-offset-2",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{section.label}</span>
                      {section.id === "setup-check" && <ProblemBadge items={setup.items} />}
                      <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          <div className={cn("max-w-2xl min-w-0 flex-1", !current && "hidden")}>{content}</div>
        </div>
      </div>
    </SettingsOrgContext.Provider>
  )
}
