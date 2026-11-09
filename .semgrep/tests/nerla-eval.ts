export function run(source: string) {
  // ruleid: nerla-eval
  eval(source)
  // ruleid: nerla-eval
  const made = new Function("a", source)
  // ruleid: nerla-eval
  const called = Function(source)
  // ok: nerla-eval
  const parsed = JSON.parse(source)
  return [made, called, parsed]
}
