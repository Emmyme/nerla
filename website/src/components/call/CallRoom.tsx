import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react"
import { LiveKitRoom, RoomAudioRenderer, useChat, useConnectionState, useLocalParticipant, useRoomContext } from "@livekit/components-react"
import {
  ConnectionError,
  ConnectionState,
  DefaultReconnectPolicy,
  DisconnectReason,
  MediaDeviceFailure,
  Room,
  RoomEvent,
  VideoPresets,
  type ReconnectPolicy,
  type RemoteParticipant,
  type RoomConnectOptions,
} from "livekit-client"
import { isTauri } from "@tauri-apps/api/core"
import { Toaster, toast } from "sonner"
import { useIsDesktop } from "@/lib/useMediaQuery"
import type { PersonResult } from "@/components/projects/PeopleSearch"
import { ShortcutsDialog } from "@/components/shell/ShortcutsDialog"
import { PortalContainer } from "@/components/ui/portal-container"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { TooltipProvider } from "@/components/ui/tooltip"
import { isMeetingWindow, minimizeWindow, setMeetingMini, watchMinimize } from "@/lib/meetingWindow"
import { setPresenceCall } from "@/lib/socket"
import { CallPanel as PanelFrame } from "./CallPanel"
import { CallStage, StageNotices } from "./CallStage"
import { CallTitlebar } from "./CallTitlebar"
import { useShellTitlebar } from "@/components/Titlebar"
import { ChatPanel } from "./ChatPanel"
import { ControlBar, useMediaShortcuts, type CallPanel, type PanelButton } from "./ControlBar"
import { CALL_TOASTER } from "./incoming"
import { useLobby } from "./LobbyRequests"
import { MiniCall } from "./MiniCall"
import { minimizeAction } from "./minimize"
import { PopOutProvider } from "./PopOutWindow"
import { PeoplePanel } from "./PeoplePanel"
import { useCallPapers, useGuestPass, type GuestPass } from "./paperShare"
import { deviceProblem, type JoinChoices } from "./devices"
import { endScreen } from "./endScreen"
import type { StageMode } from "./stage"

// The editors and the live connection load only once the user opens the paper panel
const PaperPanel = lazy(() => import("./PaperPanel"))

class StageErrorBoundary extends Component<{ children: ReactNode; message?: string }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    console.error("Call stage failed:", error)
  }

  render() {
    if (this.state.failed) {
      return (
        <div role="alert" className="flex size-full items-center justify-center p-6 text-center text-body text-app-text-muted">
          {this.props.message ?? "Video failed to load. Rejoin to try again."}
        </div>
      )
    }
    return this.props.children
  }
}

const CONNECT_OPTIONS: RoomConnectOptions = {
  peerConnectionTimeout: 30_000,
  rtcConfig: { iceTransportPolicy: "all" },
}

// Each retry can wait out a 15 second socket timeout, so the default policy keeps a dead call reconnecting for minutes
const RECONNECT_FOR_MS = 30_000
// The browser knows the network is gone well before the reconnect gives up
const OFFLINE_GRACE_MS = 15_000
const retries = new DefaultReconnectPolicy()
const RECONNECT_POLICY: ReconnectPolicy = {
  nextRetryDelayInMs: (context) => (context.elapsedMs > RECONNECT_FOR_MS ? null : retries.nextRetryDelayInMs(context)),
}

const FAILURE_NAMES: Record<MediaDeviceFailure, string> = {
  [MediaDeviceFailure.PermissionDenied]: "NotAllowedError",
  [MediaDeviceFailure.NotFound]: "NotFoundError",
  [MediaDeviceFailure.DeviceInUse]: "NotReadableError",
  [MediaDeviceFailure.Other]: "Error",
}

// Every mic or camera failure lands here, at join and later. A cancelled screen share has no kind and is left to its button.
function reportDeviceFailure(failure?: MediaDeviceFailure, kind?: MediaDeviceKind) {
  if (!kind) return
  toast.error(deviceProblem({ name: FAILURE_NAMES[failure ?? MediaDeviceFailure.Other] }), {
    id: "call-device-problem",
    toasterId: CALL_TOASTER,
  })
}

