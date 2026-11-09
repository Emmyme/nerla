import { Fragment } from "react"
import { isMac } from "@/components/call/shortcuts"
import { chordCaps, spokenKeys } from "@/lib/shortcuts"
import { cn } from "@/lib/utils"
import { ShortcutHint } from "./shortcut-hint"

/** A shortcut's keys as key caps, "then" between the keys of a sequence and "or" between choices, read out in words */
export function ShortcutKeys({
  keys,
  className,
  hintClassName,
  wordClassName,
}: {
  keys: string[][]
  className?: string
  hintClassName?: string
  wordClassName?: string
}) {
  const mac = isMac()
  const word = (text: string) => (
    <span aria-hidden="true" className={cn("text-caption", wordClassName ?? "text-muted-foreground")}>
      {text}
    </span>
  )
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      <span className="sr-only">{spokenKeys(keys, mac)}</span>
      {keys.map((sequence, i) => (
        <Fragment key={i}>
          {i > 0 && word("or")}
          {sequence.map((chord, j) => (
            <Fragment key={j}>
              {j > 0 && word("then")}
              <ShortcutHint variant="outline" keys={chordCaps(chord, mac)} className={hintClassName} />
            </Fragment>
          ))}
        </Fragment>
      ))}
    </span>
  )
}
