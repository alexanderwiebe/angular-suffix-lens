import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { compileRules, detect, virtualName, fuzzyScore, DEFAULT_RULES } = createRequire(import.meta.url)('../out/core.js');

const { compiled: rules } = compileRules(DEFAULT_RULES);
const kind = (src) => detect(src, rules)?.rule.suffix;
const opts = { normalizeHyphenSuffix: true };

test('detects each Angular kind', () => {
  assert.equal(kind(`@Component({ selector: 'app-home' }) export class Home {}`), 'component');
  assert.equal(kind(`@Injectable({ providedIn: 'root' }) export class Home {}`), 'service');
  assert.equal(kind(`@Service() export class HomeService {}`), 'service');
  assert.equal(kind(`@Directive({}) export class Hl {}`), 'directive');
  assert.equal(kind(`@Pipe({ name: 'x' }) export class X {}`), 'pipe');
  assert.equal(kind(`@NgModule({}) export class AppModule {}`), 'module');
  assert.equal(kind(`export const authGuard: CanActivateFn = () => true;`), 'guard');
  assert.equal(kind(`@Injectable() export class G implements CanActivate {}`), 'guard');
  assert.equal(kind(`export const auth: HttpInterceptorFn = (r, n) => n(r);`), 'interceptor');
  assert.equal(kind(`export const r: ResolveFn<User> = () => null;`), 'resolver');
  assert.equal(kind(`export const x = 1;`), undefined);
});

test('ignores decorators in comments and reports the line', () => {
  assert.equal(kind(`// @Component({})\n/* @Component( */\nexport const a = 1;`), undefined);
  assert.equal(detect(`import x;\n\n@Injectable()\nclass A {}`, rules).line, 2);
});

test('builds display names', () => {
  assert.equal(virtualName('home.ts', 'home', 'service', opts), 'home.service.ts');
  assert.equal(virtualName('home.html', 'home', 'component', opts), 'home.component.html');
  assert.equal(virtualName('home.spec.ts', 'home', 'component', opts), 'home.component.spec.ts');
  assert.equal(virtualName('auth-guard.ts', 'auth-guard', 'guard', opts), 'auth.guard.ts');
  assert.equal(virtualName('auth-guard.ts', 'auth-guard', 'guard', { normalizeHyphenSuffix: false }), 'auth-guard.guard.ts');
  assert.equal(virtualName('home.service.ts', 'home.service', 'service', opts), undefined);
  assert.equal(virtualName('other.html', 'home', 'component', opts), undefined);
});

test('fuzzy: "hoser" finds home.service.ts and ranks it above home.component.ts', () => {
  assert.ok(fuzzyScore('hoser', 'home.service.ts') !== undefined);
  assert.equal(fuzzyScore('hoser', 'home.ts'), undefined);
  const svc = fuzzyScore('homeser', 'home.service.ts');
  const cmp = fuzzyScore('homeser', 'home.component.ts');
  assert.ok(cmp === undefined || svc > cmp);
  assert.ok(fuzzyScore('hocom', 'home.component.ts') > (fuzzyScore('hocom', 'house-of-commons.ts') ?? -1) - 100);
});

test('invalid rules are reported, not thrown', () => {
  const { compiled, errors } = compileRules([{ suffix: 'x', pattern: '(' }, { suffix: '', pattern: 'a' }, { suffix: 'ok', pattern: 'a', enabled: false }]);
  assert.equal(compiled.length, 0);
  assert.equal(errors.length, 2);
});
