 Agent Tool Routing Benchmark: Description Engineering Mitigates Tool-Selection Collapse

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Data License: CC BY 4.0](https://img.shields.io/badge/Data_License-CC_BY_4.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)

This repository accompanies the pre-print "Description Engineering Mitigates Tool-Selection Collapse in Large Language Model Agents" (2026). It contains all benchmark data, evaluation scripts, and results.


## Abstract
The ability of Large Language Model (LLM) agents to reliably select the correct tool from a large, semantically overlapping library is critical for autonomous systems. Recent work identified a "phase transition" in routing accuracy as tool libraries grow beyond ~60 tools, driven by semantic confusability. However, whether the quality of tool descriptions—specifically, expert-authored disambiguation—can mitigate this collapse remains an open question. We construct a two-phase benchmark using quantitative finance skills, scaling from 5 to 2,000 tools with deliberately confusable filler descriptions. In Phase 1 (synthetic, 20 target skills) and Phase 2 (real-world designations, 59 target skills), we evaluate five models from four families (GPT-4o-mini, Claude 4.5 Haiku, Gemini 3.1 Flash-Lite, DeepSeek V4 Flash/V4 Pro) under two conditions: minimal one-line descriptions versus expert-authored descriptions containing explicit boundaries and formulas. At small library sizes (N≤100), all models achieve near-perfect accuracy. At scale (N=1,000-2,000), a significant collapse occurs, but the expert advantage is highly model-dependent. Expert descriptions improve the routing accuracy of models such as GPT-4o-mini, yet they reduce accuracy for Gemini 3.1 Flash-Lite by 7 points and provide little benefit for Claude Haiku. Reasoning-capable models (DeepSeek V4 Pro) remain robust regardless of description quality. These findings demonstrate that description engineering is a low-cost, zero-training intervention that can meaningfully extend an agent's operational tool capacity. Still, its effectiveness is not uniform—practitioners must calibrate the richness of the description to the specific model. We release our benchmark and skill libraries to support further research on scalable, reliable agent routing.


## Repository Structure

- `data/`
  - `generated_targets.json` - Phase 1 (Synthetic) target skills library.
  - `targets_v4.json` - Phase 2 (Real-world Enterprise) target skills library (quantitative finance designations).
  - `hq_fillers.json` - High-quality distractor tool library.
- `prompts/`
  - *(Prompt templates are embedded in the runner scripts as system prompts).*
- `runner/`
  - Evaluation scripts (Node.js) used to benchmark each model. API keys have been scrubbed.
  - `recover_402.js` - Surgical recovery utility for resuming failed API queries during massive sweeps.
- `results/`
  - Raw JSON datasets and text logs containing all accuracy metrics and statistical confidence intervals for every single API call across all models.
- `paper.md`
  - The pre-print draft containing the full empirical analysis and conclusions.

## Cite
> Jay Salvi. Description Engineering Mitigates Tool-Selection Collapse in Large Language Model Agents. TechRxiv, 2026. DOI: [to be added]

## License
Code: MIT. Data: CC BY 4.0.
