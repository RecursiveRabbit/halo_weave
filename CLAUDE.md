# CLAUDE.md - Halo Weave Development Guide

**For:** AI assistants working on this project
**Last Verified Against Code:** 2025-12-09

---

## Project Overview

Halo Weave is a **pure frontend application** for visualizing transformer attention patterns and performing brightness-based context pruning with semantic resurrection. It connects directly to a modified KoboldCPP server via WebSocket for real-time attention streaming.

**Status:** Data Science and Endless Testing. 

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
  ├─> kobold_client.js   (KoboldCPP API adapter - WebSocket + REST)
  ├─> conversation.js    (Token storage + Magnitude Voting v3 + pruning + short line merging)
  ├─> renderer.js        (DOM rendering + dual-layer brightness visualization)
  ├─> semantic_index.js  (Append-only vector DB for context resurrection via transformers.js)
  └─> data_capture.js    (Stream-to-disk attention capture for offline analysis)
```

**Key principle:** Each module is self-contained with clear responsibilities.

### Communication Flow

```
User sends message
       │
       ▼
SemanticIndex.query() - resurrect semantically relevant pruned context
       │
       ▼
KoboldClient.tokenize() - REST POST to /api/v1/tokenize
       │
       ▼
Conversation.addMessage() - store tokens with position IDs
       │
       ▼
KoboldClient.generateStream() - WebSocket to /api/extra/generate/stream/ws
       │
       ├── Text frame: {type: "token", token_id, text}
       ├── Binary frame: Float32Array (pre-aggregated attention)
       │
       ▼
Conversation.updateBrightness() - Magnitude Voting v3 scoring
       │
       ▼
Renderer.updateColors() - visual feedback (debounced with rAF)
       │
       ▼
Generation complete
       │
       ▼
SemanticIndex.indexNewChunks() - embed all new chunks with context window
       │
       ▼
Conversation.pruneToFit() - delete lowest brightness chunks
```

---

## Core Concepts

### 1. Token Dictionary (conversation.js)

**Single source of truth** for conversation history. Every token is an object:

```javascript
{
  token_id: 9707,
  text: "Hello",
  position: 42,            // Birth position, never changes
  brightness: 255,         // Magnitude voting score (starts at 255, can go negative)
  turn_id: 2,
  sentence_id: 0,          // Chunk ID - increments on paragraph/code boundaries (min 64 tokens)
  role: "user",            // "system", "user", or "assistant"
  deleted: false,          // Soft-delete flag
  brightness_at_deletion: undefined  // Preserved when deleted for debugging
}
```

**Critical invariants:**
- Position IDs are unique and never reused
- Tokenize once when message added, never retokenize
- Soft-delete: deleted tokens stay in array, marked `deleted=true`
- Fail bright: new tokens start at `brightness=255`
- Scores can go negative (no clamping)

### 2. Brightness Scoring (Magnitude Voting v3)

**Integrated into conversation.js** - no separate tracker module.

**Algorithm (per generation step):**
```
Pre-aggregated attention [context_length] (server computes mean across layers/heads)
  ↓
Calculate threshold: (1.0 - bos_attention) / (context_len - 1)
  ↓
For each token where i > 0 (skip BOS) and turn_id !== currentTurnId:
  - If attention > threshold: brightness += int(attention / threshold)
  - If attention <= threshold: brightness -= 1
  ↓
No clamping - scores range freely (can go negative)
```

**Key insights:**
- BOS token is attention sink (up to 40% of total) - excluded from threshold calculation
- Current turn tokens skip scoring entirely (they're in their local attention wave)
- Magnitude captures intensity, not just frequency
- Server-side aggregation reduces bandwidth from ~6.5MB to ~8KB per token

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

### 4. Visualization (renderer.js)

**Dual-layer brightness visualization:**

1. **Paragraph color** (all tokens in paragraph): Yellow intensity based on peak brightness
   - Dim olive (100, 90, 40) ← brightness 0
   - Medium yellow (200, 180, 80) ← brightness 255
   - Bright gold (255, 220, 100) ← brightness 500+

2. **Individual token highlight** (brightness > 255):
   - White text color (#ffffff)
   - Yellow background with alpha based on excess brightness

**Paragraph grouping:**
- Tokens grouped by `(turn_id, sentence_id, role)`
- `sentence_id` increments on newlines only (not sentence punctuation)
- Peak brightness of any token in paragraph determines paragraph color

**Performance optimizations:**
- `tokenElements` Map for O(1) DOM lookups
- `lastBrightness` Map to skip unchanged tokens
- `requestAnimationFrame` debouncing for color updates

### 5. Semantic Index (semantic_index.js)

**Append-only vector database** for context resurrection. All chunks are indexed on creation, not just pruned ones.

**Architecture:**
- Append-only entry list (entries never removed)
- Lazy-loaded embedding model via transformers.js CDN (all-MiniLM-L6-v2, ~23MB)
- Context-window embeddings: N-1, N, N+1 chunks up to 256 tokens
- Brute-force cosine similarity search (fast enough for 100K+ entries)

**Key difference from old Graveyard:**
| Aspect | Old Graveyard | Semantic Index |
|--------|---------------|----------------|
| When indexed | On prune | On creation |
| What's indexed | Dead chunks only | All chunks |
| Embedding context | Chunk in isolation | N-1, N, N+1 window |
| Removal | On resurrection | Never (append-only) |

**Lifecycle:**
```
Chunk created
       │
       ▼
