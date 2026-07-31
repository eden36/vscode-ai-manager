import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findVSCodeExecutable } from './find-vscode-executable.mjs';
import { runTests } from '@vscode/test-electron';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localExecutable = findVSCodeExecutable();
delete process.env.ELECTRON_RUN_AS_NODE;

await runTests({
  vscodeExecutablePath: localExecutable,
  extensionDevelopmentPath: projectRoot,
  extensionTestsPath: path.join(projectRoot, 'dist-test', 'integration.js'),
  launchArgs: [projectRoot, '--disable-extensions', '--skip-welcome', '--skip-release-notes'],
});
