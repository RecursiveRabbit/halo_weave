# CLAUDE.md - Halo Weave V2 Development Guide

**For:** Claude Code when working on this project
**Version:** 2.0 - Pure Frontend Edition
**Date:** 2025-11-16

---

## Project Overview

Halo Weave V2 is a **pure frontend application** for visualizing transformer attention patterns and performing brightness-based context pruning. Unlike V1 (attention_heatmap), this version has **no Python backend** - it's just HTML, CSS, and vanilla JavaScript connecting directly to KoboldCPP via WebSocket.

**Status:** ⚠️ **BLOCKED** - Requires KoboldCPP modifications for attention extraction. See `../KOBOLD_API_SPEC.md`.

---

## Architecture

### Stack

- **Frontend:** Vanilla JavaScript (ES6 modules), HTML5, CSS3
- **No build step:** No webpack, no npm, no babel - just native modules
- **Inference backend:** KoboldCPP (separate process)
- **Communication:** WebSocket for streaming, REST for metadata

### Components

```
index.html
  ↓
app.js (Main Controller)
  ├─> kobold_client.js      (API adapter)
  ├─> conversation_state.js (Token dictionary)
  ├─> attention_tracker.js  (Aggregation + decay)
  └─> heatmap.js            (Visualization)
```

**Key principle:** Each module is self-contained with clear responsibilities.

---

## Core Concepts

### 1. Token Dictionary (conversation_state.js)

**Single source of truth** for conversation history. Every token is an object:

```javascript
{
  token: "Hello",
  token_id: 9707,
  position: 42,            // Birth position, never changes
  attention_score: 0.67,   // Accumulated brightness (0-1)
  raw_attention: 0.000123, // Last raw attention from model
  turn_id: 2,
  sentence_id: 0,
  message_role: "user",
  deleted: false           // Soft-delete flag
}
```

**Critical invariants:**
- Position IDs are unique and never reused
- Tokenize once when message added, never retokenize
- Soft-delete: deleted tokens stay in array, marked `deleted=true`
- Fail bright: new tokens start at `attention_score=1.0`

### 2. Attention Tracking (attention_tracker.js)

**Processes attention tensors** from KoboldCPP:

```
Raw tensor [layers, heads, context_length]
  ↓
Aggregate (mean/max/weighted/last_layer)
  ↓
Distance weight (filter local attention)
  ↓
Update: score = old_score + weighted_attention - decay_rate
  ↓
Clamp to [0, 1]
```

**Key insight:** Only backward references matter. Local attention (current sentence) is structural noise.

### 3. Array Index ↔ Position ID Mapping

**The pruning problem:** After deleting tokens, position IDs become non-sequential:

```javascript
// Before pruning
tokens = [
  {position: 0, token: "Hello", deleted: false},
  {position: 1, token: ",", deleted: false},
  {position: 2, token: " world", deleted: false}
]
input_ids = [9707, 11, 1234]

// After pruning position 1
tokens = [
  {position: 0, token: "Hello", deleted: false},
  {position: 1, token: ",", deleted: true},    // DELETED
  {position: 2, token: " world", deleted: false}
]
input_ids = [9707, 1234]  // Position 1 skipped!

// KoboldCPP returns attention indexed by input_ids
attention[0] → input_ids[0] → position 0 ✓
attention[1] → input_ids[1] → position 2 (NOT 1!) ✓
```

**Solution:** `buildIndexToPositionMap()` before generation:

```javascript
const indexToPosition = new Map();  // {0 → 0, 1 → 2}
const activeTokens = conversation.getActiveTokens();
activeTokens.forEach((token, index) => {
  indexToPosition.set(index, token.position);
});
```

### 4. Visualization (heatmap.js)

**Color-coded token rendering:**

```
Dark blue (#001f3f) ← 0.0 (low attention)
  ↓
Cyan (#7fdbff)      ← 0.5 (medium)
  ↓
White (#ffffff)     ← 1.0 (high attention)
```

**Pruning animation:**
1. Red flash (0.1s)
2. Fade to transparent (0.3s)
3. Remove from DOM (0.4s total)

---

## Development Guidelines

### When Modifying conversation_state.js

**DO:**
- ✅ Maintain position uniqueness
- ✅ Preserve deleted tokens in array (soft-delete)
- ✅ Update sentence/line tracking incrementally
- ✅ Keep fail-bright principle (new tokens = 1.0)

**DON'T:**
- ❌ Reuse position IDs
- ❌ Actually remove deleted tokens from array
- ❌ Retokenize existing context
- ❌ Initialize tokens at 0.0 attention

### When Modifying attention_tracker.js

**DO:**
- ✅ Support multiple aggregation modes
- ✅ Apply distance weighting before decay
- ✅ Clamp scores to [0, 1]
- ✅ Make config updateable at runtime

**DON'T:**
- ❌ Normalize automatically (user should control this)
- ❌ Hide transformations (expose all parameters)
- ❌ Assume specific model architecture
- ❌ Modify conversation state directly (return values instead)

### When Modifying kobold_client.js

**DO:**
- ✅ Decode base64 attention correctly
- ✅ Handle WebSocket reconnection
- ✅ Validate model info on connect
- ✅ Support all KOBOLD_API_SPEC endpoints

**DON'T:**
- ❌ Store conversation state (client is stateless)
- ❌ Retry failed requests automatically (let app.js decide)
- ❌ Assume specific model (query /api/v1/model/info)
- ❌ Pre-process attention (return raw data)

### When Modifying heatmap.js

**DO:**
- ✅ Use dataset attributes for element identification
- ✅ Handle missing elements gracefully
- ✅ Support incremental rendering
- ✅ Provide rebuild() for full refresh

**DON'T:**
- ❌ Store application state (visualization only)
- ❌ Mutate conversation_state objects
- ❌ Assume specific DOM structure exists
- ❌ Block UI thread with heavy computation

### When Modifying app.js

**DO:**
- ✅ Coordinate all components
- ✅ Handle errors gracefully (display to user)
- ✅ Save/load settings from localStorage
- ✅ Update status frequently

**DON'T:**
- ❌ Put business logic here (delegate to modules)
- ❌ Bypass component interfaces
- ❌ Block on async operations without feedback
- ❌ Assume KoboldCPP is always available

---

## Configuration Management

### Settings Persistence

**Saved to localStorage:** `halo_weave_config`

**Included:**
- All generation settings (temperature, top-p, max tokens)
- All attention settings (aggregation, decay, distance weighting)
- All pruning settings (max context tokens)
- System prompt

**NOT included:**
- Conversation history
- Model info
- Connection state

### Default Values

See `index.html` for authoritative defaults. Key values:

- **Temperature:** 0.7
- **Top-P:** 0.9
- **Max New Tokens:** 50
- **Aggregation Mode:** mean
- **Decay Mode:** additive
- **Decay Rate:** 0.003
- **Distance Mode:** logarithmic
- **Min Distance:** 20
- **Distance Scale:** 10
- **Boost Multiplier:** 1.0
- **Max Context Tokens:** 500

