// Google AI Studio Gemini multi-model runner
// Reuses hq_fillers.json and the same fixed methodology as runner_v2.js

import { readFileSync, writeFileSync } from 'fs';

const GEMINI_KEY    = 'AIzaSyCQfThf98F893otxatXKroqh1k2ypxxOEc';
const MODEL_ID      = 'gemini-2.5-flash';
const OUT_FILE      = `results_gemini_2_5_flash.json`;
const GEMINI_URL    = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent?key=${GEMINI_KEY}`;

const TARGET_SKILLS = [
  { id: 'funding_rate_extreme',      concept: 'Flags when perp funding rate is at a statistical extreme, signaling crowded leveraged positioning.', disambiguator: 'Only fires on extremes (top/bottom percentile of trailing history), not gradual drift.', example: 'BTC funding just hit the 98th percentile of its 90-day range.', queries: ["funding on ETH perps looks really stretched right now, is this an extreme reading?", "check if funding rate is at an unusual extreme before I fade the crowd"] },
  { id: 'cvd_divergence',            concept: 'Detects divergence between cumulative volume delta and price, implying hidden absorption or distribution.', disambiguator: 'Compares CVD trend against price trend to find mismatches, unlike a raw volume spike alert.', example: 'price made a new high but CVD failed to confirm it.', queries: ["price is pushing higher but I don't think buyers are really there, can you check CVD against price?", "is there a bearish divergence between volume delta and price on this pair?"] },
  { id: 'liquidation_cascade_setup', concept: 'Estimates the probability that resting stop/liquidation clusters could trigger a fast cascade move.', disambiguator: 'Looks at book thinness plus estimated leveraged position clustering near price, not general volatility.', example: 'book depth thins out sharply 2% below spot where a lot of longs are likely stopped.', queries: ["does the book look thin enough right now for a liquidation cascade if price dips 2%?", "check whether there's stop-hunt or cascade risk building below current price"] },
  { id: 'kelly_position_size',       concept: 'Computes the Kelly-optimal position size given estimated edge, win probability, and payoff ratio.', disambiguator: 'A sizing calculation that takes an edge as input, rather than a signal generator that produces one.', example: '55% win probability, 1.8:1 payoff, what fraction of capital to risk.', queries: ["given a 55% edge and 1.8 to 1 payoff, what's my optimal bet size?", "help me size this position using the Kelly criterion"] },
  { id: 'lookahead_bias_audit',      concept: 'Audits a backtest script for lookahead bias, such as using future bars or improperly shifted indicators.', disambiguator: 'A code/methodology review task operating on strategy logic, not a live market signal.', example: 'a rolling z-score that includes the current bar in its own window.', queries: ["can you check my backtest code for any lookahead bias?", "I think my indicator might be peeking at the future bar, can you audit it?"] },
  { id: 'atr_dynamic_stop',          concept: 'Computes ATR-based stop-loss and take-profit distances that scale with current volatility.', disambiguator: 'Sets an initial distance from volatility; distinct from a trailing stop, which adjusts as price moves.', example: 'ATR(14) is 340 points, stop at 1.5x ATR.', queries: ["what stop distance should I use given the current ATR?", "help me set a volatility-adjusted stop loss"] },
  { id: 'order_flow_imbalance',      concept: 'Computes short-term buy/sell order flow imbalance from L2 order book updates.', disambiguator: 'Uses raw book add/cancel/execute events over a short window, not aggregated trade volume.', example: 'bid-side additions outpacing ask-side 3 to 1 over the last 500ms.', queries: ["what does short-term order flow imbalance look like on the book right now?", "check if there's a buy-side imbalance forming in the order book"] },
  { id: 'micro_price_estimate',      concept: 'Computes the size-weighted micro-price from top-of-book bid/ask as a fair-value estimate.', disambiguator: 'A single fair-value point estimate for execution reference, not a trend or imbalance signal.', example: 'best bid 100 at size 40, best ask 100.02 at size 10.', queries: ["what's the micro-price given the current best bid and ask sizes?", "compute a size-weighted fair value from the top of book"] },
  { id: 'trade_ev_calculator',       concept: 'Computes expected value of a proposed trade given probability of success, payoff, and transaction costs.', disambiguator: 'Validates whether an edge is positive at all, unlike Kelly sizing which assumes the edge and sizes it.', example: '60% chance of +2%, 40% chance of -1%, minus 0.1% round-trip fees.', queries: ["is this trade positive EV after fees -- 60% chance of plus 2%, 40% chance of minus 1%?", "calculate expected value for this setup including transaction costs"] },
  { id: 'trailing_stop_logic',       concept: 'Implements trailing stop logic that ratchets a stop level as price moves favorably, never loosening.', disambiguator: 'Adjusts dynamically as a trade progresses, unlike ATR dynamic stop which sets one static initial distance.', example: 'price has moved 3% in my favor since entry.', queries: ["how should my trailing stop adjust now that the trade is up 3%?", "update the trailing stop given price moved in my favor"] },
  { id: 'funding_time_to_settle',    concept: 'Tracks time remaining until the next perpetual funding settlement and expected payment direction.', disambiguator: 'About timing of the funding event itself, not whether the funding rate level is extreme.', example: '42 minutes to next funding, current rate implies longs pay shorts.', queries: ["how long until the next funding payment and which side pays?", "when does funding settle next on this perp?"] },
  { id: 'backtest_walkforward_split',concept: 'Splits historical data into walk-forward train/test windows to avoid shuffling across time.', disambiguator: 'About the train/test split methodology itself, distinct from auditing feature computation for leakage.', example: '6 months train, 1 month test, rolled forward monthly.', queries: ["set up a walk-forward split for my backtest, 6 months train 1 month test", "how should I split this time series so I don't shuffle across time?"] },
];

const HQ_FILLERS = JSON.parse(readFileSync('./hq_fillers.json', 'utf8'));

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
  // Extract just the ID if it gave a long thought process
  const words = responseText.replace(/[^a-zA-Z0-9_]/g, ' ').split(' ').filter(w => w.length > 3);
  
  const norm = s => s.toLowerCase().replace(/[^a-z0-9_]/g,'');
  
  // Try to find the exact targetId in the last 10 words (usually the answer is at the end)
  const lastWords = words.slice(-10);
  for (const w of [...lastWords].reverse()) {
      const exact = library.find(s => norm(s.id) === norm(w));
      if (exact) return { chosen: exact.id, correct: exact.id === targetId };
  }
  
  // fallback parsing logic
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

async function callModel(systemPrompt, userPrompt, retries=15) {
  for (let attempt=0; attempt<retries; attempt++) {
    try {
      const res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 500
          }
        }),
      });
      const data = await res.json();
      if (res.status === 429 || data.error?.code === 429) { 
        await new Promise(r=>setTimeout(r,(attempt+1)*15000)); 
        continue; 
      }
      if (data.error) throw new Error(`API Error: ${data.error.message}`);
      return (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    } catch(e) {
      if (attempt===retries-1) throw e;
      await new Promise(r=>setTimeout(r,5000));
    }
  }
}

const ALL_QUERIES = TARGET_SKILLS.flatMap(s => s.queries.map(q => ({targetId:s.id, query:q})));
const SIZES       = [5, 130, 500];
const CONDITIONS  = ['bare','expert'];
const totalCalls  = SIZES.length * CONDITIONS.length * ALL_QUERIES.length;

console.log('='.repeat(60));
console.log(` Model: Google ${MODEL_ID}`);
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
  console.log(`\n── size=${size}  (${library.length} skills: 12 target + ${library.length-12} HQ fillers) ──`);

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
      
      // Delay to respect 15 RPM free tier
      await new Promise(r=>setTimeout(r,4000));
    }
    const ci=wilsonCI(correct, ALL_QUERIES.length);
    results[size][condition]={correct,total:ALL_QUERIES.length,accuracy:(correct/ALL_QUERIES.length*100).toFixed(1),ci95_lo:ci.lo.toFixed(1),ci95_hi:ci.hi.toFixed(1)};
    console.log(`  → ${condition}: ${correct}/${ALL_QUERIES.length} = ${results[size][condition].accuracy}%  [95%CI: ${ci.lo.toFixed(1)}–${ci.hi.toFixed(1)}%]`);
  }
}

const elapsed=((Date.now()-t0)/1000).toFixed(1);
console.log(`\n${'='.repeat(60)}\n Done in ${elapsed}s\n${'='.repeat(60)}\n`);

// Summary table
console.log(`RESULTS — ${MODEL_ID}`);
console.log(`${'size'.padEnd(6)} ${'bare'.padEnd(8)} ${'bare CI'.padEnd(18)} ${'expert'.padEnd(8)} expert CI`);
console.log('─'.repeat(60));
for (const size of SIZES) {
  const b=results[size]?.bare, e=results[size]?.expert;
  if (!b||!e) continue;
  console.log(`${String(size).padEnd(6)} ${(b.accuracy+'%').padEnd(8)} [${b.ci95_lo}–${b.ci95_hi}%]`.padEnd(30)+`  ${(e.accuracy+'%').padEnd(8)} [${e.ci95_lo}–${e.ci95_hi}%]`);
}

writeFileSync('./'+OUT_FILE, JSON.stringify({model:MODEL_ID, methodology:'v2-fixed', generatedAt:new Date().toISOString(), results, logs}, null, 2));
console.log(`\nSaved → ${OUT_FILE}`);
