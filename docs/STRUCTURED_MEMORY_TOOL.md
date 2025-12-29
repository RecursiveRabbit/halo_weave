# Structured Memory Tool - AI-Controlled Knowledge Base

## Status: Design Document

**Concept:** Give the AI purposeful control over memory through a JSON structure it can read and modify. The AI can save goals, facts, ledgers - any structured information it needs to remember.

**Integration:** Links to semantic index by storing contextual embeddings with each entry, allowing context-aware retrieval.

---

## Core Principle

**The AI needs more than passive memory (semantic search). It needs active memory (deliberate storage and retrieval) with semantic context.**

### Key Insights

- **Passive memory** = Semantic search resurrects what was said
- **Active memory** = AI deliberately saves what matters
- **Context snapshots** = Store relevant context chunks with each memory
- **Hierarchical structure** = Headings and sub-headings for organization
- **Recency bias** = Recent context within a heading weighs heavier

---

## Architecture

### Storage Schema

**IndexedDB store: `structured_memory`**

```javascript
{
  id: auto-increment,
  path: string,              // e.g., "HaloWeave/Goals/Phase1"
  heading: string,           // e.g., "Phase1" (leaf node)
  parent_path: string,       // e.g., "HaloWeave/Goals"

  // Content
  content: any,              // JSON-serializable data (string, object, array)

  // Context snapshot (1000 tokens, ~3-5 chunks)
  contextChunks: [{
    turn_id: BigInt,
    sentence_id: number,
    role: string,
    text: string,
    embedding: Float32Array,
    similarity: number       // Why this chunk was selected
  }],

  // Metadata
  created: Date,
  modified: Date,
  accessed: Date,            // Last time AI queried this
  version: number            // Increments on edit
}
```

**IndexedDB indexes:**
- Primary: `id`
- Index: `path` (unique)
- Index: `parent_path` (for listing children)
- Index: `heading` (for searching by name)
- Index: `modified` (for recency bias)

---

## Tool Interface

The AI has access to these functions via tool calling:

### 1. Save Memory

```javascript
/**
 * Save structured data with contextual snapshot
 *
 * @param path - Hierarchical path (e.g., "HaloWeave/Goals/Phase1")
 * @param content - Data to store (string, object, array)
 * @param contextTokens - How many tokens of context to snapshot (default 1000)
 */
async saveMemory(path, content, contextTokens = 1000) {
  // 1. Parse path
  const parts = path.split('/');
  const heading = parts[parts.length - 1];
  const parent_path = parts.slice(0, -1).join('/');

  // 2. Query semantic index for relevant context
  const query = `${heading} ${JSON.stringify(content).slice(0, 200)}`;
  const matches = await semanticIndex.query(query, topK = 50);

  // 3. Select top chunks within token budget
  const contextChunks = [];
  let tokensUsed = 0;

  for (const match of matches) {
    if (tokensUsed + match.tokenCount <= contextTokens) {
      contextChunks.push({
        turn_id: match.turn_id,
        sentence_id: match.sentence_id,
        role: match.role,
        text: match.text,
        embedding: match.embedding,
        similarity: match.similarity
      });
      tokensUsed += match.tokenCount;
    }
  }

  // 4. Store or update entry
  const existing = await this.db.structured_memory
    .where('path')
    .equals(path)
    .first();

  if (existing) {
    existing.content = content;
    existing.contextChunks = contextChunks;
    existing.modified = new Date();
    existing.version++;
    await this.db.structured_memory.put(existing);
  } else {
    await this.db.structured_memory.add({
      path,
      heading,
      parent_path,
      content,
      contextChunks,
      created: new Date(),
      modified: new Date(),
      accessed: new Date(),
      version: 1
    });
  }

  return {
    status: 'SUCCESS',
    path,
    contextTokens: tokensUsed,
    chunksStored: contextChunks.length
  };
}
```

### 2. Query Memory

