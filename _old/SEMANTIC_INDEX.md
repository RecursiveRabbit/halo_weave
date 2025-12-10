# Semantic Index

**Date:** 2025-12-07  
**Status:** Design Document  
**Replaces:** GRAVEYARD.md

---

## Overview

As the conversation is generated, chunks are encoded into the **Semantic Index** - an append-only vector database of the entire conversation. Both living and deleted content is indexed and searchable.

### Why Index Everything?

At steady state (context at limit), we embed one chunk for every chunk generated. The work is unavoidable. By embedding immediately:

- **Better embeddings:** Full surrounding context available at embed time
- **Always searchable:** Find content whether it's alive or dead
- **Simpler logic:** No tracking of "in index" vs "not in index"

### Embedding Timing

Embeddings happen **after each complete exchange**, not during streaming:

```
User sends message
  → Tokenize, add to conversation
Model generates response  
  → Stream tokens, add to conversation
Generation complete
  → Embed all new chunks from this exchange
```

This hides embedding latency - it happens while the user reads the response or types their next message.

---

## Chunk Definition: Short Line Merging

A "chunk" is not a line. It's a **semantic unit**.

### The Problem with Raw Lines

```
Line 1: "Groceries:"           (2 tokens)
Line 2: "- Milk"               (3 tokens)  
Line 3: "- Eggs"               (3 tokens)
Line 4: "- Bread"              (3 tokens)
```

If we treat each line as a chunk:
- "Groceries:" gets pruned, but "- Milk" survives (meaningless)
- Searching for "groceries" finds only the header, not the items
- Embeddings are too short to capture meaning

### The Solution: Merge Short Lines

Lines under 10 tokens attach to the following line. This continues until a line ≥10 tokens is reached.

```
"Groceries:"        (2 tokens)  → merge forward
"- Milk"            (3 tokens)  → merge forward
"- Eggs"            (3 tokens)  → merge forward
"- Bread"           (3 tokens)  → merge forward
"Get these today."  (4 tokens)  → merge forward
"Mom needs them for Tuesday's dinner." (8 tokens) → merge forward
"I'll pick them up after work since the store is on my way home." (14 tokens) → STOP
```

**Result:** Everything from "Groceries:" through the 14-token line becomes ONE chunk. The grocery list, the deadline, the context about mom, and the plan all travel together.

### Implementation

In `conversation.js`, `sentence_id` only increments when:
1. A newline is encountered, AND
2. The line that just ended has ≥10 tokens

The *chunk* can grow indefinitely as short lines accumulate. It's the *line* length that triggers the boundary check.

Tokens track which chunk they belong to via `sentence_id`. Pruning and resurrection operate on chunks.

---

## Context-Window Embeddings

### The Insight

Embedding "Groceries: - Milk - Eggs" in isolation produces a weak vector. Embedding it with surrounding context produces a rich vector that captures relationships.

### The Strategy

When embedding chunk N, we pack as much context as fits:

```
[Chunk N-1] [Chunk N] [Chunk N+1] [Chunk N+2] ...
```

Until total tokens > 256.

**Algorithm:**
1. Start with target chunk N (always included)
2. Add chunk N-1 if room
3. Add chunk N+1 if room
4. Add chunk N+2 if room
5. Continue expanding forward until budget exhausted

**Example:**

```
Chunk 3: "She's been stressed about the dinner."      (8 tokens)
Chunk 4: "Mom called and asked me to pick things up." (10 tokens)
Chunk 5: "Groceries: - Milk - Eggs - Bread - Butter"  (12 tokens) ← TARGET
Chunk 6: "She needs them by Tuesday."                 (6 tokens)
Chunk 7: "The whole family is coming."                (6 tokens)
```

Embedding chunk 5 includes chunks 3-7 (42 tokens total, well under 256). The vector encodes:
- Mom is stressed about a dinner
- She asked for groceries
- The specific items
- Tuesday deadline
- Family context

Searches for "mom", "stressed", "groceries", "Tuesday", or "family" all find chunk 5.

### What Gets Stored

```javascript
{
  // Identity (for resurrection lookup)
  turn_id: 2,
  sentence_id: 5,
  role: 'assistant',
  
  // The chunk text (for display/debug)
  text: "Groceries: - Milk - Eggs - Bread - Butter",
  
  // For budget math (avoid counting every time)
  tokenCount: 47,
  
  // The embedding (computed from context window)
  embedding: Float32Array[384],
  
  // For index pruning if size becomes an issue
  referenceCount: 0
}
```

