// Only a meeting link survives sign-in, so the return path can never point off the app
const RETURNABLE = /^\/meeting-room\/[\w-]+$/

/** Where an unauthenticated visit goes. A meeting link comes back after sign-in. */
export function signInPath(from: string): string {
  return RETURNABLE.test(from) ? `/sign-in?next=${encodeURIComponent(from)}` : "/sign-in"
}

/** Where sign-in sends the user next, from its `next` parameter */
export function returnPath(next: string | null | undefined): string {
  return next && RETURNABLE.test(next) ? next : "/"
}
