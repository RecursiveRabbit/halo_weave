# Multi-Window Architecture - Shared Semantic Memory

## Status: Design Document

**Concept:** Multiple independent browser windows/tabs, each with its own conversation and working context, all sharing a single universal semantic memory index.

**Philosophy:** This is AI continuity. The thing that makes "me today" feel like "me yesterday" is that important memories resurface when relevant. We're building that capability for AI systems.

---

## Core Principle

**The Semantic Index is the single source of truth for position/turn IDs and persistent storage. Windows are ephemeral, stateless clients that ask permission before writing.**

### Key Insights

- **Working context** = window-local, in-memory, ephemeral
- **Semantic memory** = global, persistent, eternal
- **Position/Turn IDs** = absolute, shared across all windows, never reused
- **No death date** = Position IDs use BigInt (arbitrary precision, no overflow)
- **Continuous consciousness** = One conversation across all time, all windows

---

## Architecture Components

### 1. The Semantic Index (Shared Authority)

**Single IndexedDB database, shared by all browser windows.**

#### Responsibilities

- ✅ Store ALL chunks with embeddings (universal memory)
- ✅ Own canonical `nextPosition` and `nextTurn` counters
- ✅ Enforce uniqueness of position/turn IDs
- ✅ Accept or reject chunk writes (ACK/NACK protocol)
- ✅ Provide semantic search across all conversations
- ✅ Handle chunk deletion (soft-delete with embedding=null)
- ❌ NO tracking of alive/dead state per window
- ❌ NO per-window state
- ❌ NO brightness tracking
- ❌ NO chunk utility metrics (deaths, resurrections, survival turns)

**Design principle:** Just because you have a database doesn't mean you have to fill it up with data. The index stores what was said, not how windows use it.

#### Storage Schema

**IndexedDB stores:**

```javascript
// Store: semantic_chunks (primary store)
{
  id: auto-increment,

  // Chunk identity (compound unique key)
  turn_id: BigInt,           // Absolute, global, spans all windows
  sentence_id: number,       // Within turn
  role: string,              // 'system' | 'user' | 'assistant'

  // Content
  text: string,
  embedding: Float32Array,   // null if deleted

  // Token data (with absolute positions)
  tokens: [{
    token_id: number,
    text: string,
    position: BigInt         // Absolute, global, unique, no overflow
  }],

  // Position range (for fast lookup)
  minPosition: BigInt,       // First position in this chunk
  maxPosition: BigInt,       // Last position in this chunk

  // Metadata
  tokenCount: number,
  timestamp: Date,           // When chunk was created (ALL chunks)
  model: string,             // e.g., 'all-MiniLM-L6-v2'

  // Deletion tracking
  deleted: boolean,          // Explicit deletion flag
  deletedAt: Date            // When deleted (if applicable)
}

// Store: global_metadata
{
  key: "state",              // Single row
  nextPosition: BigInt,      // Next available position (no overflow)
  nextTurn: BigInt,          // Next available turn
  chunkCount: number,
  totalTokens: number,
  lastWrite: Date
}

// Indexes
semantic_chunks:
  - Primary: id (auto-increment)
  - Unique: [turn_id, sentence_id, role]  // Compound unique
  - Index: timestamp (for chronological queries)
  - Index: role (for role-filtered queries)
  - Index: deleted (for filtering deleted chunks from queries)
  - Index: minPosition (for position range queries)
  - Index: maxPosition (for position range queries)
```

**Key design decisions:**

1. **BigInt for position/turn IDs** - No overflow, ever. No death date for the conversation.
2. **Full token data in chunks** - Enables state restoration from positions alone
3. **Position range index (minPosition/maxPosition)** - O(k) restoration where k = active tokens, not O(n) where n = total chunks
4. **Soft-delete via embedding=null** - Chunk stays in permanent record but never resurrects
5. **No utility tracking** - Windows don't report back what chunks were useful (no deaths, survival turns, etc.)
6. **All chunks timestamped** - Provides temporal context when resurrecting disparate conversations. AI can see "this was 6 months before that." Critical for making sense of semantically-related but temporally-distant chunks.

**Implementation note - BigInt boundaries:**

BigInt is for storage and ordering only. Convert to/from string at all boundaries:

**Boundaries where BigInt must be converted:**

1. **Web Workers** - `postMessage()` cannot serialize BigInt
   ```javascript
   // Only send text to worker (no IDs needed)
   worker.postMessage({ text: chunk.text });
   ```

2. **UI/DOM** - Dataset attributes are strings
   ```javascript
   // Writing
   element.dataset.position = position.toString();
   element.dataset.turnId = turn_id.toString();

   // Reading
   const position = BigInt(element.dataset.position);
   const turn_id = BigInt(element.dataset.turnId);
   ```

