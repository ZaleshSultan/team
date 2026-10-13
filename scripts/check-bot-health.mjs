import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function isBotHealthy(value, now = Date.now()) {
  const checkedAt = typeof value?.checkedAt === 'string' ? Date.parse(value.checkedAt) : NaN;
  return value?.healthy === true && Number.isFinite(checkedAt) && checkedAt <= now && now - checkedAt <= 45_000;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = isBotHealthy(JSON.parse(await readFile(join(tmpdir(), 'squad-bot-health.json'), 'utf8'))) ? 0 : 1; }
  catch { process.exitCode = 1; }
}
