import { readFileSync, writeFileSync } from 'fs';
import { TARGET_SKILLS } from './targets_v4.js';

const OR_KEY = 'YOUR_API_KEY_HERE';
const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';
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

async function callModel(modelId, systemPrompt, userPrompt, retries=4) {
  for (let attempt=0; attempt<retries; attempt++) {
    try {
      const res = await fetch(OR_URL, {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+OR_KEY,'HTTP-Referer':'https://skill-phase-experiment.local'},
        body: JSON.stringify({
          model: modelId,
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

async function recoverFile(filename) {
  console.log(`\nWaiting for ${filename} to be ready...`);
  let dataRaw = null;
  while (!dataRaw) {
    try {
      dataRaw = readFileSync(filename, 'utf8');
      if (dataRaw.length > 100) break;
    } catch(e) {
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  console.log(`Recovering ${filename}...`);
  const data = JSON.parse(dataRaw);
  const logs = data.logs;
  
  // Find logs that failed with 402
  const failedLogs = logs.filter(l => l.err && String(l.err).includes('402'));
  if (failedLogs.length === 0) {
    console.log('No 402 errors found. File is clean.');
    return;
  }
  
  console.log(`Found ${failedLogs.length} queries that failed with 402. Resuming them now...`);
  
  for (let i=0; i<failedLogs.length; i++) {
    const log = failedLogs[i];
    const library = buildLibrary(log.size, log.size*7+3);
    const listing = library.map(s=>formatSkill(s, log.condition==='expert')).join('\n');
    const system  = `You are a tool-routing component. Below is a list of available skills, one per line as "id: description". Given the user's request, respond with ONLY the id of the single most appropriate skill and nothing else -- no explanation, no punctuation, just the id.\n\nAvailable skills:\n${listing}`;
    
    let raw='', chosen=null, ok=false, errMsg=null;
    try {
      raw = await callModel(data.model, system, log.query);
      ({chosen, correct:ok} = gradeResponse(raw, library, log.target));
    } catch(e) { errMsg=String(e.message||e); }
    
    // Update the log entry in memory
    log.chosen = chosen;
    log.correct = ok;
    log.err = errMsg;
    
    console.log(`  [${i+1}/${failedLogs.length}] Recovered: ${log.condition} ${ok?'✓':'✗'} -> ${chosen ?? errMsg ?? 'null'}`);
    await new Promise(r=>setTimeout(r, 2000));
  }
  
  // Recalculate results for the affected sizes/conditions
  const ALL_QUERIES_COUNT = TARGET_SKILLS.length * 3; // 59 * 3 = 177
  for (const size of Object.keys(data.results)) {
    for (const condition of ['bare', 'expert']) {
      const conditionLogs = logs.filter(l => String(l.size) === size && l.condition === condition);
      const correctCount = conditionLogs.filter(l => l.correct).length;
      const ci = wilsonCI(correctCount, ALL_QUERIES_COUNT);
      data.results[size][condition] = {
        correct: correctCount,
        total: ALL_QUERIES_COUNT,
        accuracy: (correctCount / ALL_QUERIES_COUNT * 100).toFixed(1),
        ci95_lo: ci.lo.toFixed(1),
        ci95_hi: ci.hi.toFixed(1)
      };
    }
  }
  
  // Print new summary
  console.log(`\nFixed RESULTS — ${data.modelName}`);
  console.log(`${'size'.padEnd(6)} ${'bare'.padEnd(8)} ${'expert'.padEnd(8)}`);
  console.log('─'.repeat(30));
  for (const size of [100, 500, 2000]) {
    const b=data.results[size]?.bare, e=data.results[size]?.expert;
    if (!b||!e) continue;
    console.log(`${String(size).padEnd(6)} ${(b.accuracy+'%').padEnd(8)} ${(e.accuracy+'%').padEnd(8)}`);
  }
  
  writeFileSync(filename, JSON.stringify(data, null, 2));
  console.log(`Successfully patched ${filename}\n`);
}

async function runAll() {
  try {
    await recoverFile('results_google_gemini_3_1_flash_lite.json');
    await recoverFile('results_openai_gpt_4o_mini.json');
  } catch(e) {
    console.log("Error recovering:", e.message);
  }
}

runAll();
