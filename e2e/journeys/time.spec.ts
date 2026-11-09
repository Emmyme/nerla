import { readFile } from "node:fs/promises"
import { expect, test } from "../fixtures"

test("an admin times a task, stops the timer, and this week's CSV export holds a row for that task", async ({ asUser, uniqueName }) => {
  // The app logs nothing for a timer stopped under a minute, so the timer runs just past one on the real clock
  test.setTimeout(120_000)
  const admin = await asUser("admin@nerla.com")
  const title = uniqueName("Time the venue calls")

  await admin.goto("/project/website-redesign")
  await admin.getByRole("main").getByRole("button", { name: "New task", exact: true }).click()
  const newTask = admin.getByRole("dialog", { name: "New task" })
  await newTask.getByLabel("Title").fill(title)
  await newTask.getByRole("button", { name: "Create task" }).click()
  await expect(newTask).toBeHidden()

  await admin
    .getByRole("region", { name: "Tasks" })
    .getByRole("row", { name: new RegExp(title) })
    .click()
  const panel = admin.getByRole("region", { name: new RegExp(title) })
  await panel.getByRole("button", { name: "Start timer" }).click()
  // The folded sidebar shows the running clock only in a tooltip, so it opens to watch it
  await admin.getByRole("button", { name: "Expand sidebar" }).click()
  const clock = admin.getByRole("complementary", { name: "Sidebar" }).getByRole("timer")
  await expect(clock).toContainText("0:00:0")
  await expect(clock).toContainText("0:01:", { timeout: 75_000 })
  await panel.getByRole("button", { name: "Stop timer" }).click()
  await expect(admin.getByText("Logged 1m")).toBeVisible()
  await expect(clock).toHaveCount(0)

  await admin.goto("/time/reports")
  const exportButton = admin.getByRole("button", { name: "Export CSV" })
  await expect(admin.getByText(title)).toBeVisible()
  const download = admin.waitForEvent("download")
  await exportButton.click()
  const csv = await readFile((await (await download).path())!, "utf8")
  const rows = csv.split(/\r?\n/).filter((row) => row.includes(title))
  expect(rows, `The CSV has no row for ${title}:\n${csv}`).toHaveLength(1)
  expect(rows[0]).toContain("Website Redesign")
})
