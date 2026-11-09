import { useEffect, useId, useState, type CSSProperties } from "react"
import catLogo from "@/assets/cat-logo.png"
import { HandPalm, Sunglasses } from "@/components/icons"
import { EAR_HOLES, LOGO_H, LOGO_W, NOSE, SHUT_EYES } from "@/components/ui/cat-scene-layout"
import type { PresenceState } from "@/lib/presence"
import { cn } from "@/lib/utils"

export type PresenceCatSize = "xs" | "sm" | "compact" | "md" | "base" | "lg" | "xl" | "2xl"

const BOX: Record<PresenceCatSize, string> = {
  xs: "size-[0.625rem]",
  sm: "size-[0.625rem]",
  compact: "size-3",
  md: "size-3",
  base: "size-4",
  lg: "size-5",
  xl: "size-6",
  "2xl": "size-8",
}

const FILL: Record<PresenceState, string> = {
  available: "bg-app-pistachio-strong",
  busy: "bg-app-berry",
  dnd: "bg-app-berry",
  away: "bg-app-lemon-strong",
  ooo: "bg-app-lavender-strong",
  secret: "bg-app-sky-strong",
  offline: "bg-muted-foreground opacity-75",
}

// The cutout takes the fill behind the avatar, which rows and cards set as --row-fill
const RING = "[--cat-ring:var(--row-fill,var(--color-surface))]"

const masked = (url: string): CSSProperties => ({
  maskImage: `url(${url})`,
  WebkitMaskImage: `url(${url})`,
  maskSize: "contain",
  WebkitMaskSize: "contain",
  maskRepeat: "no-repeat",
  WebkitMaskRepeat: "no-repeat",
  maskPosition: "center",
  WebkitMaskPosition: "center",
})

let solidUrl: string | null = null
let solidLoad: Promise<string> | null = null

/** The logo with its eyes, nose and ears filled in, so the cutout behind the cat has no holes */
export function loadSolidCat(): Promise<string> {
  solidLoad ??= new Promise<string>((resolve) => {
    const image = new Image()
    image.onerror = () => resolve(catLogo)
    image.onload = () => {
      try {
        const { naturalWidth: w, naturalHeight: h } = image
        const canvas = document.createElement("canvas")
        canvas.width = w
        canvas.height = h
        const context = canvas.getContext("2d")
        if (!context) return resolve(catLogo)
        context.drawImage(image, 0, 0)
        const pixels = context.getImageData(0, 0, w, h)
        const alpha = (i: number) => pixels.data[i * 4 + 3]
        const outside = new Uint8Array(w * h)
        const stack: number[] = []
        for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x)
        for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1)
        while (stack.length) {
          const i = stack.pop()!
          if (outside[i] || alpha(i) >= 128) continue
          outside[i] = 1
          const x = i % w
          if (x > 0) stack.push(i - 1)
          if (x < w - 1) stack.push(i + 1)
          if (i >= w) stack.push(i - w)
          if (i < w * (h - 1)) stack.push(i + w)
        }
        for (let i = 0; i < w * h; i++) if (!outside[i]) pixels.data[i * 4 + 3] = 255
        context.putImageData(pixels, 0, 0)
        resolve(canvas.toDataURL())
      } catch {
        resolve(catLogo)
      }
    }
    image.src = catLogo
  }).then((loaded) => (solidUrl = loaded))
  return solidLoad
}

export function useSolidCat(): string {
  const [url, setUrl] = useState(solidUrl)
  useEffect(() => {
    if (url) return
    let live = true
    void loadSolidCat().then((loaded) => {
      solidUrl = loaded
      if (live) setUrl(loaded)
    })
    return () => {
      live = false
    }
  }, [url])
  return url ?? catLogo
}

// The out of office hat and its pom-pom strands, and the busy headset, each path used twice
const HAT = "M33 25L57 -18L69 21Q51 30 33 25Z"
const POM_POM =
  "M59.6 -20.5L66.0 -19.4M58.8 -19.1L61.9 -16.0M57.4 -18.4L58.4 -11.3M55.8 -18.7L53.4 -14.2M54.7 -19.9L48.4 -16.8M54.4 -21.5L50.4 -22.2M55.2 -22.9L51.0 -27.2M56.6 -23.6L55.9 -28.5M58.2 -23.3L61.7 -29.9M59.3 -22.1L63.5 -24.2"
const HEADSET = "M8 55C8 6 92 6 92 55M95 67C95 82 82 86 68 85"

const Z = "sleep-z fill-[var(--cat-ring)] stroke-[var(--color-app-lemon-strong)] [paint-order:stroke] [stroke-linejoin:round] font-semibold"

/**
 * The Nerla cat recoloured for a presence state, with a little extra per state so it never relies on colour. Its
 * masked fills would be blanked in high contrast, so it keeps its own colours there
 */
