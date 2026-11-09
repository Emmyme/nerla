import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"

export type Command = {
  id: string
  title: string
  group: "Navigate" | "Projects" | "Actions"
  keywords?: string[]
  shortcut?: string
  /** Drawn before the title, such as a project's tile */
  lead?: ReactNode
  run: () => void
}

type MenuControls = { open(): void; close(): void; isOpen: boolean }

type Ctx = MenuControls & {
  commands: Command[]
  register(commands: Command[]): () => void
}

const CommandMenuContext = createContext<Ctx | null>(null)

export function CommandMenuProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const [holders, setHolders] = useState<{ token: symbol; commands: Command[] }[]>([])

  const opener = useRef<HTMLElement | null>(null)
  const openRef = useRef(false)

  const open = useCallback(() => {
    if (openRef.current) return
    const active = document.activeElement
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null
    openRef.current = true
    setIsOpen(true)
  }, [])

  // The menu has no trigger, so focus goes back to where it was unless the command moved it
  const close = useCallback(() => {
    if (!openRef.current) return
    openRef.current = false
    setIsOpen(false)
    const target = opener.current
    opener.current = null
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (target?.isConnected && (!active || active === document.body)) target.focus()
    })
  }, [])

  const register = useCallback((commands: Command[]) => {
    const token = Symbol()
    setHolders((prev) => [...prev, { token, commands }])
    return () => setHolders((prev) => prev.filter((h) => h.token !== token))
  }, [])

  const registered = useMemo(() => {
    const byId = new Map<string, Command>()
    for (const holder of holders) {
      for (const command of holder.commands) {
        byId.delete(command.id)
        byId.set(command.id, command)
      }
    }
    return [...byId.values()]
  }, [holders])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        if (openRef.current) close()
        else open()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [open, close])

  const value = useMemo(() => ({ isOpen, open, close, commands: registered, register }), [isOpen, open, close, registered, register])

  return <CommandMenuContext.Provider value={value}>{children}</CommandMenuContext.Provider>
}

function useCtx() {
  const ctx = useContext(CommandMenuContext)
  if (!ctx) throw new Error("Command menu hooks must be used within a CommandMenuProvider")
  return ctx
}

export function useCommandMenu(): MenuControls {
  const { open, close, isOpen } = useCtx()
  return { open, close, isOpen }
}

export function useRegisterCommands(commands: Command[]) {
  const { register } = useCtx()
  const latest = useRef(commands)
  latest.current = commands
  const signature = commands.map((c) => [c.id, c.title, c.group, c.shortcut ?? "", (c.keywords ?? []).join(",")].join("|")).join(";")

  useEffect(() => {
    const stable = latest.current.map<Command>((c) => ({
      ...c,
      run: () => latest.current.find((l) => l.id === c.id)?.run(),
    }))
    return register(stable)
  }, [register, signature])
}

export function useRegisteredCommands() {
  return useCtx().commands
}
