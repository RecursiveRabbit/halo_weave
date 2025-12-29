# AI Reflection System - Periodic Context Summaries

## Status: Design Document

**Concept:** After periods of inactivity, the AI writes a summary of the current context. These summaries are stored as normal turn pairs in the semantic index, allowing the AI to find its own past understanding when relevant.

**Philosophy:** The AI needs to periodically reflect on what's happening. These reflections become searchable memory that can resurface later.

---

## Core Principle

**Reflections are just normal conversation turns. A system prompt asks for a summary, the AI responds. Both get stored as chunks following normal turn-pair rules.**

### Key Insights

- **Normal turn pairs** = System prompt (turn N) + AI response (turn N)
- **Follows existing rules** = If we resurrect the AI chunk, we also resurrect the system prompt (why they wrote it)
- **Visible to user** = User can see, edit, or delete reflections (prevents false knowledge from cementing)
- **Time-triggered** = After X minutes of inactivity, not turn-based
- **Summarizes current context** = Not "last 5 turns", but everything currently in working context

---

## Architecture

### When to Trigger Reflection

**Two conditions must be met:**

1. **At least 5 minutes** since last user message
2. **At least 5 messages** since last reflection

**Both must be true.** This prevents:
- Interrupting active conversation (user is still talking)
- Reflecting on too little context (only 2 messages exchanged)

**Implementation:**
```javascript
class ReflectionTrigger {
  constructor() {
    this.lastUserMessage = Date.now();
    this.lastReflection = Date.now();
    this.messagesSinceReflection = 0;
    this.inactivityTimer = null;

    // Config
    this.MIN_INACTIVITY = 5 * 60 * 1000;  // 5 minutes
    this.MIN_MESSAGES = 5;
  }

  onUserMessage() {
    this.lastUserMessage = Date.now();
    this.messagesSinceReflection++;

    // Clear existing timer
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
    }

    // Set new timer
    this.inactivityTimer = setTimeout(() => {
      this.checkReflectionConditions();
    }, this.MIN_INACTIVITY);
  }

  checkReflectionConditions() {
    const inactivityMet = (Date.now() - this.lastUserMessage) >= this.MIN_INACTIVITY;
    const messagesMet = this.messagesSinceReflection >= this.MIN_MESSAGES;

    if (inactivityMet && messagesMet) {
      console.log('Reflection conditions met (5min + 5msg), triggering reflection...');
      this.triggerReflection();
    } else {
      console.log(`Reflection not triggered: inactivity=${inactivityMet}, messages=${messagesMet}`);
    }
  }

  async triggerReflection() {
    await generateReflection();
    this.lastReflection = Date.now();
    this.messagesSinceReflection = 0;
  }
}
```

**Why both conditions:**
- **Time gate** - Don't interrupt active conversation (user still talking)
- **Message gate** - Don't reflect on too little context (need substance)
- **Together** - Only reflect when user has paused AND there's meaningful context

### The Reflection Prompt

**System message (turn N, role='system'):**
```
Write a concise summary of the current context.
```

That's it. Simple, clear, no mention of semantic index or memory systems.

**The AI doesn't need to know:**
- This will be embedded
- This might resurface later
- How the semantic index works

**The AI just writes a summary of what's happening.**

### The AI's Response

**AI message (turn N, role='assistant'):**
```
We're designing a multi-window architecture for Halo Weave. Key decisions:
- BigInt position IDs to prevent overflow
- Soft-delete (embedding=null) for audit trail
- IndexedDB transactions provide locking
- Reflections stored as normal turn pairs

Open questions:
- How should structured memory work?
- Should reflections be visible to user? (Decision: yes, for accuracy)

Current task: Writing up the reflection system design.
```

**This is a normal assistant turn:**
- Gets tokenized
- Gets chunked (if multiple paragraphs)
- Gets embedded with turn-pair context (system prompt + response)
- Stored in semantic index like any other turn

### Storage as Normal Turn Pair

