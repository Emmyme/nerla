import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react"
import { toast } from "sonner"
import { Toggle } from "@/components/calendar/EventFields"
import { uploadFailure } from "@/components/files/uploadErrors"
import { AiAvatar } from "@/components/ai/AiAvatar"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field-error"
import { Input } from "@/components/ui/input"
import { RadioList } from "@/components/ui/radio-list"
import { Skeleton } from "@/components/ui/skeleton"
import { FIELD_LABEL } from "@/components/ui/field-label"
import { aiAPI, type AiStrictness, type AiUsage, type WorkspaceAi, type WorkspaceAiPatch } from "@/lib/api/ai"
import { filesAPI } from "@/lib/api/files"
import { reloadAiAccess } from "@/lib/aiAccess"
import { messageOf } from "@/lib/taskStore"
import { useAvatarSrc } from "@/lib/useAvatarSrc"
import { useBusyLoad } from "@/lib/useBusyRetry"
import { AiActivity } from "./AiActivity"
import { ConnectionForm, ToggleRow } from "./AiConnectionFields"
import { AllTokens } from "./AiTokens"
import { LoadError, LoadingRows } from "./LoadState"
import { SettingsSection } from "./SettingsSection"
import { useLeaveGuard } from "./useLeaveGuard"

const LOAD_FAILED = "Couldn't load the AI settings. Check your connection and try again."
const SAVE_FAILED = "Couldn't save that change. Try again."
const AVATAR_FAILED = "Couldn't update the avatar. Try again."
const MAX_AVATAR = 5 * 1024 * 1024
const NAME_MAX = 60

export const STRICTNESS: { value: AiStrictness; label: string; description: string }[] = [
  { value: "every", label: "Before every change", description: "Every change waits for Allow, even to the asker's own things." },
  {
    value: "tainted",
    label: "After it reads something written by someone else",
    description: "Once it has read someone else's words, any change other people can see waits for Allow.",
  },
  {
    value: "sensitive",
    label: "Only before sensitive actions",
    description: "Changes run freely. Posting a message and inviting people still wait for Allow.",
  },
]

export const tokens = (n: number) => `${n.toLocaleString("en-GB")} ${n === 1 ? "token" : "tokens"}`

