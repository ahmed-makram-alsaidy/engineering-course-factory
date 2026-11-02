import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('../review-json.mjs',import.meta.url));
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'course-review-cli-'));t.after(()=>{for(const name of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,name));fs.rmdirSync(dir);});return {dir,input:path.join(dir,'input.json'),output:path.join(dir,'output.json')};}
const input={version:1,lessonId:'cli-example',narration:'A teaching draft.',sources:[{id:'source',text:'A supplied source.'}]};
function run(f,extra=[]){return spawnSync(process.execPath,[cli,'--input',f.input,'--output',f.output,...extra],{encoding:'utf8',timeout:5000,windowsHide:true,env:{...process.env,MODEL_API_KEY:'deliberately-invalid-test-value'}});}
test('validation mode calls no model and creates no review receipt',t=>{const f=fixture(t);fs.writeFileSync(f.input,JSON.stringify(input));const result=run(f);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).modelCalled,false);assert.equal(JSON.parse(result.stdout).codeExecuted,false);assert.equal(fs.existsSync(f.output),false);});
test('invalid evidence identities are rejected before an optional live request',t=>{const f=fixture(t);fs.writeFileSync(f.input,JSON.stringify({...input,sources:[{id:'narration',text:'Collision.'}]}));const result=run(f,['--live']);assert.notEqual(result.status,0);assert.match(result.stderr,/unique/);assert.equal(fs.existsSync(f.output),false);});
test('oversized input is rejected before parsing or a live request',t=>{const f=fixture(t);fs.writeFileSync(f.input,'x'.repeat(80001));const result=run(f,['--live']);assert.notEqual(result.status,0);assert.match(result.stderr,/80000/);});
test('an existing receipt cannot be overwritten by a live request',t=>{const f=fixture(t);fs.writeFileSync(f.input,JSON.stringify(input));fs.writeFileSync(f.output,'preserve this evidence');const result=run(f,['--live']);assert.notEqual(result.status,0);assert.match(result.stderr,/already exists/);assert.equal(fs.readFileSync(f.output,'utf8'),'preserve this evidence');});
