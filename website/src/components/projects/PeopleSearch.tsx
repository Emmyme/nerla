import { useEffect, useId, useRef, useState, type MutableRefObject } from "react"
import { Plus, Search } from "@/components/icons"
import { Input } from "@/components/ui/input"
import { UserAvatar } from "@/components/ui/user-avatar"
import { usersAPI, type UserSearchResult, type UserSummary } from "@/lib/api/users"
import { cn } from "@/lib/utils"

export type PersonResult = UserSummary & { email: string }

function toPerson(user: UserSearchResult): PersonResult {
  return {
    id: user.id,
    email: user.email,
    first_name: user.firstName,
    last_name: user.lastName,
    avatar_url: user.avatarUrl ?? null,
  }
}

export function personName(person: Pick<PersonResult, "first_name" | "last_name"> & { email?: string }): string {
  return [person.first_name, person.last_name].filter(Boolean).join(" ") || person.email || "Unknown user"
}

export function PeopleSearch({
  excludeIds,
  onPick,
  busy = false,
  label = "Add people",
  actionLabel = "Add",
  labelClassName,
  inputClassName,
  inputRef: outerRef,
}: {
  excludeIds: string[]
  onPick: (person: PersonResult) => void
  busy?: boolean
  label?: string
  /** The verb on each result, "Add" by default */
  actionLabel?: string
  labelClassName?: string
  inputClassName?: string
  /** The search field, for a dialog that starts there */
  inputRef?: MutableRefObject<HTMLInputElement | null>
}) {
  const [query, setQuery] = useState("")
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [results, setResults] = useState<PersonResult[] | null>(null)
  const [failed, setFailed] = useState(false)
  const id = useId()
  const term = query.trim()

  useEffect(() => {
    if (term.length < 2) {
      setResults(null)
      setFailed(false)
      return
    }
    let live = true
    const timer = setTimeout(() => {
      usersAPI
        .searchUsers(term)
        .then((found) => {
          if (!live) return
          setResults(found.map(toPerson))
          setFailed(false)
        })
        .catch(() => {
          if (live) setFailed(true)
        })
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [term])

  const visible = results?.filter((person) => !excludeIds.includes(person.id)) ?? null

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`${id}-query`} className={cn("form-label mb-0", labelClassName)}>
        {label}
      </label>
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-[0.75rem] size-[1rem] -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={(node) => {
            inputRef.current = node
            if (outerRef) outerRef.current = node
          }}
          id={`${id}-query`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault()
          }}
          placeholder="Search by name or email"
          autoComplete="off"
          spellCheck={false}
          className={cn("pl-9", inputClassName)}
        />
      </div>

      {term.length >= 2 && (
        <>
          {failed ? (
            <p role="alert" className="text-ui text-app-berry-text">
              Couldn't search people. Check your connection and try again.
            </p>
          ) : visible === null ? (
            <p className="text-ui text-muted-foreground">Searching</p>
          ) : visible.length === 0 ? (
            <p className="text-ui text-muted-foreground">
              {results && results.length > 0 ? "Everyone matching is already added" : "No people found"}
            </p>
          ) : (
            <ul className="max-h-[12.5rem] overflow-y-auto rounded-lg ring-[0.0625rem] ring-border">
              {visible.map((person) => {
                const name = personName(person)
                return (
                  <li key={person.id} className="border-b-[0.0625rem] border-border last:border-b-0">
                    <button
                      type="button"
                      onClick={() => {
                        onPick(person)
                        setQuery("")
                        inputRef.current?.focus()
                      }}
                      disabled={busy}
                      aria-label={`${actionLabel} ${name}`}
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset disabled:cursor-not-allowed max-lg:min-h-[2.75rem]"
                    >
                      <UserAvatar user={person} size="sm" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-ui font-medium text-foreground">{name}</span>
                        <span className="truncate text-caption text-muted-foreground">{person.email}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-caption font-medium text-muted-foreground">
                        {actionLabel === "Add" && <Plus aria-hidden="true" weight="bold" className="size-[0.75rem]" />}
                        {actionLabel}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          <p role="status" className="sr-only">
            {visible === null || failed ? "" : `${visible.length} ${visible.length === 1 ? "person" : "people"} found`}
          </p>
        </>
      )}
    </div>
  )
}