---

## Testing Strategy

### Unit Testing (Future)

Not currently implemented. If adding tests:

1. **conversation_state.js** - Test position uniqueness, soft-delete, sentence boundaries
2. **attention_tracker.js** - Test aggregation modes, distance weighting, decay
3. **kobold_client.js** - Mock WebSocket, test base64 decoding
4. **heatmap.js** - Test DOM manipulation, color calculation

Use a framework like Vitest or Jest with JSDOM.

### Integration Testing

**Manual testing checklist:**

1. **Connection** - Can connect to KoboldCPP, display model name
2. **Tokenization** - Messages tokenize correctly, display in heatmap
3. **Generation** - Streaming works, tokens appear incrementally
4. **Attention** - Colors update, bright tokens stay bright
5. **Decay** - Tokens fade over time with correct decay rate
6. **Distance Weighting** - Local tokens don't accumulate attention
7. **Pruning** - Low-brightness sentences removed when over threshold
8. **Settings** - All controls update config correctly
9. **Persistence** - Settings saved across page reload
10. **Export** - JSON export contains full conversation state

### Debugging Tools

**Browser console:**
```javascript
// Access main app
window.app

// Inspect conversation
window.app.conversation.exportState()

// Check tracker config
window.app.tracker.getConfig()

// Get statistics
window.app.heatmap.getStats(window.app.conversation)

// Manual pruning test
window.app._checkPruning()
```

---

## Common Issues

### "KoboldCPP not reachable"

**Cause:** KoboldCPP not running or wrong URL

**Fix:**
1. Check KoboldCPP is running: `curl http://localhost:5001/api/v1/model/info`
2. Verify port in `kobold_client.js` constructor
3. Check firewall settings

### Attention not updating

**Cause:** KoboldCPP not returning attention data (API not implemented)

**Fix:**
1. Check browser console for errors
2. Verify `return_attention: true` in generation config
3. Confirm KoboldCPP supports attention extraction
4. Fallback to V1 (attention_heatmap) until KoboldCPP ready

### Tokens not decaying

**Cause:** Decay rate 0 or decay mode "none"

**Fix:**
1. Check `app.tracker.config.decayMode` is not "none"
2. Verify `app.tracker.config.decayRate > 0`
3. Check tracker config updates when UI changes

### Pruning too aggressive

**Cause:** Distance weighting makes most tokens dark

**Fix:**
1. Reduce min_distance (try 10-15)
2. Increase distance_scale
3. Check boost_multiplier not too low
4. Temporarily disable distance weighting to verify it's the cause

### JavaScript errors on token add

**Cause:** DOM structure mismatch or missing sentence element

**Fix:**
1. Check heatmap.currentSentenceElement exists
2. Verify startTurn() called before adding tokens
3. Rebuild heatmap: `app.heatmap.rebuild(app.conversation)`

---

## Performance Optimization

### Current Performance

- **Attention aggregation:** ~5-10ms per token (28 layers × 28 heads × 500 tokens)
- **DOM updates:** ~1-2ms per token
- **Total overhead:** ~10-15ms per token (negligible vs ~100ms model inference)

### If Performance Becomes an Issue

**Optimization targets (in order):**

1. **Batch DOM updates** - Update colors every N tokens instead of every token
2. **Web Workers** - Move attention aggregation to worker thread
3. **Virtual scrolling** - Only render visible tokens
4. **Sparse attention** - KoboldCPP sends only top-K attention values
5. **Wasm** - Rewrite aggregation in Rust/C++ compiled to Wasm

**Do NOT optimize prematurely.** Current performance is acceptable.

---

## API Integration (KoboldCPP)

### Required Endpoints

See `../KOBOLD_API_SPEC.md` for complete specification.

**Model Info:**
```
GET /api/v1/model/info
→ {model_name, num_layers, num_heads, special_tokens, ...}
```

**Tokenization:**
```
POST /api/v1/tokenize
{"text": "Hello world"}
→ {tokens: [{token_id, text}, ...]}
```

**Streaming Generation:**
```
WS /api/v1/generate/stream
→ {"type": "token", "token": {...}, "attention": {...}}
→ {"type": "done", ...}
```

### Attention Data Format

**Encoded:**
```json
{
  "format": "per_layer",
  "shape": [28, 28, 500],
  "encoding": "base64",
  "dtype": "float32",
  "data": "AAAA..."
}
```

**Decoded:**
```javascript
{
  data: Float32Array[392000],  // 28 * 28 * 500
  shape: [28, 28, 500],
  contextLength: 500
}
```

**Interpretation:**
- `shape[0]` = num_layers
- `shape[1]` = num_heads
- `shape[2]` = context_length
- `data[l * heads * len + h * len + i]` = attention from new token to token i in layer l, head h

---

## Future Improvements

### Short Term (V2.1)

- [ ] Add visual settings (font size, color scheme)
- [ ] Export heatmap as PNG/SVG
- [ ] Sentence brightness API (like V1)
- [ ] Manual token deletion (click to prune)
- [ ] Undo pruning (restore deleted sentences)

### Medium Term (V2.5)

- [ ] Multiple conversation tabs
- [ ] Conversation import/export
- [ ] Attention pattern analysis (which tokens attended to which)
- [ ] Performance profiling dashboard
- [ ] Web Workers for attention aggregation

### Long Term (V3.0)

- [ ] Multi-model comparison (run 2 models side-by-side)
- [ ] Attention-based summarization (keep high-attention content, summarize low-attention)
- [ ] Adaptive pruning (prune more aggressively when model is confident)
- [ ] Distributed inference (spread context across multiple models)

---

## Dependencies

**Runtime:**
- Modern browser (Chrome 120+, Firefox 120+)
- KoboldCPP server with attention extraction

**Development:**
- Text editor
- Static file server (optional, for testing)

**No npm, no build step, no babel, no webpack.**

---

## File Modification Guidelines

### Adding New Features

1. **Identify the right module** - Don't put everything in app.js
2. **Keep modules independent** - Minimize cross-dependencies
3. **Add to UI** - Update index.html with controls
4. **Save settings** - Add to localStorage persistence
5. **Document** - Update this file and README.md

### Breaking Changes

**Require approval before:**
- Changing conversation_state.js data structure
- Modifying attention_tracker.js aggregation logic
- Altering kobold_client.js API expectations
- Changing localStorage schema (would break existing users)

### Bug Fixes

**Always safe:**
- Fixing calculation errors
- Improving error handling
- Adding null checks
- Fixing CSS issues
- Improving documentation

---

## Philosophy

### Why Pure Frontend?

1. **PyTorch was only needed for inference** - KoboldCPP handles that now
2. **JavaScript can aggregate attention** - It's just array math
3. **Simpler deployment** - No Python env, no dependencies
4. **More portable** - Runs anywhere

