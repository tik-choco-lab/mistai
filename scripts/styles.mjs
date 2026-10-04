import fs from 'node:fs';
const file='src/preact/ui.css';
const original=fs.readFileSync(file,'utf8');
const marker=original.indexOf(' * Settings UI');
const end=marker>=0?original.lastIndexOf('/*',marker):original.indexOf('/* v0.9.0 provider/room settings.');
const keep=original.slice(0,end);
const source=fs.readFileSync('src/preact/reference.css','utf8');
// Scope the prototype's selectors; leave keyframe selectors and at-rules intact.
const scoped=source.replace(/\/\*[\s\S]*?\*\//g,'').replace(/([^{}]+)\{/g,(all,header)=>{
  const s=header.trim();
  if(s.startsWith('@') || /^(from|to|[\d.% ,]+)$/.test(s)) return all;
  return '\n'+s.split(',').flatMap(selector=>{const sel=selector.trim();return [':where(.mistai-surface,.mistai-settings-layer) '+sel,':where(.mistai-surface,.mistai-settings-layer):is('+sel+')'];}).join(',\n')+' {';
});
const defaults={surface:'#ffffff','surface-2':'#f4f6f9',border:'#e0e4ea','border-strong':'#cdd3dc',text:'#263244','text-strong':'#0f172a','text-muted':'#64748b',primary:'#0d9488','primary-soft':'rgba(13,148,136,.1)',focus:'#0d9488','focus-ring':'rgba(13,148,136,.2)','danger-text':'#b91c1c',success:'#15803d',warning:'#b45309','radius-s':'8px','radius-m':'12px','radius-l':'16px','shadow-1':'0 1px 3px rgba(16,24,40,.1)','shadow-2':'0 4px 12px rgba(16,24,40,.08)','shadow-3':'0 12px 32px rgba(16,24,40,.12)','shadow-menu':'0 18px 42px rgba(15,23,42,.16)','motion-fast':'120ms','motion-base':'200ms','ease-out':'cubic-bezier(.2,.8,.2,1)'};
const base=`
/* v0.9.0 provider/room settings. --mistai-* can be set on the host parent. */
.mistai-surface { ${Object.entries(defaults).map(([k,v])=>'--'+k+':var(--mistai-'+k+','+v+');').join('\n')} font-family:var(--mistai-font-family,Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif);line-height:1.5;color:var(--text);font-size:14px; }
.mistai-surface,.mistai-surface * { box-sizing:border-box; }
.mistai-surface button,.mistai-surface input,.mistai-surface select { letter-spacing:0; }
.mistai-surface input,.mistai-surface select { min-height:42px;padding:0 12px;border:1px solid var(--border);border-radius:var(--radius-s);background:var(--surface);color:var(--text);font-size:13px;font-family:inherit; }
.mistai-surface input:focus,.mistai-surface select:focus { border-color:var(--focus);box-shadow:0 0 0 3px var(--focus-ring);outline:none; }
.mistai-settings .ui-language-row {display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-muted);}
.mistai-settings .ui-language-row select {margin-left:auto;width:37%;}
.mistai-surface .settings-tab-bar {margin:-4px 0 0;}
.mistai-surface .settings-tab-bar button {font-size:13px;line-height:15px;}
@media(max-width:600px){.mistai-settings .ui-language-row select{width:auto;flex:1;min-width:0;}}
.mistai-surface :focus-visible { outline:2px solid var(--focus);outline-offset:2px; }
.mistai-settings-layer { position:fixed;inset:0;z-index:20;display:grid;place-items:center;align-items:start;padding:20px;padding-top:min(10vh,80px);background:rgba(8,12,20,.5);backdrop-filter:blur(2px); }
.mistai-settings {display:flex;flex-direction:column;gap:18px;padding:22px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius-l);background:var(--surface);box-shadow:var(--shadow-3); }
.mistai-settings .modal-heading { display:flex;align-items:center;justify-content:space-between;gap:14px; }
.mistai-settings h2 { margin:0;color:var(--text-strong);font-size:16px; }
.mistai-settings .icon-button {display:inline-flex;align-items:center;justify-content:center;width:42px;height:42px;padding:0;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text-muted);cursor:pointer;}
.mistai-surface .hint {color:var(--text-muted);font-size:12px;}
.mistai-surface .link-button {padding:0;border:0;background:none;color:var(--focus);text-decoration:underline;cursor:pointer;font:inherit;}
.mistai-surface .provider-field-control {min-width:0;display:grid;gap:4px;}
.mistai-surface .provider-field-saved {color:var(--success);font-size:11px;}
`;
fs.writeFileSync(file,(keep+base+scoped+'\n@media (prefers-reduced-motion: reduce) { .mistai-surface *, .mistai-surface *::before, .mistai-surface *::after { animation:none!important; transition:none!important; } }\n').replace(/[ \t]+$/gm,''));
