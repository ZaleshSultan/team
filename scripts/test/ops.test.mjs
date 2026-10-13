import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateHeaders, checkSecurityHeaders } from '../check-security-headers.mjs';
import { isBotHealthy } from '../check-bot-health.mjs';

const config = await readFile(new URL('../../deploy/security-headers.conf', import.meta.url), 'utf8');
const headers = () => new Headers({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': /Content-Security-Policy "([^"]+)"/.exec(config)[1] });
test('configured CSP permits Telegram frames and SDK without inline/eval scripts', () => validateHeaders(headers()));
for (const [name, value, code] of [
  ['x-content-type-options', '', 'NOSNIFF_MISSING'], ['referrer-policy', 'origin', 'REFERRER_POLICY_MISSING'],
  ['content-security-policy', "script-src 'self' 'unsafe-inline' https://telegram.org", 'UNSAFE_SCRIPT_POLICY'],
  ['content-security-policy', "script-src 'self' https://telegram.org; frame-ancestors 'self'", 'TELEGRAM_FRAME_POLICY_MISSING'],
]) test(`rejects insecure ${name}: ${code}`, () => {
  const changed = headers(); changed.set(name, value); assert.throws(() => validateHeaders(changed), new RegExp(code));
});
function upstream({ html, bundle = 'console.log("compiled")', mapStatus = 404, badAssetHeaders = false } = {}) {
  return async (url) => {
    const path = new URL(url).pathname;
    return new Response(path === '/' ? html ?? '<script src="https://telegram.org/js/telegram-web-app.js"></script><script type="module" src="/assets/app.js"></script>' : path.endsWith('.map') ? '' : bundle,
      { status: path.endsWith('.map') ? mapStatus : 200, headers: badAssetHeaders && path !== '/' ? {} : headers() });
  };
}
test('fetch checker verifies HTML, assets and unavailable source maps', async () => {
  assert.equal(await checkSecurityHeaders('https://public.example', upstream()), 1);
});
for (const [options, code] of [
  [{ html: '<script>alert("inline")</script>' }, 'INLINE_SCRIPT_FOUND'],
  [{ html: '<script src="https://other.example/code.js"></script>' }, 'UNEXPECTED_SCRIPT_SOURCE'],
  [{ bundle: '//# sourceMappingURL=app.js.map' }, 'SOURCE_MAP_REFERENCE_FOUND'],
  [{ mapStatus: 200 }, 'SOURCE_MAP_EXPOSED'], [{ badAssetHeaders: true }, 'NOSNIFF_MISSING'],
]) test(`fetch checker rejects ${code}`, async () => {
  await assert.rejects(checkSecurityHeaders('https://public.example', upstream(options)), new RegExp(code));
});
test('fetch checker rejects credentials without sending them upstream', async () => {
  let called = false;
  await assert.rejects(checkSecurityHeaders('https://name:PRIVATE@example.test', async () => { called = true; }), /INVALID_ORIGIN/);
  assert.equal(called, false);
});
test('bot health requires a healthy recent heartbeat and fails future timestamps', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  for (const age of [0, 15_000, 45_000]) assert.equal(isBotHealthy({ healthy: true, checkedAt: new Date(now - age).toISOString() }, now), true);
  for (const value of [null, {}, { healthy: false, checkedAt: new Date(now).toISOString() }, { healthy: true, checkedAt: 'invalid' },
    { healthy: true, checkedAt: new Date(now + 1).toISOString() }, { healthy: true, checkedAt: new Date(now - 45_001).toISOString() }]) assert.equal(isBotHealthy(value, now), false);
});
