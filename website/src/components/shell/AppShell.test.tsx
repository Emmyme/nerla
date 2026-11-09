import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, act, within } from "@testing-library/react"
import { createMemoryRouter, RouterProvider } from "react-router"
import { useEffect } from "react"
import userEvent from "@testing-library/user-event"

const state = vi.hoisted(() => ({
  auth: { user: { id: "1" } as unknown, loading: false },
  chatMounts: 0,
}))

vi.mock("@/providers/AuthProvider", () => ({ useAuth: () => state.auth }))
vi.mock("@/lib/api/request", () => ({ ApiError: class ApiError extends Error {} }))
vi.mock("@/lib/api/projects", () => ({ projectsAPI: { getUserProjects: vi.fn().mockResolvedValue([]) } }))
vi.mock("@/lib/api/ai", () => ({ aiAPI: { me: vi.fn().mockResolvedValue({ available: false, mcpEnabled: false }) } }))
vi.mock("@/contexts/DarkModeContext", () => ({ useDarkMode: () => ({ themeMode: "system", setThemeMode: vi.fn() }) }))
vi.mock("@/lib/chatHooks", () => ({ useTotalUnread: () => false }))
vi.mock("@/components/shell/Sidebar", () => ({ default: () => null }))
vi.mock("@/components/calendar/ReminderScheduler", () => ({ ReminderScheduler: () => null }))
vi.mock("@/components/onboarding/WelcomeDialog", () => ({ WelcomeDialog: () => null }))
vi.mock("@/components/chat/DockedChat", () => ({
  DockedChat: function DockedChatMock() {
    useEffect(() => {
      state.chatMounts += 1
    }, [])
    return null
  },
}))

import AppShell from "./AppShell"

beforeEach(() => {
  state.auth = { user: { id: "1" }, loading: false }
  state.chatMounts = 0
})

describe("AppShell", () => {
  it("keeps the shell mounted across navigation", async () => {
    const router = createMemoryRouter([
      {
        element: <AppShell />,
        children: [
          { path: "/", element: <p>Home page</p> },
          { path: "/calendar", element: <p>Cal</p> },
        ],
      },
    ])
    render(<RouterProvider router={router} />)
    expect(screen.getByText("Home page")).toBeInTheDocument()
    await act(async () => {
      await router.navigate("/calendar")
    })
    expect(screen.getByText("Cal")).toBeInTheDocument()
    expect(state.chatMounts).toBe(1)
  })

  it("opens the command menu with Ctrl+K", async () => {
    const router = createMemoryRouter([{ element: <AppShell />, children: [{ path: "/", element: <p>Home</p> }] }])
    render(<RouterProvider router={router} />)
    await userEvent.setup().keyboard("{Control>}k{/Control}")
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  it("shows the tab bar with the current tab and hides it on a conversation", async () => {
    const router = createMemoryRouter(
      [
        {
          element: <AppShell />,
          children: [
            { path: "/project/:slug", element: <p>Project</p> },
            { path: "/messages", element: <p>Chat</p> },
          ],
        },
      ],
      { initialEntries: ["/project/web"] },
    )
    render(<RouterProvider router={router} />)
    const bar = screen.getByRole("navigation", { name: "Main" })
    expect(within(bar).getByRole("link", { name: "Projects" })).toHaveAttribute("aria-current", "page")
    expect(within(bar).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/")
    expect(within(bar).getByRole("link", { name: "Chat" })).toHaveAttribute("href", "/messages")
    expect(within(bar).getByRole("link", { name: "Calendar" })).toHaveAttribute("href", "/calendar")
    await act(async () => {
      await router.navigate("/messages?dm=2")
    })
    expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument()
    await act(async () => {
      await router.navigate("/messages")
    })
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument()
  })

  it("opens the More sheet and returns focus to More on Escape", async () => {
    const router = createMemoryRouter([{ element: <AppShell />, children: [{ path: "/", element: <p>Home</p> }] }])
    render(<RouterProvider router={router} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "More" }))
    const sheet = screen.getByRole("dialog", { name: "More" })
    for (const name of ["Search", "Settings", "Light", "Dark", "System", "Sign out"])
      expect(within(sheet).getByRole("button", { name })).toBeInTheDocument()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "More" })).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: "More" })).toHaveFocus()
  })

  it("opens search from More and returns focus to More when it closes", async () => {
    const router = createMemoryRouter([{ element: <AppShell />, children: [{ path: "/", element: <p>Home</p> }] }])
    render(<RouterProvider router={router} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "More" }))
    await user.click(within(screen.getByRole("dialog", { name: "More" })).getByRole("button", { name: "Search" }))
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveFocus())
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.getByRole("button", { name: "More" })).toHaveFocus())
  })

  it("redirects to sign-in without a user", async () => {
    state.auth = { user: null, loading: false }
    const router = createMemoryRouter([
      {
        element: <AppShell />,
        children: [{ path: "/", element: <p>Home</p> }],
      },
      { path: "/sign-in", element: <p>Sign in</p> },
    ])
    render(<RouterProvider router={router} />)
    await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"))
  })
})
