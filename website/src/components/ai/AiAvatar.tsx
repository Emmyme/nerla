import { useId } from "react"
import { Cat } from "@/components/ui/cat-scenes"
import { LOGO_W } from "@/components/ui/cat-scene-layout"
import { useAiTeammate } from "@/lib/aiStore"
import { useAvatarSrc } from "@/lib/useAvatarSrc"
import { cn } from "@/lib/utils"

const BODY = "M27 108C27 88 38 79 50 79C62 79 73 88 73 108Z"
const HEAD_SCALE = 0.123

// Soft pink in light mode and the raised grey in dark, which also rings the head and fills its cutouts
const DISC = "[--ai-disc:var(--color-bubblegum-soft)] dark:[--ai-disc:var(--color-surface-raised)] [--cat-ring:var(--ai-disc)]"

/** The AI's face: the uploaded image, or the logo cat's head and shoulders in a circle. `size` is in rem */
export function AiAvatar({
  size,
  asleep = false,
  src,
  className,
}: {
  size: number
  asleep?: boolean
  src?: string | null
  className?: string
}) {
  const id = useId().replace(/:/g, "")
  const box = { width: `${size}rem`, height: `${size}rem` }
  if (src)
    return <img src={src} alt="" aria-hidden="true" style={box} className={cn("block shrink-0 rounded-full object-cover", className)} />
  return (
    <svg aria-hidden="true" viewBox="0 0 100 100" style={box} className={cn("block shrink-0", DISC, className)}>
      <clipPath id={`${id}-disc`}>
        <circle cx={50} cy={50} r={50} />
      </clipPath>
      <g clipPath={`url(#${id}-disc)`}>
        <rect width={100} height={100} className="fill-[var(--ai-disc)]" />
        <path d={BODY} className="fill-app-bubblegum" />
        <g transform={asleep ? "rotate(-8 50 48)" : undefined}>
          <Cat x={16} y={17} width={LOGO_W * HEAD_SCALE} eyes={asleep ? "shut" : "open"} />
        </g>
      </g>
    </svg>
  )
}

/** The workspace's AI as it looks right now, its uploaded image or the cat */
export function AiFace({ size, asleep, className }: { size: number; asleep?: boolean; className?: string }) {
  const teammate = useAiTeammate()
  const src = useAvatarSrc(teammate?.avatarUrl)
  return <AiAvatar size={size} asleep={asleep} src={teammate?.avatarUrl ? src : null} className={className} />
}

/** The small badge beside the AI's name */
export function AiBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded-sm bg-app-lavender px-1 text-micro leading-none font-semibold text-app-lavender-ink",
        className,
      )}
    >
      AI
    </span>
  )
}
