import fs from 'node:fs';
import path from 'node:path';
import {bindReview,validateInput} from './lesson-review/contract.mjs';
import {callMeta} from './lesson-review/provider.mjs';
const args=process.argv.slice(2),i=args.indexOf('--input'),o=args.indexOf('--output');
if(i<0||!args[i+1]||o<0||!args[o+1])throw Error('Usage: node tools/review-json.mjs --input draft.json --output receipt.json [--live]');
const raw=fs.readFileSync(path.resolve(args[i+1]),'utf8');
if(raw.length>80000)throw Error('Input exceeds 80000 characters');
const input=validateInput(JSON.parse(raw)),file=path.resolve(args[o+1]);
if(fs.existsSync(file))throw Error('Output already exists; preserve evidence and choose a new name');
// Validation mode does not call a model. Neither mode executes any supplied code or commands.
if(!args.includes('--live')){console.log(JSON.stringify({valid:true,lessonId:input.lessonId,sources:input.sources.length,modelCalled:false,codeExecuted:false}));process.exit(0);}
const returned=await callMeta(input);
const record={input,rawReview:returned.review,provenance:returned.provenance};
try{record.result=bindReview(input,returned.review,returned.provenance);record.status='VALIDATED';}catch(error){record.status='REJECTED_BY_CONTRACT';record.validationError=error.message;}
fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(record,null,2)+'\n','utf8');
console.log(JSON.stringify({output:file,status:record.status,findings:record.result?.findings.length??null,approvedForPublication:false,codeExecuted:false}));
