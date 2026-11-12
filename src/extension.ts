import * as vscode from 'vscode';
import {
  CompiledRule,
  DEFAULT_RULES,
  RuleConfig,
  compileRules,
  detect,
  fuzzyScore,
  stemOf,
  virtualName,
} from './core';

const SECTION = 'angularSuffixes';

interface Entry {
  uri: vscode.Uri;
  diskName: string;
  virtualName: string;
  suffix: string;
  badge: string;
  /** Line of the decorator / matching code (0 for companions). */
  line: number;
  isCompanion: boolean;
}

interface Primary {
  uri: vscode.Uri;
  stem: string;
  rule: CompiledRule;
  line: number;
}

interface Settings {
  rules: CompiledRule[];
  include: string;
  exclude: string[];
  excludePrimary: string[];
  companionExtensions: string[];
  normalizeHyphenSuffix: boolean;
  maxFileSizeKB: number;
  maxFiles: number;
  explorerBadges: boolean;
  badgeCompanions: boolean;
  workspaceSymbols: boolean;
  editorTabLabels: boolean;
}

function readSettings(output: vscode.OutputChannel): Settings {
  const c = vscode.workspace.getConfiguration(SECTION);
  const { compiled, errors } = compileRules(c.get<RuleConfig[]>('rules', DEFAULT_RULES));
  for (const e of errors) output.appendLine(`[rules] ${e}`);
  if (errors.length) {
    void vscode.window.showWarningMessage(`Angular Suffix Lens: ${errors.length} rule(s) ignored. See the output channel.`);
  }
  return {
    rules: compiled,
    include: c.get('include', '**/*.ts'),
    exclude: c.get('exclude', []),
    excludePrimary: c.get('excludePrimary', []),
    companionExtensions: c.get('companionExtensions', []),
    normalizeHyphenSuffix: c.get('normalizeHyphenSuffix', true),
    maxFileSizeKB: c.get('maxFileSizeKB', 512),
    maxFiles: c.get('maxFiles', 50000),
    explorerBadges: c.get('explorerBadges', true),
    badgeCompanions: c.get('badgeCompanions', true),
    workspaceSymbols: c.get('workspaceSymbols', true),
    editorTabLabels: c.get('editorTabLabels', false),
  };
}

/** Builds a single exclude glob from our setting plus files.exclude / search.exclude. */
function excludeGlob(s: Settings): string | undefined {
  const globs = new Set<string>(s.exclude);
  for (const key of ['files.exclude', 'search.exclude']) {
    const [section, name] = key.split('.');
    const obj = vscode.workspace.getConfiguration(section).get<Record<string, unknown>>(name) ?? {};
    for (const [g, v] of Object.entries(obj)) if (v === true) globs.add(g);
  }
  if (!globs.size) return undefined;
  return globs.size === 1 ? [...globs][0] : `{${[...globs].join(',')}}`;
}

function dirKey(uri: vscode.Uri): string {
  return vscode.Uri.joinPath(uri, '..').toString();
}

function basename(uri: vscode.Uri): string {
  const p = uri.path;
  return p.slice(p.lastIndexOf('/') + 1);
}

function relDir(uri: vscode.Uri): string {
  const rel = vscode.workspace.asRelativePath(uri, vscode.workspace.workspaceFolders?.length !== 1);
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

/** Minimal glob matcher for excludePrimary (supports **, *, ?, {a,b}). */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`(^|/)${re}$`);
}

class AngularIndex implements vscode.Disposable {
  /** All workspace files (for the custom Go to File picker and companion lookup). */
  private files = new Map<string, vscode.Uri>();
  private dirs = new Map<string, Set<string>>(); // dirKey -> file uri strings
  private primaries = new Map<string, Primary>();
  private entries = new Map<string, Entry>();
  private settings!: Settings;
  private excludePrimaryRes: RegExp[] = [];
  private includeRe!: RegExp;
  private excludeRe: RegExp[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;
  private building: Promise<void> | undefined;
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly output: vscode.OutputChannel) {}

  get all(): Iterable<Entry> {
    return this.entries.values();
  }
  get allFiles(): Iterable<vscode.Uri> {
    return this.files.values();
  }
  get config(): Settings {
    return this.settings;
  }
  get(uri: vscode.Uri): Entry | undefined {
    return this.entries.get(uri.toString());
  }
  get ready(): Promise<void> {
    return this.building ?? Promise.resolve();
  }

  rebuild(): Promise<void> {
    this.building = this.doRebuild().catch((e) => this.output.appendLine(`[index] ${e?.stack ?? e}`));
    return this.building;
  }