**Leaf node (specific entry):**
```javascript
/**
 * Query a specific memory entry
 * Returns content + contextual chunks (pruning current context, inserting snapshot)
 *
 * @param path - Full path to memory (e.g., "HaloWeave/Goals/Phase1")
 * @returns { content, contextChunks, metadata }
 */
async queryMemory(path) {
  const entry = await this.db.structured_memory
    .where('path')
    .equals(path)
    .first();

  if (!entry) {
    return { status: 'NOT_FOUND', path };
  }

  // Update access timestamp
  entry.accessed = new Date();
  await this.db.structured_memory.put(entry);

  return {
    status: 'SUCCESS',
    content: entry.content,
    contextChunks: entry.contextChunks,  // AI should insert these into context
    metadata: {
      created: entry.created,
      modified: entry.modified,
      version: entry.version
    }
  };
}
```

**Parent node (directory listing with semantic search):**
```javascript
/**
 * Query a parent heading (lists children with semantic search)
 *
 * @param path - Parent path (e.g., "HaloWeave/Goals")
 * @param query - Search term to filter children (optional)
 * @param recencyBias - Weight recent entries higher (default 0.3)
 * @returns { children: [...], relevantContext: [...] }
 */
async queryMemoryHeading(path, query = null, recencyBias = 0.3) {
  // 1. Get all children
  const children = await this.db.structured_memory
    .where('parent_path')
    .equals(path)
    .toArray();

  if (children.length === 0) {
    return { status: 'NOT_FOUND', path };
  }

  // 2. If no query, return all children sorted by recency
  if (!query) {
    children.sort((a, b) => b.modified - a.modified);
    return {
      status: 'SUCCESS',
      children: children.map(c => ({
        path: c.path,
        heading: c.heading,
        content: c.content,
        modified: c.modified
      }))
    };
  }

  // 3. Semantic search across all children's context chunks
  const queryEmbedding = await semanticIndex.embed(query);
  const results = [];

  for (const child of children) {
    let maxSimilarity = 0;
    const relevantChunks = [];

    // Search child's context chunks
    for (const chunk of child.contextChunks) {
      const similarity = cosineSimilarity(queryEmbedding, chunk.embedding);
      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
      }
      if (similarity > 0.5) {  // Threshold
        relevantChunks.push({ ...chunk, similarity });
      }
    }

    // Calculate score with recency bias
    const ageInDays = (Date.now() - child.modified) / (1000 * 60 * 60 * 24);
    const recencyScore = Math.exp(-ageInDays / 30);  // Decay over 30 days
    const finalScore = (1 - recencyBias) * maxSimilarity + recencyBias * recencyScore;

    results.push({
      path: child.path,
      heading: child.heading,
      content: child.content,
      modified: child.modified,
      relevantChunks,
      score: finalScore
    });
  }

  // 4. Sort by score and return top matches
  results.sort((a, b) => b.score - a.score);

  return {
    status: 'SUCCESS',
    children: results,
    totalChildren: children.length
  };
}
```

### 3. List Memory Structure

```javascript
/**
 * List all paths in memory (like `ls -R`)
 *
 * @param rootPath - Starting path (default: root)
 * @returns Tree structure
 */
async listMemory(rootPath = '') {
  const allEntries = await this.db.structured_memory
    .where('parent_path')
    .startsWith(rootPath)
    .toArray();

  // Build tree structure
  const tree = {};
  for (const entry of allEntries) {
    const parts = entry.path.split('/');
    let current = tree;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!current[part]) {
        current[part] = i === parts.length - 1 ? entry.content : {};
      }
      current = current[part];
    }
  }

  return {
    status: 'SUCCESS',
    tree,
    totalEntries: allEntries.length
  };
}
```

### 4. Delete Memory

```javascript
/**
 * Delete a memory entry (or entire subtree)
 *
 * @param path - Path to delete
 * @param recursive - Delete children too (default false)
 */
async deleteMemory(path, recursive = false) {
  if (recursive) {
    // Delete all children
    const children = await this.db.structured_memory
      .where('parent_path')
      .startsWith(path)
      .toArray();

    for (const child of children) {
      await this.db.structured_memory.delete(child.id);
    }
  }

  // Delete the entry itself
  const entry = await this.db.structured_memory
    .where('path')
    .equals(path)
    .first();

  if (entry) {
    await this.db.structured_memory.delete(entry.id);
    return { status: 'SUCCESS', path };
  }

  return { status: 'NOT_FOUND', path };
}
```

