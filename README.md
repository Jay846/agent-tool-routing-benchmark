# Agent Tool Routing Benchmark: The "Skill Phase Transition"

This repository contains the empirical data, evaluation scripts, and target datasets supporting the pre-print paper on the "Skill Phase Transition" in LLM orchestration.

## Abstract
The AI industry is currently heavily reliant on "Monolithic Routing"—injecting thousands of tool schemas into a single Large Language Model's (LLM) context window. This benchmark proves empirically that this architecture is a massive liability. We expose a phenomenon called the **"Skill Phase Transition"**: a critical density threshold where an LLM's routing accuracy completely falls off a cliff. Through ruthless benchmarking of frontier models (GPT-4o-mini, Claude 4.5 Haiku, Gemini 3.1 Flash-Lite, and DeepSeek V4) across scaling libraries (from 5 to 2,000 tools), we found that while models are nearly flawless at small scales ($N \le 100$), they catastrophically collapse when pushed to enterprise limits ($N \ge 1000$). 

The only viable path forward for production systems is abandoning flat context windows and shifting to modular, deterministic LangGraph-style architectures.

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

## How to Cite

If you use this dataset or benchmark in your research, please link directly to this repository.

## License

Code is released under the MIT License. Data is released under CC-BY 4.0.
