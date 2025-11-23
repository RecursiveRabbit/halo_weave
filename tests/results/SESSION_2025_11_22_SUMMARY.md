# Session Summary: 2025-11-22

## What We Did

### 1. Fixed Attention Extraction Bug in KoboldCPP
- **Problem:** GPU/CPU race condition causing 47% data corruption
- **Fix:** Added `ggml_backend_sched_synchronize()` before tensor read
- **Location:** `/home/evans/Coding_Projects/koboldcpp/src/llama-context.cpp:798`
- **Result:** 100% clean attention data in subsequent captures

### 2. Built Stream-to-Disk Capture System
- **Problem:** Browser crashes on 820MB JSON stringify
- **Solution:** Write one file per token during generation
- **Architecture:**
  - `save_server.py` on port 8081
  - `data_capture.js` POSTs each token immediately
  - Files: `Capture_Data/capture_<timestamp>/token_00000.json`, etc.
- **Result:** Can capture unlimited tokens

### 3. Developed Anchor Token Algorithm
- **Method:** Rolling average voting
  - For each generation step, calculate local mean attention
  - Award +1 vote to tokens above local mean
  - Sum votes across all 326 generation steps
  - Group by (turn_id, sentence_id), take peak vote
- **Output:** Sentences ranked by peak anchor score

### 4. Ran Test Analysis
- **Data:** 1,703 token article, 326 generation steps
- **Results:**
  - 59/82 sentences (72%) had peak = 0 → Never referenced
  - 23/82 sentences (28%) had peak > 0 → Referenced at least once
  - The 23 anchor sentences: 421 tokens (24.7% of original)

## Key Files

**Analysis Scripts:**
- `find_anchors.py` - Token voting
- `show_worst_sentences.py` - Sentence ranking
- `extract_anchor_sentences.py` - Extract anchors
- `analyze_attention.py` - Statistics
- `find_transitions.py` - Race condition detection

**Results:**
- `ANCHOR_TEST_RESULTS.md` - Full test results with extracted sentences
- `ATTENTION_MYSTERY.md` - Race condition investigation
- `Capture_Data/capture_1763842540750/` - Clean test data (1,703 tokens)

**KoboldCPP Fix:**
- `ATTENTION_RACE_CONDITION_BUG.md` - Bug documentation
- `ATTENTION_RACE_FIX.patch` - The fix
- `TEST_ATTENTION_FIX.md` - Testing protocol

## Findings

**What the model references (peak > 0):**
- System prompt
- Byline ("By Joe Mullin")
- Main topic (USPTO rules)
- Key entities (patent trolls, EFF)
- Core consequences
- Call to action

**What the model ignores (peak = 0):**
- Explanatory sections
- Case examples (3 detailed stories)
- Historical context
- Verbose elaborations
- 72% of the content

## Bug Fixed

`sentence_id` resets per turn. Must group by `(turn_id, sentence_id)` not just `sentence_id`.

## Limitations

- Single test conversation (1,703 tokens)
- One model (Qwen2.5-VL-7B)
- No validation of pruned output quality
- Sentence boundaries from tokenizer may not be semantic

## Next Steps

- Test with more conversations
- A/B test: Generate with full vs pruned context
- Integrate into frontend
- Add auto-pruning when context exceeds limit
