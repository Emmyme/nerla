import { tasksAPI, type TaskSummary } from "@/lib/api/tasks"

const BATCH = 100
/** Asks made within this window go out as one request */
const GATHER_MS = 30

/**
 * The tasks a paper's lines point at. Every chip asks for its task as it mounts, and the asks of one moment go out
 * as one request, so opening a paper costs one request. A refresh reads them all again, as when the paper regains focus
 */
export class TaskSummaries {
  private known = new Map<string, TaskSummary>()
  /** Asked for and not answered, so their chips stop waiting until the next refresh */
  private failed = new Set<string>()
  private wanted = new Set<string>()
  private asked = new Set<string>()
  /** Every task any chip asked for, read again on refresh */
  private all = new Set<string>()
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get = (id: string): TaskSummary | undefined => this.known.get(id)

  hasFailed = (id: string): boolean => this.failed.has(id)

  /** A task this editor just made, known without asking */
  put(summary: TaskSummary) {
    this.all.add(summary.id)
    this.known.set(summary.id, summary)
    this.emit()
  }

  want(id: string) {
    this.all.add(id)
    if (this.known.has(id) || this.asked.has(id)) return
    this.wanted.add(id)
    this.schedule()
  }

  refresh() {
    this.failed.clear()
    for (const id of this.all) this.wanted.add(id)
    this.asked.clear()
    this.schedule()
  }

  /** While the paper is open. React may close and open it again before it is gone */
  open() {
    this.closed = false
    if (this.wanted.size > 0) this.schedule()
  }

  close() {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private emit() {
    this.listeners.forEach((listener) => listener())
  }

  private schedule() {
    if (this.timer || this.closed) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.load()
    }, GATHER_MS)
  }

  private async load() {
    const ids = [...this.wanted]
    this.wanted.clear()
    for (let at = 0; at < ids.length; at += BATCH) {
      const batch = ids.slice(at, at + BATCH)
      batch.forEach((id) => this.asked.add(id))
      try {
        const found = await tasksAPI.summaries(batch)
        for (const summary of found) {
          this.known.set(summary.id, summary)
          this.failed.delete(summary.id)
        }
      } catch {
        // A chip without its task stays plain, and the next focus asks again
        batch.forEach((id) => {
          this.asked.delete(id)
          this.failed.add(id)
        })
      }
      this.emit()
    }
  }
}
