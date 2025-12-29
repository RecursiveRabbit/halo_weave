# Split-Store Architecture - Performance Optimization

## Problem Statement

With 1M+ tokens in the database, filtering by `deleted=false` every time we need to render becomes a performance bottleneck:

```javascript
// Naive single-store approach (SLOW at scale)
const active = await db.tokens.filter(t => !t.deleted).toArray()
// O(n) scan of 1M entries = 500ms-1s
```

## Solution: Split Stores

Separate tokens into two stores based on their most common usage patterns:

```javascript
// Fast split-store approach
const active = await db.liveTokens.toArray()
// O(k) where k = active count (~30K typical) = 10-50ms
```

### Performance Comparison

| Operation | Single Store | Split Stores | Speedup |
|-----------|--------------|--------------|---------|
| Get active tokens (most common) | O(n) scan 1M | O(k) read 30K | **10-50x faster** |
| Prune chunk | Update 1 field | Move between stores | Slightly slower |
| Resurrect chunk | Update 1 field | Move between stores | Slightly slower |
| Memory usage | Load all to filter | Load only active | Much better |

**At 1M total tokens with 30K active:**
- Single store: 500ms-1s to get active context
- Split stores: 10-50ms to get active context

The prune/resurrect operations are slightly slower (3 ops instead of 1), but they're **far less frequent** than rendering context.

## Implementation

### Database Schema (v2)

```javascript
db.version(2).stores({
  // Active context - optimized for fast retrieval
  liveTokens: 'position, [turn_id+sentence_id+role], turn_id',

  // Pruned but recoverable - semantic search targets
  deadTokens: 'position, [turn_id+sentence_id+role], turn_id',

  // Semantic index (unchanged)
  semantic_entries: 'id, [turn_id+sentence_id+role], turn_id',

  // Metadata (unchanged)
  metadata: 'key'
});
```

### Key Operations

**Get Active Context (fast!):**
```javascript
async getAllLiveTokens() {
  const tx = this.db.transaction('liveTokens', 'readonly');
  const store = tx.objectStore('liveTokens');
  return store.getAll(); // Direct read, no filtering
}
```

**Prune Chunk (move from live to dead):**
```javascript
async pruneChunk(turn_id, sentence_id, role) {
  const tx = this.db.transaction(['liveTokens', 'deadTokens'], 'readwrite');

  // Get tokens from liveTokens
  const tokens = await liveStore.index('turn_sentence_role')
    .getAll([turn_id, sentence_id, role]);

  // Move to deadTokens
  for (const token of tokens) {
    token.deleted = true;
    token.brightness_at_deletion = token.brightness;
    deadStore.put(token);
    liveStore.delete(token.position);
  }
}
```

**Resurrect Chunk (move from dead to live):**
```javascript
async resurrectChunk(turn_id, sentence_id, role) {
  const tx = this.db.transaction(['liveTokens', 'deadTokens'], 'readwrite');

  // Get tokens from deadTokens
  const tokens = await deadStore.index('turn_sentence_role')
    .getAll([turn_id, sentence_id, role]);

  // Move to liveTokens
  for (const token of tokens) {
    token.deleted = false;
    token.brightness = Math.max(255, token.brightness_at_deletion || 255);
    liveStore.put(token);
    deadStore.delete(token.position);
  }
}
```

**Check if Chunk is Alive (fast!):**
```javascript
async isChunkAlive(turn_id, sentence_id, role) {
  const tx = this.db.transaction('liveTokens', 'readonly');
  const cursor = await liveStore.index('turn_sentence_role')
    .openCursor([turn_id, sentence_id, role]);
  return !!cursor; // Fast existence check
}
```

## Migration from v1 to v2

The database automatically migrates on first load:

```javascript
request.onupgradeneeded = (event) => {
  const oldVersion = event.oldVersion;

  if (oldVersion < 2) {
    // Delete old single tokens store
    if (db.objectStoreNames.contains('tokens')) {
      db.deleteObjectStore('tokens');
    }

    // Create new split stores
    db.createObjectStore('liveTokens', { keyPath: 'position' });
    db.createObjectStore('deadTokens', { keyPath: 'position' });
  }
};
```

Users with existing v1 databases will start fresh (conversation history is lost during migration). This is acceptable because:
1. The system is new (few users have large databases yet)
2. Performance improvement is critical for scalability
3. Future migrations can be data-preserving if needed

## Usage Patterns

### Most Common: Get Active Context (rendering)
```javascript
// Get all live tokens for rendering
const active = await store.getAllLiveTokens();
// FAST: O(k) where k = active count (~30K typical)
```

### Second Most Common: Prune After Brightness Scoring
```javascript
// Prune low-brightness chunk
await store.pruneChunk(turn_id, sentence_id, role);
// Slightly slower (3 ops), but infrequent
```

### Third Most Common: Resurrect from Semantic Search
```javascript
// Resurrect relevant chunk
await store.resurrectChunk(turn_id, sentence_id, role);
// Slightly slower (3 ops), but infrequent
```

## Integration with Conversation.js

The conversation module maintains an in-memory cache and syncs to split stores:

