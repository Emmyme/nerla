import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, useLocation } from "react-router"
import { CommandMenuProvider, useRegisterCommands, useRegisteredCommands } from "./registry"
import CommandMenu from "./CommandMenu"
import { projectsAPI } from "@/lib/api/projects"
import { searchAPI, type SearchReply } from "@/lib/api/search"
import { resetProjectsStore } from "@/lib/useProjects"

vi.mock("@/lib/api/projects", () => ({
  projectsAPI: { getUserProjects: vi.fn().mockResolvedValue([{ id: "p1", name: "Apollo", slug: "apollo" }]) },
}))
vi.mock("@/lib/api/search", () => ({ searchAPI: { search: vi.fn() } }))
vi.mock("@/lib/api/ai", () => ({ aiAPI: { me: vi.fn().mockResolvedValue({ available: false, mcpEnabled: false }) } }))
vi.mock("@/contexts/DarkModeContext", () => ({ useDarkMode: () => ({ resolvedMode: "light", setThemeMode: vi.fn() }) }))
const auth = vi.hoisted(() => ({ role: "member" }))
vi.mock("@/providers/AuthProvider", () => ({ useAuth: () => ({ user: { id: "u1", role: auth.role }, logout: vi.fn() }) }))

function LocationDisplay() {
  const { pathname, search } = useLocation()
  return <p data-testid="loc">{pathname + search}</p>
}

function Registrar({ run }: { run: () => void }) {
  useRegisterCommands([{ id: "x", title: "Test action", group: "Actions", run }])
  return null
}

function Shared() {
  useRegisterCommands([{ id: "shared", title: "Shared", group: "Actions", run: () => {} }])
  return null
}

function RegisteredIds() {
  return (
    <p data-testid="ids">
      {useRegisteredCommands()
        .map((c) => c.id)
        .join(",")}
    </p>
  )
}

function Holders({ first, second }: { first: boolean; second: boolean }) {
  return (
    <CommandMenuProvider>
      {first && <Shared />}
      {second && <Shared />}
      <RegisteredIds />
    </CommandMenuProvider>
  )
}

function setup(run = vi.fn()) {
  render(
    <MemoryRouter>
      <CommandMenuProvider>
        <CommandMenu />
        <Registrar run={run} />
        <LocationDisplay />
      </CommandMenuProvider>
    </MemoryRouter>,
  )
  return { run, user: userEvent.setup() }
}

const none = { items: [], more: false }
const emptyReply = (): SearchReply => ({ files: none, tasks: none, projects: none, people: none, messages: none, events: none })

beforeEach(() => {
  resetProjectsStore()
  auth.role = "member"
  vi.mocked(searchAPI.search).mockReset().mockResolvedValue(emptyReply())
})

