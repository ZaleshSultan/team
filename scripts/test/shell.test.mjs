import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const available = spawnSync(bash, ['--version'], { windowsHide: true }).status === 0;
test('backup and smoke scripts: syntax, retention, fail closed and secret-free output using doubles', { skip: !available }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squad-m7-ops-'));
  const run = (script, env = {}) => spawnSync(bash, ['-c', 'export PATH="$MOCK_BIN:$PATH"; bash "$SQUAD_SCRIPT"'], {
    cwd: resolve('.'), encoding: 'utf8', windowsHide: true,
    env: { ...process.env, MOCK_BIN: directory.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_match, drive) => `/${drive.toLowerCase()}`), SQUAD_SCRIPT: script,
      BACKUP_DIR: `${directory.replaceAll('\\', '/')}/backups`, BACKUP_KEEP: '2', ...env },
  });
  try {
    await writeFile(join(directory, 'flock'), '#!/usr/bin/env bash\nexit "${MOCK_LOCK_FAILURE:-0}"\n', { mode: 0o700 });
    await writeFile(join(directory, 'docker'), `#!/usr/bin/env bash
if [[ "$*" == *'exec -T postgres'* ]]; then
  [[ "\${MOCK_DUMP_FAIL:-0}" == 0 ]] || { echo 'database://user:PRIVATE_SECRET@host' >&2; exit 1; }
  printf '%s\\n' 'CREATE TABLE backup_fixture(id integer);'
elif [[ "$1" == inspect ]]; then printf '%s\\n' "running \${MOCK_HEALTH:-healthy}"
else printf '%s\\n' 'opaque-container-id'; fi
`, { mode: 0o700 });
    await writeFile(join(directory, 'curl'), `#!/usr/bin/env bash
[[ "\${MOCK_HTTP_FAIL:-0}" == 0 ]] || { echo 'https://PRIVATE_SECRET@host' >&2; exit 1; }
[[ "$*" == *'/health'* || "$*" == *'/ready'* ]] && printf '%s\\n' '{"status":"ok"}'
exit 0
`, { mode: 0o700 });
    assert.equal(spawnSync(bash, ['-n', 'scripts/backup.sh', 'scripts/smoke.sh'], { windowsHide: true }).status, 0);
    for (let count = 0; count < 3; count++) {
      const result = run('scripts/backup.sh'); assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_SECRET/);
    }
    const archiveNames = (await readdir(join(directory, 'backups'))).filter((name) => name.endsWith('.sql.gz'));
    assert.equal(archiveNames.length, 2);
    assert.match(gunzipSync(await readFile(join(directory, 'backups', archiveNames[0]))).toString(), /backup_fixture/);
    for (const settings of [{ MOCK_DUMP_FAIL: '1' }, { MOCK_LOCK_FAILURE: '1' }, { BACKUP_KEEP: '0' }]) {
      const result = run('scripts/backup.sh', settings); assert.notEqual(result.status, 0); assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_SECRET/);
      assert.equal((await readdir(join(directory, 'backups'))).filter((name) => name.endsWith('.sql.gz')).length, 2);
    }
    assert.equal(run('scripts/smoke.sh').status, 0);
    for (const settings of [{ MOCK_HTTP_FAIL: '1' }, { MOCK_HEALTH: 'unhealthy' }, { SMOKE_ORIGIN: 'https://user:PRIVATE_SECRET@host' }]) {
      const result = run('scripts/smoke.sh', settings); assert.notEqual(result.status, 0); assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_SECRET/);
    }
  } finally {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.equal(basename(target).startsWith('squad-m7-ops-'), true);
    await rm(target, { recursive: true, force: true });
  }
});
