export const AI_PER_HOUR = 30
export const MCP_PER_HOUR = 300
export const MAX_STEPS = 20
export const MAX_FAILS = 3

const SWEEP_AT = 5000

/** Counts takes per key over a sliding window, in memory for this process */
export class SlidingCounter {
  private readonly taken = new Map<string, number[]>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  take(key: string, now: number): boolean {
    const recent = (this.taken.get(key) ?? []).filter((at) => at > now - this.windowMs)
    if (recent.length >= this.limit) {
      this.taken.set(key, recent)
      return false
    }
    recent.push(now)
    this.taken.set(key, recent)
    if (this.taken.size > SWEEP_AT) this.sweep(now)
    return true
  }

  private sweep(now: number) {
    for (const [key, times] of this.taken) {
      if (times.every((at) => at <= now - this.windowMs)) this.taken.delete(key)
    }
  }
}

export const budgetState = (used: number, cap: number | null): "ok" | "reached" => (cap !== null && used >= cap ? "reached" : "ok")

/** Used when the model's stream reports no usage */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)
