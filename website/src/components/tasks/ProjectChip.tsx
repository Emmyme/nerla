import { User } from "@/components/icons"
import type { Task } from "@/lib/api/tasks"
import { IdentityTile } from "@/components/ui/identity-tile"
import { cn } from "@/lib/utils"

export function ProjectChip({
  project,
  iconOnly = false,
  className,
}: {
  project: Task["project"]
  iconOnly?: boolean
  className?: string
}) {
  const name = project ? project.name : "Personal"
  return (
    <span
      title={iconOnly ? name : undefined}
      className={cn("inline-flex min-w-0 items-center gap-1.5 text-caption font-medium text-muted-foreground", className)}
    >
      {project ? (
        <IdentityTile
          color={project.color}
          symbol={project.icon}
          size="sm"
          className={project.icon ? "size-[0.875rem]" : "size-[0.6rem]"}
        />
      ) : (
        <User aria-hidden="true" weight="fill" className="-mx-0.5 size-3 shrink-0 text-app-lavender-strong" />
      )}
      <span className={iconOnly ? "sr-only" : "truncate"}>{name}</span>
    </span>
  )
}
