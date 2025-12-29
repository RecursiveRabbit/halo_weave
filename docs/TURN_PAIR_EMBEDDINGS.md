# Turn-Pair Embedding & Resurrection Strategy

## Philosophy

**We resurrect with conversational context, so we embed with conversational context.**

The old strategy embedded chunks with their sequential neighbors (N-1, N, N+1 up to 256 tokens). This captured local context but missed the conversational structure.

The new strategy embeds chunks with their **conversational partners** - the question that prompted a response, the opening of the response, and the target chunk. This encodes the Q→A relationship directly into the embedding.

**Crucially: Resurrection now matches embedding.** When we retrieve Assistant turn 30, sentence 5, we also resurrect User turn 29, sentence 0 AND Assistant turn 30, sentence 0 - the same chunks we embedded with.

## Why This Works

Conversations have structure:
```
Turn 5 (user):    "How does brightness scoring work?"
Turn 6 (assistant): "Brightness scoring uses magnitude voting..."
                    "The algorithm excludes BOS tokens..."
                    "Scores are capped at 10000..."
```

When we resurrect turn 6's third chunk ("Scores are capped..."), we also bring:
- Turn 5, sentence_0 (the original question)
- Turn 6, sentence_0 (opening of the answer)

**We should embed the same way.**

## The Strategy

### Assistant Chunks

**Embedding:**
```
Context = [User S0 from turn N-1] + [Assistant S0 from turn N] + [Target chunk]
```

**Resurrection:**
```
Resurrect = [User S0 from turn N-1] + [Assistant S0 from turn N] + [Target chunk]
```

**Example: Turn 6, sentence_2 (assistant)**

Embedding context:
1. "How does brightness scoring work?" (turn 5, user sentence_0)
2. "Brightness scoring uses magnitude voting..." (turn 6, assistant sentence_0)
3. "Scores are capped at 10000 to prevent runaway..." (turn 6, assistant sentence_2 - TARGET)

Resurrected chunks:
1. User turn 5, S0 (the question)
2. Assistant turn 6, S0 (opening of answer)
3. Assistant turn 6, S2 (target chunk)

This captures:
- The question that prompted this response
- The opening of the response (context setter)
- The target chunk itself

**Budget calculation:** target tokens + user S0 tokens + assistant S0 tokens (if all are different chunks)

### User Chunks

**Embedding:**
```
Context = [User S0 from turn N] + [Target chunk] + [Assistant S0 from turn N+1]
```

**Resurrection:**
```
Resurrect = [User S0 from turn N] + [Target chunk] + [Assistant S0 from turn N+1]
```

**Example: Turn 5, sentence_1 (user)**

Embedding context:
1. "How does brightness scoring work?" (turn 5, user sentence_0)
2. "And what's the decay rate?" (turn 5, user sentence_1 - TARGET)
3. "Brightness scoring uses magnitude voting..." (turn 6, assistant sentence_0)

Resurrected chunks:
1. User turn 5, S0 (opening of question)
2. User turn 5, S1 (target chunk)
3. Assistant turn 6, S0 (opening of response)

This captures:
- The opening of the question (topic)
- The target chunk itself
- The beginning of the response (validates topic/relevance)

**Budget calculation:** target tokens + user S0 tokens + assistant S0 tokens (if all are different chunks)

### System Chunks

```
Embedding context = [Target chunk only]
```

System prompts embed in isolation - no turn pair.

### Special Case: Sentence_0

If the target chunk IS sentence_0, we don't add it twice:

**Assistant sentence_0:**
```
Embedding context = [User S0 from turn N-1] + [Target chunk (which IS assistant S0)]
Resurrection = [User S0 from turn N-1] + [Target chunk]
Budget = target tokens + user S0 tokens (only 2 chunks, not 3)
```

**User sentence_0:**
```
Embedding context = [Target chunk (which IS user S0)] + [Assistant S0 from turn N+1]
Resurrection = [Target chunk] + [Assistant S0 from turn N+1]
Budget = target tokens + assistant S0 tokens (only 2 chunks, not 3)
```

**Key insight:** When target is sentence_0, we resurrect 2 chunks instead of 3. The budget calculation accounts for this automatically by checking if same-turn S0 exists and is different from the target.

## Comparison with Old Strategy

### Old Strategy (Sequential)

**Embedding turn 6, sentence_2:**
```
Context = [Turn 6, sentence_1] + [Turn 6, sentence_2 (target)] + [Turn 6, sentence_3]
```

Captures sequential flow within the response, but:
- ❌ No knowledge of what question prompted this
- ❌ No topic context from opening sentence
- ✅ Good for understanding detailed explanations

### New Strategy (Turn-Pair)