**Two chunks created:**

**Chunk 1 (System):**
```javascript
{
  turn_id: 527n,
  sentence_id: 0,
  role: 'system',
  text: 'Write a concise summary of the current context.',
  tokens: [...],
  embedding: [...],  // Embedded with context window
  // ... standard fields
}
```

**Chunk 2 (Assistant):**
```javascript
{
  turn_id: 527n,
  sentence_id: 0,  // Or multiple chunks if multi-paragraph
  role: 'assistant',
  text: 'We\'re designing a multi-window architecture...',
  tokens: [...],
  embedding: [...],  // Embedded with turn-pair context (includes system prompt)
  // ... standard fields
}
```

**This follows existing turn-pair embedding strategy:**
- Assistant chunk embeds with: System S0 (turn 527) + Assistant S0 (turn 527) + target
- If we resurrect the assistant chunk, we also resurrect the system prompt
- **The AI sees why it wrote the summary**

### Visibility to User

**Reflections are visible in the UI:**
- Rendered like any other turn pair
- System: "Write a concise summary of the current context."
- Assistant: "[Summary text]"
- User can see what the AI reflected on

**Why visible:**
1. **Accuracy check** - User can see if AI misunderstood something
2. **Correction** - User can delete or edit if reflection is wrong
3. **Transparency** - User knows what the AI is "thinking"
4. **Prevents false knowledge** - Bad reflections don't cement in memory forever

**User can delete reflections:**
- Click delete on the turn pair
- Both chunks get `embedding=null`, `deleted=true`
- They stay in the permanent record but never resurrect
- Prevents AI from retrieving false information

### Resurrection

**Reflections resurrect naturally via semantic search:**

```
Turn 600 (user): "What did we decide about the database schema?"

Semantic search finds:
  1. Turn 87, role=assistant: "I propose using BigInt for position IDs..."
  2. Turn 527, role=assistant: "Key decisions: BigInt position IDs to prevent overflow..."
  3. Turn 92, role=user: "Yes, let's use BigInt"

Resurrection brings all three chunks, plus their turn pairs:
  - Turn 87 system prompt
  - Turn 527 system prompt: "Write a concise summary of the current context."
  - Turn 92 context (if it's part of a pair)

AI response: "We decided on BigInt position IDs to prevent overflow. This ensures
no death date for the conversation - it can continue indefinitely."
```

