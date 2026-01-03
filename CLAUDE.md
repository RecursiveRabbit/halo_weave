# CLAUDE.md - Halo Weave Development Guide

Okay, so the problem is context length. 
Any conversation will eventually grow too large and overwhelm the context window. 
Solutions: 
FIFO or sliding window: Delete the oldest context as new context is generated.
> This is bad because it deletes tokens regardless of importance and the earliest tokens in a conversation are, like these tokens, critical to understanding the tokens that come afterwards. 
Summarization: Occasionally grab the whole context, or a section of the context, and have the system generate a summary of that context. 
> This sucks.The model rewords everything and you end up with a completely broken understanding of what's going on, losing anything important that you might have written. You lose direct user quotes and precise data in favor of rumors of what that data might have been. 

You need a way to delete unimportant information, while preserving important context. 
My proposed solution: Brightness based culling. 
We harness the attention calculation that the model is already doing on the forward pass, using those scores over time to give each token a "brightness" score. 
You then clear whole chunks with low peak brightness from the context. 
Low peak brightness is important because a single bright token can keep a whole chunk afloat. 
We allow the model itself to determine what data is important and what is not and we clear out what isn't. 

But what if a user mentions something in turn 1 that doesn't become important until turn 80? 
That's where the Semantic Index comes into play.
We don't actually delete any tokens, we just set deleted=true and stop rendering them.
As content is generated and added it's added to the Semantic Index, a RAG database that we query on subsequent user turns.
When a sequence is returned via RAG we don't stick it at the end of the context, we just set deleted=false and the sentence appears in the context at the appropriate depth as if it was never deleted.
The Chekhov's gun from turn 1 reappears in turn 1 when it becomes relevant in turn 80.
A resurrected chunk is treated as new context, with a default brightness score, and must then either prove itself or be deleted again on subsequent turns. 

**For:** AI collaborators working on this project
**Last Verified Against Code:** 2025-12-26

---

## Project Overview

Halo Weave is a **pure frontend application** for visualizing transformer attention patterns and performing brightness-based context pruning with semantic resurrection. It connects directly to a modified KoboldCPP server via SSE (Server-Sent Events) for real-time attention streaming.

**Status:** Data Science and Endless Testing. 

---

## Architecture

### Stack

- **Frontend:** Vanilla JavaScript (ES6 modules), HTML5, CSS3
- **No build step:** No webpack, no npm, no babel - just native modules
- **Inference backend:** KoboldCPP (separate process)
- **Communication:** SSE (Server-Sent Events) for streaming, REST for metadata

### Components

```
index.html
  ↓
app.js (Main Controller)
  ├─> kobold_client.js     (KoboldCPP API adapter - SSE + REST)
  ├─> conversation.js      (Token storage + Magnitude Voting v3 + anchor-protected pruning)
  ├─> renderer.js          (DOM rendering + dual-layer brightness visualization)
  ├─> semantic_index.js    (Append-only vector DB for context resurrection via transformers.js)
  ├─> persistent_store.js  (IndexedDB wrapper - infinite conversation persistence)
  └─> data_capture.js      (Stream-to-disk attention capture for offline analysis)
```

**Key principle:** Each module is self-contained with clear responsibilities.

### UI Layout

**Main panel:** Shows only active context (what the model sees)
**Graveyard sidebar:** Shows pruned chunks from `deadTokens` store (collapsible)

### Communication Flow

**User Input (DB-First):**
```
User types message → [User hits send]
       │
       ▼
Tokenize (REST call to KoboldCPP)
       │
       ▼
Write tokens to liveTokens store (AWAIT - block until persisted)
       │
       ▼
Index chunks in semantic_entries (AWAIT - block until indexed)
       │
       ▼
Render UI (UI now reflects exactly what's in database)
       │
       ▼
Read liveTokens for inference context
       │
       ▼
Send context to model
```

**Streaming Generation (Performance-First):**
```
KoboldClient.generateStream() - SSE POST to /api/extra/generate/stream
       │
       ├── SSE event: {type: "token", token: {token_id, text}, attention: {...}}
       │
       ▼
Conversation.addStreamingToken() - add to memory + fire-and-forget DB write
       │
       ▼
Conversation.updateBrightness() - Magnitude Voting v3 scoring
       │
       ▼
Renderer.addToken() - immediate visual feedback
       │
       ▼
Generation complete
       │
       ▼
Process tool calls (if any) - execute jq commands, update JSON storage
       │
       ▼
SemanticIndex.indexNewChunks() - embed all new chunks with turn-pair context
       │
       ▼
Conversation.pruneToFit() - delete lowest brightness chunks (anchor-protected)
       │
       ▼
Update graveyard sidebar (if visible)
```

**Invariant:** Between user interactions (when not generating), UI state = Database state.

---

## Core Concepts

### 1. Token Dictionary (conversation.js)

**Single source of truth** for conversation history. Every token is an object:

```javascript
{
  token_id: 9707,
  text: "Hello",
  position: 42,            // Birth position, never changes
  brightness: 10000,       // Magnitude voting score (starts at 10000, capped at 10000, no floor)
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
- Fail bright: new tokens start at `brightness=10000`
- Scores capped at 10000 to prevent runaway, no floor (can go negative)
- Resurrection brightness depends on signal strength:
  - Semantic resurrection: `brightness_at_deletion` (preserve earned signal - no gifts)
  - Manual resurrection: `10000` + pinned (strongest user signal - explicit user declaration)

### 2. Brightness Scoring (Magnitude Voting v3)

**Integrated into conversation.js** - no separate tracker module.

**Algorithm (per generation step):**
```
Pre-aggregated attention [context_length] (server computes mean across layers/heads)
  ↓
Calculate threshold: (1.0 - bos_attention) / (context_len - 1)
  ↓
Calculate mean brightness across all active tokens (excluding current turn)
  ↓
For each token where i > 0 (skip BOS) and turn_id !== currentTurnId:
  - If attention > threshold: brightness += int(attention / threshold), cap at 10000
  - If attention <= threshold: brightness -= 1  // Flat decay
  ↓
Flat decay maintains stratification (high-brightness tokens stay differentiated)
Mean brightness is used for semantic resurrection (unproven but relevant context)
```

**Key insights:**
- BOS token is attention sink (up to 40% of total) - excluded from threshold calculation
- Current turn tokens skip scoring entirely (they're in their local attention wave)
- Magnitude captures intensity, not just frequency
- Attention data is base64-encoded and aggregated client-side
- Flat -1 decay maintains stratification (proportional decay collapsed distribution to mean)
- Mean brightness provides a dynamic resurrection baseline (half the tokens are below it)

**Signal Hierarchy (brightness assignment):**
1. **New content** → 10,000 (fail-bright: maximum runway to prove relevance)
2. **Manual resurrection** → 10,000 + pinned (strongest signal - user declared importance)
3. **Semantic resurrection** → brightness_at_deletion (preserve earned value - no gifts)
4. **Earned brightness** → accumulated attention scores (proven value)

**Critical:** Brightness must persist to database after every generation. Without persistence, reloading destroys thousands of tokens worth of accumulated signal.

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

**Dual-layer brightness visualization with dynamic scaling:**

1. **Paragraph color** (all tokens in paragraph): Yellow intensity based on peak brightness
   - Uses **dynamic scale** based on min/max brightness in active context
   - Min brightness → dim olive (100, 90, 40)
   - Mid brightness → medium yellow (200, 180, 80)
   - Max brightness → bright gold (255, 220, 100)
   - **Advantage:** Shows relative stratification regardless of absolute values
   - **Preserves signal:** Dim tokens are visible even when all tokens are high-brightness

2. **Individual token highlight** (top 20% of brightness range):
   - White text color (#ffffff)
   - Yellow background with alpha 0.2-0.5 based on position within top 20%
   - Highlights the brightest tokens receiving most attention

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
User query matches → resurrectByTuple() (deleted=false, brightness=brightness_at_deletion)
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

### 7. Persistent Storage & Infinite Conversation (persistent_store.js)

**It's all one conversation.** Position IDs are absolute and count upward forever. Conversations persist across browser sessions via IndexedDB.

**Core concept:**
- Position 0 = first token ever spoken
- Position 1,000,000 = a token from 6 months later
- Close and reopen the browser → conversation continues from where it left off
- No "sessions" - just an infinite timeline of tokens

#### Split-Store Architecture (Database v2)

For performance at scale (1M+ tokens), tokens are stored in two separate IndexedDB stores:

**Store: `liveTokens`** (keyPath: position)
- Contains all active context (deleted=false)
- Fast retrieval: O(k) where k = active count (~30K typical)
- Optimized for frequent reads during rendering

**Store: `deadTokens`** (keyPath: position)
- Contains all pruned context (deleted=true)
- Target for semantic resurrection
- Rarely read, only during resurrection

**Store: `semantic_entries`** (auto-increment ID)
```javascript
{
  id: auto-increment,
  turn_id: number,
  sentence_id: number,
  role: string,
  text: string,
  embedding: Array<number>,  // Float32Array stored as array
  tokenCount: number,
  timestamp: Date
}
```

**Store: `metadata`** (keyPath: "state")
```javascript
{
  key: "state",
  nextPosition: number,      // Next available position ID
  nextTurn: number,          // Next available turn ID
  currentSentence: number,
  currentRole: string,
  lastModified: Date
}
```

#### Split-Store Performance

At 1M total tokens with 30K active:

| Operation | Time | Frequency |
|-----------|------|-----------|
| Get active context | 10-50ms | Every frame (30-60 FPS) |
| Prune chunk | 20ms | Once per turn |
| Resurrect chunk | 30ms | Once per turn |

**Key insight:** Optimize for reads (get active), accept slightly slower writes (prune/resurrect).

**Why split stores?**
- Single store with filtering: O(n) scan of 1M = 500ms-1s
- Split stores: O(k) read of 30K = 10-50ms
- **10-50x faster rendering** at scale

#### Universal Resurrection Equation

Works the same on turn 1 and turn 1000:

```javascript
resurrection_budget = model_max_context - current_context - user_prompt - generation_max

