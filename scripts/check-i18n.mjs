import { LLM_SETTINGS_MESSAGES } from '../dist/preact/i18n.js';
const reference=LLM_SETTINGS_MESSAGES.en;
const placeholders=value=>[...value.matchAll(/\{([^{}]+)\}/g)].map(match=>match[1]).sort().join('|');
const errors=[];
for(const locale of ['en','ja','zh-CN','zh-TW']){
  const table=LLM_SETTINGS_MESSAGES[locale];
  for(const [key,value] of Object.entries(reference)){
    if(typeof table[key]!=='string'||!table[key].trim())errors.push(locale+': missing/empty '+key);
    else if(placeholders(table[key])!==placeholders(value))errors.push(locale+': placeholders differ for '+key);
  }
  for(const key of Object.keys(table))if(!Object.hasOwn(reference,key))errors.push(locale+': orphan '+key);
}
if(errors.length)throw new Error(errors.join('\n'));
console.log('i18n complete: '+Object.keys(reference).length+' keys; en, ja, zh-CN, zh-TW');
