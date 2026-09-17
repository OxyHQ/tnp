/**
 * Safe XML reading for Namecheap responses.
 *
 * The API answers in XML (https://www.namecheap.com/support/api/intro/). The
 * body is untrusted input from the network, so this module:
 *
 * - refuses any document declaring a DTD or an entity before a parser sees it.
 *   Namecheap's documented responses never carry one; a body that does is
 *   either not from Namecheap or an entity-expansion attempt, and the cheapest
 *   defence against "billion laughs" is to never hand it to a parser;
 * - validates well-formedness first, because `XMLParser` is lenient and turns a
 *   truncated body into a plausible, partial tree rather than an error;
 * - parses with entity processing OFF and decodes only the five predefined XML
 *   entities and numeric character references itself, in a single pass, so a
 *   TXT record containing `&amp;lt;` reads back as `&lt;`, not `<`.
 *
 * Element and attribute lookups are case-insensitive. Namecheap's own
 * documentation spells the same field differently across pages
 * (`DomainName`/`Domainname`, `HostId`/`HostID`), and an exact-case lookup
 * that silently returned `undefined` would read as "absent", not "misspelt".
 */

import { XMLParser, XMLValidator } from "fast-xml-parser";

export type XmlValue = string | XmlNode | readonly XmlValue[];
export interface XmlNode {
  readonly [key: string]: XmlValue;
}

const ATTR_PREFIX = "@_";
const TEXT_KEY = "#text";

export class XmlRejected extends Error {
  constructor(readonly reason: "doctype" | "malformed" | "shape", detail: string) {
    super(detail);
    this.name = "XmlRejected";
  }
}

const PREDEFINED: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

/** Decode predefined entities and character references. Anything else stays literal. */
export function decodeXmlText(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, ref: string) => {
    if (ref.startsWith("#x") || ref.startsWith("#X")) {
      return codePointOrLiteral(Number.parseInt(ref.slice(2), 16), whole);
    }
    if (ref.startsWith("#")) {
      return codePointOrLiteral(Number.parseInt(ref.slice(1), 10), whole);
    }
    return PREDEFINED[ref] ?? whole;
  });
}

function codePointOrLiteral(codePoint: number, literal: string): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return literal;
  return String.fromCodePoint(codePoint);
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  textNodeName: TEXT_KEY,
  // Values stay strings: "0012" is an id, not the number 12, and a price must
  // never pass through a double on its way to `parseDecimalAmount`.
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  removeNSPrefix: true,
  processEntities: false,
  htmlEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

/** Parse a response body into a tree, or throw `XmlRejected`. */
export function parseXml(body: string): XmlNode {
  if (/<!DOCTYPE/i.test(body) || /<!ENTITY/i.test(body)) {
    throw new XmlRejected("doctype", "response declares a DTD or entity");
  }
  const valid = XMLValidator.validate(body);
  if (valid !== true) {
    throw new XmlRejected("malformed", `response is not well-formed XML (line ${valid.err.line})`);
  }
  const tree: unknown = parser.parse(body);
  if (!isNode(tree)) throw new XmlRejected("malformed", "response has no document element");
  return tree;
}

export function isNode(value: unknown): value is XmlNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findKey(node: XmlNode, name: string): string | undefined {
  if (Object.hasOwn(node, name)) return name;
  const lower = name.toLowerCase();
  return Object.keys(node).find((key) => key.toLowerCase() === lower);
}

/** Every child element called `name` (an element that appears once is still a list). */
export function children(node: XmlNode, name: string): XmlNode[] {
  const key = findKey(node, name);
  if (key === undefined || key.startsWith(ATTR_PREFIX)) return [];
  const value = node[key];
  const list: readonly XmlValue[] = Array.isArray(value) ? value : [value];
  // `<Errors />` parses to "" — an empty element is a node with nothing in it.
  return list.map((item) => (isNode(item) ? item : typeof item === "string" ? textNode(item) : {}));
}