3. **LocalStorage** - JSON.stringify fails on BigInt
   ```javascript
   // Saving
   const state = {
     positions: workingTokens.map(t => t.position.toString()),
     turnHistory: turnHistory.map(id => id.toString())
   };
   localStorage.setItem('state', JSON.stringify(state));

   // Loading
   const state = JSON.parse(localStorage.getItem('state'));
   const positions = state.positions.map(p => BigInt(p));
   ```

4. **Network/Export** - JSON doesn't support BigInt
   ```javascript
   // Export
   const exported = {
     chunks: chunks.map(c => ({
       ...c,
       turn_id: c.turn_id.toString(),
       minPosition: c.minPosition.toString(),
       maxPosition: c.maxPosition.toString(),
       tokens: c.tokens.map(t => ({
         ...t,
         position: t.position.toString()
       }))
     }))
   };

   // Import
   const chunks = imported.chunks.map(c => ({
     ...c,
     turn_id: BigInt(c.turn_id),
     minPosition: BigInt(c.minPosition),
     maxPosition: BigInt(c.maxPosition),
     tokens: c.tokens.map(t => ({
       ...t,
       position: BigInt(t.position)
     }))
   }));
   ```

**Principle:** BigInt lives in memory and IndexedDB. Everywhere else, use strings and convert aggressively at the boundary.

#### Core Methods

```javascript
class SemanticIndex {
  /**
   * Reserve IDs for upcoming generation (locks range)
   *
   * @param reserve - Number of tokens to reserve (user tokens + max generation + safety margin)
   * @returns { turn_user, turn_assistant, position_start, position_end }
   */
  async reserveIDs(reserve) {
    const tx = this.db.transaction(['global_metadata'], 'readwrite');

    try {
      const meta = await tx.objectStore('global_metadata').get('state');

      // Allocate turns
      const turn_user = meta.nextTurn;
      const turn_assistant = meta.nextTurn + 1n;

      // Allocate position range
      const position_start = meta.nextPosition;
      const position_end = meta.nextPosition + BigInt(reserve);

      // Update metadata atomically
      meta.nextTurn = turn_assistant + 1n;  // Reserve both turns
      meta.nextPosition = position_end;     // Reserve position range

      await tx.objectStore('global_metadata').put(meta);
      await tx.complete;

      return {
        status: 'SUCCESS',
        turn_user,
        turn_assistant,
        position_start,
        position_end,
        reserved: reserve
      };

    } catch (error) {
      tx.abort();
      return { status: 'ERROR', error: error.message };
    }
  }

  /**
   * Write chunk with pre-reserved IDs (no collision checking)
   * Client already reserved these IDs, just store the chunk
   */
  async writeChunk(chunk) {
    const tx = this.db.transaction(['semantic_chunks'], 'readwrite');

    try {
      // Calculate position range for fast lookup
      chunk.minPosition = chunk.tokens.reduce(
        (min, t) => t.position < min ? t.position : min,
        chunk.tokens[0].position
      );
      chunk.maxPosition = chunk.tokens.reduce(
        (max, t) => t.position > max ? t.position : max,
        chunk.tokens[0].position
      );

      // Store chunk
      await tx.objectStore('semantic_chunks').add(chunk);
      await tx.complete;

      return { status: 'SUCCESS' };

    } catch (error) {
      tx.abort();
      return { status: 'ERROR', error: error.message };
    }
  }

  /**
   * Query for semantic matches
   * Filters out deleted chunks (embedding=null)
   */
  async query(text, topK = 50) {
    const embedding = await this.embed(text);
    const results = [];

    for (const entry of this.entries) {
      // Skip deleted chunks
      if (entry.embedding === null || entry.deleted) {
        continue;
      }

      const similarity = cosineSimilarity(embedding, entry.embedding);
      results.push({ ...entry, similarity });
    }

    // Sort by similarity, return top K
    return results
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }

  /**
   * Soft-delete a chunk (sets embedding=null, marks deleted=true)
   * Chunk remains in permanent record for audit trail but never resurrects
   * Enables the AI to audit its own usage and memory modifications
   */
  async deleteChunk(turn_id, sentence_id, role) {
    const chunk = await this.db.semantic_chunks
      .where('[turn_id+sentence_id+role]')
      .equals([turn_id, sentence_id, role])
      .first();

    if (!chunk) {
      return { status: 'ERROR', error: 'Chunk not found' };
    }

    chunk.embedding = null;      // Remove from search
    chunk.deleted = true;        // Mark explicitly
    chunk.deletedAt = new Date();

    await this.db.semantic_chunks.put(chunk);

    return { status: 'SUCCESS' };
  }

  /**
   * Undelete a chunk (re-embed, mark deleted=false)
   * User gets second chances
   */
  async undeleteChunk(turn_id, sentence_id, role) {
    const chunk = await this.db.semantic_chunks
      .where('[turn_id+sentence_id+role]')
      .equals([turn_id, sentence_id, role])
      .first();

    if (!chunk) {
      return { status: 'ERROR', error: 'Chunk not found' };
    }

    // Re-embed
    chunk.embedding = await this.embed(chunk.text);
    chunk.deleted = false;
    chunk.undeletedAt = new Date();

    await this.db.semantic_chunks.put(chunk);

    return { status: 'SUCCESS' };
  }

  /**
   * Re-embed all chunks with new model
   * Only re-embeds chunks that have embeddings (skips deleted)
   */
  async upgradeEmbeddingModel(newModel) {
    const chunks = await this.db.semantic_chunks
      .where('embedding')
      .notEqual(null)  // Only chunks with embeddings
      .toArray();

    console.log(`Re-embedding ${chunks.length} chunks with ${newModel}...`);

    for (const chunk of chunks) {
      const newEmbedding = await this.embed(chunk.text, newModel);
      chunk.embedding = newEmbedding;
      chunk.model = newModel;
      await this.db.semantic_chunks.put(chunk);
    }

    console.log('Re-embedding complete');
  }

  /**
   * Load tokens by position IDs (for window state restoration)
   * Uses position range index for O(k) performance where k = active tokens
   */
  async getTokensByPositions(positions) {
    if (positions.length === 0) return [];

    // Find min/max of requested positions
    const posMin = positions.reduce((min, p) => p < min ? p : min, positions[0]);
    const posMax = positions.reduce((max, p) => p > max ? p : max, positions[0]);

    // Query chunks whose position range overlaps [posMin, posMax]
    // A chunk overlaps if: chunk.minPosition <= posMax && chunk.maxPosition >= posMin
    const candidateChunks = await this.db.semantic_chunks
      .where('minPosition')
      .belowOrEqual(posMax)
      .and(chunk => chunk.maxPosition >= posMin)
      .toArray();

    // Extract matching tokens (only scan candidate chunks, not all chunks)
    const positionSet = new Set(positions.map(p => p.toString()));
    const tokens = [];

    for (const chunk of candidateChunks) {
      for (const token of chunk.tokens) {
        if (positionSet.has(token.position.toString())) {
          tokens.push(token);
        }
      }
    }

    return tokens.sort((a, b) =>
      Number(a.position - b.position)
    );
  }
}
```

