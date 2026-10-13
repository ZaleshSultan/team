import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { publicPlayerCardSchema } from '@squad/shared';
import { AccountDeletionDialog, ProfileChips, PublishChecklist, PublicProfileCard } from './ProfileScreen.js';
import { confirmAccountDeletion, createProfileDraft, installUnsavedChangesGuard, profileDraftChanged, toggleProfileChoice, validateProfileDraft } from './profile.js';
import { profileInputFixture, profileOptionsFixture, publicProfileFixture } from './profile-fixture.js';
import i18n from './i18n.js';
import ru from './locales/ru.json';
import en from './locales/en.json';

beforeEach(async () => { await i18n.changeLanguage('ru'); });

describe('profile form validation', () => {
  it('creates a clean, independent draft without profile ids or private metadata', () => {
    const draft = createProfileDraft(profileInputFixture);
    draft.roles.push('entry');
    expect(profileInputFixture.roles).toEqual(['awp', 'support']);
    expect(createProfileDraft(null)).toEqual({ nickname: '', roles: [], lookingFor: [], playTimes: [], languages: [], region: '', hasMic: false, bio: '' });
    expect(createProfileDraft({ ...profileInputFixture, nickname: null }).nickname).toBe('');
  });

  it('validates the fields against the provider options, including selection limits', () => {
    for (const [field, values] of Object.entries({ roles: [], lookingFor: ['unknown'], playTimes: [], languages: ['ru', 'kk', 'en', 'de', 'fr'], region: '' })) {
      const result = validateProfileDraft({ ...createProfileDraft(profileInputFixture), [field]: values }, profileOptionsFixture);
      expect(result.input).toBeNull();
      expect(result.errors).toHaveProperty(field);
    }
    expect(validateProfileDraft(createProfileDraft(profileInputFixture), profileOptionsFixture).input).toEqual(profileInputFixture);
  });

  it.each(['https://example.com', 'example.com', '@contact', '+7 777 123 45 67', 'https:\u200b//example.com'])('blocks contacts in either text field: %s', (contact) => {
    for (const field of ['nickname', 'bio'] as const) {
      const result = validateProfileDraft({ ...createProfileDraft(profileInputFixture), [field]: contact }, profileOptionsFixture);
      expect(result.input).toBeNull();
      expect(result.errors[field]).toBe('CONTACTS_NOT_ALLOWED');
    }
  });

  it('normalizes whitespace and invisible characters with the same shared helper as the provider', () => {
    const result = validateProfileDraft({ ...createProfileDraft(profileInputFixture), nickname: '  И\u200bгрок   17 ', bio: '  Играю\n\tвечером\u0000  ' }, profileOptionsFixture);
    expect(result.input).toMatchObject({ nickname: 'Игрок 17', bio: 'Играю вечером' });
    expect(validateProfileDraft({ ...createProfileDraft(profileInputFixture), nickname: ' ' }, profileOptionsFixture).input?.nickname).toBeNull();
  });

  it('shows nickname and bio length errors but accepts their boundary values', () => {
    const draft = createProfileDraft(profileInputFixture);
    expect(validateProfileDraft({ ...draft, nickname: 'A' }, profileOptionsFixture).errors.nickname).toBe('TOO_SHORT');
    expect(validateProfileDraft({ ...draft, nickname: 'A'.repeat(33) }, profileOptionsFixture).errors.nickname).toBe('TOO_LONG');
    expect(validateProfileDraft({ ...draft, bio: 'я'.repeat(501) }, profileOptionsFixture).errors.bio).toBe('TOO_LONG');
    expect(validateProfileDraft({ ...draft, nickname: 'A'.repeat(32), bio: 'я'.repeat(500) }, profileOptionsFixture).input).not.toBeNull();
  });

  it('enforces selection caps while allowing a selected chip to be removed', () => {
    expect(toggleProfileChoice(['entry', 'awp', 'support'], 'igl', 3)).toEqual(['entry', 'awp', 'support']);
    expect(toggleProfileChoice(['entry', 'awp', 'support'], 'entry', 3)).toEqual(['awp', 'support']);
    expect(toggleProfileChoice(['entry'], 'awp', 3)).toEqual(['entry', 'awp']);
    const html = renderToStaticMarkup(<ProfileChips field="roles" options={profileOptionsFixture} values={['entry', 'awp', 'support']} error="TOO_MANY" onChange={() => undefined} />);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('disabled=""');
    expect(html).toContain(ru.profile.validation.TOO_MANY);
  });

  it('lets users remove legacy choices that are absent from the current provider allow-list', () => {
    const html = renderToStaticMarkup(<ProfileChips field="playTimes" options={profileOptionsFixture} values={['afternoon', 'flexible']} onChange={() => undefined} />);
    expect(html).toContain('Убрать недоступный вариант: afternoon');
    expect(html).toContain('Убрать недоступный вариант: flexible');
    expect(toggleProfileChoice(['afternoon', 'flexible'], 'afternoon', 4)).toEqual(['flexible']);
  });
});

