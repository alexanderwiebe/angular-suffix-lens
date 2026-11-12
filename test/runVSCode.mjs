import { runTests } from '@vscode/test-electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
const root = path.resolve(import.meta.dirname, '..');
const app = '/Applications/Visual Studio Code.app/Contents/MacOS';
const exe = ['Code', 'Electron'].map((n) => path.join(app, n)).find((p) => fs.existsSync(p));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'asl-user-'));
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({ 'angularSuffixes.promptToEnableQuickOpenSymbols': false }));
await runTests({
  vscodeExecutablePath: exe,
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, 'test/suite/index.js'),
  launchArgs: [path.join(root, 'test/fixture'), '--disable-extensions', '--user-data-dir', userData, '--skip-welcome', '--disable-workspace-trust'],
});
