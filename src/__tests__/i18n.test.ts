import { expect, it } from 'vitest';
import { LLM_SETTINGS_MESSAGES } from '../preact/i18n.js';
const placeholders=(text:string)=>[...text.matchAll(/\{([^}]+)\}/g)].map(m=>m[1]).sort();
for(const [locale,table] of Object.entries(LLM_SETTINGS_MESSAGES)) it(`${locale}: complete nonempty catalog, no orphan keys, matching placeholders`,()=>{
  expect(Object.keys(table).sort()).toEqual(Object.keys(LLM_SETTINGS_MESSAGES.en).sort());
  for(const [key,value] of Object.entries(table)){expect(value.trim(),`${locale}.${key}`).not.toBe('');expect(placeholders(value),`${locale}.${key}`).toEqual(placeholders(LLM_SETTINGS_MESSAGES.en[key as keyof typeof table]));}
});
