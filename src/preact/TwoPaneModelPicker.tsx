import { ChevronDown, Check } from './icons.js'
import { createPortal } from 'preact/compat'
import type { JSX } from 'preact'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { useSettingsI18n } from './i18n.js'
import type { LlmProviderV1, ModelRefV1 } from '../llm-config.js'
import { isNetworkProviderBaseUrl, NETWORK_VOICE_AUTO_MODEL } from '../llm-config.js'
import { modelFetchStatus, revalidateProviderModels } from '../model-catalog.js'
import { useModelFetchStatus } from './hooks.js'
import { matchesModelQuery, modelKey, sameModel, useLiveModels } from './ModelPicker.js'
import { motionOptions, reducedMotion, usePopoverMotion } from './SettingsMotion.js'

type Props = { providers: LlmProviderV1[]; value?: ModelRefV1; inheritedValue?: ModelRefV1; recent: ModelRefV1[]; onChange: (ref?: ModelRefV1) => void; label: string; name?: string; clearLabel?: string; voice?: boolean }
type Entry = { ref: ModelRefV1; text: string; provider: LlmProviderV1; dim?: boolean }
export function TwoPaneModelPicker({ providers, value, inheritedValue, recent, onChange, label, name, clearLabel, voice }: Props) {
  const { t, getUiLanguage } = useSettingsI18n()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('')
  const [narrow, setNarrow] = useState('')
  const [active, setActiveState] = useState({ pane: 'search', index: 0 })
  const cursor = useRef(active)
  function setActive(pane: string, index: number) { cursor.current = { pane, index }; setActiveState(cursor.current) }
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const left = useRef<HTMLDivElement>(null)
  const right = useRef<HTMLDivElement>(null)
  const present = usePopoverMotion(open, menu)
  const [position, setPosition] = useState({ top: 0, left: 16, width: 640, height: 420, up: false })
  const statuses = useLiveModels(providers)
  useModelFetchStatus()
  const enabled = providers.filter(p => p.enabled !== false)
  const assigned = value ?? inheritedValue
  const provider = providers.find(p => p.id === assigned?.providerId)
  const searching = !!query.trim()
  const describe = (ref: ModelRefV1) => ref.model === NETWORK_VOICE_AUTO_MODEL ? t('models-auto', { provider: providers.find(p => p.id === ref.providerId)?.label ?? ref.providerId }) : ref.model
  function entry(ref: ModelRefV1, p: LlmProviderV1): Entry {
    const room = isNetworkProviderBaseUrl(p.baseUrl)
    const status = statuses[p.id]
    const live = status?.phase === 'connected' ? status.models ?? [] : []
    return { ref, provider: p, text: describe(ref), dim: room && ref.model !== NETWORK_VOICE_AUTO_MODEL && !live.includes(ref.model) }
  }
  const recents: Entry[] = []
  const seen = new Set<string>()
  for (const ref of [...(assigned ? [assigned] : []), ...recent]) {
    const p = enabled.find(p => p.id === ref.providerId)
    if (!p || (!voice && ref.model === NETWORK_VOICE_AUTO_MODEL) || seen.has(modelKey(ref))) continue
    seen.add(modelKey(ref)); recents.push(entry(ref, p))
    if (recents.length === 8) break
  }
  const groups = enabled.map(p => {
    const room = isNetworkProviderBaseUrl(p.baseUrl)
    const status = statuses[p.id]
    const live = status?.phase === 'connected' ? status.models ?? [] : []
    const models = [...new Set([...(voice && room ? [NETWORK_VOICE_AUTO_MODEL] : []), ...live, ...(p.models ?? []), ...recents.filter(e => e.provider.id === p.id).map(e => e.ref.model)])].filter(m => m !== NETWORK_VOICE_AUTO_MODEL || (voice && room))
    models.sort((a, b) => Number(b === NETWORK_VOICE_AUTO_MODEL) - Number(a === NETWORK_VOICE_AUTO_MODEL) || Number(sameModel(assigned, { providerId: p.id, model: b })) - Number(sameModel(assigned, { providerId: p.id, model: a })))
    const matches = models.filter(model => matchesModelQuery({ providerId: p.id, model }, p, query)).map(model => entry({ providerId: p.id, model }, p))
    const fetch = modelFetchStatus(p)
    const state = fetch?.phase === 'fetching' ? t('models-fetching') : fetch?.phase === 'error' ? t('models-fetch-failed') : room ? t(statuses[p.id]?.phase === 'connected' ? 'models-live' : 'sharing-disconnected') : ''
    return { provider: p, matches, state, error: fetch?.error }
  })
  const sources = [
    ...(searching ? [{ id: 'all', label: t('models-all') }] : recents.length ? [{ id: 'recent', label: t('models-recent') }] : []),
    ...(clearLabel ? [{ id: 'clear', label: clearLabel }] : []),
    ...groups.map(g => ({ id: g.provider.id, label: g.provider.label, group: g })),
  ]
  const selectedSource = searching ? narrow || 'all' : source
  const entries = searching ? groups.filter(g => !narrow || g.provider.id === narrow).flatMap(g => g.matches) : source === 'recent' ? recents : groups.filter(g => g.provider.id === source).flatMap(g => g.matches)
  function close() { setOpen(false); trigger.current?.focus({ preventScroll: true }) }
  function show() {
    setQuery(''); setNarrow(''); setSource(enabled.some(p => p.id === assigned?.providerId) ? assigned!.providerId : recents.length ? 'recent' : enabled[0]?.id ?? '')
    setActive('search', 0); setOpen(true)
  }
  function switchSource(next: string) {
    if (next === 'clear') { onChange(undefined); close(); return }
    if (searching) setNarrow(next === 'all' ? '' : next)
    else setSource(next)
    setActive('left', Math.max(0, sources.findIndex(s => s.id === next)))
    left.current?.focus({ preventScroll: true })
  }
  useLayoutEffect(() => {
    if (!present) return
    const reposition = () => {
      if (!trigger.current) return
      const r = trigger.current.getBoundingClientRect()
      const below = Math.max(0, innerHeight - r.bottom - 16), above = Math.max(0, r.top - 16)
      const up = below < 420 && above > below
      const width = Math.min(innerWidth - 32, Math.max(640, r.width))
      setPosition({ top: up ? r.top - 8 : r.bottom + 8, left: Math.max(16, Math.min(r.left, innerWidth - width - 16)), width, height: Math.min(420, up ? above : below), up })
    }
    reposition(); window.addEventListener('scroll', reposition, true); window.addEventListener('resize', reposition)
    const observer = new ResizeObserver(reposition)
    if (trigger.current) observer.observe(trigger.current)
    return () => { observer.disconnect(); window.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', reposition) }
  }, [present])
  useEffect(() => {
    if (!open) return
    input.current?.focus({ preventScroll: true }); void revalidateProviderModels()
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) { setOpen(false); requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true })) }
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, present])
  useLayoutEffect(() => {
    const list = right.current
    if (!list || !open) return
    list.scrollTop = 0
    if (!reducedMotion()) {
      const animation = list.animate([{ opacity: .25 }, { opacity: 1 }], motionOptions(list, true))
      return () => animation.cancel()
    }
  }, [source, narrow])
  useEffect(() => {
    const list = active.pane === 'left' ? left.current : right.current
    const row = list?.querySelector<HTMLElement>(active.pane === 'search' ? '[aria-selected="true"]' : '[data-active="true"]')
    if (!list || !row) return
    const a = row.getBoundingClientRect(), b = list.getBoundingClientRect()
    if (a.top < b.top) list.scrollTop -= b.top - a.top
    if (a.bottom > b.bottom) list.scrollTop += a.bottom - b.bottom
    if (a.left < b.left) list.scrollLeft -= b.left - a.left
    if (a.right > b.right) list.scrollLeft += a.right - b.right
  }, [active, open, source, position])
  function keyboard(event: JSX.TargetedKeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (!open) { if (['ArrowDown', 'Enter', ' '].includes(event.key)) { event.preventDefault(); show() }; return }
    if (event.key === 'Tab') { setOpen(false); return }
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(event.key)) return
    if (cursor.current.pane === 'search' && ['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    const current = event.target === input.current ? { pane: 'search', index: 0 } : cursor.current
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || current.pane === 'search') {
      const pane = event.key === 'ArrowLeft' ? 'left' : 'right'
      setActive(pane, pane === 'left' ? Math.max(0, sources.findIndex(s => s.id === selectedSource)) : 0)
      ;(pane === 'left' ? left : right).current?.focus({ preventScroll: true }); return
    }
    if (event.key === 'Enter') {
      if (current.pane === 'left') { const s = sources[current.index]; if (s) switchSource(s.id) }
      else if (entries[current.index]) { onChange(entries[current.index].ref); close() }
    } else setActive(current.pane, Math.max(0, Math.min((current.pane === 'left' ? sources : entries).length - 1, current.index + (event.key === 'ArrowDown' ? 1 : -1))))
  }
  const warning = assigned && (!provider ? t('models-missing') : provider.enabled === false ? t('models-disabled') : '')
  const shown = assigned ? `${!value ? `${clearLabel} · ` : ''}${describe(assigned)} · ${provider?.label ?? assigned.providerId}` : clearLabel ?? t('models-empty')
  return <div class="model-picker">
    <button ref={trigger} type="button" class="model-picker-trigger" data-picker-name={name} aria-label={label} aria-haspopup="dialog" aria-expanded={open} title={shown} onKeyDown={keyboard} onClick={() => open ? close() : show()}><span class="model-trigger-text">{assigned ? `${!value ? `${clearLabel} · ` : ''}${describe(assigned)}` : shown}</span>{assigned && <span class="model-trigger-provider">· {provider?.label ?? assigned.providerId}</span>}<ChevronDown size={16} class="picker-chevron" /></button>
    {warning && <p class="model-warning" role="status">{warning}</p>}
    {present && createPortal(<div ref={menu} class="mistai-surface model-picker-menu model-picker-overlay model-picker-two-pane" role="dialog" aria-label={label} inert={!open} data-placement={position.up ? 'up' : 'down'} style={{ top: position.top, left: position.left, width: position.width, height: position.height, transform: position.up ? 'translateY(-100%)' : undefined }} onKeyDown={keyboard}>
      <input ref={input} aria-label={t('models-search')} placeholder={t('models-search')} value={query} onFocus={() => setActive('search', 0)} onInput={e => { const next = e.currentTarget.value; if (!query.trim() || !next.trim()) setNarrow(''); setQuery(next); setActive('search', 0) }} />
      <div class="model-picker-panes">
        <div ref={left} class="model-picker-sources" role="listbox" aria-label={t('models-sources')} tabIndex={-1} onFocus={event => { if (event.target === event.currentTarget && cursor.current.pane !== 'left') setActive('left', Math.max(0, sources.findIndex(s => s.id === selectedSource))) }} aria-activedescendant={active.pane === 'left' ? `source-${id}-${active.index}` : undefined}>
          {sources.map((s, i) => { const g = 'group' in s ? s.group : undefined; return <button type="button" tabIndex={-1} role="option" id={`source-${id}-${i}`} data-source-id={s.id} aria-selected={selectedSource === s.id} data-active={active.pane === 'left' && active.index === i} class={`model-source ${searching && g && !g.matches.length ? 'zero-matches' : ''}`} title={[s.label, g?.error ?? g?.state].filter(Boolean).join(' · ')} onClick={() => switchSource(s.id)}>
            <span class="model-source-label">{s.label}</span>{g && <><span class="provider-kind">{isNetworkProviderBaseUrl(g.provider.baseUrl) ? t('connection-room') : 'HTTP'}</span><small class="model-source-count">{g.matches.length}</small>{g.state && <small class="model-source-state">{g.state}</small>}</>}
          </button> })}
        </div>
        <div ref={right} class="model-picker-results" id={`models-${id}`} role="listbox" aria-label={t('models-list')} tabIndex={-1} onFocus={event => { if (event.target === event.currentTarget && cursor.current.pane !== 'right') setActive('right', 0) }} aria-activedescendant={active.pane === 'right' && entries.length ? `model-${id}-${active.index}` : undefined}>
          {entries.map((e, i) => <div key={modelKey(e.ref)}>{searching && entries[i - 1]?.provider.id !== e.provider.id && <div class="model-picker-group">{e.provider.label} · {isNetworkProviderBaseUrl(e.provider.baseUrl) ? t('connection-room') : 'HTTP'}</div>}<button type="button" tabIndex={-1} id={`model-${id}-${i}`} role="option" aria-selected={sameModel(assigned, e.ref)} data-provider-id={e.provider.id} data-model={e.ref.model} data-active={active.pane === 'right' && active.index === i} class={`model-picker-option ${e.dim ? 'cached' : ''}`} onClick={() => { onChange(e.ref); close() }}>
            <span class="model-check">{sameModel(assigned, e.ref) && <Check size={14} />}</span><span class="model-option-text">{e.text}{!searching && source === 'recent' && <small class="model-row-provider">{e.provider.label}</small>}</span>{searching && recent.some(ref => sameModel(ref, e.ref)) && <span class="model-recent-mark">{t('models-recent')}</span>}
          </button></div>)}
          {!entries.length && <p class="hint">{t('models-empty')}</p>}
        </div>
      </div>
    </div>, document.body)}
  </div>
}
