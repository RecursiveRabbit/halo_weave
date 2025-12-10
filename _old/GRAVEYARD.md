# The Graveyard - Semantic Context Resurrection

**Status:** Design Phase
**Created:** 2025-12-06

---

## Concept

When brightness-based pruning deletes a sentence, it doesn't truly die. Instead, it enters **The Graveyard** - a vector database of pruned context that can be resurrected when semantically relevant to new user input.

```
Active Context                    The Graveyard
┌─────────────────┐              ┌─────────────────┐
│ System Prompt   │              │ [vector] + meta │
│ Turn 1 User     │   prune →    │ [vector] + meta │
│ Turn 1 Asst     │              │ [vector] + meta │
│ Turn 2 User     │   ← resurrect│ [vector] + meta │
│ Turn 2 Asst     │              │ ...             │
│ [current turn]  │              │                 │
└─────────────────┘              └─────────────────┘
        ↑                                ↑
        │                                │
        └──── semantic search ───────────┘
              on user message
```

**Key insight:** The model's own attention patterns determine what gets archived. Semantic relevance determines what comes back. This is **dynamic context resurrection**, not static document retrieval.

---

## Architecture Decisions

### 1. When to Query

**Decision:** Query on every user message, before generation.

**Rationale:**
- User messages are natural query points (new topic introduction)
- RAG is designed for 100K+ documents; our graveyard will be tiny by comparison
- A conversation pruning 50 sentences/hour is nothing vs typical RAG scale
- Target latency: <100ms for query + resurrection

**Implementation:**
```javascript
async _handleSend() {
    // 1. Tokenize user message
    // 2. Query graveyard with user text
    // 3. Resurrect relevant sentences (within token budget)
    // 4. Add user message to conversation
    // 5. Generate response
}
```

### 2. What to Store

**Decision:** Vectorize sentence text. Store metadata separately.

**Stored per sentence:**
```javascript
{
    // For vector search
    embedding: Float32Array,      // Sentence embedding
    text: string,                 // Original sentence text
    
    // For resurrection
    turn_id: number,              // Which conversation turn
    sentence_id: number,          // Which sentence in turn
    role: string,                 // "user" | "assistant" | "system"
    token_positions: number[],    // Position IDs of tokens in sentence
    
    // For prioritization
    peak_brightness: number,      // Highest brightness before death
    death_time: number,           // When it was pruned (for recency)
    resurrection_count: number    // How many times resurrected (curiosity metric)
}
```

**Why peak_brightness matters:** A sentence that was once highly attended is more likely to be valuable when resurrected. It proved its worth before fading.

### 3. Resurrection Budget

**Decision:** Token quota system with user message priority.

**Formula:**
```
resurrection_budget = max(0, 512 - user_message_tokens)
```

**Examples:**
| User Message | Budget | Behavior |
|--------------|--------|----------|
| 40 tokens    | 472    | Fill with up to 472 tokens of graveyard context |
| 200 tokens   | 312    | Fill with up to 312 tokens |
| 512 tokens   | 0      | No resurrection (user filled quota) |
| 800 tokens   | 0      | No resurrection (over quota) |

**Rationale:**
- User input is always highest priority
- Resurrection fills "empty space" in the context budget
- Prevents resurrection from crowding out user intent
- 512 is tunable (UI slider?)

**Selection priority when budget allows multiple sentences:**
1. Semantic similarity to user query (primary)
2. Peak brightness (tiebreaker - more interesting = higher priority)
3. Recency of death (tiebreaker - recently pruned = more relevant to current conversation)

### 4. Storage & Embedding

**Decision:** All in-browser. Local embedding model.

**Why in-browser:**
- Current architecture is pure frontend (no Python backend)
- Conversation data stays local (privacy)
- No server round-trips (latency)
- Graveyard persists with conversation export/import

**Embedding options (ranked by preference):**

