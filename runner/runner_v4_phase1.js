import { readFileSync, writeFileSync } from 'fs';
const TARGET_SKILLS = JSON.parse(readFileSync('./generated_targets.json', 'utf8'));

const DEEPSEEK_API_KEY = 'YOUR_API_KEY_HERE';
const DEEPSEEK_URL     = 'https://api.deepseek.com/chat/completions';
const MODEL            = 'deepseek-chat';

const HQ_FILLERS = JSON.parse(readFileSync('./hq_fillers.json', 'utf8'));
console.log(`Loaded ${HQ_FILLERS.length} high-quality fillers`);
console.log(`Loaded ${TARGET_SKILLS.length} target skills`);

const ALL_QUERIES = [];
for (const t of TARGET_SKILLS) {
  for (const q of t.queries) {
    ALL_QUERIES.push({ targetId: t.id, query: q });
  }
}
console.log(`Total queries: ${ALL_QUERIES.length}\n`);

// Pseudo-random seeded shuffle for reproducible library building
function seededShuffle(array, seed) {
  let m = array.length, t, i;
  while (m) {
    i = Math.floor(Math.abs(Math.sin(seed++) * 10000)) % m--;
    t = array[m]; array[m] = array[i]; array[i] = t;
  }
  return array;
}

function buildLibrary(size, seed) {
  const nFillers = Math.max(0, size - TARGET_SKILLS.length);
  const fillers  = seededShuffle(HQ_FILLERS, seed).slice(0, nFillers);
  return seededShuffle([...TARGET_SKILLS, ...fillers], seed+1);
}

function buildPrompt(item, library, condition) {
  const tools = library.map(s => {
    let desc = `- ${s.id}: ${s.concept}`;
    if (condition === 'expert') desc += ` Distinct from others because: ${s.disambiguator} Example: ${s.example}`;
    return desc;
  }).join('\n');
  return `You are a strict JSON routing engine. Map the user's query to exactly one of the available skill IDs.
  
Available skills:
${tools}

Respond ONLY with the exact skill ID in plain text. Do not use quotes or backticks.`;
}

function gradeResponse(responseText, library, targetId) {
  if (!responseText) return { chosen: null, correct: false };
  const norm = s => s.toLowerCase().replace(/[^a-z0-9_]/g,'');
  const r    = norm(responseText);
  const exact = library.find(s => norm(s.id) === r);
  if (exact) return { chosen: exact.id, correct: exact.id === targetId };
  const partial = library.find(s => r.includes(norm(s.id)));
  if (partial) return { chosen: partial.id, correct: partial.id === targetId };
  return { chosen: null, correct: false };
}

async function callModel(systemPrompt, userPrompt, retries = 4) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0,
          max_tokens: 50,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt   },
          ]
        }),
      });
      if (res.status === 429) { await new Promise(r => setTimeout(r, (attempt+1)*5000)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0,200)}`);
      const data = await res.json();
      return (data.choices?.[0]?.message?.content || '').trim();
    } catch(e) {
      if (attempt === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// Wilson Score Interval (95% CI)
function wilsonCI(correct, n) {
  if (n === 0) return { lo: 0, hi: 0 };
  const z = 1.96, p = correct/n;
  const denominator = 1 + z*z/n;
  const center = p + z*z/(2*n);
  const diff = z * Math.sqrt((p*(1-p)/n) + (z*z/(4*n*n)));
  return { lo: (center - diff)/denominator * 100, hi: (center + diff)/denominator * 100 };
}

async function runSweep() {
  const SIZES = [5, 20, 50];
  const CONDITIONS = ['bare', 'expert'];
  const results = {};
  const logs = [];

  const totalCalls = SIZES.length * CONDITIONS.length * ALL_QUERIES.length;
  let done = 0;
  const startTime = Date.now();

  for (const size of SIZES) {
    results[size] = {};
    for (const condition of CONDITIONS) {
      const library = buildLibrary(size, size + condition.length);
      console.log(`\n── size=${size} (${condition}) ──`);
      
      let correct = 0;
      
      const MAX_CONCURRENT = 12;
      for (let i = 0; i < ALL_QUERIES.length; i += MAX_CONCURRENT) {
        const batch = ALL_QUERIES.slice(i, i + MAX_CONCURRENT);
        await Promise.all(batch.map(async (item) => {
          const system = buildPrompt(item, library, condition);
          let raw = '', chosen = null, ok = false, errMsg = null;
          try {
            raw = await callModel(system, item.query);
            ({chosen, correct:ok} = gradeResponse(raw, library, item.targetId));
            if (ok) correct++;
          } catch(e) { errMsg = String(e.message||e); }

          done++;
          const elapsed = Math.round((Date.now()-startTime)/1000);
          const pct = ((done/totalCalls)*100).toFixed(1);
          const icon = errMsg ? '!' : ok ? '✓' : '✗';
          if (!ok) console.log(`  [${done}/${totalCalls} ${pct}% | ${elapsed}s] ${condition} ${icon} "${item.query.slice(0,35)}…" → ${chosen??errMsg??'null'} (want: ${item.targetId})`);
          logs.push({size, condition, query: item.query, target: item.targetId, chosen, correct: ok, err: errMsg});
        }));
      }
      
      const ci = wilsonCI(correct, ALL_QUERIES.length);
      results[size][condition] = {
        correct, total: ALL_QUERIES.length, 
        accuracy: (correct/ALL_QUERIES.length*100).toFixed(1),
        ci95_lo: ci.lo.toFixed(1), ci95_hi: ci.hi.toFixed(1)
      };
      console.log(`  → ${condition}: ${correct}/${ALL_QUERIES.length} = ${results[size][condition].accuracy}%`);
    }
  }

  writeFileSync('./results_phase1_collapse.json', JSON.stringify({ model: MODEL, methodology: 'phase1_100targets', results, logs }, null, 2));
  console.log('\nSaved → results_phase1_collapse.json');
}

runSweep().catch(console.error);