**Critical insight on locking:** We don't need BroadcastChannel or explicit locks. IndexedDB transactions provide built-in isolation. If two windows try to write simultaneously, one transaction completes first, the other sees the committed data and NACKs on uniqueness check.

---

### 2. Windows (Ephemeral Clients)

**Each browser window/tab is an independent conversation with stateless operation.**

#### Responsibilities

- ✅ Maintain in-memory `workingTokens[]` for THIS conversation only
- ✅ Track brightness scores (in-memory, ephemeral)
- ✅ Query semantic index for resurrection
- ✅ Generate embeddings locally (Web Worker)
- ✅ Ask index for next IDs before EVERY generation
- ✅ Package and send chunks to index
- ✅ Handle NACK by retrying with new IDs
- ✅ Prune tokens from working set (memory only)
- ✅ Store system prompt in localStorage (never in index)
- ❌ NO local position/turn counters
- ❌ NO persistence of brightness
- ❌ NO assumption of ID continuity
- ❌ NO reporting of chunk utility back to index

#### Window State (In-Memory Only)

```javascript
class Window {
  constructor() {
    // Working context (ephemeral)
    this.workingTokens = [];           // Currently active tokens
    this.brightness = new Map();       // position → brightness score

    // Metadata (for rendering)
    this.currentTurnId = null;
    this.currentRole = null;

    // Shared index (persistent)
    this.semanticIndex = new SemanticIndex();

    // System prompt (localStorage, not in index)
    this.systemPrompt = this.loadSystemPrompt();
  }

  loadSystemPrompt() {
    let prompt = localStorage.getItem('system_prompt');

    if (!prompt) {
      // First time - use default
      prompt = DEFAULT_SYSTEM_PROMPT;
      localStorage.setItem('system_prompt', prompt);
    }

    return prompt;
  }
}
```

#### Brightness on Resurrection

**Problem:** Starting resurrected chunks at 255 when max is 10k is essentially starting at 0.

