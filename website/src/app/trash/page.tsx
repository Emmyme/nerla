import { useCallback, useRef } from "react"
import { useSearchParams } from "react-router"
import { PageHeader } from "@/components/shell/PageHeader"
import { TrashList } from "@/components/trash/TrashList"
import { KIND_FILTERS, trashFilterOf } from "@/lib/trashText"
import { useDocumentTitle } from "@/lib/useDocumentTitle"
import { cn } from "@/lib/utils"

const CHIP =
  "flex h-8 shrink-0 items-center whitespace-nowrap rounded-md px-3 text-ui font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-ring max-lg:h-11 max-lg:px-3.5"

/** Everything deleted in the last 30 days that the user may bring back or delete for good */
export default function TrashPage() {
  useDocumentTitle("Trash")
  const [params, setParams] = useSearchParams()
  const kind = trashFilterOf(params.get("kind"))
  const heading = useRef<HTMLHeadingElement>(null)
  const focusHeading = useCallback(() => heading.current, [])

  const choose = (next: string) =>
    setParams(
      (current) => {
        if (next === "all") current.delete("kind")
        else current.set("kind", next)
        return current
      },
      { replace: true },
    )

  return (
    <div className="flex min-w-0 flex-col gap-3.5">
      <PageHeader titleRef={heading} title="Trash" />
      <div role="group" aria-label="Show" className="flex flex-wrap items-center gap-1.5">
        {KIND_FILTERS.map((filter) => {
          const on = filter.key === kind
          return (
            <button
              key={filter.key}
              type="button"
              aria-pressed={on}
              onClick={() => choose(filter.key)}
              className={cn(
                CHIP,
                on
                  ? "bg-current-page text-app-pistachio-ink dark:text-foreground"
                  : "bg-app-sunk text-muted-foreground hover:bg-app-hover hover:text-foreground",
              )}
            >
              {filter.label}
            </button>
          )
        })}
      </div>
      <p className="rounded-lg bg-app-sunk px-3 py-2 text-ui text-muted-foreground">
        Items in the trash are deleted for good after 30 days.
      </p>
      <TrashList kind={kind} fallbackFocus={focusHeading} />
    </div>
  )
}
