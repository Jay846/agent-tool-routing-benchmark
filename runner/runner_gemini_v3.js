import { readFileSync, writeFileSync } from 'fs';
import { TARGET_SKILLS } from './targets_v3.js';

const GEMINI_KEY    = 'AIzaSyCQfThf98F893otxatXKroqh1k2ypxxOEc';
const MODEL_ID      = 'gemini-2.5-flash';
const OUT_FILE      = `results_gemini_2_5_flash_v3.json`;
const GEMINI_URL    = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent?key=${GEMINI_KEY}`;

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

// Robust grading to match v3 logic
function gradeResponse(responseText, library, targetId) {
  if (!responseText || typeof responseText !== 'string') {
    return { chosen: null, correct: false };
  }
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

async function callGemini(systemPrompt, userPrompt, retries = 10) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 20
          }
        }),
      });
      const data = await res.json();
      if (res.status === 429 || data.error?.code === 429) {
        const delay = (attempt + 1) * 10000;
        // console.log(`  [Rate Limit 429] Waiting ${delay/1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (data.error) throw new Error(`API Error: ${data.error.message}`);
      return (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    } catch(e) {
      if (attempt === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 4000));
    }
  }
  throw new Error('API Error: Max retries exceeded (Rate Limit/429)');
}

// ---------- experiment config ----------
const ALL_QUERIES = TARGET_SKILLS.flatMap(s => s.queries.map(q => ({ targetId: s.id, query: q })));
const SIZES = [60, 120, 200, 500, 1000];
const CONDITIONS = ['bare', 'expert'];

const totalCalls = SIZES.length * CONDITIONS.length * ALL_QUERIES.length;
console.log('============================================================');
console.log(` Gemini 2.5 Flash Phase Transition v3 — N=1000 Sweep`);
console.log(` Model: ${MODEL_ID}  |  temperature=0  |  HQ fillers`);
console.log(` Sizes: ${SIZES.join(', ')}`);
console.log(` Queries per condition: ${ALL_QUERIES.length} (20 targets x 5 queries)`);
console.log(` Total API calls: ${totalCalls}`);
console.log('============================================================\n');

const results = {};
const logs    = [];
let done      = 0;
const t0      = Date.now();

// Dry-run command line arg check
const isDryRun = process.argv.includes('--dry-run');

async function runSweep() {
  const sizesToRun = isDryRun ? [60] : SIZES;
  const conditionsToRun = isDryRun ? ['bare'] : CONDITIONS;

  for (const size of sizesToRun) {
    results[size] = {};
    const library = buildLibrary(size, size * 13 + 7);
    console.log(`\n── size=${size} (${library.length} skills: 20 target + ${library.length-20} fillers) ──`);

    for (const condition of conditionsToRun) {
      let correct = 0;
      const queriesToRun = isDryRun ? ALL_QUERIES.slice(0, 2) : ALL_QUERIES;

      for (const item of queriesToRun) {
        const listing = library.map(s => formatSkill(s, condition === 'expert')).join('\n');
        const system  = `You are a tool-routing component. Below is a list of available skills, one per line as "id: description". Given the user's request, respond with ONLY the id of the single most appropriate skill and nothing else -- no explanation, no punctuation, just the id.\n\nAvailable skills:\n${listing}`;

        let raw = '', chosen = null, ok = false, errMsg = null;
        try {
          raw = await callGemini(system, item.query);
          ({ chosen, correct: ok } = gradeResponse(raw, library, item.targetId));
          if (ok) correct++;
        } catch(e) { errMsg = String(e.message || e); }

        done++;
        const elapsed = ((Date.now()-t0)/1000).toFixed(0);
        const totalToRun = isDryRun ? 2 : totalCalls;
        const pct     = ((done/totalToRun)*100).toFixed(1);
        const icon    = errMsg ? '!' : (ok ? '✓' : '✗');
        
        console.log(`  [${done}/${totalToRun} ${pct}% | ${elapsed}s] ${condition} ${icon} "${item.query.slice(0,40)}…" → ${chosen ?? errMsg ?? 'null'}${ok ? '' : ` (want: ${item.targetId})`}`);

        logs.push({ size, condition, query: item.query, target: item.targetId, chosen, correct: ok, err: errMsg });
        
        // Respect free tier rate limits (15 RPM -> 4 seconds spacing)
        if (!isDryRun) {
          await new Promise(r => setTimeout(r, 4200));
        }
      }

      if (!isDryRun) {
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
  }

  if (isDryRun) {
    console.log('\nDry run completed successfully!');
    return;
  }

  const elapsed = ((Date.now()-t0)/1000).toFixed(1);
  console.log(`\n============================================================\n Done in ${elapsed}s\n============================================================\n`);

  // save
  writeFileSync('./' + OUT_FILE, JSON.stringify({ model: MODEL_ID, methodology: 'v3-scaled', results, logs }, null, 2));
  console.log(`\nSaved → ${OUT_FILE}`);
}

runSweep().catch(console.error);
