import { useMemo } from "react"
import { Link } from "react-router"
import { cn } from "@/lib/utils"
import { parseAiMarkdown, type AiRun } from "./aiMarkdown"

function Runs({ runs }: { runs: AiRun[] }) {
  return (
    <>
      {runs.map((run, index) => {
        if (run.code) {
          return (
            <code key={index} className="rounded-sm bg-app-sunk px-1 py-0.5 font-mono text-caption">
              {run.text}
            </code>
          )
        }
        if (run.href) {
          return (
            <Link
              key={index}
              to={run.href}
              className={cn(
                "rounded-sm font-medium text-app-sky-ink underline decoration-app-sky-ink/40 underline-offset-[0.2em] hover:decoration-app-sky-ink focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none",
                run.bold && "font-semibold",
                run.italic && "italic",
              )}
            >
              {run.text}
            </Link>
          )
        }
        if (!run.bold && !run.italic) return <span key={index}>{run.text}</span>
        return (
          <span key={index} className={cn(run.bold && "font-semibold", run.italic && "italic")}>
            {run.text}
          </span>
        )
      })}
    </>
  )
}

/** What the AI says, as formatted text. Built from React elements only, so nothing it writes runs or loads, and it links only to papers and boards in Nerla */
export default function AiText({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseAiMarkdown(text), [text])
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 text-body leading-normal break-words text-foreground", className)}>
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          return (
            <p key={index} className="font-semibold">
              <Runs runs={block.runs} />
            </p>
          )
        }
        if (block.type === "code") {
          return (
            <pre
              key={index}
              className="overflow-x-auto rounded-md bg-app-sunk px-3 py-2 font-mono text-caption leading-normal whitespace-pre"
            >
              {block.text}
            </pre>
          )
        }
        if (block.type === "list") {
          const items = block.items.map((runs, at) => (
            <li key={at} className="pl-1">
              <Runs runs={runs} />
            </li>
          ))
          return block.ordered ? (
            <ol key={index} start={block.start} className="flex list-decimal flex-col gap-1 pl-5">
              {items}
            </ol>
          ) : (
            <ul key={index} className="flex list-disc flex-col gap-1 pl-5">
              {items}
            </ul>
          )
        }
        return (
          <p key={index} className="whitespace-pre-wrap">
            <Runs runs={block.runs} />
          </p>
        )
      })}
    </div>
  )
}