| Option | Size | Speed | Quality | Notes |
|--------|------|-------|---------|-------|
| **Xenova/all-MiniLM-L6-v2** | 23MB | ~50ms | Good | ONNX, runs in browser via transformers.js |
| Xenova/bge-small-en-v1.5 | 33MB | ~70ms | Better | Slightly larger, better retrieval |
| Xenova/gte-small | 33MB | ~60ms | Better | Good balance |
| TensorFlow.js USE | 28MB | ~100ms | Decent | Universal Sentence Encoder, older |

**Recommendation:** Start with `all-MiniLM-L6-v2` via transformers.js
- 384-dimensional embeddings
- ~50ms per sentence on modern hardware
- Well-tested, widely used for semantic search
- WASM backend, no GPU required

**Vector search:**
- For <1000 sentences: brute-force cosine similarity is fine (~1ms)
- If scale becomes issue: hnswlib-wasm for approximate nearest neighbor

### 5. Resurrection Mechanics

**When a sentence is resurrected:**
```javascript
resurrect(sentence) {
    for (const position of sentence.token_positions) {
        const token = this.tokens.find(t => t.position === position);
        token.deleted = false;
        token.brightness = 255;  // Fresh start
    }
    sentence.resurrection_count++;
    this._invalidateCache();  // Rebuild active token list
}
```

**Key points:**
- Tokens get brightness 255 (same as new tokens)
- They have 255 opportunities to prove valuable again
- If they fade again, they return to graveyard (no special treatment)
- No cooldown - natural selection via attention

**Position ordering:**
- Resurrected tokens retain their original position IDs
- They slot back into correct chronological order in context
- Model sees them in original conversation flow

---

## Data Flow

### Pruning → Graveyard

```
1. pruneToFit() identifies lowest peak-brightness sentence
2. For each token in sentence: token.deleted = true
3. Compute sentence embedding (async, non-blocking)
4. Store in graveyard: {embedding, text, metadata}
5. Rebuild active token cache
```

### User Message → Resurrection

```
1. User submits message
2. Tokenize message, count tokens
3. Calculate resurrection_budget = max(0, 512 - token_count)
4. If budget > 0:
   a. Embed user message
   b. Query graveyard for top-K similar sentences
   c. Filter to fit within token budget
   d. Sort by: similarity > peak_brightness > death_recency
   e. Resurrect selected sentences
5. Add user message to conversation
6. Generate response
```

---

## Open Questions

### Resolved
- [x] When to query? → Every user message
- [x] What to vectorize? → Sentence text
- [x] What metadata to store? → turn_id, sentence_id, role, positions, peak_brightness
- [x] Resurrection budget? → 512 - user_tokens
- [x] Storage location? → In-browser
- [x] Embedding model? → all-MiniLM-L6-v2 via transformers.js

