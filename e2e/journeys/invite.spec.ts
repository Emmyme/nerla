import { expect, test } from "../fixtures"
import { WEB_URL } from "../stack"

test("an admin invites a new user from Members, who sets a password from the emailed link, skips the welcome cards and lands in the workspace", async ({
  asUser,
  browser,
  mailpit,
  uniqueEmail,
}) => {
  const admin = await asUser("admin@nerla.com")
  const email = uniqueEmail("invited")

  await admin.goto("/settings/members")
  await admin.getByRole("button", { name: "Invite", exact: true }).click()
  const form = admin.getByRole("dialog", { name: "Invite member" })
  await form.getByLabel("Email").fill(email)
  await form.getByLabel("First name").fill("Ivy")
  await form.getByLabel("Last name").fill("Invited")
  const sent = mailpit.mark()
  await form.getByRole("button", { name: "Invite", exact: true }).click()

  const ready = admin.getByRole("dialog", { name: "Invite link ready" })
  await expect(ready.getByText(`We're emailing it to ${email}. You can also copy the link above.`)).toBeVisible()
  await ready.getByRole("button", { name: "Done" }).click()
  await expect(admin.getByRole("list", { name: "Pending invitations" }).getByText(email)).toBeVisible()

  const mail = await mailpit.latestTo(email, { after: sent })
  expect(mail.subject).toBe("John Doe invited you to Nerla")
  const link = mail.links.find((found) => found.startsWith(`${WEB_URL}/sign-in?mode=activate`))
  expect(link, `The invite email has no sign-up link, only ${mail.links.join(", ")}`).toBeTruthy()

  const signedOut = await browser.newContext({ baseURL: WEB_URL })
  try {
    const page = await signedOut.newPage()
    await page.goto(link!)
    await expect(page.getByRole("heading", { name: "Set your password" })).toBeVisible()
    await expect(page.getByText(email, { exact: true })).toBeVisible()
    await page.getByLabel("Password", { exact: true }).fill("Joined@5678")
    await page.getByRole("button", { name: "Set password" }).click()

    await expect(page).toHaveURL(`${WEB_URL}/`)
    // A new account sees the welcome cards once, and Skip leaves them for good
    await page.getByRole("dialog", { name: "Welcome tour" }).getByRole("button", { name: "Skip" }).click()
    await expect(page.getByRole("heading", { name: /^My tasks/ })).toBeVisible()
    await expect(page.getByRole("button", { name: "Ivy Invited, Nerla" })).toBeVisible()
  } finally {
    await signedOut.close()
  }

  await admin.reload()
  await expect(admin.getByRole("list", { name: "Members" }).getByText(email)).toBeVisible()
})
