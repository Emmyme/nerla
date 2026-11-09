import { useId, useRef, useState, type FormEvent } from "react"
import { X } from "@/components/icons"
import { ColorPicker } from "@/components/files/NewFolderDialog"
import { PeopleSearch, personName, type PersonResult } from "@/components/projects/PeopleSearch"
import BaseModal from "@/components/ui/BaseModal"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field-error"
import { SymbolPicker } from "@/components/ui/identity-tile"
import { Input } from "@/components/ui/input"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { UserAvatar } from "@/components/ui/user-avatar"
import type { SymbolKey } from "@/components/ui/symbols"
import { groupChatsAPI, type ChatSummary } from "@/lib/api/chat"
import type { FolderColor } from "@/lib/folderColors"
import { refreshChats } from "@/lib/chatList"
import { messageOf } from "@/lib/taskStore"
import { cn, TAP } from "@/lib/utils"

export type NewChatMode = "dm" | "group"

const CREATE_FAILED = "Couldn't create the group. Check your connection and try again."

const MODES: { value: NewChatMode; label: string }[] = [
  { value: "dm", label: "Direct message" },
  { value: "group", label: "Group" },
]

const toPerson = (person: PersonResult) => ({
  id: person.id,
  first_name: person.first_name,
  last_name: person.last_name,
  avatar_url: person.avatar_url,
})

/** Picks a user for a DM, or names a group and picks its members. Opens the chat it lands on */
export function NewChatDialog({
  open,
  mode: initialMode,
  me,
  onClose,
  onOpenChat,
}: {
  open: boolean
  mode: NewChatMode
  me: string
  onClose: () => void
  onOpenChat: (chat: ChatSummary) => void
}) {
  const [mode, setMode] = useState<NewChatMode>(initialMode)
  const [name, setName] = useState("")
  const [members, setMembers] = useState<PersonResult[]>([])
  const [color, setColor] = useState<FolderColor>("sky")
  const [symbol, setSymbol] = useState<SymbolKey | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [missingName, setMissingName] = useState(false)
  const ids = useId()
  const search = useRef<HTMLInputElement | null>(null)
  const nameField = useRef<HTMLInputElement | null>(null)

  // Reset while rendering, so the fields of the mode asked for are in place when the dialog takes focus
  const [shown, setShown] = useState<{ open: boolean; mode: NewChatMode }>({ open, mode: initialMode })
  if (shown.open !== open || (open && shown.mode !== initialMode)) {
    setShown({ open, mode: initialMode })
    if (open) {
      setMode(initialMode)
      setName("")
      setMembers([])
      setColor("sky")
      setSymbol(null)
      setError(null)
      setMissingName(false)
    }
  }

  const startDm = (person: PersonResult) => {
    onOpenChat({
      kind: "dm",
      id: person.id,
      title: personName(person),
      project_id: null,
      members: [toPerson(person)],
      member_count: 2,
      can_pin: true,
      last_message: null,
      last_activity_at: new Date().toISOString(),
      unread: false,
    })
    onClose()
  }

  const createGroup = async (e: FormEvent) => {
    e.preventDefault()
    const title = name.trim()
    if (!title) {
      setMissingName(true)
      return
    }
    if (members.length === 0) return
    setSaving(true)
    setError(null)
    try {
      // The colour only shows with a symbol, so a group without one keeps the avatars and stores neither
      const group = await groupChatsAPI.createGroupChat({
        name: title,
        member_ids: members.map((m) => m.id),
        ...(symbol && { icon: symbol, color }),
      })
      refreshChats()
      onOpenChat({
        kind: "group",
        id: group.id,
        title: group.name,
        project_id: null,
        icon: group.icon ?? null,
        color: group.color ?? null,
        members: members.map(toPerson),
        member_count: members.length + 1,
        can_pin: true,
        last_message: null,
        last_activity_at: group.created_at,
        unread: false,
      })
      onClose()
    } catch (err) {
      setError(messageOf(err, CREATE_FAILED))
    } finally {
      setSaving(false)
    }
  }

  return (
    <BaseModal
      isOpen={open}
      onClose={() => !saving && onClose()}
      title="New chat"
      maxWidth="md"
      initialFocus={() => (mode === "group" ? nameField.current : search.current)}
    >
      <div className="flex flex-col gap-5 p-6">
        <SegmentedControl
          value={mode}
          onChange={setMode}
          options={MODES}
          label="Chat type"
          className="w-full [&>button]:flex-1 [&>button]:justify-center"
        />

        {mode === "dm" ? (
          <PeopleSearch label="Person" actionLabel="Message" excludeIds={[me]} onPick={startDm} inputRef={search} />
        ) : (
          <form onSubmit={createGroup} className="flex flex-col gap-5" noValidate>
            <div className="flex flex-col gap-2">
              <label htmlFor={`${ids}-name`} className="form-label mb-0">
                Group name
              </label>
              <Input
                ref={nameField}
                id={`${ids}-name`}
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  if (e.target.value.trim()) setMissingName(false)
                }}
                maxLength={255}
                placeholder="Design team"
                aria-invalid={missingName || undefined}
                aria-describedby={missingName ? `${ids}-name-error` : undefined}
                autoComplete="off"
              />
              {missingName && <FieldError id={`${ids}-name-error`}>Give the group a name</FieldError>}
            </div>

            <div className="flex flex-col gap-2">
              <span id={`${ids}-symbol`} className="form-label mb-0">
                Symbol
              </span>
              <SymbolPicker value={symbol} onChange={setSymbol} labelledBy={`${ids}-symbol`} />
            </div>
            {symbol && (
              <div className="flex flex-col gap-2">
                <span id={`${ids}-color`} className="form-label mb-0">
                  Colour
                </span>
                <ColorPicker value={color} onChange={setColor} labelledBy={`${ids}-color`} />
              </div>
            )}

            <div className="flex flex-col gap-2.5">
              <PeopleSearch
                label="Members"
                excludeIds={[me, ...members.map((m) => m.id)]}
                onPick={(person) => setMembers((list) => [...list, person])}
              />
              {members.length > 0 && (
                <ul aria-label="Chosen members" className="flex flex-wrap gap-1.5">
                  {members.map((person) => (
                    <li key={person.id} className="flex items-center gap-1.5 rounded-full bg-app-sunk py-0.5 pr-1 pl-0.5">
                      <UserAvatar user={person} size="xs" />
                      <span className="text-caption font-medium text-foreground">{personName(person)}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${personName(person)}`}
                        onClick={() => setMembers((list) => list.filter((m) => m.id !== person.id))}
                        className={cn(
                          "flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none",
                          TAP,
                        )}
                      >
                        <X aria-hidden="true" className="size-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {error && (
              <p role="alert" className="text-ui text-app-berry-text">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || members.length === 0}>
                Create group
              </Button>
            </div>
          </form>
        )}
      </div>
    </BaseModal>
  )
}
