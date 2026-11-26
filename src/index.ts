import { readC2pa } from './c2pa.ts';
import { readContainer } from './container.ts';
import { geminiWatermark } from './gemini.ts';
import { readMetadata } from './metadata.ts';
import { checkOpenAI } from './openai.ts';
import { decode } from './pixels.ts';

/**
 * - `verified`: valid C2PA signature from a certificate on the C2PA trust list, or the
 *   generator's own watermark detector
 * - `signed`: valid C2PA signature, but the issuer is not on the trust list
 * - `claimed`: unsigned metadata, a broken manifest or a visible watermark; easy to fake or strip
 */
export type Confidence = 'verified' | 'signed' | 'claimed';
export type Origin = 'generated' | 'edited' | 'captured';

export interface Options {
  /** Also ask OpenAI's provenance API for its SynthID watermark. This uploads the image to OpenAI. */
  openaiApiKey?: string;
}

export interface Evidence {
  source: 'c2pa' | 'xmp' | 'exif' | 'png' | 'watermark' | 'openai';
  confidence: Confidence;
  origin?: Origin;
  generator?: string;
  signer?: string;
  detail: string;
}

export interface Report {
  /** `null` means no evidence either way. It never means "made by a human". */
  ai: boolean | null;
  origin?: Origin;
  confidence: Confidence | 'none';
  generator?: string;
  evidence: Evidence[];
}

const RANK: Record<Confidence, number> = { verified: 3, signed: 2, claimed: 1 };

export async function whomade(input: Uint8Array | ArrayBuffer, options: Options = {}): Promise<Report> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const container = await readContainer(bytes);
  if (!container) throw new Error('Unsupported format: expected PNG, JPEG, WebP, HEIF or AVIF');

  const pixels = decode(bytes, container.format);
  const [c2pa, openai] = await Promise.all([
    readC2pa(bytes),
    options.openaiApiKey ? checkOpenAI(bytes, container.format, options.openaiApiKey) : [],
  ]);
  const evidence = [...c2pa, ...openai, ...readMetadata(container), ...(pixels ? geminiWatermark(pixels) : [])]
    .sort((a, b) => RANK[b.confidence] - RANK[a.confidence]);
  const top = evidence.find((e) => e.origin);
  return {
    ai: top?.origin ? top.origin !== 'captured' : null,
    origin: top?.origin,
    confidence: top?.confidence ?? 'none',
    generator: (top ?? evidence[0])?.generator,
    evidence,
  };
}

const ORIGIN: Record<Origin, string> = { generated: 'AI-generated', edited: 'AI-edited', captured: 'Camera capture' };
const CONFIDENCE: Record<Confidence, string> = {
  verified: 'verified',
  signed: 'signed, but not by a trusted issuer',
  claimed: 'unverified, easy to fake or strip',
};

/** One-line summary of a report. */
export function describe(r: Report): string {
  if (r.confidence === 'none') {
    return r.evidence.length
      ? 'Provenance found, but it does not say how the image was made.'
      : 'No provenance found. Most sites strip metadata, so this does not mean a human made it.';
  }
  return `${ORIGIN[r.origin!]}${r.generator ? ` by ${r.generator}` : ''}: ${CONFIDENCE[r.confidence]}`;
}
