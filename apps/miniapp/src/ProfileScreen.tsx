import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizeProfileText, profileTextError, publishRequirementSchema, type AuthUser, type ProfileField, type ProfileOptions, type ProfileResponse, type PublicPlayerCard, type PublishRequirement } from '@squad/shared';
import { api, ApiError, errorCode } from './api.js';
import { getTelegramWebApp } from './telegram.js';
import { confirmAccountDeletion, createProfileDraft, installUnsavedChangesGuard, profileDraftChanged, toggleProfileChoice, validateProfileDraft, type ProfileDraft, type ProfileErrors } from './profile.js';
import './profile.css';

type Operation = 'save' | 'publish' | 'preview' | 'privacy' | null;
const fields = ['roles', 'lookingFor', 'playTimes', 'languages'] as const;
const limits = { roles: 3, lookingFor: 3, playTimes: 4, languages: 4 };

export function ProfileScreen({ onAuthError, onPrivacyChanged, onDirtyChange }: {
  onAuthError(error: unknown): void;
  onPrivacyChanged(user: AuthUser): void;
  onDirtyChange(dirty: boolean): void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [draft, setDraft] = useState<ProfileDraft>(() => createProfileDraft());
  const [saved, setSaved] = useState<ProfileDraft>(() => createProfileDraft());
  const [errors, setErrors] = useState<ProfileErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<Operation>(null);
  const [preview, setPreview] = useState<PublicPlayerCard | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [guidance, setGuidance] = useState<string[]>([]);
  const [generation, setGeneration] = useState(0);
  const mounted = useRef(false);
  const busy = useRef(false);
  const mutation = useRef<AbortController | null>(null);
  const dirty = profileDraftChanged(draft, saved);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; mutation.current?.abort(); };
  }, []);

  useEffect(() => {
    onDirtyChange(dirty);
    return installUnsavedChangesGuard(dirty, window, getTelegramWebApp());
  }, [dirty, onDirtyChange]);
  useEffect(() => () => { onDirtyChange(false); }, [onDirtyChange]);

  function handleError(cause: unknown) {
    if (!mounted.current) return;
    const code = errorCode(cause);
    if (['SESSION_EXPIRED', 'SESSION_INVALID', 'UNAUTHORIZED', 'USER_BANNED'].includes(code)) onAuthError(cause);
    else setNotice(code);
    if (cause instanceof ApiError) {
      if (cause.issues) setErrors(Object.fromEntries(cause.issues.map((issue) => [issue.field, issue.code])));
      else if (cause.field) setErrors({ [cause.field]: cause.code });
      if (cause.requirements) {
        const requirements = cause.requirements.flatMap((requirement) => {
          const parsed = publishRequirementSchema.safeParse(requirement); return parsed.success ? [parsed.data] : [];
        });
        setData((current) => current ? { ...current, requirements } : current);
      }
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setNotice(null);
    void api.profile(controller.signal).then(async (result) => {
      if (controller.signal.aborted) return;
      setData(result);
      const initial = createProfileDraft(result.profile);
      setDraft(initial); setSaved(initial);
      if (result.profile) {
        try {
          const card = await api.previewProfile(controller.signal);
          if (!controller.signal.aborted) { setPreview(card); setPreviewError(null); }
        } catch (cause) {
          if (!controller.signal.aborted) {
            const code = errorCode(cause);
            setPreviewError(code);
            if (['SESSION_EXPIRED', 'SESSION_INVALID', 'UNAUTHORIZED', 'USER_BANNED'].includes(code)) handleError(cause);
          }
        }
      }
    }).catch((cause: unknown) => { if (!controller.signal.aborted) handleError(cause); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    void api.stats(controller.signal).then((result) => {
      if (!controller.signal.aborted) setGuidance(result.guidance);
    }).catch(() => { /* Stats availability never blocks profile editing or publishing. */ });
    return () => controller.abort();
    // Reload only after an explicit retry; preserving unsaved input is deliberate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);

  async function perform(next: NonNullable<Operation>, action: (signal: AbortSignal) => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    const controller = new AbortController();
    mutation.current = controller;
    setOperation(next); setNotice(null); setSuccess(false);
    try { await action(controller.signal); }
    catch (cause) { if (!controller.signal.aborted) handleError(cause); }
    finally {
      busy.current = false;
      if (mutation.current === controller) mutation.current = null;
      if (mounted.current && !controller.signal.aborted) setOperation(null);
    }
  }

  function change<K extends keyof ProfileDraft>(field: K, value: ProfileDraft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: field === 'nickname' || field === 'bio'
      ? profileTextError(field, field === 'nickname' && !normalizeProfileText(String(value)) ? null : String(value)) ?? undefined
      : undefined }));
    setSuccess(false);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data || busy.current) return;
    const validation = validateProfileDraft(draft, data.options);
    setErrors(validation.errors);
    setSuccess(false);
    if (!validation.input) return;
    await perform('save', async (signal) => {
      const result = await api.saveProfile(validation.input!, signal);
      if (signal.aborted) return;
      setData(result);
      const next = createProfileDraft(result.profile);
      setDraft(next); setSaved(next); setSuccess(true);
      // Fetch the public serializer's output; never recreate it from private account data.
      setPreview(null); setPreviewError(null);
      try {
        const card = await api.previewProfile(signal);
        if (!signal.aborted) setPreview(card);
      } catch (cause) {
        if (!signal.aborted) { setPreviewError(errorCode(cause)); handleError(cause); }
      }
    });
  }

  async function publish(published: boolean) {
    await perform('publish', async (signal) => {
      const result = await api.publishProfile(published, signal);
      if (!signal.aborted) setData((current) => current ? { ...current, ...result } : current);
    });
  }

  async function changePrivacy(shareSteamActivity: boolean) {
    await perform('privacy', async (signal) => {
      const result = await api.changePrivacy(shareSteamActivity, signal);
      if (signal.aborted) return;
      onPrivacyChanged(result.user);
      setData((current) => current ? { ...current, privacy: result.user.privacy } : current);
      setPreview(null); setPreviewError(null);
      if (data?.profile) {
        try {
          const card = await api.previewProfile(signal);
          if (!signal.aborted) setPreview(card);
        } catch (cause) { if (!signal.aborted) { setPreviewError(errorCode(cause)); handleError(cause); } }
      }
    });
  }

  function fieldError(field: ProfileField) {
    return errors[field] ? <p className="profile-field-error" id={`profile-${field}-error`} role="alert">{t(`profile.validation.${errors[field]}`, { defaultValue: t('profile.validation.INVALID_FORMAT') })}</p> : null;
  }

  return <section className="account-panel profile-panel" aria-labelledby="profile-title">
    <div className="section-heading"><span className="step-label">{t('profile.step')}</span>
      <span className={`badge ${data?.published ? '' : 'badge-muted'}`}>{t(data?.published ? 'profile.published' : 'profile.draft')}</span></div>
    <h2 id="profile-title">{t('profile.title')}</h2><p className="panel-description">{t('profile.description')}</p>
    {loading && <p aria-live="polite">{t('profile.loading')}</p>}
    {notice && <p role="alert" className="profile-field-error">{t(`profile.errors.${notice}`, { defaultValue: t(`errors.${notice}`, { defaultValue: t('errors.REQUEST_FAILED') }) })}</p>}
    {!loading && !data && <button className="secondary-button" type="button" onClick={() => setGeneration((value) => value + 1)}>{t('auth.retry')}</button>}
    {!loading && data && <>
      <form onSubmit={(event) => { void save(event); }} noValidate>
        <fieldset className="profile-form" disabled={Boolean(operation)}>
          <label className="profile-field" htmlFor="profile-nickname"><span>{t('profile.nickname')}</span>
            <input id="profile-nickname" type="text" autoComplete="off" value={draft.nickname} maxLength={64}
              aria-invalid={Boolean(errors.nickname)} aria-describedby="profile-nickname-help profile-nickname-error"
              onChange={(event) => change('nickname', event.target.value)} />
            <small id="profile-nickname-help">{t('profile.nicknameHint')}</small>
            <small className="profile-counter">{t('profile.counter', { count: Array.from(draft.nickname).length, max: 32 })}</small>{fieldError('nickname')}</label>
          {fields.map((field) => <ProfileChips key={field} field={field} options={data.options} values={draft[field]}
            error={errors[field]} onChange={(values) => change(field, values)} />)}
          <label className="profile-field" htmlFor="profile-region"><span>{t('profile.region')}</span>
            <select id="profile-region" value={draft.region} aria-invalid={Boolean(errors.region)} aria-describedby="profile-region-error"
              onChange={(event) => change('region', event.target.value)}>
              <option value="">{t('profile.regionPlaceholder')}</option>
              {draft.region && !data.options.regions.includes(draft.region) && <option value={draft.region}>{t('profile.unavailableOption', { value: draft.region })}</option>}
              {data.options.regions.map((region) => <option value={region} key={region}>{t(`profile.options.regions.${region}`, { defaultValue: region })}</option>)}
            </select>{fieldError('region')}</label>
          <label className="checkbox-row"><input type="checkbox" checked={draft.hasMic} onChange={(event) => change('hasMic', event.target.checked)} />
            <span>{t('profile.hasMic')}</span></label>
          <label className="profile-field" htmlFor="profile-bio"><span>{t('profile.bio')}</span>
            <textarea id="profile-bio" rows={4} value={draft.bio} maxLength={1000} aria-invalid={Boolean(errors.bio)}
              aria-describedby="profile-bio-help profile-bio-error" onChange={(event) => change('bio', event.target.value)} />
            <small id="profile-bio-help">{t('profile.bioHint')}</small>
            <small className="profile-counter">{t('profile.counter', { count: Array.from(draft.bio).length, max: 500 })}</small>{fieldError('bio')}</label>
          <div className="profile-save-row"><button className="primary-button" type="submit" disabled={Boolean(operation) || (!dirty && Boolean(data.profile))}>
            {t(operation === 'save' ? 'profile.saving' : 'profile.save')}</button>
            <span role="status">{success ? t('profile.saved') : dirty ? t('profile.unsaved') : ''}</span></div>
        </fieldset>
      </form>

      <section className="profile-publication" aria-labelledby="profile-publish-title">
        <h3 id="profile-publish-title">{t('profile.publishTitle')}</h3><p>{t('profile.publishDescription')}</p>
        <PublishChecklist requirements={data.requirements} dirty={dirty} />
        {guidance.map((item) => <p className="profile-guidance" key={item}>{t(`stats.guidance.${item}`)}</p>)}
        <label className="checkbox-row"><input type="checkbox" checked={data.published} disabled={Boolean(operation) || (!data.published && dirty)}
          onChange={(event) => { void publish(event.target.checked); }} /><span>{t('profile.publishToggle')}</span></label>
        {data.published && <p className="profile-guidance">{t('profile.futureDiscovery')}</p>}
      </section>

      <section className="profile-privacy" aria-labelledby="profile-privacy-title">
        <h3 id="profile-privacy-title">{t('profile.privacyTitle')}</h3>
        <label className="checkbox-row"><input type="checkbox" checked={data.privacy.shareSteamActivity} disabled={Boolean(operation)}
          onChange={(event) => { void changePrivacy(event.target.checked); }} /><span>{t('profile.shareActivity')}<small>{t('profile.privacyExplanation')}</small></span></label>
      </section>

      <section className="profile-preview" aria-labelledby="profile-preview-title">
        <div className="profile-preview-heading"><h3 id="profile-preview-title">{t('profile.previewTitle')}</h3>
          <button className="text-button" type="button" disabled={Boolean(operation) || !data.profile || dirty}
            onClick={() => { void perform('preview', async (signal) => {
              setPreviewError(null); const card = await api.previewProfile(signal); if (!signal.aborted) setPreview(card);
            }); }}>{t('profile.previewRefresh')}</button></div>
        {dirty && <p className="profile-guidance">{t('profile.previewSaveFirst')}</p>}
        {previewError && <p className="profile-field-error" role="alert">{t('profile.previewUnavailable')}</p>}
        {preview ? <PublicProfileCard card={preview} /> : <p>{t(data.profile ? 'profile.previewUnavailable' : 'profile.previewEmpty')}</p>}
      </section>

    </>}
  </section>;
}

