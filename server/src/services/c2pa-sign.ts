import { createPrivateKey } from 'node:crypto';
import { copyFileSync, rmSync, statSync } from 'node:fs';
import { env } from '../env.js';

/** Claim generator. This product, not a camera or editor vendor. */
export const C2PA_CLAIM_GENERATOR = 'benchu-canvas';

/** IPTC digital source type for media produced by a trained algorithm. */
export const C2PA_AI_SOURCE_TYPE =
  'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia';

const SIGNABLE_KINDS = new Set(['image', 'poster', 'video']);

type SigningAlg = 'ed25519' | 'es256' | 'es384' | 'es512' | 'ps256' | 'ps384' | 'ps512';

export class C2paSignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'C2paSignError';
  }
}

export type C2paCredentials = {
  certificatePem: string;
  privateKeyPem: string;
};

export type C2paSignRequest = {
  path: string;
  mime: string;
  credentials: C2paCredentials;
};

export type C2paSigner = (input: C2paSignRequest) => Promise<void>;

export type ContentCredentialDefinition = {
  claim_generator: string;
  claim_generator_info: Array<{ name: string }>;
  title: string;
  format: string;
  assertions: Array<{
    label: string;
    created: true;
    data: {
      actions: Array<{
        action: string;
        digitalSourceType: string;
        softwareAgent: { name: string };
        description: string;
      }>;
    };
  }>;
};

/**
 * Both PEM values must be non-empty strings. A missing or blank value means
 * signing is not configured, so callers must leave the file unchanged.
 */
export function configuredC2paCredentials(
  certPem: string | undefined = env.c2pa.certPem,
  keyPem: string | undefined = env.c2pa.keyPem,
): C2paCredentials | null {
  if (typeof certPem !== 'string' || certPem.length === 0) return null;
  if (typeof keyPem !== 'string' || keyPem.length === 0) return null;
  return { certificatePem: certPem, privateKeyPem: keyPem };
}

/**
 * Manifest definition embedded by the real signer.
 * `vendor` is omitted on purpose: that field is a publisher prefix and must
 * not be filled with another company's name.
 */
export function contentCredentialDefinition(mime: string): ContentCredentialDefinition {
  return {
    claim_generator: C2PA_CLAIM_GENERATOR,
    claim_generator_info: [{ name: C2PA_CLAIM_GENERATOR }],
    title: 'AI 生成',
    format: mime,
    assertions: [
      {
        label: 'c2pa.actions',
        created: true,
        data: {
          actions: [
            {
              action: 'c2pa.created',
              digitalSourceType: C2PA_AI_SOURCE_TYPE,
              softwareAgent: { name: C2PA_CLAIM_GENERATOR },
              description: 'AI 生成',
            },
          ],
        },
      },
    ],
  };
}

/**
 * Sign the current image, poster, or video when the plan requires a watermark
 * and both PEMs are configured. Otherwise this returns without calling the
 * signer or the C2PA library.
 */
export async function maybeSignOutput(input: {
  path: string;
  mime: string;
  kind: string;
  watermarkRequired: boolean;
  credentials: C2paCredentials | null;
  sign?: C2paSigner;
}): Promise<void> {
  if (!input.watermarkRequired) return;
  if (!SIGNABLE_KINDS.has(input.kind)) return;
  if (!input.credentials) return;
  const sign = input.sign ?? signContentCredential;
  await sign({
    path: input.path,
    mime: input.mime,
    credentials: input.credentials,
  });
}

/** Sign `path` in place with @contentauth/c2pa-node. The library is loaded only here. */
export async function signContentCredential(input: C2paSignRequest): Promise<void> {
  const mime = mediaType(input.mime);
  const material = signingMaterial(input.credentials.privateKeyPem);
  const outputPath = `${input.path}.c2pa-out`;
  try {
    const { Builder, LocalSigner } = await import('@contentauth/c2pa-node');
    const signer = LocalSigner.newSigner(
      Buffer.from(input.credentials.certificatePem),
      Buffer.from(material.pkcs8Pem),
      material.algorithm,
    );
    const builder = await Builder.withJsonAsync(contentCredentialDefinition(mime));
    builder.setIntent({ create: C2PA_AI_SOURCE_TYPE });
    const embedded = builder.sign(
      signer,
      { path: input.path, mimeType: mime },
      { path: outputPath, mimeType: mime },
    );
    if (!Buffer.isBuffer(embedded) || embedded.length < 1) {
      throw new C2paSignError('C2PA 签名失败：未生成内容凭证');
    }
    if (!statSync(outputPath).size) {
      throw new C2paSignError('C2PA 签名失败：未写出已签名文件');
    }
    copyFileSync(outputPath, input.path);
  } catch (err) {
    throw publicSignError(err);
  } finally {
    rmSync(outputPath, { force: true });
  }
}

function signingMaterial(privateKeyPem: string): { algorithm: SigningAlg; pkcs8Pem: string } {
  let key;
  try {
    key = createPrivateKey({ key: privateKeyPem, format: 'pem' });
  } catch {
    throw new C2paSignError('C2PA 签名失败：私钥无法用于签名');
  }
  const algorithm = signingAlgorithm(key);
  const exported = key.export({ type: 'pkcs8', format: 'pem' });
  if (typeof exported !== 'string' || exported.length === 0) {
    throw new C2paSignError('C2PA 签名失败：私钥无法用于签名');
  }
  return { algorithm, pkcs8Pem: exported };
}

function signingAlgorithm(key: ReturnType<typeof createPrivateKey>): SigningAlg {
  if (key.asymmetricKeyType === 'ed25519') return 'ed25519';
  if (key.asymmetricKeyType === 'ec') {
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (curve === 'prime256v1' || curve === 'P-256') return 'es256';
    if (curve === 'secp384r1' || curve === 'P-384') return 'es384';
    if (curve === 'secp521r1' || curve === 'P-521') return 'es512';
    throw new C2paSignError('C2PA 签名失败：不支持的椭圆曲线');
  }
  if (key.asymmetricKeyType === 'rsa') return 'ps256';
  throw new C2paSignError('C2PA 签名失败：不支持的私钥类型');
}

function mediaType(mime: string): string {
  const base = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!base) throw new C2paSignError('C2PA 签名失败：缺少文件类型');
  return base;
}

function publicSignError(err: unknown): C2paSignError {
  if (err instanceof C2paSignError) return err;
  let detail = err instanceof Error ? err.message : String(err);
  detail = detail.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted]');
  detail = detail.replace(/[A-Za-z0-9+/=]{64,}/g, '[redacted]');
  detail = detail.replace(/\s+/g, ' ').trim();
  if (!detail) detail = '未知错误';
  return new C2paSignError(`C2PA 签名失败：${detail}`.slice(0, 500));
}
