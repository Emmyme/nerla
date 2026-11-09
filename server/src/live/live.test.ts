import { expect, it } from "vitest"
import { memoryLive } from "./live"

it.each([
  { name: "reaches every subscriber of its topic", topic: "user:a", heard: { a1: [1], a2: [1], b: [] } },
  { name: "reaches nothing on another topic", topic: "org:x", heard: { a1: [], a2: [], b: [] } },
  { name: "stops at a handler that unsubscribed", topic: "user:b", unsubscribe: true, heard: { a1: [], a2: [], b: [] } },
])("a published payload $name", ({ topic, unsubscribe, heard }) => {
  const live = memoryLive()
  const got: Record<string, unknown[]> = { a1: [], a2: [], b: [] }
  live.subscribe("user:a", (payload) => got.a1.push(payload))
  live.subscribe("user:a", (payload) => got.a2.push(payload))
  const leave = live.subscribe("user:b", (payload) => got.b.push(payload))
  if (unsubscribe) leave()
  live.publish(topic, 1)
  expect(got).toEqual(heard)
})
