import { useRef } from "react"
import { toast } from "sonner"
import { Toggle } from "@/components/calendar/EventFields"
import { Skeleton } from "@/components/ui/skeleton"
import { notificationsAPI, type NotificationKind, type NotificationPref, type NotificationPrefs } from "@/lib/api/notifications"
import { setMentionPopups } from "@/lib/notificationStore"
import { ensureNotificationPermission } from "@/lib/notify"
import { useBusyLoad } from "@/lib/useBusyRetry"
import { LoadError, LoadingRows } from "./LoadState"
import { SettingsSection } from "./SettingsSection"

type KindRow = { kind: NotificationKind; label: string; description: string }

const GROUPS: { title: string; description: string; kinds: KindRow[] }[] = [
  {
    title: "Things that involve you",
    description: "On for the bell and desktop to start with.",
    kinds: [
      { kind: "project_added", label: "Added to a project", description: "Someone adds you to a project." },
      { kind: "task_assigned", label: "Assigned to you", description: "Someone assigns a task to you." },
      { kind: "mentioned", label: "Mentions", description: "Someone mentions you in a comment, a chat or a paper." },
      {
        kind: "comment_on_my_task",
        label: "Comments on your tasks",
        description: "Someone comments on a task assigned to you or created by you.",
      },
      {
        kind: "my_task_changed",
        label: "Changes to your tasks",
        description: "Someone changes the status or due date of a task assigned to you.",
      },
      { kind: "doc_shared", label: "Shared a paper or board with you", description: "Someone shares a paper or board with you." },
      {
        kind: "doc_comment",
        label: "Commented on your paper or board",
        description: "Someone comments on a paper or board you own, or replies in a thread you're in.",
      },
      {
        kind: "event_changed",
        label: "Invitations and changes to events",
        description:
          "Someone invites you to an event, or someone else moves, cancels or restores an event you organise or are invited to and haven't declined.",
      },
      {
        kind: "ai_pending",
        label: "Waiting for your Allow",
        description: "An agent you connected with an access token wants to make a change.",
      },
    ],
  },
  {
    title: "Everything in my projects",
    description: "Off to start with, for the projects you're a member of.",
    kinds: [
      { kind: "project_task_added", label: "New tasks", description: "Someone adds a task." },
      {
        kind: "project_task_changed",
        label: "Task changes",
        description: "Someone changes a task's status, assignee, due date, title or description.",
      },
      { kind: "project_task_completed", label: "Completed tasks", description: "Someone completes a task." },
      { kind: "project_comment", label: "All comments", description: "Someone comments on any task." },
    ],
  },
]

const LOAD_FAILED = "Couldn't load your notification settings. Check your connection and try again."
const SAVE_FAILED = "Couldn't save that change. Check your connection and try again."

const CHANNELS: { key: keyof NotificationPref; label: string }[] = [
  { key: "bell", label: "Bell" },
  { key: "desktop", label: "Desktop" },
]

/** Which kinds reach the bell and which pop up on the desktop, for every project at once. Each switch saves on its own */
export default function NotificationSettings() {
  const {
    data: prefs,
    setData: setPrefs,
    loadError,
    busy,
    retry,
  } = useBusyLoad(() => notificationsAPI.prefs().then((loaded) => loaded.prefs), LOAD_FAILED)
  const latest = useRef<NotificationPrefs | null>(null)
  latest.current = prefs

  const change = (kind: NotificationKind, key: keyof NotificationPref, value: boolean) => {
    const before = latest.current
    if (!before) return
    setPrefs({ ...before, [kind]: { ...before[kind], [key]: value } })
    if (kind === "mentioned" && key === "desktop") setMentionPopups(value)
    // Turning a pop-up on is the moment to ask the browser, never on load
    if (key === "desktop" && value) void ensureNotificationPermission().catch(() => false)
    notificationsAPI.savePrefs({ [kind]: { [key]: value } }).catch(() => {
      setPrefs((current) => current && { ...current, [kind]: { ...current[kind], [key]: before[kind][key] } })
      if (kind === "mentioned" && key === "desktop") setMentionPopups(before[kind][key])
      toast.error(SAVE_FAILED)
    })
  }

  if (loadError || !prefs) {
    return (
      <div className="flex flex-col">
        <SettingsSection title="Notifications" description="Choose what reaches your bell and what pops up on your desktop.">
          {loadError ? (
            <LoadError message={loadError} onRetry={retry} />
          ) : (
            <LoadingRows label="Loading your notification settings" busy={busy}>
              <Skeleton className="h-[1.25rem] w-[12rem] rounded-sm" />
              <Skeleton className="h-[2.75rem] rounded-lg" />
              <Skeleton className="h-[2.75rem] rounded-lg" />
              <Skeleton className="h-[2.75rem] rounded-lg" />
            </LoadingRows>
          )}
        </SettingsSection>
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {GROUPS.map((group) => (
        <SettingsSection key={group.title} title={group.title} description={group.description}>
          <div role="table" aria-label={group.title} className="flex flex-col">
            <div role="row" className="flex items-center gap-4 border-b-[0.0625rem] border-border pb-2">
              <span role="columnheader" className="min-w-0 flex-1">
                <span className="sr-only">Kind</span>
              </span>
              {CHANNELS.map((channel) => (
                <span
                  key={channel.key}
                  role="columnheader"
                  className="w-[3.5rem] shrink-0 text-center text-caption font-medium text-muted-foreground"
                >
                  {channel.label}
                </span>
              ))}
            </div>
            {group.kinds.map((row) => (
              <div key={row.kind} role="row" className="flex items-center gap-4 border-b-[0.0625rem] border-border py-3 last:border-b-0">
                <div role="rowheader" className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-ui font-medium text-foreground">{row.label}</span>
                  <span className="text-caption leading-[1.45] text-muted-foreground">{row.description}</span>
                </div>
                {CHANNELS.map((channel) => (
                  <div key={channel.key} role="cell" className="flex w-[3.5rem] shrink-0 justify-center">
                    <Toggle
                      checked={prefs[row.kind][channel.key]}
                      label={`${row.label}, ${channel.label.toLowerCase()}`}
                      onChange={(value) => change(row.kind, channel.key, value)}
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </SettingsSection>
      ))}
    </div>
  )
}