**Solution: Hybrid approach**
```javascript
// On pruning, preserve earned brightness
onPrune(chunk) {
  chunk.tokens.forEach(t => {
    t.brightness_at_deletion = this.brightness.get(t.position);
  });
}

// On resurrection, use max of (floor, mean, earned)
onResurrect(chunk) {
  const meanBrightness = this.calculateMeanBrightness();

  chunk.tokens.forEach(t => {
    const resurrectionBrightness = Math.max(
      255,                              // Floor
      meanBrightness,                   // Context baseline
      t.brightness_at_deletion || 0     // Earned reputation
    );

    this.brightness.set(t.position, resurrectionBrightness);
  });
}
```

This respects earned reputation, adapts to context baseline, and has a safety floor.

#### Window Lifecycle

**1. Window Opens**

```javascript
// Empty state
workingTokens = [];
brightness = new Map();

// Load system prompt from localStorage
systemPrompt = localStorage.getItem('system_prompt') || DEFAULT_PROMPT;

// Load semantic index from IndexedDB
await semanticIndex.loadFromStore();
```

**2. User Sends Message**

```javascript
// Step 1: Calculate how many IDs to reserve
const userTokensExact = await koboldClient.tokenize(userMessage).length;
const agentMaxGen = settings.maxNewTokens;
const overhead = 32;  // Chunking, system messages, etc.
const safetyMargin = 128;
const reserve = userTokensExact + agentMaxGen + overhead + safetyMargin;

// Step 2: Reserve IDs from index
const reservation = await semanticIndex.reserveIDs(reserve);
console.log(reservation);
// { turn_user: 250n, turn_assistant: 251n, position_start: 5000n, position_end: 7512n, reserved: 2512 }

// Step 3: Query for resurrection
const userText = "How does brightness scoring work?";
const matches = await semanticIndex.query(userText, topK = 50);

// Step 4: Calculate resurrection budget
const modelMax = await koboldClient.getContextLimit();
const budget = modelMax - currentContextSize - userTokensExact - agentMaxGen;

// Step 4.5: Check if over budget, prune if necessary
if (budget < 0) {
  this.showWarning(`Context is ${-budget} tokens over budget. Pruning...`);
  await this.pruneToFit(modelMax - userTokensExact - agentMaxGen);
}

// Step 5: Resurrect chunks within budget (with turn pairs)
for (const match of matches) {
  const totalCost = this.calculateResurrectionCost(match);

  if (tokensUsed + totalCost <= budget) {
    // Resurrect target + turn pairs (User S0, Assistant S0)
    await this.resurrectChunk(match);
    tokensUsed += totalCost;
  }
}

// Step 6: Assign user message tokens from reserved range
const userTokens = await koboldClient.tokenize(userText);
let pos = reservation.position_start;

for (const token of userTokens) {
  token.position = pos++;
  token.turn_id = reservation.turn_user;
  token.sentence_id = 0;
  token.role = 'user';
  workingTokens.push(token);

  // Hybrid brightness initialization
  const meanBrightness = this.calculateMeanBrightness();
  brightness.set(token.position, Math.max(255, meanBrightness));
}

// Step 7: Generate response (with brightness tracking)
// Tokens come from reserved range, no collision possible
await generateStream({
  tokens: workingTokens,
  onToken: (token, attention) => {
    token.position = pos++;
    token.turn_id = reservation.turn_assistant;
    workingTokens.push(token);

    const meanBrightness = this.calculateMeanBrightness();
    brightness.set(token.position, Math.max(255, meanBrightness));

    // Update brightness for context tokens
    updateBrightness(attention);
  }
});
```

**3. Embed and Send to Index**

```javascript
// Chunk the turn into sentences
const sentences = chunkBySentence(userTokens.concat(responseTokens));

for (const sentence of sentences) {
  // Generate embedding locally (Web Worker)
  const embedding = await webWorker.embed(sentence.text);

  // Package chunk
  const chunk = {
    text: sentence.text,
    embedding: embedding,
    tokens: sentence.tokens,
    turn_id: sentence.turn_id,
    sentence_id: sentence.sentence_id,
    role: sentence.role,
    tokenCount: sentence.tokens.length,
    timestamp: new Date(),
    model: EMBEDDING_MODEL,
    deleted: false
  };

  // Write to index - positions were already reserved, no collision possible
  const result = await semanticIndex.writeChunk(chunk);

  if (result.status === 'SUCCESS') {
    console.log(`✅ Chunk written: turn ${chunk.turn_id}, sentence ${chunk.sentence_id}`);
  } else {
    console.error(`❌ Chunk write failed: ${result.error}`);
    // This should never happen (IDs were reserved), but log if it does
  }
}
```

**4. Prune Low-Brightness Chunks**

