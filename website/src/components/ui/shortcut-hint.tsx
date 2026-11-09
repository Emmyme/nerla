import { cn } from "@/lib/utils"

const BOX =
  "inline-flex h-[1.25rem] min-w-[1.25rem] shrink-0 items-center justify-center rounded-sm px-1 font-sans text-micro font-semibold leading-none"

/** A keyboard key with its letters centred. Solid sits inside a primary button, outline on surfaces */
export function ShortcutHint({ keys, variant = "solid", className }: { keys: string; variant?: "solid" | "outline"; className?: string }) {
  return (
    <kbd
      aria-hidden="true"
      className={cn(BOX, variant === "solid" ? "bg-white/45 max-lg:hidden" : "border border-border text-muted-foreground", className)}
    >
      {/* Trimmed to the capitals so the letters sit in the true middle */}
      <span className="block [text-box:trim-both_cap_alphabetic]">{keys}</span>
    </kbd>
  )
}
