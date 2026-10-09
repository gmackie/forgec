/** One text file inside an uncompressed ZIP download. */
export interface ZipFile {
  path: string;
  text: string;
}

/** A package path: relative, no traversal, no absolute or empty segments. */
export function safeZipPath(path: string): boolean {
  if (!path || path.length > 200 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function crc32(data: Uint8Array): number {
  let c = ~0;
  for (const byte of data) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function u16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Uncompressed ZIP (method 0, UTF-8 names). The console has no compression
 * dependency; a forgec package is a handful of source files.
 */
export function storeZip(files: ZipFile[]): Uint8Array {
  if (!files.length || files.length > 50) throw new Error("A forgec package has between 1 and 50 files.");
  const entries = files.map((file) => {
    if (!safeZipPath(file.path)) throw new Error(`Refusing package path ${file.path}`);
    const name = new TextEncoder().encode(file.path);
    const data = new TextEncoder().encode(file.text);
    if (data.length > 1_500_000) throw new Error(`${file.path} is too large to download.`);
    return { name, data, crc: crc32(data) };
  });
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const local = concat([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(0),
      u16(0),
      u32(entry.crc),
      u32(entry.data.length),
      u32(entry.data.length),
      u16(entry.name.length),
      u16(0),
      entry.name,
      entry.data,
    ]);
    locals.push(local);
    central.push(
      concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(0),
        u16(0),
        u32(entry.crc),
        u32(entry.data.length),
        u32(entry.data.length),
        u16(entry.name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        entry.name,
      ]),
    );
    offset += local.length;
  }
  const directory = concat(central);
  const end = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(directory.length),
    u32(offset),
    u16(0),
  ]);
  return concat([...locals, directory, end]);
}
