import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { normalizeProfileText, profileTextError, publicPlayerCardSchema, type PlayerProfileInput, type ProfileField, type ProfileValidationCode } from '@squad/shared';
import { CS2_PROFILE_OPTIONS, Cs2GameProvider, ProfileValidationError, safeDisplayNickname } from '../src/games/cs2.js';

const provider = new Cs2GameProvider();
const ID = '76561198000000000';
const OTHER = '76561198000000001';
const valid = (changes: Partial<PlayerProfileInput> = {}): PlayerProfileInput => ({
  gameSlug: 'cs2', nickname: 'Игрок_47', roles: ['awp'], lookingFor: ['duo'],
  playTimes: ['evening'], languages: ['ru'], region: 'KZ', hasMic: true, bio: '', ...changes,
});
function expectIssue(input: unknown, field: ProfileField, code: ProfileValidationCode) {
  try { provider.validateProfile(input); throw new Error('Expected validation error'); }
  catch (error) {
    expect(error).toBeInstanceOf(ProfileValidationError);
    expect((error as ProfileValidationError).issues).toContainEqual({ field, code });
  }
}

describe('M4 CS2 provider allow-lists', () => {
  it('pins the CS2 catalog identity and advertises provider-owned options', () => {
    expect(provider.slug).toBe('cs2'); expect(provider.steamAppId).toBe(730);
    expect(provider.profileOptions).toEqual(CS2_PROFILE_OPTIONS);
    expect(provider.profileOptions.playTimes).toEqual(['morning', 'day', 'evening', 'night']);
    expect(provider.profileOptions.regions).toEqual(['KZ', 'RU', 'CIS', 'EU', 'OTHER']);
    expect(provider.profileOptions.languages).toEqual(expect.arrayContaining(['ru', 'kk', 'en']));
  });
  it.each(['roles', 'lookingFor', 'playTimes', 'languages'] as const)('accepts every %s allow-list member and rejects unknown values', (field) => {
    for (const value of provider.profileOptions[field]) {
      expect(provider.validateProfile(valid({ [field]: [value] }))[field]).toEqual([value]);
    }
    expectIssue(valid({ [field]: ['invalid-option'] }), field, 'INVALID_OPTION');
    expectIssue(valid({ [field]: [] }), field, 'REQUIRED');
  });
  it.each(CS2_PROFILE_OPTIONS.regions)('accepts region %s', (region) => {
    expect(provider.validateProfile(valid({ region })).region).toBe(region);
  });
  it('rejects invented regions and other games', () => {
    expectIssue(valid({ region: 'MARS' }), 'region', 'INVALID_OPTION');
    expectIssue(valid({ gameSlug: 'dota2' }), 'gameSlug', 'INVALID_OPTION');
  });
  it('uses 1–3 roles, 1–3 goals, 1–4 languages, and up to four play times', () => {
    expect(provider.validateProfile(valid({ roles: ['entry', 'awp', 'support'], lookingFor: ['duo', 'five_stack', 'team'], languages: ['ru', 'kk', 'en', 'de'], playTimes: [...CS2_PROFILE_OPTIONS.playTimes] }))).toBeDefined();
    expectIssue(valid({ roles: ['entry', 'awp', 'support', 'lurk'] }), 'roles', 'TOO_MANY');
    expectIssue(valid({ lookingFor: ['duo', 'five_stack', 'team', 'other'] }), 'lookingFor', 'TOO_MANY');
    expectIssue(valid({ languages: ['ru', 'kk', 'en', 'de', 'fr'] }), 'languages', 'TOO_MANY');
    expectIssue(valid({ playTimes: ['morning', 'day', 'evening', 'night', 'other'] }), 'playTimes', 'TOO_MANY');
  });
  it('deduplicates after case, whitespace, and zero-width normalization', () => {
    const result = provider.validateProfile(valid({
      gameSlug: ' CS2 ', roles: [' AWP ', 'awp', 'S\u200bUPPORT'],
      lookingFor: [' DUO ', 'duo'], playTimes: [' DAY ', 'day'], languages: ['RU', ' ru ', 'K\u200bk', 'EN'], region: ' kz ',
    }));
    expect(result).toMatchObject({ gameSlug: 'cs2', roles: ['awp', 'support'], lookingFor: ['duo'], playTimes: ['day'], languages: ['ru', 'kk', 'en'], region: 'KZ' });
  });
  it('counts unique choices and preserves their first chosen order', () => {
    expect(provider.validateProfile(valid({ roles: ['entry', 'entry', 'AWP', 'support', 'SUPPORT'] })).roles).toEqual(['entry', 'awp', 'support']);
  });
  it('requires a boolean microphone value, not a coerced string or integer', () => {
    expect(provider.validateProfile(valid({ hasMic: false })).hasMic).toBe(false);
    expectIssue({ ...valid(), hasMic: 'true' }, 'hasMic', 'INVALID_TYPE');
    expectIssue({ ...valid(), hasMic: 1 }, 'hasMic', 'INVALID_TYPE');
  });
  it('requires every transport field and rejects extra fields without echoing their names', () => {
    const { nickname: _nickname, ...missing } = valid();
    expectIssue(missing, 'nickname', 'REQUIRED');
    expectIssue({ ...valid(), rawContactSecret: 'do-not-echo' }, 'profile', 'UNKNOWN_FIELD');
    expectIssue(null, 'profile', 'INVALID_TYPE');
    expectIssue({ ...valid(), roles: [3] }, 'roles', 'INVALID_TYPE');
  });
});

