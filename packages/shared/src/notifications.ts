import { z } from 'zod';

// Durable database events own recipient/contact data. Redis jobs carry no such data.
export const notificationJobSchema = z.object({ eventId: z.string().uuid() }).strict();
export type NotificationJob = z.infer<typeof notificationJobSchema>;
