# Changelog

## 0.1.1

- First Marketplace release.
- Detects Angular 22's `@Service()` as well as `@Injectable()`.
- Activates only in Angular / Nx workspaces (`angular.json`, `nx.json` or `project.json`).

## 0.1.0

- Shows Angular names (`home.service.ts`, `home.component.ts`, …) for suffix-less files, based on their contents. Nothing is renamed on disk.
- Ctrl+P / Cmd+P matching through workspace symbols (with `search.quickOpen.includeSymbols`), plus a "Go to File (Angular Names)" picker on Cmd+Alt+P / Ctrl+Alt+P.
- Explorer badges and tooltips, an "Angular Files" view, and optional editor tab labels.
- Configurable detection rules.