describe('M4 profile free text', () => {
  it('normalizes whitespace, controls, format characters and Unicode composition', () => {
    const result = provider.validateProfile(valid({ nickname: '  И\u200bгрок\u0000_47  ', bio: '  Cafe\u0301\t squad\n\r\u200f ready \u034f \uFE0F' }));
    expect(result.nickname).toBe('Игрок_47'); expect(result.bio).toBe('Café squad ready');
    expect(normalizeProfileText('a\u202eb\u2066c\u200dd')).toBe('abcd');
  });
  it('recomposes letters after stripping controls between a base and combining mark', () => {
    const nickname = 'Cafe\u200b\u0301';
    expect(provider.validateProfile(valid({ nickname })).nickname).toBe('Café');
    expect(normalizeProfileText(normalizeProfileText(nickname))).toBe('Café');
    expect(safeDisplayNickname(nickname)).toBe('Café');
  });
  it('accepts nullable or blank nickname, empty bio, supported letters and punctuation', () => {
    expect(provider.validateProfile(valid({ nickname: null })).nickname).toBeNull();
    expect(provider.validateProfile(valid({ nickname: '  \u200b ' })).nickname).toBeNull();
    expect(provider.validateProfile(valid({ nickname: 'Ёж Әлі_47-Ж', bio: '' })).nickname).toBe('Ёж Әлі_47-Ж');
    expect(provider.validateProfile(valid({ nickname: 'Agent.47' })).nickname).toBe('Agent.47');
  });
  it('applies nickname bounds to normalized Unicode characters', () => {
    expectIssue(valid({ nickname: 'Я' }), 'nickname', 'TOO_SHORT');
    expectIssue(valid({ nickname: 'Я'.repeat(33) }), 'nickname', 'TOO_LONG');
    expect(provider.validateProfile(valid({ nickname: ` ${'𐐀'.repeat(32)} ` })).nickname).toBe('𐐀'.repeat(32));
  });
  it('applies the biography length limit after normalization', () => {
    expect(provider.validateProfile(valid({ bio: '🔥'.repeat(500) })).bio).toBe('🔥'.repeat(500));
    expectIssue(valid({ bio: 'a'.repeat(501) }), 'bio', 'TOO_LONG');
    expect(provider.validateProfile(valid({ bio: `${'a'.repeat(500)}\u200b` })).bio).toHaveLength(500);
  });
  it.each(['Player!', 'Игрок/два', '🙂🙂', 'Name+'])('rejects nickname characters outside letters/digits/spaces/_-. (%s)', (nickname) => {
    expectIssue(valid({ nickname }), 'nickname', 'INVALID_FORMAT');
  });
  const contacts = ['@username', 'mail@example.com', 'https://example.com/x', 'HTTP://example.com', 'www.example.com', 't.me/person', 'discord.gg/squad', 'steamcommunity.com/id/name', 'tg://resolve?domain=name', '+7 (707) 123-45-67', '1234567', '１２３４５６７', '１２３ ４５６ ７８９', '١٢٣٤٥٦٧', 't.\u200bme/name', '@\u200bperson', '+7\u200b707\u200b123\u200b4567',
    'example。com', 'example．com', 'example｡com', 'ｔ。ｍｅ/name', '＠username', '1.1.1.1', '0.0.0.0', '255.255.255.255', '01.2.3.4', '(1.1.1.1):80/x'];
  it.each(contacts)('rejects contacts in both fields (%s)', (contact) => {
    expectIssue(valid({ nickname: contact }), 'nickname', 'CONTACTS_NOT_ALLOWED');
    expectIssue(valid({ bio: `Contact: ${contact}` }), 'bio', 'CONTACTS_NOT_ALLOWED');
  });
  it('does not mistake ordinary game descriptions and time ranges for contacts', () => {
    const bio = 'CS2: 2500 ELO, 1000 hours. Играю 18:00–22:00, ищу duo.';
    expect(provider.validateProfile(valid({ bio })).bio).toBe(bio);
    expect(profileTextError('bio', bio)).toBeNull();
  });
  it.each(['A.B', 'Agent.47', '1.2.3', '1234.5', '256.1.1.1', 'Version1.2.3'])('does not mistake dotted nicknames or incomplete/invalid IPv4 numbers for contacts (%s)', (nickname) => {
    expect(provider.validateProfile(valid({ nickname })).nickname).toBe(nickname);
    expect(profileTextError('bio', `Version ${nickname}`)).toBeNull();
  });
  it('reports only fixed field/code errors and retains no raw input or Zod error', () => {
    const raw = 'https://secret-user-value.example/contact';
    try { provider.validateProfile({ ...valid({ bio: raw }), nickname: raw }); }
    catch (error) {
      expect(error).toBeInstanceOf(ProfileValidationError);
      expect(JSON.stringify(error)).not.toContain(raw);
      expect(inspect(error)).not.toContain(raw);
      expect((error as ProfileValidationError).issues).toEqual([{ field: 'nickname', code: 'CONTACTS_NOT_ALLOWED' }, { field: 'bio', code: 'CONTACTS_NOT_ALLOWED' }]);
      expect(String(error)).toBe('ProfileValidationError: PROFILE_VALIDATION_FAILED');
      expect(error).not.toHaveProperty('cause');
    }
    try { provider.validateProfile({ ...valid(), roles: [raw, 12], [raw]: raw }); }
    catch (error) { expect(inspect(error)).not.toContain(raw); expect(JSON.stringify(error)).not.toContain(raw); }
  });
  it('returns sanitized safe Steam persona fallback or null for unsafe display names', () => {
    expect(safeDisplayNickname('  Nice\u200b Player_47 ')).toBe('Nice Player_47');
    for (const value of ['@contact', 't.me/user', '+7 707 123 45 67', 'a', 'a'.repeat(33), '🔥🔥', null]) expect(safeDisplayNickname(value)).toBeNull();
  });
});

