export type CheckResult = { ok: boolean; skipped?: boolean; warning?: string; ms: number; error?: string }

export const CHECK_TIMEOUT_MS = 3000

/** Rejects when the work takes longer than the limit, and always clears its timer */
export async function withTimeout<T>(work: Promise<T>, limitMs = CHECK_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${limitMs / 1000} s`)), limitMs)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}

// A refused connection to every address arrives as an AggregateError with an empty message and only a code
function reasonOf(caught: unknown): string {
  if (!(caught instanceof Error)) return String(caught)
  return caught.message || (caught as NodeJS.ErrnoException).code || caught.name
}

/** Runs one check, never throws. A failure keeps the error's own short message */
export async function timedCheck(run: () => Promise<{ skipped?: boolean; warning?: string } | void>): Promise<CheckResult> {
  const start = Date.now()
  try {
    const outcome = await withTimeout(run())
    return {
      ok: true,
      ...(outcome?.skipped ? { skipped: true } : {}),
      ...(outcome?.warning ? { warning: outcome.warning } : {}),
      ms: Date.now() - start,
    }
  } catch (caught) {
    return { ok: false, ms: Date.now() - start, error: reasonOf(caught) }
  }
}