  private async doRebuild() {
    const started = Date.now();
    this.startWatcher();
    this.settings = readSettings(this.output);
    this.excludePrimaryRes = this.settings.excludePrimary.map(globToRegExp);
    this.includeRe = globToRegExp(this.settings.include);
    const exclude = excludeGlob(this.settings);
    this.excludeRe = exclude ? [globToRegExp(exclude)] : [];
    this.files.clear();
    this.dirs.clear();
    this.primaries.clear();
    this.entries.clear();

    const uris = await vscode.workspace.findFiles('**/*', exclude, this.settings.maxFiles);
    for (const u of uris) this.addFile(u);

    const candidates = uris.filter((u) => this.isPrimaryCandidate(u));
    const BATCH = 64;
    for (let i = 0; i < candidates.length; i += BATCH) {
      await Promise.all(candidates.slice(i, i + BATCH).map((u) => this.detectPrimary(u)));
    }
    for (const dir of this.dirs.keys()) this.recomputeDir(dir);

    this.output.appendLine(
      `[index] ${uris.length} files, ${candidates.length} candidates, ${this.primaries.size} Angular files, ` +
        `${this.entries.size} renamed in ${Date.now() - started}ms`,
    );
    this._onDidChange.fire(undefined);
  }

  private startWatcher() {
    if (this.watcher) return;
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.watcher.onDidCreate((u) => this.onFsEvent(u, 'create'));
    this.watcher.onDidChange((u) => this.onFsEvent(u, 'change'));
    this.watcher.onDidDelete((u) => this.onFsEvent(u, 'delete'));
    // Edits made inside VS Code arrive immediately through these, even if the OS
    // watcher is slow or drops events. Handling a file twice is harmless.
    this.editorEvents.push(
      vscode.workspace.onDidCreateFiles((e) => e.files.forEach((u) => this.onFsEvent(u, 'create'))),
      vscode.workspace.onDidDeleteFiles((e) => e.files.forEach((u) => this.onFsEvent(u, 'delete'))),
      vscode.workspace.onDidRenameFiles((e) =>
        e.files.forEach(({ oldUri, newUri }) => {
          void this.onFsEvent(oldUri, 'delete');
          void this.onFsEvent(newUri, 'create');
        }),
      ),
      vscode.workspace.onDidSaveTextDocument((d) => this.onFsEvent(d.uri, 'change')),
    );
  }
  private editorEvents: vscode.Disposable[] = [];

  private async onFsEvent(uri: vscode.Uri, kind: 'create' | 'change' | 'delete') {
    await this.building;
    if (this.isExcluded(uri)) return;
    const key = uri.toString();
    const before = new Set(this.entriesInDir(dirKey(uri)).map((e) => e.uri.toString()));
    if (kind === 'delete') {
      // A deleted folder only produces one event; drop everything beneath it too.
      for (const k of [...this.files.keys()]) {
        if (k === key || k.startsWith(key + '/')) this.removeFile(this.files.get(k)!);
      }
    } else {
      if (kind === 'create') {
        const stat = await Promise.resolve(vscode.workspace.fs.stat(uri)).catch(() => undefined);
        if (stat && stat.type & vscode.FileType.Directory) {
          await this.rebuild(); // e.g. a folder moved in: just re-scan
          return;
        }
        this.addFile(uri);
      }
      if (this.isPrimaryCandidate(uri)) await this.detectPrimary(uri);
    }
    this.recomputeDir(dirKey(uri));
    const after = this.entriesInDir(dirKey(uri)).map((e) => e.uri.toString());
    const changed = new Set([...before, ...after, key]);
    this._onDidChange.fire([...changed].map((s) => vscode.Uri.parse(s)));
  }

  private isExcluded(uri: vscode.Uri): boolean {
    // Test the path and each parent folder, so "**/.git" also excludes ".git/HEAD".
    let rel = vscode.workspace.asRelativePath(uri, false);
    while (rel) {
      if (this.excludeRe.some((re) => re.test(rel))) return true;
      const i = rel.lastIndexOf('/');
      rel = i === -1 ? '' : rel.slice(0, i);
    }
    return false;
  }

  private addFile(uri: vscode.Uri) {
    const key = uri.toString();
    this.files.set(key, uri);
    const d = dirKey(uri);
    let set = this.dirs.get(d);
    if (!set) this.dirs.set(d, (set = new Set()));
    set.add(key);
  }

  private removeFile(uri: vscode.Uri) {
    const key = uri.toString();
    this.files.delete(key);
    this.primaries.delete(key);
    this.dirs.get(dirKey(uri))?.delete(key);
  }