/** Account removal remains accessible before onboarding or Steam linking. */
export function AccountDeletionSection({ onAuthError, onDeleted }: { onAuthError(error: unknown): void; onDeleted(): void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);
  async function remove() {
    if (controller.current || !confirmed) return;
    const cancellation = new AbortController();
    controller.current = cancellation;
    setPending(true); setError(null);
    try {
      await confirmAccountDeletion(confirmed, () => api.deleteAccount(cancellation.signal), () => { if (!cancellation.signal.aborted) onDeleted(); });
    } catch (cause) {
      if (!cancellation.signal.aborted && mounted.current) {
        const code = errorCode(cause);
        if (['SESSION_EXPIRED', 'SESSION_INVALID', 'UNAUTHORIZED', 'USER_BANNED'].includes(code)) onAuthError(cause);
        else setError(code);
      }
    } finally {
      if (controller.current === cancellation) controller.current = null;
      if (!cancellation.signal.aborted && mounted.current) setPending(false);
    }
  }
  return <section className="account-panel profile-panel profile-account-deletion" aria-labelledby="profile-delete-title"><h2 id="profile-delete-title">{t('profile.deleteTitle')}</h2>
    <p className="panel-description">{t('profile.deleteDescription')}</p><button className="profile-danger-button" type="button" disabled={pending}
      onClick={() => { setOpen(true); setConfirmed(false); setError(null); }}>{t('profile.deleteOpen')}</button>
    {error && <p className="profile-field-error" role="alert">{t(`errors.${error}`, { defaultValue: t('errors.REQUEST_FAILED') })}</p>}
    {open && <AccountDeletionDialog confirmed={confirmed} busy={pending} onConfirmChange={setConfirmed}
      onCancel={() => { setOpen(false); setConfirmed(false); }} onDelete={() => { void remove(); }} />}
  </section>;
}

