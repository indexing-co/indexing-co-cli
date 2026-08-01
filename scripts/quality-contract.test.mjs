import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const pkg = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8')
);

test('quality contract keeps bounded repository-owned lanes', () => {
  assert.equal(pkg.scripts['quality:contract'], 'node --test scripts/quality-contract.test.mjs');
  assert.equal(
    pkg.scripts['quality:baseline'],
    'npm run quality:contract && npm run typecheck && npm test'
  );
  assert.match(pkg.scripts['quality:security'], /key-fingerprint\.test\.js/);
  assert.match(pkg.scripts['quality:security'], /key-handoff\.test\.js/);
  assert.equal(pkg.scripts['quality:integration'], 'node scripts/run-staging-integration.mjs');

  for (const name of ['quality:baseline', 'quality:security', 'quality:integration']) {
    assert.doesNotMatch(pkg.scripts[name], /npm publish|npm version|git push/);
  }
});