  private isPrimaryCandidate(uri: vscode.Uri): boolean {
    const rel = vscode.workspace.asRelativePath(uri, false);
    if (!this.includeRe.test(rel)) return false;
    return !this.excludePrimaryRes.some((re) => re.test(rel));
  }

  private async detectPrimary(uri: vscode.Uri) {
    const key = uri.toString();
    this.primaries.delete(key);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > this.settings.maxFileSizeKB * 1024) return;
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      const hit = detect(text, this.settings.rules);
      if (hit) this.primaries.set(key, { uri, stem: stemOf(basename(uri)), rule: hit.rule, line: hit.line });
    } catch {
      // unreadable / deleted in the meantime
    }
  }

  private entriesInDir(dir: string): Entry[] {
    const out: Entry[] = [];
    for (const k of this.dirs.get(dir) ?? []) {
      const e = this.entries.get(k);
      if (e) out.push(e);
    }
    return out;
  }

  /** Recompute display names for one directory (primaries + their companions). */
  private recomputeDir(dir: string) {
    const keys = this.dirs.get(dir);
    if (!keys) return;
    for (const k of keys) this.entries.delete(k);
    const opts = { normalizeHyphenSuffix: this.settings.normalizeHyphenSuffix };
    const prims = [...keys].map((k) => this.primaries.get(k)).filter((p): p is Primary => !!p);
    for (const p of prims) {
      const name = virtualName(basename(p.uri), p.stem, p.rule.suffix, opts);
      if (name) this.setEntry(p.uri, name, p.rule, p.line, false);
    }
    if (!prims.length || !this.settings.companionExtensions.length) return;
    for (const k of keys) {
      if (this.entries.has(k) || this.primaries.has(k)) continue;
      const uri = this.files.get(k)!;
      const name = basename(uri);
      for (const p of prims) {
        const rest = name.startsWith(p.stem + '.') ? name.slice(p.stem.length) : undefined;
        if (!rest || !this.settings.companionExtensions.includes(rest)) continue;
        const v = virtualName(name, p.stem, p.rule.suffix, opts);
        if (v) this.setEntry(uri, v, p.rule, 0, true);
        break;
      }
    }
  }

  private setEntry(uri: vscode.Uri, name: string, rule: CompiledRule, line: number, isCompanion: boolean) {
    this.entries.set(uri.toString(), {
      uri,
      diskName: basename(uri),
      virtualName: name,
      suffix: rule.suffix,
      badge: rule.badge,
      line,
      isCompanion,
    });
  }

  dispose() {
    this.watcher?.dispose();
    this.editorEvents.forEach((d) => d.dispose());
    this._onDidChange.dispose();
  }
}

// ---------------------------------------------------------------------------
// Explorer / tabs / anywhere a file decoration is rendered
// ---------------------------------------------------------------------------
class Decorations implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  constructor(private readonly index: AngularIndex) {
    index.onDidChange((uris) => this._onDidChange.fire(uris));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const cfg = this.index.config;
    if (!cfg?.explorerBadges) return undefined;
    const e = this.index.get(uri);
    if (!e || (e.isCompanion && !cfg.badgeCompanions)) return undefined;
    return new vscode.FileDecoration(e.badge, `Angular ${e.suffix}: ${e.virtualName}`);
  }
}

// ---------------------------------------------------------------------------
// Ctrl+T, "#" in Ctrl+P, and Ctrl+P itself when search.quickOpen.includeSymbols is on
// ---------------------------------------------------------------------------
class Symbols implements vscode.WorkspaceSymbolProvider {
  constructor(private readonly index: AngularIndex) {}

  async provideWorkspaceSymbols(query: string): Promise<vscode.SymbolInformation[]> {
    await this.index.ready;
    if (!this.index.config?.workspaceSymbols || !query.trim()) return [];
    const scored: { e: Entry; s: number }[] = [];
    for (const e of this.index.all) {
      const s = fuzzyScore(query, e.virtualName);
      if (s !== undefined) scored.push({ e, s });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, 200).map(
      ({ e }) =>
        new vscode.SymbolInformation(
          e.virtualName,
          e.isCompanion ? vscode.SymbolKind.File : vscode.SymbolKind.Class,
          `${relDir(e.uri)} · ${e.diskName}`,
          new vscode.Location(e.uri, new vscode.Position(e.line, 0)),
        ),
    );
  }
}

// ---------------------------------------------------------------------------
// Custom "Go to File" picker that matches on the Angular names
// ---------------------------------------------------------------------------
interface FileItem extends vscode.QuickPickItem {
  uri: vscode.Uri;
}

