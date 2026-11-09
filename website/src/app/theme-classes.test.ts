import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { cn } from "@/lib/utils"

const srcDir = resolve(__dirname, "..")
const globals = readFileSync(resolve(__dirname, "globals.css"), "utf8")

function themeKeys(): Set<string> {
  const start = globals.indexOf("@theme inline")
  const block = globals.slice(globals.indexOf("{", start), globals.indexOf("\n}", start))
  return new Set([...block.matchAll(/--color-([\w-]+):/g)].map((m) => m[1]))
}

// Every word of the file, so copy, apostrophes and multi-line template literals cannot hide a class
const fileTokens = (text: string) => text.split(/[\s"'`{}(),]+/).filter(Boolean)
// Splits a class into its variants and its utility, ignoring colons inside brackets and dropping important marks
const parse = (token: string) => {
  const variants: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < token.length; i++) {
    if (token[i] === "[") depth++
    else if (token[i] === "]") depth--
    else if (token[i] === ":" && depth === 0) {
      variants.push(token.slice(start, i))
      start = i + 1
    }
  }
  return { token, variants, utility: token.slice(start).replace(/^!|!$/g, "") }
}
const utilityOf = (token: string) => parse(token).utility

// Reads from an opening quote or bracket to its match, skipping strings so arrows and brackets inside them do not count
const readValue = (text: string, start: number) => {
  const open = text[start]
  if (open === '"' || open === "'") return text.slice(start + 1, text.indexOf(open, start + 1))
  let depth = 0
  let quote: string | null = null
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === "\\") i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch
    else if ("({[".includes(ch)) depth++
    else if (")}]".includes(ch) && --depth === 0) return text.slice(start + 1, i)
  }
  return text.slice(start + 1)
}

// The props and children of every tag of this name, however many lines its opening tag spans
const jsxTags = (text: string, tag: string) => {
  const found: { props: Map<string, string>; children: string; spread: boolean }[] = []
  // The tag names are fixed in this file
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  for (const m of text.matchAll(new RegExp(String.raw`<${tag}(?=[\s/>])`, "g"))) {
    const props = new Map<string, string>()
    let spread = false
    let i = m.index + m[0].length
    while (i < text.length && text[i] !== ">" && text[i] !== "/") {
      const attr = /^\s*([\w-]+)(=)?/.exec(text.slice(i))
      if (!attr || !attr[0].trim()) {
        if (/\s/.test(text[i])) {
          i++
          continue
        }
        if (text[i] === "{") {
          spread = true
          i += readValue(text, i).length + 2
          continue
        }
        break
      }
      i += attr[0].length
      if (!attr[2]) {
        props.set(attr[1], "")
        continue
      }
      const value = readValue(text, i)
      props.set(attr[1], value)
      i += value.length + 2
    }
    const close = text.indexOf(`</${tag}>`, i)
    const children = text[i] === ">" && close !== -1 ? text.slice(i + 1, close) : ""
    found.push({ props, children, spread })
  }
  return found
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(tsx?|css)$/.test(name) && !/\.test\./.test(name) ? [path] : []
  })
}

// Walked and read once for every case below, as doing it again per case times out on a busy machine
const files = sourceFiles(srcDir)
const texts = new Map(files.map((file) => [file, readFileSync(file, "utf8")]))
const read = (file: string) => texts.get(file) ?? ""
const code = files.filter((file) => !file.endsWith(".css"))

describe("tailwind color classes", () => {
  it("only use text-text, bg-background and border-border keys that the theme defines", () => {
    const keys = themeKeys()
    const pattern = /\b(?:text|bg|border|divide|ring|fill|stroke)-((?:text|background|border)-[a-z]+)(?:\/\d+)?(?![\w-])/g
    const unknown: string[] = []
    for (const file of files) {
      for (const m of read(file).matchAll(pattern)) if (!keys.has(m[1])) unknown.push(`${file.slice(srcDir.length + 1)}: ${m[0]}`)
    }
    expect(unknown).toEqual([])
  })
})

