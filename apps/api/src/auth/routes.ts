import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  authResponseSchema, authUserSchema, deleteAccountInputSchema, emptyInputSchema, meResponseSchema,
  onboardingInputSchema, steamLinkResponseSchema, steamLinkStatusResponseSchema, telegramAuthInputSchema,
  type AuthUser,
} from '@squad/shared';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import { createSecret, hashSecret } from './secrets.js';
import { verifyTelegramInitData } from './telegram.js';
import { buildSteamLoginUrl, verifySteamAssertion } from './steam-openid.js';
import { renderSteamPage } from './browser-page.js';
import { requireSession as authenticateSession } from './session.js';

const includes = { steamAccount: true, privacySettings: true } as const;
type User = Prisma.UserGetPayload<{ include: typeof includes }>;
const secretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const linkIdSchema = z.object({ id: z.string().uuid() }).strict();
// Allow cold pool connections and short row-lock waits; bound every transaction.
const transactionOptions = { maxWait: 10_000, timeout: 10_000 };
const telegramChatSchema = z.object({ ok: z.literal(true), result: z.object({ id: z.number().int().positive().safe(), type: z.literal('private'), username: z.string().regex(/^[A-Za-z0-9_]{1,32}$/).optional() }) });
export interface AuthDependencies {
  config: Config;
  prisma: PrismaClient;
  fetch: typeof globalThis.fetch;
  now: () => Date;
}

