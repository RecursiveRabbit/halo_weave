# Halo Weave Test Framework

This directory contains analysis scripts, test results, and captured data for evaluating anchor token detection algorithms.

## Directory Structure

### `analysis_scripts/`
Python scripts for analyzing attention patterns and identifying anchor tokens:

- **`find_anchors.py`** - Core anchor detection using rolling average voting
  - Usage: `python3 find_anchors.py <capture_dir> [top_n] [min_distance]`
  - Outputs: Top anchor tokens ranked by vote count

- **`extract_anchor_sentences.py`** - Extract sentences with peak votes > 0
  - Usage: `python3 extract_anchor_sentences.py <capture_dir>`

- **`show_sentences.py`** - Display sentence boundaries from metadata
  - Usage: `python3 show_sentences.py <metadata.json>`

- **`show_pruned_article.py`** - Show before/after pruning comparison
  - Usage: `python3 show_pruned_article.py <capture_dir>`

- **`show_worst_sentences.py`** - Rank sentences by peak brightness (ascending)

- **`inspect_tokens.py`** - Debug individual token tokenization

- **`analyze_attention.py`** - Statistical analysis of attention values

- **`find_transitions.py`** - Detect normalized vs raw logit transitions (race condition detection)

- **`visualize_anchors.py`** - Generate attention heatmap visualizations

### `results/`
Test results and analysis documentation:

- **`ANCHOR_TEST_RESULTS.md`** - Full anchor token test results with extracted sentences
- **`SESSION_2025_11_22_SUMMARY.md`** - Session summary including KoboldCPP bug fix
- **`ATTENTION_MYSTERY.md`** - Investigation of GPU/CPU race condition
- **`DATA_CAPTURE_GUIDE.md`** - How to use stream-to-disk capture system
- **`SESSION_NOTES_2025-11-21.md`** - Earlier session notes
- **`article.md`** - Test article used for analysis
- **`anchor_sentences_corrected.txt`** - Extracted anchor sentences

### `captures/`
Raw attention data captured during generation:

- **`Capture_Data/`** - Directory containing individual capture sessions
  - Each capture has format: `capture_<timestamp>/`
  - Contains: `metadata.json` and `token_XXXXX.json` files

- **`halo_weave_1763681849744.json`** - Legacy capture format (pre-streaming)

## Current State

### ✅ What Works
- Sentence boundary detection (fixed abbreviations and bare punctuation)
- Stream-to-disk data capture (no memory overflow)
- Anchor token detection using rolling average voting
- Min-distance filtering to exclude local attention wave

### ⚠️ Current Limitations

**The Local Attention Wave Problem:**
- Article tokens (prompt) never experience the local attention wave during processing
- Assistant tokens get full wave treatment during generation
- Result: Assistant tokens are artificially bright, article tokens artificially dim
- Current workaround: `min_distance=50` filter (not aggressive enough)

**Root Cause:** No attention capture during prompt ingestion in KoboldCPP

**Solution:** Need to modify KoboldCPP to capture attention during prompt processing, not just generation.

## Key Findings

From test captures (1,700+ tokens):
- **85% of article content** can be pruned based on anchor scores
- **Top anchors:** BOS token, byline, main thesis, call-to-action
- **Pruned content:** Case examples, explanatory sections, historical context
- Anchor scores are **dynamic** - change based on conversation context

## Running Analysis

```bash
# 1. Start capture (in frontend)
# 2. Generate tokens
# 3. Stop capture

# 4. Analyze anchors
cd tests/analysis_scripts
python3 find_anchors.py ../captures/Capture_Data/capture_<timestamp> 30 50

# 5. Show pruned article
python3 show_pruned_article.py ../captures/Capture_Data/capture_<timestamp>

# 6. Show sentence breakdown
python3 show_sentences.py ../captures/Capture_Data/capture_<timestamp>/metadata.json
```

## Next Steps

1. **Fix KoboldCPP:** Add attention capture during prompt processing
2. **Test with prompt attention:** Re-run analysis with fair comparison
3. **Tune min_distance:** Find optimal value to exclude local wave
4. **Validate pruning:** Generate with pruned vs full context, compare quality
5. **Integrate into frontend:** Auto-prune when context exceeds limit
