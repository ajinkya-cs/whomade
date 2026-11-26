import 'reflect-metadata';
import { X509CertificateGenerator, type X509Certificate } from '@peculiar/x509';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { trustAnchor } from '../src/c2pa.ts';
import { describe, whomade } from '../src/index.ts';

// c2pa-signed.jpg and c2pa-tampered.jpg are C.jpg and XCA.jpg from
// https://github.com/contentauth/c2pa-rs/tree/main/sdk/tests/fixtures (MIT OR Apache-2.0).
// gemini-corner*.png are bottom-right 360 px crops of real Gemini images from
// https://github.com/GargantuaX/gemini-watermark-remover/tree/main/src/assets (MIT).
const fixture = (name: string) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));

test('C2PA signed by a certificate outside the trust list is "signed"', async () => {
  const r = await whomade(await readFile(fixture('c2pa-signed.jpg')));
  assert.equal(r.evidence[0]?.confidence, 'signed');
  assert.equal(r.evidence[0]?.signer, 'C2PA Test Signing Cert');
  assert.equal(r.ai, null); // declares algorithmicMedia, which is not generative AI
});

test('C2PA that fails validation is only "claimed"', async () => {
  const r = await whomade(await readFile(fixture('c2pa-tampered.jpg')));
  assert.equal(r.evidence[0]?.confidence, 'claimed');
  assert.match(r.evidence[0]!.detail, /assertion\.dataHash\.mismatch/);
});

test('trust anchoring follows signatures, not names', async () => {
  const root = await ca('CN=Root');
  const leaf = await issue('CN=Leaf', root);
  assert.equal(await trustAnchor(leaf.cert, [], new Date(), [root.cert]), root.cert);

  const intermediate = await issue('CN=Intermediate', root);
  const deep = await issue('CN=Leaf', intermediate);
  assert.equal(await trustAnchor(deep.cert, [intermediate.cert], new Date(), [root.cert]), root.cert);
  assert.equal(await trustAnchor(deep.cert, [], new Date(), [root.cert]), undefined);

  const forged = await issue('CN=Leaf', await ca('CN=Root'));
  assert.equal(await trustAnchor(forged.cert, [], new Date(), [root.cert]), undefined);
});

test('AUTOMATIC1111 parameters in PNG', async () => {
  const r = await whomade(png(tEXt('parameters', 'a cat\nSteps: 20, Sampler: Euler a, Model: sd_xl_base_1.0, Seed: 1')));
  assert.deepEqual([r.ai, r.origin, r.confidence, r.generator], [true, 'generated', 'claimed', 'Stable Diffusion (sd_xl_base_1.0)']);
});

test('ComfyUI workflow in compressed PNG text', async () => {
  const r = await whomade(png(zTXt('prompt', '{"3":{"class_type":"KSampler","inputs":{}}}')));
  assert.equal(r.generator, 'ComfyUI');
});

test('IPTC digital source type in JPEG XMP', async () => {
  const xmp = `<rdf:Description Iptc4xmpExt:DigitalSourceType="${IPTC}trainedAlgorithmicMedia" photoshop:Credit="Made with Google AI"/>`;
  const r = await whomade(jpeg(xmp));
  assert.deepEqual([r.ai, r.origin, r.generator], [true, 'generated', 'Google AI']);
});

test('IPTC composite in WebP XMP, rdf:resource form', async () => {
  const r = await whomade(webp(`<Iptc4xmpExt:DigitalSourceType rdf:resource="${IPTC}compositeWithTrainedAlgorithmicMedia"/>`));
  assert.deepEqual([r.ai, r.origin], [true, 'edited']);
});

test('XMP in PNG iTXt', async () => {
  const xmp = `<Iptc4xmpExt:DigitalSourceType>${IPTC}digitalCapture</Iptc4xmpExt:DigitalSourceType>`;
  const r = await whomade(png(chunk('iTXt', bytes(`XML:com.adobe.xmp\0\0\0\0\0${xmp}`))));
  assert.deepEqual([r.ai, r.origin], [false, 'captured']);
});

test('no metadata means unknown, not human', async () => {
  const r = await whomade(png());
  assert.deepEqual(r, { ai: null, origin: undefined, confidence: 'none', generator: undefined, evidence: [] });
  assert.match(describe(r), /does not mean a human made it/);
});

test('malformed input', async () => {
  await assert.rejects(whomade(bytes('not an image')), /Unsupported format/);
  const truncated = png(tEXt('parameters', 'Steps: 20')).subarray(0, 40);
  assert.equal((await whomade(truncated)).ai, null);
});

