import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
  type TextareaHTMLAttributes,
} from "react"
import { AiBadge, AiFace } from "@/components/ai/AiAvatar"
import { UserAvatar, type AvatarUser } from "@/components/ui/user-avatar"
import { useAiTeammate } from "@/lib/aiStore"
import {
  AI_MENTION_ID,
  matchPeople,
  mentionName,
  mentionParts,
  mentionQuery,
  prunePicks,
  toMentionTokens,
  type MentionNames,
  type MentionPerson,
} from "@/lib/mentions"
import { cn } from "@/lib/utils"

const MAX_OPTIONS = 8
const NO_NAMES: MentionNames = new Map()

type Candidate = MentionPerson & { user: AvatarUser | null }
export type MentionUser = { id: string; first_name: string | null; last_name: string | null; avatar_url?: string | null }

export type MentionScope = {
  /** The names mentions show as */
  names: MentionNames
  /** Who can be mentioned, the user included or not */
  people: MentionUser[]
  me: string | null
  /** A shared place, where the AI teammate can be mentioned too */
  ai?: boolean
}

/** Mentions inside one chat or one task */
export const MentionContext = createContext<MentionScope>({ names: NO_NAMES, people: [], me: null })

export const useMentionScope = () => useContext(MentionContext)

const PILL = "rounded-sm px-0.5 font-semibold [box-decoration-break:clone]"

/** Text with each mention as a bold "@Name" pill, the user's own in pink */
export function MentionText({ text }: { text: string }) {
  const { names, me } = useMentionScope()
  const parts = mentionParts(text, names)
  return (
    <>
      {parts.map((part, index) =>
        part.id ? (
          <span
            key={index}
            className={cn(
              PILL,
              part.id === me?.toLowerCase() ? "bg-app-bubblegum text-app-bubblegum-ink" : "bg-app-lavender text-app-lavender-ink",
            )}
          >
            {part.text}
          </span>
        ) : (
          part.text
        ),
      )}
    </>
  )
}

/**
 * The textarea shows "@Name" and the stored text keeps `@[userId]`. The users picked, and those already
 * mentioned when editing, map the names back on send, and anyone else in `people` stands in for a name typed by hand.
 */