---

## Usage Examples

### Example 1: Saving a Goal

**AI tool call:**
```javascript
await saveMemory(
  'HaloWeave/Goals/MultiWindowSupport',
  {
    goal: 'Implement multi-window architecture',
    status: 'in_progress',
    blockers: ['Need to design BigInt schema', 'Test IndexedDB transactions'],
    priority: 'high'
  },
  contextTokens: 1000
);
```

**What happens:**
1. Semantic search finds relevant chunks about multi-window architecture (from current conversation)
2. Top 1000 tokens of context stored with the goal
3. Entry saved at `HaloWeave/Goals/MultiWindowSupport`

**Later, AI queries:**
```javascript
const result = await queryMemory('HaloWeave/Goals/MultiWindowSupport');
// Returns: { content: {...}, contextChunks: [...] }
```

**AI receives:**
- The goal content (status, blockers, priority)
- The contextual chunks from when the goal was created
- AI can prune 1k tokens from current context and insert these chunks to "remember why"

### Example 2: Querying a Parent Heading

**AI tool call:**
```javascript
const result = await queryMemoryHeading(
  'HaloWeave/Goals',
  query: 'What goals are related to database schema?',
  recencyBias: 0.3
);
```

**What happens:**
1. Loads all children under `HaloWeave/Goals`
2. Embeds the query: "What goals are related to database schema?"
3. Searches each child's context chunks for semantic matches
4. Scores each child: 70% similarity + 30% recency
5. Returns sorted list of goals with relevant context chunks

**AI receives:**
```javascript
{
  status: 'SUCCESS',
  children: [
    {
      path: 'HaloWeave/Goals/MultiWindowSupport',
      heading: 'MultiWindowSupport',
      content: { goal: '...', status: 'in_progress', ... },
      relevantChunks: [
        { text: 'Design final schema with BigInt position/turn IDs', similarity: 0.89 },
        { text: 'Add deleted, deletedAt, model fields', similarity: 0.76 }
      ],
      score: 0.82
    },
    {
      path: 'HaloWeave/Goals/BrightnessScoring',
      content: { goal: 'Optimize brightness decay', ... },
      relevantChunks: [],
      score: 0.15
    }
  ]
}
```

### Example 3: Ledger of Facts

**AI saves facts as they're learned:**
```javascript
await saveMemory(
  'User/Preferences/CodingStyle',
  {
    prefers: 'vanilla JS over frameworks',
    avoids: 'npm build steps',
    likes: 'BigInt for IDs, simple schemas'
  }
);

await saveMemory(
  'User/Projects/HaloWeave',
  {
    type: 'AI memory system',
    stack: 'vanilla JS, IndexedDB, KoboldCPP',
    status: 'active development',
    lastWorkedOn: '2024-12-24'
  }
);
```

**Later, AI queries:**
```javascript
const prefs = await queryMemory('User/Preferences/CodingStyle');
// Gets preferences + context from when they were discussed
```

### Example 4: Top-Level in System Prompt

**System prompt includes:**
```
You have access to a structured memory system with the following top-level structure:

HaloWeave/
  Goals/
    MultiWindowSupport
    BrightnessScoring
    SemanticIndex
  Architecture/
    DatabaseSchema
    WindowLifecycle
    WriteProtocol
  Bugs/
    UserTurnsAppended
    EndTokenHanging

User/
  Preferences/
    CodingStyle
  Projects/
    HaloWeave
    PositronicBrain

Use queryMemory(path) to retrieve specific entries.
Use queryMemoryHeading(path, query) to search within a heading.
Use saveMemory(path, content) to store new information.
```

---

## Design Decisions

### Why Store Context Chunks with Memories?

**Problem:** When the AI queries "HaloWeave/Goals/Phase1" 1000 turns later, the current context might not explain why the goal was created.