describe("CommandMenu", () => {
  it("opens with Ctrl+K, navigates and closes", async () => {
    const { user } = setup()
    await user.keyboard("{Control>}k{/Control}")
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    await user.keyboard("cal")
    expect(screen.getByRole("option", { name: "Calendar" })).toBeInTheDocument()
    await user.keyboard("{Enter}")
    expect(screen.getByTestId("loc")).toHaveTextContent("/calendar")
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("runs registered commands", async () => {
    const { user, run } = setup()
    await user.keyboard("{Control>}k{/Control}test")
    await user.keyboard("{Enter}")
    expect(run).toHaveBeenCalledOnce()
  })

  it("closes on Escape and lists projects", async () => {
    const { user } = setup()
    await user.keyboard("{Control>}k{/Control}")
    expect(await screen.findByRole("option", { name: /Apollo/ })).toBeInTheDocument()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).toBeNull()
  })
  it("keeps same-named projects distinct", async () => {
    vi.mocked(projectsAPI.getUserProjects).mockResolvedValueOnce([
      { id: "a", name: "Apollo", slug: "apollo-a" },
      { id: "b", name: "Apollo", slug: "apollo-b" },
    ] as never)
    const { user } = setup()
    await user.keyboard("{Control>}k{/Control}")
    await screen.findAllByRole("option", { name: /Apollo/ })
    await user.keyboard("apollo{ArrowDown}{Enter}")
    expect(screen.getByTestId("loc")).toHaveTextContent("/project/apollo-b")
  })
  it("lists the admin settings sections for admins only", async () => {
    const { user } = setup()
    await user.keyboard("{Control>}k{/Control}")
    expect(await screen.findByRole("option", { name: "Calendar sharing" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: "Members" })).toBeNull()
    expect(screen.queryByRole("option", { name: "Workspace" })).toBeNull()
    await user.keyboard("{Escape}")
    auth.role = "admin"
    await user.keyboard("{Control>}k{/Control}")
    expect(await screen.findByRole("option", { name: "Members" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "Workspace" })).toBeInTheDocument()
  })
  it("matches multi-word queries against word starts", async () => {
    vi.mocked(projectsAPI.getUserProjects).mockResolvedValueOnce([{ id: "i", name: "Infrastructure Migration", slug: "infra" }] as never)
    const { user } = setup()
    await user.keyboard("{Control>}k{/Control}")
    await screen.findByRole("option", { name: /Infrastructure Migration/ })
    await user.keyboard("infra mig")
    expect(screen.getByRole("option", { name: /Infrastructure Migration/ })).toBeInTheDocument()
  })
})

describe("CommandMenu search", () => {
  const reply: SearchReply = {
    ...emptyReply(),
    files: {
      items: [
        {
          id: "f1",
          name: "zqx-plan.pdf",
          size: 10,
          mimeType: "application/pdf",
          kind: "pdf",
          docType: null,
          altText: null,
          owner: { id: "u1", name: "Me", avatarUrl: null },
          projectId: null,
          folderId: null,
          updatedAt: "2026-10-01T10:00:00Z",
          deletedAt: null,
          removalDeadline: null,
          context: null,
          can: ["view"],
        },
      ],
      more: false,
    },
    tasks: {
      items: [
        { id: "t1", title: "Zqx launch", identifier: "APO-7", status: "todo", project: { name: "Apollo", slug: "apollo", color: null } },
      ],
      more: false,
    },
    people: { items: [{ id: "u2", name: "Zqx Person", email: "z@x.io", jobTitle: "Developer", team: null, avatarUrl: null }], more: false },
    messages: {
      items: [
        {
          id: "m1",
          snippet: "about zqx",
          createdAt: "2026-10-01T10:00:00Z",
          sender: { id: "u2", name: "Zqx Person" },
          chat: { kind: "group", id: "g1", title: "Team" },
        },
      ],
      more: false,
    },
    events: {
      items: [{ id: "e1", title: "Zqx review", startsAt: "2026-10-30T09:00:00Z", allDay: false, eventType: "meeting", ownerId: "u2" }],
      more: false,
    },
  }
  const headings = () => [...document.querySelectorAll("[cmdk-group-heading]")].map((h) => h.textContent)

  it("searches once after typing stops, and aborts the request it replaces", async () => {
    vi.mocked(searchAPI.search).mockReturnValue(new Promise(() => {}))
    const { user } = setup()
    await user.keyboard("{Control>}k{/Control}zqx")
    expect(searchAPI.search).not.toHaveBeenCalled()
    await waitFor(() => expect(searchAPI.search).toHaveBeenCalledTimes(1))
    const [q, first] = vi.mocked(searchAPI.search).mock.calls[0]
    expect(q).toBe("zqx")
    await user.keyboard("v")
    expect(first?.aborted).toBe(true)
    await waitFor(() => expect(searchAPI.search).toHaveBeenCalledTimes(2))
    expect(vi.mocked(searchAPI.search).mock.calls[1][0]).toBe("zqxv")
  })

  it("makes no request for one character", async () => {
    const { user } = setup()
    await user.keyboard("{Control>}k{/Control}z")
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(searchAPI.search).not.toHaveBeenCalled()
  })

  it("shows the groups in order and hides empty ones", async () => {
    vi.mocked(searchAPI.search).mockResolvedValue(reply)
    const { user } = setup()
    await user.keyboard("{Control>}k{/Control}zqx")
    await screen.findByRole("option", { name: /Zqx launch/ })
    expect(headings()).toEqual(["Files", "Tasks", "People", "Messages", "Events"])
    expect(screen.getByRole("option", { name: /zqx-plan\.pdf/ })).toHaveTextContent("My files")
    expect(screen.getByRole("option", { name: /about zqx/ })).toHaveTextContent("Zqx Person in Team")
  })

  it("opens a task at its route on Enter", async () => {
    vi.mocked(searchAPI.search).mockResolvedValue({ ...emptyReply(), tasks: reply.tasks })
    const { user } = setup()
    await user.keyboard("{Control>}k{/Control}zqx")
    await screen.findByRole("option", { name: /Zqx launch/ })
    await user.keyboard("{Enter}")
    expect(screen.getByTestId("loc")).toHaveTextContent("/project/apollo?task=t1")
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("waits for the fresh answer when Enter comes before it", async () => {
    let answer: (reply: SearchReply) => void = () => {}
    vi.mocked(searchAPI.search)
      .mockResolvedValueOnce({ ...emptyReply(), tasks: reply.tasks })
      .mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    const { user } = setup()
    await user.keyboard("{Control>}k{/Control}zqx")
    await screen.findByRole("option", { name: /Zqx launch/ })
    await user.keyboard("v{Enter}")
    expect(screen.getByRole("option", { name: /Zqx launch/ })).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByTestId("loc")).toHaveTextContent(/^\/$/)
    await waitFor(() => expect(searchAPI.search).toHaveBeenCalledTimes(2))
    answer({
      ...emptyReply(),
      tasks: { items: [{ id: "t2", title: "Zqxv fresh", identifier: null, status: "todo", project: null }], more: false },
    })
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/?task=t2"))
  })

  it("says when nothing matches and when search fails", async () => {
    const { user } = setup()
    await user.keyboard("{Control>}k{/Control}zqx")
    expect(await screen.findByText("Nothing found for “zqx”")).toBeInTheDocument()
    vi.mocked(searchAPI.search).mockRejectedValue(new Error("down"))
    await user.keyboard("v")
    expect(await screen.findByText("Search is unavailable right now")).toBeInTheDocument()
  })
})

describe("command registry", () => {
  it("keeps a shared command id until every component holding it unmounts", () => {
    const view = render(<Holders first second />)
    expect(screen.getByTestId("ids")).toHaveTextContent("shared")
    view.rerender(<Holders first={false} second />)
    expect(screen.getByTestId("ids")).toHaveTextContent("shared")
    view.rerender(<Holders first={false} second={false} />)
    expect(screen.getByTestId("ids")).toBeEmptyDOMElement()
  })
})
