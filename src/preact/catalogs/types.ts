export type UiLanguage = 'en' | 'ja' | 'zh-CN' | 'zh-TW'

export type MessageTable = Record<string, string>

/** One area's messages: same keys in every language, en is the fallback. */
export type MessageBundle<Key extends string> = Record<UiLanguage, Record<Key, string>>

/** Infer keys from English; every built-in locale must have exactly those keys. */
export function defineMessages<const T extends MessageTable>(
  messages: { en: T } & Omit<MessageBundle<keyof NoInfer<T> & string>, 'en'>,
) {
  return messages
}