describe('profile publication and public preview', () => {
  it('renders each missing requirement, field hints and unsaved changes without claiming readiness', () => {
    const html = renderToStaticMarkup(<PublishChecklist requirements={[
      { code: 'ONBOARDING_INCOMPLETE' }, { code: 'STEAM_REQUIRED' },
      { code: 'PROFILE_INCOMPLETE', fields: ['roles', 'region'] }, { code: 'PROFILE_INVALID' }, { code: 'USER_BANNED' }, { code: 'MODERATION_HIDDEN' },
    ]} dirty />);
    for (const requirement of Object.values(ru.profile.requirements)) expect(html).toContain(requirement.missing);
    expect(html).toContain(ru.profile.roles);
    expect(html).toContain(ru.profile.region);
    expect(html).toContain(ru.profile.previewSaveFirst);
    expect(html).not.toContain('data-complete="true"');
  });

  it('renders a ready checklist when the server returns no blockers', () => {
    const html = renderToStaticMarkup(<PublishChecklist requirements={[]} />);
    for (const requirement of Object.values(ru.profile.requirements)) expect(html).toContain(requirement.complete);
    expect(html).not.toContain('data-complete="false"');
  });

  it('renders the exact privacy-respecting card without private data or invented hours', () => {
    expect(publicPlayerCardSchema.parse(publicProfileFixture)).toEqual(publicProfileFixture);
    const html = renderToStaticMarkup(<PublicProfileCard card={publicProfileFixture} />);
    expect(html).toContain('Игрок_17');
    expect(html).toContain(ru.profile.steamVerified);
    expect(html).toContain(ru.profile.faceitVerified);
    expect(html).toContain(ru.profile.activityHidden);
    expect(html).toContain('1800');
    for (const privateKey of ['telegramId', 'username', 'steamId', 'playtimeTotal', 'userId', 'games']) expect(html).not.toContain(privateKey);
    expect(html).not.toContain(ru.stats.cs2Total);
  });

  it('uses the public hours only when present and treats null time as unknown', async () => {
    await i18n.changeLanguage('en');
    const card = { ...publicProfileFixture, nickname: null, badges: { steamVerified: true, faceitVerified: false }, activity: { cs2Hours: 123.5, cs2Hours2weeks: null } };
    const html = renderToStaticMarkup(<PublicProfileCard card={card} />);
    expect(html).toContain('123.5 h');
    expect(html).toContain(en.stats.unknown);
    expect(html).toContain(en.profile.unnamed);
    expect(html).not.toContain(en.profile.faceitVerified);
    expect(html).not.toContain('0 h');
    expect(html).not.toContain(en.profile.activityHidden);
  });

  it('escapes text instead of injecting markup or contact links', () => {
    const html = renderToStaticMarkup(<PublicProfileCard card={{ ...publicProfileFixture, bio: '<script>danger</script>' }} />);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
  });

  it('provides matching RU/EN keys for every provider choice and validation issue', () => {
    const keys = (value: Record<string, unknown>, prefix = ''): string[] => Object.entries(value).flatMap(([key, item]) => item && typeof item === 'object' ? keys(item as Record<string, unknown>, `${prefix}${key}.`) : `${prefix}${key}`);
    expect(keys(ru).sort()).toEqual(keys(en).sort());
    for (const [field, options] of Object.entries(profileOptionsFixture)) for (const option of options) expect(i18n.exists(`profile.options.${field}.${option}`)).toBe(true);
  });
});

describe('unsaved changes and account deletion', () => {
  it('tracks restored/saved drafts correctly', () => {
    const saved = createProfileDraft(profileInputFixture);
    expect(profileDraftChanged(createProfileDraft(profileInputFixture), saved)).toBe(false);
    expect(profileDraftChanged({ ...saved, bio: 'Новая цель' }, saved)).toBe(true);
    expect(profileDraftChanged({ ...saved, hasMic: false }, saved)).toBe(true);
  });

  it('registers and removes browser and Telegram guards only while dirty', () => {
    const target = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const telegram = { enableClosingConfirmation: vi.fn(), disableClosingConfirmation: vi.fn() };
    installUnsavedChangesGuard(false, target, telegram)();
    expect(target.addEventListener).not.toHaveBeenCalled();
    const cleanup = installUnsavedChangesGuard(true, target, telegram);
    expect(telegram.enableClosingConfirmation).toHaveBeenCalledOnce();
    const handler = target.addEventListener.mock.calls[0]![1] as (event: { preventDefault(): void; returnValue?: string }) => void;
    const event = { preventDefault: vi.fn(), returnValue: undefined as string | undefined };
    handler(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.returnValue).toBe('');
    cleanup();
    expect(target.removeEventListener).toHaveBeenCalledWith('beforeunload', handler);
    expect(telegram.disableClosingConfirmation).toHaveBeenCalledOnce();
  });

  it('keeps browser protection if an older Telegram client rejects closing confirmation', () => {
    const target = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const cleanup = installUnsavedChangesGuard(true, target, { enableClosingConfirmation() { throw new Error('unsupported'); } });
    cleanup();
    expect(target.removeEventListener).toHaveBeenCalledOnce();
  });

  it('requires explicit confirmation before sending any deletion and clears UI only on success', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const onDeleted = vi.fn();
    await expect(confirmAccountDeletion(false, remove, onDeleted)).resolves.toBe(false);
    expect(remove).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    await expect(confirmAccountDeletion(true, remove, onDeleted)).resolves.toBe(true);
    expect(remove).toHaveBeenCalledOnce();
    expect(onDeleted).toHaveBeenCalledOnce();
  });

  it('retains the account UI after a failed server deletion', async () => {
    const failure = new Error('network');
    const onDeleted = vi.fn();
    await expect(confirmAccountDeletion(true, async () => { throw failure; }, onDeleted)).rejects.toBe(failure);
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('shows a clearly labelled confirmation dialog and disables the final action until acknowledged', () => {
    const props = { busy: false, onConfirmChange: () => undefined, onCancel: () => undefined, onDelete: () => undefined };
    const html = renderToStaticMarkup(<AccountDeletionDialog {...props} confirmed={false} />);
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain(ru.profile.deleteConfirmDescription);
    expect(html).toContain(ru.profile.deleteAcknowledgement);
    expect(html).toContain('disabled=""');
    const acknowledged = renderToStaticMarkup(<AccountDeletionDialog {...props} confirmed />);
    expect(acknowledged).not.toContain('disabled=""');
  });
});