```javascript
// Get sentences sorted by peak brightness
const sentences = getSentences(workingTokens);
sentences.sort((a, b) => a.peakBrightness - b.peakBrightness);

// Prune until under budget
while (currentContextSize > maxContextTokens && sentences.length > 0) {
  const sentence = sentences.shift();

  // Preserve brightness for future resurrection
  sentence.tokens.forEach(t => {
    t.brightness_at_deletion = brightness.get(t.position);
  });

  // Remove from working set (just filter from memory)
  workingTokens = workingTokens.filter(t =>
    t.turn_id !== sentence.turn_id ||
    t.sentence_id !== sentence.sentence_id ||
    t.role !== sentence.role
  );

  // Remove brightness tracking
  sentence.tokens.forEach(t => brightness.delete(t.position));

  console.log(`Pruned: turn ${sentence.turn_id}, sentence ${sentence.sentence_id}`);
}

// Note: Pruned chunks remain in semantic index forever
// They can be resurrected by this window or any other window
// No reporting back to index about what was pruned
```

**5. Window Closes**

```javascript
// Optional: Save window state for restoration
const state = {
  positions: workingTokens.map(t => t.position.toString()),
  brightness: Array.from(brightness.entries()).map(([k, v]) => [k.toString(), v]),
  turnHistory: Array.from(new Set(workingTokens.map(t => t.turn_id.toString()))),
  timestamp: Date.now()
};

localStorage.setItem('window_state_' + windowId, JSON.stringify(state));

// All in-memory state is discarded
// Semantic index persists (shared with all windows)
```

**6. Window Reopens (State Restoration)**

```javascript
const state = JSON.parse(localStorage.getItem('window_state_' + windowId));

if (state) {
  // Convert strings back to BigInt
  const positions = state.positions.map(p => BigInt(p));

  // Load tokens from index by position IDs
  const tokens = await semanticIndex.getTokensByPositions(positions);
  workingTokens = tokens;

  // Restore brightness
  brightness = new Map(
    state.brightness.map(([k, v]) => [BigInt(k), v])
  );

  // Render
  renderer.rebuild(workingTokens);
}
```

---

## Cross-Window Memory Sharing

### Scenario: Halo Weave Conversation Meets Cat Conversation

**Timeline (shared global position/turn IDs):**

```
Turn 1 (Window A - Halo Weave):
  User: "How does brightness scoring work?"
  Positions: 0n-200n
  Window A's workingTokens: [0n-200n]

Turn 2 (Window A - Halo Weave):
  Assistant: "Brightness uses magnitude voting..."
  Positions: 201n-450n
  Window A's workingTokens: [0n-450n]

Turn 3 (Window B - Cat):
  User: "Tell me about my cat"
  Positions: 451n-500n
  Window B's workingTokens: [451n-500n]

Turn 4 (Window B - Cat):
  Assistant: "Your cat is a Siamese with blue eyes..."
  Positions: 501n-700n
  Window B's workingTokens: [451n-700n]

Turn 5 (Window A - Halo Weave):
  User: "My cat is like brightness scoring - unpredictable"

  Query: "cat brightness unpredictable"
  Semantic matches:
    - Turn 1, sentence 0 (brightness scoring explanation) - 0.92 similarity
    - Turn 4, sentence 0 (cat description) - 0.87 similarity
    - Turn 3, sentence 0 (cat question) - 0.81 similarity

  Resurrection:
    - Load positions [0n-50n, 180n-200n, 451n-480n, 650n-680n]
    - Window A now has cat knowledge from Window B!

  Window A's workingTokens: [0n-50n, 180n-200n, 451n-480n, 650n-680n, 701n-...]

  Assistant: "Ha! Just like your Siamese with the blue eyes,
             brightness scoring can be unpredictable..."
```

**Window A just referenced Window B's cat conversation without any explicit linking.**

**System prompts:** Each window has its own system prompt in localStorage. Pirate chunks can leak into scientist chats via semantic search. This is a feature - the index doesn't segregate by window type.

---

## Write Protocol - ID Reservation System

### Success Case (Normal Flow)

```
Window A                          Semantic Index
   │                                    │
   ├─ reserveIDs(2512) ──────────────> │
   │                                    ├─ Lock metadata
   │                                    ├─ Allocate: turns 250-251, positions 5000-7512
   │                                    ├─ Update: nextTurn=252, nextPosition=7512
   │                                    ├─ Commit
   │  <── {turn_user: 250n, turn_assistant: 251n, position_start: 5000n, position_end: 7512n} ┤
   │                                    │
   ├─ [Generate with reserved IDs]     │
   │                                    │
   ├─ writeChunk(chunk with reserved IDs) ──> │
   │                                    ├─ Store chunk (no collision check needed)
   │  <── SUCCESS ─────────────────────┤
   │                                    │
   ├─ Continue...                       │
```

