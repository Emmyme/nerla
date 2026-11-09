import type { ComponentProps } from "react"
import { CheckFat, Headphones, Heart, Star, Sunglasses, Users, type IconComponent } from "@/components/icons"
import type { EventTone, EventType } from "@/lib/eventColors"
import { cn } from "@/lib/utils"

/** One shape per event type, for users who turn on shapes with colors. Each outline differs even when filled and small */
const GLYPH: Record<EventType, IconComponent> = {
  meeting: Users,
  event: Star,
  focus: Headphones,
  personal: Heart,
  task: CheckFat,
  ooo: Sunglasses,
}

/**
 * The shape where it stands on the card in place of a dot. The pastels are too pale on white to carry a shape, so in
 * light it takes the tone's ink and in dark the pastel itself
 */
export const GLYPH_INK: Record<EventTone, string> = {
  sky: "text-app-sky-ink dark:text-app-sky",
  lavender: "text-app-lavender-ink dark:text-app-lavender",
  pistachio: "text-app-pistachio-ink dark:text-app-pistachio",
  bubblegum: "text-app-bubblegum-ink dark:text-app-bubblegum",
  lemon: "text-app-lemon-ink dark:text-app-lemon",
  away: "text-app-berry",
}

export function TypeGlyph({
  type,
  className,
  weight = "fill",
}: {
  type?: string
  className?: string
  weight?: ComponentProps<IconComponent>["weight"]
}) {
  const Icon = type && Object.prototype.hasOwnProperty.call(GLYPH, type) ? GLYPH[type as EventType] : GLYPH.event
  return <Icon aria-hidden="true" weight={weight} className={cn("shrink-0", className)} />
}
