import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { flushSync } from "react-dom"
import { usePreviewTracks } from "@livekit/components-react"
import { Track, VideoPresets, type LocalAudioTrack, type LocalVideoTrack } from "livekit-client"
import { Microphone, MicrophoneSlash, Video, VideoCameraSlash, Warning } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field-error"
import { Input } from "@/components/ui/input"
import { LoadingSpinner, Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { UserAvatar } from "@/components/ui/user-avatar"
import { cn } from "@/lib/utils"
import { avatarOf, guestAvatar } from "./avatar"
import { useNoHover } from "./CallIconButton"
import { DevicePicker } from "./DevicePicker"
import { deviceProblem, isBlocked, loadChoices, saveChoices, type JoinChoices } from "./devices"
import { presenceLine, type Presence } from "./presence"
import { isMac, mediaShortcut, shortcutKeys } from "./shortcuts"

export type GuestIdentity = { name: string }

type AvatarPerson = { id: string; first_name?: string | null; last_name?: string | null; avatar_url?: string | null }

export function PreviewVideo({ track, className }: { track?: LocalVideoTrack; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !track) return
    track.attach(el)
    return () => {
      track.detach(el)
    }
  }, [track])
  return <video ref={ref} muted playsInline autoPlay className={cn("size-full -scale-x-100 object-cover", className)} />
}

function MediaToggle({ on, kind, onToggle }: { on: boolean; kind: "mic" | "camera"; onToggle: () => void }) {
  const noun = kind === "mic" ? "microphone" : "camera"
  const label = on ? `Turn off ${noun}` : `Turn on ${noun}`
  const name = kind === "mic" ? "Microphone" : "Camera"
  const Icon = kind === "mic" ? (on ? Microphone : MicrophoneSlash) : on ? Video : VideoCameraSlash
  const touch = useNoHover()
  const button = (
    <button
      type="button"
      aria-label={name}
      aria-pressed={on}
      onClick={onToggle}
      className={cn(
        "inline-flex size-9 cursor-pointer items-center justify-center rounded-full transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none max-lg:size-11",
        on ? "border border-border bg-card text-foreground hover:bg-app-hover" : "bg-app-berry text-background hover:opacity-90",
      )}
    >
      <Icon aria-hidden="true" className="size-5" />
    </button>
  )
  if (touch) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top">
        {label}
        <span className="ml-2 opacity-70">{shortcutKeys(kind === "mic" ? "D" : "E")}</span>
      </TooltipContent>
    </Tooltip>
  )
}

function PresenceRow({ presence }: { presence: Presence | null }) {
  const shown = presence?.people.slice(0, 3) ?? []
  return (
    <p role="status" className={cn("flex min-h-6 items-center gap-2.5 text-ui text-muted-foreground", !presence && "invisible")}>
      {shown.length > 0 && (
        <span aria-hidden="true" className="flex shrink-0 -space-x-1.5">
          {shown.map((p) => (
            <UserAvatar key={p.userId} user={avatarOf(p.userId, p.name)} size="sm" className="ring-2 ring-background" />
          ))}
        </span>
      )}
      {presence && presenceLine(presence)}
    </p>
  )
}

