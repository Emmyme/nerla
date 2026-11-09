import { chromium } from "playwright"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const BASE = "http://localhost:3001"
const args = process.argv.slice(2)
const phone = args.includes("--phone")
const modeArg = args.find((a) => !a.startsWith("--"))
if (modeArg !== "light" && modeArg !== "dark") {
  console.error("usage: shots <light|dark> [--phone]")
  process.exit(2)
}
const mode = modeArg
const viewport = phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".screenshots", phone ? `${mode}-phone` : mode)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let rateLimited = 0
let tripped = false
let failures = 0
let page

async function settle() {
  await page.waitForFunction(() => !document.body.innerText.includes("Loading..."), null, { timeout: 30000 })
  await sleep(600)
}

async function openLink(selector, pathTest) {
  const link = page.locator(`${selector} >> visible=true`).first()
  await link.waitFor({ state: "visible", timeout: 5000 })
  await link.click()
  await page.waitForURL((url) => pathTest(url.pathname), { timeout: 10000 })
}

async function away() {
  await page.mouse.move(viewport.width - 4, viewport.height - 4)
  await sleep(150)
}

async function shoot(name) {
  await away()
  await page.screenshot({ path: path.join(outDir, `${name}.png`) })
  console.log(`captured ${name}`)
}

async function step(name, fn) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    tripped = false
    try {
      await fn()
      if (tripped) throw new Error("429 during step")
      await shoot(name)
      return
    } catch (err) {
      console.log(`${name} attempt ${attempt + 1} failed: ${String(err.message).split("\n")[0]}`)
      if (attempt === 0) {
        if (tripped) {
          console.log("429 seen, waiting 60s")
          await sleep(60000)
          tripped = false
        }
        await page.keyboard.press("Escape").catch(() => {})
        await page.reload().catch(() => {})
        await settle().catch(() => {})
      }
    }
  }
  failures += 1
  console.log(`FAILED ${name}`)
}

const nav = (name, selector, pathTest) =>
  step(name, async () => {
    await openLink(selector, pathTest)
    await settle()
  })

const visit = (name, route) =>
  step(name, async () => {
    await page.goto(`${BASE}${route}`)
    await settle()
  })

async function settingsPages() {
  await visit("settings-profile", "/settings/profile")
  await visit("settings-calendar", "/settings/calendar")
  await visit("settings-workspace", "/settings/workspace")
  await visit("settings-members", "/settings/members")
  await step("select-open", async () => {
    await page
      .getByRole("combobox", { name: /^Role for / })
      .locator("visible=true")
      .first()
      .click({ timeout: 5000 })
    await page.getByRole("listbox").waitFor({ state: "visible", timeout: 5000 })
    await sleep(300)
  })
  await page.keyboard.press("Escape")
  if (phone) return
  await step("user-menu", async () => {
    await page.locator('button[aria-haspopup="menu"] >> visible=true').first().click({ timeout: 5000 })
    await page.getByRole("menu").waitFor({ state: "visible", timeout: 5000 })
    await sleep(300)
  })
  await page.keyboard.press("Escape")
}

async function calendarView(name, label) {
  await step(name, async () => {
    await page.getByRole("radio", { name: label, exact: true }).click({ timeout: 5000 })
    await sleep(900)
  })
}

async function restoreCalendarView(label) {
  await page
    .getByRole("radio", { name: label, exact: true })
    .click({ timeout: 5000 })
    .catch(() => {})
  await sleep(300)
}

// A free spot in the last day column, below the sticky header, for a click-to-create
async function emptySlot() {
  return page.evaluate(() => {
    const days = [...document.querySelectorAll('[role="group"][aria-label]')].filter((g) =>
      /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) /.test(g.getAttribute("aria-label") ?? ""),
    )
    const column = days[days.length - 1]
    if (!column) return null
    const box = column.getBoundingClientRect()
    const scroller = column.closest(".overflow-y-auto")?.getBoundingClientRect()
    const x = box.left + box.width / 2
    for (let y = (scroller?.top ?? 0) + 220; y < (scroller?.bottom ?? window.innerHeight) - 60; y += 24) {
      const hit = document.elementFromPoint(x, y)
      if (hit && column.contains(hit) && !hit.closest("[data-event-key]")) return { x, y }
    }
    return null
  })
}

async function quickCreate() {
  await step("calendar-quick-create", async () => {
    const spot = await emptySlot()
    if (!spot) throw new Error("no empty slot")
    await page.mouse.click(spot.x, spot.y)
    await page.getByRole("textbox", { name: "Title" }).waitFor({ state: "visible", timeout: 5000 })
    await page.keyboard.type("Design sync")
    await sleep(400)
  })
  await page.keyboard.press("Escape")
  await page
    .getByRole("dialog")
    .waitFor({ state: "hidden", timeout: 5000 })
    .catch(() => {})
}

async function createFromButton(name, view) {
  await page
    .getByRole("radio", { name: view, exact: true })
    .click({ timeout: 5000 })
    .catch(() => {})
  await sleep(600)
  await step(name, async () => {
    await page.getByRole("button", { name: "Create", exact: true }).locator("visible=true").first().click({ timeout: 5000 })
    await page.getByRole("textbox", { name: "Title" }).waitFor({ state: "visible", timeout: 5000 })
    await sleep(500)
  })
  await page.keyboard.press("Escape")
  await page
    .getByRole("dialog")
    .waitFor({ state: "hidden", timeout: 5000 })
    .catch(() => {})
}

