import { normalizeProfileText, profileTextError, profileUpdateInputSchema, type ProfileField, type ProfileOptions, type ProfileUpdateInput } from '@squad/shared';

export type ProfileDraft = Omit<ProfileUpdateInput, 'nickname'> & { nickname: string };
export type ProfileErrors = Partial<Record<ProfileField, string>>;

export function createProfileDraft(profile?: ProfileUpdateInput | null): ProfileDraft {
  return profile ? {
    nickname: profile.nickname ?? '', roles: [...profile.roles], lookingFor: [...profile.lookingFor],
    playTimes: [...profile.playTimes], languages: [...profile.languages], region: profile.region,
    hasMic: profile.hasMic, bio: profile.bio,
  } : { nickname: '', roles: [], lookingFor: [], playTimes: [], languages: [], region: '', hasMic: false, bio: '' };
}

export function toggleProfileChoice(current: string[], value: string, maximum: number): string[] {
  return current.includes(value) ? current.filter((item) => item !== value) : current.length < maximum ? [...current, value] : current;
}

export function profileDraftChanged(draft: ProfileDraft, saved: ProfileDraft): boolean {
  return JSON.stringify(draft) !== JSON.stringify(saved);
}

export function validateProfileDraft(draft: ProfileDraft, options: ProfileOptions): { input: ProfileUpdateInput | null; errors: ProfileErrors } {
  const errors: ProfileErrors = {};
  const nickname = normalizeProfileText(draft.nickname);
  const candidate = { ...draft, nickname: nickname || null, bio: normalizeProfileText(draft.bio) };
  const result = profileUpdateInputSchema.safeParse(candidate);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = issue.path[0] as ProfileField;
      errors[field] ??= 'INVALID_FORMAT';
    }
  }
  const counts = { roles: 3, lookingFor: 3, playTimes: 4, languages: 4 } as const;
  for (const [field, max] of Object.entries(counts) as [keyof typeof counts, number][]) {
    if (!draft[field].length) errors[field] = 'REQUIRED';
    else if (draft[field].length > max) errors[field] = 'TOO_MANY';
    else if (draft[field].some((value) => !options[field].includes(value))) errors[field] = 'INVALID_OPTION';
  }
  if (!options.regions.includes(draft.region)) errors.region = draft.region ? 'INVALID_OPTION' : 'REQUIRED';
  for (const field of ['nickname', 'bio'] as const) {
    const code = profileTextError(field, candidate[field]);
    if (code) errors[field] = code;
  }
  return { input: result.success && Object.keys(errors).length === 0 ? result.data : null, errors };
}

/** The Mini App can close via Telegram controls as well as browser navigation. */
export function installUnsavedChangesGuard(dirty: boolean, target: Pick<Window, 'addEventListener' | 'removeEventListener'>, telegram?: { enableClosingConfirmation?(): void; disableClosingConfirmation?(): void }): () => void {
  if (!dirty) return () => undefined;
  const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
  target.addEventListener('beforeunload', beforeUnload as EventListener);
  try { telegram?.enableClosingConfirmation?.(); } catch { /* Older Telegram clients may lack this feature. */ }
  return () => {
    target.removeEventListener('beforeunload', beforeUnload as EventListener);
    try { telegram?.disableClosingConfirmation?.(); } catch { /* Browser navigation guard still worked. */ }
  };
}

/** Only a successful server deletion may discard the in-memory session/UI. */
export async function confirmAccountDeletion(confirmed: boolean, remove: () => Promise<void>, onDeleted: () => void): Promise<boolean> {
  if (!confirmed) return false;
  await remove();
  onDeleted();
  return true;
}
