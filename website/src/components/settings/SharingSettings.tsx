import { useEffect, useId, useRef, useState } from "react"
import { toast } from "sonner"
import { X } from "@/components/icons"
import { PeopleSearch, personName, type PersonResult } from "@/components/projects/PeopleSearch"
import { RadioList } from "@/components/ui/radio-list"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { UserAvatar } from "@/components/ui/user-avatar"
import { calendarSharingAPI, type CalendarSharing, type GrantLevel, type ShareLevel } from "@/lib/api/calendar"
import { refreshCalendar } from "@/lib/calendarStore"
import { messageOf } from "@/lib/taskStore"
import { useBusyRetry } from "@/lib/useBusyRetry"
import { useAuth } from "@/providers/AuthProvider"
import { LoadError, LoadingRows } from "./LoadState"
import { SaveBar, SettingsSection } from "./SettingsSection"
import { useLeaveGuard } from "./useLeaveGuard"

type Grant = CalendarSharing["grants"][number]

const LEVELS: { value: ShareLevel; label: string; description: string }[] = [
  { value: "details", label: "Details", description: "Teammates see your events. Personal and focus time shows as busy." },
  { value: "busy", label: "Only busy", description: "Teammates see when you're busy, without titles or details." },
  { value: "private", label: "Private", description: "You don't show up in anyone's Team view, except the people you add below." },
]

const GRANTS: { value: GrantLevel; label: string }[] = [
  { value: "busy", label: "See busy" },
  { value: "everything", label: "See everything" },
]

const LOAD_FAILED = "Couldn't load your sharing settings. Check your connection and try again."
const SAVE_FAILED = "Couldn't save your sharing settings. Try again."

// "See busy" only matters for a private calendar, so under the other defaults only full grants count
const activeGrants = (sharing: CalendarSharing) =>
  sharing.default_level === "private" ? sharing.grants : sharing.grants.filter((grant) => grant.level === "everything")

const sameSharing = (a: CalendarSharing, b: CalendarSharing) => {
  const [x, y] = [activeGrants(a), activeGrants(b)]
  return (
    a.default_level === b.default_level &&
    x.length === y.length &&
    x.every((grant, i) => grant.grantee_id === y[i].grantee_id && grant.level === y[i].level)
  )
}