async function projectPanel() {
  await step("project-panel", async () => {
    await page.locator("[data-task-id] >> visible=true").first().click({ timeout: 5000 })
    await page.locator("[data-task-panel]").waitFor({ state: "visible", timeout: 5000 })
    await sleep(600)
  })
  await page
    .getByRole("button", { name: "Close task" })
    .click()
    .catch(() => {})
  await page
    .locator("[data-task-panel]")
    .waitFor({ state: "hidden", timeout: 5000 })
    .catch(() => {})
}

const browser = await chromium.launch()
try {
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  const context = await browser.newContext({ viewport })
  await context.addInitScript((m) => {
    try {
      localStorage.setItem("nerla-mode", m)
    } catch {
      // The page falls back to its default mode when storage is blocked
    }
  }, mode)
  page = await context.newPage()
  page.on("response", (res) => {
    if (res.status() === 429) {
      rateLimited += 1
      tripped = true
    }
  })

  await page.goto(`${BASE}/sign-in`)
  await page.locator("#email").fill("admin@nerla.com")
  await page.locator("#password").fill("Test@1234")
  await page.locator('button[type="submit"]').click()
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 30000 })
  await page.reload()
  await settle()

  const is = (p) => (x) => x === p
  await step("home", async () => {
    if (new URL(page.url()).pathname !== "/") throw new Error(`unexpected landing ${page.url()}`)
    await settle()
  })

  if (phone) {
    await nav("messages", 'a[href="/messages"]', is("/messages"))
    await nav("calendar", 'a[href="/calendar"]', is("/calendar"))
    await calendarView("calendar-schedule", "Schedule")
    await calendarView("calendar-3-days", "3 days")
    await restoreCalendarView("Day")
    await quickCreate()
    await createFromButton("calendar-create-day", "Day")
    await step("calendar-event", async () => {
      await page.locator('[role="group"] button[aria-label*=", "] >> visible=true').last().click({ timeout: 5000 })
      await page.getByRole("dialog").waitFor({ state: "visible", timeout: 5000 })
      await sleep(400)
    })
    await page.keyboard.press("Escape")
    await page
      .getByRole("dialog")
      .waitFor({ state: "hidden", timeout: 5000 })
      .catch(() => {})
    await step("calendar-sheet", async () => {
      await page.getByRole("button", { name: "Open calendars" }).click({ timeout: 5000 })
      await page.getByRole("dialog").waitFor({ state: "visible", timeout: 5000 })
      await sleep(400)
    })
    await page.keyboard.press("Escape")
    await nav("projects", 'a[href="/projects"]', is("/projects"))
    await step("project", async () => {
      if (!new URL(page.url()).pathname.startsWith("/project/")) {
        await page.locator('main a[href^="/project/"] >> visible=true').first().click({ timeout: 5000 })
        await page.waitForURL((url) => url.pathname.startsWith("/project/"), { timeout: 10000 })
      }
      await settle()
    })
    await projectPanel()
    await visit("settings", "/settings")
    await settingsPages()
    await step("more-sheet", async () => {
      await page.getByRole("button", { name: "More" }).click()
      await page.getByRole("dialog", { name: "More" }).waitFor({ state: "visible", timeout: 5000 })
      await sleep(400)
    })
    await page.keyboard.press("Escape")
  } else {
    await nav("messages", 'a[href="/messages"]', is("/messages"))
    await nav("calendar", 'a[href="/calendar"]', is("/calendar"))
    await calendarView("calendar-month", "Month")
    await calendarView("calendar-schedule", "Schedule")
    await calendarView("calendar-day", "Day")
    await restoreCalendarView("Week")
    await nav("projects", 'a[href="/projects"]', is("/projects"))
    await nav("project", 'a[href^="/project/"]', (p) => p.startsWith("/project/"))
    await projectPanel()
    await settingsPages()

    await nav("calendar-again", 'a[href="/calendar"]', is("/calendar"))
    await step("calendar-event", async () => {
      await page.locator('[role="group"] button[aria-label*=", "] >> visible=true').last().click({ timeout: 5000 })
      await page.getByRole("dialog").waitFor({ state: "visible", timeout: 5000 })
      await sleep(400)
    })
    await page.keyboard.press("Escape")
    await page
      .getByRole("dialog")
      .waitFor({ state: "hidden", timeout: 5000 })
      .catch(() => {})
    await quickCreate()
    await createFromButton("calendar-create-week", "Week")
    await createFromButton("calendar-create-day", "Day")
    await createFromButton("calendar-create-month", "Month")
    await restoreCalendarView("Week")

    await step("sidebar-collapsed", async () => {
      await page.getByRole("button", { name: "Collapse sidebar" }).click()
      await sleep(400)
    })
    await page.getByRole("button", { name: "Expand sidebar" }).click()
    await sleep(400)

    await step("focus-nav", async () => {
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
      let onNav = false
      for (let i = 0; i < 20 && !onNav; i += 1) {
        await page.keyboard.press("Tab")
        onNav = await page.evaluate(() => {
          const el = document.activeElement
          return !!el && el.tagName === "A" && !!el.closest("aside, nav")
        })
      }
      if (!onNav) throw new Error("focus never reached a sidebar link")
    })
  }

  console.log(`mode=${mode} phone=${phone} http429=${rateLimited} failures=${failures}`)
} finally {
  await browser.close()
}
process.exitCode = failures > 0 ? 1 : 0
