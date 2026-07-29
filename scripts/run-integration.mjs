import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configuredExecutable = process.env.AI_MANAGER_VSCODE_EXECUTABLE;
const localExecutable = configuredExecutable || findLocalVSCode();
delete process.env.ELECTRON_RUN_AS_NODE;

await runTests({
  ...(localExecutable
    ? { vscodeExecutablePath: localExecutable }
    : { version: process.env.AI_MANAGER_VSCODE_VERSION || '1.121.0' }),
  extensionDevelopmentPath: projectRoot,
  extensionTestsPath: path.join(projectRoot, 'dist-test', 'integration.js'),
  launchArgs: [projectRoot, '--disable-extensions', '--skip-welcome', '--skip-release-notes'],
});

function findLocalVSCode() {
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    const cli = execFileSync(command, ['code'], { encoding: 'utf8' }).split(/\r?\n/).find(Boolean);
    if (!cli) return undefined;
    if (process.platform !== 'win32') return cli;
    const executable = path.resolve(path.dirname(cli), '..', 'Code.exe');
    return fs.existsSync(executable) ? executable : undefined;
  } catch {
    return undefined;
  }
}
