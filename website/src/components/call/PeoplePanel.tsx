import { useEffect, useRef, useState, type ReactNode } from "react"
import { useIsMuted, useIsSpeaking, useParticipants } from "@livekit/components-react"
import { Track, type Participant } from "livekit-client"
import { toast } from "sonner"
import { Check, Link, Microphone, MicrophoneSlash } from "@/components/icons"
import { PeopleSearch, personName, type PersonResult } from "@/components/projects/PeopleSearch"
import { Button } from "@/components/ui/button"
import { UserAvatar } from "@/components/ui/user-avatar"
import { ApiError } from "@/lib/api/request"
import { meetingsAPI } from "@/lib/api/meetings"
import { hasJoinLink, joinLink } from "@/lib/meetingWindow"
import { useCopied } from "@/lib/useCopied"
import { avatarOf } from "./avatar"
import { CALL_FIELD } from "./CallIconButton"
import { whoIs } from "./CallTile"
import { SpeakingBars, useLevelVar } from "./SpeakingLevel"
import { CALL_TOASTER } from "./incoming"
import { LobbyRequests, type Lobby } from "./LobbyRequests"

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-ui font-semibold text-app-text">
        {title}
        {count !== undefined && (
          <>
            {" "}
            <span className="ml-1 font-normal text-app-text-muted tabular-nums">{count}</span>
          </>
        )}
      </h3>
      {children}
    </section>
  )
}

// Members see who everyone in the call is. There is nowhere to go from a call, so the card has no actions
const IN_CALL = { actions: false }

function PersonRow({ participant, viewerIsGuest }: { participant: Participant; viewerIsGuest: boolean }) {
  const { name, guest } = whoIs(participant)
  const profile = !viewerIsGuest && !guest
  const micOff = useIsMuted({ participant, source: Track.Source.Microphone })
  const speaking = useIsSpeaking(participant) && !micOff
  const row = useRef<HTMLLIElement>(null)
  useLevelVar(row, participant, speaking)
  return (
    <li ref={row} className="flex min-h-10 items-center gap-2.5">
      <span aria-hidden={profile ? undefined : "true"} className="inline-flex">
        <UserAvatar user={avatarOf(participant.identity, name)} size="md" profile={profile && IN_CALL} />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-ui">
        <span className="truncate font-medium text-app-text">{name}</span>
        {participant.isLocal && <span className="shrink-0 text-app-text-muted">(you)</span>}
        {guest && <span className="shrink-0 rounded-full bg-app-lavender px-1.5 text-micro font-medium text-app-lavender-ink">Guest</span>}
      </span>
      <span className="flex size-4 shrink-0 items-center justify-center">
        {micOff ? (
          <MicrophoneSlash aria-hidden="true" className="size-4 text-app-berry-text" />
        ) : speaking ? (
          <SpeakingBars />
        ) : (
          <Microphone aria-hidden="true" className="size-4 text-app-text-muted" />
        )}
      </span>
      <span className="sr-only">{micOff ? "Microphone off" : speaking ? "Speaking" : "Microphone on"}</span>
    </li>
  )
}

function CopyJoinLink({ roomName }: { roomName: string }) {
  const [copied, markCopied] = useCopied()

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(joinLink(roomName))
      markCopied()
    } catch {
      toast.error("Couldn't copy the link. Try again.", { toasterId: CALL_TOASTER })
    }
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <p className="text-caption text-app-text-muted">Guests outside the workspace can ask to join with the link.</p>
      <Button variant="outline" size="sm" onClick={() => void copy()}>
        {copied ? <Check aria-hidden="true" className="size-3.5" /> : <Link aria-hidden="true" className="size-3.5" />}
        {copied ? "Link copied" : "Copy join link"}
      </Button>
      <span role="status" className="sr-only">
        {copied ? "Join link copied" : ""}
      </span>
    </div>
  )
}

function AddPeople({
  roomName,
  inCall,
  invited,
  onInvited,
  focusSearch,
}: {
  roomName: string
  inCall: string[]
  invited: PersonResult[]
  onInvited: (person: PersonResult) => void
  focusSearch: number
}) {
  const box = useRef<HTMLDivElement>(null)
  const [inviting, setInviting] = useState(false)
  const [announce, setAnnounce] = useState("")
  const waiting = invited.filter((p) => !inCall.includes(p.id))

  useEffect(() => {
    if (focusSearch) box.current?.querySelector("input")?.focus()
  }, [focusSearch])

  const invite = async (person: PersonResult) => {
    setInviting(true)
    try {
      await meetingsAPI.invite(roomName, person.id)
      onInvited(person)
      setAnnounce(`Invited ${personName(person)}`)
    } catch (err) {
      console.error("Call invite failed:", err)
      // A refusal is not worth retrying, so its reason is shown instead, such as an event that only its attendees may invite to
      const refused = err instanceof ApiError && err.status === 403 && err.serverMessage
      toast.error(
        refused
          ? `Couldn't invite ${personName(person)}. ${refused.replace(/\.?$/, ".")}`
          : `Couldn't invite ${personName(person)}. Try again.`,
        {
          toasterId: CALL_TOASTER,
        },
      )
    } finally {
      setInviting(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div ref={box}>
        <PeopleSearch
          label="Add people"
          labelClassName="font-semibold! text-app-text!"
          inputClassName={CALL_FIELD}
          excludeIds={[...inCall, ...invited.map((p) => p.id)]}
          onPick={(person) => void invite(person)}
          busy={inviting}
        />
      </div>
      {waiting.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {waiting.map((person) => (
            <li key={person.id} className="flex min-h-10 items-center gap-2.5">
              <span className="inline-flex">
                <UserAvatar user={person} size="md" profile={IN_CALL} />
              </span>
              <span className="min-w-0 flex-1 truncate text-ui font-medium text-app-text">{personName(person)}</span>
              <span className="flex shrink-0 items-center gap-1 text-caption text-app-text-muted">
                <Check aria-hidden="true" className="size-3.5" />
                Invited
              </span>
            </li>
          ))}
        </ul>
      )}
      <span role="status" className="sr-only">
        {announce}
      </span>
      {hasJoinLink(roomName) && <CopyJoinLink roomName={roomName} />}
    </div>
  )
}

/** Who is waiting, who is here, and for members a way to invite more users */
export function PeoplePanel({
  roomName,
  guest,
  lobby,
  invited,
  onInvited,
  focusSearch,
}: {
  roomName: string
  guest: boolean
  lobby: Lobby
  invited: PersonResult[]
  onInvited: (person: PersonResult) => void
  /** Changes each time the invite button asks for the search */
  focusSearch: number
}) {
  const participants = useParticipants()
  const sorted = [...participants].sort((a, b) =>
    a.isLocal !== b.isLocal ? (a.isLocal ? -1 : 1) : whoIs(a).name.localeCompare(whoIs(b).name, undefined, { sensitivity: "base" }),
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pt-1 pb-4">
      {lobby.isHost && lobby.entries.length > 0 && (
        <Section title="Waiting to join" count={lobby.entries.length}>
          <LobbyRequests lobby={lobby} />
        </Section>
      )}
      <Section title="In the call" count={participants.length}>
        <ul className="flex flex-col gap-0.5">
          {sorted.map((p) => (
            <PersonRow key={p.identity} participant={p} viewerIsGuest={guest} />
          ))}
        </ul>
      </Section>
      {!guest && (
        <AddPeople
          roomName={roomName}
          inCall={participants.map((p) => p.identity)}
          invited={invited}
          onInvited={onInvited}
          focusSearch={focusSearch}
        />
      )}
    </div>
  )
}
