import { expect, test } from "../fixtures"

test("an admin makes a project and a task, moves it on the board by keyboard and assigns it to Fiona, whose My tasks lists it", async ({
  asUser,
  uniqueName,
}) => {
  const admin = await asUser("admin@nerla.com")
  const project = uniqueName("Tasks journey")
  const title = uniqueName("Plan the kickoff")

  await admin.goto("/projects")
  await admin.getByRole("button", { name: "New project" }).click()
  const form = admin.getByRole("dialog", { name: "New project" })
  await form.getByLabel("Name").fill(project)
  await form.getByLabel("Add people").fill("Fiona")
  await form.getByRole("button", { name: "Add Fiona Placeholder" }).click()
  await expect(form.getByRole("list", { name: "People to add" }).getByText("Fiona Placeholder")).toBeVisible()
  await form.getByRole("button", { name: "Create project" }).click()
  await expect(admin.getByRole("heading", { name: project, level: 1 })).toBeVisible()

  const tasks = admin.getByRole("region", { name: "Tasks" })
  await tasks.getByRole("radio", { name: "Board" }).check()
  // A new project's board is empty, so it offers a first task in To do
  await expect(tasks.getByText("All caught up")).toBeVisible()
  await tasks.getByRole("button", { name: "New task", exact: true }).click()
  const newTask = admin.getByRole("dialog", { name: "New task" })
  await newTask.getByLabel("Title").fill(title)
  await newTask.getByRole("button", { name: "Create task" }).click()
  await expect(newTask).toBeHidden()

  const card = (column: string) => tasks.getByRole("group", { name: column }).getByRole("button", { name: new RegExp(title) })
  await expect(card("To do")).toBeVisible()

  const fiona = await asUser("fiona@nerla.com")
  await fiona.goto(admin.url())
  const fionasTasks = fiona.getByRole("region", { name: "Tasks" })
  await fionasTasks.getByRole("radio", { name: "Board" }).check()
  await expect(fionasTasks.getByRole("group", { name: "To do" }).getByRole("button", { name: new RegExp(title) })).toBeVisible()
  // Each key waits for the board to take the last one, as a screen reader user hears it
  const announced = (text: string) => expect(tasks.getByRole("status").filter({ hasText: text })).toBeAttached()
  await card("To do").focus()
  await admin.keyboard.press("Space")
  await expect(card("To do")).toHaveAttribute("aria-pressed", "true")
  await admin.keyboard.press("ArrowRight")
  await announced(`${title} is over In progress.`)
  await admin.keyboard.press("Space")
  await announced(`${title} was moved to In progress.`)
  await expect(card("In progress")).toBeVisible()
  await expect(card("To do")).toHaveCount(0)
  // Fiona's board follows the move without a reload
  await expect(fionasTasks.getByRole("group", { name: "In progress" }).getByRole("button", { name: new RegExp(title) })).toBeVisible()

  await card("In progress").click()
  const panel = admin.getByRole("region", { name: new RegExp(title) })
  await panel.getByRole("combobox", { name: /^Assignee/ }).click()
  await admin.getByRole("option", { name: "Fiona Placeholder" }).click()
  await expect(panel.getByRole("combobox", { name: "Assignee: Fiona Placeholder" })).toBeVisible()

  await fiona.goto("/")
  const mine = fiona.getByRole("region", { name: /^My tasks/ })
  await expect(mine.getByRole("group", { name: "In progress" }).getByRole("button", { name: new RegExp(title) })).toBeVisible()
})
