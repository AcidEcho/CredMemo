import { build } from 'vite';
import { copyFile } from 'node:fs/promises';

await build();
await Promise.all(['LICENSE', 'NOTICE'].map(file => copyFile(file, `dist/${file}`)));