### Why Vanilla JS?

1. **No build complexity** - Just open the HTML file
2. **Debugging is trivial** - Native browser DevTools
3. **No dependency hell** - No npm, no version conflicts
4. **Faster iteration** - Edit and refresh, no rebuild

### Design Principles

1. **Expose, don't hide** - All parameters user-configurable
2. **Fail bright** - When uncertain, assume maximum attention
3. **Soft-delete** - Never actually remove data, just mark deleted
4. **Deterministic** - Same input → same output
5. **Debuggable** - Always accessible via console

---

## Version History

- **V1.0** (attention_heatmap) - PyTorch proof of concept, working attention extraction
- **V2.0** (halo_weave) - Pure frontend rewrite, pending KoboldCPP modifications
- **V2.1** (2025-11-21) - **CURRENT** - KoboldCPP integration working, data capture added

---

## Session Summary (2025-11-21)

### ✅ COMPLETED

1. **KoboldCPP Integration** - WORKING
   - Fixed SSE (Server-Sent Events) parsing in `kobold_client.js`
   - Added ChatML formatting (`<|im_start|>`, `<|im_end|>`)
   - Model endpoint: `/api/v1/model` (not `/api/v1/model/info`)
   - Generation endpoint: `/api/extra/generate/stream` (SSE, not WebSocket)

2. **Raw Logits Support** - WORKING
   - Removed [0,1] clamping in `conversation_state.js` and `attention_tracker.js`
   - Scores now range from -140,000% to +94,000% (raw pre-softmax logits)
   - Negative scores = unattended tokens (natural decay!)
   - Positive scores = attended tokens (brightness)

3. **Enhanced Token Tracking**
   - Added `peak_attention` field - tracks highest score ever seen
   - Added `attention_history[]` - stores last 5 raw attention values
   - Both exported in JSON for analysis

4. **Dual-Color Visualization**
   - **Sentence background** = Peak brightness of any token in sentence
   - **Token text color** = Individual token brightness (gray to white)
   - Color scale: -100 to +100 logit range (tunable)

5. **Bug Fixes**
   - Fixed token rendering bug (was showing only last token repeatedly)
   - Fixed hard refresh caching issues
   - Model responds coherently now with proper ChatML format

### ⚠️ IN PROGRESS

**Data Capture System** - Partially working, save broken

**What works:**
- `data_capture.js` module created
- UI buttons in settings panel
- Recording full attention tensors during generation
- Data structure correct

**What's broken:**
- Browser `JSON.stringify()` throws "allocation size overflow" on 820MB data
- Attempted fix: Created `save_server.py` (Python HTTP server on port 8081)
- Updated `data_capture.js` to POST to server instead of download
- Server running but app.js handler needs async update (interrupted)

**Files modified:**
- `/home/evans/Coding_Projects/Halo_Weave/halo_weave/js/data_capture.js` - save method updated
- `/home/evans/Coding_Projects/Halo_Weave/halo_weave/save_server.py` - NEW, handles large POSTs
- `/home/evans/Coding_Projects/Halo_Weave/halo_weave/js/app.js` - needs async handler update (line ~389)

**To complete:**
1. Update app.js button handler to be async and show progress
2. Hard refresh browser
3. Test: Start capture → Generate tokens → Stop → Save
4. File should appear in `/home/evans/Coding_Projects/Halo_Weave/halo_weave/attention_capture_*.json`

### 🎯 Current State

**KoboldCPP:**
- Running at http://localhost:5001
- Model: Qwen2.5-VL-7B-Instruct-Q8_0
- Context: 512 tokens
- Attention extraction: WORKING (raw logits)

**Frontend:**
- Running at http://127.0.0.1:8080
- Chat: WORKING
- Attention visualization: WORKING
- Pruning: NOT TESTED (max_context_tokens=500)

**Servers Running:**
- Port 8080: Python http.server (frontend)
- Port 5001: KoboldCPP (inference + attention)
- Port 8081: save_server.py (data capture upload) - Background ID: e1ddfa

### 📊 Observed Attention Patterns

**Score ranges with raw logits:**
- Min: -140,624%
- Max: +94,060%
- Average: -48,151%

**Key insight:** Most tokens accumulate huge negative scores naturally. No manual decay needed - the model's own attention provides natural forgetting!

### 🔧 Architecture Changes

**conversation_state.js:**
```javascript
// NEW fields per token:
peak_attention: 1.0,        // Highest score ever
attention_history: [],      // Last 5 raw values

// REMOVED: [0,1] clamping
token.attention_score = score;  // Allow negative!
```

**heatmap.js:**
```javascript
// NEW: Sentence background = peak
_updateSentenceBackground()

// NEW: Text color by individual score
_getTextColorForScore(score)
```

**kobold_client.js:**
```javascript
// Changed: WebSocket → SSE
// Changed: /api/v1/generate/stream → /api/extra/generate/stream
```

**app.js:**
```javascript
// NEW: ChatML formatting
`<|im_start|>user\n${text}<|im_end|>\n`
`<|im_start|>assistant\n`
```

---

## Questions to Ask Before Major Changes

1. Does this maintain position ID uniqueness?
2. Does this preserve the soft-delete architecture?
3. Does this work with non-sequential position IDs (after pruning)?
4. Does this handle missing/malformed attention gracefully?
5. Does this assume specific model architecture? (if yes, make it configurable)
6. Does this add external dependencies? (if yes, reconsider)
7. Does this break localStorage schema? (if yes, add migration)

---

## Contact

- **Issues:** https://github.com/RecursiveRabbit/Halo-Weave/issues
- **V1 Reference:** `../attention_heatmap/`
- **API Spec:** `../KOBOLD_API_SPEC.md`

---

**Last Updated:** 2025-11-22
**Status:** ✅ **WORKING** - Attention extraction validated, anchor analysis complete

---

## Session Summary (2025-11-22)

### ✅ COMPLETED

1. **Fixed KoboldCPP Race Condition**
   - Identified: Attention extraction reading GPU memory before write completes
   - Documented: `/home/evans/Coding_Projects/koboldcpp/ATTENTION_RACE_CONDITION_BUG.md`
   - Fixed: Added `ggml_backend_sched_synchronize()` before extraction
   - Result: 100% clean attention data, zero transitions in test captures

2. **Stream-to-Disk Data Capture**
   - Replaced in-memory JSON accumulation with incremental file writes
   - New architecture: One JSON file per token (e.g., `token_00000.json`)
   - Server: `save_server.py` handles POST requests to write individual tokens
   - Result: Can capture unlimited tokens without memory overflow

3. **Anchor Token Analysis Algorithm**
   - Method: Rolling average voting across generation steps
   - For each step: Award +1 vote to tokens above local mean
   - Peak vote per sentence = highest vote of any token in sentence
   - Test data: 1,703 tokens, 326 generation steps, 82 sentences

