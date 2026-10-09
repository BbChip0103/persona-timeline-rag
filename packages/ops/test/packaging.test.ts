import { readFileSync } from 'node:fs';
import { join } from 'node:path';

//  (O5 acceptance 4): the image never carries private configuration, research data or reports.
const ROOT=join(__dirname,'..','..','..');

test('.dockerignore keeps secrets, private data and local build state out of the image',()=>{
  const entries=readFileSync(join(ROOT,'.dockerignore'),'utf8').split('\n').map(line=>line.trim()).filter(line=>line&&!line.startsWith('#'));
  for(const entry of ['.env*','**/.env*','data','reports','accounts','**/*.private.md','**/node_modules','**/.next','.git']) expect(entries).toContain(entry);
  // A re-include ("!…") could bring one of them back.
  expect(entries.filter(entry=>entry.startsWith('!'))).toEqual([]);
});
