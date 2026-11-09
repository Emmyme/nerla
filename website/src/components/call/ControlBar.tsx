import { useCallback, useEffect, useState, type RefObject } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { TrackToggle, useLocalParticipant, useParticipants, useRoomContext } from "@livekit/components-react"
import { Track, type LocalAudioTrack, type LocalVideoTrack } from "livekit-client"
import { toast } from "sonner"
import {
  ChatCircleDots,
  Ellipsis,
  Microphone,
  MicrophoneSlash,
  Paper,
  PhoneDisconnect,
  PictureInPicture,
  Screencast,
  SquaresFour,
  UserFocus,
  UserPlus,
  UsersThree,
  Video,
  VideoCameraSlash,
} from "@/components/icons"
import { POPOVER_SURFACE, useAnchoredPosition } from "@/components/ui/anchored-popover"
import { usePortalContainer } from "@/components/ui/portal-container"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { UnreadDot } from "@/components/ui/unread-dot"
import { FADE_MOTION, SHEET_MOTION } from "@/lib/motion"
import { formatElapsed } from "@/lib/dates"
import { cn, keepToasts } from "@/lib/utils"
import { CALL_FOCUS, CallIconButton, useNoHover } from "./CallIconButton"
import { DevicePicker } from "./DevicePicker"
import { deviceProblem, loadChoices, saveChoices } from "./devices"
import { CALL_TOASTER } from "./incoming"
import { usePopOut } from "./pip"
import { isMac, mediaShortcut, shortcutKeys } from "./shortcuts"
import type { StageMode } from "./stage"

export type CallPanel = "people" | "chat" | "paper"
export type PanelButton = CallPanel | "invite"

function CountBadge({ count, className }: { count: number; className: string }) {
  if (count <= 0) return null
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute -top-0.5 -right-0.5 flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1 text-micro leading-none font-medium tabular-nums ring-2 ring-app-bg",
        className,
      )}
    >
      {count > 9 ? "9+" : count}
    </span>
  )
}

// The room's onMediaDeviceFailure already shows the copy for mic and camera failures
function reportDeviceError(error: unknown) {
  console.error("Device toggle failed:", error)
}

/** Mounted once for the whole call, so the shortcuts also work in the mini call. A pop out window mounts its own */
export function useMediaShortcuts(target?: Window) {
  const { localParticipant } = useLocalParticipant()
  useEffect(() => {
    const mac = isMac()
    const onKey = (e: KeyboardEvent) => {
      const shortcut = mediaShortcut(e, mac)
      if (!shortcut) return
      e.preventDefault()
      if (e.repeat) return
      const toggle =
        shortcut === "mic"
          ? localParticipant.setMicrophoneEnabled(!localParticipant.isMicrophoneEnabled)
          : localParticipant.setCameraEnabled(!localParticipant.isCameraEnabled)
      toggle.catch(reportDeviceError)
    }
    const view = target ?? window
    view.addEventListener("keydown", onKey)
    return () => view.removeEventListener("keydown", onKey)
  }, [localParticipant, target])
}

type ToggleProps = { className?: string; side?: "top" | "bottom" }

export function MicToggle({ className, side }: ToggleProps) {
  const { isMicrophoneEnabled } = useLocalParticipant()
  return (
    <CallIconButton
      asChild
      label="Microphone"
      tip={isMicrophoneEnabled ? "Turn off microphone" : "Turn on microphone"}
      tone={isMicrophoneEnabled ? "idle" : "off"}
      shortcut={shortcutKeys("D")}
      side={side}
      className={className}
    >
      <TrackToggle source={Track.Source.Microphone} showIcon={false} onDeviceError={reportDeviceError}>
        {isMicrophoneEnabled ? <Microphone aria-hidden="true" /> : <MicrophoneSlash aria-hidden="true" />}
      </TrackToggle>
    </CallIconButton>
  )
}

export function CameraToggle({ className, side }: ToggleProps) {
  const { isCameraEnabled } = useLocalParticipant()
  return (
    <CallIconButton
      asChild
      label="Camera"
      tip={isCameraEnabled ? "Turn off camera" : "Turn on camera"}
      tone={isCameraEnabled ? "idle" : "off"}
      shortcut={shortcutKeys("E")}
      side={side}
      className={className}
    >
      <TrackToggle source={Track.Source.Camera} showIcon={false} onDeviceError={reportDeviceError}>
        {isCameraEnabled ? <Video aria-hidden="true" /> : <VideoCameraSlash aria-hidden="true" />}
      </TrackToggle>
    </CallIconButton>
  )
}

