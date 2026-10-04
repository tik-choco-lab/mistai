import { ChevronDown, Check } from './icons.js'
import { createPortal } from 'preact/compat'
import type { JSX } from 'preact'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { reasoningEffortOptions } from './types.js'
import { useSettingsI18n } from './i18n.js'
import type { ReasoningEffort } from './types.js'
import { usePopoverMotion } from './SettingsMotion.js'

function Level({ value }: { value: ReasoningEffort }) {
  const level = reasoningEffortOptions.indexOf(value)
  return <span class="reasoning-level" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <i class={i < level ? 'filled' : ''} />)}</span>
}

export function ReasoningPicker({ value, label, onChange }: { value: ReasoningEffort; label: string; onChange: (value: ReasoningEffort) => void }) {
  const { t, getUiLanguage } = useSettingsI18n()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [active, setActiveState] = useState(0)
  const activeIndex = useRef(0)
  function setActive(index: number) { activeIndex.current = index; setActiveState(index) }
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const present = usePopoverMotion(open, menu)
  const [position, setPosition] = useState({ top: 0, left: 0, up: false, maxHeight: 320 })
  function close() { setOpen(false); trigger.current?.focus({ preventScroll: true }) }
  function show(index = reasoningEffortOptions.indexOf(value)) { setActive(index); setOpen(true) }
  function choose() { onChange(reasoningEffortOptions[activeIndex.current]); close() }
  useLayoutEffect(() => {
    if (!present) return
    const reposition = () => {
      if (!trigger.current || !menu.current) return
      const rect = trigger.current.getBoundingClientRect()
      const below = innerHeight - rect.bottom - 16
      const above = rect.top - 16
      const up = below < menu.current.scrollHeight && above > below
      setPosition({ top: up ? rect.top - 8 : rect.bottom + 8, left: Math.max(12, Math.min(rect.left, innerWidth - 232)), up, maxHeight: Math.max(0, up ? above : below) })
    }
    reposition()
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => { window.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', reposition) }
  }, [present])
  useEffect(() => {
    if (!open) return
    menu.current?.focus({ preventScroll: true })
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) {
        setOpen(false)
        requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }))
      }
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, present])
  useEffect(() => { menu.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }) }, [active, open])
  function keyboard(event: JSX.TargetedKeyboardEvent<HTMLElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape', 'Tab'].includes(event.key)) return
    if (event.key === 'Tab') { setOpen(false); return }
    event.preventDefault(); event.stopPropagation()
    if (event.key === 'Escape') { close(); return }
    if (!open) { show(event.key === 'Home' ? 0 : event.key === 'End' ? 6 : undefined); return }
    if (event.key === 'Enter' || event.key === ' ') choose()
    else setActive(event.key === 'Home' ? 0 : event.key === 'End' ? 6 : Math.max(0, Math.min(6, activeIndex.current + (event.key === 'ArrowDown' ? 1 : -1))))
  }
  return <div class="reasoning-picker">
    <button ref={trigger} type="button" class="model-picker-trigger reasoning-trigger" aria-label={label} data-tip={t('models-effort')} aria-haspopup="listbox" aria-expanded={open} aria-controls={`reasoning-${id}`} onKeyDown={keyboard} onClick={() => open ? close() : show()}>
      <span>{t('models-reasoning')} · {t(`effort-${value}`)}</span><Level value={value} /><ChevronDown size={16} class="picker-chevron" />
    </button>
    {present && createPortal(<div ref={menu} class="mistai-surface reasoning-menu model-picker-overlay" data-placement={position.up ? 'up' : 'down'} inert={!open} role="listbox" id={`reasoning-${id}`} aria-label={t('models-effort')} aria-activedescendant={`reasoning-${id}-${active}`} tabIndex={-1} style={{ top: position.top, left: position.left, maxHeight: position.maxHeight, transform: position.up ? 'translateY(-100%)' : undefined }} onKeyDown={keyboard}>
      {reasoningEffortOptions.map((option, index) => <button type="button" tabIndex={-1} class="model-picker-option reasoning-option" role="option" id={`reasoning-${id}-${index}`} aria-selected={option === value} data-active={index === active} data-value={option} onMouseEnter={() => setActive(index)} onClick={() => { onChange(option); close() }}><span class="reasoning-check">{option === value && <Check size={14} />}</span><span class="model-option-text">{t(`effort-${option}`)}</span><Level value={option} /></button>)}
    </div>, document.body)}
  </div>
}