// Turn 1 (empty context):
// 32000 - 0 - 200 - 200 = 31,600 tokens

// Turn 50 (context has 25K tokens):
// 32000 - 25000 - 200 - 200 = 6,600 tokens
```

#### Resurrection Flow

```
User types message
       │
       ▼
Calculate budget (universal equation)
       │
       ▼
Query semantic index (in-memory, loaded from IndexedDB on startup)
       │
       ▼
Determine chunks to resurrect (within budget, with turn pairs)
       │
       ▼
Load missing turns from deadTokens (by turn_id, in parallel)
       │
       ▼
Add tokens to conversation.tokens[], sort by position
       │
       ▼
Move chunks from deadTokens to liveTokens (deleted=false)
       │
       ▼
Render UI (resurrected context visible in chronological order)
       │
       ▼
Tokenize user message (nextPosition continues from where it left off)
       │
       ▼
Add user tokens (persist to liveTokens fire-and-forget)
       │
       ▼
Generate response
       │
       ▼
Brightness scoring, pruning (move chunks from liveTokens to deadTokens)
       │
       ▼
Index new chunks (embed, persist to IndexedDB)
       │
       ▼
Save metadata (nextPosition, nextTurn)
```

#### Key Methods

**conversation.js:**
- `loadTokensFromStore(positions)` - Load tokens by position IDs from persistent_store
- `loadMetadataFromStore()` - Restore nextPosition, nextTurn on startup
- `saveMetadataToStore()` - Persist metadata after each turn

**semantic_index.js:**
- `loadFromStore()` - Load all semantic entries with embeddings on startup
- `_persistEntry()` - Save entries to IndexedDB after embedding

**persistent_store.js:**
- `getAllLiveTokens()` - Get all active context (fast, no filtering)
- `pruneChunk(turn_id, sentence_id, role)` - Move chunk from liveTokens to deadTokens
- `resurrectChunk(turn_id, sentence_id, role)` - Move chunk from deadTokens to liveTokens
- `isChunkAlive(turn_id, sentence_id, role)` - Fast existence check in liveTokens
- `getTokensByTurn(turn_ids)` - Load turns from deadTokens for resurrection

**Important properties:**
- Position IDs are absolute, never reset, never reused
- Turn IDs count upward forever
- Metadata persists state across sessions (nextPosition ensures no collisions)
- Fire-and-forget persistence (non-blocking saves)

### 8. Turn-Pair Embeddings & Resurrection Strategy (semantic_index.js)

**Philosophy: We resurrect with conversational context, so we embed with conversational context.**

The old strategy embedded chunks with sequential neighbors (N-1, N, N+1). The new strategy embeds chunks with their **conversational partners** - encoding the Q→A relationship directly.

**Crucially: Resurrection now matches embedding.** When we retrieve Assistant turn 30, sentence 5, we also resurrect User turn 29, sentence 0 AND Assistant turn 30, sentence 0 - the same chunks we embedded with.

#### Embedding Strategy

**Assistant chunks:**
```
Context = [User S0 from turn N-1] + [Assistant S0 from turn N] + [Target chunk]
```

**User chunks:**
```
Context = [User S0 from turn N] + [Target chunk] + [Assistant S0 from turn N+1]
```

**System chunks:**
```
Context = [Target chunk only]
```

**Special case - when target IS sentence_0:**
- Don't add sentence_0 twice
- Assistant S0: `[User S0 from turn N-1] + [Target]` (2 chunks)
- User S0: `[Target] + [Assistant S0 from turn N+1]` (2 chunks)

#### Resurrection Strategy

**Matches embedding exactly:**

When semantic search returns Assistant turn 30, sentence 5:
1. Resurrect User turn 29, S0 (the question that prompted this)
2. Resurrect Assistant turn 30, S0 (opening of answer)
3. Resurrect Assistant turn 30, S5 (target chunk)

**Budget calculation:**
```javascript
// For Assistant S5 (not sentence_0)
crossTurnCost = User S0 tokens (if dead, 0 if alive)
sameTurnCost = Assistant S0 tokens (if dead, 0 if alive)
targetCost = target tokens (if dead, 0 if alive)
totalCost = targetCost + crossTurnCost + sameTurnCost

