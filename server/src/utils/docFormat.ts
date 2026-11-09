/** The paper format the AI reads and writes, as one module: its types, the parser, the builder and the reader */
export { NO_REFS, type Kept, type Ref, type Resolved } from "./docFormat/types"
export { formatRefusal, parseDocText } from "./docFormat/parse"
export { docSpecs, toY, type Spec } from "./docFormat/build"
export { docToText, elements, heldRefs, lineText, unitsOf, unitSupported, unitText, type Unit } from "./docFormat/read"
