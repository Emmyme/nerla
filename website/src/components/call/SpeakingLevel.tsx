import { useEffect, type RefObject } from "react"
import { Track, createAudioAnalyser, type Participant } from "livekit-client"
import { reducedMotion } from "@/lib/motion"
import { cn } from "@/lib/utils"

/** Writes how loud a participant is, 0 to 1, to the element's --level while they speak, so nothing re-renders */
export function useLevelVar(ref: RefObject<HTMLElement | null>, participant: Participant, speaking: boolean) {
  useEffect(() => {
    const el = ref.current
    if (!el || !speaking) return
    const done = () => el.style.removeProperty("--level")
    if (reducedMotion()) {
      el.style.setProperty("--level", "0.6")
      return done
    }
    const track = participant.getTrackPublication(Track.Source.Microphone)?.audioTrack
    let analyser: ReturnType<typeof createAudioAnalyser> | undefined
    try {
      analyser = track ? createAudioAnalyser(track, { fftSize: 32, smoothingTimeConstant: 0 }) : undefined
    } catch {
      analyser = undefined
    }
    let level = 0
    // The server's level covers a suspended audio context
    const timer = setInterval(() => {
      const target = Math.min(1, Math.max(analyser?.calculateVolume() ?? 0, participant.audioLevel) * 2.5)
      level = target > level ? target : level * 0.6 + target * 0.4
      el.style.setProperty("--level", level.toFixed(2))
    }, 80)
    return () => {
      clearInterval(timer)
      void analyser?.cleanup().catch(() => {})
      done()
    }
  }, [ref, participant, speaking])
}

const PEAKS = [0.55, 1, 0.75]

/** Three pistachio bars that follow the nearest --level, static when motion is reduced */
export function SpeakingBars({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn("inline-flex h-3 shrink-0 items-center gap-0.5", className)}>
      {PEAKS.map((peak) => (
        <span
          key={peak}
          className="h-full w-0.75 rounded-full bg-app-pistachio transition-transform duration-100 ease-out"
          style={{ transform: `scaleY(calc(0.3 + var(--level, 0.5) * ${peak * 0.7}))` }}
        />
      ))}
    </span>
  )
}
