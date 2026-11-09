import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import type { HocuspocusProvider } from "@hocuspocus/provider"
import type { MentionScope, MentionUser } from "@/components/chat/MentionPicker"
import { papersAPI, type CommentAnchor, type CommentDto, type CommentThread, type DocAccess, type DocPerson } from "@/lib/api/papers"
import { namesOf } from "@/lib/mentions"
import { useAuth } from "@/providers/AuthProvider"

/** A comment about to be written: on words, a spot on a board, or the whole doc when the anchor is null */
export type Pending = { anchor: CommentAnchor | null }

export function authorName(comment: CommentDto): string {
  if (!comment.author) return "Someone"
  return "guestName" in comment.author ? comment.author.guestName : comment.author.name
}

export type CommentsStatus = "loading" | "ready" | "error"

export type DocComments = {
  fileId: string
  threads: CommentThread[]
  status: CommentsStatus
  scope: MentionScope
  /** Guests have no account, so they can't change or hide anything */
  member: boolean
  activeId: string | null
  /** The AI's name, by the threads it is working on a reply in */
  aiWorking: Record<string, string>
  setActive: (id: string | null) => void
  reload: () => void
  add: (body: string, anchor?: CommentAnchor | null) => Promise<CommentThread>
  reply: (rootId: string, body: string) => Promise<void>
  edit: (commentId: string, body: string) => Promise<void>
  remove: (commentId: string) => Promise<void>
  hide: (rootId: string) => Promise<void>
}

/** A thread's AI dots go without a word from the live server for this long, so a restart never leaves them */
const AI_WORKING_MS = 6000

/** The paper's comments, for the boards inside it */
export const DocCommentsContext = createContext<DocComments | null>(null)
export const useDocCommentsContext = () => useContext(DocCommentsContext)

const asMentionUser = (person: DocPerson): MentionUser => ({
  id: person.id,
  first_name: person.name,
  last_name: null,
  avatar_url: person.avatarUrl,
})

function withoutComment(threads: CommentThread[], id: string): CommentThread[] {
  return threads.flatMap((thread) => {
    if (thread.root.id === id) {
      return thread.replies.length ? [{ ...thread, root: { ...thread.root, deleted: true, body: "", author: null } }] : []
    }
    const replies = thread.replies.filter((reply) => reply.id !== id)
    if (replies.length === thread.replies.length) return [thread]
    return thread.root.deleted && replies.length === 0 ? [] : [{ ...thread, replies }]
  })
}

/**
 * A doc's comments for a user who may see them. One read when it mounts, and one each time the live server says they
 * changed, never on a timer. Null options mean nothing is read, for viewers
 */
