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

**Last Updated:** 2025-11-16
**Status:** ⚠️ Awaiting KoboldCPP attention extraction implementation