const TOASTER_STYLE = { fontFamily: "inherit", "--width": "22rem" } as CSSProperties
const TOASTER_OFFSET = { top: "calc(var(--titlebar-h) + 1rem)" }
const TOASTER_MOBILE_OFFSET = { top: "calc(var(--titlebar-h) + 1rem)", left: "1rem", right: "1rem" }
const MINI_OFFSET = { top: "calc(var(--titlebar-h) + 0.5rem)", left: "0.5rem", right: "0.5rem" }

/** Keeps a covered part of the call out of reach of Tab and screen readers */
function useInert(ref: RefObject<HTMLElement>, on: boolean) {
  useLayoutEffect(() => {
    if (ref.current) ref.current.inert = on
  }, [ref, on])
}

type OpenPanel = { kind: CallPanel; opener: PanelButton; focusSearch: number }

/** Mic and camera as they were when the call ended, so a rejoin keeps them */
export type CallMedia = { audioEnabled: boolean; videoEnabled: boolean }

/** Follows the live mic and camera once connected. A connect that never finishes keeps the join choices */
function useLiveMedia(media: MutableRefObject<CallMedia>) {
  const { isMicrophoneEnabled, isCameraEnabled } = useLocalParticipant()
  const connected = useConnectionState() === ConnectionState.Connected
  useEffect(() => {
    if (connected) media.current = { audioEnabled: isMicrophoneEnabled, videoEnabled: isCameraEnabled }
  }, [media, connected, isMicrophoneEnabled, isCameraEnabled])
}

