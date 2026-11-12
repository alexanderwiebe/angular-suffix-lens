# Angular Suffix Lens

Angular 20's style guide dropped file suffixes, so `home.component.ts` becomes `home.ts` and `home.service.ts` becomes `home.ts` too. This extension reads each file, works out what it is, and shows the classic name in VS Code. **Nothing is renamed on disk.**

| On disk | Shown as | Because the file contains |
|---|---|---|
| `home/home.ts` | `home.component.ts` | `@Component(` |
| `home/home.html`, `.scss`, `.spec.ts` | `home.component.html` … | sibling of a component |
| `services/home.ts` | `home.service.ts` | `@Service(` or `@Injectable(` |
| `guards/auth-guard.ts` | `auth.guard.ts` | `: CanActivateFn` |

Directives, pipes, NgModules, interceptors and resolvers are detected out of the box. You can add your own rules.

## Where the names show up

| Place | How |
|---|---|
| **Ctrl+P / Cmd+P** (type `hoser` → `home.service.ts`) | Turn on `search.quickOpen.includeSymbols`. The extension offers to do it on first run. Angular names then show up in the normal Go to File list, under the file results. |
| `#hoser` in Ctrl+P, or **Ctrl+T** | Workspace symbols. Works without any setting. |
| **Ctrl+Alt+P / Cmd+Alt+P** | "Go to File (Angular Names)". This picker lists every workspace file, ranked by the Angular name. |
| Explorer | A badge (C, S, D, P, M, G, I, R) and a hover tooltip with the Angular name, plus an **Angular Files** view that lists files by their Angular names. |
| Editor tab titles | Opt-in: `angularSuffixes.editorTabLabels`. The extension writes `workbench.editor.customLabels.patterns` entries into `.vscode/settings.json` and removes them again when you turn the setting off. |

### Want the Angular picker on Ctrl+P itself?

Add this to `keybindings.json`:

```json
{ "key": "cmd+p", "command": "angularSuffixes.goToFile" },
{ "key": "cmd+p", "command": "-workbench.action.quickOpen" }
```

(Use `ctrl+p` on Windows/Linux.)

### What VS Code can't do

The extension API can't rename items in the built-in Explorer tree, and it can't change how the built-in Ctrl+P matches file paths. That's why the features above use symbols, badges, a custom view and a custom picker.

## Configuration

`angularSuffixes.rules` is an ordered list. The first rule whose regex matches the file content wins, and comments are ignored. Example: show NgRx signal stores as `*.store.ts`. Put the new rule before `service` so it's checked first:

```json
"angularSuffixes.rules": [
  { "suffix": "store", "pattern": "signalStore\\(", "badge": "St" },
  { "suffix": "component", "pattern": "@Component\\s*\\(" },
  { "suffix": "service", "pattern": "@Injectable\\s*\\(" }
]
```

Other settings: `include`, `exclude`, `excludePrimary`, `companionExtensions`, `normalizeHyphenSuffix`, `workspaceSymbols`, `explorerBadges`, `badgeCompanions`, `treeView`, `editorTabLabels`, `maxFileSizeKB`, `maxFiles`.

## Develop

```bash
npm install
npm test             # unit tests (naming, detection, fuzzy matching)
npm run test:vscode  # integration test in an isolated VS Code window
npm run package      # builds angular-suffix-lens-0.1.0.vsix
```
