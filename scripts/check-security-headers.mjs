import { pathToFileURL } from 'node:url';

function assert(condition, code) { if (!condition) throw new Error(code); }
export function validateHeaders(headers) {
  assert(headers.get('x-content-type-options') === 'nosniff', 'NOSNIFF_MISSING');
  assert(headers.get('referrer-policy') === 'no-referrer', 'REFERRER_POLICY_MISSING');
  const directives = new Map((headers.get('content-security-policy') ?? '').split(';').map((part) => {
    const [key, ...values] = part.trim().split(/\s+/); return [key, values];
  }));
  const scripts = directives.get('script-src') ?? [];
  assert(scripts.includes("'self'") && scripts.includes('https://telegram.org')
    && !scripts.some((value) => ["'unsafe-inline'", "'unsafe-eval'", '*'].includes(value)), 'UNSAFE_SCRIPT_POLICY');
  const frames = directives.get('frame-ancestors') ?? [];
  assert(frames.includes('https://telegram.org') && frames.includes('https://*.telegram.org') && !frames.includes('*'), 'TELEGRAM_FRAME_POLICY_MISSING');
}
export async function checkSecurityHeaders(base, fetcher = fetch) {
  const origin = new URL(base);
  assert(['http:', 'https:'].includes(origin.protocol) && !origin.username && !origin.password && !origin.search && !origin.hash, 'INVALID_ORIGIN');
  origin.pathname = '/';
  const get = (url) => fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  const page = await get(origin); assert(page.ok, 'FRONTEND_UNAVAILABLE'); validateHeaders(page.headers);
  const html = await page.text();
  const tags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  assert(tags.length > 0, 'BUNDLE_MISSING');
  const assets = [];
  for (const [, attributes, body] of tags) {
    assert(!body.trim(), 'INLINE_SCRIPT_FOUND');
    const src = /\bsrc=["']([^"']+)["']/i.exec(attributes)?.[1]; assert(src, 'INLINE_SCRIPT_FOUND');
    const url = new URL(src, origin);
    if (url.origin === 'https://telegram.org' && url.pathname === '/js/telegram-web-app.js') continue;
    assert(url.origin === origin.origin && url.pathname.startsWith('/assets/') && !url.search && !url.hash, 'UNEXPECTED_SCRIPT_SOURCE');
    assets.push(url);
  }
  assert(assets.length > 0, 'BUNDLE_MISSING');
  for (const url of assets) {
    const bundle = await get(url); assert(bundle.ok, 'BUNDLE_UNAVAILABLE'); validateHeaders(bundle.headers);
    assert(!(await bundle.text()).includes('sourceMappingURL='), 'SOURCE_MAP_REFERENCE_FOUND');
    const map = await get(new URL(`${url.pathname}.map`, origin)); assert(map.status === 404, 'SOURCE_MAP_EXPOSED'); validateHeaders(map.headers);
  }
  return assets.length;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const count = await checkSecurityHeaders(process.argv[2] ?? 'http://127.0.0.1:8088'); console.log(`Security headers and ${count} bundle(s): OK`); }
  catch (error) {
    // Only our own fixed identifiers may reach output, never fetch errors/URLs.
    console.error(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'HEADER_CHECK_FAILED'); process.exitCode = 1;
  }
}
