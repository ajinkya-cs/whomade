import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';

const MAX_BYTES = 64 * 1024 * 1024;

export const version: string = createRequire(import.meta.url)('../package.json').version;

/** Reads a local path (`~` allowed) or an http(s) URL. */
export async function load(source: string): Promise<Uint8Array> {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`GET ${source}: HTTP ${res.status}`);
    if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error(`${source}: larger than 64 MB`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw new Error(`${source}: larger than 64 MB`);
    return bytes;
  }
  const path = source.replace(/^~(?=$|\/)/, homedir());
  if ((await stat(path)).size > MAX_BYTES) throw new Error(`${source}: larger than 64 MB`);
  return readFile(path);
}
