import { readFileSync, writeFileSync } from 'fs';
import { TARGET_SKILLS } from './targets_v3.js';

const DEEPSEEK_API_KEY = 'YOUR_API_KEY_HERE';
const DEEPSEEK_URL     = 'https://api.deepseek.com/chat/completions';
const MODEL            = 'deepseek-chat';

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

// Robust grading to fix Critique B (verbose prefix/suffix errors)
function gradeResponse(responseText, library, targetId) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9_]/g, '');
  const r    = responseText.toLowerCase().trim();
  
  // 1. Tokenize and search for exact match of any word with any skill ID
  const words = r.split(/[\s,.:;!"'()\[\]{}?/\\]+/).map(w => w.trim()).filter(Boolean);
  for (const word of words) {
    const matched = library.find(s => norm(s.id) === norm(word));
    if (matched) {
      return { chosen: matched.id, correct: matched.id === targetId };
    }
  }

  // 2. Exact match fallback
  const exact = library.find(s => norm(s.id) === norm(r));
  if (exact) return { chosen: exact.id, correct: exact.id === targetId };

  // 3. Substring match fallback (prefer longer ID matches)
  const normR = norm(r);
  const subs = library.filter(s => normR.includes(norm(s.id))).sort((a,b) => b.id.length - a.id.length);
  const chosen = subs.length >= 1 ? subs[0].id : null;
  return { chosen, correct: chosen === targetId };
}

// Wilson score 95% CI
function wilsonCI(correct, total) {
  if (total === 0) return { lo: 0, hi: 0 };
  const p = correct / total, z = 1.96, n = total;
  const center = (p + z*z/(2*n)) / (1 + z*z/n);
  const margin = (z * Math.sqrt(p*(1-p)/n + z*z/(4*n*n))) / (1 + z*z/n);
  return { lo: Math.max(0, center-margin)*100, hi: Math.min(1, center+margin)*100 };
}

async function callDeepSeek(systemPrompt, userPrompt, retries = 4) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0,
          max_tokens: 20,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt   },
          ],
        }),
      });
      if (res.status === 429) { await new Promise(r => setTimeout(r, (attempt+1)*3000)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return (data.choices?.[0]?.message?.content || '').trim();
    } catch(e) {
      if (attempt === retries-1) throw e;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

// Concurrency pool helper
async function runWithPool(tasks, limit) {
  const results = [];
  const executing = [];
  for (const task of tasks) {
    const p = Promise.resolve().then(() => task());
    results.push(p);
    if (limit <= tasks.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(results);
}

// ---------- experiment config ----------
const ALL_QUERIES = TARGET_SKILLS.flatMap(s => s.queries.map(q => ({ targetId: s.id, query: q })));
const SIZES = [60, 120, 200, 500, 1000];
const CONDITIONS = ['bare', 'expert'];

const totalCalls = SIZES.length * CONDITIONS.length * ALL_QUERIES.length;
console.log('============================================================');
console.log(` Skill Phase Transition v3 — N=1000 Sweep`);
// targets * 5 queries = 100 total queries
console.log(` Model: ${MODEL}  |  temperature=0  |  HQ fillers`);
console.log(` Sizes: ${SIZES.join(', ')}`);
console.log(` Queries per condition: ${ALL_QUERIES.length} (20 targets x 5 queries)`);
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
    console.log(`\n── size=${size} (${library.length} skills: 20 target + ${library.length-20} fillers) ──`);

    for (const condition of CONDITIONS) {
      let correct = 0;
      const tasks = ALL_QUERIES.map((item) => async () => {
        const listing = library.map(s => formatSkill(s, condition === 'expert')).join('\n');
        const system  = `You are a tool-routing component. Below is a list of available skills, one per line as "id: description". Given the user's request, respond with ONLY the id of the single most appropriate skill and nothing else -- no explanation, no punctuation, just the id.\n\nAvailable skills:\n${listing}`;

        let raw = '', chosen = null, ok = false, errMsg = null;
        try {
          raw = await callDeepSeek(system, item.query);
          ({ chosen, correct: ok } = gradeResponse(raw, library, item.targetId));
          if (ok) correct++;
        } catch(e) { errMsg = String(e.message || e); }

        done++;
        const elapsed = ((Date.now()-t0)/1000).toFixed(0);
        const pct     = ((done/totalCalls)*100).toFixed(1);
        const icon    = errMsg ? '!' : (ok ? '✓' : '✗');
        
        // Print progress periodically to keep logs clean but active
        if (done % 10 === 0 || done === totalCalls) {
          console.log(`  [${done}/${totalCalls} ${pct}% | ${elapsed}s] ${condition} ${icon} "${item.query.slice(0,40)}…" → ${chosen ?? errMsg ?? 'null'}${ok ? '' : ` (want: ${item.targetId})`}`);
        }

        logs.push({ size, condition, query: item.query, target: item.targetId, chosen, correct: ok, err: errMsg });
      });

      // Run queries for this size/condition with concurrency limit of 12
      await runWithPool(tasks, 12);

      const ci = wilsonCI(correct, ALL_QUERIES.length);
      results[size][condition] = {
        correct,
        total: ALL_QUERIES.length,
        accuracy: (correct/ALL_QUERIES.length*100).toFixed(1),
        ci95_lo: ci.lo.toFixed(1),
        ci95_hi: ci.hi.toFixed(1),
      };
      console.log(`  → ${condition}: ${correct}/${ALL_QUERIES.length} = ${results[size][condition].accuracy}% [95%CI: ${ci.lo.toFixed(1)}–${ci.hi.toFixed(1)}%]`);
    }
  }

  const elapsed = ((Date.now()-t0)/1000).toFixed(1);
  console.log(`\n============================================================\n Done in ${elapsed}s\n============================================================\n`);

  // ---------- results table ----------
  console.log('FINAL RESULTS (100 queries, N=1000 scale, temperature=0, robust grading)');
  console.log(`${'size'.padEnd(6)} ${'bare'.padEnd(8)} ${'bare CI'.padEnd(16)} ${'expert'.padEnd(8)} ${'expert CI'}`);
  console.log('─'.repeat(58));
  for (const size of SIZES) {
    const b = results[size]?.bare, e = results[size]?.expert;
    if (!b || !e) continue;
    console.log(`${String(size).padEnd(6)} ${(b.accuracy+'%').padEnd(8)} [${b.ci95_lo}–${b.ci95_hi}%]`.padEnd(30) + `  ${(e.accuracy+'%').padEnd(8)} [${e.ci95_lo}–${e.ci95_hi}%]`);
  }

  // save
  writeFileSync('./results_v3.json', JSON.stringify({ model: MODEL, methodology: 'v3-scaled', results, logs }, null, 2));
  console.log('\nSaved → results_v3.json');
}

runSweep().catch(console.error);