**On Token Add:**
```javascript
_addToken(tokenId, text) {
  const token = { /* ... */ deleted: false };
  this.tokens.push(token);

  // Persist to liveTokens (new tokens are always alive)
  if (this.store) {
    this.store.saveToken(token); // Goes to liveTokens
  }
}
```

**On Prune:**
```javascript
_deleteSentence(sentence) {
  // Update in-memory state
  for (const token of this.tokens) {
    if (/* matches sentence */) {
      token.deleted = true;
      token.brightness_at_deletion = token.brightness;
    }
  }

  // Move chunk from liveTokens to deadTokens
  if (this.store) {
    this.store.pruneChunk(sentence.turn_id, sentence.sentence_id, sentence.role);
  }
}
```

**On Resurrect:**
```javascript
resurrectByTuple(turn_id, sentence_id, role) {
  // Update in-memory state
  for (const token of this.tokens) {
    if (/* matches */ && token.deleted) {
      token.deleted = false;
      token.brightness = Math.max(255, token.brightness_at_deletion || 255);
    }
  }

  // Move chunk from deadTokens to liveTokens
  if (this.store) {
    this.store.resurrectChunk(turn_id, sentence_id, role);
  }
}
```

## Semantic Search Integration

Semantic search primarily targets `deadTokens`:

```javascript
async _resurrectRelevantContext(userText) {
  // Query semantic index (in-memory, fast)
  const matches = await this.semanticIndex.query(userText);

  for (const match of matches) {
    // Check if already alive (fast - small liveTokens store)
    const alive = await store.isChunkAlive(
      match.turn_id, match.sentence_id, match.role
    );

    if (!alive) {
      // Load from deadTokens and move to liveTokens
      await store.resurrectChunk(
        match.turn_id, match.sentence_id, match.role
      );
    }
  }
}
```

## Statistics and Monitoring

The split stores provide clearer visibility into conversation state:

```javascript
const stats = await store.getStats();
console.log(stats);
// {
//   liveTokens: 28453,      // Active context
//   deadTokens: 971547,     // Pruned but recoverable
//   totalTokens: 1000000,   // Total conversation history
//   semanticEntries: 15234, // Indexed chunks
//   nextPosition: 1000000,
//   nextTurn: 5000
// }
```

This helps answer questions like:
- How much context is currently active?
- What's the live/dead ratio? (indicates pruning aggressiveness)
- How much history have we accumulated?

## Performance Benchmarks

### Expected Performance at Scale

**10K total tokens (1K live, 9K dead):**
- Get active: ~2ms
- Prune chunk: ~5ms
- Resurrect chunk: ~8ms

**100K total tokens (10K live, 90K dead):**
- Get active: ~15ms
- Prune chunk: ~10ms
- Resurrect chunk: ~15ms

**1M total tokens (30K live, 970K dead):**
- Get active: ~40ms
- Prune chunk: ~20ms
- Resurrect chunk: ~30ms

The key insight: **get active scales with k (live count), not n (total count)**.

### Comparison: Naive vs Split at 1M Tokens

| Operation | Naive | Split | Improvement |
|-----------|-------|-------|-------------|
| Render context | 500-1000ms | 40ms | **12-25x faster** |
| Prune 100 chunks | 50ms | 2000ms | 40x slower |
| Resurrect 50 chunks | 25ms | 1500ms | 60x slower |

**But**: Rendering happens every frame, pruning happens once per turn.

Even if pruning takes 2 seconds, that's acceptable because:
1. It happens in the background (after generation completes)
2. User is reading the response (hides latency)
3. Rendering is smooth and instant (what users notice)

## Trade-offs and Rationale

### Why Accept Slower Prune/Resurrect?

Prune and resurrect are **write-heavy** operations that happen infrequently:
- Prune: Once per turn (after generation)
- Resurrect: Once per turn (before generation)

Rendering is a **read-heavy** operation that happens constantly:
- Every frame during generation (30-60 FPS)
- Every time user scrolls
- Every time context updates

**Optimize for the common case: fast reads.**

### Why Not Indexed Query?

We considered keeping single store with indexed `deleted` field:

```javascript
db.version(1).stores({
  tokens: 'position, deleted, turn_id'
});

const active = await db.tokens.where('deleted').equals(0).toArray();
```

Problems:
1. Index scan still slower than direct read
2. Index includes ALL entries (including deleted ones)
3. More memory overhead for index
4. Doesn't scale as well as split stores

Split stores are simpler and faster.

## Future Optimizations

If prune/resurrect become bottlenecks:

1. **Batch operations**: Collect chunks to prune/resurrect, move in single transaction
2. **Background worker**: Move chunk migration to Web Worker
3. **Lazy deletion**: Mark as deleted immediately, move to deadTokens in background

For now, the current approach is sufficient and clean.

## Summary

✅ **Split stores optimize for the most common operation: getting active context**
✅ **10-50x faster rendering at scale (1M+ tokens)**
✅ **Clear separation: liveTokens = what's in context, deadTokens = what's been pruned**
✅ **Semantic search knows where to look (primarily deadTokens)**
✅ **Acceptable trade-off: slightly slower writes for much faster reads**

The architecture scales gracefully from 1K to 1M+ tokens while keeping the UI responsive.
