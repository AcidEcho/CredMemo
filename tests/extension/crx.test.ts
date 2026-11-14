import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packCrx, verifyCrx } from '../../scripts/crx.ts';

const keypair = () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { secret: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
};

test('CRX3 preserves the ZIP and keeps its extension ID across versions signed by the same key', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'credmemo-crx-test-'));
  const keys = keypair(), ids: string[] = [];
  try {
    for (const version of ['1.0.0', '1.0.1']) {
      const zip = join(folder, `${version}.zip`), crx = join(folder, `${version}.crx`);
      execFileSync('python3', ['-c', 'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z:z.writestr("manifest.json",json.dumps({"manifest_version":3,"name":"Fixture","version":sys.argv[2]}))', zip, version]);
      ids.push((await packCrx(zip, crx, keys.secret, keys.publicKey)).extensionId);
      const packed = await readFile(crx), content = await readFile(zip);
      const verified = verifyCrx(packed, keys.publicKey, content);
      assert.deepEqual(packed.subarray(verified.zipOffset), content);
      assert.match(verified.extensionId, /^[a-p]{32}$/);
      const tampered = Buffer.from(packed);
      tampered[tampered.length - 1] ^= 1;
      assert.throws(() => verifyCrx(tampered, keys.publicKey, content), /signature/);
      assert.throws(() => verifyCrx(packed, keypair().publicKey, content), /key does not match/);
      assert.throws(() => verifyCrx(packed, keys.publicKey, Buffer.from('unrelated archive')), /payload/);
    }
    assert.equal(ids[0], ids[1]);
  } finally { await rm(folder, { recursive: true }); }
});

test('CRX signing refuses missing or mismatched keys without producing a replacement identity', async () => {
  const keys = keypair();
  await assert.rejects(packCrx('unused.zip', 'unused.crx', '', keys.publicKey), /valid CRX signing key/);
  await assert.rejects(packCrx('unused.zip', 'unused.crx', keypair().secret, keys.publicKey), /key does not match/);
  for (const bytes of [Buffer.alloc(0), Buffer.from('not a CRX file'), Buffer.from('Cr24\x03\0\0\0\xff\xff\xff\xff')]) {
    assert.throws(() => verifyCrx(bytes, keys.publicKey, Buffer.alloc(0)), /Invalid CRX3/);
  }
});