### To Decide During Implementation
- [ ] Should system prompt sentences ever enter graveyard? (Probably no - they're protected from pruning)
- [ ] UI for graveyard visibility? (Show count? List contents? Resurrection log?)
- [ ] Export/import graveyard with conversation? (Probably yes)

### Resolved: Graveyard Eviction Policy

**Decision:** FIFO with revival refresh.

**Performance analysis:**
- Brute-force cosine similarity: O(n × embedding_dim)
- 10K sentences: ~4ms search
- 100K sentences: ~40ms search  
- 1M sentences: ~400ms search (still usable)

**Memory footprint (384-dim embeddings):**
- 10K sentences: 15MB
- 100K sentences: 150MB
- 1M sentences: 1.5GB

**Practical limit:** Memory, not compute. 100K sentences (150MB) is comfortable.
At 20 tokens/sentence average, that's **2 million tokens** - hundreds of hours of conversation.

**The graveyard will never be the bottleneck.** Set cap based on memory budget, not performance.

**Rules:**
1. Graveyard has a maximum size (configurable, default 100K sentences / ~150MB)
2. New entries go to the front of the queue
3. When graveyard is full, evict from the back (oldest unreferenced)
4. When a sentence is resurrected, it leaves the graveyard entirely
5. If that sentence gets pruned again later, it re-enters at the front (fresh)

**Lifecycle:**
```
Active Context ──prune──→ Graveyard Front
                              │
                              ↓ (time passes, new entries push it back)
                              │
                         Graveyard Back ──evict──→ TRUE DEATH
                              │
                              ↑
                    resurrect (leaves graveyard,
                     re-enters active context)
```

**Why this works:**
- Context gets 255 chances in active context to prove itself
- If pruned, it waits in graveyard for semantic relevance
- If never referenced again, it eventually hits the back and dies for real
- If resurrected, it gets another 255 chances - no free passes
- Simple FIFO means no complex scoring for eviction

**Implementation:**
```javascript
// Graveyard as array (front = index 0, back = index length-1)
this.entries = [];  

add(entry) {
    this.entries.unshift(entry);  // Add to front
    if (this.entries.length > this.maxSize) {
        this.entries.pop();  // Evict from back (TRUE DEATH)
    }
}

resurrect(entry) {
    // Remove from graveyard entirely
    const idx = this.entries.indexOf(entry);
    if (idx !== -1) this.entries.splice(idx, 1);
    // Entry returns to active context (handled by conversation.js)
}
```

---

## Implementation Phases

### Phase 1: Graveyard Data Structure ✅ COMPLETE
- [x] Create `graveyard.js` module
- [x] Define GraveyardEntry structure
- [x] Implement add() method (called from pruning)
- [x] Implement FIFO storage with maxSize eviction
- [x] Add to conversation export/import

### Phase 2: Embedding Pipeline ✅ COMPLETE
- [x] Integrate transformers.js (CDN import)
- [x] Load all-MiniLM-L6-v2 model (lazy, on first prune)
- [x] Implement embed() method with mean pooling + normalization
- [ ] Benchmark embedding latency (needs testing)

### Phase 3: Semantic Search ✅ COMPLETE
- [x] Implement _cosineSimilarity() for vector comparison
- [x] Implement query() method (embed query, find top-K within token budget)
- [x] Priority sorting: similarity > peak_brightness > death_recency
- [ ] Benchmark search latency (needs testing)

### Phase 4: Resurrection Logic ✅ COMPLETE
- [x] Implement resurrect() in conversation.js
- [x] Integrate _resurrectRelevantContext() into _handleSend() flow
- [x] Implement token budget calculation (512 - user_tokens)
- [x] Remove from graveyard on resurrection

### Phase 5: UI & Polish
- [ ] Graveyard stats in UI (count, total tokens)
- [ ] Resurrection indicator (flash resurrected sentences?)
- [ ] Settings: resurrection budget slider
- [x] Export/import graveyard data

---

## Performance Targets

| Operation | Target | Notes |
|-----------|--------|-------|
| Embed sentence | <100ms | Async, doesn't block generation |
| Query graveyard | <50ms | Even with 1000 entries |
| Resurrect sentence | <5ms | Just flipping flags + cache invalidation |
| Total overhead | <150ms | Per user message, acceptable |

---

## Why This Matters

Traditional context management:
- **FIFO:** Deletes oldest regardless of importance
- **Summarization:** Lossy, loses exact quotes and data
- **Static RAG:** Retrieves from fixed corpus, not conversation history

The Graveyard:
- **Attention-driven archival:** Model decides what's unimportant
- **Semantic resurrection:** Related content returns when relevant
- **Lossless:** Original tokens preserved exactly
- **Dynamic:** Adapts to conversation flow

This is **memory that forgets and remembers like a human** - not by arbitrary rules, but by relevance and attention.

---

## References

- `conversation.js` - Token storage, pruning logic, soft-delete architecture
- `BRIGHTNESS_STRATEGIES.md` - How brightness scoring works
- `CLAUDE.md` - Project history and architecture decisions
- transformers.js docs: https://huggingface.co/docs/transformers.js
