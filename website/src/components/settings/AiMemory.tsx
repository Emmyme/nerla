import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react"
import { toast } from "sonner"
import { Trash } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { AutosizeTextarea } from "@/components/ui/autosize-textarea"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { FIELD_LABEL } from "@/components/ui/field-label"
import { aiAPI, type AiMemory as Memory } from "@/lib/api/ai"
import { ApiError } from "@/lib/api/request"
import { formatRelative } from "@/lib/dates"
import { onAiHeldEvent } from "@/lib/socket"
import { messageOf } from "@/lib/taskStore"
import { useBusyLoad } from "@/lib/useBusyRetry"
import { cn } from "@/lib/utils"
import { ToggleRow } from "./AiConnectionFields"
import { ConfirmDialog } from "./ConfirmDialog"
import { LoadError, LoadingRows } from "./LoadState"
import { linesChanged, PREF_MAX_CHARS, PREF_MAX_LINES } from "./prefLines"
import { SaveBar, SettingsSection } from "./SettingsSection"

const LOAD_FAILED = "Couldn't load your memory. Check your connection and try again."
const SAVE_FAILED = "Couldn't save your preferences. Try again."
const CLEAR_FAILED = "Couldn't clear the summary. Check your connection and try again."

type Line = { key: string; text: string }
type Control = "remove" | "field"

let nextKey = 0
const keyed = (texts: string[]): Line[] => texts.map((text) => ({ key: `line-${(nextKey += 1)}`, text }))
const textsOf = (memory: Memory) => memory.preferences.lines.map((line) => line.text)

const FIELD =
  "w-full rounded-md border border-input bg-card px-3 py-1.5 text-ui leading-[1.125rem] text-foreground transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background aria-invalid:border-app-berry aria-invalid:focus-visible:ring-app-berry max-lg:py-3"
const ROW_BUTTON = "size-8 shrink-0 text-muted-foreground hover:text-foreground"

/** The user's saved preferences and chat summary, which only they can see */
export function AiMemory({ aiName, onDirty }: { aiName: string; onDirty: (dirty: boolean) => void }) {
  const { data: memory, setData: setMemory, loadError, busy, retry } = useBusyLoad(aiAPI.memory, LOAD_FAILED)
  // A new version remounts the editor with what the server holds now
  const [version, setVersion] = useState(0)
  const dirtyNow = useRef(false)
  const track = useCallback(
    (dirty: boolean) => {
      dirtyNow.current = dirty
      onDirty(dirty)
    },
    [onDirty],
  )
  const reload = useCallback(async () => {
    setMemory(await aiAPI.memory())
    setVersion((n) => n + 1)
  }, [setMemory])

  // A Remember answered anywhere may have changed the list, so an editor with nothing unsaved shows it at once
  useEffect(
    () =>
      onAiHeldEvent((event) => {
        if (event.type === "ai-held-closed" && event.status === "done" && !dirtyNow.current) reload().catch(() => undefined)
      }),
    [reload],
  )

  if (loadError) {
    return (
      <SettingsSection title="Your preferences">
        <LoadError message={loadError} onRetry={retry} />
      </SettingsSection>
    )
  }
  if (!memory) {
    return (
      <SettingsSection title="Your preferences">
        <LoadingRows label="Loading your memory" busy={busy}>
          <Skeleton className="h-[2.75rem] rounded-lg" />
          <Skeleton className="h-[2rem] rounded-lg" />
          <Skeleton className="h-[2rem] rounded-lg" />
        </LoadingRows>
      </SettingsSection>
    )
  }
  return (
    <div className="flex flex-col">
      <Preferences key={version} memory={memory} aiName={aiName} onSaved={setMemory} onDirty={track} onReload={reload} />
      <Summary
        summary={memory.summary}
        aiName={aiName}
        onCleared={() => setMemory((current) => current && { ...current, summary: null })}
      />
    </div>
  )
}

