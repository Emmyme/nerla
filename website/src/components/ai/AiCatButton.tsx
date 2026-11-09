import { useEffect, useState } from "react"
import { useNavigate } from "react-router"
import { IconTip } from "@/components/ui/icon-tip"
import { WINDOW_BUTTON } from "@/components/shell/WindowControls"
import { getAiState, useAiSelect, useAiTeammate, waitingFor } from "@/lib/aiStore"
import { AI_CHAT_PATH, openAiChat } from "@/lib/chatDock"
import { useIsDesktop } from "@/lib/useMediaQuery"
import { cn } from "@/lib/utils"
import { AiFace } from "./AiAvatar"
import { catState, WAKE_MS } from "./aiCat"

// Filled with the background and outlined in pink, drifting up like the away cat's. Still unless the z's are allowed to move
const Z = "sleep-z fill-background stroke-app-bubblegum-strong [paint-order:stroke] [stroke-linejoin:round] font-semibold"

/** The z's keep their place on the face as it grows, `grow` being the face's size against what the z's were drawn for */
function Zs({ grow }: { grow: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      style={{ width: `${grow}rem`, height: `${grow}rem`, right: `${-0.25 * grow}rem`, top: `${-0.5 * grow}rem` }}
      className="pointer-events-none absolute overflow-visible"
    >
      <text x="7" y="11" fontSize="10" strokeWidth="1.4" className={Z}>
        z
      </text>
      <text x="12" y="4" fontSize="8" strokeWidth="1.2" className={cn(Z, "sleep-z-upper")}>
        z
      </text>
    </svg>
  )
}

// Thin pink speed lines beside the cat while it works. Without motion they stay, so the state never rests on movement
const LINE = "stroke-app-bubblegum-strong motion-safe:animate-[ai-line_1.2s_ease-in-out_infinite]"

/** Lines on the left of the cat, or mirrored on its right */
function MotionLines({ size, right = false }: { size: number; right?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 4 16"
      style={{ height: `${size}rem`, width: `${size / 4}rem` }}
      className={cn("shrink-0 overflow-visible", right && "-scale-x-100")}
      fill="none"
      strokeWidth={1.25}
      strokeLinecap="round"
    >
      <line x1={1.5} y1={4.5} x2={3.5} y2={4.5} className={LINE} />
      <line x1={0.5} y1={8} x2={3.5} y2={8} className={cn(LINE, "[animation-delay:-0.4s]")} />
      <line x1={1.75} y1={11.5} x2={3.5} y2={11.5} className={cn(LINE, "[animation-delay:-0.8s]")} />
    </svg>
  )
}

/** Says once that the AI started working, for screen readers */
function useWorkingAnnouncement(running: boolean, name: string): string {
  const [said, setSaid] = useState("")
  useEffect(() => setSaid(running ? `${name} is working` : ""), [running, name])
  return said
}

/** Whether the cat is awake, which lasts a few seconds past the last thing it was waiting on */
function useCatAwake(): { awake: boolean; running: boolean } {
  const windowOpen = useAiSelect((state) => state.viewing > 0)
  const running = useAiSelect((state) => state.running.length > 0)
  const waiting = useAiSelect((state) => waitingFor(state))
  const endedAt = useAiSelect((state) => state.endedAt)
  const [now, setNow] = useState(() => Date.now())
  const busy = windowOpen || running || waiting

  useEffect(() => {
    setNow(Date.now())
    if (busy || endedAt === null) return
    const left = endedAt + WAKE_MS - Date.now()
    if (left <= 0) return
    const timer = setTimeout(() => setNow(Date.now()), left)
    return () => clearTimeout(timer)
  }, [busy, endedAt])

  // A card past its time no longer keeps the cat awake
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => {
      if (!waitingFor(getAiState())) setNow(Date.now())
    }, 30_000)
    return () => clearInterval(timer)
  }, [waiting])

  return { awake: catState({ windowOpen, running, waiting, endedAt, now }) === "awake", running }
}

/**
 * The AI's cat beside the bell. It sleeps until its window opens, a request runs or a card waits, and while it works it
 * bobs with motion lines beside it. A desktop opens the user's DM with it as a docked window and a phone opens it in Messages
 */
export function AiCatButton({ titlebar = false }: { titlebar?: boolean }) {
  const teammate = useAiTeammate()
  const navigate = useNavigate()
  const desktop = useIsDesktop()
  const { awake, running } = useCatAwake()
  const said = useWorkingAnnouncement(running && !!teammate?.available, teammate?.name ?? "")
  if (!teammate?.available) return null

  const label = `Ask ${teammate.name}`
  const size = titlebar ? 1.5 : 2
  const announcer = (
    <span aria-live="polite" className="sr-only">
      {said}
    </span>
  )
  const open = () => {
    if (desktop) openAiChat(navigate)
    else navigate(AI_CHAT_PATH)
  }
  const face = (
    <>
      {running && <MotionLines size={size * 0.75} />}
      <span className={cn("relative flex", running && "motion-safe:animate-[ai-bob_1.2s_ease-in-out_infinite]")}>
        <AiFace size={size} asleep={!awake} className="transition-[filter] duration-150 group-hover:brightness-[0.94]" />
        {!awake && <Zs grow={size / (titlebar ? 1.375 : 1.75)} />}
      </span>
      {running && <MotionLines size={size * 0.75} right />}
    </>
  )

  if (titlebar) {
    return (
      <>
        {announcer}
        <button
          type="button"
          aria-label={label}
          title={label}
          onClick={open}
          className={cn(WINDOW_BUTTON, "group app-region-no-drag relative gap-1 hover:bg-transparent active:bg-transparent")}
        >
          {face}
        </button>
      </>
    )
  }
  return (
    <>
      {announcer}
      <IconTip label={label}>
        <button
          type="button"
          aria-label={label}
          onClick={open}
          className={cn(
            "group relative inline-flex h-10 min-w-10 shrink-0 items-center justify-center gap-1 rounded-full focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:h-11 max-lg:min-w-11",
            running && "px-1.5",
          )}
        >
          {face}
        </button>
      </IconTip>
    </>
  )
}