export function Prejoin({
  title,
  guest = false,
  me,
  presence,
  defaultGuest,
  onJoin,
}: {
  title?: string
  guest?: boolean
  me?: AvatarPerson | null
  /** Who is already in the call, members only. Null while it loads, and undefined hides the row */
  presence?: Presence | null
  defaultGuest?: GuestIdentity
  onJoin: (choices: JoinChoices, guest?: GuestIdentity) => void | Promise<void>
}) {
  const initial = useMemo(loadChoices, [])
  const [audioEnabled, setAudioEnabled] = useState(initial.audioEnabled)
  const [videoEnabled, setVideoEnabled] = useState(initial.videoEnabled)
  const [audioDeviceId, setAudioDeviceId] = useState(initial.audioDeviceId)
  const [videoDeviceId, setVideoDeviceId] = useState(initial.videoDeviceId)
  const [audioError, setAudioError] = useState<unknown>(null)
  const [videoError, setVideoError] = useState<unknown>(null)
  const [granted, setGranted] = useState({ audio: false, video: false })
  const [name, setName] = useState(defaultGuest?.name ?? "")
  const [touched, setTouched] = useState(false)
  const [pending, setPending] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    heading.current?.focus()
  }, [])

  const onAudioError = useCallback((e: Error) => {
    setAudioError(e)
    setAudioEnabled(false)
  }, [])
  const onVideoError = useCallback((e: Error) => {
    setVideoError(e)
    setVideoEnabled(false)
  }, [])

  const audioTracks = usePreviewTracks({ audio: audioEnabled ? { deviceId: audioDeviceId } : false, video: false }, onAudioError)
  const videoTracks = usePreviewTracks(
    {
      audio: false,
      video: videoEnabled ? { deviceId: videoDeviceId, resolution: VideoPresets.h720.resolution } : false,
    },
    onVideoError,
  )
  // The hook keeps the last stopped tracks after a toggle, so only trust them while enabled
  const audioTrack = audioEnabled ? (audioTracks?.find((t) => t.kind === Track.Kind.Audio) as LocalAudioTrack | undefined) : undefined
  const videoTrack = videoEnabled ? (videoTracks?.find((t) => t.kind === Track.Kind.Video) as LocalVideoTrack | undefined) : undefined

  useEffect(() => {
    if (audioTrack) setGranted((g) => (g.audio ? g : { ...g, audio: true }))
  }, [audioTrack])
  useEffect(() => {
    if (videoTrack) setGranted((g) => (g.video ? g : { ...g, video: true }))
  }, [videoTrack])

  const toggleMic = useCallback(() => {
    setAudioError(null)
    setAudioEnabled((v) => !v)
  }, [])
  const toggleCamera = useCallback(() => {
    setVideoError(null)
    setVideoEnabled((v) => !v)
  }, [])

  useEffect(() => {
    const mac = isMac()
    const onKey = (e: KeyboardEvent) => {
      const shortcut = mediaShortcut(e, mac)
      if (!shortcut) return
      e.preventDefault()
      if (e.repeat) return
      if (shortcut === "mic") toggleMic()
      else toggleCamera()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [toggleMic, toggleCamera])

  const problem = deviceProblem(videoError ?? audioError)
  const nameError = name.trim() ? null : "Enter your name"
  const showNameError = guest && touched && nameError
  const cameraStarting = videoEnabled && !videoTrack && !videoError
  const person = guest ? guestAvatar(name) : (me ?? null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitError(null)
    if (guest && nameError) {
      flushSync(() => setTouched(true))
      nameInput.current?.focus()
      return
    }
    // The live device wins, so a saved device that has gone away is replaced
    const choices: JoinChoices = {
      audioEnabled,
      videoEnabled,
      audioDeviceId: audioTrack?.mediaStreamTrack.getSettings().deviceId ?? audioDeviceId,
      videoDeviceId: videoTrack?.mediaStreamTrack.getSettings().deviceId ?? videoDeviceId,
    }
    if (!audioError && !videoError) saveChoices(choices)
    setPending(true)
    try {
      await onJoin(choices, guest ? { name: name.trim() } : undefined)
    } catch (err) {
      setSubmitError(err instanceof Error && err.message ? err.message : "Something went wrong. Try again.")
    } finally {
      setPending(false)
    }
  }

  return (
    <TooltipProvider delayDuration={300}>
      <main className="flex min-h-window justify-center bg-background md:items-center md:p-8">
        <div className="grid w-full max-w-6xl content-start gap-6 md:grid-cols-[minmax(0,46rem)_minmax(16rem,22rem)] md:content-center md:items-center md:justify-center md:gap-10">
          <section aria-label="Preview" className="min-w-0">
            <div className="relative aspect-video overflow-hidden bg-app-sunk md:rounded-xl">
              {videoTrack ? (
                <PreviewVideo track={videoTrack} />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                  {cameraStarting ? (
                    <LoadingSpinner size="lg" />
                  ) : (
                    <>
                      <UserAvatar user={person} size="md" className="size-16 text-title sm:size-20" />
                      <p className="text-ui text-muted-foreground">Camera is off</p>
                    </>
                  )}
                </div>
              )}
              <div className="absolute inset-x-0 bottom-3 flex justify-center gap-3">
                <MediaToggle kind="mic" on={audioEnabled} onToggle={toggleMic} />
                <MediaToggle kind="camera" on={videoEnabled} onToggle={toggleCamera} />
              </div>
            </div>
            <div className="mt-3 grid gap-3 max-md:px-4 sm:grid-cols-2">
              <DevicePicker
                kind="audioinput"
                value={audioDeviceId}
                onChange={setAudioDeviceId}
                track={audioTrack}
                granted={granted.audio}
                blocked={isBlocked(audioError)}
                disabled={!audioEnabled}
              />
              <DevicePicker
                kind="videoinput"
                value={videoDeviceId}
                onChange={setVideoDeviceId}
                track={videoTrack}
                granted={granted.video}
                blocked={isBlocked(videoError)}
                disabled={!videoEnabled}
              />
            </div>
          </section>

          <form onSubmit={submit} noValidate className="flex min-w-0 flex-col gap-6 max-md:px-4 max-md:pb-8">
            <div className="flex flex-col gap-3">
              <div>
                <h1
                  ref={heading}
                  tabIndex={-1}
                  className="text-page leading-[1.1] font-bold tracking-[-0.025em] text-foreground outline-none"
                >
                  {guest ? "Join the meeting" : "Ready to join?"}
                </h1>
                <p className="mt-1.5 line-clamp-2 text-lead text-muted-foreground">
                  {guest ? "Tell the host who you are and they can let you in." : title}
                </p>
              </div>
              {!guest && presence !== undefined && <PresenceRow presence={presence} />}
            </div>

            {guest && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="guest-name" className="text-ui font-medium text-foreground">
                  Your name
                </label>
                <Input
                  id="guest-name"
                  ref={nameInput}
                  autoComplete="name"
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => setTouched(true)}
                  aria-invalid={showNameError ? true : undefined}
                  aria-describedby={showNameError ? "guest-name-error" : undefined}
                />
                {showNameError && (
                  <FieldError id="guest-name-error" className="mt-0">
                    {nameError}
                  </FieldError>
                )}
              </div>
            )}

            <div>
              <div role="status">
                {problem && (
                  <p className="mb-5 flex gap-2 rounded-lg bg-app-sunk px-3 py-2.5 text-ui text-foreground">
                    <span className="flex h-5 shrink-0 items-center">
                      <Warning aria-hidden="true" className="size-4 text-app-berry-text" />
                    </span>
                    <span>{problem}</span>
                  </p>
                )}
              </div>
              <Button type="submit" variant="join" size="lg" disabled={pending} className="w-full">
                {pending && <Spinner className="size-4" />}
                {guest ? "Ask to join" : "Join now"}
              </Button>
              {submitError && (
                <p role="alert" className="mt-2 text-caption text-app-berry-text">
                  {submitError}
                </p>
              )}
              {!guest && me && (
                <p className="mt-2 flex items-center justify-center gap-2 text-caption text-muted-foreground">
                  <UserAvatar user={me} size="xs" />
                  Joining as {[me.first_name, me.last_name].filter(Boolean).join(" ")}
                </p>
              )}
            </div>
          </form>
        </div>
      </main>
    </TooltipProvider>
  )
}
