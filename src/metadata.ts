// Unsigned metadata: IPTC digital source type, generator names, Stable Diffusion-style PNG text.
// All of it can be written by anyone, so every result here is "claimed".

import { exifTags, type Container } from './container.ts';
import type { Evidence, Origin } from './index.ts';

const AI_TOOL = /\b(midjourney|dall[·-]?e|adobe firefly|stable diffusion|novelai|comfyui|invokeai|fooocus|ideogram|imagen|gemini|google ai)\b/i;
const EXIF_SOFTWARE = 0x0131;

// IPTC NewsCodes, https://cv.iptc.org/newscodes/digitalsourcetype/
const SOURCE_TYPES: Record<string, Origin> = {
  trainedAlgorithmicMedia: 'generated',
  compositeWithTrainedAlgorithmicMedia: 'edited',
  digitalCapture: 'captured',
  computationalCapture: 'captured',
  negativeFilm: 'captured',
  positiveFilm: 'captured',
  print: 'captured',
};

export function sourceTypeOrigin(uri: string): { name: string; origin?: Origin } {
  const name = uri.slice(uri.lastIndexOf('/') + 1);
  return { name, origin: SOURCE_TYPES[name] };
}

export function readMetadata(c: Container): Evidence[] {
  return [xmp(c.xmp), exif(c.exif), pngText(c.text)].filter((e) => e !== undefined);
}

function xmp(x: string | undefined): Evidence | undefined {
  if (!x) return;
  const type = xmpValue(x, 'DigitalSourceType');
  const tool = [xmpValue(x, 'CreatorTool'), xmpValue(x, 'Credit')].map((v) => v && AI_TOOL.exec(v)?.[0]).find(Boolean);
  if (!type && !tool) return;
  const { name, origin } = type ? sourceTypeOrigin(type) : { name: undefined, origin: 'generated' as const };
  const detail = [name && `IPTC digital source type: ${name}.`, tool && `Names ${tool}.`].filter(Boolean).join(' ');
  return { source: 'xmp', confidence: 'claimed', origin, generator: tool, detail };
}

function exif(e: Uint8Array | undefined): Evidence | undefined {
  const software = e && exifTags(e).get(EXIF_SOFTWARE);
  const tool = software && AI_TOOL.exec(software)?.[0];
  if (!tool) return;
  return { source: 'exif', confidence: 'claimed', origin: 'generated', generator: software, detail: `EXIF Software: ${software}.` };
}

function pngText(t: Map<string, string>): Evidence | undefined {
  const found = (generator: string, detail: string): Evidence =>
    ({ source: 'png', confidence: 'claimed', origin: 'generated', generator, detail });

  const params = t.get('parameters');
  if (params && /\bSteps: \d+/.test(params)) {
    const model = /\bModel: ([^,\n]+)/.exec(params)?.[1];
    return found(model ? `Stable Diffusion (${model})` : 'Stable Diffusion', 'PNG "parameters" text in AUTOMATIC1111 format.');
  }
  if (/"class_type"/.test(t.get('prompt') ?? '') || /"nodes"/.test(t.get('workflow') ?? '')) {
    return found('ComfyUI', 'PNG text holds a ComfyUI workflow.');
  }
  if (t.has('invokeai_metadata')) return found('InvokeAI', 'PNG "invokeai_metadata" text.');
  for (const key of ['Software', 'Source']) {
    const value = t.get(key);
    if (value && AI_TOOL.test(value)) return found(value, `PNG "${key}" text: ${value}.`);
  }
}

// XMP allows <ns:Name>value</ns:Name>, ns:Name="value" and <ns:Name rdf:resource="value"/>.
function xmpValue(x: string, name: string): string | undefined {
  return new RegExp(`:${name}(?:>|\\s*=\\s*["']|\\s[^>]*?resource\\s*=\\s*["'])\\s*([^<"']+)`).exec(x)?.[1]?.trim();
}
