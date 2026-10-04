import { Check, Copy } from './icons.js'
import { useEffect, useRef, useState } from 'preact/hooks'
import { useSettingsI18n } from './i18n.js'
import { useNetworkConsumerStatusWithTimestamp } from './hooks.js'
import type { LlmProviderV1, ModelRefV1 } from '../llm-config.js'
import { isNetworkProviderBaseUrl, roomIdFromBaseUrl } from '../llm-config.js'
import { revalidateProviderModels } from '../model-catalog.js'
import type { ProviderSettings, RoomProvide } from './types.js'
import { matchesModelQuery, sameModel } from './ModelPicker.js'
import { ModelFetchState } from './ModelFetchState.js'
import { useRoomProviderResult } from './room-providers.js'
import { useAnimatedItems } from './SettingsMotion.js'
import { AddConnectionPopup } from './AddConnectionPopup.js'

function RoomSharingChip({ room, provide, onChange }: { room: LlmProviderV1; provide: RoomProvide; onChange: (value: RoomProvide) => void }) {
  const { t, getUiLanguage } = useSettingsI18n()
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const feedbackTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(feedbackTimer.current), [])
  const result = useRoomProviderResult(room.id)
  const { status } = useNetworkConsumerStatusWithTimestamp(roomIdFromBaseUrl(room.baseUrl))
  const state = provide.enabled ? result?.status === 'connected' ? t('sharing-providing') : t('sharing-disconnected') : t('sharing-stopped')
  const peers = provide.enabled ? result?.peers.length ?? 0 : status.phase === 'connected' ? status.providers.length : 0
  return <div class="sharing-room-control"><div class="sharing-room-chip" data-room-id={room.id} data-providing={provide.enabled}><button type="button" class="sharing-room-toggle" data-room-id={room.id} aria-pressed={provide.enabled} onClick={() => onChange({ ...provide, enabled: !provide.enabled })}>
    <strong>{room.label}</strong><span aria-hidden="true">{provide.enabled ? '✓' : '○'}</span><small>{state} · {t('sharing-peers', { count: peers })}</small>
  </button><button type="button" class="sharing-room-copy" data-room-id={room.id} aria-label={t('room-copy-id')} title={t('room-copy-id')} onClick={async event => {
    event.stopPropagation()
    try { await navigator.clipboard.writeText(roomIdFromBaseUrl(room.baseUrl)); setCopied(true); setCopyFailed(false) }
    catch { setCopyFailed(true); setCopied(false) }
    clearTimeout(feedbackTimer.current)
    feedbackTimer.current = setTimeout(() => { setCopied(false); setCopyFailed(false) }, 1200)
  }}><span class={`room-copy-icon ${copied ? 'copied' : ''}`} aria-hidden="true"><Copy size={14} /><Check size={14} /></span></button></div>{(copied || copyFailed) && <small class={copied ? 'room-copy-announcement' : 'room-copy-feedback'} role="status">{t(copied ? 'room-copied' : 'room-copy-failed')}</small>}</div>
}

export function SharingPanel({ settings, onSetRoomProvide, onAddProvider, onUpdateProvider }: {
  settings: ProviderSettings; onSetRoomProvide: (id: string, value: RoomProvide) => void;
  onAddProvider: (label: string, patch?: Partial<Omit<LlmProviderV1, 'id'>>) => string;
  onUpdateProvider: (id: string, patch: Partial<Omit<LlmProviderV1, 'id'>>) => void;
}) {
  const { t, getUiLanguage } = useSettingsI18n()
  const [query, setQuery] = useState('')
  useEffect(() => { void revalidateProviderModels() }, [])
  const rooms = settings.providers.filter(p => p.enabled !== false && isNetworkProviderBaseUrl(p.baseUrl))
  const roomRows = useAnimatedItems(rooms)
  const http = settings.providers.filter(p => p.enabled !== false && !isNetworkProviderBaseUrl(p.baseUrl))
  const provideFor = (id: string) => settings.roomProvide[id] ?? { enabled: false, shared: [] }
  function selectRoom(id: string) {
    onSetRoomProvide(id, { ...provideFor(id), enabled: true })
  }
  const allShared = Object.values(settings.roomProvide).flatMap(value => value.shared)
  const isShared = (ref: ModelRefV1) => allShared.some(value => sameModel(value, ref))
  const groups = http.map(provider => {
    const models = [...new Set([...(provider.models ?? []), ...allShared.filter(ref => ref.providerId === provider.id).map(ref => ref.model)])]
    models.sort((a, b) => Number(isShared({ providerId: provider.id, model: b })) - Number(isShared({ providerId: provider.id, model: a })))
    const matches = models.filter(model => matchesModelQuery({ providerId: provider.id, model }, provider, query))
    return { provider, models: matches }
  })
  return <div class="sharing-panel" role="tabpanel">
    <div class="sharing-room-chips">{roomRows.map(({ item: room, phase }) => <div key={room.id} class={`settings-motion-item ${phase}`} inert={phase === 'leaving'}><RoomSharingChip room={room} provide={provideFor(room.id)} onChange={value => onSetRoomProvide(room.id, value)} /></div>)}<AddConnectionPopup roomOnly providers={settings.providers} availableRooms={rooms.filter(room => !provideFor(room.id).enabled)} onAddProvider={onAddProvider} onUpdateProvider={onUpdateProvider} onSelectRoom={selectRoom} /></div>
    {!rooms.length && <p class="hint">{t('sharing-no-rooms')}</p>}
    {!http.length && <p class="hint">{t('sharing-no-http')}</p>}
    {!!http.length && <>
      <input class="sharing-search" aria-label={t('models-search')} placeholder={t('models-search')} value={query} onInput={event => setQuery(event.currentTarget.value)} />
      <div class="sharing-models">
        {groups.map(({ provider, models }) => <section class="sharing-group" key={provider.id} data-provider-id={provider.id}>
          <div class="sharing-group-heading"><strong>{provider.label}</strong><span class="provider-kind">HTTP</span><ModelFetchState provider={provider} /></div>
          {models.map(model => {
            const ref = { providerId: provider.id, model }
            return <div class="sharing-model-row" key={model} data-provider-id={provider.id} data-model={model} data-shared={isShared(ref)}>
              <span class="sharing-model-name">{model}</span>
              <div class="sharing-model-chips">{rooms.map(room => {
                const provide = provideFor(room.id)
                const checked = provide.shared.some(value => sameModel(value, ref))
                return <button type="button" key={room.id} data-room-id={room.id} aria-label={`${model} · ${room.label}`} aria-pressed={checked} onClick={() => onSetRoomProvide(room.id, { ...provide, shared: checked ? provide.shared.filter(value => !sameModel(value, ref)) : [...provide.shared, ref] })}>{room.label}<span aria-hidden="true">{checked ? '✓' : '+'}</span></button>
              })}</div>
            </div>
          })}
          {!models.length && <p class="hint">{t('models-empty')}</p>}
        </section>)}
      </div>
    </>}
  </div>
}