describe('M4 verification badges and public contract', () => {
  it.each([
    [null, null, false, false], [null, ID, false, false], [ID, null, true, false],
    [ID, ID, true, true], [ID, OTHER, true, false], ['invalid', 'invalid', false, false],
  ] as const)('computes badges for %s / %s without trusting FACEIT alone', (steamId64, faceitSteamId64, steamVerified, faceitVerified) => {
    expect(provider.isVerified({ steamId64, faceitSteamId64 })).toEqual({ steamVerified, faceitVerified });
  });
  it('rejects private fields in the closed public transport contract', () => {
    const { gameSlug: _gameSlug, ...fields } = valid();
    const card = { ...fields, id: '550e8400-e29b-41d4-a716-446655440000', badges: { steamVerified: true, faceitVerified: false }, faceit: null, hasBans: null };
    expect(publicPlayerCardSchema.parse(card)).toEqual(card);
    for (const forbidden of ['telegramId', 'username', 'userId', 'steamId64', 'games', 'library', 'playtimeTotal', 'gameSlug']) {
      expect(publicPlayerCardSchema.safeParse({ ...card, [forbidden]: 'never-public' }).success).toBe(false);
    }
    expect(publicPlayerCardSchema.safeParse({ ...card, activity: { cs2Hours: null, cs2Hours2weeks: null } }).success).toBe(true);
    expect(publicPlayerCardSchema.safeParse({ ...card, activity: { cs2Hours: 15.5, cs2Hours2weeks: 2, games: [] } }).success).toBe(false);
  });
});
