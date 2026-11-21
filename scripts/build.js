import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await Promise.all([
  mkdir('dist/web', { recursive: true }),
  mkdir('dist/extension/icons', { recursive: true }),
]);
await Promise.all([
  build({ entryPoints: ['web/main.js'], bundle: true, format: 'esm', outfile: 'dist/web/main.js', loader: { '.svg': 'text' } }),
  build({ entryPoints: ['extension/popup.js', 'extension/capture.js', 'extension/background.js'], bundle: true, format: 'iife', outdir: 'dist/extension' }),
  ...['index.html', 'style.css'].map((name) => copyFile(`web/${name}`, `dist/web/${name}`)),
  ...['manifest.json', 'popup.html', 'popup.css'].map((name) => copyFile(`extension/${name}`, `dist/extension/${name}`)),
  ...[16, 48, 128].map((size) => copyFile(`extension/icons/icon-${size}.png`, `dist/extension/icons/icon-${size}.png`)),
]);