**Embedding turn 6, sentence_2:**
```
Context = [Turn 5, user S0] + [Turn 6, assistant S0] + [Turn 6, sentence_2 (target)]
```

Captures conversational structure:
- ✅ Knows what question prompted this chunk
- ✅ Has topic context from opening sentences
- ✅ Aligns with how we resurrect (turn pairs)
- ⚠️ May miss sequential details within response

## Why Opening Sentences Matter

Opening sentences (`sentence_0`) are special:
1. **They set the topic** - "How does X work?" or "X works by..."
2. **They're always resurrected** - When we bring back turn N, we bring sentence_0 from turn N±1
3. **They provide context** - Later chunks in a turn build on sentence_0

By embedding with opening sentences, we ensure:
- Search query matches the topic (user sentence_0)
- Retrieved chunks have conversational context (paired sentences)
- Resurrected chunks align with their embeddings (same context window)

## Examples

### Example 1: Technical Question

**User turn 10:**
```
S0: "How does the KV cache work?"
S1: "Specifically, how is it updated during generation?"
```

**Assistant turn 11:**
```
S0: "The KV cache stores key/value pairs from past tokens..."
S1: "During generation, new KV pairs are appended..."
S2: "This avoids recomputing attention for the full sequence..."
```

**Embedding assistant S2:**
```
Context:
- "How does the KV cache work?" (user S0, turn 10)
- "The KV cache stores key/value pairs from past tokens..." (assistant S0, turn 11)
- "This avoids recomputing attention for the full sequence..." (target, turn 11 S2)
```

**Why this works:**
When user later asks "How do we avoid recomputing attention?", the query matches:
- "avoid recomputing" (in target chunk)
- "KV cache" (in context)
- The semantic relationship between question and answer

### Example 2: Multi-Part Question

**User turn 20:**
```
S0: "I'm getting an error in the brightness calculation."
S1: "It says 'division by zero' near the threshold."
S2: "Here's the stack trace: [...]"
```

**Embedding user S2 (stack trace):**
```
Context:
- "I'm getting an error in the brightness calculation." (user S0, turn 20)
- "Here's the stack trace: [...]" (target, turn 20 S2)
- "The division by zero occurs when the BOS attention is 1.0..." (assistant S0, turn 21)
```

**Why this works:**
The stack trace chunk is embedded with:
- The problem statement (user S0)
- The diagnosis (assistant S0)

When user later asks "What was that brightness error?", the query retrieves this chunk with full context.

## Token Budget Handling

Maximum embedding context: **256 tokens** (all-MiniLM-L6-v2 limit)

If chunks don't fit:
1. **Priority 1**: Target chunk (always included)
2. **Priority 2**: Paired sentence_0 (from other role)
3. **Priority 3**: Current turn sentence_0 (if target is not S0)

**Example: Large chunks**

User S0 = 150 tokens
Target = 200 tokens
Budget = 256 tokens

Result: Skip user S0, embed target alone (200 < 256)

**Example: Reasonable sizes**

User S0 = 80 tokens
Assistant S0 = 60 tokens
Target = 100 tokens
Total = 240 tokens

Result: Include all three (240 < 256)

## Impact on Retrieval Quality

### Scenario: User asks about brightness scoring months later

**Query:** "How did we handle brightness decay?"

**Old strategy would match:**
- Chunks that mention "brightness" and "decay" sequentially
- May retrieve random chunks about decay from unrelated turns

**New strategy matches:**
- Chunks embedded with questions about brightness
- Chunks embedded with answers about decay
- **Conversational relevance**, not just keyword overlap

### Scenario: User references past error

**Query:** "What was that error we fixed in the attention calculation?"

**Old strategy would match:**
- Chunks containing "error" and "attention"
- May miss chunks that described the error without using both keywords

**New strategy matches:**
- Error description (user S0: "I'm getting an error...")
- Error diagnosis (assistant S0: "The error occurs because...")
- Error resolution chunks (embedded with both question and answer)
- **Captures the full error resolution conversation**

## Implementation Details

### Sentence Lookup Map

For efficient lookup of sentence_0 chunks:

```javascript
const sentenceLookup = new Map();
for (const s of allSentences) {
  const key = `${s.turn_id}_${s.sentence_id}_${s.role}`;
  sentenceLookup.set(key, s);
}

const getSentence0 = (turnId, role) => {
  const key = `${turnId}_0_${role}`;
  return sentenceLookup.get(key);
};
```

O(1) lookup instead of linear search.

### Edge Cases

**Turn 0 (system prompt):**
- Embeds in isolation (no pair)
- System turn has no conversational partner

**Turn 1 (first user message):**
- No previous turn for assistant to reference
- User S0 embeds with assistant S0 from turn 2 (forward reference)

