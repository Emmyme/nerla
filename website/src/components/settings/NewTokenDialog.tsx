import { useEffect, useId, useRef, useState, type FormEvent } from "react"
import { toast } from "sonner"
import { Check, Copy } from "@/components/icons"
import BaseModal from "@/components/ui/BaseModal"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field-error"
import { Input } from "@/components/ui/input"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { FIELD_LABEL } from "@/components/ui/field-label"
import { AI_TOKEN_AREAS, aiAPI, type AiToken, type AiTokenArea, type AiTokenExpiry, type AiTokenScopes } from "@/lib/api/ai"
import { messageOf } from "@/lib/taskStore"
import { useCopied } from "@/lib/useCopied"
import { ToggleRow } from "./AiConnectionFields"
import { AgentPicker, ConnectAgent } from "./ConnectAgent"
import { AGENT_NAMES, type AgentClient } from "./connectConfigs"
import { copyToClipboard } from "./InviteDialog"

export const AREA_LABELS: Record<AiTokenArea, string> = {
  tasks: "Tasks",
  projects: "Projects",
  calendar: "Calendar",
  papers: "Papers and boards",
  chat: "Chat",
  files: "Files",
  time: "Time",
}

type Level = "off" | "read" | "write"

const LEVELS: { value: Level; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "read", label: "Read" },
  { value: "write", label: "Read and write" },
]

const EXPIRIES: { value: string; label: string; days: AiTokenExpiry }[] = [
  { value: "7", label: "7 days", days: 7 },
  { value: "30", label: "30 days", days: 30 },
  { value: "90", label: "90 days", days: 90 },
  { value: "365", label: "1 year", days: 365 },
  { value: "never", label: "Never", days: null },
]

const NAME_MAX = 80
const MAKE_FAILED = "Couldn't make the token. Try again."
const COPY_FAILED = "Couldn't copy the token. Select it and copy it yourself."
const NO_AREA = "Pick at least one area."

const NO_LEVELS = Object.fromEntries(AI_TOKEN_AREAS.map((area) => [area, "off"])) as Record<AiTokenArea, Level>

/** A new access token for an outside agent. Its value shows once, right after it's made */
export function NewTokenDialog({
  open,
  agent = "claude-code",
  onClose,
  onCreated,
}: {
  open: boolean
  /** The agent picked so far, which the form starts from */
  agent?: AgentClient
  onClose: () => void
  onCreated: (token: AiToken) => void
}) {
  const [made, setMade] = useState<{ token: string; client: AgentClient } | null>(null)

  useEffect(() => {
    if (!open) setMade(null)
  }, [open])

  return (
    <BaseModal isOpen={open} onClose={onClose} title="New token" maxWidth="lg">
      {made ? (
        <ShownToken token={made.token} client={made.client} onDone={onClose} />
      ) : (
        <TokenForm
          agent={agent}
          onCancel={onClose}
          onMade={({ token, ...listed }, client) => {
            setMade({ token, client })
            // The list keeps everything but the value, which lives only in this dialog
            onCreated(listed)
          }}
        />
      )}
    </BaseModal>
  )
}

