import { randomInt } from "node:crypto"

export function pick(items: string[]) {
  // ruleid: nerla-server-math-random
  const k = Math.random()
  // ruleid: nerla-server-math-random
  const i = Math.floor(Math.random() * items.length)
  // ok: nerla-server-math-random
  const j = randomInt(items.length)
  return [k, items[i], items[j]]
}
