import { Prisma, type PrismaClient } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors.js';
import { hashSecret } from './secrets.js';

export const sessionUserIncludes = { steamAccount: true, privacySettings: true } as const;
export type SessionUser = Prisma.UserGetPayload<{ include: typeof sessionUserIncludes }>;
type Session = Prisma.SessionGetPayload<{ include: { user: { include: typeof sessionUserIncludes } } }>;
export interface SessionDependencies { prisma: PrismaClient; now: () => Date }

// Rate limiting and the handler share one lookup, scoped to the request. No raw
// token is retained in the cache or used as a rate-limit key.
const sessionCache = new WeakMap<FastifyRequest, Promise<Session | null>>();
const bearerToken = (request: FastifyRequest) => request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
const publicAuthPaths = new Set(['/api/auth/telegram', '/api/auth/steam/start', '/api/auth/steam/callback']);

async function resolveSession(request: FastifyRequest, deps: SessionDependencies): Promise<Session | null> {
  const token = bearerToken(request);
  if (!token) return null;
  let pending = sessionCache.get(request);
  if (!pending) {
    pending = deps.prisma.session.findUnique({ where: { tokenHash: hashSecret(token) }, include: { user: { include: sessionUserIncludes } } });
    sessionCache.set(request, pending);
  }
  return pending;
}

export async function sessionRateLimitKey(request: FastifyRequest, deps: SessionDependencies): Promise<string> {
  // Public login endpoints always use IP, regardless of a supplied bearer.
  if (publicAuthPaths.has(request.routeOptions.url ?? '')) return `ip:${request.ip}`;
  const session = await resolveSession(request, deps);
  return session && session.expiresAt > deps.now() ? `user:${session.userId}` : `ip:${request.ip}`;
}

export async function requireSession(request: FastifyRequest, deps: SessionDependencies): Promise<SessionUser> {
  if (!bearerToken(request)) throw new AppError(401, 'SESSION_INVALID', 'A valid session is required');
  const session = await resolveSession(request, deps);
  if (!session || session.expiresAt <= deps.now()) throw new AppError(401, 'SESSION_EXPIRED', 'The session has expired');
  if (session.user.isBanned) throw new AppError(403, 'USER_BANNED', 'This account is banned');
  return session.user;
}
