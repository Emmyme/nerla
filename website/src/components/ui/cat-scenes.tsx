import { useId, type ReactNode } from "react"
import catLogo from "@/assets/cat-logo.png"
import {
  EAR_HOLES,
  FOLDER,
  LAYOUT,
  LINE_WIDTH,
  LOGO_H as H,
  LOGO_W as W,
  NAPPING,
  NOSE,
  REACTION,
  RING,
  SEARCHING,
  SHUT_EYES,
  TRASH,
  viewBoxOf,
  type ViewBox,
} from "@/components/ui/cat-scene-layout"
import { useSolidCat } from "@/components/ui/presence-cat"
import { cn } from "@/lib/utils"

// Like the status cats, the cutout and the object fills take the fill behind the drawing, which cards set as --row-fill
const SCENE_BG = "[--cat-ring:var(--row-fill,var(--color-bg))]"
const BG_FILL = "fill-[var(--cat-ring)]"
const BG_STROKE = "stroke-[var(--cat-ring)]"
const PINK = "fill-app-bubblegum"
const GREY = "fill-muted-foreground opacity-75"
const SKY = "fill-app-sky-strong"
const SKY_OUTLINE = "fill-[var(--cat-ring)] stroke-app-sky-strong"
const OUTLINE = "fill-[var(--cat-ring)] stroke-app-bubblegum"
const GREY_OUTLINE = "fill-[var(--cat-ring)] stroke-muted-foreground [stroke-opacity:0.75]"
const LINE = { strokeWidth: LINE_WIDTH, strokeLinejoin: "round", strokeLinecap: "round" } as const

type SceneProps = { className?: string }

// Scenes share one scale, 16 units to the rem, so the cats match in size from scene to scene
const UNITS_PER_REM = 16

/** The viewBox holds the drawing with room around it (see cat-scene-layout) */
function Scene({ className, view, children }: SceneProps & { view: ViewBox; children: ReactNode }) {
  const size = { width: `${view.width / UNITS_PER_REM}rem`, height: `${view.height / UNITS_PER_REM}rem` }
  return (
    <svg aria-hidden="true" viewBox={viewBoxOf(view)} style={size} className={cn("block shrink-0 overflow-visible", SCENE_BG, className)}>
      {children}
    </svg>
  )
}

/** The logo cat placed by its top left corner and width, with a cutout in the background colour */
export function Cat({
  x,
  y,
  width,
  rotate = 0,
  tone = PINK,
  eyes = "open",
  ring = true,
}: {
  x: number
  y: number
  width: number
  rotate?: number
  tone?: string
  eyes?: "open" | "shut"
  ring?: boolean
}) {
  const solid = useSolidCat()
  const id = useId().replace(/:/g, "")
  const scale = width / W
  const shut = eyes === "shut"
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotate} ${width / 2} ${(H * scale) / 2}) scale(${scale})`}>
      <mask id={`${id}-ring`} style={{ maskType: "alpha" }}>
        <image href={solid} x={-RING} y={-RING} width={W + 2 * RING} height={H + 2 * RING} preserveAspectRatio="none" />
      </mask>
      <mask id={`${id}-cat`} style={{ maskType: "alpha" }}>
        <image href={shut ? solid : catLogo} width={W} height={H} />
      </mask>
      {ring && <rect x={-RING} y={-RING} width={W + 2 * RING} height={H + 2 * RING} mask={`url(#${id}-ring)`} className={BG_FILL} />}
      <rect width={W} height={H} mask={`url(#${id}-cat)`} className={tone} />
      {shut && (
        // The solid silhouette has no holes, so the ears, the nose and the shut eyes are painted back in the background colour
        <>
          <path d={EAR_HOLES} className={BG_FILL} />
          <ellipse {...NOSE} className={BG_FILL} />
          <path d={SHUT_EYES} fill="none" strokeWidth={26} strokeLinecap="round" className={BG_STROKE} />
        </>
      )}
    </g>
  )
}

