import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"

const openCrew = async (page: Page) => {
  await page.goto("/messages")
  await page
    .getByRole("list", { name: "Chats" })
    .getByRole("button", { name: /^Launch crew/ })
    .click()
  const chat = page.getByRole("region", { name: "Launch crew" })
  await expect(chat.getByRole("combobox", { name: "Message Launch crew" })).toBeVisible()
  return chat
}

test("admin's group message reaches Fiona live, then admin edits it, Fiona reacts, and both see both", async ({ asUser, uniqueName }) => {
  const admin = await asUser("admin@nerla.com")
  const fiona = await asUser("fiona@nerla.com")
  const first = uniqueName("Is the agenda ready")
  const edited = uniqueName("Is the review agenda ready")

  const adminChat = await openCrew(admin)
  const fionaChat = await openCrew(fiona)

  await adminChat.getByRole("combobox", { name: "Message Launch crew" }).fill(first)
  await adminChat.getByRole("button", { name: "Send" }).click()
  await expect(adminChat.getByText(first, { exact: true })).toBeVisible()
  await expect(fionaChat.getByText(first, { exact: true })).toBeVisible()

  await adminChat.getByText(first, { exact: true }).hover()
  await adminChat.getByRole("toolbar", { name: "Message actions" }).getByRole("button", { name: "More" }).click()
  await admin.getByRole("button", { name: "Edit", exact: true }).click()
  const box = adminChat.getByRole("combobox", { name: "Edit message" })
  await box.fill(edited)
  await box.press("Enter")

  for (const chat of [adminChat, fionaChat]) {
    await expect(chat.getByText(edited)).toContainText("(edited)")
    await expect(chat.getByText(first, { exact: true })).toHaveCount(0)
  }

  await fionaChat.getByText(edited).hover()
  await fionaChat.getByRole("toolbar", { name: "Message actions" }).getByRole("button", { name: "React" }).click()
  await fiona.getByRole("button", { name: "Thumbs up", exact: true }).click()

  await expect(fionaChat.getByRole("button", { name: "Thumbs up, 1, You" })).toBeVisible()
  await expect(adminChat.getByRole("button", { name: "Thumbs up, 1, Fiona Placeholder" })).toBeVisible()
  await expect(adminChat.getByText(edited)).toBeVisible()
})
