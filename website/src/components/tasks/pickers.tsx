import type { ReactNode } from "react"
import * as SelectPrimitive from "@radix-ui/react-select"
import type { Project } from "@/lib/api/projects"
import type { UserSummary } from "@/lib/api/users"
import { cn } from "@/lib/utils"
import { PriorityIcon } from "@/components/ui/priority-icon"
import { Select, SelectContent, SelectItem } from "@/components/ui/select"
import { StatusIcon } from "@/components/ui/status-icon"
import { UserAvatar } from "@/components/ui/user-avatar"
import { PRIORITY_LABEL, STATUS_LABEL, TASK_PRIORITIES, TASK_STATUSES, type TaskPriority, type TaskStatus } from "@/types/tasks"
import { UNASSIGNED_KEY, userName } from "./groupTasks"
import { ProjectChip } from "./ProjectChip"

export type PickerVariant = "ghost" | "pill"

type PickerControl = {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  variant?: PickerVariant
  disabled?: boolean
  className?: string
}

type PickerProject = Pick<Project, "id" | "name" | "slug" | "key" | "color">

const PERSONAL = "personal"

export const PICKER_TRIGGER =
  "inline-flex h-[1.875rem] min-w-0 max-w-full items-center gap-2 rounded-md px-2.5 text-ui font-medium text-foreground transition-colors duration-150 hover:bg-app-hover focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-ring data-[state=open]:bg-app-hover disabled:pointer-events-none disabled:opacity-50 max-lg:h-11"

export const PICKER_VARIANT: Record<PickerVariant, string> = {
  ghost: "",
  pill: "border-[0.0625rem] border-border bg-card",
}

function Picker({
  label,
  text,
  value,
  onValueChange,
  display,
  children,
  open,
  onOpenChange,
  variant = "ghost",
  disabled,
  className,
}: PickerControl & {
  label: string
  text: string
  value: string
  onValueChange: (value: string) => void
  display: ReactNode
  children: ReactNode
}) {
  return (
    <Select value={value} onValueChange={onValueChange} open={open} onOpenChange={onOpenChange} disabled={disabled}>
      <SelectPrimitive.Trigger aria-label={`${label}: ${text}`} className={cn(PICKER_TRIGGER, PICKER_VARIANT[variant], className)}>
        {display}
      </SelectPrimitive.Trigger>
      <SelectContent className="max-h-[min(22rem,var(--radix-select-content-available-height))] min-w-[12rem]">{children}</SelectContent>
    </Select>
  )
}

function Option({ value, icon, label }: { value: string; icon: ReactNode; label: string }) {
  return (
    <SelectItem value={value} textValue={label}>
      <span className="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className="flex shrink-0">
          {icon}
        </span>
        <span className="truncate">{label}</span>
      </span>
    </SelectItem>
  )
}

function Display({ icon, label, muted = false }: { icon: ReactNode; label: string; muted?: boolean }) {
  return (
    <>
      <span aria-hidden="true" className="flex shrink-0">
        {icon}
      </span>
      <span className={cn("truncate", muted && "text-muted-foreground")}>{label}</span>
    </>
  )
}

export function StatusPicker({
  value,
  onChange,
  ...control
}: PickerControl & { value: TaskStatus; onChange: (status: TaskStatus) => void }) {
  return (
    <Picker
      {...control}
      label="Status"
      text={STATUS_LABEL[value]}
      value={value}
      onValueChange={(next) => onChange(next as TaskStatus)}
      display={<Display icon={<StatusIcon status={value} />} label={STATUS_LABEL[value]} />}
    >
      {TASK_STATUSES.map((status) => (
        <Option key={status} value={status} icon={<StatusIcon status={status} />} label={STATUS_LABEL[status]} />
      ))}
    </Picker>
  )
}

export function PriorityPicker({
  value,
  onChange,
  ...control
}: PickerControl & { value: TaskPriority; onChange: (priority: TaskPriority) => void }) {
  return (
    <Picker
      {...control}
      label="Priority"
      text={PRIORITY_LABEL[value]}
      value={value}
      onValueChange={(next) => onChange(next as TaskPriority)}
      display={<Display icon={<PriorityIcon priority={value} />} label={PRIORITY_LABEL[value]} muted={value === "none"} />}
    >
      {TASK_PRIORITIES.map((priority) => (
        <Option key={priority} value={priority} icon={<PriorityIcon priority={priority} />} label={PRIORITY_LABEL[priority]} />
      ))}
    </Picker>
  )
}

export function AssigneePicker({
  value,
  members,
  onChange,
  assignee = null,
  profile = false,
  ...control
}: PickerControl & {
  value: string | null
  members: UserSummary[]
  onChange: (userId: string | null) => void
  assignee?: UserSummary | null
  /** The assignee's avatar sits beside the picker and opens their profile card */
  profile?: boolean
}) {
  const current = members.find((member) => member.id === value) ?? (assignee?.id === value ? assignee : null)
  const options = [...members]
  if (current && !members.some((member) => member.id === current.id)) options.push(current)
  options.sort((a, b) => userName(a).localeCompare(userName(b), undefined, { sensitivity: "base" }))
  const beside = profile && !!current

  const picker = (
    <Picker
      {...control}
      className={cn(control.className, beside && "ml-0 pl-1.5")}
      label="Assignee"
      text={userName(current)}
      value={current ? current.id : UNASSIGNED_KEY}
      onValueChange={(next) => onChange(next === UNASSIGNED_KEY ? null : next)}
      display={
        beside ? (
          <span className="truncate">{userName(current)}</span>
        ) : (
          <Display icon={<UserAvatar user={current} size="xs" />} label={userName(current)} muted={!current} />
        )
      }
    >
      <Option value={UNASSIGNED_KEY} icon={<UserAvatar user={null} size="xs" />} label="Unassigned" />
      {options.map((member) => (
        <Option key={member.id} value={member.id} icon={<UserAvatar user={member} size="xs" />} label={userName(member)} />
      ))}
    </Picker>
  )
  if (!beside) return picker
  return (
    <span className="flex min-w-0 items-center">
      <UserAvatar user={current} size="xs" profile />
      {picker}
    </span>
  )
}

export function ProjectPicker({
  value,
  projects,
  onChange,
  ...control
}: PickerControl & {
  value: string | null
  projects: PickerProject[]
  onChange: (projectId: string | null) => void
}) {
  const current = value === null ? null : projects.find((project) => project.id === value)

  return (
    <Picker
      {...control}
      label="Project"
      text={value === null ? "Personal" : (current?.name ?? "Unknown project")}
      value={value ?? PERSONAL}
      onValueChange={(next) => onChange(next === PERSONAL ? null : next)}
      display={
        current === undefined ? (
          <span className="truncate text-muted-foreground">Project</span>
        ) : (
          <ProjectChip project={current} className="text-inherit" />
        )
      }
    >
      <SelectItem value={PERSONAL} textValue="Personal">
        <ProjectChip project={null} className="text-inherit" />
      </SelectItem>
      {projects.map((project) => (
        <SelectItem key={project.id} value={project.id} textValue={project.name}>
          <ProjectChip project={project} className="text-inherit" />
        </SelectItem>
      ))}
    </Picker>
  )
}
