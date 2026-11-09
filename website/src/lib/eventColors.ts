export type EventType = "meeting" | "event" | "task" | "focus" | "personal" | "ooo"

/** `away` is out of office: no pastel, a sunk fill with a berry hairline, so it reads as not here */
export type EventTone = "sky" | "lavender" | "pistachio" | "bubblegum" | "lemon" | "away"

const TONE_BY_TYPE: Record<EventType, EventTone> = {
  meeting: "sky",
  event: "lavender",
  focus: "pistachio",
  personal: "bubblegum",
  task: "lemon",
  ooo: "away",
}

export function eventTone(type?: string): EventTone {
  return type && Object.prototype.hasOwnProperty.call(TONE_BY_TYPE, type) ? TONE_BY_TYPE[type as EventType] : "lavender"
}

export const EVENT_TYPE_OPTIONS: { type: EventType; label: string }[] = [
  { type: "meeting", label: "Meeting" },
  { type: "event", label: "Event" },
  { type: "focus", label: "Focus" },
  { type: "personal", label: "Personal" },
  { type: "task", label: "Task" },
  { type: "ooo", label: "Out of office" },
]

export function eventTypeLabel(type?: string): string {
  return EVENT_TYPE_OPTIONS.find((option) => option.type === type)?.label ?? "Event"
}

const QUIET_EDGE = "ring-[color-mix(in_srgb,var(--color-text)_14%,transparent)] dark:ring-app-lemon"
/** With more contrast on, a block's edge is ink instead of pastel */
const INK_EDGE = "contrast-more:ring-app-text"

/**
 * Upcoming events: in light a fill halfway between the soft step and the pastel, with its ink and a hairline
 * in the strong step (lemon takes the quiet mark edge). In dark both steps are the pastel and the ring melts
 * into it, so it stays pastel pop.
 */
export const EVENT_FILL: Record<EventTone, string> = {
  sky: `bg-[color-mix(in_srgb,var(--color-sky)_50%,var(--color-sky-soft))] text-app-sky-ink ring-[0.0625rem] ring-inset ring-app-sky-strong ${INK_EDGE}`,
  lavender: `bg-[color-mix(in_srgb,var(--color-lavender)_50%,var(--color-lavender-soft))] text-app-lavender-ink ring-[0.0625rem] ring-inset ring-app-lavender-strong ${INK_EDGE}`,
  pistachio: `bg-[color-mix(in_srgb,var(--color-pistachio)_50%,var(--color-pistachio-soft))] text-app-pistachio-ink ring-[0.0625rem] ring-inset ring-app-pistachio-strong ${INK_EDGE}`,
  // Personal stays lighter than the rest so it never competes with the primary button
  bubblegum: `bg-app-bubblegum-soft text-app-bubblegum-ink ring-[0.0625rem] ring-inset ring-app-bubblegum ${INK_EDGE}`,
  lemon: `bg-[color-mix(in_srgb,var(--color-lemon)_50%,var(--color-lemon-soft))] text-app-lemon-ink ring-[0.0625rem] ring-inset ${QUIET_EDGE} ${INK_EDGE}`,
  away: "bg-app-sunk text-foreground ring-[0.0625rem] ring-inset ring-app-berry",
}

/**
 * Past events: grey in light, the sunk fill with a hairline in the main pastel and the ink at 75%. In dark
 * the same idea, a charcoal block with the pastel as ring and text.
 */
export const EVENT_PAST: Record<EventTone, string> = {
  sky: "bg-app-sunk text-app-sky-ink/75 ring-[0.0625rem] ring-inset ring-app-sky dark:text-app-sky",
  lavender: "bg-app-sunk text-app-lavender-ink/75 ring-[0.0625rem] ring-inset ring-app-lavender dark:text-app-lavender",
  pistachio: "bg-app-sunk text-app-pistachio-ink/75 ring-[0.0625rem] ring-inset ring-app-pistachio dark:text-app-pistachio",
  bubblegum: "bg-app-sunk text-app-bubblegum-ink/75 ring-[0.0625rem] ring-inset ring-app-bubblegum dark:text-app-bubblegum",
  lemon: `bg-app-sunk text-app-lemon-ink/75 ring-[0.0625rem] ring-inset ${QUIET_EDGE} dark:text-app-lemon`,
  away: "bg-app-sunk text-muted-foreground ring-[0.0625rem] ring-inset ring-app-berry/50",
}

/** Small marks such as dots and checkboxes, in the strongest step of each tone */
export const EVENT_MARK: Record<EventTone, { bg: string; ring: string }> = {
  sky: { bg: "bg-app-sky-strong", ring: "ring-app-sky-strong" },
  lavender: { bg: "bg-app-lavender-strong", ring: "ring-app-lavender-strong" },
  pistachio: { bg: "bg-app-pistachio-strong", ring: "ring-app-pistachio-strong" },
  bubblegum: { bg: "bg-app-bubblegum", ring: "ring-app-bubblegum" },
  lemon: { bg: "bg-app-lemon", ring: "ring-app-lemon" },
  away: { bg: "bg-app-berry", ring: "ring-app-berry" },
}

/** Rings in the main pastel. Lemon takes the quiet mark edge in light, as its pastel barely shows on white. */
const PASTEL_RING: Record<EventTone, string> = {
  sky: "ring-app-sky",
  lavender: "ring-app-lavender",
  pistachio: "ring-app-pistachio",
  bubblegum: "ring-app-bubblegum",
  lemon: QUIET_EDGE,
  away: "ring-app-berry",
}

/** An invite the user has not answered, outlined like Google: the card with a full ring in the tone, a hairline once past */
export function invitePendingSurface(tone: EventTone, past: boolean): string {
  return `bg-card text-foreground ring-inset ${past ? "ring-[0.0625rem]" : "ring-[0.125rem]"} ${EVENT_MARK[tone].ring}`
}

/** An invite the user declined: the card with a pastel hairline, quiet but still in its color. Its title is struck through. */
export function inviteDeclinedSurface(tone: EventTone): string {
  return `bg-card text-foreground ring-[0.0625rem] ring-inset ${PASTEL_RING[tone]}`
}
