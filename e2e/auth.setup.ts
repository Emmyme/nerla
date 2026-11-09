import { test as setup } from "@playwright/test"
import { SEED_ACCOUNTS, saveSession } from "./fixtures"

// One sign-in per account per run, well inside the server's limit of 10 a minute
setup("sign in every seeded account once", async () => {
  for (const { email } of SEED_ACCOUNTS) await saveSession(email)
})
