import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react"
import { toast } from "sonner"
import { Toggle } from "@/components/calendar/EventFields"
import { CheckCircle, Warning } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { FIELD_LABEL } from "@/components/ui/field-label"
import { messageOf } from "@/lib/taskStore"

/** A key is never shown again once saved, so the field keeps it, replaces it or clears it */
type KeyDraft = { mode: "keep" | "replace" | "clear"; value: string }

const KEEP_KEY: KeyDraft = { mode: "keep", value: "" }

/** What a save sends for the key: nothing keeps it, an empty string clears it */
function keyPatch(draft: KeyDraft): string | undefined {
  if (draft.mode === "clear") return ""
  if (draft.mode === "replace" && draft.value.trim()) return draft.value.trim()
  return undefined
}

const keyChanged = (draft: KeyDraft) => keyPatch(draft) !== undefined

function KeyField({
  id,
  last4,
  draft,
  onChange,
}: {
  id: string
  last4: string | null
  draft: KeyDraft
  onChange: (draft: KeyDraft) => void
}) {
  const saved = !!last4 && draft.mode !== "replace"
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={FIELD_LABEL}>
        Key
      </label>
      {saved ? (
        <div className="flex flex-wrap items-center gap-2">
          <output
            id={id}
            aria-label={draft.mode === "clear" ? "Key, cleared when you save" : `Key ending in ${last4}`}
            className="flex h-8 min-w-[8rem] items-center rounded-md bg-app-sunk px-3 text-ui text-foreground tabular-nums max-lg:h-11"
          >
            {draft.mode === "clear" ? <span className="text-muted-foreground">Cleared when you save</span> : `••••${last4}`}
          </output>
          {draft.mode === "clear" ? (
            <Button type="button" variant="ghost" onClick={() => onChange(KEEP_KEY)}>
              Undo
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => onChange({ mode: "replace", value: "" })}>
                Replace
              </Button>
              <Button type="button" variant="ghost" onClick={() => onChange({ mode: "clear", value: "" })}>
                Clear
              </Button>
            </>
          )}
        </div>
      ) : (
        <div className="flex gap-2">
          <Input
            id={id}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={last4 ? "Paste the new key" : "Optional"}
            value={draft.value}
            maxLength={500}
            autoFocus={!!last4}
            onChange={(event) => onChange({ mode: "replace", value: event.target.value })}
            className="min-w-0 flex-1"
          />
          {last4 && (
            <Button type="button" variant="ghost" onClick={() => onChange(KEEP_KEY)}>
              Cancel
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** A switch with its label and what it does, saved on its own */
export function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description: ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  const descriptionId = useId()
  return (
    <div className="flex items-start gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-ui font-medium text-foreground">{label}</span>
        <span id={descriptionId} className="text-caption leading-[1.45] text-muted-foreground">
          {description}
        </span>
      </div>
      <Toggle checked={checked} onChange={onChange} label={label} describedBy={descriptionId} />
    </div>
  )
}

const TEST_FAILED = "Couldn't connect"

/** Tries the saved connection. The answer is only ever whether it worked */
function ConnectionTest({ test, blocked }: { test: () => Promise<{ ok: boolean }>; blocked: string | null }) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<"ok" | "failed" | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    if (testing || blocked) return
    setTesting(true)
    setResult(null)
    setError(null)
    try {
      setResult((await test()).ok ? "ok" : "failed")
    } catch (err) {
      const message = messageOf(err, TEST_FAILED)
      setResult("failed")
      if (message !== TEST_FAILED) setError(message)
    } finally {
      setTesting(false)
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        aria-disabled={testing || !!blocked || undefined}
        aria-busy={testing || undefined}
        onClick={() => void run()}
      >
        {testing ? "Testing" : "Test connection"}
      </Button>
      <p role="status" className="flex items-center gap-1.5 text-ui">
        {blocked ? (
          <span className="text-muted-foreground">{blocked}</span>
        ) : result === "ok" ? (
          <>
            <CheckCircle aria-hidden="true" weight="fill" className="size-[1rem] text-app-pistachio-strong" />
            <span className="font-medium text-foreground">Connected</span>
          </>
        ) : result === "failed" ? (
          <>
            <Warning aria-hidden="true" className="size-[1rem] text-app-berry-text" />
            <span className="font-medium text-app-berry-text">{error ?? TEST_FAILED}</span>
          </>
        ) : null}
      </p>
    </>
  )
}

type ConnectionSaved = { baseUrl: string | null; model: string | null; keyLast4: string | null; localNetwork?: boolean }
type ConnectionPatch = { baseUrl?: string | null; model?: string | null; key?: string; localNetwork?: boolean }

const ADDRESS_MAX = 2000
const MODEL_MAX = 200
const SAVE_FAILED = "Couldn't save the connection. Try again."

/**
 * The address, model name and key of a model connection, saved together. `address` false leaves only the key,
 * for the user's own key on the workspace's model. A test always runs on what was saved
 */
export function ConnectionForm({
  saved,
  address,
  onSave,
  test,
  onDirty,
}: {
  saved: ConnectionSaved
  address: boolean
  onSave: (patch: ConnectionPatch) => Promise<void>
  test: () => Promise<{ ok: boolean }>
  onDirty: (dirty: boolean) => void
}) {
  const ids = useId()
  const [baseUrl, setBaseUrl] = useState(saved.baseUrl ?? "")
  const [model, setModel] = useState(saved.model ?? "")
  const [key, setKey] = useState<KeyDraft>(KEEP_KEY)
  const [local, setLocal] = useState(!!saved.localNetwork)
  const [saving, setSaving] = useState(false)

  const changes: ConnectionPatch = {}
  if (address && baseUrl.trim() !== (saved.baseUrl ?? "")) changes.baseUrl = baseUrl.trim() || null
  if (address && model.trim() !== (saved.model ?? "")) changes.model = model.trim() || null
  if (keyChanged(key)) changes.key = keyPatch(key)
  if (saved.localNetwork !== undefined && local !== saved.localNetwork) changes.localNetwork = local
  const dirty = Object.keys(changes).length > 0
  useEffect(() => onDirty(dirty), [dirty, onDirty])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!dirty || saving) return
    setSaving(true)
    try {
      await onSave(changes)
      setKey(KEEP_KEY)
      toast.success("Connection saved")
    } catch (err) {
      toast.error(messageOf(err, SAVE_FAILED))
    } finally {
      setSaving(false)
    }
  }

  const connected = address ? !!(saved.baseUrl && saved.model) : !!saved.keyLast4
  const blocked = dirty
    ? "Save to test these settings."
    : connected
      ? null
      : address
        ? "Add an address and a model name first."
        : "Add a key first."

  return (
    <form onSubmit={save} noValidate className="flex flex-col gap-4">
      {address && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${ids}-address`} className={FIELD_LABEL}>
              Model address
            </label>
            <Input
              id={`${ids}-address`}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://api.example.com/v1"
              value={baseUrl}
              maxLength={ADDRESS_MAX}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${ids}-model`} className={FIELD_LABEL}>
              Model name
            </label>
            <Input
              id={`${ids}-model`}
              autoComplete="off"
              spellCheck={false}
              placeholder="llama3.1"
              value={model}
              maxLength={MODEL_MAX}
              onChange={(event) => setModel(event.target.value)}
            />
          </div>
        </div>
      )}
      <div className="sm:max-w-[calc(50%-0.5rem)]">
        <KeyField id={`${ids}-key`} last4={saved.keyLast4} draft={key} onChange={setKey} />
      </div>
      {saved.localNetwork !== undefined && (
        <ToggleRow
          label="Local model on this network"
          description="Lets the address be on this server or its network, such as Ollama on the same machine. Without it the address needs https."
          checked={local}
          onChange={setLocal}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant={dirty || saving ? "default" : "secondary"} disabled={!dirty || saving}>
          {saving ? "Saving" : "Save"}
        </Button>
        <ConnectionTest test={test} blocked={blocked} />
      </div>
    </form>
  )
}
