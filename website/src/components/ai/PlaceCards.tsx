import { lazy, Suspense } from "react"
import type { AiPlace } from "@/lib/api/ai"
import { useHeldIn } from "@/lib/aiStore"

const PrivateCards = lazy(() => import("./PrivateCard"))

/** The AI's cards for the user in a shared place. The cards load only once there is one */
export function PlaceCards({ place, className }: { place: AiPlace | null; className?: string }) {
  // An answered card leaves the place, where the answer itself shows
  const cards = useHeldIn(place).filter((held) => held.status === "waiting")
  if (cards.length === 0) return null
  return (
    <Suspense fallback={null}>
      <PrivateCards cards={cards} className={className} />
    </Suspense>
  )
}
