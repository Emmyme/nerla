import { describe, expect, it } from "vitest"
import type { Via } from "@/lib/api/ai"
import { stripMarks, viaLabel, type ViaVerb } from "./via"

describe("viaLabel", () => {
  it.each<[string, Via, ViaVerb | undefined, string]>([
    ["names the agent's token", { kind: "agent", tokenId: "t", tokenName: "Laptop" }, undefined, "Done by Emmy's agent (Laptop)"],
    ["names the AI and who it worked for", { kind: "ai" }, undefined, "Done by Nerla for Emmy"],
    ["says what was created", { kind: "ai" }, "Created", "Created by Nerla for Emmy"],
  ])("%s", (_name, via, verb, label) => {
    expect(viaLabel(via, "Emmy", "Nerla", verb)).toBe(label)
  })
})

describe("stripMarks", () => {
  it("takes off paired marks and line markers but keeps snake_case", () => {
    expect(stripMarks("# Plan\n- **one** and *two*\n- `run_tests` in snake_case_name")).toBe(
      "Plan one and two run_tests in snake_case_name",
    )
  })
})
