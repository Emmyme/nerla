/** The showcase workspace's members and projects, with their profiles, statuses and colours */
import { SEED_PASSWORD } from "./accounts"
import { createProject, createWorkspace, setProfile, type Person, type Project } from "./build"
import { atClock, fromLocalNoon, weekday } from "./time"
export const WORKSPACE = "Nerla"

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"] as const
const hours = (start: string, end: string, days: readonly (typeof WEEKDAYS)[number][] = WEEKDAYS) =>
  Object.fromEntries(days.map((day) => [day, { start, end }]))

export const MEMBERS = {
  emelie: {
    // Fixed, as the avatar colour comes from the id and this one lands on lavender
    id: "4b7afa8c-ada2-4db6-976e-73093d16fdef",
    firstName: "Emelie",
    lastName: "Berg",
    role: "admin",
    profile: { jobTitle: "Studio lead", team: "Leadership", pronouns: "she/her", location: "Stockholm", timeZone: "Europe/Stockholm" },
    hours: hours("09:00", "17:00"),
  },
  john: {
    firstName: "John",
    lastName: "Doe",
    role: "member",
    profile: { jobTitle: "Product designer", team: "Design", pronouns: "he/him", location: "Stockholm", timeZone: "Europe/Stockholm" },
    hours: hours("08:00", "16:00"),
  },
  test: {
    firstName: "Test",
    lastName: "Testsson",
    role: "member",
    profile: { jobTitle: "Design lead", team: "Design", pronouns: "she/her", location: "Stockholm", timeZone: "Europe/Stockholm" },
    hours: hours("09:00", "17:00"),
  },
  jane: {
    firstName: "Jane",
    lastName: "Doe",
    role: "member",
    profile: { jobTitle: "Frontend engineer", team: "Engineering", pronouns: "he/him", location: "Lisbon", timeZone: "Europe/Lisbon" },
    hours: hours("10:00", "18:00"),
  },
  penny: {
    firstName: "Penny",
    lastName: "Placeholder",
    role: "member",
    profile: { jobTitle: "Product manager", team: "Product", pronouns: "she/her", location: "Stockholm", timeZone: "Europe/Stockholm" },
    hours: hours("08:30", "16:30"),
  },
  lorem: {
    firstName: "Lorem",
    lastName: "Ipsum",
    role: "member",
    profile: { jobTitle: "Brand designer", team: "Brand", pronouns: "she/her", location: "Toronto", timeZone: "America/Toronto" },
    hours: hours("09:00", "17:30"),
  },
} as const

export type CrewKey = keyof typeof MEMBERS
export type Crew = Record<CrewKey, Person>
export type Projects = Record<"tallow" | "sampleClient" | "system" | "website" | "research", Project>

export const emailOf = (key: CrewKey) => `${key}@nerla.test`

/** `@emelie` and the other first names as stored mention tokens */
export const withMentions = (text: string, crew: Crew) =>
  text.replace(/@([a-z]+)\b/g, (match, key: string) => (key in crew ? `@[${crew[key as CrewKey].id}]` : match))

export async function seedCrew(): Promise<Crew> {
  const keys = Object.keys(MEMBERS) as CrewKey[]
  const people = await createWorkspace(
    WORKSPACE,
    keys.map((key) => ({ email: emailOf(key), password: SEED_PASSWORD, ...MEMBERS[key] })),
    true,
  )
  const crew = Object.fromEntries(keys.map((key) => [key, people.get(emailOf(key))!])) as Crew
  const statuses: Partial<Record<CrewKey, Parameters<typeof setProfile>[2]>> = {
    john: { value: "busy", until: null },
    test: { value: "dnd", until: null },
    lorem: { value: "away", until: null },
    penny: { value: "secret", until: null },
    jane: { value: "ooo", until: atClock(weekday(0, 1), 9) },
  }
  for (const key of keys) {
    await setProfile(crew[key], { ...MEMBERS[key].profile, workingHours: MEMBERS[key].hours }, statuses[key])
  }
  return crew
}

export async function seedProjects(crew: Crew): Promise<Projects> {
  const team = (...keys: CrewKey[]) => keys.map((key) => ({ person: crew[key], role: "member" as const }))
  return {
    tallow: await createProject(crew.test, {
      name: "Sample Bakery rebrand",
      description: "A warm new identity for a neighbourhood bakery with three shops: logo, packaging and a menu system.",
      color: "#FF9CC8",
      members: team("emelie", "lorem", "john", "penny"),
      startDate: fromLocalNoon(-40).toISOString(),
      endDate: fromLocalNoon(30).toISOString(),
    }),
    sampleClient: await createProject(crew.penny, {
      name: "Client app",
      description: "A calm booking and reminders app for a group of physiotherapy clinics.",
      color: "#7CC2F7",
      members: team("emelie", "john", "jane", "test"),
      startDate: fromLocalNoon(-60).toISOString(),
      endDate: fromLocalNoon(75).toISOString(),
    }),
    system: await createProject(crew.test, {
      name: "Design system 2.0",
      description: "Shared components, tokens and guidelines for every client project.",
      color: "#DCD0FF",
      members: team("emelie", "john", "jane", "lorem"),
    }),
    website: await createProject(crew.emelie, {
      name: "Studio website",
      description: "Our own site, with new case studies and a clearer contact page.",
      color: "#D5EDB5",
      members: team("lorem", "jane", "penny"),
      endDate: fromLocalNoon(20).toISOString(),
    }),
    research: await createProject(crew.penny, {
      name: "Research library",
      description: "Interview notes, insights and the recruiting panel, in one place.",
      color: "#BFE3FF",
      members: team("emelie", "john", "test"),
    }),
  }
}
