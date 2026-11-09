import { useEffect, useId, useRef, useState, type FormEvent } from "react"
import { toast } from "sonner"
import { formatFileSize } from "@/components/files/fileKinds"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field-error"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { FIELD_LABEL } from "@/components/ui/field-label"
import { organizationsAPI, type Organization, type StorageCaps } from "@/lib/api/organizations"
import { messageOf } from "@/lib/taskStore"
import { SettingsSection } from "./SettingsSection"
import { bytesToCap, capToBytes, type CapUnit } from "./storageCaps"
import { StorageUsage } from "./StorageUsage"
import { TimeTrackingSection } from "./TimeTrackingSection"
import { useLeaveGuard } from "./useLeaveGuard"
import { useSettingsOrg } from "./useSettingsOrg"
import { WorkspaceProjects } from "./WorkspaceProjects"

const NAME_MAX = 255
const SAVE_FAILED = "Couldn't save the workspace name. Try again."

export default function WorkspaceSettings() {
  const { org, isAdmin } = useSettingsOrg()
  // One guard for the page, since a router allows one blocker at a time
  const [nameDirty, setNameDirty] = useState(false)
  const [capsDirty, setCapsDirty] = useState(false)
  const discardDialog = useLeaveGuard(nameDirty || capsDirty)
  if (!org) return null
  return (
    <div className="flex flex-col">
      <NameSection key={org.id} org={org} onDirty={setNameDirty} />
      {isAdmin && (
        <>
          <StorageSection
            key={`${org.id}:${org.storageCapPerPerson}:${org.storageCapTotal}:${org.maxFileSize}`}
            org={org}
            onDirty={setCapsDirty}
          />
          <StorageUsage perPersonCap={org.storageCapPerPerson ?? null} totalCap={org.storageCapTotal ?? null} />
          <TimeTrackingSection org={org} />
          <WorkspaceProjects />
        </>
      )}
      {discardDialog}
    </div>
  )
}

function NameSection({ org, onDirty }: { org: Organization; onDirty: (dirty: boolean) => void }) {
  const { refresh } = useSettingsOrg()
  const [name, setName] = useState(org.name)
  const [saving, setSaving] = useState(false)
  const ids = useId()
  const field = useRef<HTMLInputElement>(null)

  const error = name.trim() ? null : "Enter a workspace name."
  const dirty = name.trim() !== org.name
  const valid = !error && name.trim().length <= NAME_MAX
  useEffect(() => onDirty(dirty), [dirty, onDirty])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!dirty || !valid || saving) return
    setSaving(true)
    try {
      await organizationsAPI.updateOrganization({ name: name.trim() })
      await refresh()
      setName(name.trim())
      field.current?.focus()
      toast.success("Workspace name saved")
    } catch (err) {
      toast.error(messageOf(err, SAVE_FAILED))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsSection
      title="Workspace name"
      description="Invite emails show this name."
      footer={
        <Button
          type="submit"
          form={`${ids}-form`}
          variant={dirty || saving ? "default" : "secondary"}
          disabled={!dirty || !valid || saving}
        >
          {saving ? "Saving" : "Save"}
        </Button>
      }
    >
      <form id={`${ids}-form`} onSubmit={save} noValidate className="flex flex-col gap-1.5 sm:max-w-88">
        <Input
          ref={field}
          aria-label="Workspace name"
          value={name}
          maxLength={NAME_MAX}
          autoComplete="organization"
          onChange={(event) => setName(event.target.value)}
          aria-invalid={dirty && error ? true : undefined}
          aria-describedby={dirty && error ? `${ids}-error` : undefined}
        />
        {dirty && error && (
          <FieldError role="status" id={`${ids}-error`} className="mt-0">
            {error}
          </FieldError>
        )}
      </form>
    </SettingsSection>
  )
}

type CapKey = keyof StorageCaps
type CapField = { value: string; unit: CapUnit }

const CAP_FIELDS: { key: CapKey; label: string }[] = [
  { key: "storageCapPerPerson", label: "Storage per person" },
  { key: "storageCapTotal", label: "Total workspace storage" },
  { key: "maxFileSize", label: "Largest file" },
]
const UNITS: CapUnit[] = ["MB", "GB"]
const CAPS_FAILED = "Couldn't save the storage limits. Try again."
const NOT_A_NUMBER = "Enter a number above zero, or leave it empty for no limit."

const capsOf = (org: Organization) =>
  Object.fromEntries(CAP_FIELDS.map(({ key }) => [key, bytesToCap(org[key])])) as Record<CapKey, CapField>
