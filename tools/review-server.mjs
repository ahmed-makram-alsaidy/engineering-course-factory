import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {bindReview} from './lesson-review/contract.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=name=>JSON.parse(fs.readFileSync(path.join(root,'evidence',name),'utf8'));
const port=Number(process.env.PORT||8317);
const server=http.createServer((req,res)=>{
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:");
 try{
  if(req.method==='GET'&&req.url==='/'){
   res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync(path.join(root,'apps/review-dashboard/index.html')));return;
  }
  if(req.method==='GET'&&req.url==='/api/reviews'){
   res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify({contradictory:read('live-review-contradictory.json'),corrected:read('live-review-corrected.json')}));return;
  }
  if(req.method==='POST'&&req.url==='/api/check-tampered'){
   const data=read('live-review-contradictory.json');const altered=structuredClone(data.result);altered.findings[0].evidence[0].quote='A fabricated quote that does not exist in any supplied source.';
   let rejected=false;try{bindReview(data.input,altered);}catch{rejected=true;}
   res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify({rejected,message:rejected?'Fabricated quotation rejected by the actual server-side evidence validator.':'Unexpected acceptance; check validator.'}));return;
  }
  res.writeHead(404);res.end('Not found');
 }catch{res.writeHead(500);res.end('Review evidence unavailable. Run the documented live review commands first.');}
});
server.listen(port,'127.0.0.1',()=>console.log(`Review dashboard: http://127.0.0.1:${port}\nThis dashboard displays saved live Meta responses. It does not call a model when switching cases.`));