function Preferences({
  memory,
  aiName,
  onSaved,
  onDirty,
  onReload,
}: {
  memory: Memory
  aiName: string
  onSaved: (memory: Memory) => void
  onDirty: (dirty: boolean) => void
  onReload: () => Promise<void>
}) {
  const ids = useId()
  const saved = textsOf(memory)
  const [use, setUse] = useState(memory.preferences.use)
  const [lines, setLines] = useState<Line[]>(() => keyed(saved))
  const [adding, setAdding] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [reloading, setReloading] = useState(false)
  // Counted, so the same words said twice are read out twice
  const [said, setSaidState] = useState({ n: 0, text: "" })
  const setSaid = (text: string) => setSaidState((current) => ({ n: current.n + 1, text }))
  const rows = useRef(new Map<string, Partial<Record<Control, HTMLElement | null>>>())
  const addField = useRef<HTMLInputElement>(null)
  const [focusNext, setFocusNext] = useState<{ key: string; control: Control } | "add" | null>(null)

  const texts = lines.map((line) => line.text)
  const added = adding.trim()
  const dirty = use !== memory.preferences.use || linesChanged(texts, saved) || !!added
  useEffect(() => onDirty(dirty), [dirty, onDirty])
  useEffect(() => () => onDirty(false), [onDirty])

  const full = lines.length >= PREF_MAX_LINES

  // Focus lands on a neighbour after a line goes
  useEffect(() => {
    if (!focusNext) return
    if (focusNext === "add") addField.current?.focus()
    else rows.current.get(focusNext.key)?.[focusNext.control]?.focus()
    setFocusNext(null)
  }, [focusNext])

  const edit = (key: string, text: string) => {
    setError(null)
    setLines((current) => current.map((line) => (line.key === key ? { ...line, text } : line)))
  }

  const remove = (index: number) => {
    const rest = lines.filter((_, at) => at !== index)
    setLines(rest)
    setError(null)
    const neighbour = rest[index] ?? rest[index - 1]
    setFocusNext(neighbour ? { key: neighbour.key, control: "remove" } : "add")
    setSaid(`Removed line ${index + 1}. ${rest.length} of ${PREF_MAX_LINES}`)
  }

  const add = (event?: FormEvent) => {
    event?.preventDefault()
    if (!added || full) return
    setLines((current) => [...current, ...keyed([added])])
    setAdding("")
    setError(null)
    setSaid(`Added as line ${lines.length + 1}. ${lines.length + 1} of ${PREF_MAX_LINES}`)
  }

  const reset = () => {
    setUse(memory.preferences.use)
    setLines(keyed(saved))
    setAdding("")
    setError(null)
  }

  const save = async () => {
    if (!dirty || saving) return
    const next = added && !full ? [...texts, added] : texts
    const empty = next.findIndex((text) => !text.trim())
    if (empty >= 0) {
      setError(`Line ${empty + 1} is empty. Write a preference or remove the line.`)
      return
    }
    setSaving(true)
    setError(null)
    setStale(false)
    try {
      const { preferences } = await aiAPI.savePreferences({ use, lines: next, basedOn: memory.preferences.updatedAt })
      onSaved({ ...memory, preferences })
      setUse(preferences.use)
      setLines(keyed(preferences.lines.map((line) => line.text)))
      setAdding("")
      toast.success("Preferences saved")
    } catch (err) {
      setStale(err instanceof ApiError && err.status === 409)
      setError(messageOf(err, SAVE_FAILED))
    } finally {
      setSaving(false)
    }
  }

  const reloadList = async () => {
    if (reloading) return
    setReloading(true)
    try {
      await onReload()
    } catch (err) {
      setError(messageOf(err, LOAD_FAILED))
      setReloading(false)
    }
  }

  return (
    <>
      <SettingsSection
        title="Your preferences"
        meta={`${lines.length} of ${PREF_MAX_LINES}`}
        description={`How you want ${aiName} to work for you, saved when you choose Remember or added here. Only you can see them, never an admin.`}
      >
        <ToggleRow
          label="Use my preferences"
          description={`On, ${aiName} follows them whenever you ask it something. Off, they are kept but never used, and ${aiName} won't offer to remember new ones.`}
          checked={use}
          onChange={(next) => {
            setUse(next)
            setError(null)
          }}
        />
        <p aria-live="polite" className="sr-only">
          {said.text && <span key={said.n}>{said.text}</span>}
        </p>
        {lines.length === 0 ? (
          <p className="text-ui text-muted-foreground">Nothing saved yet. Add a preference below, or choose Remember when {aiName} asks.</p>
        ) : (
          <ol aria-label="Your preferences" className="flex flex-col gap-1.5">
            {lines.map((line, index) => (
              <PrefRow
                key={line.key}
                line={line}
                index={index}
                register={(control, node) => {
                  const entry = rows.current.get(line.key) ?? {}
                  entry[control] = node
                  rows.current.set(line.key, entry)
                }}
                onEdit={(text) => edit(line.key, text)}
                onRemove={() => remove(index)}
              />
            ))}
          </ol>
        )}
        <form onSubmit={add} noValidate className="flex flex-col gap-1.5">
          <label htmlFor={`${ids}-add`} className={FIELD_LABEL}>
            Add a preference
          </label>
          <div className="flex items-center gap-2">
            <Input
              ref={addField}
              id={`${ids}-add`}
              value={adding}
              maxLength={PREF_MAX_CHARS}
              disabled={full}
              aria-describedby={full ? `${ids}-full` : undefined}
              placeholder="Such as: Call meetings syncs"
              onChange={(event) => {
                setAdding(event.target.value)
                setError(null)
              }}
              className="min-w-0 flex-1"
            />
            <Button type="submit" variant="secondary" aria-disabled={!added || full || undefined} className="shrink-0">
              Add
            </Button>
          </div>
          {full && (
            <p id={`${ids}-full`} className="text-caption text-muted-foreground">
              Your preferences are full. Remove one to add another.
            </p>
          )}
        </form>
        {error && (
          <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="text-ui text-app-berry-text">{error}</p>
            {stale && (
              <Button type="button" variant="outline" size="sm" aria-busy={reloading || undefined} onClick={() => void reloadList()}>
                {reloading ? "Reloading" : "Reload"}
              </Button>
            )}
          </div>
        )}
      </SettingsSection>
      {dirty && <SaveBar saving={saving} onSave={() => void save()} onCancel={reset} />}
    </>
  )
}

