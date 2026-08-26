// Reader/writer for the nTop notebook (.ntop) container format.
//
// The format is not documented by nTop. It was derived by inspecting files written by
// nTop 5.54.2 and is verified by round-tripping real notebooks byte-for-byte (see
// test/container.test.ts). Treat other versions as unverified: readNotebook records the
// version found in the `turhe` section so callers can refuse to write files they did not
// produce.
//
// Layout
//   file      : "MAGIC%$1" u64 sectionCount u64 reserved
//               sectionCount * { name[16], u64 endOffset }   (endOffset is relative to base)
//               80 zero bytes
//               base: sections laid out contiguously in table order
//   section   : "MAGIC@@9" type[16] name[16] u64 contentLength 80 zero bytes, then content
//   ntopfn    : a section whose content is itself a sequence of sections ("fn", "leaves")
//   container : a section holding u64 indexOffset, opaque payload bytes, then sections
//               starting at indexOffset (used by "leaves" and "cache")

import { readFileSync, writeFileSync } from "node:fs";

const FILE_MAGIC = Buffer.from("MAGIC%$1");
const SECTION_MAGIC = Buffer.from("MAGIC@@9");
const NAME_FIELD = 16;
const SECTION_HEADER = 128;
const TABLE_ENTRY = 24;
const TABLE_PADDING = 80;

export interface Section {
  type: string;
  name: string;
  content: Buffer;
  /** Present when `type` is "ntopfn"; `content` is then derived from these on write. */
  children?: Section[];
}

export interface ObjContainer {
  /** Bytes between the offset word and the first section. Opaque; preserved verbatim. */
  payload: Buffer;
  sections: Section[];
}

export interface Notebook {
  sections: Section[];
  /** Version tuple from the `turhe` section, e.g. [5, 54, 2]. Null if absent or unparsable. */
  version: number[] | null;
}

function readName(buf: Buffer, offset: number): string {
  return buf
    .subarray(offset, offset + NAME_FIELD)
    .toString("utf8")
    .replace(/\0+$/, "");
}

function writeName(buf: Buffer, offset: number, name: string): void {
  const bytes = Buffer.from(name, "utf8");
  if (bytes.length > NAME_FIELD) throw new Error(`Section name too long (max ${NAME_FIELD} bytes): ${name}`);
  bytes.copy(buf, offset);
}

export function parseSections(buf: Buffer, start: number, end: number): Section[] {
  const sections: Section[] = [];
  let offset = start;
  while (offset < end) {
    if (!buf.subarray(offset, offset + 8).equals(SECTION_MAGIC)) {
      throw new Error(`Expected section magic at byte ${offset} (scanning ${start}..${end})`);
    }
    const type = readName(buf, offset + 8);
    const name = readName(buf, offset + 24);
    const length = Number(buf.readBigUInt64LE(offset + 40));
    const contentStart = offset + SECTION_HEADER;
    if (contentStart + length > end) {
      throw new Error(`Section "${name}" claims ${length} bytes but only ${end - contentStart} remain`);
    }
    const section: Section = { type, name, content: buf.subarray(contentStart, contentStart + length) };
    if (type === "ntopfn") section.children = parseSections(buf, contentStart, contentStart + length);
    sections.push(section);
    offset = contentStart + length;
  }
  if (offset !== end) throw new Error(`Section walk ended at ${offset}, expected ${end}`);
  return sections;
}

function sectionToBuffer(section: Section): Buffer {
  const content = section.children ? Buffer.concat(section.children.map(sectionToBuffer)) : section.content;
  const header = Buffer.alloc(SECTION_HEADER);
  SECTION_MAGIC.copy(header, 0);
  writeName(header, 8, section.type);
  writeName(header, 24, section.name);
  header.writeBigUInt64LE(BigInt(content.length), 40);
  return Buffer.concat([header, content]);
}

