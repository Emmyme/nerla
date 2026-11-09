import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { JSONContent } from "@tiptap/core"
import { useRoomContext } from "@livekit/components-react"
import { ConnectionState, RoomEvent } from "livekit-client"
import { ApiError } from "@/lib/api/request"
import { meetingsAPI } from "@/lib/api/meetings"
import { papersAPI, type CallShare } from "@/lib/api/papers"
import { formatLongDate } from "@/lib/dates"

/** The data message that tells everyone in the call a paper or board was shown or stopped */
const PAPER_TOPIC = "nerla-paper"

type PaperMessage = { shareId: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const paperMessage = (shareId: string): Uint8Array => new TextEncoder().encode(JSON.stringify({ shareId }))

/** Only a share id is trusted from the room, and only as a hint to read the call's shares again */
export function readPaperMessage(payload: Uint8Array): PaperMessage | null {
  try {
    const data: unknown = JSON.parse(new TextDecoder().decode(payload))
    const shareId = (data as { shareId?: unknown } | null)?.shareId
    return typeof shareId === "string" && UUID.test(shareId) ? { shareId } : null
  } catch {
    return null
  }
}

/** A participant in the call. Members have an id and become mentions, guests are written by name */
type MeetingPerson = { id: string | null; name: string }

/** The Meeting notes layout, laid into an empty paper by the user who made it */
export function meetingNotes(title: string, date: Date, people: MeetingPerson[]): JSONContent[] {
  const joined: JSONContent[] = []
  people.forEach((person, index) => {
    const text = `${index > 0 ? ", " : ""}${person.id ? "" : person.name}`
    const last = joined.at(-1)
    if (text && last?.type === "text") last.text += text
    else if (text) joined.push({ type: "text", text })
    if (person.id) joined.push({ type: "mention", attrs: { id: person.id, label: person.name } })
  })
  const heading = (text: string): JSONContent => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] })
  return [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: title }] },
    { type: "paragraph", content: [{ type: "text", text: formatLongDate(date) }] },
    joined.length ? { type: "paragraph", content: joined } : { type: "paragraph" },
    heading("Agenda"),
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph" }] }] },
    heading("Notes"),
    { type: "paragraph" },
    heading("Action items"),
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph" }] }] },
  ]
}

/** A doc token lasts 10 minutes, so one with 5 or fewer left is swapped for a new one */
const FRESH_FOR_MS = 5 * 60_000
/** The call pass lasts 10 minutes as well, and is renewed well inside that */
const PASS_REFRESH_MS = 5 * 60_000
/** A failed renewal tries again after this, while the pass in hand still holds */
const PASS_RETRY_MS = 30_000

type DocTokenFetch = (shareId: string) => Promise<{ token: string; expiresAt: string }>

/** A guest's doc tokens, one per share, fetched with the call pass when none is fresh enough */
export class GuestDocTokens {
  private held = new Map<string, Promise<{ token: string; until: number }>>()

  constructor(
    private fetch: DocTokenFetch,
    private now: () => number = Date.now,
  ) {}

  async get(shareId: string): Promise<string> {
    const held = this.held.get(shareId)
    if (held) {
      const found = await held.catch(() => null)
      if (found && found.until - this.now() > FRESH_FOR_MS) return found.token
      if (this.held.get(shareId) !== held) return this.get(shareId)
    }
    const next = this.fetch(shareId).then(({ token, expiresAt }) => ({ token, until: Date.parse(expiresAt) }))
    this.held.set(shareId, next)
    next.catch(() => this.held.get(shareId) === next && this.held.delete(shareId))
    return (await next).token
  }
}

/** A guest's proof of being in the call, from the lobby. The pass is renewed while the guest stays */
export type GuestPass = { pass: string; expiresAt: string; name: string }

