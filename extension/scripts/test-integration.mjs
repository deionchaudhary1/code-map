import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';

const extensionRoot = resolve(import.meta.dirname, '..');
const extensionTestsPath = join(extensionRoot, 'dist/tests/integration.cjs');

await build({
  absWorkingDir: extensionRoot,
  entryPoints: ['tests/integration.ts'],
  outfile: extensionTestsPath,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode'],
});

const testRoot = resolve(process.env.CODE_MAP_TEST_ROOT ?? join(tmpdir(), 'code-map-vscode'));
await mkdir(testRoot, { recursive: true });
const runRoot = await mkdtemp(join(testRoot, 'run-'));
const workspace = join(runRoot, 'workspace');
const fixture = process.env.CODE_MAP_TEST_WORKSPACE ?? join(extensionRoot, '../examples/demo');

try {
  await cp(resolve(fixture), workspace, { recursive: true });
  await runTests({
    cachePath: join(testRoot, 'vscode-test'),
    version: process.env.CODE_MAP_VSCODE_VERSION ?? '1.96.4',
    vscodeExecutablePath: process.env.CODE_MAP_VSCODE_EXECUTABLE,
    extensionDevelopmentPath: extensionRoot,
    extensionTestsPath,
    extensionTestsEnv: { CODE_MAP_TEST_ROOT: testRoot, CODE_MAP_TEST_WORKSPACE: workspace },
    launchArgs: [
      workspace,
      '--disable-extensions',
      `--user-data-dir=${join(runRoot, 'user-data')}`,
      `--extensions-dir=${join(runRoot, 'extensions')}`,
    ],
  });
} finally {
  await rm(runRoot, { recursive: true, force: true });
}
