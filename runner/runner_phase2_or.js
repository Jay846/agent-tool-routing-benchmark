// OpenRouter multi-model runner
// Usage: node --input-type=module runner_openrouter.js <model_id> <friendly_name>
// Reuses hq_fillers.json and the same fixed methodology as runner_v2.js

import { readFileSync, writeFileSync } from 'fs';

const OR_KEY        = 'YOUR_API_KEY_HERE';
const OR_URL        = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL_ID      = process.argv[2] || 'openai/gpt-4o-mini';
const MODEL_NAME    = process.argv[3] || MODEL_ID.replace('/','-');
const OUT_FILE      = `results_${MODEL_NAME.replace(/[^a-z0-9]/gi,'_')}.json`;

import { TARGET_SKILLS } from './targets_v4.js';

const HQ_FILLERS = JSON.parse(readFileSync('./fillers_v4.json', 'utf8'));

function seededShuffle(arr, seed) {
  const a = arr.slice(); let s = seed;
  for (let i = a.length-1; i > 0; i--) {
    s = (s*9301+49297)%233280;
    const j = Math.floor((s/233280)*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

function buildLibrary(size, seed) {
  const nFillers = Math.max(0, size - TARGET_SKILLS.length);
  const fillers  = seededShuffle(HQ_FILLERS, seed).slice(0, nFillers);
  return seededShuffle([...TARGET_SKILLS, ...fillers], seed+1);
}

function formatSkill(skill, expert) {
  if (!expert) return `${skill.id}: ${skill.concept}`;
  return `${skill.id}: ${skill.concept} ${skill.disambiguator} Example: "${skill.example}"`;
}

function gradeResponse(responseText, library, targetId) {
  if (!responseText) return { chosen: null, correct: false };
  const norm = s => s.toLowerCase().replace(/[^a-z0-9_]/g,'');
  const r    = norm(responseText);
  const exact = library.find(s => norm(s.id) === r);
  if (exact) return { chosen: exact.id, correct: exact.id === targetId };
  const subs = library.filter(s => r.includes(norm(s.id))).sort((a,b)=>b.id.length-a.id.length);
  const chosen = subs.length >= 1 ? subs[0].id : null;
  return { chosen, correct: chosen === targetId };
}

function wilsonCI(correct, total) {
  if (total===0) return {lo:0,hi:0};
  const p=correct/total, z=1.96, n=total;
  const center=(p+z*z/(2*n))/(1+z*z/n);
  const margin=(z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n)))/(1+z*z/n);
  return { lo:Math.max(0,center-margin)*100, hi:Math.min(1,center+margin)*100 };
}

async function callModel(systemPrompt, userPrompt, retries=4) {
  for (let attempt=0; attempt<retries; attempt++) {
    try {
      const res = await fetch(OR_URL, {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+OR_KEY,'HTTP-Referer':'https://skill-phase-experiment.local'},
        body: JSON.stringify({
          model: MODEL_ID,
          temperature: 0,
          max_tokens: 20,
          messages:[{role:'system',content:systemPrompt},{role:'user',content:userPrompt}],
        }),
      });
      if (res.status===429) { await new Promise(r=>setTimeout(r,(attempt+1)*5000)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0,200)}`);
      const data = await res.json();
      return (data.choices?.[0]?.message?.content || '').trim();
    } catch(e) {
      if (attempt===retries-1) throw e;
      await new Promise(r=>setTimeout(r,2000));
    }
  }
}

const ALL_QUERIES = TARGET_SKILLS.flatMap(s => s.queries.map(q => ({targetId:s.id, query:q})));
const SIZES       = [100, 500, 2000];
const CONDITIONS  = ['bare','expert'];
const totalCalls  = SIZES.length * CONDITIONS.length * ALL_QUERIES.length;

console.log('='.repeat(60));
console.log(` Model: ${MODEL_ID}  (saved as: ${MODEL_NAME})`);
console.log(` temperature=0 | HQ fillers | all 24 queries`);
console.log(` Sizes: ${SIZES.join(', ')}`);
console.log(` Total API calls: ${totalCalls}`);
console.log('='.repeat(60)+'\n');

const results={}, logs=[];
let done=0;
const t0=Date.now();

for (const size of SIZES) {
  results[size]={};
  const library = buildLibrary(size, size*7+3);
  console.log(`\n── size=${size}  (${library.length} skills: ${TARGET_SKILLS.length} target + ${library.length-TARGET_SKILLS.length} HQ fillers) ──`);

  for (const condition of CONDITIONS) {
    let correct=0;
    for (const item of ALL_QUERIES) {
      const listing = library.map(s=>formatSkill(s,condition==='expert')).join('\n');
      const system  = `You are a tool-routing component. Below is a list of available skills, one per line as "id: description". Given the user's request, respond with ONLY the id of the single most appropriate skill and nothing else -- no explanation, no punctuation, just the id.\n\nAvailable skills:\n${listing}`;
      let raw='', chosen=null, ok=false, errMsg=null;
      try {
        raw = await callModel(system, item.query);
        ({chosen, correct:ok} = gradeResponse(raw, library, item.targetId));
        if (ok) correct++;
      } catch(e) { errMsg=String(e.message||e); }
      done++;
      const elapsed=((Date.now()-t0)/1000).toFixed(0);
      const pct=((done/totalCalls)*100).toFixed(1);
      const icon=errMsg?'!':ok?'✓':'✗';
      console.log(`  [${done}/${totalCalls} ${pct}% | ${elapsed}s] ${condition} ${icon}  "${item.query.slice(0,42)}…"  →  ${chosen??errMsg??'null'}${ok?'':` (want: ${item.targetId})`}`);
      logs.push({size,condition,query:item.query,target:item.targetId,chosen,correct:ok,err:errMsg});
      await new Promise(r=>setTimeout(r, 2000));
    }
    const ci=wilsonCI(correct, ALL_QUERIES.length);
    results[size][condition]={correct,total:ALL_QUERIES.length,accuracy:(correct/ALL_QUERIES.length*100).toFixed(1),ci95_lo:ci.lo.toFixed(1),ci95_hi:ci.hi.toFixed(1)};
    console.log(`  → ${condition}: ${correct}/${ALL_QUERIES.length} = ${results[size][condition].accuracy}%  [95%CI: ${ci.lo.toFixed(1)}–${ci.hi.toFixed(1)}%]`);
  }
}

const elapsed=((Date.now()-t0)/1000).toFixed(1);
console.log(`\n${'='.repeat(60)}\n Done in ${elapsed}s\n${'='.repeat(60)}\n`);

// Summary table
console.log(`RESULTS — ${MODEL_NAME}`);
console.log(`${'size'.padEnd(6)} ${'bare'.padEnd(8)} ${'bare CI'.padEnd(18)} ${'expert'.padEnd(8)} expert CI`);
console.log('─'.repeat(60));
for (const size of SIZES) {
  const b=results[size]?.bare, e=results[size]?.expert;
  if (!b||!e) continue;
  console.log(`${String(size).padEnd(6)} ${(b.accuracy+'%').padEnd(8)} [${b.ci95_lo}–${b.ci95_hi}%]`.padEnd(30)+`  ${(e.accuracy+'%').padEnd(8)} [${e.ci95_lo}–${e.ci95_hi}%]`);
}

writeFileSync('./'+OUT_FILE, JSON.stringify({model:MODEL_ID,modelName:MODEL_NAME,methodology:'v4-or-checkpoints',generatedAt:new Date().toISOString(),results,logs},null,2));
console.log(`\nSaved → ${OUT_FILE}`);
