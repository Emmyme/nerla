import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router"

const state = vi.hoisted(() => ({
  projects: [] as unknown[],
  unread: false,
}))

vi.mock("@/providers/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "1", firstName: "Ada", lastName: "Lovelace", role: "member" }, logout: vi.fn() }),
}))
vi.mock("@/contexts/DarkModeContext", () => ({
  useDarkMode: () => ({ themeMode: "light", resolvedMode: "light" }),
}))
vi.mock("@/components/command/registry", () => ({ useCommandMenu: () => ({ open: vi.fn() }) }))
vi.mock("@/lib/chatHooks", () => ({ useTotalUnread: () => state.unread }))
vi.mock("@/lib/api/projects", () => ({ projectsAPI: { getUserProjects: () => Promise.resolve(state.projects) } }))
vi.mock("@/lib/api/users", () => ({ avatarAPI: { getAvatar: vi.fn() } }))
vi.mock("@/lib/api/organizations", () => ({
  organizationsAPI: { getCurrentOrganization: () => Promise.resolve({ id: "o1", name: "Acme" }) },
}))

import Sidebar from "./Sidebar"
import { resetProjectsStore } from "@/lib/useProjects"
import { resetRecentProjects, sidebarProjects } from "@/lib/recentProjects"

const makeProjects = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Project ${i}`, slug: `project-${i}`, color: "#7CC2F7" }))

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Sidebar />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  state.projects = []
  state.unread = false
  resetProjectsStore()
  localStorage.clear()
  resetRecentProjects()
})

describe("Sidebar", () => {
  it("marks the current link", async () => {
    renderAt("/calendar")
    expect(screen.getByRole("link", { name: "Calendar" })).toHaveAttribute("aria-current", "page")
    await screen.findByText("You're not in any projects yet")
  })

  it("shows pinned projects first, then recent ones up to 4 in all, and an All projects link", async () => {
    state.projects = makeProjects(12).map((project, i) =>
      i === 7 || i === 3 ? { ...project, pinned: true, pinned_at: i === 7 ? "2026-10-01T00:00:00Z" : "2026-10-02T00:00:00Z" } : project,
    )
    renderAt("/")
    const rows = await screen.findAllByTestId("sidebar-project")
    expect(rows.map((row) => row.textContent)).toEqual(["Project 3", "Project 7", "Project 0", "Project 1"])
    expect(screen.getByRole("button", { name: "Unpin Project 7" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Pin Project 0" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "All projects" })).toHaveAttribute("href", "/projects")
  })

  it("orders the sidebar's projects by pin, then recently opened, then list order", () => {
    const projects = makeProjects(6) as Parameters<typeof sidebarProjects>[0]
    const { pinned, others } = sidebarProjects(projects, ["p4", "p1"], ["p1", "p5", "gone", "p2"], 3)
    expect(pinned.map((p) => p.id)).toEqual(["p4", "p1"])
    expect(others.map((p) => p.id)).toEqual(["p5", "p2", "p0"])
  })

  it("puts the unread dot on Chat only while something is unread", async () => {
    const { rerender } = renderAt("/")
    expect(screen.getByRole("link", { name: "Chat" })).toBeInTheDocument()
    state.unread = true
    rerender(
      <MemoryRouter initialEntries={["/"]}>
        <Sidebar />
      </MemoryRouter>,
    )
    expect(screen.getByRole("link", { name: "Chat Unread messages" })).toBeInTheDocument()
    await screen.findByText("You're not in any projects yet")
  })

  it("puts Files before the Projects section and the workspace under the user's name", async () => {
    renderAt("/files")
    const files = screen.getByRole("link", { name: "Files" })
    expect(files).toHaveAttribute("aria-current", "page")
    const projects = screen.getByRole("button", { name: "Projects" })
    expect(projects.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    expect(screen.getByRole("button", { name: "New project" })).toBeInTheDocument()
    expect(await screen.findByTestId("workspace-name")).toHaveTextContent("Acme")
    await screen.findByText("You're not in any projects yet")
  })

  it("shows an empty state without projects", async () => {
    renderAt("/")
    expect(await screen.findByText("You're not in any projects yet")).toBeInTheDocument()
  })
})
