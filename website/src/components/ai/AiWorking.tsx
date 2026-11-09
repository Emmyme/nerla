import { TypingDots } from "@/components/ui/typing-dots"
import { useAiTeammate } from "@/lib/aiStore"
import { cn } from "@/lib/utils"
import { AiFace } from "./AiAvatar"

/** Where the AI's reply will land, while it works on it. It reads like a teammate typing in a chat */
export function AiWorkingRow({ name, className }: { name?: string; className?: string }) {
  const teammate = useAiTeammate()
  const shown = name || teammate?.name || "Nerla AI"
  return (
    <div className={cn("flex min-h-8 min-w-0 items-center gap-2 text-ui", className)}>
      <AiFace size={1.25} />
      <TypingDots className="text-muted-foreground" />
      <span className="min-w-0 truncate">
        <span className="font-semibold text-foreground">{shown}</span> <span className="text-muted-foreground">is typing</span>
      </span>
    </div>
  )
}
