# Strategy Framework - Implementation Summary

**Date:** 2025-11-23
**Status:** ✅ Complete and tested

---

## What We Built

A modular testing framework for comparing brightness-based token importance scoring strategies on captured attention data.

### Components Created

1. **`base_strategy.py`** - Abstract base class
   - Defines interface all strategies must implement
   - Provides common utilities (load data, aggregate attention, group sentences)
   - Handles export (markdown + JSON)

2. **`voting_strategy.py`** - Rolling mean voting system
   - Discrete vote counts per token
   - +1 vote when attention > local mean per step
   - Min-distance filter to eliminate local wave bias

3. **`cumulative_strategy.py`** - Accumulate with decay
   - Continuous scores (raw logits)
   - Accumulate weighted attention - decay per step
   - Distance weighting (logarithmic, linear, etc.)

4. **`run_comparison.py`** - Execute all strategies
   - Runs multiple strategies on same capture
   - Generates individual reports per strategy
   - Produces side-by-side comparison with agreement analysis

5. **`README.md`** - Documentation

---

## File Structure

```
tests/strategy_framework/
├── base_strategy.py          # Abstract interface
├── voting_strategy.py         # Strategy 1
├── cumulative_strategy.py     # Strategy 2
├── run_comparison.py          # Comparison runner
├── README.md                  # Usage docs
├── IMPLEMENTATION_SUMMARY.md  # This file
└── test_results/              # Generated reports
    └── capture_1763842540750/
        ├── voting_strategy.md
        ├── voting_strategy.json
        ├── cumulative_strategy.md
        ├── cumulative_strategy.json
        └── comparison_report.md
```

---

## Test Results - capture_1763842540750

**Data:** 1,703 tokens, 326 generation steps, 70 sentences

### Score Statistics

| Strategy | Min | Max | Mean | Median |
|----------|-----|-----|------|--------|
| Voting | 1.00 | 326.00 | 44.01 | 26.00 |
| Cumulative | -0.83 | 241.37 | 0.67 | 0.08 |

### Top 10 Convergence

**8 out of 10 sentences agreed** by both strategies:
- Turn 0, Sentence 0 - System prompt
- Turn 0, Sentence 1 - System prompt continuation
- Turn 1, Sentence 1 - Article title
- Turn 1, Sentence 2 - Main content
- Turn 1, Sentence 3 - Byline
- Turn 1, Sentence 4 - Article content
- Turn 1, Sentence 5 - Key claims
- Turn 1, Sentence 6 - Consequences

**Disagreement (2 sentences):**
- **Cumulative uniquely ranks high:**
  - Turn 1, Sentence 0 - User's question ("What are the implications...")
  - Turn 1, Sentence 11 - Call to action ("TAKE ACTION Tell USPTO...")

### Key Observations

1. **Strong agreement on article content** - Both strategies identify the core claims and key entities

2. **Cumulative favors user context** - Cumulative strategy ranks the user's question higher, voting doesn't

3. **Score distributions differ dramatically:**
   - Voting: Integer counts, wide range (1-326)
   - Cumulative: Continuous, narrow range (-0.83 to 241.37), heavy tail toward 0

4. **Negative scores in cumulative** - Tokens can go negative with decay, representing "forgotten" content

5. **Both filter local wave** - Min-distance parameters differ (Voting: 50, Cumulative: 20) but both avoid local attention inflation

---

## How to Use

### Run single strategy:

```bash
cd tests/strategy_framework

# Voting
python3 voting_strategy.py ../captures/Capture_Data/capture_1763842540750 50

# Cumulative
python3 cumulative_strategy.py ../captures/Capture_Data/capture_1763842540750 0.003 20
```

### Run comparison:

```bash
python3 run_comparison.py ../captures/Capture_Data/capture_1763842540750
```

### Add new strategy:

1. Create `my_strategy.py` inheriting from `BrightnessStrategy`
2. Implement `compute_scores()` and `get_strategy_name()`
3. Add to `run_comparison.py` strategies list
4. Run comparison

---

## Design Decisions

### Why separate frontend from analysis?

Frontend (`js/`) stays unchanged - it's just a data capture pipeline. All research happens in Python scripts. Once we determine the best strategy, we integrate it back into frontend.

### Why markdown + JSON output?

- **Markdown** - Human-readable for qualitative evaluation
- **JSON** - Machine-readable for quantitative analysis and plotting

### Why base class abstraction?

Makes it trivial to add new strategies and compare them fairly on same data with same tooling.

### Why sentence-level aggregation?

Individual token scores are noisy. Peak score per sentence gives stable comparison unit and matches pruning granularity.

---

## Next Steps

### Immediate:
1. ✅ Framework implemented and tested
2. ⏳ Run on more captures (different conversation types)
3. ⏳ Analyze which strategy better identifies anchors
4. ⏳ Document findings in BRIGHTNESS_STRATEGIES.md

### Medium term:
1. Implement hybrid strategies:
   - Votes weighted by magnitude
   - Exponential decay vs additive
   - Different aggregation modes (max vs mean)
2. Test parameter sensitivity
3. Generate visualizations (score distributions, rank correlations)

### Long term:
1. Collect ground truth labels (manual annotation of important content)
2. Compute precision/recall metrics
3. Regeneration quality testing (prune context, measure output degradation)
4. Integrate best strategy into frontend for real-time pruning

---

## Open Questions

1. **Why does cumulative have such narrow score range?**
   - Decay rate 0.003 * 326 steps = ~0.98 total decay
   - Most tokens barely accumulate before decaying
   - May need to adjust decay rate or aggregation mode

2. **Why does voting agree so strongly with cumulative?**
   - Both filter local wave (different thresholds)
   - Both use mean aggregation
   - Suggests core content is robustly identifiable

3. **Should we trust cumulative's lower scores?**
   - Negative scores represent active forgetting
   - Could be valuable signal for pruning
   - Need to validate with regeneration testing

4. **Is sentence detection accurate?**
   - Currently tokenizer-based with abbreviation detection
   - May not match semantic boundaries
   - Consider alternative segmentation (attention-based clustering?)

---

## Technical Notes

### Performance
- ~2-3 seconds per strategy for 1,703 token capture
- Scalable to much larger captures

### Dependencies
- Python 3.x
- numpy
- Standard library only (no heavy ML frameworks)

### Memory
- Loads full attention tensors per token file
- Peak memory ~500MB for large captures
- Could stream if memory becomes issue

---

## Credits

**Concept:** Brightness-based context culling to replace FIFO/summarization
**Frontend:** Pure vanilla JS, KoboldCPP backend
**Analysis:** Python strategy framework for comparative evaluation
**Status:** Research phase - determining optimal strategy before production integration

---

**Last Updated:** 2025-11-23
**Test Coverage:** 1 capture (1,703 tokens)
**Next Test:** Capture with code generation, chat conversation, or Q&A