SemanticIndex.indexNewChunks() - embed with context window
       │
       ▼
Active in context (brightness tracked)
       │
       ▼
Pruned (deleted=true) ─── still in index, searchable
       │
       ▼
User query matches → resurrectByTuple() (deleted=false, brightness=255)
       │
       ▼
Back in active context, must prove itself again
```

**Query timing:** Every user message, before adding to conversation
**Token budget:** `resurrectionBudget - estimatedUserTokens` (default 512)
**Lookup:** By `(turn_id, sentence_id, role)` tuple, not token positions

### 6. Paragraph-Based Chunking (conversation.js)

**Chunks are semantic units: paragraphs and code blocks, with a minimum size.**

**Chunk boundaries occur at:**
1. `\n\n` - Paragraph break (double newline)
2. `\n}` - Closing brace at line start (code block end)
3. `\n``` ` - Fenced code block boundary

**But only if** the current chunk has ≥64 tokens (`minChunkTokens`).

Short paragraphs, lists, and headers merge into the next chunk until the minimum is reached.

**Why this approach:**
- Paragraphs are natural semantic units
- Code blocks stay intact
- Minimum size prevents tiny chunks (e.g., "## Header" becoming its own chunk)
- Fewer, larger chunks = faster indexing + better recall
- 256-token embedding limit just truncates long chunks (topic still captured)

---

## Development Guidelines

### When Modifying conversation.js

**DO:**
- ✅ Maintain position uniqueness
- ✅ Preserve deleted tokens in array (soft-delete)
- ✅ Update chunk tracking on paragraph/code boundaries
- ✅ Keep fail-bright principle (new tokens = 255)

**DON'T:**
- ❌ Reuse position IDs
- ❌ Actually remove deleted tokens from array
- ❌ Retokenize existing context
- ❌ Initialize tokens at 0 brightness
- ❌ Clamp brightness scores

### When Modifying kobold_client.js

**DO:**
- ✅ Use WebSocket binary frames for attention (pre-aggregated Float32Array)
- ✅ Force-close lingering WebSockets before new generation (`_forceCloseWebSocket()`)
- ✅ Fall back to SSE if WebSocket fails
- ✅ Use 5s timeout on tokenize requests

**DON'T:**
- ❌ Store conversation state (client is stateless)
- ❌ Wait for WebSocket close handshake (can take 10s+)
- ❌ Assume specific model (query /api/v1/model)
- ❌ Aggregate attention client-side (server does this now)

### When Modifying renderer.js

**DO:**
- ✅ Use dataset attributes for element identification
- ✅ Handle missing elements gracefully
- ✅ Support incremental rendering
- ✅ Cache DOM element references for O(1) lookups

**DON'T:**
- ❌ Store application state (visualization only)
- ❌ Mutate conversation objects
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

**Saved to localStorage:** `halo_weave_settings`

**Included:**
- All generation settings (temperature, top-p, max tokens)
- Pruning settings (max context tokens)
- System prompt

**NOT included:**
- Conversation history
- Model info
- Connection state

### Default Values

See `index.html` for authoritative defaults. Key values:

- **Temperature:** 0.7
- **Top-P:** 0.9
- **Max New Tokens:** 50 (slider max: 2048)
- **Max Context Tokens:** 2000 (0 = no pruning)
- **Initial Brightness:** 255
- **Decay per step:** -1 (when below threshold)

---

## Testing Strategy

### Unit Testing (Future)

Not currently implemented. If adding tests:

1. **conversation.js** - Test position uniqueness, soft-delete, line boundaries, magnitude voting
2. **kobold_client.js** - Mock WebSocket, test base64 decoding
3. **renderer.js** - Test DOM manipulation, color calculation
4. **semantic_index.js** - Test embedding, context windows, similarity search, resurrection

