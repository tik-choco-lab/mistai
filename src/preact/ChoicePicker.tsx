import { ChevronDown, Check } from './icons.js'
import { createPortal } from 'preact/compat'
import type { JSX } from 'preact'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { usePopoverMotion } from './SettingsMotion.js'

export function ChoicePicker({ value, label, options, onChange, className = '' }: { value: string; label: string; options: { value: string; label: string }[]; onChange: (value: string) => void; className?: string }) {
  const values = options.map(option => option.value)
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
  function show(index = values.indexOf(value)) { setActive(Math.max(0, index)); setOpen(true) }
  function choose() { if (values[activeIndex.current] !== undefined) onChange(values[activeIndex.current]); close() }
  useLayoutEffect(() => {
    if (!present) return
    const reposition = () => {
      if (!trigger.current || !menu.current) return
      const rect = trigger.current.getBoundingClientRect()
      const below = innerHeight - rect.bottom - 16
      const above = rect.top - 16
      const up = below < menu.current.scrollHeight && above > below
      setPosition({ top: up ? rect.top - 8 : rect.bottom + 8, left: Math.max(16, Math.min(rect.left, innerWidth - menu.current.getBoundingClientRect().width - 16)), up, maxHeight: Math.max(0, up ? above : below) })
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
    if (!open) { show(event.key === 'Home' ? 0 : event.key === 'End' ? values.length - 1 : undefined); return }
    if (event.key === 'Enter' || event.key === ' ') choose()
    else setActive(event.key === 'Home' ? 0 : event.key === 'End' ? values.length - 1 : Math.max(0, Math.min(values.length - 1, activeIndex.current + (event.key === 'ArrowDown' ? 1 : -1))))
  }
  return <div class={`choice-picker ${className}`}>
    <button ref={trigger} type="button" class="model-picker-trigger choice-trigger" aria-label={label} data-tip={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={`reasoning-${id}`} onKeyDown={keyboard} onClick={() => open ? close() : show()}>
      <span class="model-trigger-text">{options.find(option => option.value === value)?.label ?? value}</span><ChevronDown size={16} class="picker-chevron" />
    </button>
    {present && createPortal(<div ref={menu} class="mistai-surface choice-menu reasoning-menu model-picker-overlay" data-placement={position.up ? 'up' : 'down'} inert={!open} role="listbox" id={`reasoning-${id}`} aria-label={label} aria-activedescendant={`reasoning-${id}-${active}`} tabIndex={-1} style={{ top: position.top, left: position.left, maxHeight: position.maxHeight, transform: position.up ? 'translateY(-100%)' : undefined }} onKeyDown={keyboard}>
      {options.map((option, index) => <button type="button" tabIndex={-1} class="model-picker-option reasoning-option" role="option" id={`reasoning-${id}-${index}`} aria-selected={option.value === value} data-active={index === active} data-value={option.value} onMouseEnter={() => setActive(index)} onClick={() => { onChange(option.value); close() }}><span class="reasoning-check">{option.value === value && <Check size={14} />}</span><span class="model-option-text">{option.label}</span></button>)}
    </div>, document.body)}
  </div>
}
