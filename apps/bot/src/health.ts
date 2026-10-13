import { writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const BOT_HEALTH_PATH = join(tmpdir(), 'squad-bot-health.json');
const temporaryPath = `${BOT_HEALTH_PATH}.${process.pid}.tmp`;
export async function writeBotHealth(healthy: boolean, now = new Date()) {
  await writeFile(temporaryPath, JSON.stringify({ healthy, checkedAt: now.toISOString() }), { mode: 0o600 });
  await rename(temporaryPath, BOT_HEALTH_PATH);
}
export function startBotHealth(check: () => Promise<boolean>, write: typeof writeBotHealth = writeBotHealth) {
  let checking = false; let stopping = false;
  let active: Promise<void> | undefined;
  const update = async () => {
    if (checking || stopping) return; checking = true;
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 5_000); timer.unref(); });
      const healthy = await Promise.race([check().catch(() => false), timeout]);
      await write(!stopping && healthy);
    } catch { /* A stale/missing heartbeat fails its container healthcheck. */ }
    finally { if (timer) clearTimeout(timer); checking = false; }
  };
  const schedule = () => { if (!active && !stopping) active = update().finally(() => { active = undefined; }); };
  const interval = setInterval(schedule, 15_000); interval.unref(); schedule();
  return { async stop() { stopping = true; clearInterval(interval); await active; await write(false).catch(() => undefined); } };
}
