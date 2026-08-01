import { spawnSync } from 'node:child_process';

if (!process.env.INDEXING_CO_STAGING_API_KEY) {
  process.stderr.write(
    'quality:integration unavailable: INDEXING_CO_STAGING_API_KEY is not configured.\n'
  );
  process.exit(2);
}

const result = spawnSync('npm', ['run', 'test:integration'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'inherit',
  shell: false,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
