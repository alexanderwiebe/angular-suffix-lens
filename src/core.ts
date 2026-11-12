// Pure logic (no `vscode` import) so it can be unit tested with plain Node.

export interface RuleConfig {
  /** Suffix inserted into the displayed name, e.g. "service" -> home.service.ts */
  suffix: string;
  /** JavaScript regular expression source that must match the file content. */
  pattern: string;
  /** Regular expression flags (default "m"). */
  flags?: string;
  /** 1-2 character Explorer badge. Defaults to the first letter of the suffix. */
  badge?: string;
  /** Set to false to disable a rule without deleting it. */
  enabled?: boolean;
}

export interface CompiledRule {
  suffix: string;
  badge: string;
  re: RegExp;
}

export interface Detection {
  rule: CompiledRule;
  /** Zero-based line of the first match. */
  line: number;
}

export function compileRules(rules: RuleConfig[]): { compiled: CompiledRule[]; errors: string[] } {
  const compiled: CompiledRule[] = [];
  const errors: string[] = [];
  for (const r of rules ?? []) {
    if (!r || r.enabled === false) continue;
    const suffix = String(r.suffix ?? '').trim().replace(/^\.+|\.+$/g, '');
    if (!suffix || !r.pattern) {
      errors.push(`Rule needs both "suffix" and "pattern": ${JSON.stringify(r)}`);
      continue;
    }
    try {
      const flags = (r.flags ?? 'm').replace(/g/g, '');
      compiled.push({
        suffix,
        badge: (r.badge ?? suffix[0].toUpperCase()).slice(0, 2),
        re: new RegExp(r.pattern, flags),
      });
    } catch (e) {
      errors.push(`Invalid pattern for "${suffix}": ${(e as Error).message}`);
    }
  }
  return { compiled, errors };
}

/**
 * Blank out comments (keeping offsets and newlines intact) so a decorator that
 * only appears in a comment does not trigger a rule.
 */
export function stripComments(src: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^[ \t]*\/\/.*$/gm, blank);
}

/** First rule (in configured order) whose pattern matches wins. */
export function detect(content: string, rules: CompiledRule[]): Detection | undefined {
  const text = stripComments(content);
  for (const rule of rules) {
    const m = rule.re.exec(text);
    if (m) {
      let line = 0;
      for (let i = 0; i < m.index; i++) if (text.charCodeAt(i) === 10) line++;
      return { rule, line };
    }
  }
  return undefined;
}

/** "home.ts" -> "home"; "home.spec.ts" -> "home.spec" */
export function stemOf(basename: string): string {
  const i = basename.lastIndexOf('.');
  return i > 0 ? basename.slice(0, i) : basename;
}

export interface NameOptions {
  /** Turn `home-pipe.ts` into `home.pipe.ts` instead of `home-pipe.pipe.ts`. */
  normalizeHyphenSuffix: boolean;
}

/**
 * Compute the displayed name for `basename`, which is either the primary file
 * (stem + ".ts") or a companion that shares its stem (stem + ".html", ".spec.ts" ...).
 * Returns undefined when the name should not change.
 */
export function virtualName(
  basename: string,
  primaryStem: string,
  suffix: string,
  opts: NameOptions,
): string | undefined {
  if (!basename.startsWith(primaryStem + '.')) return undefined;
  const lowerStem = primaryStem.toLowerCase();
  const lowerSuffix = suffix.toLowerCase();
  // Already follows the classic convention (home.service.ts) - leave it alone.
  if (lowerStem.endsWith('.' + lowerSuffix)) return undefined;
  let stem = primaryStem;
  if (opts.normalizeHyphenSuffix && lowerStem.endsWith('-' + lowerSuffix) && stem.length > suffix.length + 1) {
    stem = stem.slice(0, stem.length - suffix.length - 1);
  }
  const rest = basename.slice(primaryStem.length); // ".ts", ".html", ".spec.ts"
  return `${stem}.${suffix}${rest}`;
}

const SEPARATORS = new Set(['.', '-', '_', '/', '\\', ' ']);

/**
 * Small fuzzy scorer: every query character must appear in order in the target.
 * Rewards consecutive runs, word starts and short targets. Returns undefined on no match.
 */
export function fuzzyScore(query: string, target: string): number | undefined {
  const q = query.replace(/\s+/g, '').toLowerCase();
  if (!q) return 0;
  const t = target.toLowerCase();
  // Try every possible start for the first character and keep the best greedy run.
  let best: number | undefined;
  let start = t.indexOf(q[0]);
  while (start !== -1) {
    const s = scoreFrom(q, t, target, start);
    if (s !== undefined && (best === undefined || s > best)) best = s;
    start = t.indexOf(q[0], start + 1);
  }
  return best;
}

function scoreFrom(q: string, t: string, original: string, start: number): number | undefined {
  let score = 0;
  let ti = start;
  let prevMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    // Prefer a word-start occurrence of the char if the next plain occurrence is not consecutive.
    let idx = t.indexOf(q[qi], ti);
    if (idx === -1) return undefined;
    if (idx !== prevMatch + 1) {
      let j = idx;
      while (j !== -1 && !isWordStart(original, j)) j = t.indexOf(q[qi], j + 1);
      if (j !== -1) idx = j;
    }
    score += 1;
    if (idx === prevMatch + 1) score += 5;
    if (isWordStart(original, idx)) score += 8;
    prevMatch = idx;
    ti = idx + 1;
  }
  if (start === 0) score += 4;
  score -= Math.min(t.length, 100) * 0.05;
  return score;
}

function isWordStart(s: string, i: number): boolean {
  if (i === 0) return true;
  const prev = s[i - 1];
  if (SEPARATORS.has(prev)) return true;
  const c = s[i];
  return c !== c.toLowerCase() && prev === prev.toLowerCase();
}

export const DEFAULT_RULES: RuleConfig[] = [
  { suffix: 'component', pattern: '@Component\\s*\\(', badge: 'C' },
  { suffix: 'directive', pattern: '@Directive\\s*\\(', badge: 'D' },
  { suffix: 'pipe', pattern: '@Pipe\\s*\\(', badge: 'P' },
  { suffix: 'module', pattern: '@NgModule\\s*\\(', badge: 'M' },
  {
    suffix: 'guard',
    pattern: ':\\s*(CanActivateFn|CanActivateChildFn|CanDeactivateFn|CanMatchFn)\\b|implements\\s+[^{]*\\b(CanActivate|CanActivateChild|CanDeactivate|CanMatch)\\b',
    badge: 'G',
  },
  { suffix: 'interceptor', pattern: ':\\s*HttpInterceptorFn\\b|implements\\s+[^{]*\\bHttpInterceptor\\b', badge: 'I' },
  { suffix: 'resolver', pattern: ':\\s*ResolveFn\\b|implements\\s+[^{]*\\bResolve\\s*<', badge: 'R' },
  { suffix: 'service', pattern: '@(Injectable|Service)\\s*\\(', badge: 'S' },
];
