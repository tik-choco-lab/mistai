import { ChevronDown } from './icons.js'
import { createPortal } from 'preact/compat'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { useSettingsI18n } from './i18n.js'
import type { LlmProviderV1 } from '../llm-config.js'
import { isNetworkProviderBaseUrl, networkProviderBaseUrl, roomIdFromBaseUrl } from '../llm-config.js'
import { motionOptions, reducedMotion, usePopoverMotion } from './SettingsMotion.js'

let lastKind: 'http' | 'room' = 'http'
export function focusProviderCard(id: string) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const card = document.querySelector<HTMLElement>(`[data-provider-id="${CSS.escape(id)}"].provider-card`)
    card?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'instant' : 'smooth' })
    window.dispatchEvent(new CustomEvent('mistai-focus-provider', { detail: id }))
  }))
}
type Props = {
  providers: LlmProviderV1[]; roomOnly?: boolean; availableRooms?: LlmProviderV1[];
  onAddProvider: (label: string, patch?: Partial<Omit<LlmProviderV1, 'id'>>) => string;
  onUpdateProvider: (id: string, patch: Partial<Omit<LlmProviderV1, 'id'>>) => void;
  onSelectRoom?: (id: string) => void;
}
export function AddConnectionPopup({ providers, roomOnly, availableRooms, onAddProvider, onUpdateProvider, onSelectRoom }: Props) {
  const { t, getUiLanguage } = useSettingsI18n()
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<'http' | 'room'>(roomOnly ? 'room' : lastKind)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [roomId, setRoomId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState('')
  const [duplicate, setDuplicate] = useState<LlmProviderV1>()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const fields = useRef<HTMLDivElement>(null)
  const previousHeight = useRef<number>()
  const present = usePopoverMotion(open, menu)
  const [position, setPosition] = useState({ top: 0, left: 16, width: 400, maxHeight: 500, up: false, sheet: false })
  function close() { setOpen(false); trigger.current?.focus({ preventScroll: true }) }
  function selectExisting(p: LlmProviderV1) {
    if (p.enabled === false) onUpdateProvider(p.id, { enabled: true })
    if (roomOnly) onSelectRoom?.(p.id)
    else focusProviderCard(p.id)
    close()
  }
  useLayoutEffect(() => {
    if (!present) return
    const reposition = () => {
      const r = trigger.current?.getBoundingClientRect(), m = menu.current
      if (!r || !m) return
      const sheet = innerWidth < 520, width = Math.min(400, innerWidth - 32)
      const above = Math.max(0, r.top - 16), below = Math.max(0, innerHeight - r.bottom - 16)
      const up = below < m.scrollHeight && above > below
      const next = { top: sheet ? innerHeight / 2 : up ? r.top - 8 : r.bottom + 8, left: sheet ? (innerWidth - width) / 2 : Math.max(16, Math.min(r.right - width, innerWidth - width - 16)), width, maxHeight: sheet ? innerHeight - 32 : Math.max(above, below), up: !sheet && up, sheet }
      setPosition(old => JSON.stringify(old) === JSON.stringify(next) ? old : next)
    }
    reposition(); window.addEventListener('scroll', reposition, true); window.addEventListener('resize', reposition)
    const observer = new ResizeObserver(reposition)
    if (menu.current) observer.observe(menu.current)
    return () => { observer.disconnect(); window.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', reposition) }
  }, [present])
  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLInputElement>('.connection-name')?.focus({ preventScroll: true })
    // Only pointerdown outside closes: releasing a selection/drag outside is safe.
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) { setOpen(false); requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true })) }
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, present])
  useLayoutEffect(() => {
    const element = fields.current, from = previousHeight.current
    previousHeight.current = undefined
    if (!element || from === undefined || reducedMotion()) return
    const animation = element.animate([{ height: `${from}px`, opacity: .25 }, { height: `${element.scrollHeight}px`, opacity: 1 }], motionOptions(element))
    return () => animation.cancel()
  }, [kind])
  function submit() {
    setError(''); setDuplicate(undefined)
    if (kind === 'http') {
      try { const parsed = new URL(url.trim()); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error() }
      catch { setError(t('connection-url-invalid')); return }
    } else {
      if (!roomId.trim()) { setError(t('connection-room-required')); return }
      const existing = providers.find(p => isNetworkProviderBaseUrl(p.baseUrl) && roomIdFromBaseUrl(p.baseUrl) === roomId.trim())
      if (existing) { setDuplicate(existing); setError(t('connection-room-duplicate')); return }
    }
    const address = kind === 'room' ? roomId.trim() : url.trim()
    const id = onAddProvider(name.trim() || address, { baseUrl: kind === 'room' ? networkProviderBaseUrl(address) : address, apiKey: kind === 'room' ? '' : apiKey, enabled: true, models: [] })
    if (roomOnly) onSelectRoom?.(id)
    else focusProviderCard(id)
    close(); setName(''); setUrl(''); setRoomId(''); setApiKey('')
  }
  return <>
    <button ref={trigger} type="button" class={roomOnly ? 'sharing-add-room' : 'connection-add-button'} aria-expanded={open} aria-haspopup="dialog" onClick={() => { if (open) close(); else { setKind(roomOnly ? 'room' : lastKind); setError(''); setDuplicate(undefined); setOpen(true) } }}>{t(roomOnly ? 'room-add' : 'connection-add')}<ChevronDown size={16} class="picker-chevron" /></button>
    {present && createPortal(<div ref={menu} class={`mistai-surface connection-popup model-picker-overlay ${roomOnly ? 'sharing-add-form' : ''}`} role="dialog" aria-label={t(roomOnly ? 'room-add' : 'provider-add')} inert={!open} data-placement={position.up ? 'up' : 'down'} data-sheet={position.sheet} style={{ top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight, transform: position.sheet ? 'translateY(-50%)' : position.up ? 'translateY(-100%)' : undefined }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }}>
      {!roomOnly && <div class="connection-kind-toggle settings-tab-bar" role="tablist" aria-label={t('connection-kind')}><span class="settings-tab-highlight" style={{ transform: `translateX(${kind === 'room' ? 100 : 0}%)` }} />{(['http', 'room'] as const).map(k => <button type="button" role="tab" aria-selected={kind === k} class={kind === k ? 'active' : ''} onClick={() => { previousHeight.current = fields.current?.getBoundingClientRect().height; lastKind = k; setKind(k); setError(''); setDuplicate(undefined) }}>{k === 'http' ? 'HTTP' : t('connection-room')}</button>)}</div>}
      {roomOnly && <label>{t('room-from-connections')}<select class="sharing-existing-room" value="" onChange={event => { const p = providers.find(p => p.id === event.currentTarget.value); if (p) selectExisting(p) }}><option value="">{t('room-select')}</option>{availableRooms?.map(p => <option value={p.id}>{p.label} · {roomIdFromBaseUrl(p.baseUrl)}</option>)}</select></label>}
      <form noValidate onSubmit={event => { event.preventDefault(); submit() }} onKeyDown={event => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); submit() } }}>
        <label>{t('connection-name')}<input class={`connection-name ${roomOnly ? 'sharing-new-room-label' : ''}`} value={name} onInput={e => setName(e.currentTarget.value)} /></label>
        <div ref={fields} class="connection-fields">
          {kind === 'http' ? <><label>{t('connection-base-url')}<input class="connection-url" required aria-invalid={!!error} value={url} onInput={e => { setUrl(e.currentTarget.value); setError('') }} /></label>{error && <p class="model-warning" role="alert">{error}</p>}<label>{t('connection-api-key')}<input class="connection-api-key" type="password" value={apiKey} onInput={e => setApiKey(e.currentTarget.value)} /></label></> : <><label>{t(roomOnly ? 'room-new-id' : 'room-id')}<div class="sharing-room-id-row"><input class="sharing-new-room-id connection-room-id" required aria-invalid={!!error} value={roomId} onInput={e => { setRoomId(e.currentTarget.value); setError(''); setDuplicate(undefined) }} /><button class="sharing-random-room" type="button" onClick={() => { setRoomId(Array.from(crypto.getRandomValues(new Uint8Array(18)), byte => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[byte & 63]).join('')); setError(''); setDuplicate(undefined) }}>{t('room-random')}</button></div></label>{error && <p class="model-warning" role="alert">{error}</p>}{duplicate && <button class="connection-use-existing" type="button" onClick={() => selectExisting(duplicate)}>{t('connection-existing', { name: duplicate.label })}</button>}</>}
        </div>
        <div class="provider-card-actions"><button type="submit" class="primary-button">{t('connection-submit')}</button><button type="button" onClick={close}>{t('provider-cancel')}</button></div>
      </form>
    </div>, document.body)}
  </>
}