const bytesOf = (field: CapField) => (field.value.trim() ? capToBytes(field.value, field.unit) : null)
const isEmpty = (field: CapField) => !field.value.trim()
// Two fields match when they hold the same limit, so "1.50 GB" and "1536 MB" are no change
const sameField = (a: CapField, b: CapField) => (isEmpty(a) && isEmpty(b)) || (bytesOf(a) !== null && bytesOf(a) === bytesOf(b))

function StorageSection({ org, onDirty }: { org: Organization; onDirty: (dirty: boolean) => void }) {
  const { refresh } = useSettingsOrg()
  const [initial, setInitial] = useState(() => capsOf(org))
  const [fields, setFields] = useState(initial)
  const [saving, setSaving] = useState(false)
  // A field says it is wrong once the user leaves it, so typing "0.5" never flashes an error at "0"
  const [touched, setTouched] = useState<Partial<Record<CapKey, boolean>>>({})
  const ids = useId()

  const changed = CAP_FIELDS.filter(({ key }) => !sameField(fields[key], initial[key]))
  const invalid = (key: CapKey) => !isEmpty(fields[key]) && bytesOf(fields[key]) === null
  const dirty = changed.length > 0
  const valid = CAP_FIELDS.every(({ key }) => !invalid(key))
  useEffect(() => onDirty(dirty), [dirty, onDirty])

  const set = (key: CapKey, change: Partial<CapField>) => setFields((all) => ({ ...all, [key]: { ...all[key], ...change } }))

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setTouched({ storageCapPerPerson: true, storageCapTotal: true, maxFileSize: true })
    if (!dirty || !valid || saving) return
    setSaving(true)
    try {
      const updates: StorageCaps = {}
      for (const { key } of changed) updates[key] = bytesOf(fields[key])
      await organizationsAPI.updateOrganization(updates)
      setInitial(fields)
      await refresh()
      toast.success("Storage limits saved")
    } catch (err) {
      toast.error(messageOf(err, CAPS_FAILED))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsSection
      title="Storage"
      description="Leave a field empty for no limit. Project files count toward the workspace total only."
      footer={
        <Button type="submit" form={`${ids}-caps`} variant={dirty || saving ? "default" : "secondary"} disabled={!dirty || saving}>
          {saving ? "Saving" : "Save"}
        </Button>
      }
    >
      <form id={`${ids}-caps`} onSubmit={save} noValidate className="grid gap-4 sm:max-w-[40rem] sm:grid-cols-3">
        {CAP_FIELDS.map(({ key, label }) => {
          const field = fields[key]
          const error = !!touched[key] && invalid(key)
          const ceiling = key === "maxFileSize" ? org.uploadCeiling : undefined
          const above = !!ceiling && (bytesOf(field) ?? 0) > ceiling
          const hint = ceiling
            ? above
              ? `Files over ${formatFileSize(ceiling)} are still refused by the server.`
              : `The server takes files up to ${formatFileSize(ceiling)}.`
            : null
          const described =
            [error ? `${ids}-${key}-error` : null, hint ? `${ids}-${key}-hint` : null].filter(Boolean).join(" ") || undefined
          return (
            <div key={key} className="flex flex-col gap-1.5">
              <label htmlFor={`${ids}-${key}`} className={FIELD_LABEL}>
                {label}
              </label>
              <div className="flex gap-2">
                <Input
                  id={`${ids}-${key}`}
                  value={field.value}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="No limit"
                  onChange={(event) => set(key, { value: event.target.value })}
                  onBlur={() => setTouched((all) => ({ ...all, [key]: true }))}
                  aria-invalid={error || undefined}
                  aria-describedby={described}
                  className="min-w-0 flex-1 tabular-nums"
                />
                <Select value={field.unit} onValueChange={(unit) => set(key, { unit: unit as CapUnit })}>
                  <SelectTrigger aria-label={`${label} unit`} className="w-[4.75rem] shrink-0 border-transparent bg-app-sunk font-medium">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {UNITS.map((unit) => (
                      <SelectItem key={unit} value={unit}>
                        {unit}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {error && (
                <FieldError id={`${ids}-${key}-error`} className="mt-0">
                  {NOT_A_NUMBER}
                </FieldError>
              )}
              {hint && (
                <p id={`${ids}-${key}-hint`} className="text-caption text-muted-foreground">
                  {hint}
                </p>
              )}
            </div>
          )
        })}
      </form>
    </SettingsSection>
  )
}
