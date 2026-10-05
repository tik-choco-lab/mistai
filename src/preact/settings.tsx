// LlmSettings v2: tc-translate's provider/room prototype behind app adapters.
import type { ComponentChildren } from 'preact';
import { createContext } from 'preact';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createProvider, patchProvider, deleteProvider, setDefaultModel, setVoiceConfig, isNetworkProviderBaseUrl, networkProviderBaseUrl, roomIdFromBaseUrl, providerKind, type LlmProviderV1, type ModelRefV1, type SharedLlmConfigV1, type VoiceConfigV1 } from '../llm-config.js';
import { refreshProviderModels, revalidateProviderModels } from '../model-catalog.js';
import { fetchVoices } from '../openai.js';
import { isTtsSpeed } from '../protocol.js';
import { ModelPicker, useLiveModels } from './ModelPicker.js';
import { ReasoningPicker } from './ReasoningPicker.js';
import { ChoicePicker } from './ChoicePicker.js';
import { ProviderStatus } from './ProviderStatus.js';
import { SharingPanel } from './SharingPanel.js';
import { AddConnectionPopup, focusProviderCard } from './AddConnectionPopup.js';
import { AnimatedDisclosure, motionOptions, useAnimatedItems } from './SettingsMotion.js';
import { useLlmConfig, useNetworkConsumerStatusWithTimestamp } from './hooks.js';
import { SettingsI18nContext, useSettingsI18n, type LlmSettingsLocale, type LlmSettingsMessages } from './i18n.js';
import { buildTtsVoiceOptionValues, resolveTtsVoiceOptions } from './voice-options.js';
import type { LlmLocalSettings, LlmSettingsLocalAdapter, LlmSettingsTask, LlmSettingsVoiceAdapter, LlmSettingsMicAdapter } from './types.js';
import { ChevronDown, X } from './icons.js';
export * from './types.js';
export * from './voice-options.js';
export { LLM_SETTINGS_MESSAGES, type LlmSettingsLocale, type LlmSettingsMessages } from './i18n.js';