export function toAuthUser(user: User, config: Config): AuthUser {
  const ageConfirmed = Boolean(user.ageConfirmedAt && user.ageMinimumConfirmed === config.AGE_MINIMUM);
  const rulesAccepted = Boolean(user.rulesAcceptedAt && user.rulesVersion === config.RULES_VERSION);
  return authUserSchema.parse({
    id: user.id, telegramId: user.telegramId.toString(), username: user.username,
    language: user.language === 'en' ? 'en' : 'ru',
    onboarding: { required: !user.username || !ageConfirmed || !rulesAccepted, ageConfirmed, rulesAccepted, minimumAge: config.AGE_MINIMUM, rulesVersion: config.RULES_VERSION, usernameRequired: true },
    steam: user.steamAccount ? { steamId64: user.steamAccount.steamId64.toString(), linkedAt: user.steamAccount.linkedAt.toISOString() } : null,
    privacy: { shareSteamActivity: user.privacySettings?.shareSteamActivity ?? false },
  });
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthDependencies) {
  const { config, prisma, fetch: fetcher, now } = deps;
  const requireSession = (request: FastifyRequest) => authenticateSession(request, { prisma, now });
  const requireOnboarding = (user: User) => {
    if (toAuthUser(user, config).onboarding.required) throw new AppError(409, 'ONBOARDING_REQUIRED', 'Complete onboarding first');
  };

  app.post('/api/auth/telegram', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = telegramAuthInputSchema.parse(request.body);
    const telegram = verifyTelegramInitData(body.initData, config.BOT_TOKEN, { now: now(), maxAgeSeconds: config.TELEGRAM_AUTH_MAX_AGE_SECONDS });
    const token = createSecret();
    const expiresAt = new Date(now().getTime() + config.SESSION_TTL_SECONDS * 1000);
    const user = await prisma.$transaction(async (tx) => {
      // Keep this upsert scalar-only so Prisma uses PostgreSQL ON CONFLICT.
      const identity = await tx.user.upsert({
        where: { telegramId: BigInt(telegram.id) },
        create: { telegramId: BigInt(telegram.id), username: telegram.username ?? null },
        update: { username: telegram.username ?? null },
      });
      await tx.privacySettings.upsert({ where: { userId: identity.id }, create: { userId: identity.id }, update: {} });
      const user = await tx.user.findUniqueOrThrow({ where: { id: identity.id }, include: includes });
      if (user.isBanned) throw new AppError(403, 'USER_BANNED', 'This account is banned');
      await tx.session.deleteMany({ where: { userId: user.id, expiresAt: { lte: now() } } });
      await tx.session.create({ data: { userId: user.id, tokenHash: hashSecret(token), expiresAt } });
      return user;
    }, transactionOptions);
    reply.header('Cache-Control', 'no-store');
    return authResponseSchema.parse({ token, expiresAt: expiresAt.toISOString(), user: toAuthUser(user, config) });
  });
  app.get('/api/me', async (request, reply) => {
    const user = await requireSession(request);
    reply.header('Cache-Control', 'no-store');
    return meResponseSchema.parse({ user: toAuthUser(user, config) });
  });
  app.delete('/api/me', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await requireSession(request);
    deleteAccountInputSchema.parse(request.body);
    await prisma.$transaction(async (tx) => {
      // Serialize deletion with requests, bans, linking and stats persistence.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id}::uuid FOR UPDATE`;
      // Reports BY this user cascade. Reports ABOUT them retain only the reason
      // and moderation state, without private details or identifying notes.
      await tx.report.updateMany({ where: { reportedUserId: user.id, reporterUserId: { not: user.id } },
        data: { details: null, resolutionNote: 'ACCOUNT_DELETED', status: 'REVIEWED', resolvedAt: now(), resolvedBy: null } });
      await tx.user.deleteMany({ where: { id: user.id } });
    }, transactionOptions);
    return reply.code(204).send();
  });
  app.post('/api/auth/logout', async (request, reply) => {
    await requireSession(request);
    emptyInputSchema.parse(request.body ?? {});
    await prisma.session.deleteMany({ where: { tokenHash: hashSecret(request.headers.authorization!.slice(7)) } });
    return reply.code(204).send();
  });
  app.post('/api/onboarding', async (request, reply) => {
    const current = await requireSession(request);
    const body = onboardingInputSchema.parse(request.body);
    if (body.minimumAge !== config.AGE_MINIMUM || body.rulesVersion !== config.RULES_VERSION) throw new AppError(400, 'CONSENT_OUTDATED', 'Review the current age requirement and rules');
    if (!current.username) throw new AppError(409, 'USERNAME_REQUIRED', 'Set a Telegram username first');
    const user = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${current.id}::uuid FOR UPDATE`;
      const active = await tx.user.findUnique({ where: { id: current.id } });
      if (!active) throw new AppError(401, 'SESSION_EXPIRED', 'The session has expired');
      if (active.isBanned) throw new AppError(403, 'USER_BANNED', 'This account is banned');
      if (!active.username) throw new AppError(409, 'USERNAME_REQUIRED', 'Set a Telegram username first');
      return tx.user.update({ where: { id: current.id }, data: {
      ageConfirmedAt: now(), ageMinimumConfirmed: config.AGE_MINIMUM,
      rulesAcceptedAt: now(), rulesVersion: config.RULES_VERSION, language: body.language,
      privacySettings: { upsert: { create: { shareSteamActivity: body.shareSteamActivity }, update: { shareSteamActivity: body.shareSteamActivity } } },
      }, include: includes });
    }, transactionOptions);
    reply.header('Cache-Control', 'no-store');
    return meResponseSchema.parse({ user: toAuthUser(user, config) });
  });
  app.post('/api/me/telegram/refresh', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const current = await requireSession(request);
    emptyInputSchema.parse(request.body ?? {});
    let username: string | null;
    try {
      const response = await fetcher(`https://api.telegram.org/bot${config.BOT_TOKEN}/getChat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: current.telegramId.toString() }), redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error('upstream');
      const chat = telegramChatSchema.parse(await response.json());
      if (BigInt(chat.result.id) !== current.telegramId) throw new Error('mismatched chat');
      username = chat.result.username ?? null;
    } catch {
      throw new AppError(502, 'TELEGRAM_UNAVAILABLE', 'Start the bot and try checking your username again');
    }
    const user = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${current.id}::uuid FOR UPDATE`;
      const active = await tx.user.findUnique({ where: { id: current.id } });
      if (!active) throw new AppError(401, 'SESSION_EXPIRED', 'The session has expired');
      if (active.isBanned) throw new AppError(403, 'USER_BANNED', 'This account is banned');
      return tx.user.update({ where: { id: current.id }, data: { username }, include: includes });
    }, transactionOptions);
    reply.header('Cache-Control', 'no-store');
    return meResponseSchema.parse({ user: toAuthUser(user, config) });
  });

  app.post('/api/auth/steam/link', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await requireSession(request);
    emptyInputSchema.parse(request.body ?? {});
    requireOnboarding(user);
    if (user.steamAccount) throw new AppError(409, 'STEAM_ALREADY_LINKED', 'Steam is already linked');
    const code = createSecret();
    const expiresAt = new Date(now().getTime() + config.STEAM_LINK_TTL_SECONDS * 1000);
    const link = await prisma.$transaction(async (tx) => {
      // Serialize attempts and completions for this user; locks also serialize bans.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id}::uuid FOR UPDATE`;
      const current = await tx.user.findUniqueOrThrow({ where: { id: user.id }, include: includes });
      if (current.isBanned) throw new AppError(403, 'USER_BANNED', 'This account is banned');
      requireOnboarding(current);
      if (current.steamAccount) throw new AppError(409, 'STEAM_ALREADY_LINKED', 'Steam is already linked');
      await tx.steamLink.updateMany({ where: { userId: user.id, status: { in: ['PENDING', 'STARTED', 'VERIFYING'] } }, data: { status: 'FAILED', failureCode: 'STEAM_LINK_SUPERSEDED' } });
      return tx.steamLink.create({ data: { userId: user.id, startCodeHash: hashSecret(code), expiresAt } });
    }, transactionOptions);
    const url = new URL('/api/auth/steam/start', config.PUBLIC_API_URL);
    url.searchParams.set('code', code);
    reply.header('Cache-Control', 'no-store');
    return steamLinkResponseSchema.parse({ id: link.id, url: url.toString(), expiresAt: expiresAt.toISOString() });
  });
  app.get('/api/auth/steam/links/:id', async (request, reply) => {
    const user = await requireSession(request);
    const { id } = linkIdSchema.parse(request.params);
    const link = await prisma.steamLink.findFirst({ where: { id, userId: user.id } });
    if (!link) throw new AppError(404, 'STEAM_LINK_NOT_FOUND', 'Link attempt not found');
    const expired = !['COMPLETED', 'FAILED'].includes(link.status) && link.expiresAt <= now();
    reply.header('Cache-Control', 'no-store');
    return steamLinkStatusResponseSchema.parse({ id: link.id, status: expired ? 'EXPIRED' : link.status, expiresAt: link.expiresAt.toISOString(), failureCode: expired ? 'STEAM_LINK_EXPIRED' : link.failureCode });
  });

  app.get('/api/auth/steam/start', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const parsed = z.object({ code: secretSchema }).strict().safeParse(request.query);
    if (!parsed.success) return reply.code(400).type('text/html').send(renderSteamPage('invalid', 'ru', config.BOT_USERNAME));
    const link = await prisma.steamLink.findUnique({ where: { startCodeHash: hashSecret(parsed.data.code) }, include: { user: { include: includes } } });
    if (!link || link.status !== 'PENDING' || link.expiresAt <= now()) return reply.code(410).type('text/html').send(renderSteamPage('expired', link?.user.language ?? 'ru', config.BOT_USERNAME));
    if (link.user.isBanned || toAuthUser(link.user, config).onboarding.required || link.user.steamAccount) return reply.code(409).type('text/html').send(renderSteamPage('invalid', link.user.language, config.BOT_USERNAME));
    const state = createSecret();
    const browserBinding = createSecret();
    const returnTo = new URL('/api/auth/steam/callback', config.PUBLIC_API_URL);
    returnTo.searchParams.set('id', link.id);
    const realm = new URL(config.PUBLIC_API_URL).origin;
    const claimed = await prisma.steamLink.updateMany({ where: { id: link.id, status: 'PENDING', expiresAt: { gt: now() } }, data: { status: 'STARTED', startedAt: now(), callbackStateHash: hashSecret(state), browserBindingHash: hashSecret(browserBinding), returnTo: returnTo.toString(), realm } });
    if (claimed.count !== 1) return reply.code(410).type('text/html').send(renderSteamPage('expired', link.user.language, config.BOT_USERNAME));
    returnTo.searchParams.set('state', state);
    reply.setCookie(`steam_bind_${link.id}`, browserBinding, { httpOnly: true, secure: new URL(config.PUBLIC_API_URL).protocol === 'https:', sameSite: 'lax', path: '/api/auth/steam', maxAge: Math.max(1, Math.floor((link.expiresAt.getTime() - now().getTime()) / 1000)) });
    return reply.redirect(buildSteamLoginUrl(returnTo.toString(), realm));
  });

  app.get('/api/auth/steam/callback', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const params = new URL(request.raw.url!, config.PUBLIC_API_URL).searchParams;
    const parsed = z.object({ id: z.string().uuid(), state: secretSchema }).safeParse({ id: params.get('id'), state: params.get('state') });
    const unique = new Set<string>();
    for (const [key] of params) {
      if (unique.has(key)) return reply.code(400).type('text/html').send(renderSteamPage('invalid', 'ru', config.BOT_USERNAME));
      unique.add(key);
    }
    if (!parsed.success) return reply.code(400).type('text/html').send(renderSteamPage('invalid', 'ru', config.BOT_USERNAME));
    const link = await prisma.steamLink.findUnique({ where: { id: parsed.data.id }, include: { user: { include: includes } } });
    const binding = request.cookies[`steam_bind_${parsed.data.id}`];
    if (!link || !link.callbackStateHash || hashSecret(parsed.data.state) !== link.callbackStateHash || !binding || !secretSchema.safeParse(binding).success || hashSecret(binding) !== link.browserBindingHash) {
      return reply.code(400).type('text/html').send(renderSteamPage('invalid', 'ru', config.BOT_USERNAME));
    }
    const cookieOptions = { path: '/api/auth/steam', httpOnly: true, secure: new URL(config.PUBLIC_API_URL).protocol === 'https:', sameSite: 'lax' as const };
    if (link.status !== 'STARTED' || link.expiresAt <= now()) {
      reply.clearCookie(`steam_bind_${link.id}`, cookieOptions);
      return reply.code(410).type('text/html').send(renderSteamPage('expired', link.user.language, config.BOT_USERNAME));
    }
    const claimed = await prisma.steamLink.updateMany({ where: { id: link.id, status: 'STARTED', expiresAt: { gt: now() } }, data: { status: 'VERIFYING' } });
    if (claimed.count !== 1) return reply.code(410).type('text/html').send(renderSteamPage('expired', link.user.language, config.BOT_USERNAME));
    try {
      if (params.get('openid.mode') === 'cancel') throw new AppError(400, 'STEAM_CANCELLED', 'Steam sign-in cancelled');
      if (!link.returnTo) throw new AppError(400, 'STEAM_INVALID_RESPONSE', 'Invalid linking state');
      const expected = new URL(link.returnTo);
      expected.searchParams.set('state', parsed.data.state);
      const assertion = await verifySteamAssertion(params, expected.toString(), { now: now(), maxAgeSeconds: config.STEAM_LINK_TTL_SECONDS, fetch: fetcher });
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${link.userId}::uuid FOR UPDATE`;
        const active = await tx.steamLink.findUniqueOrThrow({ where: { id: link.id }, include: { user: { include: includes } } });
        if (active.status !== 'VERIFYING' || active.expiresAt <= now()) throw new AppError(410, 'STEAM_LINK_EXPIRED', 'Steam link is no longer active');
        if (active.user.isBanned || toAuthUser(active.user, config).onboarding.required) throw new AppError(403, 'ONBOARDING_REQUIRED', 'This profile is not eligible');
        if (active.user.steamAccount) throw new AppError(409, 'STEAM_ALREADY_LINKED', 'Steam is already linked');
        const completed = await tx.steamLink.updateMany({ where: { id: link.id, status: 'VERIFYING', expiresAt: { gt: now() } }, data: { status: 'COMPLETED', completedAt: now() } });
        if (completed.count !== 1) throw new AppError(410, 'STEAM_LINK_EXPIRED', 'Steam link is no longer active');
        await tx.steamOpenIdNonce.create({ data: { nonce: assertion.nonce, steamLinkId: link.id, expiresAt: new Date(now().getTime() + config.STEAM_LINK_TTL_SECONDS * 1000) } });
        await tx.steamAccount.create({ data: { userId: link.userId, steamId64: BigInt(assertion.steamId64), linkedAt: now() } });
      }, transactionOptions);
      reply.clearCookie(`steam_bind_${link.id}`, cookieOptions);
      return reply.type('text/html').send(renderSteamPage('success', link.user.language, config.BOT_USERNAME));
    } catch (error) {
      const conflict = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
      const nonceReplay = conflict && String(error.meta?.target).includes('nonce');
      const code = nonceReplay ? 'STEAM_NONCE_REPLAY' : conflict ? 'STEAM_ACCOUNT_CONFLICT' : error instanceof AppError ? error.code : 'INTERNAL_ERROR';
      const status = nonceReplay ? 400 : conflict ? 409 : error instanceof AppError ? error.statusCode : 500;
      if (status === 500) request.log.error({ code }, 'Steam account transaction failed');
      await prisma.steamLink.updateMany({ where: { id: link.id, status: 'VERIFYING' }, data: { status: 'FAILED', failureCode: code } });
      reply.clearCookie(`steam_bind_${link.id}`, cookieOptions);
      const kind = status === 409 ? 'conflict' : status === 410 ? 'expired' : code === 'STEAM_CANCELLED' ? 'cancelled' : status === 502 ? 'unavailable' : 'invalid';
      return reply.code(status).type('text/html').send(renderSteamPage(kind, link.user.language, config.BOT_USERNAME));
    }
  });
}
