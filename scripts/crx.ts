import { createHash, createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import Pbf from 'pbf';

const createCrx = createRequire(import.meta.url)('crx3') as (input: Readable, options: { keyPath: string; crxPath: string }) => Promise<void>;
type Proof = { key: Buffer; signature: Buffer };

export function verifyCrx(data: Buffer, expectedPublicKey: string, expectedZip: Buffer) {
  if (data.length < 12 || data.toString('ascii', 0, 4) !== 'Cr24' || data.readUInt32LE(4) !== 3) throw new Error('Invalid CRX3 header');
  const headerSize = data.readUInt32LE(8), zipOffset = 12 + headerSize;
  if (headerSize > 1024 * 1024 || zipOffset >= data.length) throw new Error('Invalid CRX3 header size');
  const header = new Pbf(data.subarray(12, zipOffset)).readFields((tag, result, reader) => {
    if (tag === 2) result.proofs.push(reader.readMessage((field, proof, message) => {
      if (field === 1) proof.key = Buffer.from(message.readBytes());
      if (field === 2) proof.signature = Buffer.from(message.readBytes());
    }, { key: Buffer.alloc(0), signature: Buffer.alloc(0) } as Proof));
    if (tag === 10000) result.signed = Buffer.from(reader.readBytes());
  }, { proofs: [] as Proof[], signed: Buffer.alloc(0) as Buffer });
  const publicKey = Buffer.from(expectedPublicKey, 'base64');
  const proof = header.proofs.find(value => value.key.equals(publicKey));
  if (!proof || !header.signed.length) throw new Error('CRX signing key does not match');
  const id = createHash('sha256').update(publicKey).digest().subarray(0, 16);
  const signed = new Pbf(header.signed).readFields((tag, result, reader) => {
    if (tag === 1) result.id = Buffer.from(reader.readBytes());
  }, { id: Buffer.alloc(0) as Buffer });
  if (!signed.id.equals(id)) throw new Error('CRX extension ID does not match');
  const size = Buffer.alloc(4);
  size.writeUInt32LE(header.signed.length);
  const zip = data.subarray(zipOffset);
  const payload = Buffer.concat([Buffer.from('CRX3 SignedData\0'), size, header.signed, zip]);
  if (!verify('sha256', payload, createPublicKey({ key: publicKey, type: 'spki', format: 'der' }), proof.signature)) throw new Error('CRX signature verification failed');
  if (!zip.equals(expectedZip)) throw new Error('CRX payload does not match ZIP');
  return { extensionId: Array.from(id, byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join(''), zipOffset };
}

export async function packCrx(zipPath: string, target: string, secret: string, expectedPublicKey: string) {
  let key;
  try { key = createPrivateKey(secret); }
  catch { throw new Error('A valid CRX signing key is required'); }
  if (key.asymmetricKeyType !== 'rsa' || createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64') !== expectedPublicKey) throw new Error('CRX signing key does not match');
  const directory = await mkdtemp(join(tmpdir(), 'credmemo-sign-'));
  const keyPath = join(directory, 'signing.pem');
  try {
    // 签名私钥只写入受限临时文件，禁止打包库自行生成另一把密钥改变插件身份。
    await writeFile(keyPath, key.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    await createCrx(createReadStream(zipPath), { keyPath, crxPath: target });
    return verifyCrx(await readFile(target), expectedPublicKey, await readFile(zipPath));
  } finally {
    await unlink(keyPath);
    await rmdir(directory);
  }
}