export interface LlmSettingsProps {
  tasks: LlmSettingsTask[];
  localSettings: LlmSettingsLocalAdapter;
  voice?: LlmSettingsVoiceAdapter;
  mic?: LlmSettingsMicAdapter;
  locale?: LlmSettingsLocale;
  messages?: Partial<LlmSettingsMessages>;
  extraSections?: ComponentChildren | ((tab: 'connection' | 'tasks' | 'sharing') => ComponentChildren);
  /** App controls above the tab bar, such as a UI-language selector. */
  headerSection?: ComponentChildren;
  config?: SharedLlmConfigV1;
  onConfigChange?(config: SharedLlmConfigV1): void;
  onClose?(): void;
  initialTab?: 'connection' | 'tasks' | 'sharing';
  title?: string;
  className?: string;
}
function ProviderField({ label, value, commit, type = 'text' }: { label: string; value: string; commit(value: string): string | undefined; type?: string }) {
  const { t } = useSettingsI18n();
  const [draft, setDraft] = useState(value), [feedback, setFeedback] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(), cancelled = useRef(false);
  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  function save(next: string) {
    if (cancelled.current) { cancelled.current = false; return; }
    if (next === value) return;
    const error = commit(next); setFeedback(error ?? t('field-saved'));
    clearTimeout(timer.current); if (!error) timer.current = setTimeout(() => setFeedback(''), 1200);
  }
  return <label class="provider-field"><span>{label}</span><span class="provider-field-control"><input type={type} value={draft} aria-invalid={!!feedback && feedback !== t('field-saved')} onInput={event => { setDraft(event.currentTarget.value); setFeedback(''); }} onBlur={event => save(event.currentTarget.value)} onKeyDown={event => {
    if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelled.current = true; setDraft(value); setFeedback(''); event.currentTarget.blur(); }
  }} />{feedback && <small class={feedback === t('field-saved') ? 'provider-field-saved' : 'model-warning'} role="status">{feedback}</small>}</span></label>;
}
const LocalContext = createContext<LlmLocalSettings>({ tasks: {}, roomProvide: {}, recentModels: [] });
function ProviderCard({ provider, update, remove }: { provider: LlmProviderV1; update(patch: Partial<LlmProviderV1>): string | undefined; remove(): void }) {
  const { t } = useSettingsI18n(), local = useContext(LocalContext);
  const room = providerKind(provider) === 'room', [expanded, setExpanded] = useState(false);
  const { status, updatedAt } = useNetworkConsumerStatusWithTimestamp(provider.enabled !== false && room ? roomIdFromBaseUrl(provider.baseUrl) : '');
  useEffect(() => {
    const focus = (event: Event) => { if ((event as CustomEvent<string>).detail !== provider.id) return; setExpanded(true); document.querySelector<HTMLButtonElement>(`[data-provider-id="${CSS.escape(provider.id)}"] .provider-card-summary`)?.focus({ preventScroll: true }); };
    window.addEventListener('mistai-focus-provider', focus); return () => window.removeEventListener('mistai-focus-provider', focus);
  }, [provider.id]);
  return <article class={`provider-card ${provider.enabled === false ? 'provider-disabled' : ''}`} data-provider-id={provider.id}>
    <div class="provider-card-heading"><button type="button" class="settings-switch" role="switch" aria-checked={provider.enabled !== false} onClick={() => update({ enabled: provider.enabled === false })} aria-label={`${provider.label} ${t('models-enabled')}`} data-tip={t('models-enabled')}><span /></button>
      <button type="button" class="provider-card-summary" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><span class="provider-kind">{room ? t('connection-room') : 'HTTP'}</span><span class="provider-card-name"><strong title={provider.label || provider.baseUrl}>{provider.label || provider.baseUrl}</strong><span class="provider-card-meta" title={room ? roomIdFromBaseUrl(provider.baseUrl) : provider.baseUrl}>{room ? roomIdFromBaseUrl(provider.baseUrl) : provider.baseUrl}</span></span><ChevronDown size={16} class="disclosure-chevron" /></button>
      <ProviderStatus provider={provider} status={status} updatedAt={updatedAt} provide={local.roomProvide[provider.id]?.enabled ?? false} />
    </div><AnimatedDisclosure open={expanded}><div class="provider-card-body">
      <ProviderField label={t('provider-label')} value={provider.label} commit={label => update({ label })} />
      <ProviderField label={t(room ? 'room-id' : 'connection-base-url')} value={room ? roomIdFromBaseUrl(provider.baseUrl) : provider.baseUrl} commit={value => update({ baseUrl: room ? (value.trim() ? networkProviderBaseUrl(value) : '') : value.trim() })} />
      {!room && <ProviderField label={t('connection-api-key')} value={provider.apiKey} type="password" commit={apiKey => update({ apiKey })} />}
      <div class="provider-card-actions"><button type="button" class="danger-button" onClick={() => { if (confirm(t('provider-delete-confirm'))) remove(); }}>{t('provider-delete')}</button></div>
    </div></AnimatedDisclosure></article>;
}
function VoiceRows({ config, voice, mic, recent, saveVoice, remember }: { config: SharedLlmConfigV1; voice?: LlmSettingsVoiceAdapter; mic?: LlmSettingsMicAdapter; recent: ModelRefV1[]; saveVoice(kind: 'tts' | 'stt', value: VoiceConfigV1): void; remember(ref?: ModelRefV1): void }) {
  const { t } = useSettingsI18n(), statuses = useLiveModels(config.providers);
  const tts = voice?.tts?.get?.() ?? config.tts, provider = config.providers.find(p => p.id === (tts?.providerId ?? config.defaultModel?.providerId));
  const engine = !tts?.model ? 'browser' : provider && isNetworkProviderBaseUrl(provider.baseUrl) ? 'network' : 'api';
  const [fetched, setFetched] = useState<string[]>([]);
  useEffect(() => {
    setFetched([]); if (engine !== 'api' || !provider || provider.enabled === false) return;
    let cancelled = false;
    const timer = setTimeout(() => { void fetchVoices(provider.baseUrl, provider.apiKey).then(values => { if (!cancelled) setFetched(values); }); }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [engine, provider?.baseUrl, provider?.apiKey, provider?.enabled]);
  const voices = buildTtsVoiceOptionValues(resolveTtsVoiceOptions({ engine, consumerStatus: statuses[provider?.id ?? ''], fetchedApiVoices: fetched, adapterVoiceOptions: voice?.tts?.voiceOptions }), tts?.voice ?? '');
  return <>{(['tts', 'stt'] as const).map(kind => {
    if (!voice?.[kind]) return null;
    const value = voice[kind]?.get?.() ?? config[kind];
    return <><div class="provider-task-row"><span data-tip={t(`voice-${kind}-tip`)}>{t(`voice-${kind}-heading`)}</span><ModelPicker providers={config.providers} recent={recent} label={t(`voice-${kind}-model-label`)} voice clearLabel={t('voice-model-browser-option')} value={value?.model ? { providerId: value.providerId ?? config.defaultModel?.providerId ?? '', model: value.model } : undefined} onChange={ref => { saveVoice(kind, { ...value, providerId: ref?.providerId, model: ref?.model ?? '' }); remember(ref); }} /></div>
      {kind === 'tts' && engine !== 'browser' && <div class="provider-task-row"><span>{t('voice-tts-voice-label')}</span><ChoicePicker label={t('voice-tts-voice-label')} value={tts?.voice ?? ''} options={voices.map(value => ({ value, label: value || t('voice-provider-default-option') }))} onChange={value => saveVoice('tts', { ...tts, model: tts?.model ?? '', voice: value })} /></div>}
      {kind === 'tts' && <label class="provider-task-row provider-field"><span>{t('voice-tts-speed-label')}</span><span class="provider-field-control"><input name="tts-speed" type="number" min="0.25" max="4" step="0.05" value={tts?.speed ?? 1} onInput={event => {
        const speed = event.currentTarget.valueAsNumber;
        if (isTtsSpeed(speed)) saveVoice('tts', { ...tts, model: tts?.model ?? '', speed });
      }} /></span></label>}</>;
  })}{mic && <div class="provider-task-row"><span>{t('voice-mic-label')}</span><ChoicePicker className="mic-picker" label={t('voice-mic-label')} value={mic.deviceId} options={[{ value: '', label: t('voice-mic-default-option') }, ...(mic.devices ?? []).map((device, index) => ({ value: device.deviceId, label: device.label || t('voice-mic-fallback-label', { index: index + 1 }) }))]} onChange={mic.onChange} /></div>}{mic?.labelsHidden && <p class="hint">{t('voice-mic-permission-hint')} <button class="link-button" onClick={() => void mic.onUnlockLabels?.()}>{t('voice-mic-permission-button')}</button></p>}</>;
}
export function LlmSettings(props: LlmSettingsProps) {
  const surface = useRef<HTMLElement>(null);
  return <SettingsI18nContext.Provider value={{ locale: props.locale ?? 'en', messages: props.messages, surface }}><SettingsContent {...props} surface={surface} /></SettingsI18nContext.Provider>;
}
function SettingsContent(props: LlmSettingsProps & { surface: { current: HTMLElement | null } }) {
  const { t } = useSettingsI18n(), state = useLlmConfig(), config = props.config ?? state.config;
  const localRef = useRef(props.localSettings.get()); localRef.current = props.localSettings.get();
  const [, render] = useState(0), local = localRef.current;
  useEffect(() => props.localSettings.subscribe?.(() => render(n => n + 1)), [props.localSettings]);
  useEffect(() => { void revalidateProviderModels(); }, []);
  const [tab, setTab] = useState(props.initialTab ?? 'connection');
  const dialog = useRef<HTMLElement>(null), animation = useRef<Animation | null>(null), previousHeight = useRef<number | null>(null), overlayPressStarted = useRef(false);
  useEffect(() => {
    const reset = () => { overlayPressStarted.current = false; }; document.addEventListener('pointerdown', reset, true);
    const media = matchMedia('(prefers-reduced-motion: reduce)'), stop = () => { animation.current?.cancel(); animation.current = null; }; media.addEventListener('change', stop);
    return () => { document.removeEventListener('pointerdown', reset, true); media.removeEventListener('change', stop); stop(); };
  }, []);
  useLayoutEffect(() => {
    const from = previousHeight.current; previousHeight.current = null; animation.current?.cancel(); animation.current = null; const element = dialog.current;
    if (!element || from === null || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const to = element.getBoundingClientRect().height; if (Math.abs(to - from) < 1) return;
    const next = element.animate([{ height: `${from}px` }, { height: `${to}px` }], motionOptions(element)); animation.current = next; next.onfinish = () => { if (animation.current === next) animation.current = null; };
  }, [tab]);
  function editLocal(mutate: (value: LlmLocalSettings) => void) { const value = structuredClone(localRef.current); mutate(value); localRef.current = value; props.localSettings.set(value); render(n => n + 1); }
  function remember(ref?: ModelRefV1) { if (ref) editLocal(value => { value.recentModels = [ref, ...value.recentModels.filter(r => r.providerId !== ref.providerId || r.model !== ref.model)].slice(0, 8); }); }
  function save(mutate: (value: SharedLlmConfigV1) => void) { if (props.config) { const value = structuredClone(props.config); mutate(value); props.onConfigChange?.(value); } else state.save(mutate); }
  function add(label: string, patch?: Partial<Omit<LlmProviderV1, 'id'>>) { let id = ''; save(value => { id = createProvider(value, label); if (patch) patchProvider(value, id, patch); }); void refreshProviderModels(id, { force: true }); return id; }
  function update(id: string, patch: Partial<LlmProviderV1>): string | undefined {
    const old = config.providers.find(p => p.id === id);
    if (patch.baseUrl !== undefined) {
      if (old && providerKind(old) === 'room') {
        const roomId = roomIdFromBaseUrl(patch.baseUrl); if (!roomId) return t('room-id-invalid');
        const existing = config.providers.find(p => p.id !== id && providerKind(p) === 'room' && roomIdFromBaseUrl(p.baseUrl) === roomId);
        if (existing) { focusProviderCard(existing.id); return t('connection-room-duplicate'); }
      } else { try { const url = new URL(patch.baseUrl); if (!['http:', 'https:'].includes(url.protocol)) return t('field-invalid'); } catch { return t('field-invalid'); } }
    }
    const refresh = old && ((patch.baseUrl !== undefined && patch.baseUrl !== old.baseUrl) || (patch.apiKey !== undefined && patch.apiKey !== old.apiKey) || (patch.enabled === true && old.enabled === false));
    save(value => patchProvider(value, id, patch)); if (refresh) void refreshProviderModels(id, { force: true }); return undefined;
  }
  const settings = { ...local, providers: config.providers, defaultModel: config.defaultModel }, providerRows = useAnimatedItems(config.providers), picker = { providers: config.providers, recent: local.recentModels };
  const content = <section ref={element => { dialog.current = element; props.surface.current = element; }} class={`mistai-surface mistai-settings settings-modal provider-room-settings ${props.className ?? ''}`} role={props.onClose ? 'dialog' : undefined} aria-modal={props.onClose ? 'true' : undefined} aria-label={props.title ?? t('settings')}>
    <div class="modal-heading"><h2>{props.title ?? t('settings')}</h2>{props.onClose && <button type="button" class="icon-button" aria-label={t('close-settings')} onClick={props.onClose}><X size={20} /></button>}</div>
    {props.headerSection}
    <div class="settings-tab-bar" role="tablist"><span class="settings-tab-highlight" aria-hidden="true" style={{ transform: `translateX(${(['connection', 'tasks', 'sharing'] as const).indexOf(tab) * 100}%)` }} />{(['connection', 'tasks', 'sharing'] as const).map(id => <button type="button" role="tab" aria-selected={tab === id} class={tab === id ? 'active' : ''} onClick={() => { if (tab === id) return; previousHeight.current = dialog.current?.getBoundingClientRect().height ?? null; if (dialog.current) dialog.current.scrollTop = 0; setTab(id); }}>{t(`settings-tab-${id}`)}</button>)}</div>
    {tab === 'connection' ? <div class="provider-list" role="tabpanel"><div class="connections-header"><strong>{t('settings-tab-connection')}</strong><AddConnectionPopup providers={config.providers} onAddProvider={add} onUpdateProvider={update} /></div>{providerRows.map(({ item: provider, phase }) => <div key={provider.id} class={`settings-motion-item ${phase}`} inert={phase === 'leaving'}><ProviderCard provider={provider} update={patch => update(provider.id, patch)} remove={() => save(value => deleteProvider(value, provider.id))} /></div>)}</div> : tab === 'sharing' ? <SharingPanel settings={settings} onSetRoomProvide={(id, provide) => editLocal(value => { value.roomProvide[id] = provide; })} onAddProvider={add} onUpdateProvider={update} /> : <div class="provider-tasks" role="tabpanel">
      <div class="provider-task-row"><span data-tip={t('models-default')}>{t('models-default')}</span><ModelPicker {...picker} name="default-model" label={t('models-default')} value={config.defaultModel} onChange={ref => { save(value => setDefaultModel(value, ref)); remember(ref); }} /></div>
      {props.tasks.map(task => <div key={task.id} class={`provider-task-row ${task.reasoning ? 'with-effort' : ''}`}><span data-tip={task.tip} title={task.tip}>{task.label}</span><ModelPicker {...picker} name={task.id} label={task.label} inheritedValue={config.defaultModel} value={local.tasks[task.id]?.ref} clearLabel={t('models-follow')} onChange={ref => { editLocal(value => { value.tasks[task.id] = { reasoningEffort: value.tasks[task.id]?.reasoningEffort ?? 'none', ref }; }); remember(ref); }} />{task.reasoning && <ReasoningPicker value={local.tasks[task.id]?.reasoningEffort ?? 'none'} label={`${task.label} ${t('models-effort')}`} onChange={effort => editLocal(value => { value.tasks[task.id] = { ...value.tasks[task.id], reasoningEffort: effort }; })} />}</div>)}
      <VoiceRows config={config} voice={props.voice} mic={props.mic} recent={local.recentModels} remember={remember} saveVoice={(kind, value) => { if (props.voice?.[kind]?.set) { props.voice[kind]!.set!(value); render(n => n + 1); } else save(config => setVoiceConfig(config, kind, value)); }} />
    </div>}{typeof props.extraSections === 'function' ? props.extraSections(tab) : props.extraSections}
  </section>;
  return <LocalContext.Provider value={local}>{props.onClose ? <div class="modal-layer settings-layer mistai-settings-layer" onPointerDown={event => { overlayPressStarted.current = event.target === event.currentTarget; }} onClick={event => { const close = overlayPressStarted.current && event.target === event.currentTarget; overlayPressStarted.current = false; if (close) props.onClose?.(); }}>{content}</div> : content}</LocalContext.Provider>;
}
