import {systemPrompt, validateInput} from './contract.mjs';

export async function callMeta(input, {apiKey = process.env.MODEL_API_KEY, model = 'muse-spark-1.3', timeoutMs = 60000} = {}) {
  validateInput(input);
  if (!apiKey) throw new Error('Set MODEL_API_KEY to use live Meta review. Credentials are never read from project files.');
  const started = Date.now();
  const response = await fetch('https://api.meta.ai/v1/responses', {
    method: 'POST',
    headers: {'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'course-factory-lesson-review/0.1'},
    body: JSON.stringify({model, instructions: systemPrompt(), input: JSON.stringify(input), max_output_tokens: 2200, reasoning: {effort: 'low'}}),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`Meta API returned HTTP ${response.status}; no retry was dispatched`);
  const raw = await response.json();
  const text = (raw.output || []).flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('\n');
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let review;
  try { review = JSON.parse(cleaned); } catch { throw new Error('Meta response was not valid review JSON; no retry was dispatched'); }
  return {
    review,
    provenance: {mode: 'LIVE_META_API', endpoint: 'https://api.meta.ai/v1/responses', requestedModel: model, returnedModel: raw.model || null, responseId: raw.id || null, createdAt: new Date().toISOString(), latencyMs: Date.now() - started, usage: raw.usage || null, automaticRetries: 0}
  };
}
