// OpenAI's Content Provenance API. It finds the SynthID watermark OpenAI embeds in its images,
// which survives the screenshots and re-uploads that strip C2PA. Opt-in: it uploads the image.
// https://developers.openai.com/api/docs/guides/content-provenance

import type { Evidence } from './index.ts';

const ENDPOINT = 'https://api.openai.com/v1/content_provenance_checks';
const MIME: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

interface Result {
  type: 'c2pa' | 'synthid';
  outcome: 'detected' | 'not_detected';
  model?: string | null;
}

export async function checkOpenAI(bytes: Uint8Array, format: string, apiKey: string): Promise<Evidence[]> {
  const type = MIME[format];
  if (!type) throw new Error(`OpenAI's provenance API does not accept ${format.toUpperCase()} images`);

  const body = new FormData();
  body.append('file', new Blob([bytes as BlobPart], { type }), `image.${format}`);
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const error = ((await res.json().catch(() => undefined)) as { error?: { message?: string } } | undefined)?.error?.message;
    const reason = res.status === 404 ? 'this organization has no access' : (error ?? res.statusText);
    throw new Error(`OpenAI provenance API: HTTP ${res.status}, ${reason}`);
  }

  // C2PA is verified locally; only the watermark is new information.
  const { results = [] } = (await res.json()) as { results?: Result[] };
  return results
    .filter((r) => r.type === 'synthid' && r.outcome === 'detected')
    .map((r) => ({
      source: 'openai',
      confidence: 'verified',
      origin: 'generated',
      generator: r.model ? `OpenAI (${r.model})` : 'OpenAI',
      detail: "OpenAI's provenance API found its SynthID watermark.",
    }));
}
