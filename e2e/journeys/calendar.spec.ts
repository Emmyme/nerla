import { expect, test } from "../fixtures"

const DAY = /^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day \d+ [A-Z][a-z]+$/

test("an admin adds a weekly event with Fiona as a guest, next week's occurrence shows, and Fiona has the invite", async ({
  asUser,
  uniqueName,
}) => {
  const admin = await asUser("admin@nerla.com")
  const title = uniqueName("Weekly planning")
  const named = new RegExp(`^${title},`)

  await admin.goto("/calendar")
  await admin.getByRole("complementary", { name: "Calendars" }).getByRole("button", { name: "New meeting" }).click()
  const editor = admin.getByRole("region", { name: "New event" })
  await editor.getByRole("textbox", { name: "Title" }).fill(title)
  await editor.getByRole("combobox", { name: "Repeat" }).click()
  await admin.getByRole("option", { name: /^Weekly on / }).click()
  await expect(editor.getByRole("combobox", { name: "Repeat" })).toHaveText(/^Weekly on /)
  await editor.getByRole("textbox", { name: "Guests" }).fill("Fiona")
  await editor.getByRole("button", { name: "Add Fiona Placeholder" }).click()
  await expect(editor.getByRole("list", { name: "Guests" }).getByText("Fiona Placeholder")).toBeVisible()
  // It starts within the hour, and its reminder would stay on screen over the other journeys of admin and Fiona
  await editor.getByRole("combobox", { name: "Reminder" }).click()
  await admin.getByRole("option", { name: "No reminder" }).click()
  await editor.getByRole("button", { name: "Save" }).click()
  await expect(editor).toBeHidden()

  const day = admin.getByRole("group", { name: DAY }).filter({ has: admin.getByRole("button", { name: named }) })
  await expect(day).toHaveCount(1)
  const weekday = (await day.getAttribute("aria-label"))!.split(" ")[0]

  const week = await admin.getByRole("heading", { level: 1 }).textContent()
  await admin.getByRole("button", { name: "Next week" }).click()
  await expect(admin.getByRole("heading", { level: 1 })).not.toHaveText(week!)
  const nextWeek = admin.getByRole("group", { name: new RegExp(`^${weekday} `) })
  await expect(nextWeek.getByRole("button", { name: named })).toBeVisible()

  const fiona = await asUser("fiona@nerla.com")
  await fiona.goto("/calendar")
  const invite = fiona.getByRole("main").getByRole("button", { name: new RegExp(`^${title},.*Not answered`) })
  await expect(invite).toBeVisible()
  await invite.click()
  await expect(fiona.getByText("Going?")).toBeVisible()
  await expect(fiona.getByRole("radiogroup", { name: "Your reply" })).toBeVisible()
})
