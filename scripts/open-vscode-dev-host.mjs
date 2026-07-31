import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findVSCodeExecutable } from './find-vscode-executable.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = findVSCodeExecutable();
const args = [
  `--extensionDevelopmentPath=${projectRoot}`,
  projectRoot,
  '--new-window',
  '--disable-extensions',
];

const child = spawn(executable, args, {
  detached: true,
  stdio: 'ignore',
  windowsHide: false,
});
child.unref();

console.log(`已用 VS Code 打开扩展开发宿主：${executable}`);
