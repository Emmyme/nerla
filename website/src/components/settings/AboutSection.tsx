import { useEffect, useId, useRef, useState, type FormEvent } from "react"
import { toast } from "sonner"
import { TIME_FIELD, Toggle } from "@/components/calendar/EventFields"
import BaseModal from "@/components/ui/BaseModal"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field-error"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { TimeField } from "@/components/ui/time-field"
import { Plus, X } from "@/components/icons"
import { FIELD_LABEL } from "@/components/ui/field-label"
import { timeAPI } from "@/lib/api/time"
import { usersAPI, type ProfileFieldKey } from "@/lib/api/users"
import { WEEKDAYS, type DayHours, type Weekday, type WorkingHours } from "@/lib/availability"
import { setAutofillProject, useTimeTracking } from "@/lib/timeStore"
import { useProjects } from "@/lib/useProjects"
import { deviceTimeZone, formatWeekdayLong } from "@/lib/dates"
import { forgetProfile } from "@/lib/profiles"
import { messageOf } from "@/lib/taskStore"
import { cn } from "@/lib/utils"
import { useAuth } from "@/providers/AuthProvider"
import { SettingsSection } from "./SettingsSection"
import { TimeZonePicker, zoneLabel } from "./TimeZonePicker"
import { useSettingsOrg } from "./useSettingsOrg"

const SAVE_FAILED = "Couldn't save your details. Try again."
const DEFAULT_DAY = { start: "09:00", end: "17:00" }
// Lunch first, then a short afternoon break
const DEFAULT_BREAKS = [
  { start: "12:00", end: "13:00" },
  { start: "15:00", end: "15:15" },
]
const MAX_BREAKS = 4

type TextKey = Exclude<ProfileFieldKey, "timeZone">
const FIELDS: { key: TextKey; label: string; max: number; autoComplete?: string; type?: string }[] = [
  { key: "jobTitle", label: "Job title", max: 100, autoComplete: "organization-title" },
  { key: "team", label: "Team or department", max: 100 },
  { key: "pronouns", label: "Pronouns", max: 40 },
  { key: "location", label: "Location", max: 100 },
  { key: "phone", label: "Phone", max: 40, autoComplete: "tel", type: "tel" },
]

// 5 January 2026 is a Monday
const DAY_NAMES = WEEKDAYS.map((_, index) => formatWeekdayLong(new Date(2026, 0, 5 + index)))

const confirmKey = (userId: string) => `nerla:profile-public-ok:${userId}`

function confirmedBefore(userId: string): boolean {
  try {
    return localStorage.getItem(confirmKey(userId)) === "1"
  } catch {
    return false
  }
}

function rememberConfirm(userId: string) {
  try {
    localStorage.setItem(confirmKey(userId), "1")
  } catch {
    // Without storage the confirm asks again next time
  }
}

const hoursKey = (hours: WorkingHours | null | undefined) =>
  WEEKDAYS.map((day) => {
    const range = hours?.[day]
    return range ? `${range.start}-${range.end}` : ""
  }).join(",")
const breaksKey = (breaks: DayHours[] | null | undefined) => (breaks ?? []).map((range) => `${range.start}-${range.end}`).join(",")

