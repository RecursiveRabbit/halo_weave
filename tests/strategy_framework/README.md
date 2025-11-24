# Brightness Strategy Testing Framework

Framework for comparing different token importance scoring strategies on captured attention data.

## Overview

Each strategy computes a "brightness" score for every token, then ranks sentences by their peak token score. This framework allows running multiple strategies on the same capture data and comparing results side-by-side.

## Architecture

### Base Class: `base_strategy.py`

Abstract interface that all strategies must implement:

```python
class BrightnessStrategy(ABC):
    @abstractmethod
    def compute_scores(self) -> Dict[int, float]:
        """Return {position: score} mapping"""
        pass

    @abstractmethod
    def get_strategy_name(self) -> str:
        """Return human-readable strategy name"""
        pass
```

Provides common functionality:
- Load capture metadata and token files
- Aggregate attention across layers/heads
- Group tokens into sentences
- Export markdown and JSON reports

### Strategies

**1. Voting Strategy (`voting_strategy.py`)**
- Discrete vote counts (integer scores)
- +1 vote per generation step if attention > local mean
- Min-distance filter to eliminate local wave bias
- Measures frequency: "How often was this referenced?"

**2. Cumulative Strategy (`cumulative_strategy.py`)**
- Continuous scores (raw logits)
- Accumulate weighted attention with decay
- Distance weighting to filter local attention
- Measures magnitude: "How much attention was paid?"

### Comparison Runner: `run_comparison.py`

Runs all strategies on same capture, generates:
- Individual reports (markdown + JSON) per strategy
- Side-by-side comparison with agreement/disagreement analysis

## Usage

### Run Single Strategy

```bash
# Voting strategy
python3 voting_strategy.py Capture_Data/capture_1763842540750 50
# Args: <capture_dir> [min_distance]

# Cumulative strategy
python3 cumulative_strategy.py Capture_Data/capture_1763842540750 0.003 20
# Args: <capture_dir> [decay_rate] [min_distance]
```

### Run All Strategies (Comparison)

```bash
python3 run_comparison.py Capture_Data/capture_1763842540750
```

This generates:
```
test_results/capture_1763842540750/
├── voting_strategy.md           # Human-readable rankings
├── voting_strategy.json         # Machine-readable data
├── cumulative_strategy.md       # Human-readable rankings
├── cumulative_strategy.json     # Machine-readable data
└── comparison_report.md         # Side-by-side analysis
```

## Output Formats

### Markdown Reports (`.md`)

Human-readable sentence rankings:

```markdown
**Rank 1 - Turn 0, Sentence 0** (Score: 326.00, 20 tokens, system)
```
system
You are Qwen, an AI participating in...
```
```

### JSON Data (`.json`)

Machine-readable for data science:

```json
{
  "metadata": {
    "strategy": "Rolling Mean Voting",
    "parameters": {"min_distance": 50},
    "score_stats": {"min": 0, "max": 326, "mean": 42.5}
  },
  "sentences": [
    {
      "turn_id": 0,
      "sentence_id": 0,
      "score": 326,
      "text": "...",
      "tokens": [...]
    }
  ]
}
```

### Comparison Report

Side-by-side rankings table:

| Rank | Voting | Cumulative |
|------|--------|------------|
| 1    | T0:S0 (326) | T0:S0 (450.2) |
| 2    | T2:S5 (284) | T2:S5 (402.8) |

Plus agreement/disagreement analysis showing where strategies converge or differ.

## Adding New Strategies

1. **Create new file** `my_strategy.py`
2. **Inherit from base:**
   ```python
   from base_strategy import BrightnessStrategy

   class MyStrategy(BrightnessStrategy):
       def get_strategy_name(self):
           return "My Strategy"

       def compute_scores(self):
           # Your algorithm here
           return {position: score}
   ```
3. **Add to `run_comparison.py`:**
   ```python
   strategy = MyStrategy(capture_dir, param1=value1)
   sentences, metadata = strategy.run()
   strategies_results['MyStrategy'] = (sentences, metadata)
   ```

## Strategy Parameters

### Voting Strategy

- `min_distance` (default 50) - Only count votes for tokens this far behind generation head

### Cumulative Strategy

- `decay_rate` (default 0.003) - Decay per step
- `decay_mode` (default 'additive') - 'additive', 'exponential', or 'none'
- `distance_mode` (default 'logarithmic') - 'none', 'threshold', 'linear', 'logarithmic', 'square_root'
- `min_distance` (default 20) - Minimum distance for distance weighting
- `distance_scale` (default 10.0) - Scale factor for distance weighting

## Evaluation Metrics

### Qualitative

- Read ranked sentences, judge if important content surfaces
- Check if pruned content (low scores) is actually unimportant
- Test if top-ranked sentences preserve conversation meaning

### Quantitative (Future)

- **Precision/Recall** - Requires manual ground truth labels
- **Context reduction** - Pruned tokens / total tokens
- **Regeneration quality** - Compare generation with full vs pruned context

## Open Questions

1. **Which strategy is correct?** - Probably neither, truth is somewhere between
2. **Can we combine them?** - Hybrid approach weighting votes by magnitude?
3. **How to validate?** - Need ground truth or regeneration testing
4. **Model-specific?** - Do different models need different strategies?
5. **Conversation-specific?** - Does strategy choice depend on conversation type?

## Current Status (2025-11-23)

- ✅ Framework implemented
- ✅ Two strategies ready to test
- ⏳ Need to run comparison on existing captures
- ⏳ Need to analyze results and document findings
- ⏳ Need to test on diverse conversation types
- ⏳ Need ground truth data for quantitative evaluation

## Next Steps

1. Run `run_comparison.py` on existing captures
2. Manually evaluate which strategy identifies better anchors
3. Test on diverse conversation types (code, chat, Q&A)
4. Implement hybrid strategies based on findings
5. Integrate best strategy into frontend for real-time pruning
