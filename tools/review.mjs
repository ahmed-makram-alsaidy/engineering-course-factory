import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {bindReview, validateInput} from './lesson-review/contract.mjs';
import {callMeta} from './lesson-review/provider.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const live = args.includes('--live');
const fixed = args.includes('--corrected');
const outputArg = args.indexOf('--output');
const output = path.resolve(outputArg >= 0 ? args[outputArg + 1] : path.join(root, 'runtime', `review-${fixed ? 'corrected' : 'contradictory'}.json`));
const example = path.join(root, 'examples', 'python-functions');
// This demonstration executes only this checked-in trusted fixture, never a model-supplied command.
const run = spawnSync(process.env.PYTHON || 'python', ['-B', '-X', 'utf8', 'review_checks.py'], {cwd: example, encoding: 'utf8', timeout: 10000, maxBuffer: 65536, windowsHide: true});
if (run.status !== 0) throw new Error('Trusted fixture execution failed; review was not sent');
const narration = fixed
  ? 'الدالة is_valid_age في المثال بتقبل القيم الصحيحة اللي أكبر من صفر ولحد مية وعشرين، وبالتالي صفر ومية واحد وعشرين مرفوضين. فحص is_valid_name هنا بيعد أجزاء النص بعد إزالة المسافات الزائدة؛ قبول كلمتين مش إثبات لهوية الشخص. ملاحظة تنفيذية: Python بتعتبر bool نوع فرعي من int، والمثال ده مش بيستبعده.'
  : 'الدالة is_valid_age بتقبل الصفر وأي عدد صحيح موجب، من غير حد أقصى للسن. والدالة is_valid_name بتتأكد إن الاسم هو الهوية القانونية الحقيقية للشخص.';
const input = validateInput({version: 1, lessonId: 'C02.09-review-demo', narration, sources: [
  {id: 'python-source', text: fs.readFileSync(path.join(example, 'validators.py'), 'utf8')},
  {id: 'execution', text: run.stdout.trim()},
  {id: 'scope', text: 'This is a programming exercise about boolean predicates, not a medical recommendation or an identity verification service. The name rule checks text word count only. Python bool is a subclass of int.'}
]});
let result;
if (live) {
  const returned = await callMeta(input);
  result = bindReview(input, returned.review, returned.provenance);
} else {
  const findings = fixed ? [] : [{severity: 'blocking', title: 'Zero is rejected by the executed example', explanation: 'The draft says zero is accepted, while the source and the executed boundary check show otherwise.', suggestedChange: 'Explain the actual predicate and its upper bound, and describe the name rule as text validation.', evidence: [{sourceId: 'narration', quote: 'بتقبل الصفر'}, {sourceId: 'python-source', quote: '0 < age <= 120'}, {sourceId: 'execution', quote: '"age_zero": false'}]}];
  result = bindReview(input, {findings}, {mode: 'OFFLINE_REPLAY_FIXTURE', modelCalled: false, createdAt: new Date().toISOString()});
}
fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, JSON.stringify({input, result}, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({output, decision: result.decision, findings: result.findings.length, mode: result.provenance.mode, approvedForPublication: false}, null, 2));