/** Everything inside the room: titlebar, stage, the one side panel and the control bar */
function CallBody({
  title,
  roomName,
  guest,
  guestPass,
  isMini,
  media,
  startedAt,
  onToggleMini,
  onMinimize,
  onLeave,
}: {
  title: string
  roomName: string
  guest: boolean
  guestPass: GuestPass | null
  isMini: boolean
  media: MutableRefObject<CallMedia>
  startedAt?: number
  onToggleMini: () => void
  onMinimize: () => void
  onLeave: () => void
}) {
  const [mode, setMode] = useState<StageMode>("grid")
  const [panel, setPanel] = useState<OpenPanel | null>(null)
  const phone = !useIsDesktop()
  const stage = useRef<HTMLElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  useInert(stage, phone && panel !== null)
  useInert(bar, phone && panel !== null)
  useMediaShortcuts()
  useLiveMedia(media)

  // The mini call has no room for panels, so they close on the way in
  useEffect(() => {
    if (isMini) setPanel(null)
  }, [isMini])
  const [invited, setInvited] = useState<PersonResult[]>([])
  const people = useRef<HTMLButtonElement>(null)
  const chatButton = useRef<HTMLButtonElement>(null)
  const invite = useRef<HTMLButtonElement>(null)
  const paperButton = useRef<HTMLButtonElement>(null)
  const buttons = useMemo(() => ({ people, chat: chatButton, invite, paper: paperButton }), [])
  const current = useRef(panel)
  current.current = panel

  const open = useCallback((kind: CallPanel, opener: PanelButton, focusSearch = 0) => setPanel({ kind, opener, focusSearch }), [])

  // Focus goes back to the button that opened the panel, or to the panel's own button when that one is hidden
  const close = useCallback(() => {
    const was = current.current
    setPanel(null)
    if (!was) return
    requestAnimationFrame(() => {
      buttons[was.opener].current?.focus()
      if (document.activeElement !== buttons[was.opener].current) buttons[was.kind].current?.focus()
      // On a phone the paper panel opens from the more sheet, so focus goes back to that sheet's button
      if (!bar.current?.contains(document.activeElement)) bar.current?.querySelector<HTMLElement>('[aria-label="More options"]')?.focus()
    })
  }, [buttons])

  // Closing from a control bar button leaves focus on that button
  const toggle = useCallback((kind: CallPanel) => (current.current?.kind === kind ? setPanel(null) : open(kind, kind)), [open])
  const view = useCallback(() => open("people", "people"), [open])
  const addPeople = useCallback(() => open("people", "invite", Date.now()), [open])

  // A paper or board shown in the call opens beside the video for everyone, late joiners included
  const pass = useGuestPass(guestPass)
  const [paperFocus, setPaperFocus] = useState<string | null>(null)
  const showPaper = useCallback(
    (shareId: string) => {
      setPaperFocus(shareId)
      open("paper", "paper")
    },
    [open],
  )
  const papers = useCallPapers({ roomName, guest, pass, onShow: showPaper })
  const paperOpen = panel?.kind === "paper"
  // Once open, the paper panel stays mounted while hidden, so its live connection keeps the share in use
  const [paperMounted, setPaperMounted] = useState(false)
  useEffect(() => {
    if (paperOpen) setPaperMounted(true)
  }, [paperOpen])

  // A participant who joins stops being invited, so after leaving they can be invited again
  const room = useRoomContext()
  useEffect(() => {
    const joined = (p: RemoteParticipant) =>
      setInvited((list) => (list.some((x) => x.id === p.identity) ? list.filter((x) => x.id !== p.identity) : list))
    room.on(RoomEvent.ParticipantConnected, joined)
    return () => {
      room.off(RoomEvent.ParticipantConnected, joined)
    }
  }, [room])

  const lobby = useLobby(roomName, { enabled: !guest, quiet: panel?.kind === "people", onView: view })

  const chat = useChat()
  const [readCount, setReadCount] = useState(0)
  const chatOpen = panel?.kind === "chat"
  const total = chat.chatMessages.length
  useEffect(() => {
    if (chatOpen) setReadCount(total)
  }, [chatOpen, total])
  const unread = chatOpen ? 0 : chat.chatMessages.slice(readCount).filter((m) => !m.from?.isLocal).length

  return (
    <PopOutProvider onLeave={onLeave}>
      <CallTitlebar title={title} isMini={isMini} onToggleMini={onToggleMini} onMinimize={onMinimize} onLeave={onLeave} />
      <StageNotices />
      {isMini ? (
        <MiniCall onExpand={onToggleMini} onLeave={onLeave} />
      ) : (
        <>
          <div className="flex min-h-0 flex-1">
            <main ref={stage} className={cn("relative min-w-0 flex-1 lg:px-4", !isTauri() && "lg:pt-4")}>
              <StageErrorBoundary>
                <CallStage mode={mode} />
              </StageErrorBoundary>
            </main>
            {(paperOpen || paperMounted) && (
              <StageErrorBoundary message="Paper couldn't load. It loads after you leave the call and reload.">
                <Suspense
                  fallback={
                    paperOpen && (
                      <PanelFrame title="Paper" onClose={close} wide>
                        <Skeleton className="mx-4 h-[8rem] rounded-lg" />
                      </PanelFrame>
                    )
                  }
                >
                  <PaperPanel
                    title={title}
                    roomName={roomName}
                    papers={papers}
                    focus={paperFocus}
                    onFocus={setPaperFocus}
                    guest={guest}
                    guestPass={guestPass && pass ? { pass, name: guestPass.name } : null}
                    hidden={!paperOpen}
                    onClose={close}
                  />
                </Suspense>
              </StageErrorBoundary>
            )}
            {panel && panel.kind !== "paper" && (
              <PanelFrame key={panel.kind} title={panel.kind === "people" ? "People" : "Chat"} onClose={close}>
                {panel.kind === "people" ? (
                  <PeoplePanel
                    roomName={roomName}
                    guest={guest}
                    lobby={lobby}
                    invited={invited}
                    onInvited={(person) => setInvited((list) => [...list.filter((p) => p.id !== person.id), person])}
                    focusSearch={panel.focusSearch}
                  />
                ) : (
                  <ChatPanel chat={chat} />
                )}
              </PanelFrame>
            )}
          </div>
          <div ref={bar}>
            <ControlBar
              title={title}
              startedAt={startedAt}
              panel={panel?.kind ?? null}
              onTogglePanel={toggle}
              onInvite={addPeople}
              buttons={buttons}
              waiting={lobby.entries.length}
              unread={unread}
              paper={papers.shares.length > 0 ? "shown" : "none"}
              guest={guest}
              phone={phone}
              mode={mode}
              onModeChange={setMode}
              onLeave={onLeave}
            />
          </div>
        </>
      )}
    </PopOutProvider>
  )
}

