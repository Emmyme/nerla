export function previews(html: string, text: string) {
  // ruleid: nerla-dangerously-set-inner-html
  const raw = <div dangerouslySetInnerHTML={{ __html: html }} />
  // ruleid: nerla-dangerously-set-inner-html
  const wrapped = <section className="body" dangerouslySetInnerHTML={{ __html: html }}></section>
  // ok: nerla-dangerously-set-inner-html
  const safe = <p className="body">{text}</p>
  return [raw, wrapped, safe]
}

// ruleid: nerla-dangerously-set-inner-html
export const props = { className: "body", dangerouslySetInnerHTML: { __html: "<b>hi</b>" } }

// ok: nerla-dangerously-set-inner-html
export const plain = { className: "body", children: "hi" }
