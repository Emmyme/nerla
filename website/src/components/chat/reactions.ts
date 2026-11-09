import type { ComponentType } from "react"
import catLogo from "@/assets/cat-logo.png"
import { CatNappingReaction, CatSearchingReaction } from "@/components/ui/cat-scenes"
import { CheckCircle, Confetti, Fire, Heart, ThumbsUp, type IconComponent } from "@/components/icons"
import { GrinFace } from "./GrinFace"
import type { MessageReaction } from "@/lib/api/chat"

export type Reaction = {
  key: string
  label: string
  /** A fill icon and its text color class, the logo image, or a drawn cat sized like the logo */
  icon: IconComponent | null
  color: string
  image?: string
  scene?: ComponentType<{ className?: string }>
}

export const REACTIONS: Reaction[] = [
  { key: "thumbs-up", label: "Thumbs up", icon: ThumbsUp, color: "text-app-sky-strong" },
  { key: "heart", label: "Heart", icon: Heart, color: "text-app-bubblegum" },
  { key: "fire", label: "Fire", icon: Fire, color: "text-app-berry" },
  { key: "laugh", label: "Happy", icon: GrinFace as IconComponent, color: "text-app-lemon-strong" },
  { key: "party", label: "Celebrate", icon: Confetti, color: "text-app-lavender-strong" },
  { key: "check", label: "Done", icon: CheckCircle, color: "text-app-pistachio-strong" },
  { key: "cat", label: "Purr", icon: null, color: "", image: catLogo },
  { key: "cat-search", label: "Looking into it", icon: null, color: "", scene: CatSearchingReaction },
  { key: "cat-sleepy", label: "Sleepy", icon: null, color: "", scene: CatNappingReaction },
]

const BY_KEY = new Map(REACTIONS.map((r) => [r.key, r]))

export function reactionFor(value: string): Reaction | undefined {
  return BY_KEY.get(value)
}

type ReactionGroup = {
  key: string
  reaction: Reaction | undefined
  /** One entry per user, in the order they reacted */
  people: MessageReaction[]
  mine: boolean
}

export function groupReactions(reactions: MessageReaction[], me: string): ReactionGroup[] {
  const groups = new Map<string, ReactionGroup>()
  for (const r of reactions) {
    const key = r.emoji
    let group = groups.get(key)
    if (!group) {
      group = { key, reaction: reactionFor(key), people: [], mine: false }
      groups.set(key, group)
    }
    if (r.user_id === me) group.mine = true
    if (!group.people.some((p) => p.user_id === r.user_id)) group.people.push(r)
  }
  return [...groups.values()]
}
