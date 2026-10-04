import { createPortal } from 'preact/compat'
import type { JSX } from 'preact'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { useSettingsI18n } from './i18n.js'
import type { LlmProviderV1, ModelRefV1 } from '../llm-config.js'
import { roomConsumer, type ConsumerStatus } from '../rooms.js'
import { isNetworkProviderBaseUrl, NETWORK_VOICE_AUTO_MODEL, roomIdFromBaseUrl } from '../llm-config.js'
import { modelFetchStatus, revalidateProviderModels } from '../model-catalog.js'
import { useModelFetchStatus } from './hooks.js'
import { ChevronDown } from './icons.js'
import { usePopoverMotion } from './SettingsMotion.js'
import { TwoPaneModelPicker } from './TwoPaneModelPicker.js'
export function sameModel(a?: ModelRefV1, b?: ModelRefV1) { return !!a && !!b && a.providerId === b.providerId && a.model === b.model }
export function modelKey(ref: ModelRefV1) { return JSON.stringify([ref.providerId, ref.model]) }
export function matchesModelQuery(ref: ModelRefV1, provider: LlmProviderV1, query: string) {
  return query.toLowerCase().trim().split(/\s+/).filter(Boolean).every(token => `${ref.model} ${provider.label}`.toLowerCase().includes(token))
}
export function useLiveModels(providers: LlmProviderV1[]) {
  const [statuses, setStatuses] = useState<Record<string, ConsumerStatus>>({})
  const key = providers.filter(p => p.enabled !== false && isNetworkProviderBaseUrl(p.baseUrl)).map(p => `${p.id}:${p.baseUrl}`).join('|')
  useEffect(() => {
    const stops = providers.filter(p => p.enabled !== false && isNetworkProviderBaseUrl(p.baseUrl)).map(p => {
      const client = roomConsumer(roomIdFromBaseUrl(p.baseUrl))
      setStatuses(s => ({ ...s, [p.id]: client.status }))
      return client.onStatusChange(status => setStatuses(s => ({ ...s, [p.id]: status })))
    })
    return () => stops.forEach(stop => stop())
  }, [key])
  return statuses
}
type Props = {
  providers: LlmProviderV1[]; value?: ModelRefV1; inheritedValue?: ModelRefV1; recent: ModelRefV1[]; onChange: (ref?: ModelRefV1) => void;
  label: string; name?: string; clearLabel?: string; voice?: boolean; shared?: ModelRefV1[]; onToggle?: (ref: ModelRefV1) => void;
}
export function ModelPicker(props: Props) {
  return props.onToggle ? <ChecklistPicker {...props} /> : <TwoPaneModelPicker {...props} />
}
function ChecklistPicker({ providers, value, inheritedValue, recent, onChange, label, clearLabel, voice, shared, onToggle }: Props) {
  const { t, getUiLanguage } = useSettingsI18n()
  const pickerId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const checklist = !!onToggle
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const present = usePopoverMotion(open, menu)
  const trigger = useRef<HTMLButtonElement>(null)
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0, maxHeight: 380, up: false })
  function close() { setOpen(false); trigger.current?.focus({ preventScroll: true }) }
  useLayoutEffect(() => {
    if (!present || checklist) return
    const reposition = () => {
      if (!trigger.current || !menu.current) return
      const rect = trigger.current.getBoundingClientRect()
      const below = Math.max(0, innerHeight - rect.bottom - 16)
      const above = Math.max(0, rect.top - 16)
      const desired = Math.min(380, menu.current.scrollHeight)
      const up = below < desired && above > below
      const width = Math.min(innerWidth - 24, Math.max(rect.width, 360))
      const next = { top: up ? rect.top - 8 : rect.bottom + 8, left: Math.max(12, Math.min(rect.left, innerWidth - width - 12)), width, maxHeight: Math.min(380, up ? above : below), up }
      setPosition(previous => Object.keys(next).every(key => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next)
    }
    reposition()
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    const observer = new ResizeObserver(reposition)
    if (trigger.current) observer.observe(trigger.current)
    if (menu.current) observer.observe(menu.current)
    return () => { window.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', reposition); observer.disconnect() }
  }, [present, checklist])
  const statuses = useLiveModels(providers)
  useModelFetchStatus()
  useEffect(() => { if (open || checklist) void revalidateProviderModels() }, [open, checklist])
  const enabled = providers.filter(p => p.enabled !== false && (!checklist || !isNetworkProviderBaseUrl(p.baseUrl)))
  const matches = (ref: ModelRefV1) => {
    const provider = enabled.find(p => p.id === ref.providerId)
    return provider && matchesModelQuery(ref, provider, query)
  }
  type Entry = { ref?: ModelRefV1; text: string; section: string; group?: string; dim?: boolean }
  const entries: Entry[] = []
  const seen = new Set<string>()
  const append = (entry: Entry) => {
    if (entry.ref) {
      const key = modelKey(entry.ref)
      if (seen.has(key)) return
      seen.add(key)
    }
    entries.push(entry)
  }
  const describe = (ref: ModelRefV1) => `${ref.model} · ${providers.find(p => p.id === ref.providerId)?.label ?? ref.providerId}`
  if (!checklist && clearLabel) entries.push({ text: clearLabel, section: '' })
  const assigned = value ?? inheritedValue
  if (!checklist && !query.trim()) {
    for (const ref of [...(assigned ? [assigned] : []), ...recent]) {
      // The voice "room auto" sentinel is shared in recents but is not a chat model.
      if (!voice && ref.model === NETWORK_VOICE_AUTO_MODEL) continue
      if (!matches(ref) || seen.has(modelKey(ref))) continue
      const provider = enabled.find(p => p.id === ref.providerId)
      if (!provider) continue
      const room = isNetworkProviderBaseUrl(provider.baseUrl)
      const status = statuses[provider.id]
      append({ ref, text: voice && room && ref.model === NETWORK_VOICE_AUTO_MODEL ? t('models-auto', { provider: provider.label }) : describe(ref), section: t('models-recent'), group: 'recent', dim: room && ref.model !== NETWORK_VOICE_AUTO_MODEL && !(status?.phase === 'connected' && status.models?.includes(ref.model)) })
      if (seen.size === 8) break
    }
  }
  enabled.forEach(provider => {
    const room = isNetworkProviderBaseUrl(provider.baseUrl)
    const status = statuses[provider.id]
    const live = status?.phase === 'connected' ? status.models ?? [] : []
    const fetchStatus = modelFetchStatus(provider)
    const state = fetchStatus?.phase === 'fetching' ? t('models-fetching') : fetchStatus?.phase === 'error' ? t('models-fetch-failed') : room ? t(status?.phase === 'connected' ? 'models-live' : 'models-cache') : provider.modelsFetchedAt ? t('models-ok', { count: provider.models?.length ?? 0 }) : t('models-cache')
    const section = `${provider.label} · ${room ? t('connection-room') : 'HTTP'} · ${state}`
    const auto = { providerId: provider.id, model: NETWORK_VOICE_AUTO_MODEL }
    if (voice && room && matches(auto)) {
      append({ ref: auto, text: t('models-auto', { provider: provider.label }), section, group: provider.id })
    }
    const known = [...new Set([...live, ...(provider.models ?? []), ...(checklist ? shared ?? [] : [...(assigned ? [assigned] : []), ...recent]).filter(ref => ref.providerId === provider.id).map(ref => ref.model)])]
    if (checklist) known.sort((a, b) => Number(shared?.some(ref => sameModel(ref, { providerId: provider.id, model: b }))) - Number(shared?.some(ref => sameModel(ref, { providerId: provider.id, model: a }))))
    known.filter(model => (voice || model !== NETWORK_VOICE_AUTO_MODEL) && matches({ providerId: provider.id, model })).forEach(model => {
      append({ ref: { providerId: provider.id, model }, text: model, section, group: provider.id, dim: room && !live.includes(model) })
    })
  })
  useEffect(() => { setActive(0) }, [query])
  const activeIndex = Math.min(active, Math.max(0, entries.length - 1))
  useEffect(() => {
    if (!open) return
    input.current?.focus({ preventScroll: true })
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) {
        setOpen(false)
        // Return focus after the outside press's default focus action.
        requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }))
      }
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  useEffect(() => {
    const list = menu.current?.querySelector<HTMLElement>('.model-picker-results')
    const option = list?.querySelector<HTMLElement>('[data-active="true"]')
    if (!list || !option) return
    const bounds = list.getBoundingClientRect()
    const row = option.getBoundingClientRect()
    const header = Array.from(list.querySelectorAll<HTMLElement>('.model-picker-group')).filter(group => group.compareDocumentPosition(option) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1)
    const visibleTop = bounds.top + (header?.offsetHeight ?? 0)
    if (row.top < visibleTop) list.scrollTop -= visibleTop - row.top
    if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom
  }, [activeIndex, open, query, position])
  function choose(entry: Entry) {
    if (checklist && entry.ref) onToggle?.(entry.ref)
    else { onChange(entry.ref); close() }
  }
  const provider = assigned && providers.find(p => p.id === assigned.providerId)
  const warning = assigned && (!provider ? t('models-missing') : provider.enabled === false ? t('models-disabled') : '')
  const shown = value ? value.model === NETWORK_VOICE_AUTO_MODEL ? t('models-auto', { provider: provider?.label ?? value.providerId }) : describe(value) : inheritedValue ? `${clearLabel} · ${describe(inheritedValue)}` : clearLabel ?? t('models-empty')
  function onKeyDown(event: JSX.TargetedKeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') { event.stopPropagation(); close() }
    if (!(open || checklist)) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(n => Math.max(0, Math.min(entries.length - 1, Math.min(n, Math.max(0, entries.length - 1)) + (event.key === 'ArrowDown' ? 1 : -1)))) }
    if (event.key === 'Enter' && entries[activeIndex]) { event.preventDefault(); choose(entries[activeIndex]) }
  }
  const list = <div ref={menu} class={`model-picker-menu ${checklist ? '' : 'model-picker-overlay'}`} inert={!open && !checklist} data-placement={position.up ? 'up' : 'down'} style={checklist ? undefined : { top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight, transform: position.up ? 'translateY(-100%)' : undefined }} onKeyDown={onKeyDown}>
      <input ref={input} aria-label={t('models-search')} placeholder={t('models-search')} value={query} onInput={event => setQuery(event.currentTarget.value)} role="combobox" aria-expanded="true" aria-controls={`model-options-${pickerId}`} aria-activedescendant={entries.length ? `model-option-${pickerId}-${activeIndex}` : undefined} />
      <div class="model-picker-results" id={`model-options-${pickerId}`} role="listbox" aria-multiselectable={checklist}>
        {entries.map((entry, i) => <div key={entry.ref ? modelKey(entry.ref) : 'clear'}>
          {entry.section && entry.group !== entries[i - 1]?.group && <div class="model-picker-group">{entry.section}</div>}
          <button type="button" id={`model-option-${pickerId}-${i}`} role="option" aria-selected={checklist ? !!shared?.some(ref => sameModel(ref, entry.ref)) : entry.ref ? sameModel(assigned, entry.ref) : !value} data-provider-id={entry.ref?.providerId} data-model={entry.ref?.model} data-active={activeIndex === i} class={`model-picker-option ${entry.dim ? 'cached' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => choose(entry)}>
            {checklist ? <span class="model-check" aria-hidden="true">{shared?.some(ref => sameModel(ref, entry.ref)) ? '☑' : '☐'}</span> : sameModel(assigned, entry.ref) && <span class="model-check" aria-hidden="true">✓</span>}<span class="model-option-text">{entry.text}</span>
            {!checklist && !!query.trim() && recent.some(ref => sameModel(ref, entry.ref)) && <span class="model-recent-mark">{t('models-recent')}</span>}
          </button>
        </div>)}
        {!entries.length && <p class="hint">{t('models-empty')}</p>}
      </div>
    </div>
  return <div class={`model-picker ${checklist ? 'model-checklist' : ''}`} ref={root}>
    {!checklist && <button ref={trigger} type="button" class="model-picker-trigger" aria-label={label} title={shown} aria-expanded={open} onKeyDown={onKeyDown} onClick={() => { setOpen(!open); setQuery(''); setActive(0) }}><span class="model-trigger-text">{assigned && assigned.model !== NETWORK_VOICE_AUTO_MODEL ? `${!value ? `${clearLabel} · ` : ''}${assigned.model}` : shown}</span>{assigned && assigned.model !== NETWORK_VOICE_AUTO_MODEL && <span class="model-trigger-provider">· {provider?.label ?? assigned.providerId}</span>}<ChevronDown size={16} class="picker-chevron" /></button>}
    {warning && <p class="model-warning" role="status">{warning}</p>}
    {(present || checklist) && (checklist ? list : createPortal(list, document.body))}
  </div>
}