/** The workspace's model, the AI's name and look, its limits and who used it. Admins only */
export default function WorkspaceAiSettings() {
  const { data: settings, setData: setSettings, loadError, busy, retry } = useBusyLoad(aiAPI.settings, LOAD_FAILED)
  const [connectionDirty, setConnectionDirty] = useState(false)
  const [nameDirty, setNameDirty] = useState(false)
  const [budgetDirty, setBudgetDirty] = useState(false)
  // One guard for the page, as the router keeps only one blocker
  const discardDialog = useLeaveGuard(connectionDirty || nameDirty || budgetDirty)
  const latest = useRef<WorkspaceAi | null>(null)
  latest.current = settings

  const save = async (patch: WorkspaceAiPatch) => {
    const next = await aiAPI.saveSettings(patch)
    setSettings(next)
    // What users see of the AI follows these settings, the admin's own view included
    void reloadAiAccess()
  }

  /** A switch or choice that saves on its own, showing the change at once and undoing it if the save fails */
  const saveNow = (patch: WorkspaceAiPatch) => {
    const before = latest.current
    if (!before) return
    setSettings((current) => current && ({ ...current, ...patch } as WorkspaceAi))
    save(patch).catch((err) => {
      setSettings(
        (current) =>
          current && { ...current, ...Object.fromEntries(Object.keys(patch).map((key) => [key, before[key as keyof WorkspaceAi]])) },
      )
      toast.error(messageOf(err, SAVE_FAILED))
    })
  }

  if (loadError || !settings) {
    return (
      <div className="flex flex-col">
        <SettingsSection title="Workspace AI" description="Connect a model for the whole workspace and choose how careful the AI is.">
          {loadError ? (
            <LoadError message={loadError} onRetry={retry} />
          ) : (
            <LoadingRows label="Loading the AI settings" busy={busy}>
              <Skeleton className="h-[1.25rem] w-[12rem] rounded-sm" />
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
      <SettingsSection
        title="AI teammate"
        description="It answers in its own chat and wherever someone mentions it, using the model below. Turning it off stops it at once."
        action={<Toggle checked={settings.enabled} onChange={(enabled) => saveNow({ enabled })} label="AI teammate" />}
      />
      <SettingsSection
        title="MCP access"
        description="Outside agents connect with someone's access token and act as that person. Turning it off refuses every token at once."
        action={<Toggle checked={settings.mcpEnabled} onChange={(mcpEnabled) => saveNow({ mcpEnabled })} label="MCP access" />}
      />
      <SettingsSection
        title="Model"
        description="Any server with the OpenAI chat completions API and tool calling, such as Ollama, LM Studio or OpenRouter. The key is stored encrypted and never shown again."
      >
        <ConnectionForm saved={settings} address onSave={save} test={aiAPI.testSettings} onDirty={setConnectionDirty} />
      </SettingsSection>
      <NameSection key={settings.name} name={settings.name} onSave={(name) => save({ name })} onDirty={setNameDirty} />
      <AvatarSection settings={settings} onSave={(avatarFileId) => save({ avatarFileId })} />
      <BudgetSection
        key={`${settings.monthlyBudget}:${settings.personBudget}`}
        settings={settings}
        onSave={save}
        onDirty={setBudgetDirty}
      />
      <SettingsSection
        title="Personal models"
        description="What people may set for their own chat with the AI. Mentions in shared places and agents always use the workspace's model."
      >
        <div className="flex flex-col gap-4">
          <ToggleRow
            label="Let people use their own key"
            description="A person's own key for the workspace's model. It doesn't count toward the budgets, unless the workspace has no key of its own or uses its local network."
            checked={settings.allowPersonalKey}
            onChange={(allowPersonalKey) => saveNow({ allowPersonalKey })}
          />
          <ToggleRow
            label="Let people add their own model address"
            description="A model of their own, with its own key. It always needs https."
            checked={settings.allowPersonalUrl}
            onChange={(allowPersonalUrl) => saveNow({ allowPersonalUrl })}
          />
        </div>
      </SettingsSection>
      <SettingsSection
        title="When the AI asks first"
        description="For the AI teammate and outside agents alike. People can choose a stricter level for themselves."
      >
        <RadioList
          name="workspace-strictness"
          value={settings.strictness}
          options={STRICTNESS}
          onChange={(strictness) => saveNow({ strictness })}
        />
      </SettingsSection>
      <AllTokens />
      <SettingsSection
        title="Activity"
        description="Every AI and agent action in the workspace, with who asked and the result. Never what was written."
      >
        <AiActivity scope="workspace" aiName={settings.name} />
      </SettingsSection>
      {discardDialog}
    </div>
  )
}

function NameSection({
  name,
  onSave,
  onDirty,
}: {
  name: string
  onSave: (name: string) => Promise<void>
  onDirty: (dirty: boolean) => void
}) {
  const [value, setValue] = useState(name)
  const [saving, setSaving] = useState(false)
  const ids = useId()

  const error = value.trim() ? null : "Enter a name."
  const dirty = value.trim() !== name
  useEffect(() => onDirty(dirty), [dirty, onDirty])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!dirty || error || saving) return
    setSaving(true)
    try {
      await onSave(value.trim())
      toast.success("Name saved")
    } catch (err) {
      toast.error(messageOf(err, SAVE_FAILED))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsSection
      title="Name"
      description="How the AI shows in chats and mentions."
      footer={
        <Button
          type="submit"
          form={`${ids}-form`}
          variant={dirty || saving ? "default" : "secondary"}
          disabled={!dirty || !!error || saving}
        >
          {saving ? "Saving" : "Save"}
        </Button>
      }
    >
      <form id={`${ids}-form`} onSubmit={save} noValidate className="flex flex-col gap-1.5 sm:max-w-88">
        <Input
          aria-label="Name"
          value={value}
          maxLength={NAME_MAX}
          autoComplete="off"
          onChange={(event) => setValue(event.target.value)}
          aria-invalid={dirty && error ? true : undefined}
          aria-describedby={dirty && error ? `${ids}-error` : undefined}
        />
        {dirty && error && (
          <FieldError id={`${ids}-error`} className="mt-0">
            {error}
          </FieldError>
        )}
      </form>
    </SettingsSection>
  )
}

function AvatarSection({ settings, onSave }: { settings: WorkspaceAi; onSave: (avatarFileId: string | null) => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null)
  const upload = useRef<HTMLButtonElement>(null)
  const src = useAvatarSrc(settings.avatarUrl)
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const errorId = useId()

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return
    if (!file.type.startsWith("image/")) return setError("Choose an image file.")
    if (file.size > MAX_AVATAR) return setError("Choose an image of 5 MB or less.")
    setError(null)
    setBusy("upload")
    let uploaded: { id: string }
    try {
      uploaded = await filesAPI.uploadFile(file, { purpose: "avatar" })
    } catch (err) {
      toast.error(await uploadFailure(err, file, undefined, AVATAR_FAILED))
      setBusy(null)
      return
    }
    try {
      await onSave(uploaded.id)
      toast.success("Avatar updated")
    } catch (err) {
      toast.error(messageOf(err, AVATAR_FAILED))
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    setError(null)
    setBusy("remove")
    try {
      await onSave(null)
      upload.current?.focus()
      toast.success("Avatar set back to the cat")
    } catch (err) {
      toast.error(messageOf(err, AVATAR_FAILED))
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingsSection title="Avatar" description="The Nerla cat, or an image of your own.">
      <div className="flex flex-wrap items-center gap-4">
        <AiAvatar size={4} src={settings.avatarUrl ? src : null} />
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={input}
            type="file"
            accept="image/*"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => void pick(event)}
          />
          <Button
            ref={upload}
            type="button"
            variant="outline"
            aria-disabled={!!busy || undefined}
            aria-busy={busy === "upload" || undefined}
            aria-describedby={error ? errorId : undefined}
            onClick={() => !busy && input.current?.click()}
          >
            {busy === "upload" ? "Uploading" : "Upload image"}
          </Button>
          {settings.avatarUrl && (
            <Button
              type="button"
              variant="ghost"
              aria-disabled={!!busy || undefined}
              aria-busy={busy === "remove" || undefined}
              onClick={() => !busy && void remove()}
            >
              {busy === "remove" ? "Removing" : "Use the cat"}
            </Button>
          )}
        </div>
      </div>
      {error && (
        <FieldError id={errorId} className="mt-0">
          {error}
        </FieldError>
      )}
    </SettingsSection>
  )
}

type BudgetKey = "monthlyBudget" | "personBudget"

const BUDGETS: { key: BudgetKey; label: string }[] = [
  { key: "monthlyBudget", label: "Monthly token budget" },
  { key: "personBudget", label: "Per-person token budget" },
]
const NOT_A_BUDGET = "Enter a whole number of tokens, or leave it empty for no limit."

const budgetText = (value: number | null) => (value === null ? "" : String(value))
const budgetOf = (text: string): number | null | undefined => {
  const cleaned = text.replace(/[\s,_]/g, "")
  if (!cleaned) return null
  return /^\d+$/.test(cleaned) && Number.isSafeInteger(Number(cleaned)) ? Number(cleaned) : undefined
}

function BudgetSection({
  settings,
  onSave,
  onDirty,
}: {
  settings: WorkspaceAi
  onSave: (patch: WorkspaceAiPatch) => Promise<void>
  onDirty: (dirty: boolean) => void
}) {
  const [fields, setFields] = useState<Record<BudgetKey, string>>({
    monthlyBudget: budgetText(settings.monthlyBudget),
    personBudget: budgetText(settings.personBudget),
  })
  const [usage, setUsage] = useState<AiUsage | null>(null)
  const [saving, setSaving] = useState(false)
  const [touched, setTouched] = useState<Partial<Record<BudgetKey, boolean>>>({})
  const ids = useId()

  useEffect(() => {
    let live = true
    aiAPI.usage().then(
      (next) => live && setUsage(next),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [])

  const changed = BUDGETS.filter(({ key }) => budgetOf(fields[key]) !== settings[key])
  const invalid = (key: BudgetKey) => budgetOf(fields[key]) === undefined
  const dirty = changed.length > 0
  const valid = BUDGETS.every(({ key }) => !invalid(key))
  useEffect(() => onDirty(dirty), [dirty, onDirty])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setTouched({ monthlyBudget: true, personBudget: true })
    if (!dirty || !valid || saving) return
    setSaving(true)
    try {
      await onSave(Object.fromEntries(changed.map(({ key }) => [key, budgetOf(fields[key]) ?? null])))
      toast.success("Budget saved")
    } catch (err) {
      toast.error(messageOf(err, SAVE_FAILED))
    } finally {
      setSaving(false)
    }
  }

  const used = usage?.workspace
  return (
    <SettingsSection
      title="Budget"
      meta={used ? `${tokens(used.used)} this month` : undefined}
      description="Counted in tokens each month. Leave a field empty for no limit. When a budget is used up, the AI says so and waits for next month."
      footer={
        <Button type="submit" form={`${ids}-budget`} variant={dirty || saving ? "default" : "secondary"} disabled={!dirty || saving}>
          {saving ? "Saving" : "Save"}
        </Button>
      }
    >
      <form id={`${ids}-budget`} onSubmit={save} noValidate className="grid gap-4 sm:grid-cols-2">
        {BUDGETS.map(({ key, label }) => {
          const error = !!touched[key] && invalid(key)
          return (
            <div key={key} className="flex flex-col gap-1.5">
              <label htmlFor={`${ids}-${key}`} className={FIELD_LABEL}>
                {label}
              </label>
              <Input
                id={`${ids}-${key}`}
                value={fields[key]}
                inputMode="numeric"
                autoComplete="off"
                placeholder="No limit"
                onChange={(event) => setFields((all) => ({ ...all, [key]: event.target.value }))}
                onBlur={() => setTouched((all) => ({ ...all, [key]: true }))}
                aria-invalid={error || undefined}
                aria-describedby={error ? `${ids}-${key}-error` : undefined}
                className="tabular-nums"
              />
              {error && (
                <FieldError id={`${ids}-${key}-error`} className="mt-0">
                  {NOT_A_BUDGET}
                </FieldError>
              )}
            </div>
          )
        })}
      </form>
      {used?.reached && (
        <p className="rounded-lg bg-app-lemon-soft px-3.5 py-2.5 text-ui text-app-lemon-ink">This month's budget is used up.</p>
      )}
    </SettingsSection>
  )
}
