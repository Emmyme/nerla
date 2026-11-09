import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Toggle } from "@/components/calendar/EventFields"
import { organizationsAPI, type Organization } from "@/lib/api/organizations"
import { messageOf } from "@/lib/taskStore"
import { reloadTimeTracking } from "@/lib/timeStore"
import { SettingsSection } from "./SettingsSection"
import { useSettingsOrg } from "./useSettingsOrg"

const SAVE_FAILED = "Couldn't change time tracking. Try again."

/** The workspace switch, which saves on its own. Off hides time tracking everywhere and keeps the entries */
export function TimeTrackingSection({ org }: { org: Organization }) {
  const { refresh } = useSettingsOrg()
  const [on, setOn] = useState(!!org.timeTracking)
  const [saving, setSaving] = useState(false)

  useEffect(() => setOn(!!org.timeTracking), [org.timeTracking])

  const change = async (next: boolean) => {
    if (saving) return
    setOn(next)
    setSaving(true)
    try {
      await organizationsAPI.updateOrganization({ timeTracking: next })
      reloadTimeTracking()
      await refresh()
    } catch (err) {
      setOn(!next)
      toast.error(messageOf(err, SAVE_FAILED))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsSection
      title="Time tracking"
      description="Log hours on projects and tasks, with a timer, suggestions and reports. Turning it off stops running timers, hides it everywhere and keeps every entry."
      action={<Toggle checked={on} onChange={(next) => void change(next)} label="Time tracking" />}
    />
  )
}
