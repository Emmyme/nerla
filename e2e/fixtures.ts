import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, renameSync } from "node:fs"
import { resolve } from "node:path"
import { test as base, request, type BrowserContext, type Page } from "@playwright/test"
import { SEED_ACCOUNTS, SEED_PASSWORD, type SeedEmail } from "../server/scripts/seed/accounts"
import { API_URL, AUTH_DIR, readRun, WEB_URL } from "./stack"

export { expect } from "@playwright/test"
export { SEED_ACCOUNTS, SEED_PASSWORD }

const authFile = (email: SeedEmail) => resolve(AUTH_DIR, `${email}.json`)

/** Signs in through the API and keeps the session cookie, so journeys start signed in without the form */
export async function saveSession(email: SeedEmail): Promise<string> {
  const file = authFile(email)
  const api = await request.newContext({ baseURL: API_URL })
  try {
    const response = await api.post("/api/auth/signin", { data: { email, password: SEED_PASSWORD } })
    if (!response.ok()) throw new Error(`Signing in ${email} through the API answered ${response.status()}: ${await response.text()}`)
    mkdirSync(AUTH_DIR, { recursive: true })
    // Written aside and moved in, so a parallel worker never reads half a file
    const partial = `${file}.${process.pid}.${randomBytes(4).toString("hex")}`
    await api.storageState({ path: partial })
    renameSync(partial, file)
    return file
  } finally {
    await api.dispose()
  }
}

type Email = { subject: string; links: string[] }

type MailpitMessage = { ID: string; Created: string; Subject: string; To: { Address: string }[] | null }

// The Docker clock can run a little behind the host's
const CLOCK_SKEW_MS = 5000

async function mailpitJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Mailpit answered ${response.status} for ${url}`)
  return (await response.json()) as T
}

const linksIn = (text: string) =>
  [...text.replaceAll("&amp;", "&").matchAll(/https?:\/\/[^\s"'<>]+/g)].map(([link]) => link.replace(/[.,)]+$/, ""))

/** The newest email to exactly this address sent at or after the cutoff, waiting for it to arrive */
async function latestTo(mailpitUrl: string, address: string, after: number, timeout: number): Promise<Email> {
  // Mailpit's search matches part of an address, so the recipient is checked exactly below
  const query = encodeURIComponent(`to:"${address}"`)
  const wanted = address.toLowerCase()
  const deadline = Date.now() + timeout
  for (;;) {
    const { messages } = await mailpitJson<{ messages: MailpitMessage[] }>(`${mailpitUrl}/api/v1/search?query=${query}&limit=50`)
    const found = messages.find(
      (message) =>
        (message.To ?? []).some((to) => to.Address.toLowerCase() === wanted) && Date.parse(message.Created) >= after - CLOCK_SKEW_MS,
    )
    if (found) {
      const message = await mailpitJson<{ Subject: string; Text: string; HTML: string }>(`${mailpitUrl}/api/v1/message/${found.ID}`)
      return { subject: message.Subject, links: [...new Set([...linksIn(message.Text), ...linksIn(message.HTML)])] }
    }
    if (Date.now() > deadline) {
      throw new Error(`No email to ${address} arrived in Mailpit within ${timeout / 1000} s of waiting for it.`)
    }
    await new Promise((wait) => setTimeout(wait, 250))
  }
}

const uniqueStem = (workerIndex: number) => `${Date.now().toString(36)}${randomBytes(2).toString("hex")}-${workerIndex}`

type Fixtures = {
  /** A page in its own browser context, signed in as a seeded account from its cached session */
  asUser: (email: SeedEmail) => Promise<Page>
  mailpit: {
    /** Waits for the newest email to the address, sent since the test began or since a cutoff from mark() */
    latestTo: (address: string, options?: { after?: number; timeout?: number }) => Promise<Email>
    /** A cutoff to take just before an action, so latestTo waits for the email that action sends */
    mark: () => number
  }
  /** A name no other journey or run uses, so parallel journeys never share data */
  uniqueName: (prefix: string) => string
  /** An email address no other journey or run uses, safe to type into an address field */
  uniqueEmail: (prefix: string) => string
}

export const test = base.extend<Fixtures>({
  asUser: async ({ browser }, use) => {
    const contexts: BrowserContext[] = []
    await use(async (email) => {
      const file = existsSync(authFile(email)) ? authFile(email) : await saveSession(email)
      const context = await browser.newContext({ baseURL: WEB_URL, storageState: file })
      contexts.push(context)
      return context.newPage()
    })
    await Promise.all(contexts.map((context) => context.close()))
  },

  // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures a fixture needs from this pattern
  mailpit: async ({}, use) => {
    const { mailpitUrl } = readRun()
    const since = Date.now()
    await use({
      latestTo: (address, { after = since, timeout = 15_000 } = {}) => latestTo(mailpitUrl, address, after, timeout),
      mark: () => Date.now(),
    })
  },

  // eslint-disable-next-line no-empty-pattern -- as above
  uniqueName: async ({}, use, testInfo) => {
    let count = 0
    const stem = uniqueStem(testInfo.workerIndex)
    await use((prefix) => `${prefix} ${stem}-${++count}`)
  },

  // eslint-disable-next-line no-empty-pattern -- as above
  uniqueEmail: async ({}, use, testInfo) => {
    let count = 0
    const stem = uniqueStem(testInfo.workerIndex)
    await use((prefix) => `${prefix.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${stem}-${++count}@e2e.test`)
  },
})