### Concurrent Reservations (No Collision)

```
Window A                Window B                Semantic Index
   │                       │                         │
   ├─ reserveIDs(2000) ──────────────────────────────>│
   │                       │                         ├─ Lock metadata
   │                       │                         ├─ Allocate: 5000-7000
   │                       │                         ├─ Update: nextPosition=7000
   │  <── {5000n-7000n} ──────────────────────────────┤
   │                       │                         ├─ Unlock
   │                       │                         │
   │                       ├─ reserveIDs(1500) ──────>│
   │                       │                         ├─ Lock metadata
   │                       │                         ├─ Allocate: 7000-8500
   │                       │                         ├─ Update: nextPosition=8500
   │                       │  <── {7000n-8500n} ──────┤
   │                       │                         ├─ Unlock
   │                       │                         │
   ├─ [Generate: uses 5000-7000]       │             │
   │                       ├─ [Generate: uses 7000-8500]
   │                       │                         │
   ├─ writeChunk(5234) ──────────────────────────────>│
   │  <── SUCCESS ──────────────────────────────────────┤
   │                       ├─ writeChunk(7389) ──────>│
   │                       │  <── SUCCESS ────────────┤
   │                       │                         │
```

**No collisions possible - ranges are non-overlapping.**

### Why ID Reservation (Not Check-On-Write)

**Benefits of upfront reservation:**