**Solution:** Store 1000 tokens of relevant context from when the memory was created. On query, prune current context and insert the snapshot.

**Benefits:**
- AI remembers the reasoning behind decisions
- Context is semantically relevant (not just chronologically adjacent)
- Bridges the gap between past intent and current state

### Why Semantic Search on Parent Headings?

**Problem:** If you query "HaloWeave/Goals", you don't want context from when the heading was created (empty). You want to search across all goal entries.

**Solution:** Treat all stored chunks in all children as a corpus. Run semantic search across that corpus.

**Benefits:**
- Querying a parent returns relevant children
- Recency bias prevents stale goals from dominating
- AI can ask "What goals involve databases?" and get smart matches

### Why Recency Bias?

**Problem:** A goal from 6 months ago might be semantically perfect but no longer relevant.

**Solution:** Score = (1 - recencyBias) × similarity + recencyBias × recencyScore

**Benefits:**
- Recent entries weigh heavier
- Adjustable parameter (0.3 = 70% similarity, 30% recency)
- Exponential decay over 30 days (configurable)

### Why Hierarchical Paths?

**Problem:** Flat key-value store gets chaotic at scale.

**Solution:** Use filesystem-like paths: `Category/Subcategory/Entry`

**Benefits:**
- Natural organization
- Can query at any level (leaf or parent)
- Easy to visualize (tree structure in UI)
- AI can explore incrementally (list top level, drill down)

### Why Store Full Context Chunks (Not Just References)?

**Problem:** If we only store position IDs, we depend on semantic index never deleting those chunks.

**Solution:** Store full chunk data (text + embedding) in the memory entry.

**Benefits:**
- Self-contained (memory persists even if source chunks deleted)
- Faster retrieval (no join with semantic index)
- Snapshot is immutable (chunk text won't change)

---

## Integration with Multi-Window Architecture

### Shared Across Windows

**The structured memory is in the same IndexedDB database as the semantic index.** All windows share the same memory structure.

- Window A saves `HaloWeave/Goals/Phase1`
- Window B queries `HaloWeave/Goals` and sees Phase1
- Cross-window knowledge sharing (just like semantic index)

### Context Injection on Query

When AI queries a memory entry:

1. **Prune current context** - Remove 1k tokens to make space
2. **Insert context chunks** - Add the stored chunks at their original positions
3. **Generate response** - AI now has the relevant historical context

**Implementation:**
```javascript
async injectMemoryContext(memoryPath) {
  // 1. Query memory
  const memory = await structuredMemory.queryMemory(memoryPath);

  if (memory.status !== 'SUCCESS') {
    return { error: 'Memory not found' };
  }

  // 2. Calculate token cost
  const contextTokenCost = memory.contextChunks.reduce(
    (sum, chunk) => sum + chunk.text.split(' ').length * 1.3,  // Rough estimate
    0
  );

  // 3. Prune current context to make space
  await window.pruneToFit(
    currentContextSize - contextTokenCost,
    preserveRecent = true  // Keep recent turns
  );

  // 4. Insert memory context chunks
  for (const chunk of memory.contextChunks) {
    window.workingTokens.push(...chunk.tokens);  // If we stored full tokens
    // OR just render as text block if we only stored text
  }

  // 5. Return memory content to AI
  return {
    content: memory.content,
    contextInjected: true,
    tokensAdded: contextTokenCost
  };
}
```

---

## Tool Call Examples

### As Seen by the AI

**Tool definition:**
```json
{
  "name": "saveMemory",
  "description": "Save structured data to your memory with contextual snapshot",
  "parameters": {
    "path": {
      "type": "string",
      "description": "Hierarchical path like 'Project/Category/Entry'"
    },
    "content": {
      "type": "any",
      "description": "Data to store (string, object, array)"
    },
    "contextTokens": {
      "type": "number",
      "default": 1000,
      "description": "How many tokens of relevant context to snapshot"
    }
  }
}
```

**AI uses it:**
```
User: "Remember this: I prefer to avoid npm and build steps"