function showGoToFile(index: AngularIndex) {
  const qp = vscode.window.createQuickPick<FileItem>();
  qp.placeholder = 'Search files by Angular name (e.g. "hoser" → home.service.ts)';
  qp.matchOnDescription = false;
  // We do our own filtering/sorting; keep VS Code from re-sorting our results.
  (qp as unknown as { sortByLabel: boolean }).sortByLabel = false;

  const toItem = (uri: vscode.Uri): FileItem => {
    const e = index.get(uri);
    const dir = relDir(uri);
    return {
      uri,
      label: e ? e.virtualName : basename(uri),
      description: e ? `${dir}${dir ? ' · ' : ''}${e.diskName}` : dir,
      resourceUri: uri,
      iconPath: vscode.ThemeIcon.File,
      alwaysShow: true,
    };
  };

  const recent = () => {
    const seen = new Set<string>();
    const out: vscode.Uri[] = [];
    for (const g of vscode.window.tabGroups.all)
      for (const t of g.tabs) {
        const u = (t.input as { uri?: vscode.Uri } | undefined)?.uri;
        if (u instanceof vscode.Uri && !seen.has(u.toString())) {
          seen.add(u.toString());
          out.push(u);
        }
      }
    return out;
  };

  const update = () => {
    const q = qp.value.trim();
    if (!q) {
      const r = recent();
      const seen = new Set(r.map(String));
      const rest = [...index.allFiles].filter((u) => !seen.has(u.toString())).slice(0, 200 - r.length);
      qp.items = [...r, ...rest].map(toItem);
      return;
    }
    const scored: { uri: vscode.Uri; s: number }[] = [];
    for (const uri of index.allFiles) {
      const e = index.get(uri);
      const name = e ? e.virtualName : basename(uri);
      const nameScore = fuzzyScore(q, name);
      const dir = relDir(uri);
      const pathScore = q.includes('/') ? fuzzyScore(q, dir ? `${dir}/${name}` : name) : undefined;
      const s = Math.max(nameScore !== undefined ? nameScore * 2 : -Infinity, pathScore ?? -Infinity);
      if (s !== -Infinity) scored.push({ uri, s });
    }
    scored.sort((a, b) => b.s - a.s);
    qp.items = scored.slice(0, 200).map((x) => toItem(x.uri));
  };

  qp.onDidChangeValue(update);
  qp.onDidAccept(async () => {
    const item = qp.selectedItems[0];
    if (!item) return;
    qp.hide();
    await vscode.window.showTextDocument(item.uri, { preview: true });
  });
  qp.onDidHide(() => qp.dispose());
  qp.busy = true;
  update();
  qp.show();
  void index.ready.then(() => {
    qp.busy = false;
    update();
  });
}

// ---------------------------------------------------------------------------
// "Angular Files" tree in the Explorer (shows the Angular names)
// ---------------------------------------------------------------------------
type Node = { kind: 'dir'; dir: string; entries: Entry[] } | { kind: 'file'; entry: Entry };

class Tree implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  constructor(private readonly index: AngularIndex) {
    index.onDidChange(() => this._onDidChange.fire());
  }
  getChildren(node?: Node): Node[] {
    if (node?.kind === 'dir') {
      return node.entries
        .sort((a, b) => a.virtualName.localeCompare(b.virtualName))
        .map((entry) => ({ kind: 'file', entry }));
    }
    if (node) return [];
    const groups = new Map<string, Entry[]>();
    for (const e of this.index.all) {
      const d = relDir(e.uri);
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d)!.push(e);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dir, entries]) => ({ kind: 'dir', dir, entries }));
  }
  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'dir') {
      const item = new vscode.TreeItem(node.dir || '(root)', vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = vscode.ThemeIcon.Folder;
      return item;
    }
    const e = node.entry;
    const item = new vscode.TreeItem(e.virtualName);
    item.resourceUri = e.uri; // file-icon theme icon + decorations
    item.description = e.diskName;
    item.tooltip = `${vscode.workspace.asRelativePath(e.uri)}\nShown as ${e.virtualName}`;
    item.command = { command: 'vscode.open', title: 'Open', arguments: [e.uri] };
    item.contextValue = 'angularFile';
    return item;
  }
}

// ---------------------------------------------------------------------------
// Editor tab titles via workbench.editor.customLabels.patterns (opt-in, writes workspace settings)
// ---------------------------------------------------------------------------
const OWNED_KEY = 'angularSuffixes.ownedLabelPatterns';

