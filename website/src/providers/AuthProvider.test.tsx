import { afterEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const token = vi.hoisted(() => ({ value: "desktop-token" as string | null }))
const loadApp = vi.hoisted(() => vi.fn())
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({ ...(await importOriginal<object>()), isTauri: () => true }))
vi.mock("@/lib/authToken", () => ({
  getToken: async () => token.value,
  removeToken: async () => {
    token.value = null
  },
}))
vi.mock("@/lib/appPath", async (importOriginal) => ({ ...(await importOriginal<object>()), loadApp }))

import { AuthProvider, useAuth } from "./AuthProvider"

function SignOut() {
  const { user, logout } = useAuth()
  return user ? <button onClick={logout}>Sign out</button> : null
}

describe("signing out on desktop", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("sends the token with the sign-out so the server revokes it, and only then clears it", async () => {
    const sent: { url: string; auth: string | null }[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        sent.push({ url, auth: new Headers(init?.headers).get("Authorization") })
        return Response.json(url.endsWith("/auth/me") ? { firstName: "Fiona" } : { message: "Logged out successfully" })
      }),
    )
    render(
      <AuthProvider>
        <SignOut />
      </AuthProvider>,
    )
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }))

    await waitFor(() => expect(loadApp).toHaveBeenCalledWith("/sign-in"))
    expect(sent.find((request) => request.url.endsWith("/auth/logout"))).toMatchObject({ auth: "Bearer desktop-token" })
    expect(token.value).toBeNull()
  })
})