function PrefRow({
  line,
  index,
  register,
  onEdit,
  onRemove,
}: {
  line: Line
  index: number
  register: (control: Control, node: HTMLElement | null) => void
  onEdit: (text: string) => void
  onRemove: () => void
}) {
  const n = index + 1
  return (
    <li className="flex items-start gap-1 rounded-md">
      {/* Grows to show a long line in full. A preference is one line, so Enter adds no break */}
      <AutosizeTextarea
        ref={(node) => register("field", node)}
        value={line.text}
        maxLength={PREF_MAX_CHARS}
        aria-label={`Preference ${n}`}
        aria-invalid={!line.text.trim() || undefined}
        onChange={(event) => onEdit(event.target.value.replace(/\s*\n\s*/g, " "))}
        onKeyDown={(event) => event.key === "Enter" && event.preventDefault()}
        containerClassName="min-w-0 flex-1"
        className={FIELD}
      />
      <Button
        ref={(node) => register("remove", node)}
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Remove preference ${n}`}
        onClick={onRemove}
        className={cn(ROW_BUTTON, "hover:text-app-berry-text")}
      >
        <Trash aria-hidden="true" className="size-4" />
      </Button>
    </li>
  )
}

function Summary({ summary, aiName, onCleared }: { summary: Memory["summary"]; aiName: string; onCleared: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const heading = useRef<HTMLDivElement>(null)

  return (
    <SettingsSection
      title="Chat summary"
      description={
        summary
          ? summary.updatedAt
            ? `Folded from older messages, updated ${formatRelative(summary.updatedAt)}`
            : "Folded from older messages"
          : undefined
      }
      action={
        summary && (
          <Button type="button" variant="destructive" onClick={() => setConfirming(true)}>
            Clear summary
          </Button>
        )
      }
    >
      <div ref={heading} tabIndex={-1} className="focus-visible:outline-none">
        {summary ? (
          // Plain text, never markup, since the model wrote it
          <p className="rounded-md bg-app-sunk px-3 py-2.5 text-ui leading-[1.55] wrap-anywhere whitespace-pre-wrap text-foreground">
            {summary.text}
          </p>
        ) : (
          <p className="text-ui text-muted-foreground">
            Nothing yet. Once your chat with {aiName} passes 20 messages, older ones are summarised here.
          </p>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        title="Clear the summary?"
        confirmLabel="Clear summary"
        busyLabel="Clearing"
        failed={CLEAR_FAILED}
        onConfirm={async () => {
          await aiAPI.clearSummary()
          onCleared()
          toast.success("Summary cleared")
        }}
        onClose={() => setConfirming(false)}
        fallbackFocus={() => heading.current}
      >
        It's deleted for good, so {aiName} no longer knows what it covered. Your messages stay, and the older ones aren't summarised again.
      </ConfirmDialog>
    </SettingsSection>
  )
}
