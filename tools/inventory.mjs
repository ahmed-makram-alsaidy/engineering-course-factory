import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const courses=JSON.parse(fs.readFileSync(path.join(root,'data/courses.json'),'utf8'));
const csv=fs.readFileSync(path.join(root,'data/lesson-inventory.csv'),'utf8');
// Count logical CSV rows, including correctly quoted multiline fields.
let quoted=false,rows=0;
for(let i=0;i<csv.length;i++){if(csv[i]==='"'){if(quoted&&csv[i+1]==='"'){i++;continue;}quoted=!quoted;}if(csv[i]==='\n'&&!quoted)rows++;}
if(quoted)throw new Error('Unterminated CSV field');
const total=rows-1,core=courses.reduce((n,c)=>n+c.packages,0);
if(courses.length!==28||core!==433||total!==485)throw new Error('Inventory counts do not match the published snapshot');
console.log(JSON.stringify({courses:courses.length,corePackages:core,discoveryPackages:total-core,totalPackages:total,meaning:'Prepared source packages, not completed video count'},null,2));