function textNode(text: string): XmlNode {
  return text === "" ? {} : { [TEXT_KEY]: text };
}

export function child(node: XmlNode, name: string): XmlNode | undefined {
  return children(node, name)[0];
}

export function requireChild(node: XmlNode, name: string): XmlNode {
  const found = child(node, name);
  if (!found) throw new XmlRejected("shape", `missing element ${name}`);
  return found;
}

export function attr(node: XmlNode, name: string): string | undefined {
  const key = findKey(node, ATTR_PREFIX + name);
  if (key === undefined) return undefined;
  const value = node[key];
  return typeof value === "string" ? decodeXmlText(value) : undefined;
}

export function requireAttr(node: XmlNode, name: string): string {
  const value = attr(node, name);
  if (value === undefined) throw new XmlRejected("shape", `missing attribute ${name}`);
  return value;
}

/** Text content of an element; `undefined` when it is empty. */
export function text(node: XmlNode | undefined): string | undefined {
  if (!node) return undefined;
  const value = node[TEXT_KEY];
  if (typeof value !== "string" || value === "") return undefined;
  return decodeXmlText(value);
}

export function childText(node: XmlNode, name: string): string | undefined {
  return text(child(node, name));
}

/**
 * Namecheap booleans: documented as `true`/`false`, printed as `True`/`False`
 * in some examples. Anything else is a response this code does not understand,
 * not a `false`.
 */
export function parseBool(value: string, field: string): boolean {
  const lower = value.trim().toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  throw new XmlRejected("shape", `${field} is not a boolean`);
}

export function requireBool(node: XmlNode, name: string): boolean {
  return parseBool(requireAttr(node, name), name);
}

export function optionalBool(node: XmlNode, name: string): boolean | null {
  const value = attr(node, name);
  if (value === undefined || value === "") return null;
  return parseBool(value, name);
}

export function parseIntStrict(value: string, field: string): number {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) throw new XmlRejected("shape", `${field} is not an integer`);
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) throw new XmlRejected("shape", `${field} is out of range`);
  return parsed;
}

export function requireInt(node: XmlNode, name: string): number {
  return parseIntStrict(requireAttr(node, name), name);
}

/**
 * Namecheap dates: `MM/DD/YYYY` (getInfo, getList) or `M/D/YYYY h:mm:ss AM`
 * (renew). The documentation states no time zone, and `GMTTimeDifference` in
 * the same responses is not a parseable offset (`--4:00`). They are read as
 * UTC — explicitly, never through `new Date(string)`, whose interpretation of
 * a slash date depends on the host's locale and zone. The error this leaves is
 * at most a day, and expiry decisions keep a margin far larger than that.
 */
export function parseNamecheapDate(value: string, field: string): Date {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AaPp][Mm]))?$/.exec(value.trim());
  if (!match) throw new XmlRejected("shape", `${field} is not a recognised date`);
  const [, mm, dd, yyyy, hh, mi, ss, meridiem] = match;
  const month = Number(mm);
  const day = Number(dd);
  const year = Number(yyyy);
  let hour = hh === undefined ? 0 : Number(hh);
  const minute = mi === undefined ? 0 : Number(mi);
  const second = ss === undefined ? 0 : Number(ss);
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) throw new XmlRejected("shape", `${field} has an invalid hour`);
    const pm = meridiem.toLowerCase() === "pm";
    hour = (hour % 12) + (pm ? 12 : 0);
  }
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  // Date.UTC rolls 02/30 over into March; a rolled-over date is a wrong date.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    minute > 59 ||
    second > 59
  ) {
    throw new XmlRejected("shape", `${field} is not a valid calendar date`);
  }
  return date;
}

export function optionalDate(value: string | undefined, field: string): Date | null {
  if (value === undefined || value.trim() === "") return null;
  return parseNamecheapDate(value, field);
}