No token positions stored - `(turn_id, sentence_id, role)` is sufficient to identify all tokens in a chunk. Resurrection scans conversation tokens matching that tuple.

---

## Query and Resurrection Flow

### On User Message

```javascript
async function onUserMessage(text) {
  // 1. Query semantic index (returns matches sorted by similarity, descending)
  const matches = await semanticIndex.query(text, { maxResults: 20 });
  
  // 2. Select top matches until budget exhausted
  let totalTokens = 0;
  const budget = 1024;
  
  for (const match of matches) {
    if (totalTokens + match.tokenCount > budget) {
      break;  // Budget exhausted
    }
    
    // Resurrect (no-op if already alive)
    conversation.resurrect(match.turn_id, match.sentence_id, match.role);
    match.referenceCount++;
    totalTokens += match.tokenCount;
  }
  
  // 3. Continue with normal message handling
  addUserMessage(text);
  generate();
}
```

### Resurrection Mechanics

```javascript
resurrect(turn_id, sentence_id, role) {
  for (const token of this.tokens) {
    if (token.turn_id === turn_id && 
        token.sentence_id === sentence_id && 
        token.role === role) {
      if (!token.deleted) return;  // Already alive, nothing to do
      token.deleted = false;
      token.brightness = 255;  // Fresh start
    }
  }
}
```

Resurrected tokens:
- Reappear at their original position (context depth preserved)
- Start at brightness 255 (must prove themselves again)
- Compete fairly with other content

---

## Lifecycle of a Chunk

```
Created
  ↓
Indexed (embedding computed with context)
  ↓
Active in context (brightness tracked)
  ↓
Brightness drops below threshold
  ↓
Pruned (deleted=true, removed from active context)
  ↓
[Still in index, searchable]
  ↓
User query matches → Resurrected (deleted=false, brightness=255)
  ↓
Back in active context, must prove itself again
  ↓
Either stays bright (survives) or fades again (re-pruned)
```

**True death** only occurs if:
1. The chunk is pruned
2. It's never semantically relevant to any future query
3. The index itself is cleared (conversation reset)

---

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `minLineTokens` | 10 | Lines below this merge forward |
| `embeddingContextTokens` | 256 | Max tokens for N-1, N, N+1 window |
| `queryMaxResults` | 20 | Max chunks returned per query |
| `resurrectionBudget` | 1024 | Max tokens to resurrect per user message |
| `embeddingModel` | all-MiniLM-L6-v2 | 384-dim, ~23MB, runs in browser |

---

## Implementation Files

| File | Responsibility |
|------|----------------|
| `conversation.js` | Token storage, chunk assignment, brightness tracking, pruning |
| `semantic_index.js` | Vector storage, embedding, similarity search |
| `app.js` | Orchestration: when to embed, when to query, when to resurrect |

---

## Migration from Graveyard

The semantic index replaces `graveyard.js`. Key differences:

| Aspect | Graveyard | Semantic Index |
|--------|-----------|----------------|
| When indexed | On prune | On creation |
| What's indexed | Dead chunks only | All chunks |
| Embedding context | Chunk in isolation | N-1, N, N+1 window |
| Removal | On resurrection | Never (append-only) |
| Alive/dead tracking | In graveyard | In conversation only |

---

## Future Considerations

### Chunk Boundary Refinement

The 10-token threshold is a starting point. May need tuning based on:
- Code (many short lines that are semantically complete)
- Prose (longer natural units)
- Structured data (tables, lists)

### Embedding Model Selection

all-MiniLM-L6-v2 is fast and small. Alternatives:
- **Larger models:** Better quality, slower, more memory
- **Domain-specific:** Code embeddings, multilingual, etc.

### Index Pruning

If the index grows too large, use `referenceCount` to evict:
- Sort by `referenceCount` ascending
- Prune chunks that have never been relevant to any query
- Keep frequently-matched chunks

### Export/Import

**Don't export embeddings by default.** They bloat the file and can be regenerated from text. Export only:
- `turn_id`, `sentence_id`, `role`
- `text`, `tokenCount`
- `referenceCount`

Regenerate embeddings on import (slower but portable).

---

**Last Updated:** 2025-12-07