/** The current call pass, renewed every 5 minutes. A failed renewal is tried again in 30 s while the pass still holds. Null for members */
export function useGuestPass(initial: GuestPass | null): (() => string) | null {
  const held = useRef(initial?.pass ?? "")
  const firstExpiry = useRef(initial?.expiresAt ?? "")
  const guest = !!initial
  useEffect(() => {
    if (!guest) return
    let until = Date.parse(firstExpiry.current)
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const renew = () =>
      meetingsAPI.guestPassRefresh(held.current).then(
        (next) => {
          if (stopped) return
          held.current = next.pass
          until = Date.parse(next.passExpiresAt)
          timer = setTimeout(renew, PASS_REFRESH_MS)
        },
        (err: unknown) => {
          console.error("Call pass refresh failed:", err)
          // A guest who left gets no new pass, and the old one lapses on its own
          if (!stopped && until - Date.now() > PASS_RETRY_MS) timer = setTimeout(renew, PASS_RETRY_MS)
        },
      )
    timer = setTimeout(renew, PASS_REFRESH_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [guest])
  return useMemo(() => (guest ? () => held.current : null), [guest])
}

/** A user who just joined may not count as in the call yet, so the first read tries again after these pauses */
const JOIN_RETRIES_MS = [2000, 5000, 10000]

/**
 * The papers and boards open in this call. Read once on joining and again whenever a participant announces one
 * was shown or stopped, never on a timer. A read asked for while one is out becomes one more read after it, and a
 * reply older than a change made here is dropped. A guest without a call pass reads nothing. `onShow` opens the panel
 */
export function useCallPapers({
  roomName,
  guest,
  pass,
  onShow,
}: {
  roomName: string
  guest: boolean
  pass: (() => string) | null
  onShow: (shareId: string) => void
}) {
  const room = useRoomContext()
  const [shares, setShares] = useState<CallShare[]>([])
  const show = useRef(onShow)
  show.current = onShow
  const passRef = useRef(pass)
  passRef.current = pass
  const canRead = !guest || !!pass
  const inFlight = useRef<Promise<CallShare[] | null> | null>(null)
  const queued = useRef<Promise<CallShare[] | null> | null>(null)
  const version = useRef(0)

  const fetchOnce = useCallback(async (): Promise<CallShare[] | null> => {
    const asked = version.current
    try {
      const found = await papersAPI.callShares(roomName, passRef.current?.())
      if (asked === version.current) setShares(found)
      return found
    } catch (err) {
      if (!(err instanceof ApiError)) console.error("Reading the call's papers failed:", err)
      return null
    }
  }, [roomName])

  const read = useCallback((): Promise<CallShare[] | null> => {
    if (!canRead) return Promise.resolve(null)
    if (!inFlight.current) {
      const started = fetchOnce().finally(() => {
        if (inFlight.current === started) inFlight.current = null
      })
      inFlight.current = started
      return started
    }
    queued.current ??= inFlight.current.then(() => {
      queued.current = null
      return read()
    })
    return queued.current
  }, [canRead, fetchOnce])

  const reload = useCallback(() => void read(), [read])

  useEffect(() => {
    if (!canRead) return
    let stopped = false
    let retry: ReturnType<typeof setTimeout> | undefined
    // A new join, as after connecting again, takes over from any retries still waiting, so one timer runs at most
    let joins = 0
    const joined = async (attempt = 0, join = ++joins) => {
      clearTimeout(retry)
      const found = await read()
      if (stopped || join !== joins) return
      if (found) {
        if (found[0]) show.current(found[0].id)
      } else if (attempt < JOIN_RETRIES_MS.length) {
        retry = setTimeout(() => void joined(attempt + 1, join), JOIN_RETRIES_MS[attempt])
      }
    }
    const onConnected = () => void joined()
    const onData = (payload: Uint8Array, _from?: unknown, _kind?: unknown, topic?: string) => {
      if (topic !== PAPER_TOPIC) return
      const message = readPaperMessage(payload)
      if (!message) return
      void read().then((found) => {
        if (!stopped && found?.some((share) => share.id === message.shareId)) show.current(message.shareId)
      })
    }
    room.on(RoomEvent.Connected, onConnected)
    room.on(RoomEvent.Reconnected, reload)
    room.on(RoomEvent.DataReceived, onData)
    if (room.state === ConnectionState.Connected) void joined()
    return () => {
      stopped = true
      clearTimeout(retry)
      room.off(RoomEvent.Connected, onConnected)
      room.off(RoomEvent.Reconnected, reload)
      room.off(RoomEvent.DataReceived, onData)
    }
  }, [room, canRead, read, reload])

  /** Tells everyone in the call to read the shares again */
  const announce = useCallback(
    (shareId: string) => {
      room.localParticipant
        .publishData(paperMessage(shareId), { reliable: true, topic: PAPER_TOPIC })
        .catch((err) => console.error("Announcing the paper failed:", err))
    },
    [room],
  )

  // A change made here outdates any reply already on its way, so that reply is dropped and one more read follows
  const changed = useCallback(
    (apply: (list: CallShare[]) => CallShare[]) => {
      version.current++
      setShares(apply)
      if (inFlight.current) void read()
    },
    [read],
  )
  const opened = useCallback((share: CallShare) => changed((list) => [...list.filter((s) => s.id !== share.id), share]), [changed])
  const stopped = useCallback((shareId: string) => changed((list) => list.filter((s) => s.id !== shareId)), [changed])

  return { shares, reload, announce, opened, stopped }
}

export type CallPapers = ReturnType<typeof useCallPapers>
