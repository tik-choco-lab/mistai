import fs from 'node:fs';
import ts from 'typescript';
const entries={'@tik-choco/mistai':'src/index.ts','@tik-choco/mistai/llm-config':'src/llm-config.ts','@tik-choco/mistai/preact':'src/preact/index.ts','@tik-choco/mistai/identity':'src/identity/index.ts'};
const config=ts.readConfigFile('tsconfig.json',ts.sys.readFile);
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,'.');
const program=ts.createProgram(Object.values(entries),parsed.options),checker=program.getTypeChecker();
const version=JSON.parse(fs.readFileSync('package.json','utf8')).version;
let result='# Exported API (v'+version+')\n\nGenerated from the public entry points. `ui.css` is the stylesheet subpath.\n';
for(const [name,file] of Object.entries(entries)){
  const symbol=checker.getSymbolAtLocation(program.getSourceFile(file));
  const exports=checker.getExportsOfModule(symbol).map(item=>{const resolved=item.flags&ts.SymbolFlags.Alias?checker.getAliasedSymbol(item):item;return {name:item.name,value:!!(resolved.flags&ts.SymbolFlags.Value)};}).sort((a,b)=>a.name.localeCompare(b.name));
  result+='\n## `'+name+'`\n\n';
  for(const value of [true,false])result+='**'+(value?'Values':'Types')+'**\n\n'+exports.filter(item=>item.value===value).map(item=>'`'+item.name+'`').join(', ')+'.\n\n';
}
fs.writeFileSync('docs/exports.md',result);