/** Who can see the user's calendar in Team view: the workspace default, and users who see more or less than it */
export default function SharingSettings() {
  const userId = useAuth().user?.id
  const [saved, setSaved] = useState<CalendarSharing | null>(null)
  const [form, setForm] = useState<CalendarSharing | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [saving, setSaving] = useState(false)
  const name = useId()
  const levels = useRef<HTMLFieldSetElement>(null)
  const { busy, waitIfBusy, done } = useBusyRetry()

  useEffect(() => {
    let live = true
    setLoadError(null)
    calendarSharingAPI
      .get()
      .then((sharing) => {
        if (!live) return
        done()
        setSaved(sharing)
        setForm(sharing)
      })
      .catch((err) => {
        if (!live || waitIfBusy(err, () => setAttempt((count) => count + 1))) return
        done()
        setLoadError(messageOf(err, LOAD_FAILED))
      })
    return () => {
      live = false
    }
  }, [attempt, waitIfBusy, done])

  // A user whose "See busy" is hidden under a shared default comes back as a full grant
  const addGrant = (person: PersonResult) =>
    setForm(
      (current) =>
        current && {
          ...current,
          grants: [
            ...current.grants.filter((grant) => grant.grantee_id !== person.id),
            {
              grantee_id: person.id,
              level: "everything",
              grantee: { id: person.id, first_name: person.first_name, last_name: person.last_name, avatar_url: person.avatar_url },
            },
          ],
        },
    )
  const setGrant = (id: string, level: GrantLevel) =>
    setForm(
      (current) =>
        current && { ...current, grants: current.grants.map((grant) => (grant.grantee_id === id ? { ...grant, level } : grant)) },
    )
  const removeGrant = (id: string) =>
    setForm((current) => current && { ...current, grants: current.grants.filter((grant) => grant.grantee_id !== id) })

  const changed = !!form && !!saved && !sameSharing(form, saved)
  const discardDialog = useLeaveGuard(changed)
  // The bar goes once the form is clean, so focus moves back to the choices
  const toChoices = () => requestAnimationFrame(() => levels.current?.querySelector<HTMLInputElement>("input[type=radio]")?.focus())

  const isPrivate = form?.default_level === "private"
  const grants = form ? activeGrants(form) : []

  const save = async () => {
    if (!form || !changed || saving) return
    setSaving(true)
    try {
      await calendarSharingAPI.save({
        default_level: form.default_level,
        grants: grants.map(({ grantee_id, level }) => ({ grantee_id, level })),
      })
      const next = { ...form, grants }
      setSaved(next)
      setForm(next)
      toast.success("Sharing settings saved")
      toChoices()
      void refreshCalendar()
    } catch (err) {
      toast.error(messageOf(err, SAVE_FAILED))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col">
      <SettingsSection title="Workspace default" description="This decides what teammates see of your calendar in their Team view.">
        {loadError ? (
          <LoadError message={loadError} onRetry={() => setAttempt((count) => count + 1)} />
        ) : !form ? (
          <LoadingRows label="Loading your sharing settings" busy={busy}>
            {LEVELS.map((level) => (
              <Skeleton key={level.value} className="h-[3.75rem] rounded-lg" />
            ))}
          </LoadingRows>
        ) : (
          <fieldset ref={levels} className="flex min-w-0 flex-col">
            <legend className="sr-only">Workspace default</legend>
            <RadioList
              name={name}
              value={form.default_level}
              options={LEVELS}
              onChange={(level) => setForm({ ...form, default_level: level })}
            />
          </fieldset>
        )}
      </SettingsSection>

      {form && !loadError && (
        <SettingsSection
          title="Specific people"
          description={
            isPrivate
              ? "Let some people see your calendar anyway."
              : "Let some people see all your events in full, personal and focus time included."
          }
        >
          <PeopleSearch
            label="Add a person"
            excludeIds={[...(userId ? [userId] : []), ...grants.map((grant) => grant.grantee_id)]}
            onPick={addGrant}
          />
          {grants.length > 0 && (
            <ul aria-label="People with access" className="flex flex-col">
              {grants.map((grant) => (
                <GrantRow
                  key={grant.grantee_id}
                  grant={grant}
                  choose={isPrivate}
                  onLevel={(level) => setGrant(grant.grantee_id, level)}
                  onRemove={() => removeGrant(grant.grantee_id)}
                />
              ))}
            </ul>
          )}
          <p className="rounded-lg bg-app-sunk px-3.5 py-2.5 text-ui text-muted-foreground">
            People you invite to an event always see it, and Everyone events show for the whole workspace, whatever you pick here.
          </p>
        </SettingsSection>
      )}
      {changed && (
        <SaveBar
          saving={saving}
          onSave={() => void save()}
          onCancel={() => {
            setForm(saved)
            toChoices()
          }}
        />
      )}
      {discardDialog}
    </div>
  )
}

/** `choose` offers "See busy" too, which only a private calendar can use */
function GrantRow({
  grant,
  choose,
  onLevel,
  onRemove,
}: {
  grant: Grant
  choose: boolean
  onLevel: (level: GrantLevel) => void
  onRemove: () => void
}) {
  const who = personName(grant.grantee)
  return (
    <li className="flex items-center gap-2.5 border-b-[0.0625rem] border-border py-2 last:border-b-0">
      <UserAvatar user={grant.grantee} size="sm" />
      <span className="min-w-0 flex-1 truncate text-body text-foreground">{who}</span>
      {choose ? (
        <Select value={grant.level} onValueChange={(level) => onLevel(level as GrantLevel)}>
          <SelectTrigger aria-label={`What ${who} can see`} className="w-[9.5rem] shrink-0 px-2.5 max-sm:w-[8rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GRANTS.map((option) => (
              <SelectItem key={option.value} value={option.value} className="text-ui">
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span className="shrink-0 text-ui text-muted-foreground">Sees everything</span>
      )}
      <button
        type="button"
        aria-label={`Remove ${who}`}
        onClick={onRemove}
        className="flex size-[2rem] shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:size-11"
      >
        <X aria-hidden="true" className="size-[1rem]" />
      </button>
    </li>
  )
}
