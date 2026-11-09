import { forwardRef, useId, useImperativeHandle, type ReactNode } from "react"
import * as SelectPrimitive from "@radix-ui/react-select"
import { ChevronDown } from "@/components/icons"
import { CheckItem, MENU_ITEM, useMenuKeys } from "@/components/ui/check-menu"
import { PriorityIcon } from "@/components/ui/priority-icon"
import { Select, SelectContent, SelectItem } from "@/components/ui/select"
import { UserAvatar } from "@/components/ui/user-avatar"
import type { Task } from "@/lib/api/tasks"
import type { UserSummary } from "@/lib/api/users"
import { cn } from "@/lib/utils"
import { PRIORITY_LABEL, TASK_PRIORITIES, type TaskPriority } from "@/types/tasks"
import { UNASSIGNED_KEY, userName, type TaskGroupBy } from "./groupTasks"

export type TaskFilters = { assignees: string[]; priorities: TaskPriority[] }

export const NO_FILTERS: TaskFilters = { assignees: [], priorities: [] }

export const TOOLBAR_PILL =
  "inline-flex h-[1.75rem] min-w-0 max-w-[12rem] cursor-pointer items-center gap-1.5 rounded-md border-[0.0625rem] border-border bg-card px-2.5 text-ui font-medium text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-ring data-[state=open]:bg-app-hover max-lg:h-11"

const GROUPS: { value: TaskGroupBy; label: string }[] = [
  { value: "status", label: "Status" },
  { value: "priority", label: "Priority" },
  { value: "assignee", label: "Assignee" },
  { value: "none", label: "None" },
]

export function filterTasks(tasks: Task[], filters: TaskFilters): Task[] {
  return tasks.filter(
    (task) =>
      (filters.assignees.length === 0 || filters.assignees.includes(task.assigned_to ?? UNASSIGNED_KEY)) &&
      (filters.priorities.length === 0 || filters.priorities.includes(task.priority)),
  )
}

export const TaskFilterMenu = forwardRef<
  HTMLButtonElement,
  { filters: TaskFilters; people: UserSummary[]; onChange: (filters: TaskFilters) => void }
>(function TaskFilterMenu({ filters, people, onChange }, ref) {
  const { open, setOpen, button: buttonRef, menu: menuRef, close, onKeyDown: menuKeys } = useMenuKeys()
  const ids = useId()
  const count = filters.assignees.length + filters.priorities.length

  useImperativeHandle(ref, () => buttonRef.current as HTMLButtonElement)

  const toggleAssignee = (id: string) =>
    onChange({
      ...filters,
      assignees: filters.assignees.includes(id) ? filters.assignees.filter((a) => a !== id) : [...filters.assignees, id],
    })

  const togglePriority = (priority: TaskPriority) =>
    onChange({
      ...filters,
      priorities: filters.priorities.includes(priority)
        ? filters.priorities.filter((p) => p !== priority)
        : [...filters.priorities, priority],
    })

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${ids}-menu` : undefined}
        aria-label={count > 0 ? `Filter, ${count} active` : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault()
            setOpen(true)
          }
        }}
        className={cn(TOOLBAR_PILL, count > 0 && "text-foreground", open && "bg-app-hover text-foreground")}
      >
        Filter
        {count > 0 && (
          <span
            aria-hidden="true"
            className="rounded-full bg-app-sky-soft px-1.5 text-micro leading-[1.1rem] font-medium text-app-sky-ink tabular-nums"
          >
            {count}
          </span>
        )}
        <ChevronDown aria-hidden="true" weight="bold" className="size-[0.7rem] shrink-0" />
      </button>
      {open && (
        <div
          ref={menuRef}
          id={`${ids}-menu`}
          role="menu"
          aria-label="Filter tasks"
          onKeyDown={menuKeys}
          className="absolute top-full left-0 z-20 mt-1 flex max-h-[min(34rem,75vh)] w-[15rem] max-w-[calc(100vw-2rem)] flex-col overflow-y-auto rounded-lg border-[0.0625rem] border-border bg-popover p-1 text-popover-foreground shadow-[var(--shadow-popover)] duration-150 animate-in fade-in-0 zoom-in-95"
        >
          <MenuGroup id={`${ids}-assignee`} label="Assignee">
            <CheckItem
              checked={filters.assignees.includes(UNASSIGNED_KEY)}
              onToggle={() => toggleAssignee(UNASSIGNED_KEY)}
              icon={<UserAvatar user={null} size="xs" />}
              label="Unassigned"
            />
            {people.map((person) => (
              <CheckItem
                key={person.id}
                checked={filters.assignees.includes(person.id)}
                onToggle={() => toggleAssignee(person.id)}
                icon={<UserAvatar user={person} size="xs" />}
                label={userName(person)}
              />
            ))}
          </MenuGroup>
          <div role="separator" className="mx-1.5 my-1 h-[0.0625rem] shrink-0 bg-border" />
          <MenuGroup id={`${ids}-priority`} label="Priority">
            {TASK_PRIORITIES.map((priority) => (
              <CheckItem
                key={priority}
                checked={filters.priorities.includes(priority)}
                onToggle={() => togglePriority(priority)}
                icon={<PriorityIcon priority={priority} />}
                label={PRIORITY_LABEL[priority]}
              />
            ))}
          </MenuGroup>
          {count > 0 && (
            <>
              <div role="separator" className="mx-1.5 my-1 h-[0.0625rem] shrink-0 bg-border" />
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  onChange(NO_FILTERS)
                  close()
                }}
                className={MENU_ITEM}
              >
                Clear
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
})

function MenuGroup({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div role="group" aria-labelledby={id} className="flex shrink-0 flex-col">
      <div id={id} role="presentation" className="px-2.5 pt-1.5 pb-1 text-micro font-medium text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  )
}

export function GroupSelect({ value, onChange }: { value: TaskGroupBy; onChange: (value: TaskGroupBy) => void }) {
  const label = GROUPS.find((group) => group.value === value)?.label ?? "Status"

  return (
    <Select value={value} onValueChange={(next) => onChange(next as TaskGroupBy)}>
      <SelectPrimitive.Trigger aria-label={`Group: ${label}`} className={TOOLBAR_PILL}>
        <span className="truncate">Group: {label}</span>
        <ChevronDown aria-hidden="true" weight="bold" className="size-[0.7rem] shrink-0" />
      </SelectPrimitive.Trigger>
      <SelectContent className="min-w-[10rem]">
        {GROUPS.map((group) => (
          <SelectItem key={group.value} value={group.value} textValue={group.label}>
            {group.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