test("Gemini's visible watermark in real Gemini corners", async () => {
  for (const [name, margin] of [['gemini-corner.png', 32], ['gemini-corner-weak.png', 96]] as const) {
    const r = await whomade(await readFile(fixture(name)));
    assert.deepEqual([r.ai, r.confidence, r.generator], [true, 'claimed', 'Google Gemini'], name);
    assert.match(r.evidence[0]!.detail, new RegExp(`48 px, ${margin} px from the corner`), name);
  }
  const photo = await whomade(await readFile(fixture('c2pa-signed.jpg')));
  assert.ok(!photo.evidence.some((e) => e.source === 'watermark'));
});

test('OpenAI provenance API: SynthID detected, and errors surface', async (t) => {
  const calls: { url: string; init: RequestInit }[] = [];
  let reply = new Response(JSON.stringify({
    object: 'content_provenance_check',
    results: [
      { type: 'c2pa', outcome: 'not_detected', validation_state: 'not_present', issuer: null, model: null, generated_at: null },
      { type: 'synthid', outcome: 'detected', model: 'gpt-image', generated_at: '2026-07-27T18:34:12Z' },
    ],
  }));
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => (calls.push({ url, init }), reply));

  const r = await whomade(png(), { openaiApiKey: 'sk-test' });
  assert.deepEqual([r.ai, r.confidence, r.generator], [true, 'verified', 'OpenAI (gpt-image)']);
  assert.equal(calls[0]!.url, 'https://api.openai.com/v1/content_provenance_checks');
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer sk-test');
  assert.equal(((calls[0]!.init.body as FormData).get('file') as File).type, 'image/png');

  reply = new Response('{}', { status: 404 });
  await assert.rejects(whomade(png(), { openaiApiKey: 'sk-test' }), /HTTP 404, this organization has no access/);
  assert.equal(calls.length, 2);
  await whomade(png());
  assert.equal(calls.length, 2); // never called without a key
});

test('MCP server: initialize, list and call', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'mcp']);
  const replies = new Map<number, any>();
  const done = new Promise<void>((resolve) =>
    createInterface({ input: child.stdout }).on('line', (line) => {
      const msg = JSON.parse(line);
      replies.set(msg.id, msg);
      if (replies.size === 3) resolve();
    }),
  );
  const send = (msg: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  send({ id: 3, method: 'tools/call', params: { name: 'who_made', arguments: { source: fixture('c2pa-signed.jpg') } } });
  await done;
  child.kill();

  assert.equal(replies.get(1).result.protocolVersion, '2025-06-18');
  assert.equal(replies.get(2).result.tools[0].name, 'who_made');
  assert.match(replies.get(3).result.content[0].text, /C2PA Test Signing Cert/);
});

const IPTC = 'http://cv.iptc.org/newscodes/digitalsourcetype/';
const bytes = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: (Uint8Array | number[])[]) => new Uint8Array(Buffer.concat(parts.map((p) => Uint8Array.from(p))));
const u32 = (n: number, le = false) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, le); return b; };

function chunk(type: string, data: Uint8Array) {
  const body = cat(bytes(type), data);
  return cat(u32(data.length), body, u32(crc32(body)));
}
const tEXt = (key: string, value: string) => chunk('tEXt', bytes(`${key}\0${value}`));
const zTXt = (key: string, value: string) => chunk('zTXt', cat(bytes(`${key}\0\0`), deflateSync(value)));
const png = (...chunks: Uint8Array[]) =>
  cat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], chunk('IHDR', cat(u32(1), u32(1), [8, 6, 0, 0, 0])), ...chunks, chunk('IEND', new Uint8Array()));

function jpeg(xmp: string) {
  const payload = bytes(`http://ns.adobe.com/xap/1.0/\0${xmp}`);
  return cat([0xff, 0xd8, 0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff], payload, [0xff, 0xd9]);
}

function webp(xmp: string) {
  const data = bytes(xmp);
  const body = cat(bytes('WEBP'), bytes('XMP '), u32(data.length, true), data, data.length & 1 ? [0] : []);
  return cat(bytes('RIFF'), u32(body.length, true), body);
}

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
const VALIDITY = { notBefore: new Date(Date.now() - 86_400_000), notAfter: new Date(Date.now() + 86_400_000) };
type Issued = { keys: CryptoKeyPair; cert: X509Certificate };
const keys = () => crypto.subtle.generateKey(ALG, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;

async function ca(name: string): Promise<Issued> {
  const k = await keys();
  return { keys: k, cert: await X509CertificateGenerator.createSelfSigned({ name, keys: k, signingAlgorithm: ALG, ...VALIDITY }) };
}

async function issue(subject: string, issuer: Issued): Promise<Issued> {
  const k = await keys();
  const cert = await X509CertificateGenerator.create({
    subject,
    issuer: issuer.cert.subject,
    publicKey: k.publicKey,
    signingKey: issuer.keys.privateKey,
    signingAlgorithm: ALG,
    ...VALIDITY,
  });
  return { keys: k, cert };
}
