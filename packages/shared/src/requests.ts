import { z } from 'zod';
import { normalizeProfileText, profileTextError, publicPlayerCardSchema } from './profile.js';
import { telegramUsernameSchema } from './telegram-contact.js';

export const requestStatusSchema = z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELED', 'EXPIRED']);
export type RequestStatus = z.infer<typeof requestStatusSchema>;

/** The same contact filter as profile bios, with a smaller Unicode character budget. */
export const requestMessageSchema = z.string().max(4096).transform(normalizeProfileText).superRefine((message, ctx) => {
  if (Array.from(message).length > 200) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'TOO_LONG' });
  if (profileTextError('bio', message) === 'CONTACTS_NOT_ALLOWED') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'CONTACTS_NOT_ALLOWED' });
  }
});
export const sendRequestInputSchema = z.object({
  toProfileId: z.string().uuid(), message: requestMessageSchema.optional(),
}).strict();
export type SendRequestInput = z.infer<typeof sendRequestInputSchema>;
export const requestIdParamsSchema = z.object({ id: z.string().uuid() }).strict();
export const blockProfileParamsSchema = z.object({ profileId: z.string().uuid() }).strict();

const pageLimit = z.union([
  z.number().int().min(1).max(50),
  z.string().regex(/^[1-9]\d?$/).transform(Number).pipe(z.number().int().min(1).max(50)),
]);
export const requestListQuerySchema = z.object({
  limit: pageLimit.default(20), cursor: z.string().min(1).max(1024).optional(),
}).strict();
export type RequestListQuery = z.infer<typeof requestListQuerySchema>;

/** Closed public projection: contacts and account identifiers are never list fields. */
export const requestItemSchema = z.object({
  id: z.string().uuid(), status: requestStatusSchema, message: requestMessageSchema.nullable(),
  createdAt: z.string().datetime(), resolvedAt: z.string().datetime().nullable(), expiresAt: z.string().datetime(),
  player: publicPlayerCardSchema.nullable(),
}).strict();
export type RequestItem = z.infer<typeof requestItemSchema>;
export const requestListResponseSchema = z.object({
  items: z.array(requestItemSchema).max(50), nextCursor: z.string().nullable(),
}).strict();
export type RequestListResponse = z.infer<typeof requestListResponseSchema>;

export const requestContactSchema = z.object({
  username: telegramUsernameSchema,
}).strict();
export type RequestContact = z.infer<typeof requestContactSchema>;
export const requestResponseSchema = z.object({
  request: requestItemSchema, contact: requestContactSchema.optional(),
}).strict().superRefine((response, ctx) => {
  if (response.contact && response.request.status !== 'ACCEPTED') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contact'], message: 'CONTACT_NOT_ACCEPTED' });
  }
});
export type RequestResponse = z.infer<typeof requestResponseSchema>;
export const requestSummaryResponseSchema = z.object({ pendingIncoming: z.number().int().nonnegative() }).strict();
export type RequestSummaryResponse = z.infer<typeof requestSummaryResponseSchema>;
export const blockResponseSchema = z.object({ blocked: z.boolean() }).strict();
export type BlockResponse = z.infer<typeof blockResponseSchema>;
