import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { across, lineOf } from "./guardSource"

/** The modules that may run a tool, since they hold the gate every AI tool call goes through */
const GATE = ["aiGate.ts", "aiToolRun.ts", "aiCards.ts"].map((name) => join("services", name))

// Any mention of runTool in code, an import or an alias included, but not its own definition
const RUN_TOOL = /(?<!function )\brunTool\b/g

/** Lines that name runTool outside comments */
function directRuns(text: string): number[] {
  return [...text.matchAll(RUN_TOOL)]
    .filter((match) => !/^\s*(\/\/|\*|\/\*)/.test(text.slice(text.lastIndexOf("\n", match.index) + 1, match.index)))
    .map((match) => lineOf(text, match.index))
}

describe("AI gate guard", () => {
  it("catches a direct tool run", () => {
    expect(directRuns('import { runTool } from "./aiTools"')).toEqual([1])
    expect(directRuns("const result = await aiTools.runTool(ctx, name, args)")).toEqual([1])
    expect(directRuns("export async function runTool(ctx: ToolContext) {}")).toEqual([])
    expect(directRuns("// runTool is only called by the gate")).toEqual([])
  })

  it("runs every AI tool call through the gate modules", () => {
    expect(across(directRuns).filter((at) => !GATE.some((file) => at.startsWith(`${file}:`)))).toEqual([])
  })
})