function TokenForm({
  agent,
  onCancel,
  onMade,
}: {
  agent: AgentClient
  onCancel: () => void
  onMade: (token: AiToken & { token: string }, client: AgentClient) => void
}) {
  const [client, setClient] = useState(agent)
  const [name, setName] = useState(AGENT_NAMES[agent])
  // Once the user types a name, picking an agent leaves it alone
  const [touched, setTouched] = useState(false)
  const [expiry, setExpiry] = useState("30")
  const [readOnly, setReadOnly] = useState(false)
  const [levels, setLevels] = useState(NO_LEVELS)
  const [tried, setTried] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ids = useId()

  const nameError = name.trim() ? null : "Name the token, for example after the agent or the device."
  const scopes: AiTokenScopes = {}
  for (const area of AI_TOKEN_AREAS) {
    const level = levels[area]
    if (level !== "off") scopes[area] = readOnly ? "read" : level
  }
  const areaError = Object.keys(scopes).length === 0 ? NO_AREA : null

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTried(true)
    if (nameError || areaError || saving) return
    setSaving(true)
    setError(null)
    try {
      const days = EXPIRIES.find((option) => option.value === expiry)?.days ?? 30
      onMade(await aiAPI.createToken({ name: name.trim(), expiresInDays: days, scopes, readOnly }), client)
    } catch (err) {
      setError(messageOf(err, MAKE_FAILED))
    } finally {
      setSaving(false)
    }
  }

  const options = readOnly ? LEVELS.filter((level) => level.value !== "write") : LEVELS
  const pickAgent = (next: AgentClient) => {
    setClient(next)
    if (!touched) setName(AGENT_NAMES[next])
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5 p-6">
      <AgentPicker value={client} onChange={pickAgent} />
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${ids}-name`} className={FIELD_LABEL}>
            Name
          </label>
          <Input
            id={`${ids}-name`}
            value={name}
            maxLength={NAME_MAX}
            autoComplete="off"
            autoFocus
            placeholder="Laptop agent"
            onChange={(event) => {
              setTouched(true)
              setName(event.target.value)
            }}
            aria-invalid={(tried && !!nameError) || undefined}
            aria-describedby={tried && nameError ? `${ids}-name-error` : undefined}
          />
          {tried && nameError && (
            <FieldError id={`${ids}-name-error`} className="mt-0">
              {nameError}
            </FieldError>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <label id={`${ids}-expiry`} className={FIELD_LABEL}>
            Expires after
          </label>
          <Select value={expiry} onValueChange={setExpiry}>
            <SelectTrigger aria-labelledby={`${ids}-expiry`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXPIRIES.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <ToggleRow
        label="Read only"
        description="The token can read what you can, and never changes anything."
        checked={readOnly}
        onChange={setReadOnly}
      />

      <fieldset className="flex flex-col gap-2" aria-describedby={tried && areaError ? `${ids}-areas-error` : undefined}>
        <legend className={`${FIELD_LABEL} mb-2`}>Areas</legend>
        <div className="flex flex-col divide-y-[0.0625rem] divide-border rounded-lg ring-[0.0625rem] ring-border">
          {AI_TOKEN_AREAS.map((area) => (
            <div key={area} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
              <span className="min-w-0 flex-1 text-ui font-medium text-foreground">{AREA_LABELS[area]}</span>
              <SegmentedControl
                label={AREA_LABELS[area]}
                value={readOnly && levels[area] === "write" ? "read" : levels[area]}
                onChange={(level) => setLevels((all) => ({ ...all, [area]: level }))}
                options={options}
              />
            </div>
          ))}
        </div>
        {tried && areaError && (
          <FieldError id={`${ids}-areas-error`} className="mt-0">
            {areaError}
          </FieldError>
        )}
      </fieldset>

      {error && (
        <p role="alert" className="text-ui text-app-berry-text">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" aria-disabled={saving || undefined} aria-busy={saving || undefined}>
          {saving ? "Making" : "Make token"}
        </Button>
      </div>
    </form>
  )
}

function ShownToken({ token, client, onDone }: { token: string; client: AgentClient; onDone: () => void }) {
  const field = useRef<HTMLInputElement>(null)
  const [copied, markCopied] = useCopied()
  const noteId = useId()

  // The form that had focus is gone, and the field reads out the note with it
  useEffect(() => field.current?.focus(), [])

  const copy = async () => {
    if (await copyToClipboard(token, field.current)) return markCopied()
    toast.error(COPY_FAILED)
    field.current?.focus()
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <p id={noteId} className="text-body leading-[1.5] text-foreground">
        Copy it now and keep it somewhere safe. You won't see this token again.
      </p>
      <div className="flex gap-2 max-sm:flex-col">
        <Input
          ref={field}
          readOnly
          value={token}
          aria-label="Your new token"
          aria-describedby={noteId}
          onFocus={(event) => event.currentTarget.select()}
          className="min-w-0 font-mono text-caption sm:flex-1"
        />
        <Button type="button" variant="outline" className="shrink-0" onClick={() => void copy()}>
          {copied ? <Check aria-hidden="true" className="size-[1rem]" /> : <Copy aria-hidden="true" className="size-[1rem]" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <section aria-labelledby={`${noteId}-connect`} className="flex flex-col gap-3 border-t border-border pt-4">
        <h3 id={`${noteId}-connect`} className="text-ui font-semibold text-foreground">
          Connect an agent
        </h3>
        <ConnectAgent token={token} client={client} />
      </section>
      <div className="flex justify-end">
        <Button type="button" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  )
}
