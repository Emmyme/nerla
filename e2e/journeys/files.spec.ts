import { readFile } from "node:fs/promises"
import { expect, test } from "../fixtures"
import { WEB_URL } from "../stack"

test("an admin uploads a text file to a project and shares it by link, which opens and downloads signed out", async ({
  asUser,
  browser,
  uniqueName,
}) => {
  const admin = await asUser("admin@nerla.com")
  const name = `${uniqueName("Venue notes").replaceAll(" ", "-")}.txt`
  const text = `Venue notes\n\n${name}\n`

  await admin.goto("/project/website-redesign")
  const files = admin.getByRole("region", { name: "Files" })
  await admin.getByRole("radio", { name: "Files" }).check()
  await files.getByRole("button", { name: "New" }).click()
  const chooser = admin.waitForEvent("filechooser")
  await admin.getByRole("menuitem", { name: "Upload" }).click()
  await (await chooser).setFiles({ name, mimeType: "text/plain", buffer: Buffer.from(text) })
  await expect(files.getByRole("list", { name: "Files" }).getByRole("button", { name, exact: true })).toBeVisible()

  await files.getByRole("button", { name: `Actions for ${name}` }).click()
  await admin.getByRole("menuitem", { name: "Get link…" }).click()
  const dialog = admin.getByRole("dialog", { name: `Link to ${name}` })
  await dialog.getByRole("button", { name: "Create link" }).click()
  const url = await dialog.getByRole("textbox", { name: "New link" }).inputValue()
  expect(url).toMatch(new RegExp(`^${WEB_URL}/s/`))

  const signedOut = await browser.newContext({ baseURL: WEB_URL })
  try {
    const page = await signedOut.newPage()
    await page.goto(url)
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible()
    const button = page.getByRole("link", { name: "Download" })

    const href = await button.getAttribute("href")
    expect((await signedOut.request.get(href!)).status()).toBe(200)

    const download = page.waitForEvent("download")
    await button.click()
    const saved = await download
    expect(saved.suggestedFilename()).toBe(name)
    expect(await readFile((await saved.path())!, "utf8")).toBe(text)
  } finally {
    await signedOut.close()
  }
})