Use a framework like Vitest or Jest with JSDOM.


**Manual testing checklist:**

1. **Connection** - Can connect to KoboldCPP, display model name
2. **Tokenization** - Messages tokenize correctly, display in heatmap
3. **Generation** - Streaming works, tokens appear incrementally
4. **Attention** - Colors update based on magnitude voting scores
5. **Current Turn Immunity** - Current turn tokens stay at 255 (yellow)
6. **Score Decay** - Tokens below threshold lose 1 brightness per step
7. **Pruning** - Low-brightness lines removed when over token budget
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

// Get statistics
window.app.conversation.getStats()

// Get sentences (paragraphs) with brightness
window.app.conversation.getSentences()

// Manual pruning test
window.app._checkPruning()

// Semantic index stats
window.app.semanticIndex.getStats()

// Force rebuild display
window.app.renderer.rebuild(window.app.conversation)

// Abort current generation
window.app.client.abort()
```

---

## Common Issues

### "KoboldCPP not reachable"

**Cause:** KoboldCPP not running or wrong URL

**Fix:**
1. Check KoboldCPP is running: `curl http://localhost:5001/api/v1/model`
2. Verify port in `kobold_client.js` constructor (default: `http://127.0.0.1:5001`)
3. Check firewall settings

### Attention not updating

**Cause:** KoboldCPP not returning attention data (API not implemented)

**Fix:**
1. Check browser console for errors
2. Verify WebSocket endpoint `/api/extra/generate/stream/ws` is available
3. Confirm KoboldCPP has attention extraction enabled
4. Check if falling back to SSE (slower but still works)

### Tokens not decaying

**Cause:** Tokens only decay when attention is below threshold

**Fix:**
1. Verify generation is happening (decay only occurs during generation)
2. Check that tokens aren't in current turn (immune until next turn)
3. Inspect `conversation.getStats()` to see brightness range

### Pruning too aggressive

**Cause:** Token budget too low or many low-brightness lines

**Fix:**
1. Increase max context tokens in settings
2. Check `conversation.getSentences()` to see line brightness distribution
3. System prompt (turn 0, role system) is immune - verify it exists

### JavaScript errors on token add

**Cause:** DOM structure mismatch or missing sentence element

**Fix:**
1. Check renderer has turn element for current turn_id
2. Verify conversation.currentRole is set before adding tokens
3. Rebuild display: `app.renderer.rebuild(app.conversation)`

### WebSocket connection issues

**Cause:** Lingering WebSocket from previous generation blocking new connections

**Symptoms:**
- "Tokenization timed out after 5s"
- Requests hang after several messages

**Fix:**
1. Restart KoboldCPP to clear connection pool
2. Check `_forceCloseWebSocket()` is being called before new generation
3. Use Chrome/Brave instead of Firefox (Firefox has intermittent issues)

---

## Performance

### Current Performance (with server-side aggregation)

**Typical generation (500 token context):**
- **Wall clock:** ~27ms/token
- **Token gaps (network + model):** ~22ms/token
- **Our processing:** ~5ms/token
  - addToken: ~0.1ms
  - updateBrightness: ~0.04ms
  - updateColors: ~0.1ms
  - renderToken: ~0.1ms
- **Attention size:** ~8KB/token (pre-aggregated)

**Large context (1700+ tokens):**
- **Wall clock:** ~78ms/token
- **Token gaps:** ~71ms/token
- **Our processing:** ~6ms/token
- **Attention size:** ~7.7MB/token (if using SSE fallback)

**Semantic index operations:**
- First embed: ~2-3s (model init + WASM warmup)
- Subsequent embeds: ~40-60ms/chunk
- Search (10K chunks): ~4ms
- Search (100K sentences): ~40ms

### Optimizations Already Implemented

1. **Server-side aggregation** - 784x bandwidth reduction (6.5MB → 8KB)
2. **WebSocket binary frames** - Zero-copy Float32Array, no base64
3. **O(1) DOM lookups** - tokenElements Map
4. **requestAnimationFrame debouncing** - Coalesce color updates
5. **Active token caching** - Avoid repeated filter operations
6. **Numeric sentence keys** - Avoid string concatenation in hot path

### If Performance Becomes an Issue

**Remaining optimization targets:**
1. **Web Workers** - Move semantic index embedding off main thread
2. **Virtual scrolling** - Only render visible tokens
3. **Batch DOM updates** - Update colors every N tokens
4. **IndexedDB** - Persist semantic index to disk instead of memory