4. **Test Results** (`ANCHOR_TEST_RESULTS.md`)
   - 59 sentences (72%) had peak = 0 (never referenced)
   - 23 sentences (28%) had peak > 0 (referenced at least once)
   - The 23 anchor sentences contain 421 tokens (24.7% of original)
   - Algorithm successfully separates core content from supporting details

### 📁 Files Created

**Analysis Scripts:**
- `find_anchors.py` - Token-level voting, shows top anchor tokens
- `show_worst_sentences.py` - Ranks sentences by peak vote (ascending)
- `extract_anchor_sentences.py` - Extracts sentences with peak > 0
- `analyze_attention.py` - Statistical analysis of attention values
- `find_transitions.py` - Detects normalized vs raw logit transitions

**Documentation:**
- `ANCHOR_TEST_RESULTS.md` - Test results with extracted sentences
- `ATTENTION_MYSTERY.md` - Investigation of race condition
- `DATA_CAPTURE_GUIDE.md` - How to use stream-to-disk capture

**KoboldCPP:**
- `ATTENTION_RACE_CONDITION_BUG.md` - Complete bug analysis
- `ATTENTION_RACE_FIX.patch` - One-line fix
- `TEST_ATTENTION_FIX.md` - Testing protocol

**Data Captures:**
- `Capture_Data/capture_1763839318829/` - Short test (198 tokens)
- `Capture_Data/capture_1763842540750/` - Full test (1,703 tokens, clean)
- `Capture_Data/capture_1763788462071/` - Corrupted (shows race condition)

### 🔧 Bug Fixed

**Sentence Grouping:** `sentence_id` resets per turn, must group by `(turn_id, sentence_id)` not just `sentence_id`. All analysis scripts now use correct grouping.

### 📊 Key Findings

**Top 5 Anchor Tokens:**
1. Position 0 (BOS): 293 votes (100%)
2. "Mull": 272 votes (92.8%)
3. "proposed": 260 votes (88.7%)
4. "Joe": 258 votes (88.1%)
5. "participating": 244 votes (83.3%)

**What Gets Pruned (peak=0 sentences):**
- Explanatory sections ("Why This Rule Change Matters")
- Case examples and anecdotes
- Verbose elaborations of already-stated points
- Historical context and background

**What Gets Kept (peak>0 sentences):**
- System prompt
- Main topic and key entities
- Core actions and consequences
- Call to action with deadline

### ⚠️ Limitations

- Only one test conversation analyzed (1,703 tokens)
- Model-specific (Qwen2.5-VL-7B)
- Sentence boundaries from tokenizer may not match semantic boundaries
- No validation of whether pruned context maintains generation quality

### 🎯 Next Steps

- [ ] Test with multiple conversation types (technical, creative, chat)
- [ ] Validate: Generate with pruned vs full context, compare outputs
- [ ] Integrate anchor scoring into frontend UI
- [ ] Implement automatic pruning when context exceeds limit
- [ ] Add user controls for pruning aggressiveness

---

## Session Summary (2025-11-22 Evening)

### ✅ COMPLETED

1. **Fixed Sentence Boundary Detection**
   - Identified off-by-one error: sentence ID incremented before token assignment
   - Fixed: Capture sentence ID before increment, assign after token creation
   - Added abbreviation detection: U.S., Dr., Mr., etc. no longer break sentences
   - Added bare punctuation filter: "." "!" "?" tokens don't trigger boundaries
   - Result: 50 sentences (down from 120 broken boundaries)

2. **Improved Semantic Chunking**
   - Enhanced regex to handle: `...`, `!?`, `."`, `!"`, `?)`, `]!`
   - Line breaks now create semantic boundaries (for log files)
   - Single source of truth: Only `conversation_state.js` detects boundaries
   - `heatmap.js` now trusts `sentence_id` instead of re-detecting

3. **Added Min-Distance Filtering**
   - New parameter: `min_distance` (default 50 tokens)
   - Only count votes for tokens at least N tokens behind generation head
   - Prevents newly generated tokens from inflating anchor scores
   - Usage: `find_anchors.py <capture_dir> [top_n] [min_distance]`

4. **Organized Test Framework**
   - Created `tests/` directory structure:
     - `analysis_scripts/` - 9 Python analysis tools
     - `results/` - 7 test reports and documentation
     - `captures/` - Raw attention data (gitignored)
     - `README.md` - Test framework documentation
   - All test files moved out of project root

### ⚠️ CRITICAL FINDING: The Local Attention Wave Problem

**Discovered fundamental asymmetry in anchor scoring:**

**The Problem:**
- Article tokens (prompt): Never experience local attention wave during processing
- Assistant tokens: Get full wave during generation (50-100 token span)
- Local wave is ~10-50x brighter than distant backward references
- Result: Assistant tokens artificially bright, article tokens artificially dim

**Evidence:**
- Token graphs show massive attention spike within ~100 tokens of generation head
- 85% of assistant responses scored peak > 0
- Only 28% of article scored peak > 0
- Min-distance filter helps but doesn't fix root cause

**Root Cause:**
We don't capture attention during prompt ingestion, only during generation.

**Impact on Anchor Detection:**
- Cannot fairly compare article tokens vs assistant tokens
- Pruning algorithm biased toward deleting article content
- Rolling mean and min-distance are stopgaps, not solutions

### 📁 Files Modified

**Frontend:**
- `js/conversation_state.js` - Fixed sentence boundary detection
- `js/heatmap.js` - Removed duplicate boundary logic, trusts sentence_id

**Test Framework:**
- `tests/analysis_scripts/find_anchors.py` - Added min_distance parameter
- `tests/analysis_scripts/extract_anchor_sentences.py` - Added min_distance
- `tests/analysis_scripts/show_pruned_article.py` - Added min_distance
- `tests/analysis_scripts/show_sentences.py` - NEW: Display sentence boundaries
- `tests/analysis_scripts/inspect_tokens.py` - NEW: Debug tokenization
- `tests/README.md` - NEW: Test framework documentation

**Project:**
- `.gitignore` - Added `tests/captures/` to ignore large binary data
- `CLAUDE.md` - This update

### 🔬 Test Results (With Fixed Boundaries)

**Capture: capture_1763860331013 (2,392 tokens, 409 generation steps)**

**Sentence Distribution:**
- 70 total sentences (down from 120 with broken boundaries)
- 17 kept (peak > 0): 560 tokens (23.4%)
- 53 pruned (peak = 0): 1,832 tokens (76.6%)

**Top Anchor Tokens (min_distance=50):**
1. Position 0 (BOS): 409 votes (100%)
2. "ability": 347 votes (84.8%)
3. "Joe": 321 votes (78.5%)
4. "granted": 277 votes (67.7%)
5. "realistic": 252 votes (61.6%)

**Key Insight:**
Anchor scores are **dynamic** - they change based on conversation context. Same article, different questions → different anchor patterns.

### 🚨 Blocker: Need Prompt Processing Attention

