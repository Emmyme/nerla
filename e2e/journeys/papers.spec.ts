import { expect, test } from "../fixtures"

test("Fiona writes on the seeded paper, and Diana, who may only comment, can't type into it but adds a comment Fiona sees", async ({
  asUser,
  uniqueName,
}) => {
  const line = uniqueName("Fiona adds a launch checklist")
  const comment = uniqueName("Can we move this to Monday")

  const fiona = await asUser("fiona@nerla.com")
  await fiona.goto("/project/website-redesign")
  await fiona.getByRole("radio", { name: "Files" }).check()
  await fiona.getByRole("list", { name: "Files" }).getByRole("button", { name: "Launch plan", exact: true }).click()
  await expect(fiona.getByRole("heading", { name: "Launch plan", level: 1 }).first()).toBeVisible()
  const fionaPaper = fiona.getByRole("textbox", { name: "Paper", exact: true })
  await expect(fionaPaper).toBeEditable()
  await expect(fiona.getByRole("button", { name: "Comments", exact: true })).toBeEnabled()
  // Focus rather than a click, which could land on words a thread is about and open it
  await fionaPaper.focus()
  await fiona.keyboard.press("Control+End")
  await fiona.keyboard.press("Enter")
  await fiona.keyboard.type(line)
  await expect(fionaPaper.getByText(line)).toBeVisible()

  const diana = await asUser("diana@nerla.com")
  await diana.goto("/files/shared")
  await diana.getByRole("list", { name: "Files" }).getByRole("button", { name: "Launch plan", exact: true }).click()
  await expect(diana.getByText("Can comment")).toBeVisible()
  const dianaPaper = diana.getByRole("textbox", { name: "Paper", exact: true })
  await expect(dianaPaper.getByText(line)).toBeVisible()
  await expect(diana.getByRole("toolbar", { name: "Formatting" })).toHaveCount(0)
  await expect(dianaPaper).not.toBeEditable()

  const goals = dianaPaper.getByText("Ship the new website before the spring campaign")
  await goals.click()
  await diana.keyboard.type("Diana typed this")
  await expect(dianaPaper.getByText("Diana typed this")).toHaveCount(0)

  await goals.click({ clickCount: 3 })
  await diana.getByRole("button", { name: "Comments", exact: true }).click()
  await diana.getByLabel("New comment").fill(comment)
  await diana.getByRole("button", { name: "Comment", exact: true }).click()
  await expect(diana.getByRole("article", { name: "Comment by Diana Example" }).getByText(comment)).toBeVisible()

  await fiona.getByRole("button", { name: "Comments", exact: true }).click()
  await expect(fiona.getByRole("article", { name: "Comment by Diana Example" }).getByText(comment)).toBeVisible()
  // Diana's comment came through, so anything she had typed would have reached Fiona by now too
  await expect(fionaPaper.getByText("Diana typed this")).toHaveCount(0)
})