/** Peeking out of a trash can in the offline grey, its head tilted under the lid resting on its ear tips */
export function CatInTrash({ className }: SceneProps) {
  return (
    <Scene className={className} view={LAYOUT.trash.view}>
      <Cat {...TRASH.cat} tone={GREY} />
      <path d="M35 51H85L81.6 87.4A4 4 0 0 1 77.6 91H42.4A4 4 0 0 1 38.4 87.4Z" className={GREY_OUTLINE} {...LINE} />
      <path d="M53 59V83M67 59V83" fill="none" className={GREY_OUTLINE} {...LINE} />
      <rect x={31} y={46} width={58} height={6} rx={3} className={GREY_OUTLINE} {...LINE} />
      <g transform={`translate(${TRASH.lid.x} ${TRASH.lid.y}) rotate(${TRASH.lid.rotate})`}>
        <path d="M-6 -9.5V-11.5A2.5 2.5 0 0 1 -3.5 -14H3.5A2.5 2.5 0 0 1 6 -11.5V-9.5" fill="none" className={GREY_OUTLINE} {...LINE} />
        <path d="M-24 -1.5Q-23 -9.5 0 -9.5Q23 -9.5 24 -1.5Z" className={GREY_OUTLINE} {...LINE} />
        <rect x={-28} y={-2} width={56} height={5} rx={2.5} className={GREY_OUTLINE} {...LINE} />
      </g>
    </Scene>
  )
}

/** Curled up in an open folder, in sky, with its tail out of the side */
export function CatInFolder({ className }: SceneProps) {
  return (
    <Scene className={className} view={LAYOUT.folder.view}>
      <path
        d="M20 24h21a3 3 0 0 1 2.4 1.2L46.6 30H100a4 4 0 0 1 4 4v50a4 4 0 0 1-4 4H20a4 4 0 0 1-4-4V28a4 4 0 0 1 4-4Z"
        className={SKY_OUTLINE}
        {...LINE}
      />
      <path d={FOLDER.tail} fill="none" strokeWidth={7.5} strokeLinecap="round" className={BG_STROKE} />
      <path d={FOLDER.tail} fill="none" strokeWidth={3.75} strokeLinecap="round" className="stroke-app-sky-strong" />
      <ellipse cx={83} cy={59} rx={16} ry={9} strokeWidth={3.5} className={cn(SKY, BG_STROKE, "[paint-order:stroke]")} />
      <Cat {...FOLDER.cat} tone={SKY} />
      <path
        d="M14 60h92a3 3 0 0 1 2.9 3.7l-4.6 21.4A4 4 0 0 1 100.4 88H19.6a4 4 0 0 1-3.9-2.9L11.1 63.7A3 3 0 0 1 14 60Z"
        className={SKY_OUTLINE}
        {...LINE}
      />
    </Scene>
  )
}

const Z = cn(BG_FILL, "stroke-app-bubblegum font-extrabold [paint-order:stroke] [stroke-linejoin:round]")

/** Asleep */
export function CatNapping({ className }: SceneProps) {
  return (
    <Scene className={className} view={LAYOUT.napping.view}>
      <Cat {...NAPPING.cat} eyes="shut" />
      {NAPPING.z.map((z) => (
        <text key={z.x} x={z.x} y={z.y} fontSize={z.size} strokeWidth={z.stroke} className={Z}>
          z
        </text>
      ))}
    </Scene>
  )
}

/** One big eye through a magnifier */
export function CatSearching({ className }: SceneProps) {
  const id = useId().replace(/:/g, "")
  const { cat, eye, r } = SEARCHING
  const zoom = `translate(${eye.x} ${eye.y}) scale(1.55) translate(${-eye.x} ${-eye.y})`
  return (
    <Scene className={className} view={LAYOUT.searching.view}>
      <Cat {...cat} />
      <rect
        x={-4.5}
        y={0}
        width={9}
        height={18}
        rx={4.5}
        transform={`translate(${eye.x + 10} ${eye.y + 10}) rotate(-45)`}
        className={OUTLINE}
        {...LINE}
      />
      <circle cx={eye.x} cy={eye.y} r={r} strokeWidth={6.5} className={cn(BG_FILL, BG_STROKE)} />
      <clipPath id={`${id}-lens`}>
        <circle cx={eye.x} cy={eye.y} r={r} />
      </clipPath>
      <g clipPath={`url(#${id}-lens)`}>
        <g transform={zoom}>
          <Cat {...cat} ring={false} />
        </g>
      </g>
      <circle cx={eye.x} cy={eye.y} r={r} fill="none" className="stroke-app-bubblegum" {...LINE} />
    </Scene>
  )
}

