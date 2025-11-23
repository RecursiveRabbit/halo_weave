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
