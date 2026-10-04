import type { ConsumerStatus } from '../index.js'
import { createPortal } from 'preact/compat'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { useSettingsI18n } from './i18n.js'
import { useModelFetchStatus } from './hooks.js'
import type { LlmProviderV1 } from '../llm-config.js'
import { isNetworkProviderBaseUrl } from '../llm-config.js'
import { modelFetchStatus } from '../model-catalog.js'
import { useRoomProviderResult } from './room-providers.js'
import { usePopoverMotion } from './SettingsMotion.js'

export function ProviderStatus({ provider, status, updatedAt, provide }: { provider: LlmProviderV1; status: ConsumerStatus; updatedAt: number; provide: boolean }) {
  const { t, getUiLanguage } = useSettingsI18n()
  useModelFetchStatus()
  const result = useRoomProviderResult(provider.id)
  const room = isNetworkProviderBaseUrl(provider.baseUrl)
  const disabled = provider.enabled === false
  const fetch = modelFetchStatus(provider)
  const state = disabled ? 'offline' : room ? status.phase === 'connected' ? 'connected' : status.phase === 'error' ? 'error' : status.phase === 'idle' ? 'offline' : 'searching' : fetch?.phase === 'error' ? 'error' : fetch?.phase === 'fetching' ? 'searching' : provider.modelsFetchedAt ? 'connected' : 'offline'
  const text = disabled ? t('models-disabled') : room ? t(`connection-phase-${status.phase}`) : fetch?.phase === 'fetching' ? t('models-fetching') : fetch?.phase === 'error' ? t('models-fetch-error') : provider.modelsFetchedAt ? t('models-ok', { count: provider.models?.length ?? 0 }) : t('models-count', { count: provider.models?.length ?? 0 })
  const providing = !disabled && provide && result?.status === 'connected'
  const peers = provide ? result?.peers.length ?? 0 : status.phase === 'connected' ? status.providers.length : 0
  const timestamp = room ? updatedAt : Date.parse(provider.modelsFetchedAt ?? '')
  const error = disabled ? '' : room ? [status.phase === 'error' ? status.message : '', provide ? result?.errorMessage : ''].filter(Boolean).join(' · ') : fetch?.error
  const details = [text, room ? t('sharing-peers', { count: peers }) : '', room ? t(providing ? 'sharing-providing' : 'sharing-stopped') : '', timestamp ? t('connection-updated', { time: new Date(timestamp).toLocaleString(getUiLanguage()) }) : '', error].filter(Boolean)
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(false)
  const [hovered, setHovered] = useState(false)
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>()
  const open = pinned || hovered
  const present = usePopoverMotion(open, menu)
  const [position, setPosition] = useState({ top: 0, left: 0, up: false, maxHeight: 320 })
  function close() { clearTimeout(leaveTimer.current); setPinned(false); setHovered(false) }
  function enter() {
    clearTimeout(leaveTimer.current)
    if (matchMedia('(min-width: 481px) and (hover: hover)').matches) setHovered(true)
  }
  function leave() { leaveTimer.current = setTimeout(() => setHovered(false), 120) }
  useEffect(() => () => clearTimeout(leaveTimer.current), [])
  useLayoutEffect(() => {
    if (!present) return
    const reposition = () => {
      if (!trigger.current || !menu.current) return
      const rect = trigger.current.getBoundingClientRect()
      const below = innerHeight - rect.bottom - 20
      const above = rect.top - 20
      const up = below < menu.current.scrollHeight && above > below
      setPosition({ top: up ? rect.top - 8 : rect.bottom + 8, left: Math.max(12, Math.min(rect.right - menu.current.offsetWidth, innerWidth - menu.current.offsetWidth - 12)), up, maxHeight: Math.max(0, up ? above : below) })
    }
    reposition()
    const observer = new ResizeObserver(reposition)
    if (menu.current) observer.observe(menu.current)
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => { observer.disconnect(); window.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', reposition) }
  }, [present])
  useEffect(() => {
    if (!open) return
    // Close at press origin, so dragging a selection out of the portal stays open.
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); trigger.current?.focus({ preventScroll: true }) } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true) }
  }, [open])
  return <span class={room ? 'room-header-status' : 'http-header-status'}>
    <button ref={trigger} type="button" class="provider-status-trigger" data-state={state} data-providing={providing} data-fetch-state={room ? undefined : disabled ? 'disabled' : fetch?.phase ?? (provider.modelsFetchedAt ? 'ok' : 'cache')} aria-label={`${provider.label || provider.baseUrl}: ${text}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={`provider-status-${id}`} title={details.join(' · ')} onMouseEnter={enter} onMouseLeave={leave} onClick={() => pinned ? close() : setPinned(true)}>
      <span class="provider-status-dot" aria-hidden="true" /><span class="provider-status-text">{text}</span>
    </button>
    {present && createPortal(<div ref={menu} id={`provider-status-${id}`} class="mistai-surface provider-status-popover model-picker-overlay" role="dialog" aria-label={`${provider.label || provider.baseUrl}: ${text}`} data-placement={position.up ? 'up' : 'down'} inert={!open} style={{ top: position.top, left: position.left, maxHeight: position.maxHeight, transform: position.up ? 'translateY(-100%)' : undefined }} onMouseEnter={enter} onMouseLeave={leave}>
      <strong>{provider.label || provider.baseUrl}</strong>{details.map((detail, index) => <p key={index} class={detail === error ? 'provider-status-error' : ''}>{detail}</p>)}
    </div>, document.body)}
  </span>
}