export function CallRoom({
  token,
  livekitUrl,
  title,
  roomName,
  choices,
  guest = false,
  guestPass,
  onEnd,
}: {
  token: string
  livekitUrl?: string | null
  title?: string
  roomName: string
  choices?: JoinChoices
  guest?: boolean
  /** A guest's proof of being in the call, for the papers shown in it */
  guestPass?: GuestPass
  /** The duration is how long the user was connected, if they ever were */
  onEnd: (reason: DisconnectReason | undefined, left: boolean, media: CallMedia, duration?: number) => void
}) {
  useShellTitlebar()
  const serverUrl = livekitUrl || import.meta.env.VITE_LIVEKIT_URL || "ws://localhost:7880"
  const [stage, setStage] = useState<HTMLDivElement | null>(null)
  const [isMini, setIsMini] = useState(false)
  const mini = useRef(false)
  const left = useRef(false)
  const ended = useRef(false)
  const closing = useRef(false)
  const [startedAt, setStartedAt] = useState<number>()
  const connectedAt = useRef<number>()
  const media = useRef<CallMedia>({ audioEnabled: choices?.audioEnabled ?? false, videoEnabled: choices?.videoEnabled ?? false })

  // The room reads the join choices once and keeps its own devices after that
  const [room] = useState(
    () =>
      new Room({
        adaptiveStream: true,
        dynacast: true,
        reconnectPolicy: RECONNECT_POLICY,
        audioCaptureDefaults: choices?.audioDeviceId ? { deviceId: choices.audioDeviceId } : undefined,
        videoCaptureDefaults: {
          resolution: VideoPresets.h720.resolution,
          ...(choices?.videoDeviceId ? { deviceId: choices.videoDeviceId } : {}),
        },
      }),
  )

  // LiveKitRoom reconnects when its callbacks change identity, so every callback it gets is stable
  const onEndRef = useRef(onEnd)
  onEndRef.current = onEnd
  const end = useCallback(
    (reason?: DisconnectReason) => {
      if (ended.current) return
      ended.current = true
      const leftOnPurpose = left.current || reason === DisconnectReason.CLIENT_INITIATED
      closing.current = endScreen(reason, leftOnPurpose, guest, isMeetingWindow()).close
      onEndRef.current(reason, leftOnPurpose, media.current, connectedAt.current && Date.now() - connectedAt.current)
    },
    [guest],
  )

  // An end screen or a rejoin needs the full window back, unless the window is about to close
  useEffect(
    () => () => {
      if (mini.current && !closing.current) void setMeetingMini(false)
    },
    [],
  )

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const watch = () => {
      clearTimeout(timer)
      if (!navigator.onLine) timer = setTimeout(() => !navigator.onLine && end(), OFFLINE_GRACE_MS)
    }
    watch()
    window.addEventListener("offline", watch)
    window.addEventListener("online", watch)
    return () => {
      clearTimeout(timer)
      window.removeEventListener("offline", watch)
      window.removeEventListener("online", watch)
    }
  }, [end])

  // A connect that fails, the first one included, ends on the connection lost screen. Device problems arrive through reportDeviceFailure
  const reportRoomError = useCallback(
    (err: Error) => {
      console.error("Call error:", err)
      if (err instanceof ConnectionError) end()
      else
        toast.error("Your audio or video didn't start. Turn it off and on again to retry.", {
          id: "call-publish-problem",
          toasterId: CALL_TOASTER,
        })
    },
    [end],
  )

  const initial = useRef(choices).current
  const audio = useMemo(() => (initial?.audioEnabled ? { deviceId: initial.audioDeviceId } : false), [initial])
  const video = useMemo(() => (initial?.videoEnabled ? { deviceId: initial.videoDeviceId } : false), [initial])

  // The clock counts from the first connect, a reconnect keeps it going
  useEffect(() => {
    const connected = () => {
      if (connectedAt.current) return
      connectedAt.current = Date.now()
      setStartedAt(connectedAt.current)
    }
    room.on(RoomEvent.Connected, connected)
    if (room.state === ConnectionState.Connected) connected()
    return () => {
      room.off(RoomEvent.Connected, connected)
    }
  }, [room])

  // Teammates see a member as busy while connected
  useEffect(() => {
    if (guest) return
    const joined = () => setPresenceCall(roomName)
    const gone = () => setPresenceCall(null)
    room.on(RoomEvent.Connected, joined)
    room.on(RoomEvent.Disconnected, gone)
    if (room.state === ConnectionState.Connected) joined()
    return () => {
      room.off(RoomEvent.Connected, joined)
      room.off(RoomEvent.Disconnected, gone)
      gone()
    }
  }, [room, roomName, guest])

  const leave = useCallback(() => {
    left.current = true
    if (room.state === ConnectionState.Disconnected) end(DisconnectReason.CLIENT_INITIATED)
    else void room.disconnect().finally(() => end(DisconnectReason.CLIENT_INITIATED))
  }, [room, end])

  const changeMini = useCallback((next: boolean) => {
    if (mini.current === next) return
    mini.current = next
    setIsMini(next)
    setMeetingMini(next).catch((error) => console.error("Corner window failed:", error))
  }, [])
  const toggleMini = useCallback(() => changeMini(!mini.current), [changeMini])

  // In a desktop meeting window, minimizing a call sends it to the corner. The corner window minimizes for real
  const minimizeTo = useCallback(
    () =>
      minimizeAction({
        inCall: isMeetingWindow() && (room.state === ConnectionState.Connected || room.state === ConnectionState.Reconnecting),
        mini: mini.current,
        tauri: isTauri(),
      }),
    [room],
  )
  const minimize = useCallback(() => {
    if (minimizeTo() === "mini") changeMini(true)
    else minimizeWindow().catch((error) => console.error("Minimize failed:", error))
  }, [minimizeTo, changeMini])
  useEffect(() => watchMinimize(() => minimizeTo() === "mini" && changeMini(true)), [minimizeTo, changeMini])

  return (
    <div
      ref={setStage}
      data-call-stage
      data-theme="nerla"
      data-mode="dark"
      className="fixed inset-0 z-50 flex flex-col bg-app-bg text-app-text scheme-dark"
    >
      <PortalContainer.Provider value={stage}>
        <TooltipProvider delayDuration={300}>
          <Toaster
            id={CALL_TOASTER}
            position="top-center"
            expand
            gap={8}
            offset={isMini ? MINI_OFFSET : TOASTER_OFFSET}
            mobileOffset={isMini ? MINI_OFFSET : TOASTER_MOBILE_OFFSET}
            style={TOASTER_STYLE}
          />
          {/* The call has no shell around it, so a board in it opens the keyboard shortcuts here */}
          <ShortcutsDialog />
          <LiveKitRoom
            room={room}
            token={token}
            serverUrl={serverUrl}
            connect
            audio={audio}
            video={video}
            connectOptions={CONNECT_OPTIONS}
            onDisconnected={end}
            onError={reportRoomError}
            onMediaDeviceFailure={reportDeviceFailure}
            className="flex min-h-0 flex-1 flex-col"
          >
            <CallBody
              title={title || "Meeting"}
              roomName={roomName}
              guest={guest}
              guestPass={guestPass ?? null}
              isMini={isMini}
              media={media}
              startedAt={startedAt}
              onToggleMini={toggleMini}
              onMinimize={minimize}
              onLeave={leave}
            />
            <RoomAudioRenderer />
          </LiveKitRoom>
        </TooltipProvider>
      </PortalContainer.Provider>
    </div>
  )
}