**What We Need:**
Modify KoboldCPP to capture attention during prompt ingestion, not just token generation.

**Why:**
Every token deserves a fair shot at being "in the wave" during its own processing. Without this, anchor detection is fundamentally biased.

**Location:**
Likely needs changes in KoboldCPP's `llama_decode()` or `eval()` paths to extract attention tensors during batch prompt processing, similar to how we extract them during generation.

### 📊 Current Limitations

1. **No prompt processing attention** - Article tokens never experience local wave
2. **Min-distance is a workaround** - Doesn't level the playing field
3. **Sentence boundaries still imperfect** - Tokenizer doesn't respect semantic units
4. **Single model tested** - Qwen2.5-VL-7B only
5. **No quality validation** - Haven't tested if pruned context maintains output quality

### 🎯 Updated Next Steps

**Critical Path:**
1. **Modify KoboldCPP:** Capture attention during prompt processing
2. **Re-run tests:** Fair comparison with prompt attention data
3. **Validate pruning quality:** A/B test full vs pruned context

**Future Work:**
- Integrate anchor scoring into frontend UI
- Implement automatic pruning when context exceeds limit
- Test with multiple models and conversation types
- Add user controls for pruning aggressiveness

---

## Session Summary (2025-11-23)

### ✅ COMPLETED

1. **Strategy Testing Framework**
   - Created modular framework for comparing brightness scoring strategies
   - Built abstract base class (`base_strategy.py`) defining common interface
   - All strategies inherit from base, ensuring fair comparison
   - Automatic export to markdown (human-readable) + JSON (machine-readable)

2. **Two Complete Strategies Implemented**
   - **Voting Strategy** (`voting_strategy.py`) - Rolling mean voting system
     - Discrete vote counts (+1 if attention > local mean)
     - Min-distance filter to eliminate local wave bias
     - Measures frequency: "How often was this referenced?"
   - **Cumulative Strategy** (`cumulative_strategy.py`) - Accumulate with decay
     - Continuous scores (raw logits, can be negative)
     - Distance weighting + decay per step
     - Measures magnitude: "How much attention was paid?"

3. **Comparison Runner** (`run_comparison.py`)
   - Executes all strategies on same capture data
   - Generates individual reports per strategy
   - Produces side-by-side comparison with agreement/disagreement analysis
   - Shows which sentences all strategies agree on vs unique rankings

4. **Documentation**
   - `BRIGHTNESS_STRATEGIES.md` - High-level comparison of both systems
   - `tests/strategy_framework/README.md` - Usage documentation
   - `tests/strategy_framework/IMPLEMENTATION_SUMMARY.md` - Implementation notes and findings

### 📊 Test Results

**Capture 1 (capture_1763842540750): 1,703 tokens, 326 steps**
- **8/10 top sentences agreed** between both strategies
- Strong convergence on article core content, system prompt, key entities
- Voting: scores 1-326, Cumulative: scores -0.83 to 241.37
- Both strategies robust to different score ranges

**Capture 2 (capture_1763788462071): 198 tokens, 387 steps**
- **9/9 sentences agreed** (100% convergence)
- Cumulative scores went heavily negative (decay dominated short context)
- Rankings still correct despite negative scores
- Demonstrates robust anchor detection across different scoring mechanics

### 🔑 Key Insights

1. **Both strategies converge on same anchors** despite:
   - Different scoring mechanics (discrete vs continuous)
   - Different score ranges (positive only vs negative/positive)
   - Different parameters (min_distance 50 vs 20)

2. **Current turn immunity problem identified:**
   - Tokens in current turn accumulate huge attention during generation
   - Creates unfair bias (prompt tokens never get local wave)
   - Solution proposed: Skip attention accumulation for `current_turn_id`
   - Not yet implemented (frontend unchanged, research-only phase)

3. **Decay rate matters for cumulative:**
   - 0.003 decay × 387 steps = everything goes negative
   - Need to tune based on conversation length
   - Or implement adaptive decay

### 📁 Files Created

**Strategy Framework:**
- `tests/strategy_framework/base_strategy.py` - Abstract base class (300 lines)
- `tests/strategy_framework/voting_strategy.py` - Rolling mean voting (140 lines)
- `tests/strategy_framework/cumulative_strategy.py` - Accumulate with decay (150 lines)
- `tests/strategy_framework/run_comparison.py` - Comparison runner (200 lines)
- `tests/strategy_framework/README.md` - Usage documentation
- `tests/strategy_framework/IMPLEMENTATION_SUMMARY.md` - Implementation notes

**Documentation:**
- `BRIGHTNESS_STRATEGIES.md` - High-level strategy comparison

**Test Results:** (gitignored)
- `tests/strategy_framework/test_results/capture_*/` - Generated reports

### 🏗️ Architecture Decisions

**Frontend stays unchanged:**
- Current `js/` files are data capture pipeline only
- All research happens in Python analysis scripts
- Once best strategy determined, integrate back into frontend

**Output formats:**
- **Markdown** - Human-readable sentence rankings for qualitative evaluation
- **JSON** - Machine-readable data for quantitative analysis and plotting

**Modular design:**
- Easy to add new strategies (inherit from base class)
- Fair comparison (same data, same tooling)
- Sentence-level aggregation (peak score per sentence)

### ⚠️ Current Limitations

1. **Frontend brightness ignored** - Using voting/cumulative from analysis scripts only
2. **Need better test data** - Short captures with many steps = decay dominated
3. **No ground truth** - Manual annotation needed for precision/recall metrics
4. **No regeneration testing** - Haven't validated pruned context maintains output quality
5. **Single model** - Qwen2.5-VL-7B only

### 🎯 Next Steps

**Immediate:**
1. Capture longer conversations (1000+ tokens)
2. Mixed content types (code, explanations, questions)
3. Multiple turns with varying importance
4. Run comparison framework on diverse data

**Medium term:**
1. Implement hybrid strategies (votes weighted by magnitude)
2. Test parameter sensitivity (decay rates, min-distance, aggregation modes)
3. Generate visualizations (score distributions, rank correlations)
4. Manual annotation of important content (ground truth)

**Long term:**
1. Compute precision/recall metrics with ground truth
2. Regeneration quality testing (prune context, measure output degradation)
3. Integrate best strategy into frontend for real-time pruning
4. Adaptive strategies (change behavior based on conversation context)

---

## Session Summary (2025-12-01)

### ✅ COMPLETED

1. **Two New Brightness Strategies Implemented**
   - **Symmetric Voting (±1)** - Democratic frequency detector
     - `score += 1` if attention > local mean
     - `score -= 1` if attention ≤ local mean
     - Measures: "How often was this token referenced?"
   - **Magnitude-Weighted Voting** - Intensity-aware scoring
     - `score += int(attention / mean)` if above mean (e.g., 6.5x → +6)
     - `score -= 1` if below mean
     - Measures: "How hard did the model think about this?"