const SHARE_OPTIONS = { audio: true, selfBrowserSurface: "include" } as const

function reportShareError(err: Error) {
  if (err.name !== "NotAllowedError") toast.error("Your screen couldn't be shared. Try again.", { toasterId: CALL_TOASTER })
}

function canShareScreen() {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function"
}

const MENU_ROW = cn(
  "flex h-11 w-full cursor-pointer items-center gap-3 rounded-md px-2.5 text-ui font-medium text-foreground transition-colors duration-150 hover:bg-app-hover disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-5 [&_svg]:shrink-0",
  "aria-pressed:bg-app-sky aria-pressed:text-app-sky-ink aria-pressed:hover:bg-app-sky/90",
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
)

/** On phones the bar keeps the essentials, and the rest of the controls live in the more sheet */
function PhoneRows({
  guest,
  onInvite,
  onPaper,
  onClose,
}: {
  guest: boolean
  onInvite: () => void
  onPaper?: () => void
  onClose: () => void
}) {
  const { isScreenShareEnabled } = useLocalParticipant()
  return (
    <div className="flex flex-col gap-0.5">
      {canShareScreen() && (
        <TrackToggle
          source={Track.Source.ScreenShare}
          showIcon={false}
          captureOptions={SHARE_OPTIONS}
          onDeviceError={reportShareError}
          className={MENU_ROW}
        >
          <Screencast aria-hidden="true" />
          {isScreenShareEnabled ? "Stop presenting" : "Present your screen"}
        </TrackToggle>
      )}
      {onPaper && (
        <button type="button" onClick={onPaper} className={MENU_ROW}>
          <Paper aria-hidden="true" />
          Paper
        </button>
      )}
      {!guest && (
        <button type="button" onClick={onInvite} className={MENU_ROW}>
          <UserPlus aria-hidden="true" />
          Add people
        </button>
      )}
      <PopOutRow onDone={onClose} />
    </div>
  )
}

function PopOutRow({ onDone }: { onDone: () => void }) {
  const popOut = usePopOut()
  if (!popOut.available) return null
  return (
    <button
      type="button"
      onClick={() => {
        popOut.toggle()
        onDone()
      }}
      className={cn(MENU_ROW, "lg:h-8")}
    >
      <PictureInPicture aria-hidden="true" />
      {popOut.open ? "Close the pop out" : "Pop out"}
    </button>
  )
}

/** Floats the call over other tabs and apps, in the bar on desktop */
function PopOutButton() {
  const popOut = usePopOut()
  if (!popOut.available) return null
  return (
    <CallIconButton
      label="Pop out"
      tip={popOut.open ? "Close the pop out" : "Pop out the call"}
      pressed={popOut.open}
      tone={popOut.open ? "active" : "idle"}
      onClick={popOut.toggle}
    >
      <PictureInPicture aria-hidden="true" />
    </CallIconButton>
  )
}

const LAYOUTS = [
  { value: "grid" as const, label: "Grid", icon: <SquaresFour aria-hidden="true" className="size-4" /> },
  { value: "speaker" as const, label: "Speaker", icon: <UserFocus aria-hidden="true" className="size-4" /> },
]

// Phones get a bottom sheet over a scrim, like the full-screen people and chat sheets
const SHEET = `fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col gap-4 overflow-y-auto rounded-t-xl bg-app-surface px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-app-text outline-none ${SHEET_MOTION.bottom}`

