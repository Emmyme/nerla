import { NotFoundView } from "@/components/ui/not-found-view"
import { useDocumentTitle } from "@/lib/useDocumentTitle"

export default function NotFound() {
  useDocumentTitle("Page not found")
  return <NotFoundView />
}
