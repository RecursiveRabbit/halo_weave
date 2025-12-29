# Brightness Scoring Strategies

## Overview

We have two distinct approaches to scoring token importance. Each has different properties and may excel in different scenarios.

---

## Strategy 1: Cumulative Brightness (Frontend)

**Location:** `js/attention_tracker.js`

**Algorithm:**
```javascript
// Per generation step, for each token:
score_new = score_old + weighted_attention - decay

Where:
- weighted_attention = aggregate(attention) * distance_weight(distance)
- decay = decay_rate (additive) OR score_old * decay_rate (exponential)
```

**Properties:**
- **Continuous scores** - Can be any real number (especially with raw logits)
- **Magnitude-based** - Captures HOW MUCH attention was paid
- **Real-time** - Updates during generation
- **Distance weighting** - Filters local attention wave
- **Decay** - Natural forgetting over time

**Aggregation modes:**
- `mean` - Average across all layers/heads
- `max` - Maximum across all layers/heads
- `last_layer` - Only final layer (average heads)
- `weighted_layers` - Weight later layers more heavily

**Current values (as of 2025-11-23):**
```javascript
{
  aggregationMode: 'mean',
  decayMode: 'additive',
  decayRate: 0.003,
  distanceWeightMode: 'logarithmic',
  minDistance: 20,
  distanceScale: 10.0,
  boostMultiplier: 1.0
}
```

**Initialization:**
- **Current:** Tokens start at `1.0` ("fail bright")
- **Proposed:** Tokens start at `0.0` ("fail dark")

**Strengths:**
- Captures magnitude of attention (one huge spike can keep token alive)
- Real-time scoring during generation
- Tunable decay prevents unbounded growth

**Weaknesses:**
- Sensitive to outlier spikes (one big attention → high score)
- Decay rate is arbitrary (why 0.003?)
- Local attention wave inflates recent tokens dramatically

---

## Strategy 2: Rolling Mean Voting (Analysis Scripts)

**Location:** `tests/analysis_scripts/find_anchors.py`

**Algorithm:**
```python
# Per generation step:
local_mean = mean(attention_values_for_this_step)

for each token:
    if attention > local_mean:
        votes[token] += 1
```

**Properties:**
- **Discrete votes** - Integer counts only
- **Frequency-based** - Captures HOW OFTEN attention was paid
- **Post-hoc** - Runs on captured data after generation
- **Min-distance filter** - Only count votes for tokens far from generation head
- **No decay** - Votes accumulate indefinitely

**Current values (as of 2025-11-23):**
```python
min_distance = 50  # Only count votes for tokens 50+ behind generation head
```

**Initialization:**
- All tokens start at `0 votes`

**Strengths:**
- Robust to outliers (one spike = one vote, same as consistent reference)
- No arbitrary parameters (just "above mean" = vote)
- Min-distance filter eliminates local wave bias entirely
- Simple to interpret (100 votes from 300 steps = 33% consistency)

