import { expect, test } from "../fixtures"

const ADMIN_SECTIONS = { "Workspace AI": "workspace-ai", Workspace: "workspace", Members: "members", "Setup check": "setup-check" }

test("Fiona, a member, sees no admin sections in Settings, and their addresses send her to Profile", async ({ asUser }) => {
  const fiona = await asUser("fiona@nerla.com")
  await fiona.goto("/")
  await fiona.getByRole("button", { name: "Fiona Placeholder, Nerla" }).click()
  await fiona.getByRole("menuitem", { name: "Settings" }).click()

  const sections = fiona.getByRole("navigation", { name: "Settings" })
  await expect(sections.getByRole("link", { name: "Profile" })).toBeVisible()
  for (const name of Object.keys(ADMIN_SECTIONS)) await expect(sections.getByRole("link", { name, exact: true })).toHaveCount(0)

  for (const path of Object.values(ADMIN_SECTIONS)) {
    await fiona.goto(`/settings/${path}`)
    await expect(fiona).toHaveURL(/\/settings\/profile$/)
    await expect(sections.getByRole("link", { name: "Profile" })).toHaveAttribute("aria-current", "page")
    await expect(fiona.getByRole("region", { name: "Name" })).toBeVisible()
  }
})

test("the admin of Nerla opens a project and a paper of the Other workspace and finds nothing of them", async ({ asUser }) => {
  // Olga, the admin of Other, finds the addresses through the app
  const olga = await asUser("olga@other.test")
  await olga.goto("/projects")
  await olga.getByRole("link", { name: /^Other Roadmap/ }).click()
  await expect(olga.getByRole("heading", { name: "Other Roadmap", level: 1 })).toBeVisible()
  const projectUrl = olga.url()
  await olga.getByRole("radio", { name: "Files" }).check()
  await olga.getByRole("list", { name: "Files" }).getByRole("button", { name: "Other secret paper", exact: true }).click()
  await expect(olga.getByRole("textbox", { name: "Paper", exact: true }).getByText("Only the Other workspace reads this.")).toBeVisible()
  const paperUrl = olga.url()
  expect(paperUrl).toMatch(/\/paper\/[0-9a-f-]{36}$/)

  const admin = await asUser("admin@nerla.com")
  for (const [url, title] of [
    [projectUrl, "This project wandered off"],
    [paperUrl, "This paper wandered off"],
  ]) {
    await admin.goto(url)
    await expect(admin.getByRole("heading", { name: title })).toBeVisible()
    await expect(admin).not.toHaveTitle(/Other/)
    for (const text of ["Other Roadmap", "Plans that only the Other workspace may see", "Other secret", "Only the Other workspace"]) {
      await expect(admin.getByText(text)).toHaveCount(0)
    }
  }
})
