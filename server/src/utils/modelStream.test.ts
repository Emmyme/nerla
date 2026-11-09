import { describe, expect, it } from "vitest"
import { parseChatStream, type StreamEvent } from "./modelStream"

async function* chunks(...parts: string[]) {
  for (const part of parts) yield part
}

const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`

async function collect(source: AsyncIterable<string>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of parseChatStream(source)) events.push(event)
  return events
}

describe("parseChatStream", () => {
  it("joins one tool call's arguments split over chunks", async () => {
    const events = await collect(
      chunks(
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "create_task", arguments: '{"tit' } }] } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'le":"Buy ' } }] } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'milk"}' } }] } }] }) + "data: [DONE]\n\n",
      ),
    )
    expect(events).toEqual([{ type: "tool_calls", calls: [{ id: "call_1", name: "create_task", arguments: '{"title":"Buy milk"}' }] }])
  })

  it("gives text deltas in order, even when a line is split between chunks", async () => {
    const first = sse({ choices: [{ delta: { content: "Hel" } }] })
    const second = sse({ choices: [{ delta: { content: "lo" } }] })
    const events = await collect(chunks(first.slice(0, 20), first.slice(20) + second, "data: [DONE]\n\n"))
    expect(events).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
    ])
  })

  it("gives the token total from a usage chunk", async () => {
    const events = await collect(
      chunks(sse({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }), "data: [DONE]\n\n"),
    )
    expect(events).toEqual([{ type: "usage", tokens: 10 }])
  })
})