**Weaknesses:**
- Loses magnitude information (tiny spike = huge spike = 1 vote)
- Post-hoc only (can't run during generation)
- No decay (old references count as much as recent)

---

## Key Differences

| Aspect | Cumulative Brightness | Rolling Mean Voting |
|--------|----------------------|---------------------|
| **Output** | Continuous scores | Integer vote counts |
| **Measures** | Magnitude (how much) | Frequency (how often) |
| **Timing** | Real-time during generation | Post-hoc analysis |
| **Outliers** | Sensitive (one spike → high score) | Robust (one spike = 1 vote) |
| **Decay** | Yes (configurable) | No (votes accumulate forever) |
| **Local wave** | Distance weighting (partial fix) | Min-distance filter (complete fix) |
| **Interpretability** | Raw logit scores (hard to interpret) | Vote percentage (easy to interpret) |

---

## Current Turn Immunity Problem (NEW)

**The Problem:**
Tokens in the current turn accumulate huge attention during their own generation (the "local attention wave"). This creates unfair comparison between:
- **Prompt tokens** - Never experienced local wave during their processing
- **Assistant tokens** - Get full wave during generation (10-50x brighter)

**Proposed Solution:**
Skip attention accumulation for tokens in `current_turn_id`:

```javascript
if (token.turn_id === current_turn_id) {
    continue;  // Don't accumulate during your own turn
}
```

**Impact:**
- Eliminates local wave bias completely
- All tokens judged by future references only
- Current turn appears "dim" until next turn (correct behavior)

**Applies to:**
- ✅ Strategy 1 (cumulative brightness) - Add turn check to `attention_tracker.js`
- ✅ Strategy 2 (rolling mean voting) - Already implemented via min-distance filter

---

## Testing Framework Proposal

### Goal
Compare strategies objectively on real conversation data to determine which better identifies anchor content.

### Data Requirements
1. **Captured conversations** with full attention tensors
2. **Ground truth labels** (manual annotation of which sentences are important)
3. **Diverse conversation types** (technical, chat, code generation, Q&A)

### Metrics

**Primary:**
- **Precision** - Of pruned content, how much was actually unimportant?
- **Recall** - Of unimportant content, how much did we prune?
- **F1 Score** - Harmonic mean of precision/recall

**Secondary:**
- **Context reduction ratio** - Pruned tokens / total tokens
- **Generation quality** - Does the model still generate coherent responses with pruned context?
- **Computational cost** - Time to compute scores per token

### Test Protocol

1. **Capture conversation** with attention data (already have this)

2. **Run multiple strategies** on same capture:
   ```bash
   # Strategy 1: Cumulative brightness
   python3 test_strategy.py capture_dir --strategy cumulative --decay 0.003

   # Strategy 2: Rolling mean voting
   python3 test_strategy.py capture_dir --strategy voting --min-distance 50

   # Strategy 3: Hybrid (votes weighted by magnitude)
   python3 test_strategy.py capture_dir --strategy hybrid
   ```

3. **Each strategy outputs:**
   - Ranked list of sentences by importance
   - Suggested pruning threshold
   - Pruned context (sentences to delete)

4. **Compare outputs:**
   - Qualitative: Read pruned context, judge if important content lost
   - Quantitative: If ground truth labels exist, compute precision/recall
   - Regeneration test: Prune context, continue conversation, measure coherence

### Proposed Test Harness Structure

```
tests/
├── strategy_framework/
│   ├── base_strategy.py          # Abstract base class
│   ├── cumulative_strategy.py    # Strategy 1
│   ├── voting_strategy.py        # Strategy 2
│   ├── hybrid_strategy.py        # Strategy 3 (future)
│   ├── run_comparison.py         # Run all strategies on same data
│   └── evaluate_results.py       # Compute metrics, generate report
├── captures/                     # Test data (gitignored)
├── ground_truth/                 # Manual annotations (optional)
└── results/                      # Strategy comparison reports
```

---

## Open Questions

1. **Which strategy is "correct"?**
   - Probably neither - truth is somewhere in between
   - May depend on conversation type (code vs chat vs Q&A)

2. **Can we combine them?**
   - Hybrid: Votes weighted by magnitude?
   - Use voting for pruning decisions, cumulative for visualization?

3. **How to handle prompt processing attention?**
   - Current captures only have generation attention
   - Need KoboldCPP modification to capture prompt processing
   - Without this, all strategies are biased

4. **What about semantic boundaries?**
   - Current sentence detection is tokenizer-based
   - May not align with semantic units
   - Could cluster tokens by attention patterns instead?

5. **Decay vs no decay?**
   - Cumulative has decay, voting doesn't
   - Is recent context actually more important?
   - Or do anchors remain stable regardless of age?

6. **Aggregation method matters?**
   - Mean vs max vs last-layer
   - Different strategies might prefer different aggregations
   - Should test all combinations

---

## Recommendations

**Short term:**
1. ✅ Document both systems (this file)
2. Create `base_strategy.py` abstract class
3. Refactor existing approaches to inherit from base
4. Run both on existing captures, compare outputs manually

**Medium term:**
1. Implement strategy comparison harness
2. Capture diverse conversation types
3. Manual annotation of important content (ground truth)
4. Quantitative evaluation with metrics

**Long term:**
1. Test hybrid strategies
2. Integrate best strategy into frontend
3. A/B test with users
4. Adaptive strategies (change behavior based on conversation context)

---

## Current Status (2025-11-23)

- **Strategy 1** - Implemented in frontend, working
- **Strategy 2** - Implemented in analysis scripts, tested on 2 captures
- **Comparison framework** - Not yet implemented
- **Ground truth data** - Does not exist
- **Current turn immunity** - Proposed, not yet implemented

---

## Next Steps

1. Create abstract base class for strategies
2. Refactor `find_anchors.py` to use base class
3. Refactor `attention_tracker.js` logic into Python for fair comparison
4. Run side-by-side comparison on existing captures
5. Document observations and recommend path forward
