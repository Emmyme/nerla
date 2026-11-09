/**
 * Where Left, Right, Home or End moves focus in a row of `count` controls, wrapping at the ends. A vertical list
 * moves with Up and Down instead. Null for any other key
 */
export function rovingIndex(
  key: string,
  current: number,
  count: number,
  orientation: "horizontal" | "vertical" = "horizontal",
): number | null {
  if (count === 0) return null
  const [back, forward] = orientation === "vertical" ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"]
  if (key === forward) return (current + 1) % count
  if (key === back) return (current - 1 + count) % count
  if (key === "Home") return 0
  if (key === "End") return count - 1
  return null
}
