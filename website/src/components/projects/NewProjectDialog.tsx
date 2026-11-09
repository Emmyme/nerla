import { useEffect, useId, useRef, useState, type FormEvent, type MutableRefObject } from "react"
import { useNavigate } from "react-router"
import { X } from "@/components/icons"
import BaseModal from "@/components/ui/BaseModal"
import { Button } from "@/components/ui/button"
import { UserAvatar } from "@/components/ui/user-avatar"
import { ApiError } from "@/lib/api/request"
import { projectsAPI, type Project } from "@/lib/api/projects"
import { nearestSwatch, PROJECT_SWATCHES } from "@/lib/projectColors"
import { messageOf } from "@/lib/taskStore"
import { notifyProjectsChanged, useProjects } from "@/lib/useProjects"
import { useAuth } from "@/providers/AuthProvider"
import { PeopleSearch, personName, type PersonResult } from "./PeopleSearch"
import type { SymbolKey } from "@/components/ui/symbols"
import { ColorField, DescriptionField, KeyField, NameField, SymbolField } from "./ProjectFields"
import { KEY_HINT, KEY_TAKEN, projectKeyError } from "./projectKey"

const CREATE_FAILED = "Couldn't create the project. Check your connection and try again."

function leastUsedSwatch(projects: Project[]): string {
  const counts = new Map<string, number>(PROJECT_SWATCHES.map((swatch) => [swatch.key, 0]))
  for (const project of projects) {
    const key = nearestSwatch(project.color).key
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let best = PROJECT_SWATCHES[0]
  for (const swatch of PROJECT_SWATCHES) {
    if ((counts.get(swatch.key) ?? 0) < (counts.get(best.key) ?? 0)) best = swatch
  }
  return best.hex
}

type NewProjectDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (project: Project) => void
}

export function NewProjectDialog({ open, onOpenChange, onCreated }: NewProjectDialogProps) {
  const saving = useRef(false)

  return (
    <BaseModal
      isOpen={open}
      onClose={() => {
        if (!saving.current) onOpenChange(false)
      }}
      title="New project"
      maxWidth="lg"
    >
      <NewProjectForm savingRef={saving} onCreated={onCreated} onClose={() => onOpenChange(false)} />
    </BaseModal>
  )
}

function NewProjectForm({
  savingRef,
  onCreated,
  onClose,
}: {
  savingRef: MutableRefObject<boolean>
  onCreated?: (project: Project) => void
  onClose: () => void
}) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { projects } = useProjects()
  const [name, setName] = useState("")
  const [key, setKey] = useState("")
  const [color, setColor] = useState<string | null>(() => leastUsedSwatch(projects))
  const [symbol, setSymbol] = useState<SymbolKey | null>(null)
  const [description, setDescription] = useState("")
  const [people, setPeople] = useState<PersonResult[]>([])
  const [saving, setSavingState] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<Project | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const keyRef = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  const ids = useId()

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      savingRef.current = false
    }
  }, [savingRef])

  const setSaving = (value: boolean) => {
    savingRef.current = value
    setSavingState(value)
  }

  const locked = saving || created !== null

  const openProject = (project: Project) => {
    onClose()
    navigate(`/project/${project.slug}`)
  }

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (locked) return
    const trimmed = name.trim()
    if (!trimmed) {
      setNameError("Give the project a name")
      nameRef.current?.focus()
      return
    }
    const keyProblem = projectKeyError(key)
    if (keyProblem) {
      setKeyError(keyProblem)
      keyRef.current?.focus()
      return
    }

    setSaving(true)
    setError(null)
    let project: Project
    try {
      project = await projectsAPI.createProject({
        name: trimmed,
        key: key || undefined,
        color: color ?? undefined,
        icon: symbol ?? undefined,
        description: description.trim() || undefined,
      })
    } catch (err) {
      if (!mounted.current) return
      setSaving(false)
      if (err instanceof ApiError && err.status === 409) {
        setKeyError(messageOf(err, KEY_TAKEN))
        requestAnimationFrame(() => keyRef.current?.focus())
      } else {
        setError(messageOf(err, CREATE_FAILED))
      }
      return
    }

    const added = await Promise.allSettled(people.map((person) => projectsAPI.addProjectMember(project.id, person.id)))
    notifyProjectsChanged()
    onCreated?.(project)
    if (!mounted.current) return

    const missed = people.filter((_, i) => added[i].status === "rejected").map(personName)
    if (missed.length > 0) {
      setSaving(false)
      setCreated(project)
      setError(`The project was created, but ${missed.join(", ")} couldn't be added. Add them in project settings.`)
      return
    }
    savingRef.current = false
    openProject(project)
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col">
      <fieldset disabled={locked} className="flex min-w-0 flex-col gap-4 px-6 pt-5 pb-5">
        <NameField
          id={`${ids}-name`}
          inputRef={nameRef}
          autoFocus
          value={name}
          error={nameError}
          onChange={(next) => {
            setName(next)
            if (nameError) setNameError(null)
          }}
        />
        <KeyField
          id={`${ids}-key`}
          inputRef={keyRef}
          value={key}
          error={keyError}
          hint={KEY_HINT}
          onChange={(next) => {
            setKey(next)
            if (keyError) setKeyError(null)
          }}
        />
        <ColorField id={`${ids}-color`} value={color} onChange={setColor} />
        <SymbolField id={`${ids}-symbol`} value={symbol} onChange={setSymbol} />
        <DescriptionField id={`${ids}-description`} value={description} onChange={setDescription} />

        <div className="flex flex-col gap-2.5">
          <PeopleSearch
            excludeIds={[...(user ? [user.id] : []), ...people.map((person) => person.id)]}
            onPick={(person) => setPeople((current) => [...current, person])}
          />
          {people.length > 0 && (
            <ul aria-label="People to add" className="flex flex-wrap gap-1.5">
              {people.map((person) => {
                const label = personName(person)
                return (
                  <li
                    key={person.id}
                    className="inline-flex items-center gap-1.5 rounded-full border-[0.0625rem] border-border bg-card py-1 pr-1 pl-1 text-ui font-medium text-foreground"
                  >
                    <UserAvatar user={person} size="xs" />
                    <span className="max-w-[10rem] truncate">{label}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${label}`}
                      onClick={() => setPeople((current) => current.filter((p) => p.id !== person.id))}
                      className="relative flex size-[1.25rem] items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50 max-lg:after:absolute max-lg:after:-inset-[0.75rem] max-lg:after:content-['']"
                    >
                      <X aria-hidden="true" weight="bold" className="size-[0.7rem]" />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t-[0.0625rem] border-border px-6 py-4">
        {error && (
          <p role="alert" className="mr-auto basis-full text-ui text-app-berry-text sm:flex-1">
            {error}
          </p>
        )}
        {created ? (
          <Button type="button" onClick={() => openProject(created)}>
            Open project
          </Button>
        ) : (
          <>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Creating" : "Create project"}
            </Button>
          </>
        )}
      </div>
    </form>
  )
}