export function PresenceCat({ state, size = "md", className }: { state: PresenceState; size?: PresenceCatSize; className?: string }) {
  const solid = useSolidCat()
  const hatClip = useId()
  const tiny = size === "xs" || size === "sm"
  return (
    <span aria-hidden="true" className={cn("relative inline-block shrink-0 forced-color-adjust-none", RING, BOX[size], className)}>
      <span className="absolute -inset-[0.125rem] bg-[var(--cat-ring)]" style={masked(solid)} />
      {state === "offline" ? (
        // An outline cat: the solid shape in grey, then the logo in the background colour a little smaller on top,
        // so the rim, eyes, nose and ears show grey
        <>
          <span className={cn("absolute inset-0", FILL.offline)} style={masked(solid)} />
          <span className={cn("absolute bg-[var(--cat-ring)]", tiny ? "inset-[12%]" : "inset-[6.5%]")} style={masked(catLogo)} />
        </>
      ) : (
        <span className={cn("absolute inset-0", FILL[state])} style={masked(state === "away" ? solid : catLogo)} />
      )}
      {state === "away" && (
        // Asleep: the solid silhouette has no eye holes, so the ears, nose and shut eyes are painted back in the cutout colour
        <svg viewBox={`0 0 ${LOGO_W} ${LOGO_H}`} className="absolute inset-0 size-full overflow-visible">
          <path d={EAR_HOLES} className="fill-[var(--cat-ring)]" />
          <ellipse {...NOSE} className="fill-[var(--cat-ring)]" />
          <path d={SHUT_EYES} fill="none" strokeWidth={tiny ? 44 : 30} strokeLinecap="round" className="stroke-[var(--cat-ring)]" />
        </svg>
      )}
      {state === "dnd" && (
        <HandPalm
          weight="fill"
          strokeWidth={tiny ? 20 : 16}
          className={cn(
            "absolute stroke-[var(--color-app-berry)] text-[var(--cat-ring)] [paint-order:stroke]",
            tiny ? "top-[10%] left-[6%] size-[88%]" : "top-[34%] -left-[12%] size-[66%]",
          )}
        />
      )}
      {state === "ooo" && (
        // A party hat tilted on the cat's head, white with stripes and a pom-pom in the cat's colour
        <svg viewBox="0 0 100 100" className="absolute inset-0 size-full overflow-visible">
          <clipPath id={hatClip}>
            <path d={HAT} />
          </clipPath>
          <path
            d={HAT}
            strokeWidth={tiny ? 7 : 5}
            strokeLinejoin="round"
            className="fill-[var(--cat-ring)] stroke-app-lavender-strong [paint-order:stroke]"
          />
          <g clipPath={`url(#${hatClip})`} strokeWidth={6} className="stroke-app-lavender-strong">
            <path d="M30 14L80 -6M24 30L80 8" />
          </g>
          {/* A tufty pom-pom: uneven strands bursting from a small centre, outlined in the background colour */}
          <g fill="none" strokeLinecap="round">
            <path d={POM_POM} strokeWidth={7.5} className="stroke-[var(--cat-ring)]" />
            <path d={POM_POM} strokeWidth={3.4} className="stroke-app-lavender-strong" />
          </g>
          <circle cx="57" cy="-21" r="5" className="fill-app-lavender-strong" />
        </svg>
      )}
      {state === "busy" && (
        // A headset drawn around the cat like the hand on do not disturb: the background colour outlined in the cat's
        // colour, with a slim band over its head, cups at its cheeks and a mic towards its mouth
        <svg viewBox="0 0 100 100" className="absolute inset-0 size-full overflow-visible">
          <path d={HEADSET} fill="none" strokeWidth={9} strokeLinecap="round" className="stroke-app-berry" />
          <path d={HEADSET} fill="none" strokeWidth={4.5} strokeLinecap="round" className="stroke-[var(--cat-ring)]" />
          <g className="fill-[var(--cat-ring)] stroke-app-berry [paint-order:stroke]" strokeWidth={4.5}>
            <rect x="-3" y="48" width="13" height="22" rx="6" />
            <rect x="90" y="48" width="13" height="22" rx="6" />
          </g>
        </svg>
      )}
      {state === "secret" && (
        <Sunglasses
          weight="fill"
          strokeWidth={tiny ? 18 : 14}
          className={cn(
            "absolute stroke-[var(--color-app-sky-strong)] text-[var(--cat-ring)] [clip-path:inset(45%_0_0_0)] [paint-order:stroke]",
            tiny ? "-top-[28%] -left-[8%] size-[116%]" : "-top-[19%] -left-[2%] size-[104%]",
          )}
        />
      )}
      {state === "away" && (
        <svg viewBox="0 0 20 20" className="absolute inset-0 size-full overflow-visible">
          <text x="15" y={tiny ? 6 : 7} fontSize={tiny ? 13 : 10} strokeWidth={tiny ? 1.8 : 1.2} className={Z}>
            z
          </text>
          {!tiny && (
            <text x="20" y="0" fontSize="8" strokeWidth="1.1" className={cn(Z, "sleep-z-upper")}>
              z
            </text>
          )}
        </svg>
      )}
    </span>
  )
}
