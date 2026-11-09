/** The accounts the seed makes. Plain data with no imports, so the e2e package can read it without a database */

export type SeedWorkspace = "Nerla" | "Other"

export type SeedAccount = {
  email: string
  password: string
  name: string
  firstName: string
  lastName: string
  workspace: SeedWorkspace
  /** The role in the workspace */
  role: "admin" | "member"
}

export const SEED_PASSWORD = "Test@1234"

export const SEED_ACCOUNTS = [
  {
    email: "admin@nerla.com",
    password: SEED_PASSWORD,
    name: "John Doe",
    firstName: "John",
    lastName: "Doe",
    workspace: "Nerla",
    role: "admin",
  },
  {
    email: "fiona@nerla.com",
    password: SEED_PASSWORD,
    name: "Fiona Placeholder",
    firstName: "Fiona",
    lastName: "Placeholder",
    workspace: "Nerla",
    role: "member",
  },
  {
    email: "diana@nerla.com",
    password: SEED_PASSWORD,
    name: "Diana Example",
    firstName: "Diana",
    lastName: "Example",
    workspace: "Nerla",
    role: "member",
  },
  {
    email: "olga@other.test",
    password: SEED_PASSWORD,
    name: "Olga Other",
    firstName: "Olga",
    lastName: "Other",
    workspace: "Other",
    role: "admin",
  },
] as const satisfies readonly SeedAccount[]

export type SeedEmail = (typeof SEED_ACCOUNTS)[number]["email"]
