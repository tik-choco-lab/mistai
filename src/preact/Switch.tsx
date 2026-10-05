/** The one on/off control of the tik-choco settings UI. Styled by `.mistai-switch` in ui.css, which works inside or
 * outside `.mistai-surface`; use a checkbox only for picking items from a set. */
export function Switch({ checked, onChange, label, tip, disabled, className = '' }: { checked: boolean; onChange: (next: boolean) => void; label: string; tip?: string; disabled?: boolean; className?: string }) {
  return <button type="button" class={`mistai-switch settings-switch ${className}`.trim()} role="switch" aria-checked={checked} aria-label={label} data-tip={tip} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>
}