describe("focus and error colors", () => {
  it("never use ring-accent or border-accent inside focus variants", () => {
    const pattern = /\b(?:focus|focus-visible|focus-within):[^\s"'`]*(?:ring|border)-accent/g
    const found: string[] = []
    for (const file of files) {
      for (const m of read(file).matchAll(pattern)) found.push(`${file.slice(srcDir.length + 1)}: ${m[0]}`)
    }
    expect(found).toEqual([])
  })

  it("never use stock red color classes", () => {
    const pattern = /\b[\w:-]*(?:text|bg|border|ring|fill|stroke|from|to|via|divide|outline|shadow|decoration|placeholder)-red-\d+/g
    const found: string[] = []
    for (const file of files) {
      for (const m of read(file).matchAll(pattern)) found.push(`${file.slice(srcDir.length + 1)}: ${m[0]}`)
    }
    expect(found).toEqual([])
  })
})

describe("accent text", () => {
  it("never uses text-accent, which is the pink fill, for text", () => {
    const found: string[] = []
    for (const file of code) {
      for (const m of read(file).matchAll(/(?<![^\s"'`])(?:[^\s"'`:]+:)*text-accent(?:\/\d+)?(?![\w-])/g))
        found.push(`${file.slice(srcDir.length + 1)}: ${m[0]}`)
    }
    expect(found).toEqual([])
  })
})

describe("soft fills", () => {
  it("pair every bg-app-*-soft fill with its matching ink text color", () => {
    const found: string[] = []
    const quoted = /(["'`])((?:(?!\1)[^\n])*)\1/g
    const fillRe = /(?<![^\s"'`])((?:[\w-]+:)*)bg-app-(pistachio|bubblegum|sky|lavender|lemon)-soft(?![\w-])/g
    const textRe = /(?<![^\s"'`])((?:[\w-]+:)*)text-(foreground|app-[a-z]+-(?:ink|text))(?![\w-])/g
    for (const file of code) {
      for (const m of read(file).matchAll(quoted)) {
        const s = m[2]
        for (const [, prefix, tone] of s.matchAll(fillRe)) {
          const bad = [...s.matchAll(textRe)].filter((t) => t[1] === prefix && t[2] !== `app-${tone}-ink`)
          if (bad.length > 0) found.push(`${file.slice(srcDir.length + 1)}: ${s}`)
        }
      }
    }
    expect(found).toEqual([])
  })
})

describe("design scale", () => {
  const offScale = [
    /(?<![\w-])rounded(?:-[trblse]{1,2})?-\[(?!inherit\])[^\]]*\]/g,
    /(?<![\w-])rounded(?:-[trblse]{1,2})?-(?:2xl|3xl|4xl)(?![\w-])/g,
    /(?<![\w-])text-\[[\d.]+(?:rem|px|em)\]/g,
    /(?<![\w-])text-(?:xs|sm|base|lg|xl|[2-9]xl)(?![\w-])/g,
    /(?<![\w-])font-\[\d+\]/g,
    /(?<![\w-])font-(?:extrabold|black)(?![\w-])/g,
    /(?<![\w[-])-?(?:space-[xy]|gap-[xy]|gap|p[xytblrse]?|m[xytblrse]?)-\[-?[\d.]+(?:rem|px|em)\]/g,
  ]

  // Display type kept off the scale: the heavy 404 digits and the sleeping cat's z's
  const displayType = new Set([
    "components/ui/not-found-view.tsx: text-[6rem]",
    "components/ui/not-found-view.tsx: font-extrabold",
    "components/ui/cat-scenes.tsx: font-extrabold",
  ])

  it("keeps radius, type size, weight and spacing classes on the scale", () => {
    const found: string[] = []
    for (const file of code) {
      const name = file.slice(srcDir.length + 1).replace(/\\/g, "/")
      const text = read(file)
      for (const pattern of offScale)
        for (const m of text.matchAll(pattern)) if (!displayType.has(`${name}: ${m[0]}`)) found.push(`${name}: ${m[0]}`)
    }
    expect(found).toEqual([])
  })

  it("keeps font-bold to page titles", () => {
    const allowed = ["components/shell/PageHeader.tsx", "components/calendar/CalendarToolbar.tsx", "components/call/Prejoin.tsx"]
    const found: string[] = []
    for (const file of code) {
      const name = file.slice(srcDir.length + 1).replace(/\\/g, "/")
      if (allowed.includes(name)) continue
      for (const m of read(file).matchAll(/(?<![\w-])font-bold(?![\w-])/g)) found.push(`${name}: ${m[0]}`)
    }
    expect(found).toEqual([])
  })

  const opacity = String.raw`(?:\/(?:\d+|\[[^\]]+\]))?`
  const colorProps =
    "text|bg|border(?:-[trblxyse])?|ring(?:-offset)?|fill|stroke|from|to|via|divide|outline|shadow|decoration|placeholder|accent|caret"
  const palette =
    "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone"
  const rules: [string, RegExp][] = [
    ["arbitrary hex", /-\[#|\[[\w-]+:#[\da-fA-F]/],
    ["stock palette", new RegExp(`^(?:${colorProps})-(?:${palette})-\\d+${opacity}$`)],
    ["raw white or black", new RegExp(`^(?:${colorProps})-(?:white|black)${opacity}$`)],
    [
      "old alias",
      new RegExp(`^(?:text|bg|border|divide|ring|fill|stroke)-(?:text|background|border)-(?:primary|secondary|tertiary|muted)${opacity}$`),
    ],
    ["old utility", /^(?:glass|glass-raised|page-title|heading-lg|heading-xl|section-label|shadow-card|shadow-card-hover)$/],
  ]
  const classify = (token: string) => {
    const utility = utilityOf(token)
    return rules.filter(([, pattern]) => pattern.test(token) || pattern.test(utility)).map(([rule]) => rule)
  }
  const scan = (text: string) => fileTokens(text).flatMap((token) => classify(token).map((rule) => ({ rule, token })))

  it("catches the color and utility forms it guards against", () => {
    const caught = [
      "data-[state=open]:bg-gray-100",
      "has-[:checked]:glass",
      "[&_svg]:text-white",
      "!bg-black",
      "bg-black!",
      "hover:!text-emerald-500",
      "bg-white/[0.4]",
      "text-sky-500/[.5]",
      "ring-offset-blue-200",
      "border-t-rose-300",
      "bg-[#c42b1c]",
      "[color:#fff]",
      "max-lg:text-text-secondary",
      "group-hover:section-label",
    ]
    for (const token of caught) expect(classify(token), token).not.toEqual([])
    const multiLine = '<div className={`p-3 ${open ? "x" : ""}\n      bg-zinc-200`} />'
    expect(scan(multiLine).map((f) => f.token)).toEqual(["bg-zinc-200"])
    const apostrophes = `<p>Don't worry</p><span className="bg-gray-100">It's fine</span>`
    expect(scan(apostrophes).map((f) => f.token)).toEqual(["bg-gray-100"])

    const fine = [
      "bg-app-sky",
      "text-app-sky-ink",
      "hover:bg-app-sky-soft",
      "bg-app-bg/90",
      "text-app-on-accent",
      "border-border",
      "text-foreground",
      "whitespace-nowrap",
      "rounded-[inherit]",
      "aria-busy:opacity-50",
      "data-[state=open]:bg-app-selected",
      "glassy",
      "white",
      "neutral",
      "#1",
    ]
    for (const token of fine) expect(classify(token), token).toEqual([])
  })

  it("uses theme tokens, never hex, stock palette, raw white or black, or the old utilities", () => {
    const whiteAllowed = [
      "components/ui/button.tsx",
      "components/calendar/ReminderScheduler.tsx",
      "components/ui/shortcut-hint.tsx",
      "components/chat/DockedChat.tsx",
    ]
    const found: string[] = []
    for (const file of code) {
      const name = file.slice(srcDir.length + 1).replace(/\\/g, "/")
      for (const { rule, token } of scan(read(file))) {
        if (rule === "raw white or black" && whiteAllowed.includes(name)) continue
        found.push(`${name}: ${rule} ${token}`)
      }
    }
    expect(found).toEqual([])
  })

  it("lets the named type steps merge as sizes, not colors", () => {
    expect(cn("text-ui text-foreground")).toBe("text-ui text-foreground")
    expect(cn("text-caption", "text-body")).toBe("text-body")
  })
})

describe("button sizing", () => {
  // A class string kept in a constant of the same file counts where the constant is used
  const buttonClassNames = (text: string) => {
    const constants = new Map([...text.matchAll(/\bconst ([A-Z][A-Z\d_]*) =\s*(["'`])([^"'`]*)\2/g)].map((m) => [m[1], m[3]]))
    return jsxTags(text, "Button").flatMap(({ props }) => {
      const className = props.get("className")
      return className === undefined ? [] : className.replace(/\b[A-Z][A-Z\d_]*\b/g, (name) => constants.get(name) ?? name)
    })
  }

  const sizing = [
    /^(?:min-|max-)?h-/,
    /^p[ytb]-/,
    /^text-(?:micro|caption|ui|body|lead|title|page)$/,
    /^text-\[(?:length:|[\d.]|calc\(|clamp\()/,
  ]
  const sizingTokens = (className: string) => fileTokens(className).filter((token) => sizing.some((rule) => rule.test(utilityOf(token))))
  const scanButtons = (text: string) => buttonClassNames(text).flatMap(sizingTokens)

  it("catches the sizing forms it guards against", () => {
    const caught: [string, string[]][] = [
      ['<Button className="h-9 w-full">Save</Button>', ["h-9"]],
      ['<Button variant="ghost" className="max-lg:min-h-11">Go</Button>', ["max-lg:min-h-11"]],
      [
        '<Button\n  type="button"\n  onClick={() => go(a > b)}\n  className={cn("gap-2", open && "lg:!py-1")}\n>\n  Go\n</Button>',
        ["lg:!py-1"],
      ],
      ['<Button className={`px-2 ${wide ? "pt-2" : ""} text-caption`} />', ["pt-2", "text-caption"]],
      ['<Button size="sm" className="text-[0.8rem] max-h-8" />', ["text-[0.8rem]", "max-h-8"]],
      ['<Button {...rest} className="pb-1 hover:text-body" />', ["pb-1", "hover:text-body"]],
      ['const TIGHT =\n  "h-7 px-2"\n<Button className={cn(TIGHT, "gap-1")}>Go</Button>', ["h-7"]],
    ]
    for (const [source, tokens] of caught) expect(scanButtons(source), source).toEqual(tokens)
    const fine = [
      '<Button className="w-full gap-2 mt-2 px-2 size-11 rounded-full bg-app-sky text-app-sky-ink">Go</Button>',
      '<Button className="text-[var(--color-text-on-accent)] ml-auto">Go</Button>',
      '<ButtonGroup className="h-8" />',
      '<button className="h-8 py-1 text-caption" />',
      '<Button onClick={() => (a > b ? "h-8" : "")} className="w-24">Go</Button>',
    ]
    for (const source of fine) expect(scanButtons(source), source).toEqual([])
  })

  it("leaves Button height, vertical padding and type size to the size prop", () => {
    const found: string[] = []
    for (const file of files) {
      if (!file.endsWith(".tsx")) continue
      const name = file.slice(srcDir.length + 1).replace(/\\/g, "/")
      for (const token of scanButtons(read(file))) found.push(`${name}: ${token}`)
    }
    expect(found).toEqual([])
  })

  const iconChild = /<(?:svg|[A-Z][\w.]*)[\s/>]/
  const crowded = (text: string) =>
    jsxTags(text, "Button").filter(({ props, children }) => props.has("shortcut") && iconChild.test(children)).length

  it("catches a shortcut button with an icon child", () => {
    const caught = [
      '<Button shortcut="U" onClick={go}>\n  <Upload aria-hidden="true" className="size-[1rem]" />\n  Upload\n</Button>',
      '<Button\n  type="button"\n  shortcut={open ? undefined : "C"}\n>\n  <svg viewBox="0 0 16 16" />\n  New\n</Button>',
      '<Button variant="sky" shortcut="N"><Icons.Plus />New</Button>',
    ]
    for (const source of caught) expect(crowded(source), source).toBe(1)
    const fine = [
      '<Button shortcut="C" onClick={() => go(a > b)}>\n  New task\n</Button>',
      '<Button onClick={go}>\n  <Upload aria-hidden="true" />\n  Upload\n</Button>',
      '<Button shortcut="C"><span className="truncate">{label}</span></Button>',
      '<Button size="icon" aria-label="Upload" />',
    ]
    for (const source of fine) expect(crowded(source), source).toBe(0)
  })

  it("gives a button an icon or a shortcut, never both", () => {
    const found: string[] = []
    for (const file of files) {
      if (!file.endsWith(".tsx")) continue
      const name = file.slice(srcDir.length + 1).replace(/\\/g, "/")
      if (crowded(read(file))) found.push(name)
    }
    expect(found).toEqual([])
  })
})

describe("accessible names", () => {
  const nameProps = ["aria-label", "aria-labelledby", "title"]
  const iconsOf = (text: string) =>
    new Set(
      [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@\/components\/icons"/g)].flatMap((m) =>
        m[1].split(",").map((part) =>
          part
            .trim()
            .split(/\s+as\s+/)
            .at(-1)!,
        ),
      ),
    )
  // Only icons and plain marks, with no text and no expression that could render some
  const iconOnly = (children: string, icons: Set<string>) => {
    const inside = children.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    const components = [...inside.matchAll(/<([A-Z][\w.]*)/g)].map((m) => m[1])
    return !/sr-only/.test(inside) && !/\S/.test(inside.replace(/<[^>]*>/g, "")) && components.every((name) => icons.has(name))
  }
  const unnamed = (text: string) => {
    const icons = iconsOf(text)
    return ["Button", "button"].flatMap((tag) =>
      jsxTags(text, tag)
        .filter(({ props, spread }) => !spread && !nameProps.some((prop) => props.has(prop)))
        .filter(({ props, children }) => props.get("size") === "icon" || iconOnly(children, icons))
        .map(({ props }) => `<${tag}${props.has("onClick") ? ` onClick={${props.get("onClick")}}` : ""}>`),
    )
  }

  it("catches an icon button without a name", () => {
    const icons = 'import { Close as X } from "@/components/icons"\n'
    const caught = [
      '<Button size="icon" onClick={close}>\n  <X aria-hidden="true" />\n</Button>',
      '<Button type="button" variant="ghost" size="icon" onClick={close} />',
      '<button type="button" onClick={close} className="size-8">\n  <X aria-hidden="true" />\n</button>',
      '<button type="button" onClick={close}><svg viewBox="0 0 16 16" /></button>',
    ]
    for (const source of caught) expect(unnamed(icons + source), source).toHaveLength(1)
    const fine = [
      '<Button size="icon" aria-label="Close" onClick={close}>\n  <X aria-hidden="true" />\n</Button>',
      '<button type="button" aria-labelledby={titleId}><X /></button>',
      '<button type="button" title="Close"><X /></button>',
      '<button type="button" onClick={close}>\n  <X aria-hidden="true" />\n  Close\n</button>',
      '<button type="button"><X /><span className="sr-only">Close</span></button>',
      '<button type="button">{label}</button>',
      '<button type="button"><TabFace Icon={X} label="More" /></button>',
      '<Button {...props} size="icon" />',
    ]
    for (const source of fine) expect(unnamed(icons + source), source).toEqual([])
  })

  it("names every button that shows only an icon", () => {
    const found: string[] = []
    for (const file of files) {
      if (!file.endsWith(".tsx")) continue
      const name = file.slice(srcDir.length + 1).replace(/\\/g, "/")
      for (const tag of unnamed(read(file))) found.push(`${name}: ${tag}`)
    }
    expect(found).toEqual([])
  })
})
