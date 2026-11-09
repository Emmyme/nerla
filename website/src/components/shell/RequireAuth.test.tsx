import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, waitFor } from "@testing-library/react"
import { createMemoryRouter, RouterProvider } from "react-router"
import RequireAuth from "./RequireAuth"

const state = vi.hoisted(() => ({ auth: { user: null as unknown, loading: false } }))
vi.mock("@/providers/AuthProvider", () => ({ useAuth: () => state.auth }))

function setup() {
  return createMemoryRouter(
    [
      {
        path: "/meeting-room/:roomId",
        element: (
          <RequireAuth>
            <p>Room</p>
          </RequireAuth>
        ),
      },
      { path: "/sign-in", element: <p>Sign in</p> },
    ],
    { initialEntries: ["/meeting-room/abc"] },
  )
}

describe("RequireAuth", () => {
  beforeEach(() => {
    state.auth = { user: null, loading: false }
  })

  it("redirects to sign-in without a user, keeping the meeting to come back to", async () => {
    const router = setup()
    render(<RouterProvider router={router} />)
    await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"))
    expect(router.state.location.search).toBe("?next=%2Fmeeting-room%2Fabc")
  })
})
