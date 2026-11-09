import { cn } from "@/lib/utils"

/** Three dots that rise in turn while a user, or the AI, is typing. They hold still without motion but always show */
export function TypingDots({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn("inline-flex shrink-0 items-center gap-1", className)}>
      {[0, 1, 2].map((dot) => (
        <span
          key={dot}
          className="size-[0.3125rem] rounded-full bg-current opacity-60 motion-safe:animate-[typing-dot_1.2s_ease-in-out_infinite]"
          style={{ animationDelay: `${dot * 0.15}s` }}
        />
      ))}
    </span>
  )
}
