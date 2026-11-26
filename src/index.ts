import { readC2pa } from './c2pa.ts';
import { readContainer } from './container.ts';
import { readMetadata } from './metadata.ts';

/**
 * - `verified`: valid C2PA signature from a certificate on the C2PA trust list
 * - `signed`: valid C2PA signature, but the issuer is not on the trust list
 * - `claimed`: unsigned or broken metadata; anyone can write or strip it
 */
export type Confidence = 'verified' | 'signed' | 'claimed';
export type Origin = 'generated' | 'edited' | 'captured';

export interface Evidence {
  source: 'c2pa' | 'xmp' | 'exif' | 'png';
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

export async function whomade(input: Uint8Array | ArrayBuffer): Promise<Report> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const container = await readContainer(bytes);
  if (!container) throw new Error('Unsupported format: expected PNG, JPEG, WebP, HEIF or AVIF');

  const evidence = [...(await readC2pa(bytes)), ...readMetadata(container)]
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
  verified: 'verified C2PA signature',
  signed: 'signed, but not by a trusted issuer',
  claimed: 'unsigned metadata, easy to fake or strip',
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