export function useDocComments(
  options: {
    fileId: string
    provider: HocuspocusProvider
    access: () => Promise<DocAccess>
    member: boolean
    /** The users the host already reads, so one open reads them once */
    people?: Promise<DocPerson[]> | null
  } | null,
): DocComments | null {
  const { user } = useAuth()
  const [threads, setThreads] = useState<CommentThread[]>([])
  const [status, setStatus] = useState<CommentsStatus>("loading")
  const [people, setPeople] = useState<DocPerson[]>([])
  const [activeId, setActive] = useState<string | null>(null)
  const [aiWorking, setAiWorking] = useState<Record<string, string>>({})
  const fileId = options?.fileId ?? null
  const provider = options?.provider ?? null
  const member = options?.member ?? false
  const access = useRef(options?.access)
  access.current = options?.access
  const ask = useCallback(async () => (await access.current?.()) ?? {}, [])

  const reading = useRef(false)
  const again = useRef(false)
  const alive = useRef(true)
  const load = useCallback(async () => {
    if (!fileId) return
    if (reading.current) {
      again.current = true
      return
    }
    reading.current = true
    let retried = false
    try {
      for (;;) {
        again.current = false
        try {
          const found = await papersAPI.comments(fileId, await ask())
          if (!alive.current) return
          setThreads(found)
          setStatus("ready")
        } catch {
          if (!alive.current) return
          setStatus((was) => (was === "ready" ? was : "error"))
          // A change that came in during the failed read gets one more try, never a loop
          if (!again.current || retried) return
          retried = true
          continue
        }
        if (!again.current) return
      }
    } finally {
      reading.current = false
    }
  }, [fileId, ask])

  useEffect(() => {
    alive.current = true
    if (!provider) return
    void load()
    let signedIn = provider.isAuthenticated
    const expiry = new Map<string, ReturnType<typeof setTimeout>>()
    const stopWorking = (rootId: string) => {
      clearTimeout(expiry.get(rootId))
      expiry.delete(rootId)
      setAiWorking((all) => {
        if (!(rootId in all)) return all
        const { [rootId]: _, ...rest } = all
        return rest
      })
    }
    const onStateless = ({ payload }: { payload: string }) => {
      try {
        const message = JSON.parse(payload) as { type?: string; commentId?: unknown; name?: unknown; working?: unknown }
        if (message.type === "comments") void load()
        if (message.type !== "ai-working" || typeof message.commentId !== "string") return
        const rootId = message.commentId
        if (message.working !== true) return stopWorking(rootId)
        const name = typeof message.name === "string" ? message.name : ""
        clearTimeout(expiry.get(rootId))
        expiry.set(
          rootId,
          setTimeout(() => stopWorking(rootId), AI_WORKING_MS),
        )
        setAiWorking((all) => (all[rootId] === name ? all : { ...all, [rootId]: name }))
      } catch {
        // Not a message for comments
      }
    }
    // Messages sent while the connection was down never arrive, so coming back reads once
    const onAuthenticated = () => {
      if (signedIn) void load()
      signedIn = true
    }
    provider.on("stateless", onStateless)
    provider.on("authenticated", onAuthenticated)
    return () => {
      alive.current = false
      provider.off("stateless", onStateless)
      provider.off("authenticated", onAuthenticated)
      expiry.forEach((timer) => clearTimeout(timer))
      setAiWorking({})
    }
  }, [provider, load])

  const given = options?.people ?? null
  useEffect(() => {
    if (!fileId || !member) return
    let live = true
    void (given ?? ask().then((reach) => papersAPI.people(fileId, reach.shareId))).then(
      (found) => live && setPeople(found),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [fileId, member, ask, given])

  const scope = useMemo<MentionScope>(() => {
    const authors = threads.flatMap((thread) =>
      [thread.root, ...thread.replies].flatMap((comment) =>
        comment.author && "id" in comment.author ? [{ id: comment.author.id, first_name: comment.author.name, last_name: null }] : [],
      ),
    )
    const mine = user && { id: user.id, first_name: user.firstName, last_name: user.lastName }
    const pickable = people.map(asMentionUser)
    return { names: namesOf([mine, ...pickable, ...authors]), people: pickable, me: user?.id ?? null, ai: member }
  }, [threads, people, user, member])

  const add = useCallback(
    async (body: string, anchor?: CommentAnchor | null) => {
      const root = await papersAPI.addComment(fileId!, { body, ...(anchor ? { anchor } : {}) }, await ask())
      const thread = { root, replies: [] }
      setThreads((all) => (all.some((known) => known.root.id === root.id) ? all : [...all, thread]))
      return thread
    },
    [fileId, ask],
  )
  const reply = useCallback(
    async (rootId: string, body: string) => {
      const made = await papersAPI.addComment(fileId!, { body, parentId: rootId }, await ask())
      setThreads((all) =>
        all.map((thread) =>
          thread.root.id === rootId && !thread.replies.some((known) => known.id === made.id)
            ? { ...thread, replies: [...thread.replies, made] }
            : thread,
        ),
      )
    },
    [fileId, ask],
  )
  const edit = useCallback(
    async (commentId: string, body: string) => {
      const changed = await papersAPI.editComment(commentId, body, (await ask()).shareId)
      const swap = (comment: CommentDto) => (comment.id === changed.id ? changed : comment)
      setThreads((all) => all.map((thread) => ({ root: swap(thread.root), replies: thread.replies.map(swap) })))
    },
    [ask],
  )
  const remove = useCallback(
    async (commentId: string) => {
      await papersAPI.deleteComment(commentId, (await ask()).shareId)
      setThreads((all) => withoutComment(all, commentId))
    },
    [ask],
  )
  const hide = useCallback(
    async (rootId: string) => {
      await papersAPI.hideThread(rootId, (await ask()).shareId)
      setThreads((all) => all.filter((thread) => thread.root.id !== rootId))
      setActive((was) => (was === rootId ? null : was))
    },
    [ask],
  )

  const reload = useCallback(() => void load(), [load])
  return useMemo(
    () =>
      options && fileId
        ? { fileId, threads, status, scope, member, activeId, aiWorking, setActive, reload, add, reply, edit, remove, hide }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- options is a new object each render, so only its presence counts
    [!options, fileId, threads, status, scope, member, activeId, aiWorking, reload, add, reply, edit, remove, hide],
  )
}