const WHITE = "0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0"

/**
 * A reaction icon, sized like the Purr image. The cat and its extras are one mask over a pink fill, so the
 * cutouts and the extras' fills show whatever is behind the icon, hover and selected fills included.
 */
function CatReaction({ className, children }: SceneProps & { children: (white: string) => ReactNode }) {
  const id = useId().replace(/:/g, "")
  const { x, y, width, height } = REACTION.view
  const area = { x: x - width / 4, y: y - height / 4, width: width * 1.5, height: height * 1.5 }
  return (
    <svg aria-hidden="true" viewBox={viewBoxOf(REACTION.view)} className={cn("block shrink-0 overflow-visible", className)}>
      <filter id={`${id}-white`}>
        <feColorMatrix values={WHITE} />
      </filter>
      <mask id={`${id}-mask`} maskUnits="userSpaceOnUse" {...area}>
        {children(`url(#${id}-white)`)}
      </mask>
      <rect {...area} mask={`url(#${id}-mask)`} className="fill-app-bubblegum" />
    </svg>
  )
}

const { outline, gap } = REACTION

/** Asleep with a small z, for reactions */
export function CatNappingReaction({ className }: SceneProps) {
  const solid = useSolidCat()
  const z = REACTION.z
  return (
    <CatReaction className={className}>
      {(white) => (
        <>
          <image href={solid} width={W} height={H} filter={white} />
          <path d={EAR_HOLES} fill="black" />
          <ellipse {...NOSE} fill="black" />
          <path d={SHUT_EYES} fill="none" stroke="black" strokeWidth={26} strokeLinecap="round" />
          <text
            x={z.x}
            y={z.y}
            fontSize={z.size}
            fontWeight={800}
            fill="black"
            stroke="black"
            strokeWidth={2 * (outline + gap)}
            strokeLinejoin="round"
          >
            z
          </text>
          <text
            x={z.x}
            y={z.y}
            fontSize={z.size}
            fontWeight={800}
            fill="black"
            stroke="white"
            strokeWidth={2 * outline}
            strokeLinejoin="round"
            paintOrder="stroke"
          >
            z
          </text>
        </>
      )}
    </CatReaction>
  )
}

/** A magnifier over one eye, for reactions */
export function CatSearchingReaction({ className }: SceneProps) {
  const id = useId().replace(/:/g, "")
  const { eye, r, handle } = REACTION.lens
  const start = (r - outline) * Math.SQRT1_2
  const zoom = `translate(${eye.x} ${eye.y}) scale(1.55) translate(${-eye.x} ${-eye.y})`
  const handleRect = (
    <rect
      x={-handle.width / 2}
      width={handle.width}
      height={handle.length}
      rx={handle.width / 2}
      transform={`translate(${eye.x + start} ${eye.y + start}) rotate(-45)`}
    />
  )
  return (
    <CatReaction className={className}>
      {(white) => (
        <>
          <image href={catLogo} width={W} height={H} filter={white} />
          <g fill="black" stroke="black" strokeWidth={outline + 2 * gap}>
            {handleRect}
            <circle cx={eye.x} cy={eye.y} r={r} />
          </g>
          <g fill="black" stroke="white" strokeWidth={outline}>
            {handleRect}
            <circle cx={eye.x} cy={eye.y} r={r} />
          </g>
          <clipPath id={`${id}-lens`}>
            <circle cx={eye.x} cy={eye.y} r={r - outline / 2} />
          </clipPath>
          <g clipPath={`url(#${id}-lens)`}>
            <image href={catLogo} width={W} height={H} filter={white} transform={zoom} />
          </g>
        </>
      )}
    </CatReaction>
  )
}
