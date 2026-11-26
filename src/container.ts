// Pulls the metadata whomade reads (XMP, EXIF, PNG text) out of PNG, JPEG and WebP files.

export interface Container {
  format: 'png' | 'jpeg' | 'webp' | 'bmff';
  xmp?: string;
  exif?: Uint8Array;
  text: Map<string, string>;
}

const MAX_INFLATED = 16 * 1024 * 1024;
const XMP_NS = 'http://ns.adobe.com/xap/1.0/\0';
const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder();

export async function readContainer(b: Uint8Array): Promise<Container | undefined> {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return png(b);
  if (startsWith(b, [0xff, 0xd8, 0xff])) return jpeg(b);
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return webp(b);
  if (ascii(b, 4, 4) === 'ftyp') return { format: 'bmff', text: new Map() };
  return undefined;
}

async function png(b: Uint8Array): Promise<Container> {
  const c: Container = { format: 'png', text: new Map() };
  for (let i = 8; i + 8 <= b.length; ) {
    const len = u32be(b, i);
    const type = ascii(b, i + 4, 4);
    const data = b.subarray(i + 8, i + 8 + len);
    i += 12 + len;
    if (type === 'IEND') break;
    if (type === 'eXIf') c.exif = data;
    if (type !== 'tEXt' && type !== 'zTXt' && type !== 'iTXt') continue;

    const k = data.indexOf(0);
    if (k < 0) continue;
    const key = latin1.decode(data.subarray(0, k));
    let value: string;
    if (type === 'tEXt') {
      value = latin1.decode(data.subarray(k + 1));
    } else if (type === 'zTXt') {
      value = latin1.decode(await inflate(data.subarray(k + 2)));
    } else {
      // iTXt: keyword, compression flag, method, language tag, translated keyword, text
      const lang = data.indexOf(0, k + 3);
      const translated = data.indexOf(0, lang + 1);
      if (lang < 0 || translated < 0) continue;
      const text = data.subarray(translated + 1);
      value = utf8.decode(data[k + 1] ? await inflate(text) : text);
    }
    if (key === 'XML:com.adobe.xmp') c.xmp = value;
    else c.text.set(key, value);
  }
  return c;
}

function jpeg(b: Uint8Array): Container {
  const c: Container = { format: 'jpeg', text: new Map() };
  for (let i = 2; i + 4 <= b.length; ) {
    if (b[i] !== 0xff) break;
    const marker = b[i + 1]!;
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xda || marker === 0xd9) break; // image data starts; metadata is done
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    const seg = b.subarray(i + 4, i + 2 + len);
    i += 2 + len;
    if (marker !== 0xe1) continue;
    if (ascii(seg, 0, 6) === 'Exif\0\0') c.exif = seg.subarray(6);
    else if (ascii(seg, 0, XMP_NS.length) === XMP_NS) c.xmp = utf8.decode(seg.subarray(XMP_NS.length));
  }
  return c;
}

function webp(b: Uint8Array): Container {
  const c: Container = { format: 'webp', text: new Map() };
  for (let i = 12; i + 8 <= b.length; ) {
    const type = ascii(b, i, 4);
    const len = u32le(b, i + 4);
    const data = b.subarray(i + 8, i + 8 + len);
    i += 8 + len + (len & 1);
    if (type === 'XMP ') c.xmp = utf8.decode(data);
    if (type === 'EXIF') c.exif = ascii(data, 0, 6) === 'Exif\0\0' ? data.subarray(6) : data;
  }
  return c;
}

// Reads ASCII tags from IFD0 of a TIFF/EXIF block.
export function exifTags(t: Uint8Array): Map<number, string> {
  const tags = new Map<number, string>();
  try {
    const le = t[0] === 0x49;
    const v = new DataView(t.buffer, t.byteOffset, t.byteLength);
    const ifd = v.getUint32(4, le);
    for (let n = v.getUint16(ifd, le), e = ifd + 2; n > 0; n--, e += 12) {
      if (v.getUint16(e + 2, le) !== 2) continue; // ASCII only
      const count = v.getUint32(e + 4, le);
      const at = count <= 4 ? e + 8 : v.getUint32(e + 8, le);
      tags.set(v.getUint16(e, le), latin1.decode(t.subarray(at, at + count)).replace(/\0+$/, ''));
    }
  } catch {
    // Truncated or malformed EXIF: keep what was read.
  }
  return tags;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      size += r.value.length;
      if (size > MAX_INFLATED) break;
      parts.push(r.value);
    }
  } catch {
    // Corrupt stream: keep what was inflated.
  } finally {
    reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(Math.min(size, MAX_INFLATED));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.subarray(0, o);
}

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((x, i) => b[i] === x);
const ascii = (b: Uint8Array, at: number, len: number) => latin1.decode(b.subarray(at, at + len));
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const u32le = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