function MoreMenu({
  mode,
  onModeChange,
  phone,
  guest,
  onInvite,
  onPaper,
}: {
  mode: StageMode
  onModeChange: (mode: StageMode) => void
  phone: boolean
  guest: boolean
  onInvite: () => void
  onPaper?: () => void
}) {
  const [open, setOpen] = useState(false)
  const { anchorRef, contentRef, style } = useAnchoredPosition(open)
  const container = usePortalContainer()
  const room = useRoomContext()
  const { microphoneTrack, cameraTrack } = useLocalParticipant()
  const [audioId, setAudioId] = useState(() => room.getActiveDevice("audioinput"))
  const [videoId, setVideoId] = useState(() => room.getActiveDevice("videoinput"))

  const switchDevice = useCallback(
    async (kind: "audioinput" | "videoinput", deviceId: string) => {
      const set = kind === "audioinput" ? setAudioId : setVideoId
      set(deviceId)
      try {
        await room.switchActiveDevice(kind, deviceId)
        saveChoices({ ...loadChoices(), [kind === "audioinput" ? "audioDeviceId" : "videoDeviceId"]: deviceId })
      } catch (err) {
        console.error("Device switch failed:", err)
        toast.error(deviceProblem(err) ?? "That device didn't start. Pick another one.", { toasterId: CALL_TOASTER })
      }
    },
    [room],
  )

  return (
    <Dialog.Root open={open} onOpenChange={setOpen} modal={phone}>
      <Dialog.Trigger asChild>
        <CallIconButton ref={anchorRef} label="More options" tone={open ? "active" : "idle"}>
          <Ellipsis aria-hidden="true" weight="bold" />
        </CallIconButton>
      </Dialog.Trigger>
      <Dialog.Portal container={container}>
        {phone && <Dialog.Overlay className={`fixed inset-0 z-50 bg-app-scrim ${FADE_MOTION}`} />}
        <Dialog.Content
          onInteractOutside={keepToasts}
          ref={contentRef}
          style={phone ? undefined : style}
          aria-describedby={undefined}
          className={phone ? SHEET : cn("fixed z-50 flex w-[min(20rem,calc(100vw-1rem))] flex-col gap-4 p-4", POPOVER_SURFACE)}
        >
          <Dialog.Title className={cn("font-semibold text-foreground", phone ? "text-title" : "text-body")}>More options</Dialog.Title>
          {phone && (
            <PhoneRows
              guest={guest}
              onInvite={() => {
                setOpen(false)
                onInvite()
              }}
              onPaper={
                onPaper &&
                (() => {
                  setOpen(false)
                  onPaper()
                })
              }
              onClose={() => setOpen(false)}
            />
          )}
          {!phone && (
            <div className="-mx-2.5 empty:hidden">
              <PopOutRow onDone={() => setOpen(false)} />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <p className="text-caption font-medium text-muted-foreground">Layout</p>
            <SegmentedControl label="Layout" value={mode} onChange={onModeChange} options={LAYOUTS} className="self-start" />
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="text-caption font-medium text-muted-foreground">Microphone</p>
            <DevicePicker
              kind="audioinput"
              value={audioId}
              onChange={(id) => void switchDevice("audioinput", id)}
              track={microphoneTrack?.track as LocalAudioTrack | undefined}
              granted={Boolean(microphoneTrack?.track)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="text-caption font-medium text-muted-foreground">Camera</p>
            <DevicePicker
              kind="videoinput"
              value={videoId}
              onChange={(id) => void switchDevice("videoinput", id)}
              track={cameraTrack?.track as LocalVideoTrack | undefined}
              granted={Boolean(cameraTrack?.track)}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function LeaveButton({ onLeave }: { onLeave: () => void }) {
  const touch = useNoHover()
  const button = (
    <button
      type="button"
      onClick={onLeave}
      className={cn(
        "inline-flex h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full bg-app-text px-3 text-ui font-medium text-app-bg transition-colors duration-150 hover:bg-app-text/85 sm:ml-1 sm:px-5 [&_svg]:size-5",
        CALL_FOCUS,
      )}
    >
      <PhoneDisconnect aria-hidden="true" weight="fill" />
      <span className="max-sm:sr-only">Leave</span>
    </button>
  )
  if (touch) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top">Leave call</TooltipContent>
    </Tooltip>
  )
}

/** Ticks once a second, on its own so the bar doesn't re-render */
function CallClock({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <span>{formatElapsed(now - since)}</span>
}

function HeadCount() {
  const count = useParticipants().length
  return (
    <span className="flex items-center gap-1">
      <UsersThree aria-hidden="true" className="size-3.5" />
      {count}
      <span className="sr-only">{count === 1 ? "person" : "people"} in the call</span>
    </span>
  )
}

/** The call's name, how long the user has been in it and who is here, in the bar's left column */
function CallInfo({ title, startedAt }: { title: string; startedAt?: number }) {
  return (
    <div className="min-w-0">
      <h1 className="truncate text-ui font-medium tracking-normal text-app-text">{title}</h1>
      <p className="flex items-center gap-2.5 text-caption text-app-text-muted tabular-nums">
        {startedAt !== undefined && <CallClock since={startedAt} />}
        <HeadCount />
      </p>
    </div>
  )
}

/** The calm row of call controls under the stage. Phones get one row of essentials, with the rest under more */
export function ControlBar({
  title,
  startedAt,
  panel,
  onTogglePanel,
  onInvite,
  buttons,
  waiting = 0,
  unread = 0,
  paper = "none",
  guest = false,
  phone = false,
  mode,
  onModeChange,
  onLeave,
}: {
  title: string
  /** When the user connected, for the call clock */
  startedAt?: number
  panel: CallPanel | null
  onTogglePanel: (panel: CallPanel) => void
  onInvite: () => void
  buttons: Record<PanelButton, RefObject<HTMLButtonElement>>
  /** Guests asking to join, shown on the people button while its panel is closed */
  waiting?: number
  /** Chat messages from others since the chat panel was last open */
  unread?: number
  /** Whether a paper or board is open in the call. Guests only get the button then */
  paper?: "none" | "shown"
  guest?: boolean
  phone?: boolean
  mode: StageMode
  onModeChange: (mode: StageMode) => void
  onLeave: () => void
}) {
  const { isScreenShareEnabled } = useLocalParticipant()
  const waitingShown = panel === "people" ? 0 : waiting
  const unreadShown = panel === "chat" ? 0 : unread
  const paperButton = !guest || paper === "shown"
  const more = (
    <MoreMenu
      mode={mode}
      onModeChange={onModeChange}
      phone={phone}
      guest={guest}
      onInvite={onInvite}
      onPaper={paperButton ? () => onTogglePanel("paper") : undefined}
    />
  )
  const panelButtons = (
    <>
      <CallIconButton
        ref={buttons.people}
        label={waitingShown ? `People, ${waitingShown} waiting to join` : "People"}
        tip="People"
        pressed={panel === "people"}
        tone={panel === "people" ? "active" : "idle"}
        onClick={() => onTogglePanel("people")}
        className="relative"
      >
        <UsersThree aria-hidden="true" />
        <CountBadge count={waitingShown} className="bg-app-berry text-app-bg" />
      </CallIconButton>
      <CallIconButton
        ref={buttons.chat}
        label={unreadShown ? `Chat, ${unreadShown} unread` : "Chat"}
        tip="Chat"
        pressed={panel === "chat"}
        tone={panel === "chat" ? "active" : "idle"}
        onClick={() => onTogglePanel("chat")}
        className="relative"
      >
        <ChatCircleDots aria-hidden="true" />
        {unreadShown > 0 && <UnreadDot className="pointer-events-none absolute top-1 right-1 rounded-full ring-2 ring-app-bg" />}
      </CallIconButton>
      {paperButton && !phone && (
        <CallIconButton
          ref={buttons.paper}
          label={paper === "shown" && panel !== "paper" ? "Paper, one is open in the call" : "Paper"}
          tip="Paper"
          pressed={panel === "paper"}
          tone={panel === "paper" ? "active" : "idle"}
          onClick={() => onTogglePanel("paper")}
          className="relative"
        >
          <Paper aria-hidden="true" />
          {paper === "shown" && panel !== "paper" && (
            <UnreadDot className="pointer-events-none absolute top-1 right-1 rounded-full ring-2 ring-app-bg" />
          )}
        </CallIconButton>
      )}
    </>
  )

  if (phone) {
    return (
      <div className="flex shrink-0 items-center justify-center px-2 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-3">
        <h1 className="sr-only">{title}</h1>
        <div role="group" aria-label="Call controls" className="flex items-center gap-1.5 sm:gap-2">
          <MicToggle />
          <CameraToggle />
          {panelButtons}
          {more}
          <LeaveButton onLeave={onLeave} />
        </div>
      </div>
    )
  }

  return (
    <div className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 px-4 pt-2 pb-4">
      <CallInfo title={title} startedAt={startedAt} />
      <div role="group" aria-label="Call controls" className="flex items-center gap-2">
        <MicToggle />
        <CameraToggle />
        {canShareScreen() && (
          <CallIconButton
            asChild
            label="Present your screen"
            tip={isScreenShareEnabled ? "Stop presenting" : "Present your screen"}
            tone={isScreenShareEnabled ? "active" : "idle"}
          >
            <TrackToggle source={Track.Source.ScreenShare} showIcon={false} captureOptions={SHARE_OPTIONS} onDeviceError={reportShareError}>
              <Screencast aria-hidden="true" />
            </TrackToggle>
          </CallIconButton>
        )}
        {more}
        <LeaveButton onLeave={onLeave} />
      </div>
      <div className="flex items-center justify-end gap-2">
        <PopOutButton />
        {!guest && (
          <CallIconButton ref={buttons.invite} label="Add people" onClick={onInvite}>
            <UserPlus aria-hidden="true" />
          </CallIconButton>
        )}
        {panelButtons}
      </div>
    </div>
  )
}
