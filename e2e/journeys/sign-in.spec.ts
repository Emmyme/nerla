import { expect, SEED_PASSWORD, test } from "../fixtures"
import { API_URL } from "../stack"

// The real form, never the cached session, since signing in is what this journey checks
test("Fiona signs in through the form, signs out, and her other tab is signed out too", async ({ page, context }) => {
  await page.goto("/")
  await expect(page).toHaveURL(/\/sign-in/)

  await page.getByLabel("Email").fill("fiona@nerla.com")
  await page.getByLabel("Password").fill(SEED_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()

  await expect(page).toHaveURL("/")
  await expect(page).toHaveTitle("Home · Nerla")
  await expect(page.getByRole("heading", { name: /^My tasks/ })).toBeVisible()

  const otherTab = await context.newPage()
  await otherTab.goto("/")
  const account = (tab: typeof page) => tab.getByRole("button", { name: /Fiona Placeholder/ })
  await expect(account(otherTab)).toBeVisible()

  // What the running tab is refused after the sign-out, which is how it finds out
  const refused: string[] = []
  otherTab.on("response", (response) => {
    if (response.status() === 401 && response.url().startsWith(API_URL)) refused.push(response.url())
  })

  await account(page).click()
  await page.getByRole("menuitem", { name: "Sign out" }).click()
  await expect(page).toHaveURL(/\/sign-in/)
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible()

  // Navigates inside the running app, as a Trashcan click does, to a page that fetches its list each time.
  // This also holds when a background request already signed the tab out
  await otherTab.evaluate(() => {
    history.pushState({}, "", "/trash")
    dispatchEvent(new PopStateEvent("popstate"))
  })
  await expect(otherTab).toHaveURL(/\/sign-in/)
  await expect(otherTab.getByRole("heading", { name: "Sign in" })).toBeVisible()
  expect(refused.length, "The other tab was never refused by the server").toBeGreaterThan(0)
})