2. **Removed Score Clamping - Critical Discovery**
   - Initially: Clamped to [0, 255] with tokens starting at 255
   - Problem: Crushed dynamic range at both ends
   - Solution: Removed all clamping, let scores go where they need
   - Result: **Massive dynamic range revealed**
     - Symmetric: -208 to +718
     - Magnitude: **-208 to +231,859** (!)

3. **Parallel Testing Framework**
   - Ran all 4 strategies in parallel on full dataset
   - Dataset: 463 generation steps, 2,265 tokens
   - Execution: ~6 minutes (parallel) vs ~24 min (sequential) - 4x speedup
   - Used all 12 CPU cores efficiently

4. **Pruning-Focused Analysis**
   - Shifted perspective: Analyze BOTTOM scores (deletion candidates), not top
   - Created `pruning_comparison.md` showing lowest-scoring sentences
   - Deletion agreement: **Only 5/10** sentences agreed between strategies
   - This 50% disagreement revealed fundamental differences

### 🔑 Key Discoveries

**1. BOS Token is King**
- Symmetric score: 718 (highest)
- Magnitude score: **231,859** (100x higher than any other sentence!)
- Every generated token attends to BOS with massive intensity
- Single most critical anchor token in the context

**2. Natural Score Distribution is Bimodal**
- **Median scores:** Both strategies -104 to -160 (most tokens go negative)
- **Mean scores:** Symmetric -97, Magnitude +236 (pulled up by outliers)
- A few anchor tokens accumulate huge positive scores
- Most tokens naturally decay to negative (no manual pruning needed!)

**3. Symmetric vs Magnitude - Fundamentally Different**

| Metric | Symmetric ±1 | Magnitude-Weighted |
|--------|--------------|-------------------|
| **Measures** | Reference frequency | Reference intensity |
| **Good at keeping** | Frequently-referenced content | Spiky, important facts |
| **Deletes** | Rare facts (even if critical) | Weak rhetoric & fluff |
| **Range** | -208 to 718 (926 total) | -208 to 231,859 (232K total!) |
| **Median** | -160 | -104 |
| **Best for** | Understanding reference patterns | **Pruning decisions** |

**Example from test data:**

**Symmetric DELETES (rare but important):**
- "SportBrain sued 80 companies" - concrete fact
- "Shipping & Transit" - specific case study
- Patent names and numbers - cited rarely, but critical

**Magnitude DELETES (frequent but weak):**
- "That's utterly upside-down" - rhetorical opinion
- "Absurd presumption" - emotional argument
- Section headings - metadata, not content

**4. The Pruning Insight**

**Facts have spiky attention:**
- Referenced rarely
- When referenced, HUGE attention spike (up to 1,178x mean!)
- Model saying: "This is important, pay close attention"
- Magnitude KEEPS these (captures the spike)
- Symmetric DELETES these (low vote count)

**Rhetoric has diffuse attention:**
- Referenced frequently
- But with weak, distributed attention
- Background reasoning, not critical anchors
- Symmetric KEEPS these (high vote count)
- Magnitude DELETES these (low intensity)

### 📊 Test Results (capture_1764023921758)

**Score Statistics:**
| Strategy | Min | Max | Mean | Median |
|----------|-----|-----|------|--------|
| Voting (old) | 1 | 463 | 45.18 | 24 |
| Cumulative (old) | -0.46 | 344.77 | 0.10 | -0.27 |
| Symmetric (unclamped) | -208 | 718 | -97.29 | -160 |
| Magnitude (unclamped) | -208 | **231,859** | 235.60 | -104 |

**Deletion Agreement:**
- 5/10 sentences agreed on deletion (50% disagreement)
- Both agree to delete: role markers, weak explanations, "Sample comment:" labels
- Symmetric unique: Case studies and examples (concrete but rare)
- Magnitude unique: Rhetorical arguments and section headings (frequent but weak)

### 📁 Files Created

**New Strategies:**
- `tests/strategy_framework/symmetric_voting_strategy.py` - Symmetric ±1 voting
- `tests/strategy_framework/magnitude_voting_strategy.py` - Magnitude-weighted voting

**Analysis:**
- `tests/strategy_framework/test_results/capture_*/pruning_comparison.md` - Deletion-focused analysis
- `tests/strategy_framework/test_results/capture_*/unclamped_comparison.md` - Full range comparison

**Updated:**
- `tests/strategy_framework/run_comparison.py` - Now runs all 4 strategies in parallel

### 🎯 Decision: Use Magnitude Voting (Unclamped)

**Why magnitude is superior for pruning:**

1. **Keeps rare but critical facts** - Concrete data, names, numbers get huge spikes
2. **Deletes rhetorical fluff** - Persuasive but non-factual content scores low
3. **Massive dynamic range** - Clear separation between anchors (231K) and noise (-200)
4. **Natural pruning threshold** - Anything negative can be deleted safely
5. **Intensity over frequency** - Measures "how important" not "how often"

**Implementation plan for frontend:**
- Start all new tokens at score 255
- Each generation step:
  - If token attention > local mean: `score += int(attention / mean)`
  - If token attention ≤ local mean: `score -= 1`
- **No clamping** - let scores range freely
- Prune sentences when peak token score < threshold (e.g., < 0)

### ⚠️ TODO Items Identified

- [ ] **Line-based semantic grouping** - Track `line_id` per token, group by line instead of sentence
  - Lines are natural boundaries in code, logs, terminal output
  - May be better pruning unit than sentences
  - Test: Compare sentence-based vs line-based pruning

### 🏗️ Next Session

**Frontend Integration (2025-12-02):**
1. Update `attention_tracker.js` to use magnitude voting algorithm
2. Remove 0-1 clamping, allow negative scores
3. Update `conversation_state.js` to start tokens at 255
4. Modify pruning logic to delete sentences with peak score < 0
5. Update visualization colors for negative scores
6. Test live pruning with KoboldCPP

---

## Session Summary (2025-12-04)

### ✅ COMPLETED

1. **Production-Ready Magnitude Voting v3**
   - Created `magnitude_voting_strategy_v3.py` with full optimizations
   - O(1) mean calculation: `threshold = (1.0 - bos_attention) / (context_len - 1)`
   - BOS token exclusion from scoring and threshold calculation
   - Fully vectorized NumPy updates: `scores_array[1:n] += np.where(above, ratios, -1)`
   - Eliminated list allocation in hot loop (running aggregates instead)

2. **Key Optimization Insights**
   - **Softmax always sums to 1** - No need to compute `np.mean(aggregated)`
   - **BOS is attention sink** - Takes up to 40% of total attention, skewing threshold
   - **Vectorization eliminates Python loop overhead** - Critical for production performance
   - **Test harness limitations identified** - JSON I/O (650ms/token) hides optimization gains

