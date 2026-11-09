import { useCallback, useEffect, useRef, useState } from "react"
import { ApiError } from "@/lib/api/request"
import {
  fileBrowserAPI,
  type FileItem,
  type FileListing,
  type FileSearchQuery,
  type FileSection,
  type FileSort,
  type FolderItem,
} from "@/lib/api/files"
import type { FolderColor } from "@/lib/folderColors"
import { messageOf } from "@/lib/taskStore"

export type FilePlace = { section: FileSection; projectId?: string | null; folderId?: string | null }
type FilesOptions = { sort: FileSort; dir: "asc" | "desc"; search?: FileSearchQuery | null }
type FilesStatus = "loading" | "ready" | "error" | "missing"
export type Usage = FileListing["usage"]
export type TrailStep = { id: string; name: string; color?: FolderColor | null }

const SEARCH_DELAY_MS = 200
const LOAD_FAILED = "Couldn't load files. Check your connection and try again."

type State = {
  key: string
  status: FilesStatus
  folders: FolderItem[]
  files: FileItem[]
  usage: Usage | null
  nextCursor: string | null
  trail: TrailStep[]
  error: string | null
  loadingMore: boolean
}

const EMPTY: Omit<State, "key"> = {
  status: "loading",
  folders: [],
  files: [],
  usage: null,
  nextCursor: null,
  trail: [],
  error: null,
  loadingMore: false,
}

const placeKey = (place: FilePlace, options: FilesOptions) =>
  JSON.stringify([place.section, place.projectId ?? null, place.folderId ?? null, options.sort, options.dir, options.search ?? null])

/**
 * One section, folder or search of Files. Opening a place costs one request, a search waits until typing
 * rests and cancels the one before it.
 */
export function useFiles(place: FilePlace, options: FilesOptions) {
  const key = placeKey(place, options)
  const [state, setState] = useState<State>({ key, ...EMPTY })
  const controller = useRef<AbortController | null>(null)
  const latest = useRef({ place, options, key })
  latest.current = { place, options, key }

  const load = useCallback((keepRows: boolean, delay = 0) => {
    const { place: at, options: opts, key: forKey } = latest.current
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    setState((current) =>
      keepRows && current.key === forKey
        ? { ...current, status: current.status === "ready" ? "ready" : "loading", error: null }
        : keepRows
          ? { ...current, key: forKey, error: null }
          : { key: forKey, ...EMPTY },
    )
    const run = () => {
      const request = opts.search
        ? fileBrowserAPI.search(opts.search, abort.signal)
        : fileBrowserAPI.browse(
            { section: at.section, projectId: at.projectId, folderId: at.folderId, sort: opts.sort, dir: opts.dir },
            abort.signal,
          )
      return request.then(
        (listing) => {
          if (abort.signal.aborted) return
          setState({
            key: forKey,
            status: "ready",
            folders: listing.folders,
            files: listing.files,
            usage: listing.usage,
            nextCursor: listing.nextCursor,
            trail: listing.trail ?? [],
            error: null,
            loadingMore: false,
          })
        },
        (err: unknown) => {
          if (abort.signal.aborted) return
          const missing = err instanceof ApiError && err.status === 404
          setState((current) => ({
            ...current,
            key: forKey,
            status: missing ? "missing" : current.status === "ready" && current.key === forKey ? "ready" : "error",
            error: missing ? null : messageOf(err, LOAD_FAILED),
            loadingMore: false,
          }))
        },
      )
    }
    if (delay <= 0) {
      void run()
      return
    }
    const timer = window.setTimeout(() => void run(), delay)
    abort.signal.addEventListener("abort", () => window.clearTimeout(timer), { once: true })
  }, [])

  const searching = !!options.search
  const previousSearch = useRef(searching)
  useEffect(() => {
    // Typing keeps the last results on screen, changing place starts afresh
    const typing = searching && previousSearch.current
    previousSearch.current = searching
    load(typing, searching ? SEARCH_DELAY_MS : 0)
  }, [key, searching, load])

  useEffect(() => () => controller.current?.abort(), [])

  const refresh = useCallback(() => load(true), [load])

  const stateRef = useRef(state)
  stateRef.current = state

  const loadMore = useCallback(() => {
    const { place: at, options: opts, key: forKey } = latest.current
    const current = stateRef.current
    if (!current.nextCursor || current.loadingMore || current.key !== forKey || opts.search) return
    const cursor = current.nextCursor
    setState((now) => ({ ...now, loadingMore: true }))
    fileBrowserAPI
      .browse({ section: at.section, projectId: at.projectId, folderId: at.folderId, sort: opts.sort, dir: opts.dir, cursor })
      .then(
        (page) =>
          setState((now) =>
            now.key !== forKey
              ? now
              : // A refresh meanwhile moved the cursor, so this page would repeat rows already shown
                now.nextCursor !== cursor
                ? { ...now, loadingMore: false }
                : { ...now, files: [...now.files, ...page.files], nextCursor: page.nextCursor, usage: page.usage, loadingMore: false },
          ),
        (err: unknown) =>
          setState((now) => (now.key === forKey ? { ...now, loadingMore: false, error: messageOf(err, LOAD_FAILED) } : now)),
      )
  }, [])

  /** Changes the rows on screen at once, for an action the server has already taken */
  const update = useCallback(
    (change: (listing: { folders: FolderItem[]; files: FileItem[] }) => { folders: FolderItem[]; files: FileItem[] }) => {
      setState((current) => ({ ...current, ...change({ folders: current.folders, files: current.files }) }))
    },
    [],
  )

  const shown = state.key === key || (searching && previousSearch.current) ? state : { key, ...EMPTY }
  return {
    status: shown.status,
    error: shown.error,
    folders: shown.folders,
    files: shown.files,
    usage: shown.usage,
    trail: shown.trail,
    hasMore: shown.nextCursor !== null && !options.search,
    loadingMore: shown.loadingMore,
    loadMore,
    refresh,
    update,
  }
}