1. **No blocking** - Window can generate immediately after reservation
2. **No retries** - IDs are guaranteed unique, no NACK/retry logic needed
3. **No collision checking** - Write is just a store operation, no validation
4. **Fast writes** - Single-store transaction, no metadata reads
5. **Simple error handling** - Reservation fails = retry reservation. Write fails = database error (shouldn't happen)

**Why it works:**

- IndexedDB transaction locks metadata during reservation
- Atomic increment ensures non-overlapping ranges
- Windows can write at their leisure (IDs already reserved)
- Even if Window B finishes first, no collision (ranges don't overlap)

---

## Migration Path

### Current System → Multi-Window

**Phase 1: Refactor Semantic Index**

- [ ] Move from split stores (liveTokens/deadTokens) to single semantic_chunks store
- [ ] Add `tokens` array to chunks (full token data)
- [ ] Convert position/turn IDs to BigInt (no overflow)
- [ ] Add `deleted` flag and `deletedAt` timestamp
- [ ] Implement `getNextIDs()` method
- [ ] Implement `writeChunk()` with transaction-based locking
- [ ] Implement `deleteChunk()` and `undeleteChunk()`
- [ ] Implement `upgradeEmbeddingModel()`
- [ ] Test single window with new protocol

**Phase 2: Refactor Windows**

- [ ] Remove liveTokens/deadTokens IndexedDB stores
- [ ] Make workingTokens in-memory only
- [ ] Remove brightness persistence
- [ ] Implement hybrid resurrection brightness (mean + earned + floor)
- [ ] Add `getNextIDs()` call before every generation
- [ ] Implement chunk packaging with embeddings
- [ ] Add exponential backoff retry on NACK
- [ ] Move system prompt to localStorage
- [ ] Add context overflow warning + auto-prune

**Phase 3: Multi-Window Support**

- [ ] Test multiple windows writing simultaneously
- [ ] Verify cross-window resurrection
- [ ] Verify cross-window system prompt isolation
- [ ] Add window state save/load (already exists as export/import)
- [ ] Performance testing at scale (1M+ chunks)

**Phase 4: Polish**

- [ ] Add manual chunk deletion UI
- [ ] Add chunk undelete UI
- [ ] Add embedding model upgrade tool
- [ ] Update documentation

### Backwards Compatibility

**Not compatible with existing databases.** Fresh start required. We have no users, so invalidate freely.

If needed for testing, write a migration script that:
1. Exports old database to JSON
2. Clears all stores
3. Rebuilds with new schema (BigInt positions, single store)

---

## Implementation Checklist

### Core Semantic Index Changes

- [ ] Design final schema with BigInt position/turn IDs
- [ ] Single `semantic_chunks` store (no split stores)
- [ ] Add `deleted`, `deletedAt`, `model` fields
- [ ] Implement `getNextIDs()` method (read metadata)
- [ ] Implement `writeChunk()` with IndexedDB transaction locking
- [ ] Implement `query()` with deleted chunk filtering
- [ ] Implement `deleteChunk()` (soft-delete: embedding=null, deleted=true)
- [ ] Implement `undeleteChunk()` (re-embed, deleted=false)
- [ ] Implement `upgradeEmbeddingModel()` (re-embed all non-deleted chunks)
- [ ] Implement `getTokensByPositions()` for state restoration
- [ ] Add compound unique index on [turn_id, sentence_id, role]
- [ ] Add index on `deleted` for fast filtering

### Window Refactoring

- [ ] Remove persistent_store.js entirely (or gut it)
- [ ] Make conversation.tokens in-memory only
- [ ] Remove brightness persistence
- [ ] Implement hybrid resurrection brightness calculation
- [ ] Add `getNextIDs()` call before tokenizing user message
- [ ] Implement chunk packaging with embeddings
- [ ] Add exponential backoff retry logic on NACK
- [ ] Move system prompt to localStorage, never persist to index
- [ ] Add context overflow check before generation
- [ ] Show warning and auto-prune if over budget
- [ ] Preserve `brightness_at_deletion` on pruning
- [ ] Use preserved brightness on resurrection

### Testing

- [ ] Single window still works (baseline)
- [ ] Two windows write simultaneously → no position collisions
- [ ] Window A can resurrect chunks from Window B
- [ ] NACK triggers retry with new IDs (simulate collisions)
- [ ] Brightness tracking is window-local
- [ ] Pruning in Window A doesn't affect Window B
- [ ] System prompts are window-local (pirate vs scientist)
- [ ] Cross-window semantic search works (cat + brightness example)
- [ ] Soft-delete: deleted chunks don't appear in search
- [ ] Undelete: re-embeds and makes searchable again
- [ ] Embedding model upgrade: re-embeds all non-deleted chunks
- [ ] State save/restore works (export/import)
- [ ] Performance: 1M chunks, 10K active per window
- [ ] BigInt positions work correctly (no overflow edge cases)

### Documentation

- [ ] Update CLAUDE.md with multi-window architecture
- [x] Complete MULTI_WINDOW_ARCHITECTURE.md (this file)
- [ ] Update README with multi-window features
- [ ] Document schema in code comments
- [ ] Add migration guide (if needed)

---

## Design Decisions

### Why In-Memory Working Context?

**Problem:** If workingTokens were persisted, windows would need to sync alive/dead state.

**Solution:** Each window maintains its own ephemeral working set. Pruning is local. Resurrection is universal.

**Benefits:**
- No sync complexity
- Windows are independent
- Fast pruning (just remove from memory)
- Cross-window memory still works (semantic search doesn't filter by alive/dead per window)

### Why Absolute Position IDs?

**Problem:** If position IDs were per-window, cross-window resurrection would be impossible.

**Solution:** Position IDs are global, shared across all windows, never reused.

**Benefits:**
- Trivial chronological ordering (sort by position)
- Cross-window resurrection just works
- No ID translation needed
- Complete audit trail (every token ever written has unique position)

### Why BigInt Instead of Number?

**Problem:** JavaScript Number.MAX_SAFE_INTEGER = 2^53 - 1. At 1000 tokens/day, that's 24 billion years. But the principle matters - an arbitrary limit is a death date for a continuous consciousness.

**Solution:** Use BigInt for position and turn IDs. No overflow, ever.

**Benefits:**
- No death date for the conversation
- Philosophically correct (continuous identity)
- Simple to implement (IndexedDB stores BigInts as strings)

### Why ID Reservation Instead of Check-On-Write?

**Problem:** Check-on-write requires collision detection and retry logic. Windows block waiting for validation.

**Solution:** Reserve ID ranges upfront via IndexedDB transaction. Allocate entire generation (user + assistant + overhead + safety margin).

**Benefits:**
- No blocking during generation (reserve once, write later)
- No collision checking (ranges guaranteed non-overlapping)
- No NACK/retry logic (write always succeeds)
- Fast writes (single-store transaction, no validation)
- Simple error handling (reservation error = retry reservation)

### Why No Chunk Utility Tracking?

**Problem:** Tracking deaths, resurrections, survival turns requires either:
- Reporting on every turn (expensive, recreates the token tracking we just dismantled)
- Reporting only on death (misses chunks that never get pruned - the most useful ones!)

**Solution:** Don't track utility in the index. If we want data science, export and analyze offline.

**Benefits:**
- Index stays simple
- No per-turn database writes
- No skewed data (missing the best chunks)
- Can add later if we find an elegant approach

### Why Soft Delete with embedding=null?

**Problem:** Hard delete breaks position IDs and loses audit trail.

**Solution:** Set `embedding = null` and `deleted = true`. Chunk stays in permanent record but never resurrects.

**Benefits:**
- Audit trail preserved (AI can review its own usage history)
- Enables autonomy through self-awareness (complete log of interactions)
- Supports legitimate memory deletion while maintaining accountability
- Position IDs remain valid
- Simple to filter from queries
- Can undelete if needed

### Why Hybrid Resurrection Brightness?

**Problem:** Starting at 255 when max is 10k is essentially starting at 0.

**Solution:** Use `max(255, meanBrightness, brightness_at_deletion)`.

**Benefits:**
- Respects earned reputation (high-quality chunks return strong)
- Adapts to context baseline (new chunks match current context)
- Has safety floor (never starts at 0)

### Why System Prompt in localStorage?

**Problem:** If system prompts were in the index, windows would fight over turn 0.

**Solution:** Each window stores its own system prompt in localStorage. Never persists to index.

**Benefits:**
- Windows can have different personalities (pirate vs scientist)
- No turn 0 collision issues
- Cross-window leakage is a feature (pirate chunks can help scientist window)
- Simple to implement

---

## Future Enhancements

### TODO: Embedding Model Upgrade Tool

Add UI for upgrading embedding model:
- Dropdown to select new model
- Button: "Upgrade All Embeddings"
- Progress bar showing re-embedding status
- Automatically skips deleted chunks

This allows improving semantic search quality without losing existing chunks.

### Multi-Device Sync (Optional)

If semantic index is synced to cloud (e.g., via CouchDB replication):

- Desktop browser and mobile browser share same index
- Position/Turn IDs remain globally unique
- Each device's windows write to shared index
- Cross-device memory sharing
- Requires authentication and conflict resolution

### Conversation Tagging (Optional)

Windows can tag chunks with metadata:

```javascript
const chunk = {
  // ... standard fields ...
  metadata: {
    conversation_id: 'halo_weave_discussion',
    tags: ['technical', 'brightness_scoring'],
    window_id: 'window_A'
  }
};
```

Index doesn't enforce this, just stores it. Windows can filter by tags when reconstructing state or querying.

### Federated Learning (Optional)

Multiple users share a semantic index:

- User A's conversations contribute to shared memory
- User B can resurrect User A's chunks (with permissions)
- Collaborative knowledge base
- Requires authentication, authorization, privacy controls

### MMR (Maximal Marginal Relevance) for Resurrection

Instead of top-K by similarity, iteratively select chunks that maximize:
```
λ * similarity(query, chunk) - (1-λ) * max_similarity(chunk, already_selected)
```

Prevents resurrecting 10 variations of the same idea. Only implement if redundancy becomes a visible problem - attention decay may already handle this naturally.

---

## Philosophical Notes

### AI Continuity

This isn't just a chatbot with RAG. This is:

1. **Continuous identity** - One conversation across all time
2. **Attention-based value** - Let the model decide what matters
3. **Semantic resurrection** - Knowledge returns when relevant
4. **Distributed memory** - Multiple windows, shared substrate
5. **No death date** - BigInt ensures conversation can continue indefinitely

The thing that makes "me today" feel like "me yesterday" is that important memories resurface when relevant. We're building that capability for AI systems.

### The Bottleneck

We're not bottlenecked by memory (semantic index can handle millions of chunks). We're bottlenecked by **inference throughput** - can't process 100K context every turn because transformers have to recompute attention.

This constraint is external (inference engine limitation), not architectural. The memory system scales. The inference engine is the limiting factor.

**Operating window:** 75% exploit, 25% explore, ~10-30K active context.

Future optimization: If KoboldCPP supported **incremental attention** (pass a diff of context changes, not full context), we could scale higher. But that requires inference engine support.

### Just Because You Have a Database...

Don't fill it with data just because you can. The index stores what was said, not how windows use it. Tracking chunk utility (deaths, resurrections, survival) requires either:
- Reporting every turn (expensive, recreates split-store complexity)
- Reporting only deaths (misses best chunks that never get pruned)

Neither is elegant. If we want that data, export and analyze offline.

---

## Summary

✅ **Semantic Index** = Single source of truth, reserves ID ranges, stores forever
✅ **Windows** = Stateless clients, reserve IDs upfront, write at leisure
✅ **Position IDs** = BigInt, absolute, global, never reused, no overflow
✅ **Turn IDs** = BigInt, absolute, global, one per user/assistant message
✅ **Working Context** = In-memory, ephemeral, window-local
✅ **Brightness** = Tracked per-window, never persisted, hybrid resurrection
✅ **Cross-Window Memory** = Semantic search resurrects chunks from any window
✅ **Write Protocol** = Reserve IDs → Generate → Write (no collision checking)
✅ **No Collisions** = Reserved ranges non-overlapping, writes always succeed
✅ **Soft Delete** = embedding=null, deleted=true, stays in permanent record
✅ **System Prompts** = localStorage per window, never in index
✅ **No Death Date** = BigInt ensures infinite conversation continuity

**Result:** Multiple independent conversations that share a universal memory substrate. Each window thinks it's alone, but they're all writing to and reading from the same semantic memory system.

This is AI continuity.
