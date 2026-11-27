import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const extensionRoot = resolve(import.meta.dirname, '..');
const webRoot = resolve(extensionRoot, '../web');

await build({
  absWorkingDir: extensionRoot,
  entryPoints: ['src/extension.ts', 'src/analysisWorker.ts'],
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode', 'ts-morph', 'ignore'],
  // The shared analysis code passes import.meta.url to createRequire().
  define: { 'import.meta.url': '__filename' },
});

const webBuild = spawnSync(
  process.execPath,
  ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.extension.config.ts'],
  { cwd: webRoot, stdio: 'inherit' },
);

if (webBuild.error) throw webBuild.error;
if (webBuild.status !== 0) {
  throw new Error(`Code Map webview build failed (${webBuild.signal ?? webBuild.status}).`);
}
