// GraphQL string construction. The Forkable API inlines query args as literals
// (no typed $vars) and uses a single Relay `$input` for mutations. This module
// builds those strings safely — every identifier is validated, and every value
// goes through a strict GraphQL literal serializer (no injection via strings).

const NAME_RE = /^[_A-Za-z][_0-9A-Za-z]*$/;

/** Throw if `name` is not a valid GraphQL identifier (field name, arg name, object key). */
export function assertNameSafe(name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`unsafe GraphQL identifier: ${JSON.stringify(name)}`);
}

export type Literal =
  | string
  | number
  | boolean
  | null
  | Literal[]
  | { [k: string]: Literal | undefined };

export type LiteralArgs = Record<string, Literal | undefined>;

/**
 * Serialize a JS value to a GraphQL literal.
 * - strings → JSON.stringify (valid GraphQL string escaping)
 * - numbers/booleans → as-is; `null` → `null`
 * - arrays → `[a, b, …]`
 * - objects → `{ key: value, … }` with UNQUOTED keys (GraphQL input-object literal)
 * `undefined` object values are omitted.
 */
export function serializeLiteral(v: Literal): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "string") return JSON.stringify(v);
  if (t === "number") {
    if (!Number.isFinite(v as number))
      throw new Error(`non-finite number in GraphQL literal: ${v}`);
    return String(v);
  }
  if (t === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(serializeLiteral).join(", ")}]`;
  if (t === "object") {
    const entries: string[] = [];
    for (const [k, val] of Object.entries(v as Record<string, Literal | undefined>)) {
      if (val === undefined) continue;
      assertNameSafe(k);
      entries.push(`${k}: ${serializeLiteral(val)}`);
    }
    return `{ ${entries.join(", ")} }`;
  }
  throw new Error(`unserializable GraphQL literal of type ${t}`);
}

/** Serialize an args object to the inside of `(...)`, omitting `undefined` args. */
export function serializeArgs(args: LiteralArgs): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    assertNameSafe(k);
    parts.push(`${k}: ${serializeLiteral(v)}`);
  }
  return parts.join(", ");
}

/**
 * Build a query document.
 * `buildQuery("menus", {ids:[1], clubId:2}, "id name")` →
 *   `{ menus(ids: [1], clubId: 2) { id name } }`
 * Extra top-level roots (e.g. "app { config }") are appended inside the braces.
 */
export function buildQuery(
  root: string,
  args?: LiteralArgs,
  selection?: string,
  extraRoots: string[] = [],
): string {
  assertNameSafe(root);
  const argStr = args ? serializeArgs(args) : "";
  const head = argStr ? `${root}(${argStr})` : root;
  const body = selection ? `${head} { ${selection} }` : head;
  const extras = extraRoots.length ? ` ${extraRoots.join(" ")}` : "";
  return `{ ${body}${extras} }`;
}

/** Capitalize the first character only to form the input type name: addPiece → AddPieceInput. */
export function inputTypeName(mutation: string): string {
  assertNameSafe(mutation);
  return `${mutation.charAt(0).toUpperCase()}${mutation.slice(1)}Input`;
}

/**
 * Build a Relay-style mutation document. The caller's `selection` should include
 * `errors` (and any payload fields). Variables are passed separately as `{ input }`.
 * `buildMutation("confirmDelivery", "errors delivery { id }")` →
 *   `mutation ($input: ConfirmDeliveryInput!) { confirmDelivery(input: $input) { errors delivery { id } } }`
 */
export function buildMutation(name: string, selection: string): string {
  assertNameSafe(name);
  return `mutation ($input: ${inputTypeName(name)}!) { ${name}(input: $input) { ${selection} } }`;
}
