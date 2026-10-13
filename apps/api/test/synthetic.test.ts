import { describe, expect, it } from 'vitest';
import { cs2GameProvider } from '../src/games/cs2.js';
import { ownsSyntheticUser, syntheticBatch, syntheticId } from '../src/dev/synthetic-data.js';
import { requireSyntheticConstraint } from '../src/dev/synthetic-constraint.js';
import { requireSyntheticTarget, syntheticConsent, syntheticCount, syntheticTelegramId, SYNTHETIC_TELEGRAM_MIN, SYNTHETIC_TELEGRAM_MAX } from '../src/dev/synthetic-guard.js';

const safe = { NODE_ENV: 'test', ALLOW_SYNTHETIC_SEED: '1', DATABASE_URL: 'postgresql://squad_test@127.0.0.1:5433/squad_m5_test?schema=public' };
describe('synthetic-data safety boundaries', () => {
  it.each(['localhost', '127.0.0.1'])('allows only explicit disposable local database: %s', (host) => {
    expect(requireSyntheticTarget({ ...safe, DATABASE_URL: `postgresql://local@${host}/squad_dev` }).databaseName).toBe('squad_dev');
    expect(requireSyntheticTarget({ ...safe, NODE_ENV: 'development' }).databaseName).toBe('squad_m5_test');
  });
  it.each([undefined, '', '0', 'true', ' 1', '1 '])('refuses missing or inexact opt-in: %s', (value) => {
    expect(() => requireSyntheticTarget({ ...safe, ALLOW_SYNTHETIC_SEED: value })).toThrow('SYNTHETIC_OPT_IN_REQUIRED');
  });
  it.each([undefined, '', 'production', 'Production', 'PRODUCTION', 'production ', 'staging', 'preview'])('refuses unsafe NODE_ENV: %s', (value) => {
    expect(() => requireSyntheticTarget({ ...safe, NODE_ENV: value })).toThrow('SYNTHETIC_DEV_ENV_REQUIRED');
  });
  it.each([undefined, '', 'invalid', 'https://localhost/squad_test', 'file:///squad_test', 'postgresql://localhost/squad_test#host=production'])('refuses invalid URL/protocol/fragment: %s', (value) => {
    expect(() => requireSyntheticTarget({ ...safe, DATABASE_URL: value })).toThrow();
  });
  it.each(['production.example', 'db', '192.168.1.2', '0.0.0.0', '[::1]', 'localhost.', '127.0.0.2', 'localhost.production.example'])('refuses non-allowlisted hosts: %s', (host) => {
    expect(() => requireSyntheticTarget({ ...safe, DATABASE_URL: `postgresql://user@${host}/squad_test` })).toThrow('SYNTHETIC_LOCAL_DATABASE_REQUIRED');
  });
  it.each(['squad', 'squad_prod', 'test', '_test', 'squad_test_backup', 'squad_TEST', 'squad_test/other', 'squad_test%2Fother', 'squad%00_test', 'squad%ZZ_test', ''])('refuses unsafe database names: %s', (database) => {
    expect(() => requireSyntheticTarget({ ...safe, DATABASE_URL: `postgresql://localhost/${database}` })).toThrow();
  });
  it.each(['host=production.example', 'dbname=production', 'schema=private', 'schema=public&schema=public', 'options=-c%20search_path%3Dproduction', 'sslmode=require', 'application_name=seed'])('refuses connection/schema option overrides: %s', (query) => {
    expect(() => requireSyntheticTarget({ ...safe, DATABASE_URL: `postgresql://localhost/squad_test?${query}` })).toThrow('SYNTHETIC_DATABASE_OPTIONS_FORBIDDEN');
  });
  it('fixed errors never retain credentials or connection URLs', () => {
    const databaseUrl = 'postgresql://user:secret-value@production.example/squad_test';
    try { requireSyntheticTarget({ ...safe, DATABASE_URL: databaseUrl }); throw new Error('Expected refusal'); }
    catch (error) {
      expect(String(error)).toBe('SyntheticGuardError: SYNTHETIC_LOCAL_DATABASE_REQUIRED');
      expect(JSON.stringify(error)).not.toContain('secret-value');
      expect(JSON.stringify(error)).not.toContain('production.example');
    }
  });
  it('bounds the default, supplied count and reserved Telegram ID range', () => {
    expect(syntheticCount()).toBe(10_000);
    expect(syntheticCount('100000')).toBe(100_000);
    expect(syntheticTelegramId(0)).toBe(SYNTHETIC_TELEGRAM_MAX);
    expect(syntheticTelegramId(99_999)).toBe(SYNTHETIC_TELEGRAM_MIN);
    for (const input of ['0', '-1', '1.5', '1e4', '100001', 'Infinity', ' 10', '']) expect(() => syntheticCount(input)).toThrow('SYNTHETIC_COUNT_INVALID');
    for (const index of [-1, 100_000, NaN, 1.5]) expect(() => syntheticTelegramId(index)).toThrow('SYNTHETIC_INDEX_INVALID');
  });
  it('cleanup ownership marker cannot match an unrelated or out-of-range user', () => {
    expect(ownsSyntheticUser({ id: syntheticId('user', 0), telegramId: SYNTHETIC_TELEGRAM_MAX })).toBe(true);
    expect(ownsSyntheticUser({ id: syntheticId('profile', 0), telegramId: SYNTHETIC_TELEGRAM_MAX })).toBe(false);
    expect(ownsSyntheticUser({ id: syntheticId('user', 1), telegramId: SYNTHETIC_TELEGRAM_MAX })).toBe(false);
    expect(ownsSyntheticUser({ id: syntheticId('user', 0), telegramId: 123n })).toBe(false);
    expect(ownsSyntheticUser({ id: syntheticId('user', 0), telegramId: SYNTHETIC_TELEGRAM_MIN - 1n })).toBe(false);
  });
  it('uses only explicitly provided public consent settings and refuses invalid configuration', () => {
    expect(syntheticConsent({})).toEqual({ ageMinimum: 18, rulesVersion: '2026-10-07' });
    expect(syntheticConsent({ AGE_MINIMUM: '21', RULES_VERSION: 'next-rules' })).toEqual({ ageMinimum: 21, rulesVersion: 'next-rules' });
    for (const AGE_MINIMUM of ['12', '100', '18.5', 'abc']) expect(() => syntheticConsent({ AGE_MINIMUM })).toThrow('SYNTHETIC_CONSENT_CONFIG_INVALID');
    for (const RULES_VERSION of ['', 'x'.repeat(41)]) expect(() => syntheticConsent({ RULES_VERSION })).toThrow('SYNTHETIC_CONSENT_CONFIG_INVALID');
    const batch = syntheticBatch(0, 1, '00000000-0000-4000-a000-000000000001', syntheticConsent({ AGE_MINIMUM: '21', RULES_VERSION: 'next-rules' }));
    expect(batch.users[0]).toMatchObject({ ageMinimumConfirmed: 21, rulesVersion: 'next-rules' });
  });
  it.each(['(telegram_id > 0)', '((telegram_id) > (0))', '("telegram_id" > 0)', ' telegram_id\n > 0 '])('accepts only the original positive-ID check: %s', (expression) => {
    expect(requireSyntheticConstraint([{ name: 'users_telegram_id_positive', expression, validated: true }], true).validated).toBe(true);
  });
  it.each(['telegram_id >= 0', 'telegram_id > -1', 'telegram_id > 0 OR true', 'other_id > 0', '"telegram_id>0"', 'telegram_id > 0::bigint', 'telegram_id > 0; SELECT 1', 'telegram_id BETWEEN -10 AND 10'])('refuses unexpected CHECK metadata: %s', (expression) => {
    expect(() => requireSyntheticConstraint([{ name: 'users_telegram_id_positive', expression, validated: true }], false)).toThrow('SYNTHETIC_SCHEMA_UNSUPPORTED');
  });
  it('refuses missing/duplicated/renamed constraints and requires initial validation before seed', () => {
    const constraint = { name: 'users_telegram_id_positive', expression: '(telegram_id > 0)', validated: true };
    expect(() => requireSyntheticConstraint([], false)).toThrow('SYNTHETIC_SCHEMA_UNSUPPORTED');
    expect(() => requireSyntheticConstraint([constraint, constraint], false)).toThrow('SYNTHETIC_SCHEMA_UNSUPPORTED');
    expect(() => requireSyntheticConstraint([{ ...constraint, name: 'other' }], false)).toThrow('SYNTHETIC_SCHEMA_UNSUPPORTED');
    expect(() => requireSyntheticConstraint([{ ...constraint, validated: false }], true)).toThrow('SYNTHETIC_SCHEMA_VALIDATION_REQUIRED');
    expect(requireSyntheticConstraint([{ ...constraint, validated: false }], false).validated).toBe(false);
  });
  it('generates deterministic valid profiles with filter/privacy/eligibility variety', () => {
    const batch = syntheticBatch(0, 300, '00000000-0000-4000-a000-000000000001');
    expect(batch).toEqual(syntheticBatch(0, 300, '00000000-0000-4000-a000-000000000001'));
    expect(new Set(batch.users.map((user) => user.id)).size).toBe(300);
    for (const profile of batch.profiles) expect(() => cs2GameProvider.validateProfile({
      gameSlug: 'cs2', nickname: profile.nickname, roles: profile.roles, languages: profile.languages,
      hasMic: profile.hasMic, region: profile.region, playTimes: profile.playTimes, lookingFor: profile.lookingFor, bio: profile.bio,
    })).not.toThrow();
    expect(new Set(batch.faceit.map((player) => player.level)).size).toBe(10);
    expect(batch.users.some((user) => user.isBanned)).toBe(true);
    expect(batch.users.some((user) => user.botBlocked)).toBe(true);
    expect(batch.users.some((user) => user.username === null)).toBe(true);
    expect(batch.steam.length).toBeLessThan(batch.users.length);
    expect(batch.profiles.some((profile) => !profile.isPublished)).toBe(true);
    expect(batch.privacy.some((privacy) => privacy.shareSteamActivity)).toBe(true);
    expect(batch.privacy.some((privacy) => !privacy.shareSteamActivity)).toBe(true);
    expect(batch.steam.some((account) => account.vacBans === 1)).toBe(true);
    expect(batch.steam.some((account) => account.gameBans === 1)).toBe(true);
  });
});
