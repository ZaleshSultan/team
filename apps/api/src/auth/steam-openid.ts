import { AppError } from '../errors.js';

const STEAM_ENDPOINT = 'https://steamcommunity.com/openid/login';
const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const IDENTIFIER_SELECT = `${OPENID_NS}/identifier_select`;
const MAX_PROVIDER_BYTES = 8_192;
const REQUIRED_SIGNED = ['op_endpoint', 'return_to', 'response_nonce', 'assoc_handle', 'claimed_id', 'identity'];
// Public universe, individual account, desktop instance, nonzero account ID.
const MIN_STEAM_ID = 76_561_197_960_265_729n;
const MAX_STEAM_ID = 76_561_202_255_233_023n;

export interface SteamAssertionOptions {
  now: Date;
  maxAgeSeconds: number;
  fetch: typeof globalThis.fetch;
}

export interface SteamAssertion {
  steamId64: string;
  nonce: string;
}

function invalid(): never {
  throw new AppError(400, 'STEAM_INVALID_RESPONSE', 'Steam authentication could not be verified');
}

function unavailable(): never {
  throw new AppError(502, 'STEAM_UNAVAILABLE', 'Steam authentication is temporarily unavailable');
}

function parseConfiguredUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid();
  }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.hash) invalid();
  return url;
}

export function buildSteamLoginUrl(returnTo: string, realm: string): string {
  const callback = parseConfiguredUrl(returnTo);
  const trustRoot = parseConfiguredUrl(realm);
  if (trustRoot.search || callback.origin !== trustRoot.origin
    || !(callback.pathname === trustRoot.pathname
      || callback.pathname.startsWith(trustRoot.pathname.endsWith('/') ? trustRoot.pathname : `${trustRoot.pathname}/`))) invalid();
  const url = new URL(STEAM_ENDPOINT);
  url.search = new URLSearchParams({
    'openid.ns': OPENID_NS,
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': realm,
    'openid.identity': IDENTIFIER_SELECT,
    'openid.claimed_id': IDENTIFIER_SELECT,
  }).toString();
  return url.toString();
}

async function readProviderResponse(response: Response): Promise<string> {
  const advertisedLength = response.headers.get('content-length');
  if (advertisedLength && /^\d+$/.test(advertisedLength) && Number(advertisedLength) > MAX_PROVIDER_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    invalid();
  }
  if (!response.body) invalid();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_PROVIDER_BYTES) {
        await reader.cancel().catch(() => undefined);
        invalid();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    unavailable();
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * This is intentionally Steam-only: Valve documents this provider/claimed-ID
 * binding. Pin both to Valve instead of discovering arbitrary callback URLs.
 * No user-controlled URL is ever fetched; this is not a general OpenID client.
 * https://steamcommunity.com/dev
 * https://openid.net/specs/openid-authentication-2_0.html#verification
 * Persistent nonce replay checks and browser state binding belong to the route.
 */
export async function verifySteamAssertion(
  params: URLSearchParams,
  expectedReturnTo: string,
  options: SteamAssertionOptions,
): Promise<SteamAssertion> {
  if (params.toString().length > 16_384) invalid();
  const seen = new Set<string>();
  for (const [key] of params) {
    if (seen.has(key)) invalid();
    seen.add(key);
  }
  if (params.get('openid.ns') !== OPENID_NS || params.get('openid.mode') !== 'id_res'
    || params.get('openid.op_endpoint') !== STEAM_ENDPOINT
    || params.get('openid.return_to') !== expectedReturnTo) invalid();
  const claimedId = params.get('openid.claimed_id');
  if (!claimedId || claimedId !== params.get('openid.identity')) invalid();
  const match = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(claimedId);
  const steamId64 = match?.[1];
  if (!steamId64 || BigInt(steamId64) < MIN_STEAM_ID || BigInt(steamId64) > MAX_STEAM_ID) invalid();
  const assoc = params.get('openid.assoc_handle');
  const signature = params.get('openid.sig');
  if (!assoc || assoc.length > 512 || !signature || signature.length > 512
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || signature.length % 4 !== 0) invalid();
  const signed = (params.get('openid.signed') ?? '').split(',');
  if (new Set(signed).size !== signed.length
    || signed.some((key) => !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(key) || !params.has(`openid.${key}`))
    || REQUIRED_SIGNED.some((key) => !signed.includes(key))) invalid();

  const nonce = params.get('openid.response_nonce');
  const nonceParts = nonce && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)([!-~]{1,235})$/.exec(nonce);
  const timestamp = nonceParts?.[1];
  if (!nonce || !timestamp) invalid();
  const nonceTime = Date.parse(timestamp);
  const nowTime = options.now.getTime();
  if (!Number.isFinite(nonceTime) || new Date(nonceTime).toISOString().replace('.000Z', 'Z') !== timestamp
    || !Number.isFinite(nowTime) || !Number.isSafeInteger(options.maxAgeSeconds) || options.maxAgeSeconds <= 0
    || nowTime - nonceTime > options.maxAgeSeconds * 1000 || nonceTime - nowTime > 30_000) invalid();

  const verification = new URLSearchParams();
  for (const [key, value] of params) {
    if (key.startsWith('openid.')) verification.set(key, value);
  }
  verification.set('openid.mode', 'check_authentication');
  let response: Response;
  try {
    response = await options.fetch(STEAM_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: verification,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    unavailable();
  }
  if (!response.ok || response.redirected) unavailable();
  const raw = await readProviderResponse(response);
  const result = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    if (line === '') continue;
    const separator = line.indexOf(':');
    if (separator < 1) invalid();
    const key = line.slice(0, separator);
    if (result.has(key)) invalid();
    result.set(key, line.slice(separator + 1));
  }
  if (result.get('ns') !== OPENID_NS || result.get('is_valid') !== 'true') invalid();
  return { steamId64, nonce };
}
