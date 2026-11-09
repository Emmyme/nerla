import { Hide } from "@/components/icons"
import type { AiHeld } from "@/lib/api/ai"
import { answerCard, useAiTeammate } from "@/lib/aiStore"
import { cn } from "@/lib/utils"
import { HeldCard } from "./HeldCard"

/** A card in a shared place that only the asker sees, in their own view of that chat or thread */
function PrivateCard({ held, className }: { held: AiHeld; className?: string }) {
  const teammate = useAiTeammate()
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <p className="flex items-center gap-1.5 px-1 text-caption font-medium text-muted-foreground">
        <Hide aria-hidden="true" className="size-[0.875rem]" />
        Only you can see this
      </p>
      <HeldCard held={held} aiName={teammate?.name} onAnswer={(decision, chosen) => answerCard(held, decision, chosen)} />
    </div>
  )
}

export default function PrivateCards({ cards, className }: { cards: AiHeld[]; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {cards.map((held) => (
        <PrivateCard key={held.id} held={held} />
      ))}
    </div>
  )
}