**Last assistant turn:**
- Assistant chunks reference user S0 from previous turn
- No next turn for forward reference (acceptable)

**Orphaned turns:**
- If turn N+1 doesn't exist yet, assistant N chunks embed without forward reference
- Gets re-embedded when turn N+1 arrives? (future enhancement)

## Migration Considerations

**Existing embeddings:**
- Built with old sequential strategy
- Still valid, just different context
- Will gradually be replaced as chunks are re-embedded

**Trigger for re-embedding:**
- When chunk is merged (calls `reindexChunk`)
- Manual re-index (if implemented)
- For now: old embeddings coexist with new ones

**Compatibility:**
- Query still works (searching same vector space)
- Old embeddings: sequential context
- New embeddings: turn-pair context
- Both contribute to search results

## Performance Impact

**Embedding time:**
- Same (still ~40-60ms per chunk)
- Number of chunks to embed unchanged
- Context window computation slightly faster (O(1) lookup vs linear scan)

**Search quality:**
- Expected improvement: **better conversational relevance**
- Chunks retrieved match the Q→A structure
- Aligns with resurrection strategy (we resurect what we embedded with)

## Future Enhancements

**Adaptive context window:**
- If turn pair doesn't fit in 256 tokens, truncate intelligently
- Prioritize question keywords over answer details

**Multi-turn context:**
- Include sentence_0 from turn N-2, N-3 for deep context
- Only if budget allows

**Conversation clustering:**
- Detect topic shifts (new conversation thread)
- Reset turn-pair context at boundaries

**Re-embedding trigger:**
- When new turn completes, re-embed previous turn's chunks
- Ensures all chunks have forward/backward references

For now, the current strategy is clean and effective.

## Budget Accounting Examples

### Example 1: Assistant S3 (not sentence_0)

**Semantic search returns:** Assistant turn 30, sentence 5

**Budget check:**
```javascript
// Find pairs
crossTurnPair = User turn 29, S0 (120 tokens, currently dead)
sameTurnS0 = Assistant turn 30, S0 (80 tokens, currently dead)
target = Assistant turn 30, S5 (150 tokens, currently dead)

// Calculate cost
totalCost = 150 + 120 + 80 = 350 tokens

// Check budget
if (tokensUsed + 350 <= budget) {
  resurrect all three;
  tokensUsed += 350;
}
```

**Result:** 3 chunks resurrected (question + answer opening + target)

### Example 2: Assistant S0 (is sentence_0)

**Semantic search returns:** Assistant turn 30, sentence 0

**Budget check:**
```javascript
// Find pairs
crossTurnPair = User turn 29, S0 (120 tokens, currently dead)
sameTurnS0 = null (target IS sentence_0, don't count twice)
target = Assistant turn 30, S0 (80 tokens, currently dead)

// Calculate cost
totalCost = 80 + 120 + 0 = 200 tokens

// Check budget
if (tokensUsed + 200 <= budget) {
  resurrect both;
  tokensUsed += 200;
}
```

**Result:** 2 chunks resurrected (question + target which is answer opening)

### Example 3: Some chunks already alive

**Semantic search returns:** Assistant turn 30, sentence 5

**Budget check:**
```javascript
// Find pairs
crossTurnPair = User turn 29, S0 (120 tokens, ALREADY ALIVE)
sameTurnS0 = Assistant turn 30, S0 (80 tokens, currently dead)
target = Assistant turn 30, S5 (150 tokens, currently dead)

// Calculate cost (skip alive chunks)
crossTurnCost = 0 (already alive)
sameTurnCost = 80 (dead, needs resurrection)
targetCost = 150 (dead, needs resurrection)
totalCost = 150 + 0 + 80 = 230 tokens

// Check budget
if (tokensUsed + 230 <= budget) {
  resurrect target and sameTurnS0 (crossTurnPair is already alive);
  tokensUsed += 230;
}
```

**Result:** 2 chunks resurrected (answer opening + target), 1 skipped (question already alive)

## Summary

✅ **Turn-pair embeddings encode conversational structure**
✅ **Resurrection matches embedding (3-chunk strategy)**
✅ **Budget accounts for all chunks (target + cross-turn S0 + same-turn S0)**
✅ **Smart deduplication (don't count sentence_0 twice, don't resurrect alive chunks)**
✅ **Opening sentences provide topic context**
✅ **Better retrieval quality for conversational queries**
✅ **Handles edge cases gracefully (system, first turn, last turn, S0 targets)**

The embedding and resurrection strategies are now **perfectly aligned**: we embed with conversational context, and we resurrect with conversational context. The chunks retrieved are the chunks that were embedded together.
