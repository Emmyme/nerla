import { z } from "zod"
import { presenceName } from "../../utils/presence"
import { call, query, tool } from "./shared"

type Person = { id: string; email: string; firstName: string | null; lastName: string | null }

const findPeople = tool({
  name: "find_people",
  area: "people",
  write: false,
  description: "Look up teammates in the workspace by name or email, to get their ids.",
  input: z.object({ query: z.string().trim().min(2).max(100) }),
  async run(ctx, args) {
    const people = await call<Person[]>(ctx, { method: "GET", url: `/api/users/search?${query({ q: args.query })}` })
    const items = people.map((person) => ({
      ref: { kind: "person" as const, id: person.id },
      id: person.id,
      name: presenceName(person.firstName, person.lastName),
      email: person.email,
    }))
    return { ok: true, data: null, items, authors: people.map((person) => person.id) }
  },
})

export const PEOPLE_TOOLS = [findPeople]
