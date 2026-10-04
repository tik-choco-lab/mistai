import type { JSX } from 'preact';
type Props = { size?: number; class?: string };
function Icon({ size = 16, class: className, children }: Props & { children: JSX.Element | JSX.Element[] }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class={className} aria-hidden="true">{children}</svg>;
}
export const ChevronDown = (props: Props) => <Icon {...props}><path d="m6 9 6 6 6-6" /></Icon>;
export const Check = (props: Props) => <Icon {...props}><path d="m20 6-11 11-5-5" /></Icon>;
export const Copy = (props: Props) => <Icon {...props}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></Icon>;
export const X = (props: Props) => <Icon {...props}><path d="m18 6-12 12M6 6l12 12" /></Icon>;
