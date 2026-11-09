export type ToolCallRequest = { id: string; name: string; arguments: string }

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

export type StreamEvent =
  { type: "text"; text: string } | { type: "tool_calls"; calls: ToolCallRequest[] } | { type: "usage"; tokens: number }

type Delta = {
  content?: unknown
  tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
}

type Chunk = {
  choices?: { delta?: Delta }[]
  usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } | null
}

const asNumber = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)

/** Reads an OpenAI style chat stream. Tool call pieces are joined by index and come out once, when the stream ends */
export async function* parseChatStream(chunks: AsyncIterable<string>): AsyncIterable<StreamEvent> {
  const calls: ToolCallRequest[] = []
  const slotOf = new Map<number, ToolCallRequest>()
  let pending = ""
  let finished = false

  function* handle(line: string): Generator<StreamEvent> {
    if (!line.startsWith("data:")) return
    const data = line.slice(5).trim()
    if (data === "[DONE]") {
      finished = true
      return
    }
    let chunk: Chunk
    try {
      chunk = JSON.parse(data) as Chunk
    } catch {
      return
    }
    const delta = chunk.choices?.[0]?.delta
    if (typeof delta?.content === "string" && delta.content) yield { type: "text", text: delta.content }
    for (const piece of delta?.tool_calls ?? []) {
      const index = piece.index ?? 0
      let slot = slotOf.get(index)
      if (!slot || (piece.id && slot.id && piece.id !== slot.id)) {
        slot = { id: piece.id || `call_${calls.length}`, name: "", arguments: "" }
        slotOf.set(index, slot)
        calls.push(slot)
      }
      if (piece.function?.name && !slot.name) slot.name = piece.function.name
      if (piece.function?.arguments) slot.arguments += piece.function.arguments
    }
    if (chunk.usage) {
      const tokens = asNumber(chunk.usage.total_tokens) || asNumber(chunk.usage.prompt_tokens) + asNumber(chunk.usage.completion_tokens)
      if (tokens > 0) yield { type: "usage", tokens }
    }
  }

  for await (const part of chunks) {
    pending += part
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ""
    for (const line of lines) yield* handle(line)
    if (finished) break
  }
  if (!finished && pending) yield* handle(pending)
  const named = calls.filter((call) => call.name)
  if (named.length) yield { type: "tool_calls", calls: named }
}
