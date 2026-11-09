import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"

test("an admin deletes a task and undoes it from the toast, then deletes it again and restores it from the trash", async ({
  asUser,
  uniqueName,
}) => {
  const admin = await asUser("admin@nerla.com")
  const title = uniqueName("Order the banners")
  const tasks = admin.getByRole("region", { name: "Tasks" })
  const card = tasks.getByRole("group", { name: "To do" }).getByRole("button", { name: new RegExp(title) })

  const deleteTask = async (page: Page) => {
    await card.click()
    const panel = page.getByRole("region", { name: new RegExp(title) })
    await panel.getByRole("button", { name: "More actions" }).click()
    await page.getByRole("menu", { name: "Task actions" }).getByRole("menuitem", { name: "Delete task…" }).click()
    await page.getByRole("dialog", { name: "Delete task?" }).getByRole("button", { name: "Delete task" }).click()
    await expect(card).toHaveCount(0)
  }

  await admin.goto("/project/website-redesign")
  await tasks.getByRole("radio", { name: "Board" }).check()
  await tasks.getByRole("button", { name: "New task in To do" }).click()
  const newTask = admin.getByRole("dialog", { name: "New task" })
  await newTask.getByLabel("Title").fill(title)
  await newTask.getByRole("button", { name: "Create task" }).click()
  await expect(card).toBeVisible()

  await deleteTask(admin)
  const toast = admin
    .getByRole("region", { name: /^Notifications/ })
    .getByRole("listitem")
    .filter({ hasText: "Task moved to the trash" })
  await toast.getByRole("button", { name: "Undo" }).click()
  await expect(card).toBeVisible()

  await deleteTask(admin)
  await admin.getByRole("link", { name: "Trash" }).click()
  const trash = admin.getByRole("list", { name: "Items in the trash" })
  await trash.getByRole("button", { name: `Restore task ${title}` }).click()
  await expect(admin.getByText(/^Restored to /)).toBeVisible()
  await expect(trash.getByText(title)).toHaveCount(0)

  await admin.goto("/project/website-redesign")
  await tasks.getByRole("radio", { name: "Board" }).check()
  await expect(card).toBeVisible()
})
