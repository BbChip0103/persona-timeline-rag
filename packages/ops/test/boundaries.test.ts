import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// Packages never import from apps/: the web reads its rules from @ptr/ops/web (dependency-free: zod only).
const ROOT=join(__dirname,'..','..','..');
const walk=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true})
  .flatMap(entry=>entry.name==='node_modules'?[]:entry.isDirectory()?walk(join(dir,entry.name)):[join(dir,entry.name)]);
const imports=(file:string)=>[...readFileSync(file,'utf8').matchAll(/(?:from|import|require\()\s*['"]([^'"]+)['"]/g)].map(match=>match[1]!);

test('no package source imports from apps/',()=>{
  const offenders=walk(join(ROOT,'packages')).filter(file=>/\.tsx?$/.test(file)&&!file.includes(`${'/'}test${'/'}`))
    .flatMap(file=>imports(file).filter(spec=>/(^|\/)apps\//.test(spec)).map(spec=>`${relative(ROOT,file)} -> ${spec}`));
  expect(offenders).toEqual([]);
});
test('the web rules module imports zod only',()=>{
  expect(imports(join(ROOT,'packages/ops/src/config/web.ts'))).toEqual(['zod']);
});