class TabLabels implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  constructor(
    private readonly index: AngularIndex,
    private readonly state: vscode.Memento,
    private readonly output: vscode.OutputChannel,
  ) {
    index.onDidChange(() => this.schedule());
  }
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.sync(), 1000);
  }
  async sync(forceRemove = false) {
    if (!vscode.workspace.workspaceFolders?.length) return;
    const enabled = !forceRemove && this.index.config?.editorTabLabels;
    const owned = new Set(this.state.get<string[]>(OWNED_KEY, []));
    if (!enabled && !owned.size) return;

    const cfg = vscode.workspace.getConfiguration('workbench.editor');
    const current = { ...(cfg.inspect<Record<string, string>>('customLabels.patterns')?.workspaceValue ?? {}) };
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(current)) if (!owned.has(k)) next[k] = v; // keep user's own patterns
    const nowOwned: string[] = [];
    if (enabled) {
      for (const e of this.index.all) {
        const rel = vscode.workspace.asRelativePath(e.uri, false);
        if (/[[\]{}*?]/.test(rel) || rel in next) continue;
        next[rel] = e.virtualName;
        nowOwned.push(rel);
      }
    }
    const same =
      Object.keys(next).length === Object.keys(current).length &&
      Object.entries(next).every(([k, v]) => current[k] === v);
    if (!same) {
      await cfg.update(
        'customLabels.patterns',
        Object.keys(next).length ? next : undefined,
        vscode.ConfigurationTarget.Workspace,
      );
      this.output.appendLine(`[tabs] wrote ${nowOwned.length} label pattern(s) to workspace settings`);
    }
    await this.state.update(OWNED_KEY, nowOwned);
  }
  dispose() {
    clearTimeout(this.timer);
  }
}

// ---------------------------------------------------------------------------

async function maybePromptQuickOpenSymbols(ctx: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  if (!cfg.get('promptToEnableQuickOpenSymbols', true)) return;
  if (vscode.workspace.getConfiguration('search').get('quickOpen.includeSymbols')) return;
  if (ctx.globalState.get('quickOpenPromptDismissed')) return;
  const enable = 'Enable';
  const never = "Don't Ask Again";
  const choice = await vscode.window.showInformationMessage(
    'Angular Suffix Lens: let Ctrl+P / Cmd+P find "home.service.ts" for a file named home.ts? ' +
      'This turns on "search.quickOpen.includeSymbols" in your user settings.',
    enable,
    'Not Now',
    never,
  );
  if (choice === enable) {
    await vscode.workspace
      .getConfiguration('search')
      .update('quickOpen.includeSymbols', true, vscode.ConfigurationTarget.Global);
  } else if (choice === never) {
    await ctx.globalState.update('quickOpenPromptDismissed', true);
  }
}

export interface Api {
  ready: Promise<void>;
  virtualNameOf(uri: vscode.Uri): string | undefined;
}

export function activate(ctx: vscode.ExtensionContext): Api {
  const output = vscode.window.createOutputChannel('Angular Suffix Lens');
  const index = new AngularIndex(output);
  const tabs = new TabLabels(index, ctx.workspaceState, output);

  ctx.subscriptions.push(
    output,
    index,
    tabs,
    vscode.window.registerFileDecorationProvider(new Decorations(index)),
    vscode.languages.registerWorkspaceSymbolProvider(new Symbols(index)),
    vscode.window.registerTreeDataProvider('angularSuffixes.files', new Tree(index)),
    vscode.commands.registerCommand('angularSuffixes.goToFile', () => showGoToFile(index)),
    vscode.commands.registerCommand('angularSuffixes.reindex', () => index.rebuild()),
    vscode.commands.registerCommand('angularSuffixes.syncTabLabels', () => tabs.sync()),
    vscode.commands.registerCommand('angularSuffixes.removeTabLabels', () => tabs.sync(true)),
    vscode.commands.registerCommand('angularSuffixes.copyAngularName', (arg?: vscode.Uri | Node) => {
      const uri =
        arg instanceof vscode.Uri
          ? arg
          : arg && 'entry' in arg
            ? arg.entry.uri
            : vscode.window.activeTextEditor?.document.uri;
      const e = uri && index.get(uri);
      if (e) void vscode.env.clipboard.writeText(e.virtualName);
    }),
    vscode.workspace.onDidChangeConfiguration((ev) => {
      if (ev.affectsConfiguration(SECTION) || ev.affectsConfiguration('files.exclude') || ev.affectsConfiguration('search.exclude')) {
        void index.rebuild();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void index.rebuild()),
  );

  void index.rebuild();
  void maybePromptQuickOpenSymbols(ctx);

  return {
    ready: index.ready,
    virtualNameOf: (uri) => index.get(uri)?.virtualName,
  };
}

export function deactivate() {}