export function parseNotebook(buf: Buffer): Notebook {
  if (!buf.subarray(0, 8).equals(FILE_MAGIC)) throw new Error("Not an nTop notebook: file magic missing");
  const count = Number(buf.readBigUInt64LE(8));
  const base = TABLE_ENTRY * count + 0x18 + TABLE_PADDING;
  if (base > buf.length) throw new Error("Section table extends past end of file");

  const sections: Section[] = [];
  let previousEnd = 0;
  for (let i = 0; i < count; i++) {
    const entry = 0x18 + i * TABLE_ENTRY;
    const name = readName(buf, entry);
    const end = Number(buf.readBigUInt64LE(entry + NAME_FIELD));
    const parsed = parseSections(buf, base + previousEnd, base + end);
    if (parsed.length !== 1)
      throw new Error(`Table entry "${name}" contains ${parsed.length} sections, expected 1`);
    if (parsed[0]!.name !== name) throw new Error(`Table entry "${name}" holds section "${parsed[0]!.name}"`);
    sections.push(parsed[0]!);
    previousEnd = end;
  }
  if (base + previousEnd !== buf.length) {
    throw new Error(`Trailing data: sections end at ${base + previousEnd}, file is ${buf.length} bytes`);
  }
  return { sections, version: readVersion(sections) };
}

export function buildNotebook(notebook: Notebook): Buffer {
  const count = notebook.sections.length;
  const head = Buffer.alloc(TABLE_ENTRY * count + 0x18 + TABLE_PADDING);
  FILE_MAGIC.copy(head, 0);
  head.writeBigUInt64LE(BigInt(count), 8);
  const blobs = notebook.sections.map(sectionToBuffer);
  let cumulative = 0;
  notebook.sections.forEach((section, i) => {
    cumulative += blobs[i]!.length;
    const entry = 0x18 + i * TABLE_ENTRY;
    writeName(head, entry, section.name);
    head.writeBigUInt64LE(BigInt(cumulative), entry + NAME_FIELD);
  });
  return Buffer.concat([head, ...blobs]);
}

export function readNotebook(path: string): Notebook {
  return parseNotebook(readFileSync(path));
}

export function writeNotebook(path: string, notebook: Notebook): void {
  writeFileSync(path, buildNotebook(notebook));
}

function readVersion(sections: Section[]): number[] | null {
  const turhe = sections.find((s) => s.name === "turhe");
  if (!turhe) return null;
  try {
    const parsed: unknown = JSON.parse(turhe.content.toString("utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { turver?: unknown }).turver)) {
      return (parsed as { turver: number[] }).turver;
    }
  } catch {
    return null;
  }
  return null;
}

export function findSection(notebook: Notebook, name: string): Section {
  const section = notebook.sections.find((s) => s.name === name);
  if (!section) throw new Error(`Notebook has no "${name}" section`);
  return section;
}

/** Splits a "leaves"/"cache" style section into its opaque payload and its sections. */
export function parseObjContainer(content: Buffer): ObjContainer {
  if (content.length < 8) return { payload: Buffer.alloc(0), sections: [] };
  const indexOffset = Number(content.readBigUInt64LE(0));
  if (indexOffset < 8 || indexOffset > content.length) {
    throw new Error(
      `Object container index offset ${indexOffset} outside content of ${content.length} bytes`,
    );
  }
  return {
    payload: Buffer.from(content.subarray(8, indexOffset)),
    sections: parseSections(content, indexOffset, content.length),
  };
}

export function buildObjContainer(container: ObjContainer): Buffer {
  const offset = Buffer.alloc(8);
  offset.writeBigUInt64LE(BigInt(8 + container.payload.length), 0);
  return Buffer.concat([offset, container.payload, ...container.sections.map(sectionToBuffer)]);
}

export function jsonSection(name: string, value: unknown): Section {
  return { type: "json", name, content: Buffer.from(JSON.stringify(value), "utf8") };
}

/** An object container holding a single JSON "index" section and no payload. */
export function emptyObjContainer(): Buffer {
  return buildObjContainer({ payload: Buffer.alloc(0), sections: [jsonSection("index", [])] });
}
