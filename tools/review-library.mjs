import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {bindReview, digest, validateInput} from './lesson-review/contract.mjs';
import {callMeta} from './lesson-review/provider.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sample=path.join(root,'examples/review-sample');
const evidence=path.join(root,'evidence/library-review');
const args=process.argv.slice(2);
const live=args.includes('--live');
const manifest=JSON.parse(fs.readFileSync(path.join(sample,'manifest.json'),'utf8'));
if(manifest.version!==1||!Array.isArray(manifest.cases)||manifest.cases.length>12)throw Error('Invalid sample manifest');
fs.mkdirSync(evidence,{recursive:true});
const rows=[];let calls=0;
for(const item of manifest.cases){
 if(!/^[A-Za-z0-9.-]+\.json$/.test(item.file)||!/^[A-Za-z0-9.-]+$/.test(item.id))throw Error('Invalid manifest identity');
 const input=validateInput(JSON.parse(fs.readFileSync(path.join(sample,item.file),'utf8')));
 if(input.lessonId!==item.id)throw Error('Manifest / lesson identity mismatch');
 const file=path.join(evidence,item.id+'.json');
 let record;
 if(fs.existsSync(file)){
  record=JSON.parse(fs.readFileSync(file,'utf8'));
  if(record.inputSha256!==digest(JSON.stringify(input)))throw Error('Saved input differs; preserve the old receipt and choose a new case ID');
 }else{
  if(!live)throw Error('Saved live receipt missing for '+item.id+'. --live makes one paid API request for each missing case.');
  const start=new Date().toISOString();
  try{
   calls++;const returned=await callMeta(input);
   record={input,inputSha256:digest(JSON.stringify(input)),rawReview:returned.review,provenance:returned.provenance};
   try{record.result=bindReview(input,returned.review,returned.provenance);record.status='VALIDATED';}
   catch(error){record.status='REJECTED_BY_CONTRACT';record.validationError=error.message;}
  }catch(error){record={input,inputSha256:digest(JSON.stringify(input)),status:'REQUEST_FAILED',startedAt:start,error:error.message,...(error.responseEvidence?{responseEvidence:error.responseEvidence}:{})};}
  // Failed and rejected results are preserved. No automatic retry, silent repair or replacement.
  fs.writeFileSync(file,JSON.stringify(record,null,2)+'\n','utf8');
 }
 if(record.status==='VALIDATED'){
  const rebound=bindReview(input,record.rawReview,record.provenance);
  if(JSON.stringify(rebound)!==JSON.stringify(record.result))throw Error('Saved validated result differs from the current contract');
 }
 const row={caseId:item.id,lessonId:item.lessonId,topic:item.topic,kind:item.kind,status:record.status,findings:record.result?.findings.length??null,decision:record.result?.decision??null,latencyMs:record.provenance?.latencyMs??null,usage:record.provenance?.usage??null,receipt:'evidence/library-review/'+item.id+'.json'};
 rows.push(row);
 console.log(JSON.stringify({case:row.caseId,status:row.status,findings:row.findings}));
}
const summary={schemaVersion:1,sampleLessons:new Set(rows.map(x=>x.lessonId)).size,caseCount:rows.length,validated:rows.filter(x=>x.status==='VALIDATED').length,rejected:rows.filter(x=>x.status==='REJECTED_BY_CONTRACT').length,failed:rows.filter(x=>x.status==='REQUEST_FAILED').length,selection:manifest.selection,limitations:'New source-derived test drafts and deliberately seeded contradictions. Not verbatim published narration, not a random sample, not a human-labeled accuracy benchmark. Source references may themselves contain errors. Matching quotations establish reference integrity, not truth. Historical evidence is labeled and not claimed as freshly executed. No case is approved for publication.',rows};
fs.writeFileSync(path.join(evidence,'summary.json'),JSON.stringify(summary,null,2)+'\n','utf8');
console.log(JSON.stringify({lessons:summary.sampleLessons,cases:summary.caseCount,validated:summary.validated,rejected:summary.rejected,failed:summary.failed,requestsDispatchedThisRun:calls}));