---

## API Integration (KoboldCPP)

### Required Endpoints

See `KOBOLD_API_SPEC.md` for complete specification.

**Model Info:**
```
GET /api/v1/model
→ {model_name, num_layers, num_attention_heads, ...}
```

**Tokenization:**
```
POST /api/v1/tokenize
{"text": "Hello world", "add_special_tokens": false}
→ {tokens: [{token_id, text}, ...]}
```

**Streaming Generation (WebSocket - preferred):**
```
WS /api/extra/generate/stream/ws
→ Text frame: {"type": "token", "token_id": 123, "text": "Hello"}
→ Binary frame: Float32Array[context_length] (pre-aggregated attention)
→ Text frame: {"type": "done", ...}
```

**Streaming Generation (SSE - fallback):**
```
POST /api/extra/generate/stream
→ data: {"type": "token", "token": {...}, "attention": {base64 encoded}}
→ data: {"type": "done", ...}
```

### Attention Data Format

**WebSocket (pre-aggregated by server):**
```javascript
// Binary frame is raw Float32Array
const floats = new Float32Array(event.data);  // [context_length]

// Wrapped for conversation.js:
{
  data: floats,
  shape: [1, 1, contextLen],  // Pretend 1 layer, 1 head
  contextLength: contextLen,
  preAggregated: true  // Flag to skip client-side aggregation
}
```

**SSE (base64 encoded, full tensor):**
```json
{
  "format": "per_layer",
  "shape": [28, 28, 500],
  "encoding": "base64",
  "dtype": "float32",
  "data": "AAAA..."
}
```

**Performance comparison:**
- WebSocket binary: ~8KB/token, ~10ms/token
- SSE base64: ~6.5MB/token, ~150ms/token

---

## Known Issues / TODO

### Bugs to Investigate

- [ ] **Stale state after refresh** - Occasionally, old conversation content persists after page refresh. Hard refresh (Ctrl+Shift+R) clears it. May be browser caching JS files.
- [ ] **End token tokenization hanging** - `<|im_end|>` tokenization after generation sometimes hangs. Currently commented out in app.js.
- [ ] **Off-by-one on assistant turns** - AI sometimes answers the previous question instead of the current one. Likely a turn boundary or resurrection timing issue.

### Future Improvements

**Short Term:**
- [ ] Add visual settings (font size, color scheme)
- [ ] Manual token deletion (click to prune)
- [ ] Undo pruning (manual resurrection from semantic index)
- [ ] **Pin chunks** - Mark chunks as immune to pruning
- [ ] **Merge chunks** - Combine two adjacent chunks (update sentence_ids, re-embed)

**Medium Term:**
- [ ] Multiple conversation tabs
- [x] Web Workers for semantic index embedding (off main thread) ✅ Implemented
- [ ] Attention pattern analysis (which tokens attended to which)

**Long Term:**
- [ ] Multi-model comparison
- [ ] Attention-based summarization
- [ ] Adaptive pruning based on model confidence

---

## Dependencies

**Runtime:**
- Modern browser (Chrome 120+, Firefox 120+ with caveats)
- KoboldCPP server with attention extraction and WebSocket support
- transformers.js (loaded from CDN on first semantic index use, ~23MB)

**Development:**
- Text editor
- Static file server (e.g., `python -m http.server 8080`)
- Optional: `save_server.py` for data capture (port 8081)

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
- Changing conversation.js token data structure
- Modifying brightness scoring algorithm in conversation.js
- Altering kobold_client.js API expectations
- Changing localStorage schema (would break existing users)
- Modifying semantic index entry format (would break saved exports)

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

## Related Documentation

- `KOBOLD_API_SPEC.md` - KoboldCPP API specification
- `SEMANTIC_INDEX.md` - Semantic index design document
- `BRIGHTNESS_STRATEGIES.md` - Comparison of scoring algorithms
- `tests/README.md` - Test framework documentation
- `../attention_heatmap/` - V1 reference (PyTorch proof of concept)

---

## Questions to Ask Before Major Changes

1. Does this maintain position ID uniqueness?
2. Does this preserve the soft-delete architecture?
3. Does this work with non-sequential position IDs (after pruning)?
4. Does this handle missing/malformed attention gracefully?
5. Does this assume specific model architecture? (if yes, make it configurable)
6. Does this add external dependencies? (if yes, reconsider)
7. Does this break localStorage schema? (if yes, add migration)
8. Does this affect semantic index compatibility? (if yes, handle old exports)