3. **Performance Testing**
   - Ran v1 (original), v2 (half-vectorized), v3 (fully vectorized) on same dataset
   - Test data: 463 generation steps, 2,265 tokens, 14GB JSON files
   - Results: All ~310s total time (no measurable difference)
   - **Why:** File I/O and JSON parsing dominate (650ms/token vs 1ms compute)

### 🔑 Key Discovery: Production vs Test Performance

**Test Harness (offline):**
```
File open:          ~50ms
JSON parsing:       ~600ms (BOTTLENECK!)
Attention extract:  ~0ms
v3 compute:         ~1ms
────────────────────────
Total per token:    ~651ms
```

**Production (real-time WebSocket):**
```
Base64 decode:      ~5ms
NumPy reshape:      ~0ms (view)
Aggregation:        ~2ms
v3 compute:         ~1ms
────────────────────────
Total per token:    ~8ms (~125 tokens/sec)
```

**Verdict:** The v3 optimizations ARE valuable for production. The test harness can't show it because we're benchmarking JSON I/O, not the algorithm.

### 📊 Estimated Production Performance

| Component | Time | Notes |
|-----------|------|-------|
| Base64 decode | ~5ms | `atob()` on 1.5MB blob |
| Float32Array cast | ~0ms | Zero-copy view |
| Aggregation (28×28) | ~2ms | `np.mean(axis=(0,1))` |
| Threshold calc | ~0ms | `(1-bos)/(n-1)` |
| Vectorized voting | ~1ms | Single `np.where()` call |
| **Total** | **~8ms** | **Headroom for 125 tok/sec** |

### 📁 Files Created

**Optimized Strategies:**
- `tests/strategy_framework/magnitude_voting_strategy_v2.py` - Half-vectorized (failed)
- `tests/strategy_framework/magnitude_voting_strategy_v3.py` - Fully vectorized (production-ready)

**Both versions include:**
- Timing measurements for benchmarking
- BOS exclusion logic
- O(1) mean calculation
- Running aggregates (no list building)

### 🎯 Architecture Decisions

**Why v3 is production-ready despite benchmark results:**

1. **Test data is not production data** - JSON files are artifacts of the test harness
2. **Production path is faster** - WebSocket → base64 → numpy (no file I/O, no JSON parsing)
3. **Optimizations target the right bottleneck** - The ~1ms compute is what runs in production
4. **Benchmark validates correctness** - Output matches v1, proving algorithm integrity

**What matters in production:**
- ✅ O(1) threshold calculation (not hidden by I/O)
- ✅ Vectorized operations (pure NumPy, no Python loops)
- ✅ No memory allocation churn (running aggregates)
- ✅ BOS exclusion (attention sink handling)

### ⚠️ Limitations Acknowledged

- Only validated on test harness (JSON replay), not live WebSocket
- No profiling of actual production path yet
- Estimates based on component benchmarks, not end-to-end measurement
- Single model tested (Qwen2.5-VL-7B, 28L/28H)

### 🏗️ Next Session

**Validation priorities:**
1. Profile live WebSocket path (measure actual production performance)
2. Integrate v3 into frontend `attention_tracker.js`
3. Verify BOS exclusion doesn't break visualization
4. Test pruning behavior with negative scores
5. Benchmark end-to-end: token generation → scoring → pruning

**Integration checklist:**
- [ ] Port v3 algorithm to JavaScript
- [ ] Update `attention_tracker.js` with O(1) mean
- [ ] Add BOS exclusion to threshold calculation
- [ ] Remove score clamping (allow negative)
- [ ] Test with live KoboldCPP generation

---

## Session Summary (2025-12-04 Evening)

### ✅ COMPLETED

1. **WebSocket Binary Streaming - MASSIVE PERFORMANCE WIN**
   - Implemented binary WebSocket endpoint in KoboldCPP (`/api/extra/generate/stream/ws`)
   - Updated `kobold_client.js` with `_generateStreamWS()` method
   - Zero-copy attention: `new Float32Array(event.data)` directly on binary frame
   - **Result: 80s → 11s wall clock (7.3x faster)**

2. **Performance Bottleneck Analysis**
   - Added detailed timing instrumentation to identify bottlenecks
   - Discovered SSE+base64 overhead was **64 seconds** per 512 tokens:
     - Buffer string operations: 37.6s (73.5ms/token)
     - JSON parsing: 5.5s (10.9ms/token)
     - Base64 decode: 21.0s (41.0ms/token)
   - Binary WebSocket eliminates ALL of this overhead

3. **Data Capture Queue Fix**
   - Fixed dropped tokens during capture (was losing ~95% of attention files)
   - Root cause: `await` in SSE callback getting orphaned as tokens piled up
   - Solution: Write queue with buffer copy, fire-and-forget from main loop
   - Now captures 100% of tokens reliably

4. **UI Rendering Optimizations**
   - Added `tokenElements` Map for O(1) DOM lookups (was O(n) querySelector)
   - Optimized `updateColors` to skip unchanged tokens
   - Coalesced updates with `requestAnimationFrame`
   - Changed paragraph detection from sentence punctuation to newlines

### 📊 Performance Results

**Before (SSE + Base64):**
```
Wall clock:       80.5s (157.3ms/token)
Token gaps:       78.0s (152.3ms/token) [serialization overhead!]
Our processing:   3.1s (6.1ms/token)
Tokens/sec:       6.4
```

**After (WebSocket Binary):**
```
Wall clock:       11.0s (26.6ms/token)
Token gaps:       8.8s (21.2ms/token) [actual model inference]
Our processing:   2.2s (5.3ms/token)
Tokens/sec:       37.6
```

**Breakdown of eliminated overhead:**
| Component | Before | After | Savings |
|-----------|--------|-------|---------|
| Buffer ops | 37.6s | 0s | 100% |
| JSON parse | 5.5s | 0.1s | 98% |
| Base64 decode | 21.0s | 0s | 100% |
| **Total** | **64.1s** | **<1s** | **99%** |

### 🔑 Key Insight

The model generates at ~50 tokens/sec. With SSE+base64, we were seeing 6.4 tokens/sec in the UI. The 64 seconds of serialization overhead was hiding the model's true performance.

With binary WebSocket, the UI now keeps up with the model. **Real-time attention visualization at 37 tokens/second.**

### 📁 Files Modified

**KoboldCPP (separate repo):**
- Added WebSocket endpoint `/api/extra/generate/stream/ws`
- Binary frames for attention data (no base64)
- Text frames for token metadata (tiny JSON)

**Halo Weave:**
- `js/kobold_client.js` - Added `_generateStreamWS()`, auto-fallback to SSE
- `js/app.js` - Timing instrumentation, fire-and-forget capture
- `js/data_capture.js` - Write queue with buffer copy
- `js/conversation.js` - Paragraph detection by newlines
- `js/renderer.js` - O(1) DOM lookups, update coalescing
- `KOBOLD_API_SPEC.md` - Updated with Phase 6 WebSocket docs

### 🎯 Current State