/** Job title, team, pronouns, location, phone, time zone and working hours, which everyone in the workspace can see */
export function AboutSection({ onDirty }: { onDirty: (dirty: boolean) => void }) {
  const { user, refreshUser } = useAuth()
  const { org } = useSettingsOrg()
  const ids = useId()
  const saveButton = useRef<HTMLButtonElement>(null)
  const saved = (key: TextKey) => user?.[key] ?? ""
  const offeredZone = user?.timeZone || deviceTimeZone()
  const [text, setText] = useState<Record<TextKey, string>>(
    () => Object.fromEntries(FIELDS.map(({ key }) => [key, saved(key)])) as Record<TextKey, string>,
  )
  const [zone, setZone] = useState(offeredZone)
  const [hours, setHours] = useState<WorkingHours>(() => user?.workingHours ?? {})
  const [breaks, setBreaks] = useState<DayHours[]>(() => user?.workBreaks ?? [])
  const time = useTimeTracking()
  const { projects } = useProjects()
  // Untouched follows the saved setting, which arrives with the time tracking state
  const [autofill, setAutofill] = useState<string | null | undefined>(undefined)
  const autofillShown = autofill === undefined ? time.autofillProjectId : autofill
  const memberProjects = projects.filter(
    (project) => project.member !== false && (project.status !== "archived" || project.id === autofillShown),
  )
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const workspace = org?.name ?? "your workspace"
  const badDays = WEEKDAYS.filter((day) => {
    const range = hours[day]
    return !!range && range.end <= range.start
  })
  const badBreaks = breaks.flatMap((range, index) => (range.end <= range.start ? [index] : []))
  const breaksDirty = time.enabled && breaksKey(breaks) !== breaksKey(user?.workBreaks)
  const autofillDirty = time.enabled && autofill !== undefined && autofill !== time.autofillProjectId
  const dirty =
    FIELDS.some(({ key }) => text[key].trim() !== saved(key)) ||
    zone !== offeredZone ||
    hoursKey(hours) !== hoursKey(user?.workingHours) ||
    breaksDirty ||
    autofillDirty
  const valid = badDays.length === 0 && badBreaks.length === 0 && FIELDS.every(({ key, max }) => text[key].trim().length <= max)
  useEffect(() => onDirty(dirty), [dirty, onDirty])

  if (!user) return null

  const setDay = (day: Weekday, range: WorkingHours[Weekday] | null) =>
    setHours((current) => {
      const next = { ...current }
      if (range) next[day] = range
      else delete next[day]
      return next
    })

  const turnOn = (day: Weekday) => {
    // A new day copies the nearest earlier day that is set, so a work week takes one setting
    const index = WEEKDAYS.indexOf(day)
    const before = [...WEEKDAYS.slice(0, index)].reverse().find((other) => hours[other])
    setDay(day, before ? { ...hours[before]! } : DEFAULT_DAY)
  }

  const submit = async () => {
    setSaving(true)
    try {
      const trimmed = Object.fromEntries(FIELDS.map(({ key }) => [key, text[key].trim()])) as Record<TextKey, string>
      await usersAPI.updateProfile({
        ...Object.fromEntries(FIELDS.map(({ key }) => [key, trimmed[key] || null])),
        timeZone: zone || null,
        workingHours: Object.keys(hours).length ? hours : null,
        ...(breaksDirty ? { workBreaks: breaks.length ? breaks : null } : {}),
      })
      if (autofillDirty) {
        const { autofillProjectId } = await timeAPI.saveSettings(autofill ?? null)
        setAutofillProject(autofillProjectId)
        setAutofill(undefined)
      }
      await refreshUser()
      forgetProfile(user.id)
      setText(trimmed)
      toast.success("Details saved")
    } catch (err) {
      toast.error(messageOf(err, SAVE_FAILED))
    } finally {
      setSaving(false)
    }
  }

  const save = (event?: FormEvent) => {
    event?.preventDefault()
    if (!dirty || !valid || saving) return
    if (!confirmedBefore(user.id)) return setConfirming(true)
    void submit()
  }

  return (
    <SettingsSection
      title="About you"
      description={`Everyone in ${workspace} can see these details.`}
      footer={
        <Button
          ref={saveButton}
          type="submit"
          form={`${ids}-form`}
          variant={dirty || saving ? "default" : "secondary"}
          disabled={!dirty || !valid || saving}
        >
          {saving ? "Saving" : "Save"}
        </Button>
      }
    >
      <form id={`${ids}-form`} onSubmit={save} noValidate className="flex flex-col gap-6">
        <div className="grid gap-4 sm:grid-cols-2">
          {FIELDS.map(({ key, label, max, autoComplete, type }) => (
            <div key={key} className="flex flex-col gap-1.5">
              <label htmlFor={`${ids}-${key}`} className={FIELD_LABEL}>
                {label}
              </label>
              <Input
                id={`${ids}-${key}`}
                type={type ?? "text"}
                value={text[key]}
                maxLength={max}
                autoComplete={autoComplete ?? "off"}
                onChange={(event) => setText((current) => ({ ...current, [key]: event.target.value }))}
              />
            </div>
          ))}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${ids}-zone`} className={FIELD_LABEL}>
              Time zone
            </label>
            <TimeZonePicker id={`${ids}-zone`} value={zone} onChange={setZone} />
          </div>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-body font-semibold text-foreground">Working hours</legend>
          <p className="text-ui text-muted-foreground">Times are in {zoneLabel(zone)}.</p>
          <ul className="mt-1 flex flex-col gap-1">
            {WEEKDAYS.map((day, index) => {
              const range = hours[day]
              const name = DAY_NAMES[index]
              const bad = badDays.includes(day)
              return (
                <li key={day} className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1.5 max-lg:min-h-11">
                  <span className="flex w-[8.5rem] items-center gap-2.5">
                    <Toggle
                      id={`${ids}-${day}`}
                      checked={!!range}
                      onChange={(on) => (on ? turnOn(day) : setDay(day, null))}
                      label={`Work on ${name}`}
                    />
                    <label
                      htmlFor={`${ids}-${day}`}
                      className={cn("text-ui", range ? "font-medium text-foreground" : "text-muted-foreground")}
                    >
                      {name}
                    </label>
                  </span>
                  {range && (
                    <span className="flex items-center gap-2">
                      <TimeField
                        aria-label={`${name} start`}
                        value={range.start}
                        onChange={(start) => setDay(day, { ...range, start })}
                        className={TIME_FIELD}
                      />
                      <span className="text-ui text-muted-foreground">to</span>
                      <TimeField
                        aria-label={`${name} end`}
                        value={range.end}
                        durationFrom={range.start}
                        aria-invalid={bad}
                        aria-describedby={bad ? `${ids}-${day}-error` : undefined}
                        onChange={(end) => setDay(day, { ...range, end })}
                        className={TIME_FIELD}
                      />
                    </span>
                  )}
                  {bad && (
                    <FieldError id={`${ids}-${day}-error`} className="mt-0 basis-full">
                      End after the start.
                    </FieldError>
                  )}
                </li>
              )
            })}
          </ul>
        </fieldset>

        {time.enabled && (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-body font-semibold text-foreground">Breaks</legend>
            <p className="text-ui text-muted-foreground">The same on every working day. Filling your hours leaves them out.</p>
            {breaks.length > 0 && (
              <ul className="mt-1 flex flex-col gap-1">
                {breaks.map((range, index) => {
                  const bad = badBreaks.includes(index)
                  const name = `Break ${index + 1}`
                  const setBreak = (next: DayHours) => setBreaks((current) => current.map((other, at) => (at === index ? next : other)))
                  return (
                    <li key={index} className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1.5 max-lg:min-h-11">
                      <TimeField
                        aria-label={`${name} start`}
                        value={range.start}
                        onChange={(start) => setBreak({ ...range, start })}
                        className={TIME_FIELD}
                      />
                      <span className="text-ui text-muted-foreground">to</span>
                      <TimeField
                        aria-label={`${name} end`}
                        value={range.end}
                        durationFrom={range.start}
                        aria-invalid={bad}
                        aria-describedby={bad ? `${ids}-break-${index}-error` : undefined}
                        onChange={(end) => setBreak({ ...range, end })}
                        className={TIME_FIELD}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${name.toLowerCase()}`}
                        title="Remove"
                        onClick={() => setBreaks((current) => current.filter((_, at) => at !== index))}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X aria-hidden="true" className="size-[0.9rem]" />
                      </Button>
                      {bad && (
                        <FieldError id={`${ids}-break-${index}-error`} className="mt-0 basis-full">
                          End after the start.
                        </FieldError>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
            <div>
              <Button
                type="button"
                variant="ghost"
                disabled={breaks.length >= MAX_BREAKS}
                onClick={() => setBreaks((current) => [...current, { ...DEFAULT_BREAKS[Math.min(current.length, 1)] }])}
                className="-ml-2 px-2"
              >
                <Plus aria-hidden="true" className="size-[0.9rem]" />
                Add break
              </Button>
            </div>
          </fieldset>
        )}

        {time.enabled && (
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">Fill my working hours</legend>
            <div className="flex items-start gap-2.5">
              <span className="pt-0.5">
                <Toggle
                  id={`${ids}-autofill`}
                  checked={!!autofillShown}
                  onChange={(on) => setAutofill(on ? (memberProjects[0]?.id ?? null) : null)}
                  label="Fill my working hours"
                />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <label htmlFor={`${ids}-autofill`} className="text-body font-semibold text-foreground">
                  Fill my working hours
                </label>
                <span className="text-ui text-muted-foreground">
                  {memberProjects.length
                    ? "When a working day ends, the time you have not logged goes to one project."
                    : "Join a project to fill your working hours."}
                </span>
              </span>
            </div>
            {autofillShown && (
              <Select value={autofillShown} onValueChange={setAutofill}>
                <SelectTrigger aria-label="Project to fill" className="sm:max-w-88">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {memberProjects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </fieldset>
        )}
      </form>

      <BaseModal
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        title="Share these details?"
        maxWidth="sm"
        fallbackFocus={() => saveButton.current}
      >
        <div className="flex flex-col gap-4 p-6">
          <p className="text-body leading-[1.5] text-muted-foreground">These details will be visible to everyone in {workspace}.</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" autoFocus onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                rememberConfirm(user.id)
                setConfirming(false)
                void submit()
              }}
            >
              Save
            </Button>
          </div>
        </div>
      </BaseModal>
    </SettingsSection>
  )
}
