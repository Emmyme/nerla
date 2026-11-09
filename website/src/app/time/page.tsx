import { FirstTip } from "@/components/onboarding/FirstTip"
import { useLocation, useNavigate, useSearchParams } from "react-router"
import NotFound from "@/app/not-found"
import { PageHeader } from "@/components/shell/PageHeader"
import { TimeReports } from "@/components/time/TimeReports"
import { calendarDay } from "@/components/time/timeView"
import { WeekReview } from "@/components/time/WeekReview"
import { CatSearching } from "@/components/ui/cat-scenes"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { mondayOf, todayIn } from "@/lib/timeFormat"
import { useTimeTracking, useTimeTrackingReady, useTimeTrackingRetrying } from "@/lib/timeStore"
import { useDocumentTitle } from "@/lib/useDocumentTitle"
import { useAuth } from "@/providers/AuthProvider"

type Tab = "mine" | "reports"

const TABS: { value: Tab; label: string }[] = [
  { value: "mine", label: "My time" },
  { value: "reports", label: "Reports" },
]

function TimeView({ tab, canReport }: { tab: Tab; canReport: boolean }) {
  useDocumentTitle(tab === "reports" ? "Reports" : null, "Time")
  const navigate = useNavigate()
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const today = todayIn(user?.timeZone)
  const asked = calendarDay(params.get("week"))
  const start = asked ? mondayOf(asked) : mondayOf(today)

  const goToWeek = (week: string | null) =>
    setParams((current) => {
      if (week && week !== mondayOf(today)) current.set("week", week)
      else current.delete("week")
      return current
    })

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader title="Time" />
      <FirstTip id="time" />
      {canReport && (
        <SegmentedControl
          label="Time view"
          value={tab}
          onChange={(next) => navigate(next === "reports" ? "/time/reports" : "/time")}
          options={TABS}
          className="self-start"
        />
      )}
      {tab === "reports" ? (
        <TimeReports today={today} workspaceAdmin={user?.role === "admin"} />
      ) : (
        <WeekReview start={start} today={today} onWeek={goToWeek} />
      )}
    </div>
  )
}

/** The user's week and, for a user who reports on a project, the reports. Gone while the workspace has time tracking off */
export default function TimePage() {
  const { enabled, canReport } = useTimeTracking()
  const ready = useTimeTrackingReady()
  const retrying = useTimeTrackingRetrying()
  const tab: Tab = useLocation().pathname.replace(/\/+$/, "").endsWith("/reports") ? "reports" : "mine"
  if (!ready && !enabled)
    return (
      <div className="flex min-w-0 flex-col gap-5">
        <PageHeader title="Time" />
        <div className="flex flex-col items-center gap-3 rounded-xl px-4 py-12 text-center ring-[0.0625rem] ring-border">
          <CatSearching />
          <p role="status" className="text-body font-semibold text-foreground">
            {retrying ? "Couldn't reach the server. Trying again..." : "Loading time tracking..."}
          </p>
        </div>
      </div>
    )
  if (!enabled || (tab === "reports" && !canReport)) return <NotFound />
  return <TimeView tab={tab} canReport={canReport} />
}
