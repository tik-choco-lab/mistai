import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import { modelMessages } from './catalogs/models.js';
import { settingsMessages } from './catalogs/settings.js';
import { appMessages } from './catalogs/app.js';
import type { UiLanguage } from './catalogs/types.js';
export type LlmSettingsLocale = UiLanguage;
const extras = {
  en: { 'field-saved': 'Saved', 'provider-delete-confirm': 'Delete this connection?', 'room-id-invalid': 'Enter a room ID.', 'field-invalid': 'Enter a valid HTTP or HTTPS URL.' },
  ja: { 'field-saved': '\u4fdd\u5b58\u6e08\u307f', 'provider-delete-confirm': '\u3053\u306e\u63a5\u7d9a\u5148\u3092\u524a\u9664\u3057\u307e\u3059\u304b\uff1f', 'room-id-invalid': '\u30eb\u30fc\u30e0 ID \u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002', 'field-invalid': '\u6709\u52b9\u306a HTTP / HTTPS URL \u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002' },
  'zh-CN': { 'field-saved': '\u5df2\u4fdd\u5b58', 'provider-delete-confirm': '\u5220\u9664\u6b64\u8fde\u63a5\uff1f', 'room-id-invalid': '\u8bf7\u8f93\u5165\u623f\u95f4 ID\u3002', 'field-invalid': '\u8bf7\u8f93\u5165\u6709\u6548\u7684 HTTP \u6216 HTTPS \u7f51\u5740\u3002' },
  'zh-TW': { 'field-saved': '\u5df2\u5132\u5b58', 'provider-delete-confirm': '\u522a\u9664\u6b64\u9023\u7dda\uff1f', 'room-id-invalid': '\u8acb\u8f38\u5165\u623f\u9593 ID\u3002', 'field-invalid': '\u8acb\u8f38\u5165\u6709\u6548\u7684 HTTP \u6216 HTTPS \u7db2\u5740\u3002' },
};
function catalog(locale: UiLanguage) { return { ...appMessages[locale], ...settingsMessages[locale], ...modelMessages[locale], ...extras[locale] }; }
export const LLM_SETTINGS_MESSAGES = { en: catalog('en'), ja: catalog('ja'), 'zh-CN': catalog('zh-CN'), 'zh-TW': catalog('zh-TW') };
export type LlmSettingsMessages = typeof LLM_SETTINGS_MESSAGES.en;
export const SettingsI18nContext = createContext<{ locale: UiLanguage; messages?: Partial<LlmSettingsMessages>; surface?: { current: HTMLElement | null } }>({ locale: 'en' });
export function useSettingsI18n() {
  const { locale, messages } = useContext(SettingsI18nContext);
  const table: Record<string, string | undefined> = { ...LLM_SETTINGS_MESSAGES[locale], ...messages };
  return { getUiLanguage: () => locale, t: (key: string, params: Record<string, string | number> = {}) => (table[key] ?? key).replace(/\{([^}]+)\}/g, (match, name: string) => params[name] === undefined ? match : String(params[name])) };
}
