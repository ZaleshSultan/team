import { normalizeProfileText, reportInputSchema, telegramUsernameSchema, type BlockListResponse, type ReportInput, type ReportResponse } from '@squad/shared';
import { errorCode } from './api.js';

export type ReportTarget = { profileId: string; requestId?: never } | { requestId: string; profileId?: never };
export const REPORT_DETAILS_MAX_LENGTH = 500;
export const REPORT_REASONS = ['SPAM', 'HARASSMENT', 'CHEATING', 'FAKE_PROFILE', 'CONTACT_SPAM', 'UNDERAGE', 'OTHER'] as const;
export type ReportReason = typeof REPORT_REASONS[number];

export function reportDetailsLength(value: string): number { return Array.from(normalizeProfileText(value)).length; }
export function createReportSubmission(target: ReportTarget, reason: ReportReason | '', details: string): ReportInput | null {
  const normalized = normalizeProfileText(details);
  const result = reportInputSchema.safeParse({ ...target, reason, ...(normalized ? { details: normalized } : {}) });
  return result.success ? result.data : null;
}

/** A successful report is retained when the independent, optional block fails. */
export async function submitReportAndBlock(input: ReportInput, profileId: string | null, blockToo: boolean, deps: {
  report(input: ReportInput): Promise<ReportResponse>; block(profileId: string): Promise<unknown>;
}): Promise<{ response: ReportResponse; blocked: boolean; blockError: string | null }> {
  const response = await deps.report(input);
  if (!blockToo || !profileId) return { response, blocked: false, blockError: null };
  try { await deps.block(profileId); return { response, blocked: true, blockError: null }; }
  catch (error) { return { response, blocked: false, blockError: errorCode(error) }; }
}

export function applyBlockPage(current: BlockListResponse, next: BlockListResponse, append: boolean): BlockListResponse {
  const items = new Map((append ? current.items : []).map((item) => [item.profileId, item]));
  for (const item of next.items) items.set(item.profileId, item);
  return { items: [...items.values()], nextCursor: next.nextCursor };
}

export function communityLink(botUsername: string, command: 'rules' | 'privacy' | 'help'): string | null {
  return telegramUsernameSchema.safeParse(botUsername).success ? `https://t.me/${botUsername}?start=${command}` : null;
}
