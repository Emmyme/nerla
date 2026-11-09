import { isTauri } from "@tauri-apps/api/core"
import { PictureInPicture, X } from "@/components/icons"
import { WINDOW_BUTTON, WINDOW_CLOSE, WindowControls } from "@/components/shell/WindowControls"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/** Desktop only: a drag strip with the window controls, where minimize sends a call to the corner. The mini call adds its title and a leave button in place of close */
export function CallTitlebar({
  title,
  isMini,
  onToggleMini,
  onMinimize,
  onLeave,
}: {
  title: string
  isMini: boolean
  onToggleMini: () => void
  onMinimize: () => void
  onLeave: () => void
}) {
  if (!isTauri()) return null

  if (isMini) {
    return (
      <header data-tauri-drag-region className="app-region-drag flex h-titlebar shrink-0 items-center gap-2 pl-3 select-none">
        <h1 data-tauri-drag-region className="min-w-0 truncate text-caption font-medium tracking-normal text-app-text">
          {title}
        </h1>
        <div className="app-region-no-drag ml-auto flex h-full items-stretch">
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={onLeave} aria-label="Leave call" className={WINDOW_CLOSE}>
                <X aria-hidden="true" className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Leave call</TooltipContent>
          </Tooltip>
        </div>
      </header>
    )
  }

  return (
    <header data-tauri-drag-region className="app-region-drag flex h-titlebar shrink-0 items-stretch justify-end select-none">
      <div className="app-region-no-drag flex items-stretch">
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" onClick={onToggleMini} aria-label="Minimize to corner" className={WINDOW_BUTTON}>
              <PictureInPicture aria-hidden="true" className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Minimize to corner</TooltipContent>
        </Tooltip>
        <WindowControls onMinimize={onMinimize} />
      </div>
    </header>
  )
}
