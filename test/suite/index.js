const vscode = require('vscode');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function () {
  const ext = vscode.extensions.getExtension('ajwiebe.angular-suffix-lens');
  const api = await ext.activate();
  await api.ready;
  const root = vscode.workspace.workspaceFolders[0].uri;
  const u = (p) => vscode.Uri.joinPath(root, p);
  fs.rmSync(path.join(root.fsPath, '.vscode'), { recursive: true, force: true });
  const results = [];
  const check = (name, fn) => results.push(Promise.resolve().then(fn).then(() => console.log('  ✔', name), (e) => { console.log('  ✘', name, e.message); throw e; }));

  check('component + companions', () => {
    assert.equal(api.virtualNameOf(u('src/app/home/home.ts')), 'home.component.ts');
    assert.equal(api.virtualNameOf(u('src/app/home/home.html')), 'home.component.html');
    assert.equal(api.virtualNameOf(u('src/app/home/home.scss')), 'home.component.scss');
    assert.equal(api.virtualNameOf(u('src/app/home/home.spec.ts')), 'home.component.spec.ts');
  });
  check('service / guard / plain', () => {
    assert.equal(api.virtualNameOf(u('src/app/services/home.ts')), 'home.service.ts');
    assert.equal(api.virtualNameOf(u('src/app/guards/auth-guard.ts')), 'auth.guard.ts');
    assert.equal(api.virtualNameOf(u('src/app/plain.ts')), undefined);
  });
  check('workspace symbol search "hoser" -> home.service.ts', async () => {
    const syms = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', 'hoser');
    const hit = syms.find((s) => s.name === 'home.service.ts');
    assert.ok(hit, 'got: ' + syms.map((s) => s.name).join(', '));
    assert.equal(hit.location.uri.path.endsWith('/services/home.ts'), true);
    assert.equal(hit.location.range.start.line, 2);
  });
  await Promise.all(results.splice(0));

  // Live update: create a pipe file on disk (outside VS Code) and wait for the OS watcher.
  await wait(1500);
  const pipe = u('src/app/home/price-pipe.ts');
  fs.writeFileSync(pipe.fsPath, "@Pipe({ name: 'price' })\nexport class PricePipe {}\n");
  let name;
  for (let i = 0; i < 80 && !name; i++) { await wait(250); name = api.virtualNameOf(pipe); }
  fs.unlinkSync(pipe.fsPath);
  check('watcher picks up new file', () => assert.equal(name, 'price.pipe.ts'));

  // Editor tab labels (opt-in) write workspace settings.
  await vscode.workspace.getConfiguration('angularSuffixes').update('editorTabLabels', true, vscode.ConfigurationTarget.Workspace);
  let patterns;
  for (let i = 0; i < 40; i++) {
    await wait(250);
    patterns = vscode.workspace.getConfiguration('workbench.editor').get('customLabels.patterns') || {};
    if (patterns['src/app/services/home.ts']) break;
  }
  assert.ok(true);
  check('tab labels written', () => assert.equal(patterns['src/app/services/home.ts'], 'home.service.ts'));
  await vscode.workspace.getConfiguration('angularSuffixes').update('editorTabLabels', undefined, vscode.ConfigurationTarget.Workspace);
  for (let i = 0; i < 40; i++) {
    await wait(250);
    patterns = vscode.workspace.getConfiguration('workbench.editor').get('customLabels.patterns') || {};
    if (!patterns['src/app/services/home.ts']) break;
  }
  check('tab labels removed when disabled', () => assert.equal(patterns['src/app/services/home.ts'], undefined));
  await Promise.all(results);
  fs.rmSync(path.join(root.fsPath, '.vscode'), { recursive: true, force: true });
};