// For Assistant S0 (is sentence_0)
crossTurnCost = User S0 tokens (if dead)
sameTurnCost = 0 (don't count sentence_0 twice)
targetCost = target tokens (if dead)
totalCost = targetCost + crossTurnCost
```

**Smart deduplication:**
- Skip chunks already alive (cost = 0)
- Don't count sentence_0 twice when it's the target
- Only resurrect chunks within budget

#### Why Turn-Pair Embeddings Work

**Example conversation:**
```
Turn 5 (user):    "How does brightness scoring work?"
Turn 6 (assistant): "Brightness scoring uses magnitude voting..."
                    "The algorithm excludes BOS tokens..."
                    "Scores are capped at 10000..."
```

When we resurrect turn 6's third chunk ("Scores are capped..."), we also bring:
- Turn 5, S0 (the original question) ← context
- Turn 6, S0 (opening of the answer) ← topic

The embedding was built with these same chunks, so retrieval quality matches the Q→A structure.

**Benefits:**
- ✅ Captures conversational structure (not just sequential)
- ✅ Encodes question that prompted the response
- ✅ Opening sentences provide topic context
- ✅ Resurrection matches embedding (same chunks)
- ✅ Better relevance for conversational queries

**Comparison with old sequential strategy:**

| Aspect | Sequential (Old) | Turn-Pair (New) |
|--------|------------------|-----------------|
| Context | N-1, N, N+1 within same turn | Question + Answer openings + Target |
| Captures | Sequential flow in response | Conversational Q→A structure |
| Best for | Detailed explanations | Topic retrieval |
| Resurrection | Mismatched (used turn pairs anyway) | Matched (embed and resurrect same) |

#### Edge Cases

- **System chunks:** Embed in isolation (no conversational partner)
- **First user turn:** No previous assistant turn (forward reference only)
- **Last assistant turn:** No next user turn (acceptable, backward reference only)
- **Orphaned turns:** If turn N+1 doesn't exist yet, user chunks embed without forward reference
  - **Note:** Not re-embedded when turn N+1 arrives (minor limitation, low impact)

#### Maximum Embedding Context

Limit: **256 tokens** (all-MiniLM-L6-v2)

If chunks don't fit:
1. **Priority 1:** Target chunk (always included)
2. **Priority 2:** Cross-turn S0 (from other role)
3. **Priority 3:** Same-turn S0 (if target is not S0)

Chunks exceeding 256 tokens are truncated (topic still captured).

### 9. Anchor-Protected Pruning (conversation.js)

**Philosophy: S0 chunks are conversation anchors - they must be pruned with their turn pairs to maintain conversational coherence.**

Brightness-based pruning could create incoherent situations:
- AT4S4 survives (very bright) but UT3S0 (the question) gets pruned
- Now the answer has no question

**Anchor Protection Rule:**

For each turn pair (User Turn N → Assistant Turn N+1):
- **UT_N S0** and **AT_(N+1) S0** form an anchor pair
- Anchors are immune to pruning UNLESS:
  1. The anchor is the ONLY remaining chunk from its turn
  2. Its paired anchor is ALSO the only remaining chunk from its turn
  3. They prune together (atomically)

**Example pruning sequence:**
```
Turn 3 (user):      S0 (bright), S1 (dim), S2 (medium)
Turn 4 (assistant): S0 (bright), S1 (dim), S2 (medium), S3 (bright), S4 (very dim)

Step 1: Prune AT4S4, UT3S1, AT4S1, UT3S2, AT4S2, AT4S3
Result: Turn 3: S0 only, Turn 4: S0 only

Step 2: Try to prune UT3S0
→ Both anchors are solo - prune atomically
→ 🔗 Pruned anchor pair: user turn 3 + assistant turn 4
Result: Both turns completely gone
```

**Benefits:**
- ✅ Any surviving chunk has conversational context (its S0 anchor guaranteed)
- ✅ Resurrection brings meaningful context (S0 pairs resurrected together)
- ✅ Pruning mirrors embedding (both use turn-pair strategy)
- ✅ Q→A structure preserved even under extreme pruning
- ✅ The conversation skeleton (all S0 chunks) is the last thing deleted

**Implementation:** `conversation.js:_isAnchorProtected()` and `pruneToFit()`

### 10. Graveyard Sidebar & Manual Resurrection

**The UI is a read-only view of the database.** The main panel shows `liveTokens`, the graveyard shows `deadTokens`.

**Graveyard Features:**
- Right sidebar (collapsible)
- Toggle button: ⚰️ in stats bar
- Lists all pruned chunks from `deadTokens` store
- Shows: turn ID, role, sentence ID, token count, peak brightness at deletion
- Click any chunk to resurrect

**Manual Resurrection Flow:**
```
User clicks chunk in graveyard
       │
       ▼
store.resurrectChunk() - move from deadTokens → liveTokens
       │
       ▼
Load resurrected tokens into memory
       │
       ▼
Pin all tokens (token.pinned = true) + brightness = 10000 - USER SIGNAL
       │
       ▼
Persist pinned state and brightness to database
       │
       ▼
Rebuild UI - chunk reappears at chronological position with 📌
```

**Signal Hierarchy (strongest to weakest):**
1. **User manual resurrection** → 10k brightness + auto-pin (strongest signal - explicit user declaration)
2. **User manual pin** → 10k brightness + pin explicitly via UI
3. **High attention** → Earned brightness → survives brightness-based pruning
4. **Semantic match** → brightness_at_deletion → auto-resurrected but not pinned (preserves earned signal, must re-prove relevance)

Manual resurrection is an explicit user declaration: "I need this." The system pins it permanently.

### 11. DB-First Architecture & Rehydration

**Core Principle:** The UI reflects the database, not in-memory state.

**On Startup (Rehydration):**
```
Initialize IndexedDB
       │
       ▼
Load metadata (nextPosition, nextTurn)
       │
       ▼
Load semantic index (all embeddings)
       │
       ▼
Load all liveTokens into memory
       │
       ▼
Render conversation (main panel)
       │
       ▼
Connect to KoboldCPP
```

**User Input (DB-First):**
- Tokenize → Write to DB (AWAIT) → Index (AWAIT) → Render
- **Invariant:** If it's visible in UI, it's persisted in DB

**Streaming Generation (Performance-First):**
- Token arrives → Add to memory → Render → DB write (fire-and-forget)
- Brightness updates during generation → In-memory only (performance)
- **Tradeoff:** Brief window where UI > DB during generation
- **Acceptable:** User can't interact during generation, so inconsistency is unobservable

**After Generation Completes:**
- **CRITICAL:** Persist all brightness updates to database
- Without this, reloading destroys accumulated signal (thousands of tokens worth)
- Fire-and-forget batch save of all active tokens
- Then: semantic indexing, pruning, stats

**Between Turns (Consistency Checkpoint):**
- All DB writes complete before user can send next message
- Invariant restored: UI = DB

### 12. Tool System (tool_system.js)

**Purpose:** Give the AI persistent note-taking ability through a familiar jq-like interface.

**Architecture:**
- Tool calls embedded in assistant responses: `<tool>jq command</tool>`
- Simplified jq parser supporting common operations
- Persistent JSON storage in IndexedDB (`tool_data` store)
- **Compact results** - Shows only path/value changed, not full JSON
- **Text markers** - Results use `⚙️【command】→ result` format that survives tokenization
- **Continuation loop** - Model continues generating after tool execution (up to 5 iterations)

**Supported Operations:**

**Reading:**
```bash
<tool>jq '.' notes.json</tool>                    # Show entire file
<tool>jq '.topics' notes.json</tool>              # Get specific field
<tool>jq '.array[0]' notes.json</tool>            # Array index access
```

**Writing (requires `> output`):**
```bash
<tool>jq '.field = "value"' notes.json > output</tool>           # Set field
<tool>jq '.array += ["item"]' notes.json > output</tool>         # Append to array
<tool>jq '. + {"new": "field"}' notes.json > output</tool>       # Merge object
<tool>jq 'del(.field)' notes.json > output</tool>                # Delete field
```

**Notes Structure:**
```json
{
  "_metadata": {
    "created": "ISO timestamp",
    "last_modified": "ISO timestamp",
    "description": "AI assistant's persistent notes"
  },
  "topics": {},      // Topic-keyed information
  "reminders": [],   // List of reminders
  "context": {},     // Contextual information
  "scratch": {}      // Temporary workspace
}
```

**Processing Flow:**
```
Generation completes
       │
       ▼
_processToolCalls() detects <tool>...</tool> tags
       │
       ▼
Execute each tool via ToolSystem
       │
       ▼
Add compact result as tokens: ⚙️【command】→ ✓ .path = "value"
       │
       ▼
Tools executed? ────Yes────► _continueGeneration() ────┐
       │                                               │
       No                                              │
       │                                               │
       ▼                                               │
Generation complete ◄─────────────────────────────────┘
                           (up to 5 iterations)
```

**Key Features:**
- **Persistent across sessions** - Notes survive browser refresh
- **Familiar interface** - Uses jq syntax already in training data
- **Safe execution** - Limited to JSON manipulation, no system access
- **Compact results** - `✓ .context.name = "value"` instead of full JSON dump
- **Text markers** - `⚙️【】→✓❌` survive brightness scoring and tokenization
- **Continuation loop** - Model can use multiple tools and continue reasoning

**UI Styling:**
- Tool result tokens rendered in **cyan** (#4ecdc4) with subtle background
- Markers detected via text pattern matching (survives import/export)
- Color persists through brightness updates (not overwritten)

---

## Development Guidelines

### When Modifying conversation.js

**DO:**
- ✅ Maintain position uniqueness
- ✅ Preserve deleted tokens in array (soft-delete)
- ✅ Update chunk tracking on paragraph/code boundaries
- ✅ Keep fail-bright principle (new tokens = 10000)
- ✅ Respect anchor protection in pruning (S0 chunks must prune with pairs)
- ✅ Use `waitForPersist: true` for critical writes (user messages)
- ✅ Calculate mean brightness during updates (for semantic resurrection)
- ✅ Use flat -1 decay (maintains stratification)

**DON'T:**
- ❌ Reuse position IDs
- ❌ Actually remove deleted tokens from array
- ❌ Retokenize existing context
- ❌ Initialize tokens at 0 brightness (use 10000)
- ❌ Prune S0 anchors without their paired anchor
- ❌ Allow UI to render before DB persistence completes (for user input)
- ❌ Use proportional decay (collapses distribution to mean)
- ❌ Boost semantic resurrection brightness (destroys earned stratification)
- ❌ Skip persisting brightness after generation (loses signal on reload)

### When Modifying kobold_client.js

**DO:**
- ✅ Use SSE (Server-Sent Events) for streaming generation
- ✅ Decode base64-encoded attention tensors
- ✅ Use 5s timeout on tokenize requests
- ✅ Handle attention data with shape [layers, heads, context_length]

**DON'T:**
- ❌ Store conversation state (client is stateless)
- ❌ Assume specific model (query /api/v1/model)
- ❌ Skip error handling for missing attention data

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
- ✅ Rehydrate conversation on startup (load liveTokens from DB)
- ✅ Update graveyard sidebar after pruning (if visible)
- ✅ Pin chunks when user manually resurrects them

**DON'T:**
- ❌ Put business logic here (delegate to modules)
- ❌ Bypass component interfaces
- ❌ Block on async operations without feedback
- ❌ Assume KoboldCPP is always available
- ❌ Render UI before DB writes complete (for user input)

### When Modifying persistent_store.js

**DO:**
- ✅ Use transactions for multi-store operations (prune/resurrect)
- ✅ Use fire-and-forget saves for non-critical writes
- ✅ Index by (turn_id, sentence_id, role) for fast chunk lookups
- ✅ Keep liveTokens and deadTokens strictly separated
- ✅ Handle database upgrade migrations carefully

**DON'T:**
- ❌ Merge liveTokens and deadTokens stores (defeats performance gains)
- ❌ Block on save operations (use fire-and-forget)
- ❌ Forget to handle schema migrations (would break existing databases)
- ❌ Store derived data (compute on read, e.g., chunk text from tokens)

### When Modifying semantic_index.js

**DO:**
- ✅ Embed with turn-pair context (User S0 + Assistant S0 + Target)
- ✅ Persist entries after embedding (to IndexedDB)
- ✅ Handle embedding errors gracefully (model load can fail)
- ✅ Use Web Worker for embedding (off main thread)
- ✅ Account for all resurrected chunks in budget (target + pairs)

**DON'T:**
- ❌ Revert to sequential embedding (N-1, N, N+1)
- ❌ Resurrect without turn pairs (breaks Q→A structure)
- ❌ Count sentence_0 twice when it's the target
- ❌ Forget to check if chunks are already alive (wastes budget)
- ❌ Skip cross-turn or same-turn S0 (incomplete context)

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
- **Initial Brightness:** 10000 (fail-bright)
- **Decay per step:** -1 flat (when below threshold)
- **Brightness cap:** 10000 (prevents runaway scores)
- **Brightness floor:** None (can go negative for rank-based pruning)

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
5. **Current Turn Immunity** - Current turn tokens stay at 10000 (bright)
6. **Score Decay** - Tokens below threshold lose 1 brightness per step (flat decay)
7. **Pruning** - Low-brightness chunks removed when over token budget (rank-based)
8. **Semantic Resurrection** - Resurrected chunks start at mean brightness
9. **Manual Resurrection** - Graveyard chunks resurrect at 10k with pin
10. **Settings** - All controls update config correctly
11. **Persistence** - Settings and conversation saved across page reload
12. **Export** - JSON export contains full conversation state

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

// Persistent store stats
await window.app.store.getStats()
// { liveTokens: 28453, deadTokens: 971547, semanticEntries: 15234, nextPosition: 1000000, nextTurn: 5000 }

// View metadata
await window.app.store.getMetadata()

// Check if chunk is alive
await window.app.store.isChunkAlive(turn_id, sentence_id, role)

// Force rebuild display
window.app.renderer.rebuild(window.app.conversation)

// Abort current generation
window.app.client.abort()

// Export entire database (warning: can be very large!)
const data = await window.app.store.exportAll()

// Clear database (destructive!)
await window.app.store.clearAll()
```

---

## Common Issues



### Attention not updating

**Cause:** KoboldCPP not returning attention data (API not implemented)

**Fix:**
1. Check browser console for errors
2. Verify SSE endpoint `/api/extra/generate/stream` is available
3. Confirm KoboldCPP has attention extraction enabled
4. Check for base64 decoding errors in console

### Tokens not decaying

**Cause:** Tokens only decay when attention is below threshold

**Fix:**
1. Verify generation is happening (decay only occurs during generation)
2. Check that tokens aren't in current turn (immune until next turn)
3. Inspect `conversation.getStats()` to see brightness range

### JavaScript errors on token add

**Cause:** DOM structure mismatch or missing sentence element

**Fix:**
1. Check renderer has turn element for current turn_id
2. Verify conversation.currentRole is set before adding tokens
3. Rebuild display: `app.renderer.rebuild(app.conversation)`

### Database not persisting / Lost conversation after refresh

**Cause:** IndexedDB initialization failed or browser privacy settings

**Fix:**
1. Check browser console for IndexedDB errors
2. Verify browser allows IndexedDB (not in private/incognito mode)
3. Check `await app.store.getStats()` - should show token counts
4. Try different browser (some Firefox privacy settings block IndexedDB)
5. Clear IndexedDB manually if corrupted: `await app.store.clearAll()`

### Slow performance with large database (1M+ tokens)

**Cause:** Expected behavior at scale, but should still be acceptable

**Check:**
1. `await app.store.getStats()` - How many liveTokens vs deadTokens?
2. If liveTokens > 50K, pruning may be too conservative (increase brightness decay or lower max context)
3. Get active context time: Should be 10-50ms even with 1M total tokens
4. If slower, check browser DevTools Performance tab for bottlenecks

---

## Performance

### Current Performance

**Typical generation (500 token context):**
- **Wall clock:** ~27ms/token
- **Token gaps (network + model):** ~22ms/token
- **Our processing:** ~5ms/token
  - addToken: ~0.1ms
  - updateBrightness: ~0.04ms
  - updateColors: ~0.1ms
  - renderToken: ~0.1ms
- **Attention size:** ~1MB/token (base64-encoded)

**Large context (1700+ tokens):**
- **Wall clock:** ~78ms/token
- **Token gaps:** ~71ms/token
- **Our processing:** ~6ms/token
- **Attention size:** ~6.5MB/token (base64-encoded)

**Semantic index operations:**
- First embed: ~2-3s (model init + WASM warmup)
- Subsequent embeds: ~40-60ms/chunk
- Search (10K chunks): ~4ms
- Search (100K sentences): ~40ms

### Optimizations Already Implemented

1. **O(1) DOM lookups** - tokenElements Map
2. **requestAnimationFrame debouncing** - Coalesce color updates
3. **Active token caching** - Avoid repeated filter operations
4. **Numeric sentence keys** - Avoid string concatenation in hot path
5. **Client-side attention aggregation** - Efficient mean calculation across layers/heads

### If Performance Becomes an Issue

**Already implemented:**
1. ✅ **Web Workers** - Semantic index embedding runs off main thread
2. ✅ **IndexedDB** - Full persistence (tokens, semantic index, metadata)
3. ✅ **Split stores** - liveTokens/deadTokens for 10-50x faster active context retrieval

**Remaining optimization targets:**
1. **Virtual scrolling** - Only render visible tokens (useful for very long active contexts)
2. **Batch DOM updates** - Update colors every N tokens instead of every token
3. **Compression** - gzip embeddings in IndexedDB to reduce storage

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

**Streaming Generation (SSE):**
```
POST /api/extra/generate/stream
→ data: {"type": "token", "token": {...}, "attention": {base64 encoded}}
→ data: {"type": "done", ...}
```

### Attention Data Format

**SSE with base64-encoded tensor:**
```json
{
  "format": "per_layer",
  "shape": [28, 28, 500],
  "encoding": "base64",
  "dtype": "float32",
  "data": "AAAA...",
  "context_length": 500
}
```

The client decodes the base64 data and aggregates across layers and heads to produce the final attention scores.

---

## Known Issues / TODO

### Recently Fixed

- [x] **Semantic index uniqueness constraint error** - Fixed saveSemanticEntry() to do proper upsert (check for existing record before insert) ✅ Fixed 2025-12-26
- [x] **Conversation not rehydrating on startup** - Added loadAllLiveTokensFromStore() to restore conversation from IndexedDB ✅ Fixed 2025-12-26
- [x] **Graveyard toggle button unreachable** - Moved toggle button from inside collapsible graveyard to stats bar ✅ Fixed 2025-12-26
- [x] **End token tokenization hanging** - `<|im_end|>` tokenization after generation sometimes hangs. Currently commented out in app.js. ✅ Fixed 2025-12-29

### Bugs to Investigate



### Future Improvements

**Short Term:**
- [ ] Add visual settings (font size, color scheme)
- [ ] Currently we don't count attention for current turn, this is a holdover from a past version. We should allow current turn tokens to accrue attention and decay. 
- [x] Add Timestamps to user turns.✅ Implemented 2025-12-29
- [x] Manual chunk deletion from UI (currently can only prune via brightness)
- [x] **Manual resurrection from graveyard** - Click pruned chunks to resurrect ✅ Implemented 2025-12-26
- [x] **Auto-pin on manual resurrection** - User resurrection signals importance ✅ Implemented 2025-12-26
- [x] **Anchor-protected pruning** - S0 chunks from turn pairs must prune together ✅ Implemented 2025-12-26
- [x] **DB-first architecture** - UI reflects database state, not memory ✅ Implemented 2025-12-26
- [x] **Pin chunks** - Mark chunks as immune to pruning ✅ Implemented
- [x] **Merge chunks** - Combine two adjacent chunks (update sentence_ids, re-embed) ✅ Implemented
- [x] **Paired resurrection** - User chunks bring assistant s0 from next turn, assistant chunks bring user s0 from previous turn. Preserves Q→A structure. ✅ Implemented
- [x] **User boost in retrieval** - User content gets 1.5x similarity boost (denser signal, smaller chunks) ✅ Implemented

**Medium Term:**
- [ ] Multiple conversation tabs
- [x] Web Workers for semantic index embedding (off main thread) ✅ Implemented
- [x] **Infinite conversation persistence (IndexedDB)** - Conversations persist across sessions, position IDs absolute ✅ Implemented
- [x] **Split-store optimization** - liveTokens/deadTokens for 10-50x faster rendering at scale ✅ Implemented
- [x] **Turn-pair embeddings** - Embed with conversational context (Q+A structure) instead of sequential ✅ Implemented
- [ ] Attention pattern analysis (which tokens attended to which)
- [ ] **MMR (Maximal Marginal Relevance) for resurrection** - Instead of top-K by similarity, iteratively select chunks that maximize `λ * sim(query, chunk) - (1-λ) * max_sim(chunk, already_selected)`. Prevents resurrecting 10 variations of the same idea. Only implement if redundancy becomes a visible problem - attention decay may already handle this naturally.

**Long Term:**
- [ ] Multi-model comparison
- [ ] Attention-based summarization
- [ ] Adaptive pruning based on model confidence

---

## Dependencies

**Runtime:**
- Modern browser (Chrome 120+, Firefox 120+)
- KoboldCPP server with attention extraction and SSE support
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
- Modifying brightness scoring algorithm in conversation.js (e.g., changing decay strategy)
- Altering kobold_client.js API expectations
- Changing localStorage schema (would break existing users)
- Modifying semantic index entry format (would break saved exports)
- Changing IndexedDB schema (requires version migration)
- Merging liveTokens/deadTokens stores (would destroy performance at scale)
- Reverting turn-pair embedding strategy (would create embedding inconsistency)
- Removing anchor protection (would break conversational coherence)
- Changing DB-first architecture to in-memory-first (would violate consistency guarantees)
- Disabling auto-pin on manual resurrection (would ignore strongest user signal)
- Changing brightness initialization values (10k for new/manual, mean for semantic)
- Reverting to proportional decay (would collapse stratification)

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
2. **Fail bright** - New tokens start at 10k (maximum runway to prove relevance)
3. **Soft-delete** - Never actually remove data, just mark deleted
4. **Deterministic** - Same input → same output
5. **Debuggable** - Always accessible via console
6. **UI reflects DB** - Between interactions, UI state = Database state
7. **User signal is strongest** - Manual actions (resurrection, pinning) → 10k + pin
8. **Rank-based pruning** - Delete lowest brightness, not below-threshold (no floor needed)
9. **Stratification matters** - Flat decay maintains differentiation (proportional collapses to mean)

---

## Related Documentation

**Core Documentation:**
- `KOBOLD_API_SPEC.md` - KoboldCPP API specification
- `BRIGHTNESS_STRATEGIES.md` - Comparison of scoring algorithms
- `tests/README.md` - Test framework documentation

**Feature-Specific Documentation (Integrated into this file):**
- `INFINITE_CONVERSATION.md` - Persistent storage via IndexedDB (see Section 7)
- `SPLIT_STORE_OPTIMIZATION.md` - liveTokens/deadTokens architecture (see Section 7)
- `TURN_PAIR_EMBEDDINGS.md` - Conversational embedding strategy (see Section 8)
- Anchor-protected pruning (see Section 9)
- Graveyard sidebar & manual resurrection (see Section 10)
- DB-first architecture & rehydration (see Section 11)
- `SEMANTIC_INDEX.md` - Original semantic index design document (legacy)

**Legacy:**
- `../attention_heatmap/` - Reference implementation (PyTorch proof of concept)

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
9. Does this break IndexedDB schema? (if yes, add database version migration)
10. Does this change the split-store architecture? (merging liveTokens/deadTokens would kill performance)
11. Does this change turn-pair embedding strategy? (would create inconsistency with existing embeddings)
12. Does this violate anchor protection? (S0 chunks must prune with their pairs)
13. Does this break the DB-first invariant? (UI should reflect DB state between interactions)
14. Does this allow manual resurrection without pinning? (user signal must be respected)