**The AI sees:**
- The original conversation
- Its own reflection on what was decided
- The system prompt that triggered the reflection (knows it's a summary)

### What Gets Summarized

**Prompt says: "Summarize the current context"**

The AI has access to:
- All tokens in `workingTokens[]` (current working context)
- Recent user messages
- Recent AI responses
- Resurrected chunks

**The AI summarizes everything currently in its context window.**

**Not:**
- "Last 5 turns" (arbitrary cutoff)
- "Recent conversation" (vague)
- Specific topics (AI decides what matters)

**Just:** "Current context" (everything you currently know)

---

## Implementation

### Reflection Generation Flow

```javascript
async function generateReflection() {
  console.log('Generating reflection...');

  // 1. Estimate token requirement for reflection
  const systemPromptTokens = 20;  // "Write a concise summary..."
  const maxReflectionTokens = 2000;
  const overhead = 32;
  const reserve = systemPromptTokens + maxReflectionTokens + overhead;

  // 2. Reserve IDs from index
  const reservation = await semanticIndex.reserveIDs(reserve);
  const reflectionTurnSystem = reservation.turn_user;      // System prompt
  const reflectionTurnAssistant = reservation.turn_assistant;  // AI reflection
  let pos = reservation.position_start;

  // 3. Create system message
  const systemMessage = {
    text: 'Write a concise summary of the current context.',
    role: 'system',
    turn_id: reflectionTurnSystem,
    sentence_id: 0
  };

  // 4. Tokenize system message
  const systemTokens = await koboldClient.tokenize(systemMessage.text);

  for (const token of systemTokens) {
    token.position = pos++;
    token.turn_id = reflectionTurnSystem;
    token.sentence_id = 0;
    token.role = 'system';
  }

  // 5. Add system message to working context
  window.workingTokens.push(...systemTokens);

  // 6. Generate AI response (normal generation)
  const aiResponse = await koboldClient.generateStream({
    context: window.workingTokens,
    maxNewTokens: 2000,  // Cap reflection length
    onToken: (token, attention) => {
      token.position = pos++;
      token.turn_id = reflectionTurnAssistant;
      token.role = 'assistant';
      window.workingTokens.push(token);

      // Update brightness as normal
      window.updateBrightness(attention);
    }
  });

  // 7. Render both messages in UI
  window.renderer.renderTurn(reflectionTurnSystem);
  window.renderer.renderTurn(reflectionTurnAssistant);

  // 8. Chunk and embed both messages
  const chunks = window.conversation.chunkBySentence(
    systemTokens.concat(aiResponse.tokens)
  );

  for (const chunk of chunks) {
    // Generate embedding with turn-pair context
    const embedding = await window.semanticIndex.embedWithContext(chunk);

    // Package and send to index (positions already reserved)
    const result = await window.semanticIndex.writeChunk({
      ...chunk,
      embedding,
      timestamp: new Date(),
      model: EMBEDDING_MODEL,
      deleted: false
    });

    if (result.status === 'SUCCESS') {
      console.log(`✅ Reflection chunk written: turn ${chunk.turn_id}, sentence ${chunk.sentence_id}, role ${chunk.role}`);
    } else {
      console.error(`❌ Reflection chunk failed: ${result.error}`);
      // This shouldn't happen (IDs were reserved)
    }
  }

  console.log('Reflection complete');
}
```

### UI Rendering

**Reflections render like normal turns (two adjacent turns):**
```html
<div class="turn" data-turn-id="527" data-role="system">
  <div class="turn-header">System</div>
  <div class="turn-content">
    Write a concise summary of the current context.
  </div>
</div>

<div class="turn" data-turn-id="528" data-role="assistant">
  <div class="turn-header">Assistant</div>
  <div class="turn-content">
    We're designing a multi-window architecture for Halo Weave. Key decisions:
    - BigInt position IDs to prevent overflow
    - Soft-delete (embedding=null) for audit trail
    ...
  </div>
  <div class="turn-actions">
    <button onclick="deleteChunk(528, 0, 'assistant')">Delete</button>
  </div>
</div>
```

**Note:** System turn is 527, assistant turn is 528. They are adjacent turns, not the same turn.

**Optional: Visual distinction**
- Add CSS class: `class="turn reflection"`
- Style differently (e.g., light blue background)
- User can see at a glance: "This is a reflection, not a user message"

### Deletion Handling

**User clicks delete on reflection:**

Reflections use the same deletion logic as any other chunk. No special handling needed.

```javascript
// Same as deleting any chunk
await semanticIndex.deleteChunk(turn_id, sentence_id, role);
```

**Chunks get soft-deleted:**
- `embedding = null`
- `deleted = true`
- `deletedAt = new Date()`

**They stay in the permanent record but never resurrect.**

---

## Configuration

### Tunable Parameters

```javascript
const REFLECTION_CONFIG = {
  // Trigger
  inactivityThreshold: 5 * 60 * 1000,  // 5 minutes

  // Prompt
  systemPrompt: 'Write a concise summary of the current context.',

  // Generation
  maxTokens: 2000,  // Cap reflection length

  // UI
  showInTranscript: true,  // Always visible
  visuallyDistinct: true,  // Style differently
  allowDeletion: true      // User can delete
};
```

### Prompt Customization

**User can customize the reflection prompt:**
```javascript
// In settings UI
config.reflectionPrompt = 'Summarize what we\'ve discussed and list open questions.';

// Or more detailed
config.reflectionPrompt = `
Write a brief summary covering:
- What we're working on
- Decisions made
- Open questions
`.trim();
```

**The prompt is just a system message. User has full control.**

---

## Benefits

### 1. AI Remembers Its Own Understanding

**Without reflections:**
- User: "What were we working on last week?"
- Semantic search finds raw dialogue chunks
- AI: "We discussed BigInt IDs and soft-delete..."

**With reflections:**
- User: "What were we working on last week?"
- Semantic search finds reflection chunks
- AI: "Last week we designed the multi-window architecture. Key decisions were BigInt IDs for continuity and soft-delete for audit trails. We were debating whether reflections should be visible - we decided yes."

**The reflection provides distilled understanding.**

### 2. Natural Pauses Trigger Reflection

User steps away for coffee = AI reflects on current state.

**No interruption:**
- Doesn't happen mid-conversation
- Doesn't break flow
- User comes back to a fresh summary

### 3. User Can Correct Mistakes

AI misunderstands something in its reflection:
```
AI reflection: "We decided to use optimistic locking instead of transactions."
User: (sees this) "That's wrong, delete that."
```

**User deletes the reflection. It never resurrects. False knowledge doesn't cement.**

### 4. Summarizes Large Context

After 50 turns of back-and-forth discussion, the reflection distills:
```
AI reflection: "We're implementing multi-window architecture with shared semantic
memory. Core decisions: BigInt IDs, soft-delete for audit, IndexedDB transactions
for locking, reflections as normal turn pairs. Still debating: structured memory tool
design. Next steps: implement reflection system, then test at scale."
```

**This 2000-token summary captures 5000 tokens of discussion.**

### 5. Cross-Window Continuity

- Window A: User discusses architecture for 2 hours, steps away
- AI reflects: "Designed multi-window architecture with..."
- User closes Window A
- Window B (next day): User asks "What did we work on yesterday?"
- Semantic search finds Window A's reflection
- **Window B knows what Window A accomplished**

### 6. No Special Infrastructure

- Reflections are normal turn pairs
- Follow existing embedding strategy
- Stored as normal chunks
- Resurrect via normal semantic search
- Render like normal turns

**Zero schema changes. Zero special cases.**

---

## Design Decisions

### Why Time-Based, Not Turn-Based?

**Problem:** Turn-based (every 5 turns) interrupts flow.

**Solution:** Time-based (after 5 minutes inactivity) waits for natural break.

**Benefits:**
- User steps away = good time to reflect
- Doesn't interrupt active conversation
- Natural rhythm (pauses in conversation)

### Why Normal Turn Pairs, Not Special Role?

**Problem:** Special role would require custom handling everywhere.

**Solution:** Use normal system/assistant turn pair.

**Benefits:**
- Follows existing turn-pair embedding strategy
- Resurrects the system prompt (AI knows why it wrote summary)
- No schema changes
- No special resurrection logic
- No special rendering logic

**The only special thing: It's system-triggered, not user-triggered.**

### Why Visible to User?

**Problem:** Hidden reflections could cement false knowledge.

**Solution:** Show reflections in UI. User can see and delete.

**Benefits:**
- User can correct mistakes
- Transparency (user knows what AI is "thinking")
- Prevents false information from becoming permanent memory
- User can audit AI's understanding

**Example scenario:**
```
AI reflects: "We decided to use CAS instead of locking."
User: "No, we decided on locking. Delete that reflection."
User deletes turn.
Chunks get embedding=null, deleted=true.
AI never retrieves that false information.
```

### Why "Summarize Current Context", Not "Last 5 Turns"?

**Problem:** "Last 5 turns" is arbitrary and might miss important earlier context.

**Solution:** "Current context" = everything in working context window.

**Benefits:**
- AI summarizes everything it currently knows
- Includes resurrected chunks (could be from 100 turns ago)
- Captures full picture, not arbitrary slice
- AI decides what matters

**The working context is already curated (pruned, resurrected). Just summarize that.**

---

## Future Enhancements

### Pre-Pruning Reflections

Before pruning low-brightness chunks, trigger a reflection:
```
System: Summarize the chunks about to be pruned from context.
AI: The pruned content discussed edge cases for context overflow and user preferences for vanilla JS...
```

**Benefit:** Creates summary of what's being forgotten.

**Implementation:** Trigger reflection with custom prompt before pruning.

### Manual Reflection Trigger

User can manually trigger a reflection:
```
User: "Summarize what we've discussed"
System: (triggers reflection generation)
```

**Benefit:** User can request summary on demand.

**Implementation:** Button in UI or slash command.

### Reflection on Demand with Custom Prompt

```
User: "Summarize our decisions about database schema"
System: "Summarize our decisions about database schema" (system message)
AI: (writes targeted summary)
```

**Benefit:** Focused reflections on specific topics.

**Implementation:** User types custom prompt, system wraps it and triggers reflection.

### Reflection Quality Metrics

Track reflection quality:
- How often are reflections resurrected? (high = useful)
- How often are reflections deleted? (high = inaccurate)
- Which topics get reflected on most?

**Benefit:** Understand what kinds of reflections are valuable.

**Implementation:** Add metrics to chunk metadata, analyze offline.

---

## Implementation Checklist

### Core Reflection System

- [ ] Add `ReflectionTrigger` class (tracks inactivity timer)
- [ ] Set timer on each user message (reset existing timer)
- [ ] Trigger reflection after inactivity threshold
- [ ] Generate system message: "Write a concise summary of the current context."
- [ ] Generate AI response (normal generation with maxTokens=2000)
- [ ] Store both as normal turn pair (system + assistant chunks)
- [ ] Render both in UI (visible to user)
- [ ] Handle deletion (soft-delete with embedding=null)

### Turn Pair Handling

- [ ] Ensure system message gets turn_id N
- [ ] Ensure AI response gets same turn_id N
- [ ] Chunk both messages (follow paragraph boundaries)
- [ ] Embed with turn-pair context (system S0 + assistant S0 + target)
- [ ] Store all chunks in semantic index
- [ ] Handle NACK (retry with new turn ID)

### UI Integration

- [ ] Render reflections like normal turns
- [ ] Add visual distinction (CSS class "reflection", light blue background)
- [ ] Add delete button (both system and assistant messages)
- [ ] Show "AI is reflecting..." status during generation
- [ ] Update status line during reflection

### Configuration

- [ ] Add inactivity threshold to settings (default 5 minutes)
- [ ] Add max reflection tokens to settings (default 2000)
- [ ] Add custom reflection prompt (optional)
- [ ] Add toggle: Enable/disable reflections
- [ ] Add toggle: Visual distinction on/off

### Testing

- [ ] Reflection triggers after 5 minutes inactivity
- [ ] Timer resets on each user message
- [ ] Reflection stored as normal turn pair
- [ ] Both chunks (system + assistant) stored correctly
- [ ] Reflection resurrects when semantically relevant
- [ ] System prompt resurrects with assistant chunk
- [ ] User can delete reflection (soft-delete)
- [ ] Deleted reflections don't resurrect
- [ ] Multiple windows can see each other's reflections
- [ ] Reflection visible in UI with visual distinction

---

## Summary

✅ **Trigger:** After 5 minutes of inactivity (not turn-based)
✅ **Prompt:** System message: "Write a concise summary of the current context."
✅ **Storage:** Normal turn pair (system turn N + assistant turn N)
✅ **Turn-pair embedding:** Follows existing strategy (resurrects system prompt with assistant chunk)
✅ **Visible:** Rendered in UI like normal turns, user can see and delete
✅ **Deletion:** Soft-delete (embedding=null, deleted=true), stays in permanent record
✅ **No special handling:** Just normal chunks that happen to be system-triggered

**Result:** The AI periodically summarizes what's happening. These summaries become searchable memory that can resurface later. User can correct mistakes by deleting bad reflections.

**This is AI continuity through periodic self-reflection.**
