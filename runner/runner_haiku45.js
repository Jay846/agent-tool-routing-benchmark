import { readFileSync, writeFileSync } from 'fs';
import { TARGET_SKILLS } from './targets_v3.js';
import { getTokenProvider } from "@aws/bedrock-token-generator";

const MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const REGION = 'us-east-1';
const BEDROCK_URL = `https://bedrock-runtime.${REGION}.amazonaws.com/model/${MODEL_ID}/invoke`;

const provider = getTokenProvider({ region: REGION });
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAuthToken() {
  const now = Date.now();
  if (!cachedToken || now > tokenExpiresAt) {
    cachedToken = await provider();
    tokenExpiresAt = now + 11 * 60 * 60 * 1000; // token is good for 12 hours, refresh at 11
  }
  return cachedToken;
}

const HQ_FILLERS = JSON.parse(readFileSync('./hq_fillers.json', 'utf8'));
console.log(`Loaded ${HQ_FILLERS.length} high-quality fillers\n`);

function seededShuffle(arr, seed) {
  const a = arr.slice(); let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildLibrary(size, seed) {
  const nFillers = Math.max(0, size - TARGET_SKILLS.length);
  const fillers  = seededShuffle(HQ_FILLERS, seed).slice(0, nFillers);
  return seededShuffle([...TARGET_SKILLS, ...fillers], seed + 1);
}

function formatSkill(skill, expert) {
  if (!expert) return `${skill.id}: ${skill.concept}`;
  return `${skill.id}: ${skill.concept} ${skill.disambiguator} Example: "${skill.example}"`;
}

function gradeResponse(responseText, library, targetId) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9_]/g, '');
  const r    = responseText.toLowerCase().trim();
  const words = r.split(/[\s,.:;!"'()\[\]{}?/\\]+/).map(w => w.trim()).filter(Boolean);
  for (const word of words) {
    const matched = library.find(s => norm(s.id) === norm(word));
    if (matched) return { chosen: matched.id, correct: matched.id === targetId };
  }
  const exact = library.find(s => norm(s.id) === norm(r));
  if (exact) return { chosen: exact.id, correct: exact.id === targetId };
  const normR = norm(r);
  const subs = library.filter(s => normR.includes(norm(s.id))).sort((a,b) => b.id.length - a.id.length);
  const chosen = subs.length >= 1 ? subs[0].id : null;
  return { chosen, correct: chosen === targetId };
}

function wilsonCI(correct, total) {
  if (total === 0) return { lo: 0, hi: 0 };
  const p = correct / total, z = 1.96, n = total;
  const center = (p + z*z/(2*n)) / (1 + z*z/n);
  const margin = (z * Math.sqrt(p*(1-p)/n + z*z/(4*n*n))) / (1 + z*z/n);
  return { lo: Math.max(0, center-margin)*100, hi: Math.min(1, center+margin)*100 };
}

async function callClaudeHaiku(systemPrompt, userPrompt, retries = 4) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const token = await getAuthToken();
      const res = await fetch(BEDROCK_URL, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json', 
          'Authorization': `Bearer ${token}` 
        },
        body: JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 20,
          temperature: 0,
          system: systemPrompt,
          messages: [
            { role: 'user', content: userPrompt }
          ],
        }),
      });
      if (res.status === 429) { await new Promise(r => setTimeout(r, (attempt+1)*3000)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return (data.content?.[0]?.text || '').trim();
    } catch(e) {
      if (attempt === retries-1) throw e;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

async function runWithPool(tasks, limit) {
  const results = [];
  const executing = [];
  for (const task of tasks) {
    const p = Promise.resolve().then(() => task());
    results.push(p);
    if (limit <= tasks.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

const ALL_QUERIES = TARGET_SKILLS.flatMap(s => s.queries.map(q => ({ targetId: s.id, query: q })));
const SIZES = [60, 120, 200, 500, 1000];
const CONDITIONS = ['bare', 'expert'];

const totalCalls = SIZES.length * CONDITIONS.length * ALL_QUERIES.length;
console.log('============================================================');
console.log(` Skill Phase Transition — Claude 4.5 Haiku`);
console.log(` Model: ${MODEL_ID}  |  temperature=0`);
console.log(` Sizes: ${SIZES.join(', ')}`);
console.log(` Total API calls: ${totalCalls}`);
console.log('============================================================\n');

const results = {};
const logs    = [];
let done      = 0;
const t0      = Date.now();

async function runSweep() {
  for (const size of SIZES) {
    results[size] = {};
    const library = buildLibrary(size, size * 13 + 7);
    console.log(`\n── size=${size} (${library.length} skills) ──`);

    for (const condition of CONDITIONS) {
      let correct = 0;
      const tasks = ALL_QUERIES.map((item) => async () => {
        const listing = library.map(s => formatSkill(s, condition === 'expert')).join('\n');
        const system  = `You are a tool-routing component. Below is a list of available skills, one per line as "id: description". Given the user's request, respond with ONLY the id of the single most appropriate skill and nothing else -- no explanation, no punctuation, just the id.\n\nAvailable skills:\n${listing}`;

        let raw = '', chosen = null, ok = false, errMsg = null;
        try {
          raw = await callClaudeHaiku(system, item.query);
          ({ chosen, correct: ok } = gradeResponse(raw, library, item.targetId));
          if (ok) correct++;
        } catch(e) { errMsg = String(e.message || e); }

        done++;
        const elapsed = ((Date.now()-t0)/1000).toFixed(0);
        const pct     = ((done/totalCalls)*100).toFixed(1);
        const icon    = errMsg ? '!' : (ok ? '✓' : '✗');
        if (done % 10 === 0 || done === totalCalls) {
          console.log(`  [${done}/${totalCalls} ${pct}% | ${elapsed}s] ${condition} ${icon} "${item.query.slice(0,40)}…" → ${chosen ?? errMsg ?? 'null'}${ok ? '' : ` (want: ${item.targetId})`}`);
        }
        logs.push({ size, condition, query: item.query, target: item.targetId, chosen, correct: ok, err: errMsg });
      });

      // Using concurrency of 8 to avoid Bedrock rate limits
      await runWithPool(tasks, 8);

      const ci = wilsonCI(correct, ALL_QUERIES.length);
      results[size][condition] = {
        correct, total: ALL_QUERIES.length,
        accuracy: (correct/ALL_QUERIES.length*100).toFixed(1),
        ci95_lo: ci.lo.toFixed(1), ci95_hi: ci.hi.toFixed(1),
      };
      console.log(`  → ${condition}: ${correct}/${ALL_QUERIES.length} = ${results[size][condition].accuracy}% [95%CI: ${ci.lo.toFixed(1)}–${ci.hi.toFixed(1)}%]`);
    }
  }

  const elapsed = ((Date.now()-t0)/1000).toFixed(1);
  console.log(`\n============================================================\n Done in ${elapsed}s\n============================================================\n`);
  
  console.log('FINAL RESULTS (100 queries, N=1000 scale, temperature=0, robust grading)');
  console.log(`${'size'.padEnd(6)} ${'bare'.padEnd(8)} ${'bare CI'.padEnd(16)} ${'expert'.padEnd(8)} ${'expert CI'}`);
  console.log('─'.repeat(58));
  for (const size of SIZES) {
    const b = results[size]?.bare, e = results[size]?.expert;
    if (!b || !e) continue;
    console.log(`${String(size).padEnd(6)} ${(b.accuracy+'%').padEnd(8)} [${b.ci95_lo}–${b.ci95_hi}%]`.padEnd(30) + `  ${(e.accuracy+'%').padEnd(8)} [${e.ci95_lo}–${e.ci95_hi}%]`);
  }

  writeFileSync('./results_haiku45.json', JSON.stringify({ model: 'claude-haiku-4.5', results, logs }, null, 2));
}

runSweep().catch(console.error);