**Performance:** ✅ Real-time (37 tok/s)
**Data Capture:** ✅ 100% reliable
**UI Visualization:** ✅ Smooth, responsive
**WebSocket:** ✅ Primary transport (SSE fallback)

The attention pipeline is now production-ready. Model inference is the only bottleneck.

---

## Session Summary (2025-12-05)

### ✅ COMPLETED

1. **Recency Bias Fix - WORKING**
   - Problem: Current turn tokens appeared overly bright due to high local self-attention
   - Solution: Skip scoring for tokens with `turn_id === currentTurnId`
   - Result: Current turn stays yellow (255), previous turns show differentiated brightness
   - Location: `js/conversation.js` line 166

2. **Multi-Turn Conversations - WORKING**
   - Fixed critical bug: `localhost` vs `127.0.0.1` mismatch was blocking HTTP requests
   - Browser treats these as different origins with separate connection pools
   - Changed `app.js` to use `http://127.0.0.1:5001` consistently
   - Multi-turn now works reliably in Chrome/Brave

3. **Git Housekeeping**
   - Committed missing `index.html` and `css/style.css` from UI rewrite
   - Deleted obsolete files: `attention_tracker.js`, `conversation_state.js`, `heatmap.js`
   - Updated test framework files
   - Repository now clean and consistent

4. **UI Improvements**
   - Increased max tokens slider to 2048 (was 512)
   - Added `brightness_at_deletion` field to preserve scores when tokens are pruned
   - Removed debug logging and delays from production code

### ⚠️ KNOWN ISSUES

1. **Firefox Connection Bug**
   - Firefox has intermittent connection issues with our WebSocket/HTTP mix
   - Tokenize requests timeout randomly after WebSocket generation
   - Works fine in Chrome/Brave
   - Root cause: Unknown (possibly Firefox connection pool handling)
   - Workaround: Use Chrome/Brave for now

2. **Stale Connections**
   - Multiple browser sessions can leave stale connections to KoboldCPP
   - Symptom: Tokenize requests hang on fresh page load
   - Fix: Restart KoboldCPP to clear connection pool
   - Long-term: May need `Connection: close` headers or connection management

3. **Performance Scales with Context**
   - Small context (350 tokens, 2.3MB attention): 26ms/token ✅
   - Large context (1765 tokens, 7.7MB attention): 72ms/token ⚠️
   - This is expected - more data to transfer per token
   - Optimization opportunity for next session

### 📊 Current Performance

**Small context (350 tokens):**
```
Wall clock:       5.9s (27.7ms/token)
Token gaps:       5.6s (25.9ms/token)
Our processing:   358ms (1.66ms/token)
Attention size:   2.3MB per token
```

**Large context (1765 tokens):**
```
Wall clock:       47.0s (77.9ms/token)
Token gaps:       43.0s (71.2ms/token)
Our processing:   3840ms (6.36ms/token)
Attention size:   7.7MB per token
```

### 📁 Files Modified

**Core Changes:**
- `js/conversation.js` - Recency bias fix (skip current turn scoring), brightness_at_deletion
- `js/app.js` - Changed to 127.0.0.1, removed debug delays
- `js/kobold_client.js` - Cleaned up WebSocket close handling
- `index.html` - Max tokens slider increased to 2048

**Git Cleanup:**
- Deleted: `js/attention_tracker.js`, `js/conversation_state.js`, `js/heatmap.js`
- Committed: `index.html`, `css/style.css`, `save_server.py`, test framework

### 🎯 Next Session: Optimization

**Performance investigation needed:**
- Token gaps increased from 21ms to 72ms with larger context
- KoboldCPP generates in 12s, but wall clock is 47s
- 35 seconds unaccounted for - likely WebSocket transfer overhead
- Need to profile binary frame handling

**Potential optimizations:**
1. Batch attention updates (every N tokens instead of every token)
2. Reduce attention tensor size (top-K values only?)
3. Web Workers for attention processing
4. Connection pooling / keep-alive improvements

---

## Session Summary (2025-12-05 Afternoon)

### ✅ COMPLETED: WebSocket Performance Optimization

**The Problem:**
- KoboldCPP generated 443 tokens in 9.15s (49.8 tok/s)
- Frontend wall clock was 44.6s (10.0 tok/s)
- 35 seconds of overhead unaccounted for

**Root Cause Identified:**
- Server `sendall()` was blocking for 33.85s (90ms/token)
- TCP send buffer filling up because client couldn't read fast enough
- Client blocked on synchronous JavaScript processing during `onmessage`
- Each token: 6.5MB attention data × 443 tokens = 2.9GB total transfer

**The Solution: Server-Side Attention Aggregation**
- Moved `mean(axis=(0,1))` from client to server
- Reduces data from `[28, 28, context]` to `[context]`
- **784x bandwidth reduction** (6.5MB → 8KB per token)

### 📊 Performance Results

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| **Wall clock** | 44.6s | 9.3s | **4.8x faster** |
| **Token gaps** | 42.4s (39ms/msg) | 9.1s (10ms/msg) | **4.7x faster** |
| **Binary data** | 3503MB | 3.6MB | **973x less** |
| **sendall time** | 33.85s | 0.01s | **3385x faster** |
| **Our processing** | 4.0ms/tok | 0.39ms/tok | **10x faster** |
| **updateBrightness** | 2.6ms/tok | 0.04ms/tok | **65x faster** |

**Generation is now real-time** - UI keeps up with model inference.

### 📁 Files Modified

**KoboldCPP:**
- `koboldcpp.py` - Server-side attention aggregation in `handle_websocket_stream()`
- `gpttype_adapter.cpp` - Removed debug `fprintf` statements from attention capture

**Halo Weave:**
- `js/kobold_client.js` - Updated to expect pre-aggregated attention data, added `preAggregated` flag
- `js/conversation.js` - Skip `_aggregateAttention()` when data is pre-aggregated
- `js/app.js` - Batched stats updates with requestAnimationFrame

**Earlier optimizations this session:**
- `js/conversation.js` - Cached active tokens, numeric keys in getSentences(), single-pass getStats()
- `js/renderer.js` - Use precomputed peakBrightness instead of Math.max(...array)

### 🔧 API Change

**WebSocket binary frame format changed:**
- **Before:** Raw `[layers, heads, context]` float32 array (~6.5MB)
- **After:** Pre-aggregated `[context]` float32 array (~8KB)

Client receives `preAggregated: true` flag to skip client-side aggregation.

### 🎯 Current State

**Performance:** ✅ Real-time (47.8 tok/s matches model speed)
**Data transfer:** ✅ Minimal (3.6MB total for 443 tokens)
**Processing overhead:** ✅ Negligible (0.39ms/token)

The attention pipeline is now **zero-overhead** relative to model inference.

---

**Last Updated:** 2025-12-05
**Status:** ✅ **PRODUCTION-READY** - Real-time attention visualization at model speed
**Browser Support:** Chrome/Brave ✅ | Firefox ⚠️ (connection issues)
