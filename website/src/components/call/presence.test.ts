import { describe, expect, it } from "vitest"
import { presenceLine } from "./presence"

const person = (name: string) => ({ userId: name, name })

describe("presenceLine", () => {
  it("names who is in the call and counts the rest", () => {
    expect(presenceLine({ people: [], guests: 0 })).toBe("No one else is here yet")
    expect(presenceLine({ people: [person("Jane Smith")], guests: 0 })).toBe("Jane Smith is in the call")
    expect(presenceLine({ people: [person("Jane Smith"), person("Tom Lee")], guests: 0 })).toBe("Jane Smith and Tom Lee are in the call")
    expect(presenceLine({ people: [person("Jane Smith")], guests: 2 })).toBe("Jane Smith and 2 others are in the call")
    expect(presenceLine({ people: [], guests: 1 })).toBe("A guest is in the call")
  })
})