export function ProfileChips({ field, options, values, error, onChange }: {
  field: typeof fields[number]; options: ProfileOptions; values: string[]; error?: string; onChange(values: string[]): void;
}) {
  const { t } = useTranslation();
  return <fieldset className="profile-chip-field" aria-describedby={`profile-${field}-help profile-${field}-error`}>
    <legend>{t(`profile.${field}`)}</legend><small id={`profile-${field}-help`}>{t('profile.choiceLimit', { max: limits[field] })}</small>
    <div className="profile-chips">{Array.from(new Set([...options[field], ...values])).map((value) => <button className="profile-chip" type="button" key={value}
      aria-pressed={values.includes(value)} disabled={!values.includes(value) && values.length >= limits[field]}
      onClick={() => onChange(toggleProfileChoice(values, value, limits[field]))}>{options[field].includes(value)
        ? t(`profile.options.${field}.${value}`, { defaultValue: value })
        : t('profile.removeUnavailableOption', { value })}</button>)}</div>
    {error && <p id={`profile-${field}-error`} className="profile-field-error" role="alert">{t(`profile.validation.${error}`, { defaultValue: t('profile.validation.INVALID_FORMAT') })}</p>}
  </fieldset>;
}

export function PublishChecklist({ requirements, dirty = false }: { requirements: PublishRequirement[]; dirty?: boolean }) {
  const { t } = useTranslation();
  const all = ['ONBOARDING_INCOMPLETE', 'STEAM_REQUIRED', 'PROFILE_INCOMPLETE', 'PROFILE_INVALID', 'USER_BANNED', 'MODERATION_HIDDEN'] as const;
  return <ul className="profile-checklist">{all.map((code) => {
    const missing = requirements.find((requirement) => requirement.code === code);
    return <li key={code} data-complete={!missing}><span aria-hidden="true">{missing ? '○' : '✓'}</span><span>{t(`profile.requirements.${code}.${missing ? 'missing' : 'complete'}`)}
      {missing?.fields && missing.fields.length > 0 && <small>{t('profile.requiredFields', { fields: missing.fields.map((field) => t(`profile.${field}`, { defaultValue: field })).join(', ') })}</small>}</span></li>;
  })}{dirty && <li data-complete="false"><span aria-hidden="true">○</span><span>{t('profile.previewSaveFirst')}</span></li>}</ul>;
}

