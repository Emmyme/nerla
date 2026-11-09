import { Check, Question, X } from "@/components/icons"
import { PeopleSearch, personName, type PersonResult } from "@/components/projects/PeopleSearch"
import { UserAvatar } from "@/components/ui/user-avatar"
import type { EventAttendee, EventResponse } from "@/lib/api/calendar"
import { cn } from "@/lib/utils"

export const RESPONSE_WORD: Record<EventResponse, string> = { yes: "Yes", no: "No", maybe: "Maybe", pending: "Awaiting" }

export function guestName(guest: EventAttendee): string {
  return [guest.first_name, guest.last_name].filter(Boolean).join(" ") || "Guest"
}

const toGuest = (person: PersonResult): EventAttendee => ({
  user_id: person.id,
  first_name: person.first_name || person.last_name ? person.first_name : personName(person),
  last_name: person.last_name,
  avatar_url: person.avatar_url,
  response: "pending",
})

/** A small badge on the avatar: a check for yes, a cross for no, a question mark for maybe */
export function ResponseMark({ response, ring = "ring-popover" }: { response: EventResponse; ring?: string }) {
  if (response === "pending") return null
  const Icon = response === "yes" ? Check : response === "no" ? X : Question
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute -right-[0.3rem] -bottom-[0.2rem] flex size-[0.75rem] items-center justify-center rounded-full ring-[0.125rem]",
        ring,
        response === "yes" ? "bg-app-pistachio text-app-pistachio-ink" : "bg-app-sunk text-muted-foreground",
      )}
    >
      <Icon weight="bold" className="size-[0.5rem]" />
    </span>
  )
}

/** Workspace members as guests, each a chip with their reply, and a search to add more */
export function GuestPicker({
  guests,
  ownerId,
  onChange,
}: {
  guests: EventAttendee[]
  ownerId: string | undefined
  onChange: (guests: EventAttendee[]) => void
}) {
  const excludeIds = [...guests.map((guest) => guest.user_id), ...(ownerId ? [ownerId] : [])]
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2.5">
      <PeopleSearch label="Guests" excludeIds={excludeIds} onPick={(person) => onChange([...guests, toGuest(person)])} />
      {guests.length > 0 && (
        <ul aria-label="Guests" className="flex flex-wrap gap-1.5">
          {guests.map((guest) => {
            const name = guestName(guest)
            return (
              <li
                key={guest.user_id}
                className="flex max-w-full items-center gap-2 rounded-full bg-app-sunk py-1 pr-0.5 pl-1 text-ui text-foreground"
              >
                <span className="relative shrink-0">
                  <UserAvatar
                    user={{ id: guest.user_id, first_name: guest.first_name, last_name: guest.last_name, avatar_url: guest.avatar_url }}
                    size="xs"
                  />
                  <ResponseMark response={guest.response} ring="ring-app-sunk" />
                </span>
                <span className="min-w-0 truncate font-medium">{name}</span>
                <span className="sr-only">, {RESPONSE_WORD[guest.response]}</span>
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  onClick={() => onChange(guests.filter((other) => other.user_id !== guest.user_id))}
                  className="flex size-[1.4rem] shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:size-9"
                >
                  <X aria-hidden="true" weight="bold" className="size-[0.7rem]" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
