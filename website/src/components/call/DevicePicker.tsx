import { useEffect, useRef, useState } from "react"
import { useMediaDeviceSelect } from "@livekit/components-react"
import type { LocalAudioTrack, LocalVideoTrack } from "livekit-client"
import { Microphone, Video } from "@/components/icons"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { reducedMotion } from "@/lib/motion"
import { cn } from "@/lib/utils"

type Kind = "audioinput" | "videoinput"

const COPY: Record<Kind, { label: string; fallback: string; none: string; blocked: string; permission: string }> = {
  audioinput: {
    label: "Microphone",
    fallback: "Microphone",
    none: "No microphone available",
    blocked: "Microphone blocked",
    permission: "microphone",
  },
  videoinput: { label: "Camera", fallback: "Camera", none: "No camera available", blocked: "Camera blocked", permission: "camera" },
}

/** Whether the browser has the device blocked for this site, kept current when the user changes it */
function usePermissionDenied(kind: Kind) {
  const [denied, setDenied] = useState(false)
  useEffect(() => {
    let status: PermissionStatus | undefined
    let gone = false
    const sync = () => setDenied(status?.state === "denied")
    navigator.permissions
      ?.query({ name: COPY[kind].permission as PermissionName })
      .then((s) => {
        if (gone) return
        status = s
        sync()
        s.addEventListener("change", sync)
      })
      .catch(() => {})
    return () => {
      gone = true
      status?.removeEventListener("change", sync)
    }
  }, [kind])
  return denied
}

export function DevicePicker({
  kind,
  value,
  onChange,
  track,
  granted,
  blocked: blockedByError = false,
  disabled,
  className,
}: {
  kind: Kind
  value?: string
  onChange: (deviceId: string) => void
  track?: LocalAudioTrack | LocalVideoTrack
  granted: boolean
  /** The last try to start the device was refused */
  blocked?: boolean
  disabled?: boolean
  className?: string
}) {
  const { devices } = useMediaDeviceSelect({ kind, requestPermissions: granted })
  const options = devices.filter((d) => d.deviceId)
  const live = track?.mediaStreamTrack.getSettings().deviceId
  const current = [value, live].map((id) => options.find((d) => d.deviceId === id)?.deviceId).find(Boolean) ?? options[0]?.deviceId
  const copy = COPY[kind]
  const Icon = kind === "audioinput" ? Microphone : Video
  const blocked = usePermissionDenied(kind) || blockedByError

  return (
    <div className={cn("min-w-0", className)}>
      <Select value={blocked ? "" : current} onValueChange={onChange} disabled={disabled || blocked || options.length === 0}>
        <SelectTrigger aria-label={copy.label} className="justify-start gap-2 text-left [&>svg:last-child]:ml-auto">
          <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <SelectValue placeholder={blocked ? copy.blocked : options.length === 0 ? copy.none : copy.label} />
        </SelectTrigger>
        <SelectContent>
          {options.map((d, i) => (
            <SelectItem key={d.deviceId} value={d.deviceId}>
              {d.label || `${copy.fallback} ${i + 1}`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {kind === "audioinput" && <MicMeter track={track as LocalAudioTrack | undefined} />}
    </div>
  )
}

function MicMeter({ track }: { track?: LocalAudioTrack }) {
  const bar = useRef<HTMLSpanElement>(null)
  const [reduced] = useState(reducedMotion)

  useEffect(() => {
    const el = bar.current
    const media = track?.mediaStreamTrack
    if (!el || !media || reduced) return
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    const source = ctx.createMediaStreamSource(new MediaStream([media]))
    source.connect(analyser)
    const samples = new Uint8Array(analyser.fftSize)
    let frame = 0
    let level = 0
    const tick = () => {
      analyser.getByteTimeDomainData(samples)
      let sum = 0
      for (const s of samples) sum += ((s - 128) / 128) ** 2
      const target = Math.min(1, Math.sqrt(sum / samples.length) * 5)
      level = target > level ? target : level * 0.85 + target * 0.15
      el.style.transform = `scaleX(${level.toFixed(3)})`
      frame = requestAnimationFrame(tick)
    }
    const resume = () => void ctx.resume().catch(() => {})
    resume()
    window.addEventListener("pointerdown", resume, { once: true })
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("pointerdown", resume)
      source.disconnect()
      void ctx.close().catch(() => {})
      el.style.transform = "scaleX(0)"
    }
  }, [track, reduced])

  if (reduced) return null

  return (
    <span aria-hidden="true" className={cn("mt-2 block h-1 overflow-hidden rounded-full bg-app-sunk", !track && "invisible")}>
      <span ref={bar} style={{ transform: "scaleX(0)" }} className="block h-full origin-left rounded-full bg-app-pistachio-strong" />
    </span>
  )
}