export function PublicProfileCard({ card }: { card: PublicPlayerCard }) {
  const { t, i18n } = useTranslation();
  const number = (value: number) => new Intl.NumberFormat(i18n.resolvedLanguage === 'en' ? 'en' : 'ru', { maximumFractionDigits: 1 }).format(value);
  return <article className="public-profile-card">
    <h4>{card.nickname ?? t('profile.unnamed')}</h4>
    <div className="profile-badges">{card.badges.steamVerified && <span className="badge">{t('profile.steamVerified')}</span>}
      {card.badges.faceitVerified && <span className="badge">{t('profile.faceitVerified')}</span>}</div>
    <dl className="profile-preview-details">
      {fields.map((field) => <div key={field}><dt>{t(`profile.${field}`)}</dt><dd>{card[field].map((value) => t(`profile.options.${field}.${value}`, { defaultValue: value })).join(', ')}</dd></div>)}
      <div><dt>{t('profile.region')}</dt><dd>{t(`profile.options.regions.${card.region}`, { defaultValue: card.region })}</dd></div>
      <div><dt>{t('profile.microphone')}</dt><dd>{t(card.hasMic ? 'profile.yes' : 'profile.no')}</dd></div>
      <div><dt>{t('profile.bans')}</dt><dd>{t(card.hasBans == null ? 'stats.unknown' : card.hasBans ? 'stats.banned' : 'stats.clear')}</dd></div>
      {card.faceit && <><div><dt>{t('stats.faceitLevel')}</dt><dd>{card.faceit.level ?? t('stats.unknown')}</dd></div>
        <div><dt>{t('stats.faceitElo')}</dt><dd>{card.faceit.elo ?? t('stats.unknown')}</dd></div></>}
      {card.activity && <><div><dt>{t('stats.cs2Total')}</dt><dd>{card.activity.cs2Hours == null ? t('stats.unknown') : t('stats.hours', { value: number(card.activity.cs2Hours) })}</dd></div>
        <div><dt>{t('stats.cs2Recent')}</dt><dd>{card.activity.cs2Hours2weeks == null ? t('stats.unknown') : t('stats.hours', { value: number(card.activity.cs2Hours2weeks) })}</dd></div></>}
    </dl>
    {!card.activity && <p className="profile-guidance">{t('profile.activityHidden')}</p>}
    {card.bio && <p className="profile-bio">{card.bio}</p>}
  </article>;
}

export function AccountDeletionDialog({ confirmed, busy, onConfirmChange, onCancel, onDelete }: {
  confirmed: boolean; busy: boolean; onConfirmChange(value: boolean): void; onCancel(): void; onDelete(): void;
}) {
  const { t } = useTranslation();
  return <div role="alertdialog" aria-modal="false" aria-labelledby="delete-confirm-title" aria-describedby="delete-confirm-description" className="profile-delete-dialog"
    onKeyDown={(event) => { if (event.key === 'Escape' && !busy) onCancel(); }}>
    <h4 id="delete-confirm-title">{t('profile.deleteConfirmTitle')}</h4><p id="delete-confirm-description">{t('profile.deleteConfirmDescription')}</p>
    <label className="checkbox-row"><input type="checkbox" autoFocus checked={confirmed} disabled={busy} onChange={(event) => onConfirmChange(event.target.checked)} />
      <span>{t('profile.deleteAcknowledgement')}</span></label>
    <div className="profile-dialog-actions"><button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>{t('profile.cancel')}</button>
      <button className="profile-danger-button" type="button" disabled={!confirmed || busy} onClick={onDelete}>{t(busy ? 'profile.deleting' : 'profile.deleteConfirm')}</button></div>
  </div>;
}
