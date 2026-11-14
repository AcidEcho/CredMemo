import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { packCrx } from './crx.ts';

await import('./build.mjs');

const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
const project = JSON.parse(await readFile('package.json', 'utf8'));
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(project.version) || [manifest.version, lock.version, lock.packages[''].version].some(version => version !== project.version)) throw new Error('Release versions must match');
if (manifest.manifest_version !== 3 || manifest.host_permissions?.length || manifest.permissions.some(permission => ['unlimitedStorage', 'desktopCapture'].includes(permission))) throw new Error('Unexpected manifest permissions');
if (manifest.options_ui || manifest.options_page) throw new Error('A management page is not supported');
const files = await readdir('dist', { recursive: true });
for (const required of ['LICENSE', 'NOTICE', 'licenses/jsqr.txt', 'licenses/vite.txt']) {
  if (!files.includes(required)) throw new Error(`Missing distribution notice: ${required}`);
}
if (files.includes('index.html') || files.includes('scan.html')) throw new Error('Unexpected standalone page');
for (const file of files) {
  if (/\.(py|env|pem|key)$/.test(file) || file.includes('node_modules')) throw new Error('Unexpected release file');
}
await mkdir('release', { recursive: true });
const target = resolve(`release/CredMemo-${manifest.version}.zip`);
// 发行包仅包含可加载的扩展文件，开发环境和旧服务代码不进入安装包。
const script = 'import pathlib,sys,zipfile\nroot=pathlib.Path("dist")\nwith zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED) as archive:\n for path in sorted(root.rglob("*")):\n  if path.is_file(): archive.write(path,path.relative_to(root))';
execFileSync('python3', ['-c', script, target], { stdio: 'inherit' });
console.log(`${target} (${(await stat(target)).size} bytes)`);
const signingKey = process.env.CREDMEMO_CRX_PRIVATE_KEY || await readFile('.runtime/crx-signing.pem', 'utf8').catch(() => {
  throw new Error('CRX signing key is required. Set CREDMEMO_CRX_PRIVATE_KEY; use npm run build for unpacked development.');
});
const { publicKey } = JSON.parse(await readFile('crx-public-key.json', 'utf8'));
const crxTarget = resolve(`release/CredMemo-${manifest.version}.crx`);
const signed = await packCrx(target, crxTarget, signingKey, publicKey);
console.log(`${crxTarget} (${(await stat(crxTarget)).size} bytes; ID: ${signed.extensionId})`);
