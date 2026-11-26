// C2PA Content Credentials. c2pa-ts checks hashes and the signature; it does not check who
// issued the certificate, so the chain is verified here against the official C2PA trust list.

import 'reflect-metadata'; // required by @peculiar/x509; must load first
import { X509Certificate } from '@peculiar/x509';
import { createAsset } from '@trustnxt/c2pa-ts/asset';
import { SuperBox } from '@trustnxt/c2pa-ts/jumbf';
import { ActionAssertion, type Action, ManifestStore } from '@trustnxt/c2pa-ts/manifest';
import type { Evidence, Origin } from './index.ts';
import { sourceTypeOrigin } from './metadata.ts';
import { anchors as trustListPem } from './trust-list.ts';

const RANK: Record<Origin, number> = { generated: 3, edited: 2, captured: 1 };
let trustList: X509Certificate[] | undefined;

export async function readC2pa(bytes: Uint8Array): Promise<Evidence[]> {
  const asset = await createAsset(bytes).catch(() => undefined);
  const jumbf = await asset?.getManifestJUMBF();
  if (!asset || !jumbf) return [];

  let store: ManifestStore;
  let valid: boolean;
  let failures: string[];
  try {
    store = ManifestStore.read(SuperBox.fromBuffer(jumbf));
    const result = await store.validate(asset);
    valid = result.isValid;
    failures = result.statusEntries.filter((s) => !s.success).map((s) => s.code);
  } catch (e) {
    return [{ source: 'c2pa', confidence: 'claimed', detail: `Unreadable C2PA manifest: ${(e as Error).message}.` }];
  }

  const active = store.getActiveManifest();
  const sig = active?.signature?.signatureData;
  const signer = sig?.certificate && (field(sig.certificate, 'O') ?? field(sig.certificate, 'CN'));
  const anchor = valid && sig?.certificate
    ? await trustAnchor(sig.certificate, sig.chainCertificates, sig.timestamp ?? new Date())
    : undefined;
  const declared = declarations(store);

  const detail = [
    !valid
      ? `Manifest fails validation (${failures.join(', ')}): the file changed after signing, or the manifest is forged.`
      : anchor
        ? `Signed by ${signer}, chaining to ${field(anchor, 'CN') ?? anchor.subject} on the C2PA trust list.`
        : `Signed by ${signer}, but the certificate does not chain to the C2PA trust list.`,
    declared.sourceType && `Declares ${declared.sourceType}.`,
    declared.watermarked && 'Declares an invisible watermark.',
  ].filter(Boolean).join(' ');

  return [{
    source: 'c2pa',
    confidence: !valid ? 'claimed' : anchor ? 'verified' : 'signed',
    origin: declared.origin,
    generator: declared.generator ?? active?.claim?.claimGeneratorName,
    signer,
    detail,
  }];
}

// Strongest origin declared by any manifest, ingredients included: an AI image edited in
// Photoshop keeps its "trainedAlgorithmicMedia" action in the ingredient's manifest.
function declarations(store: ManifestStore) {
  let best: { origin?: Origin; sourceType?: string; generator?: string } = {};
  let watermarked = false;
  for (const manifest of store.manifests) {
    for (const assertion of manifest.assertions?.assertions ?? []) {
      if (!(assertion instanceof ActionAssertion)) continue;
      for (const action of assertion.actions as Action[]) {
        if (action.action.startsWith('c2pa.watermarked')) watermarked = true;
        if (!action.digitalSourceType) continue;
        const { name, origin } = sourceTypeOrigin(action.digitalSourceType);
        if (best.sourceType && rank(origin) <= rank(best.origin)) continue;
        const agent = action.softwareAgent;
        best = {
          origin,
          sourceType: name,
          generator: agent ? (agent.version ? `${agent.name} (${agent.version})` : agent.name) : manifest.claim?.claimGeneratorName,
        };
      }
    }
  }
  return { ...best, watermarked };
}

export async function trustAnchor(
  leaf: X509Certificate,
  chain: X509Certificate[],
  at: Date,
  roots: X509Certificate[] = (trustList ??= parsePem(trustListPem)),
): Promise<X509Certificate | undefined> {
  const issuedBy = async (cert: X509Certificate, issuer: X509Certificate) =>
    cert.issuer === issuer.subject && (await cert.verify({ publicKey: issuer, signatureOnly: true }).catch(() => false));

  let cert = leaf;
  for (let depth = 0; depth < 8; depth++) {
    for (const root of roots) {
      if (root.notBefore > at || root.notAfter < at) continue;
      if (root.equal(cert) || (await issuedBy(cert, root))) return root;
    }
    let next: X509Certificate | undefined;
    for (const c of chain) if (c !== cert && (await issuedBy(cert, c))) { next = c; break; }
    if (!next) return undefined;
    cert = next;
  }
  return undefined;
}

const rank = (o?: Origin) => (o ? RANK[o] : 0);
const field = (c: X509Certificate, name: string) => c.subjectName.getField(name)[0];
const parsePem = (pem: string) =>
  (pem.match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g) ?? []).map((p) => new X509Certificate(p));