export function useMentionComposer({
  text,
  setText,
  field,
  seed = [],
}: {
  text: string
  setText: (next: string) => void
  field: RefObject<HTMLTextAreaElement | null>
  /** The mentions already in the text being edited, in order */
  seed?: MentionPerson[]
}) {
  const { people, me, ai } = useMentionScope()
  const teammate = useAiTeammate()
  const aiName = ai && teammate?.available ? teammate.name : null
  const listId = useId()
  const [caret, setCaret] = useState<number | null>(null)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [active, setActive] = useState(0)
  const picked = useRef<MentionPerson[]>(seed)

  // The AI comes first when it can answer here
  const candidates = useMemo<Candidate[]>(
    () => [
      ...(aiName ? [{ id: AI_MENTION_ID, name: aiName, user: null }] : []),
      ...people
        .filter((person) => person.id.toLowerCase() !== me?.toLowerCase())
        .map((person) => ({ id: person.id.toLowerCase(), name: mentionName(person), user: person }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ],
    [people, me, aiName],
  )

  const query = caret === null ? null : mentionQuery(text, caret)
  const term = query?.query
  const options = useMemo(() => (term === undefined ? [] : matchPeople(candidates, term).slice(0, MAX_OPTIONS)), [candidates, term])
  const open = !!query && options.length > 0 && dismissed !== query.start
  const current = open ? options[Math.min(active, options.length - 1)] : undefined
  const optionId = (person: MentionPerson) => `${listId}-${person.id}`

  useEffect(() => setActive(0), [query?.start, query?.query])

  const track = useCallback(() => {
    const node = field.current
    setCaret(node && document.activeElement === node && node.selectionStart === node.selectionEnd ? node.selectionStart : null)
  }, [field])

  const pick = (person: Candidate) => {
    if (!query) return
    const label = `@${person.name} `
    const next = text.slice(0, query.start) + label + text.slice(caret ?? query.start)
    const at = query.start + label.length
    picked.current = [...prunePicks(text, picked.current, candidates), { id: person.id, name: person.name }]
    setText(next)
    setCaret(at)
    requestAnimationFrame(() => {
      const node = field.current
      node?.focus()
      node?.setSelectionRange(at, at)
    })
  }

  /** True when the key belonged to the open list */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || !query || e.nativeEvent.isComposing) return false
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const step = e.key === "ArrowDown" ? 1 : -1
      setActive((index) => (Math.min(index, options.length - 1) + step + options.length) % options.length)
    } else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      if (current) pick(current)
    } else if (e.key === "Escape") {
      setDismissed(query.start)
    } else {
      return false
    }
    e.preventDefault()
    e.stopPropagation()
    return true
  }

  const inputProps: Pick<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    | "role"
    | "aria-autocomplete"
    | "aria-haspopup"
    | "aria-expanded"
    | "aria-controls"
    | "aria-activedescendant"
    | "onSelect"
    | "onFocus"
    | "onBlur"
  > = candidates.length > 0
    ? {
        role: "combobox",
        "aria-autocomplete": "list",
        "aria-haspopup": "listbox",
        "aria-expanded": open,
        "aria-controls": listId,
        "aria-activedescendant": current ? optionId(current) : undefined,
        onSelect: track,
        onFocus: track,
        onBlur: () => setCaret(null),
      }
    : {}

  const picker = (
    <MentionPicker
      id={listId}
      open={open}
      options={options}
      activeId={current?.id ?? null}
      optionId={optionId}
      onHover={(index) => setActive(index)}
      onPick={pick}
    />
  )

  return {
    inputProps,
    onKeyDown,
    picker,
    /** After each change, so the list follows what is typed */
    track,
    toStored: (shown: string) => toMentionTokens(shown, picked.current, candidates),
    /** Starts over, with the mentions of a text about to be edited when given */
    reset: (next: MentionPerson[] = []) => {
      picked.current = next
      setDismissed(null)
    },
  }
}

function MentionPicker({
  id,
  open,
  options,
  activeId,
  optionId,
  onHover,
  onPick,
}: {
  id: string
  open: boolean
  options: Candidate[]
  activeId: string | null
  optionId: (person: MentionPerson) => string
  onHover: (index: number) => void
  onPick: (person: Candidate) => void
}) {
  const list = useRef<HTMLDivElement>(null)

  // The active option stays in view inside the list, without scrolling the page
  useEffect(() => {
    const box = list.current
    const option = activeId ? box?.querySelector<HTMLElement>(`[data-person="${activeId}"]`) : null
    if (!box || !option) return
    if (option.offsetTop < box.scrollTop) box.scrollTop = option.offsetTop
    else if (option.offsetTop + option.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = option.offsetTop + option.offsetHeight - box.clientHeight
  }, [activeId])

  // Always in the page, so the textarea's aria-controls points at something
  return (
    <div
      ref={list}
      id={id}
      role="listbox"
      aria-label="People to mention"
      hidden={!open}
      className="absolute bottom-full left-0 z-50 mb-1 max-h-[17rem] w-[16rem] max-w-full overflow-y-auto rounded-lg border-[0.0625rem] border-border bg-popover p-1 text-popover-foreground shadow-[var(--shadow-popover)]"
    >
      {options.map((person, index) => (
        <div
          key={person.id}
          id={optionId(person)}
          data-person={person.id}
          role="option"
          aria-selected={person.id === activeId}
          // The textarea keeps focus, so typing carries on
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onPointerMove={() => onHover(index)}
          onClick={() => onPick(person)}
          className={cn(
            "flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-ui font-medium text-foreground max-lg:min-h-11",
            person.id === activeId && "bg-app-selected",
          )}
        >
          {person.user ? <UserAvatar user={person.user} size="xs" /> : <AiFace size={1.25} />}
          <span className="truncate">{person.name}</span>
          {!person.user && <AiBadge />}
        </div>
      ))}
    </div>
  )
}
