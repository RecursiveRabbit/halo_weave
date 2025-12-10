# Halo Weave Code Review - 2025-12-10

**Reviewer:** Claude Opus 4.5  
**Scope:** Full codebase review with focus on sync issues and documented bugs  
**Files Reviewed:** app.js, conversation.js, semantic_index.js, kobold_client.js, renderer.js, embedding_worker.js, graveyard.js, data_capture.js

---

## 🔴 Critical Issues

### 1. Sentence Key Mismatch Between Modules

**Location:** conversation.js:475, renderer.js:76, renderer.js:201

**Problem:** Different modules use inconsistent key formats for identifying sentences/chunks:

```javascript
// conversation.js - includes role
const key = token.turn_id * 1000000 + token.sentence_id * 10 + (roleNum[token.role] || 0);

// renderer.js:76 - MISSING role
const sentenceKey = sentence.turn_id * 1000 + sentence.sentence_id;

// renderer.js:201 - String format, MISSING role
const key = `${turnId}:${sentenceId}`;
```

**Impact:** If a turn ever has sentences with different roles but same sentence_id, the renderer would incorrectly merge/overwrite them. Could cause visual corruption or incorrect brightness coloring.

**Fix:** Standardize on one key format across all modules:
```javascript
// Option A: Numeric (fast)
const sentenceKey = turn_id * 1000000 + sentence_id * 10 + roleNum[role];

// Option B: String (readable)  
const sentenceKey = `${turnId}:${sentenceId}:${role}`;
```

**Files to modify:**
- renderer.js lines 76, 201, and the `sentenceElements` Map key format

---

### 2. WebSocket Promise May Hang on Edge Cases

**Location:** kobold_client.js:236-245

**Problem:** The `onclose` handler only rejects on unclean close with pending token:

```javascript
ws.onclose = (event) => {
    if (this.ws === ws) {
        this.ws = null;
    }
    if (!event.wasClean && pendingToken) {
        onError(new Error(`WebSocket closed unexpectedly: ${event.code}`));
        reject(new Error(`WebSocket closed: ${event.code}`));
    }
    // ⚠️ No handling for: wasClean=true but no 'done' received
    // ⚠️ No handling for: !wasClean but no pendingToken
};
```

**Impact:** Promise could hang forever if server closes without sending `done` message.

**Fix:**
```javascript
ws.onclose = (event) => {
    if (this.ws === ws) {
        this.ws = null;
    }
    // If we haven't resolved yet (via 'done' handler), treat any close as potential error
    if (!event.wasClean) {
        const err = new Error(`WebSocket closed unexpectedly: ${event.code}`);
        onError(err);
        reject(err);
    }
    // Note: Clean close after 'done' is fine - resolve() already called
};
```

---

## 🟡 Moderate Issues

### 3. Context Window Sorting Missing Role Comparison

**Location:** semantic_index.js:296-299

**Problem:** Sort doesn't include role, leading to unstable ordering:

```javascript
const sorted = [...allSentences].sort((a, b) => {
    if (a.turn_id !== b.turn_id) return a.turn_id - b.turn_id;
    return a.sentence_id - b.sentence_id;
    // ⚠️ Missing role comparison
});
```

**Impact:** Context window embedding could include chunks in inconsistent order across runs if same turn_id/sentence_id exists with different roles.

**Fix:**
```javascript
const roleNum = { system: 0, user: 1, assistant: 2 };
const sorted = [...allSentences].sort((a, b) => {
    if (a.turn_id !== b.turn_id) return a.turn_id - b.turn_id;
    if (a.sentence_id !== b.sentence_id) return a.sentence_id - b.sentence_id;
    return (roleNum[a.role] || 0) - (roleNum[b.role] || 0);
});
```

---

### 4. Inefficient Worker Ready Polling

**Location:** semantic_index.js:132-138

**Problem:** Polling loop to wait for worker ready:

```javascript
for (let i = 0; i < 300; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (this._workerReady) return true;
    if (!this._worker) break;
}
```

**Impact:** Wastes CPU cycles, 100ms latency granularity, harder to reason about.

**Fix:** Use Promise-based signaling:
```javascript
// In constructor:
this._workerReadyPromise = new Promise((resolve, reject) => {
    this._resolveWorkerReady = resolve;
    this._rejectWorkerReady = reject;
    setTimeout(() => reject(new Error('Worker init timeout')), 30000);
});

// In onmessage 'ready' case:
this._workerReady = true;
this.modelReady = true;
this._resolveWorkerReady?.();

// In _ensureModel:
if (this._worker && !this._workerReady) {
    try {
        await this._workerReadyPromise;
        return true;
    } catch (err) {
        // Worker failed, fall through to main thread
    }
}
```

---

### 5. Documentation/Code Mismatch: Chunk Minimum Tokens

**Location:** SEMANTIC_INDEX.md vs conversation.js:39

**Problem:** Doc says 10 tokens, code uses 64:

```markdown
<!-- SEMANTIC_INDEX.md -->
Lines under 10 tokens attach to the following line.
```

```javascript
// conversation.js
this.minChunkTokens = 64;  // Minimum tokens before allowing chunk break
```

**Fix:** Update SEMANTIC_INDEX.md to reflect actual value of 64, or discuss if 64 is the intended threshold.

---

## 🟢 Minor Issues

### 6. Dead Code: graveyard.js

**Location:** js/graveyard.js

**Problem:** File exists but is not imported anywhere. Semantic index has replaced it.

**Fix:** Either delete the file or add deprecation header:
```javascript
/**
 * @deprecated Replaced by semantic_index.js as of 2025-12-07
 * Kept for reference only. Do not import.
 */
```

---

### 7. Cache Optimization Needs Safety Comment

**Location:** conversation.js:94-97

**Problem:** The cache append optimization assumes invariants that aren't documented:

```javascript
if (this._activeTokensCache !== null) {
    this._activeTokensCache.push(token);
    this._activeTokenCount++;
}
```

**Fix:** Add clarifying comment:
```javascript
// SAFETY: This append-to-cache optimization is safe because:
// 1. Tokens are only added via _addToken(), never modified during add
// 2. New tokens always start with deleted=false
// 3. Cache is invalidated on any deletion operation
if (this._activeTokensCache !== null) {
    this._activeTokensCache.push(token);
    this._activeTokenCount++;
}
```

---

## 📋 Bugs to Investigate (from CLAUDE.md)

### Bug 1: Stale State After Refresh

**Symptom:** Old conversation content persists after page refresh.

**Likely Cause:** Browser caching JS modules.

**Investigation Steps:**
1. Check if hard refresh (Ctrl+Shift+R) always fixes it
2. Check Network tab for 304 responses on JS files

**Proposed Fix:** Add cache-busting to module imports:
```html
<!-- index.html -->
<script type="module" src="js/app.js?v=${BUILD_HASH}"></script>
```

Or for development, ensure your static file server sends appropriate cache headers:
```
Cache-Control: no-cache, no-store, must-revalidate
```

---

### Bug 2: End Token Tokenization Hanging

**Symptom:** `<|im_end|>` tokenization after generation sometimes hangs.

**Location:** app.js:465-474 (currently commented out)

**Likely Cause:** KoboldCPP tokenization endpoint blocking when called immediately after WebSocket generation completes. The server might still be processing the generation cleanup.

**Investigation Steps:**
1. Add timing logs around the tokenize call
2. Check if WebSocket is fully closed before tokenizing
3. Try adding delay

**Proposed Fix:**
```javascript
// Option A: Ensure WebSocket fully closed
this.client._forceCloseWebSocket();
await new Promise(r => setTimeout(r, 50)); // Small settle time

// Option B: Use try-catch with retry
for (let attempt = 0; attempt < 3; attempt++) {
    try {
        const endTokens = await this.client.tokenize('<|im_end|>\n');
        for (const t of endTokens) {
            const token = this.conversation.addStreamingToken(t.token_id, t.text);
            this.renderer.addToken(token, this.conversation);
        }
        break;
    } catch (err) {
        if (attempt < 2) {
            await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
        } else {
            console.warn('Failed to add end token after retries:', err);
        }
    }
}
```

---

### Bug 3: Off-by-One on Assistant Turns

**Symptom:** AI sometimes answers the previous question instead of the current one.

**Status:** Could not reproduce from code review alone. Turn management looks correct.

**Analysis of Turn Flow:**
```
Initial state: currentTurnId = 0

_handleSend():
  1. _resurrectRelevantContext(text)  // Query with user text, currentTurnId = 0
  2. _addMessage('system', ...)       // Adds tokens with turn_id=0, then nextTurn() → currentTurnId = 1
  3. _addMessage('user', text)        // Adds tokens with turn_id=1, then nextTurn() → currentTurnId = 2
  4. _generate()                      // Assistant tokens get turn_id=2
  5. nextTurn()                       // currentTurnId = 3
```

**Possible Causes:**
1. **Resurrection timing:** Resurrected chunks get brightness=255 and compete fairly, but if they contain Q&A from previous exchanges, they might be contextually confusing to the model
2. **Prompt construction:** Check if `getInputIds()` returns tokens in correct order after resurrection
3. **Semantic index staleness:** If embeddings were computed with incomplete context

**Investigation Steps:**
1. Add diagnostic logging in `_resurrectRelevantContext`:
   ```javascript
   console.log(`🔍 Resurrection query at turn ${this.conversation.currentTurnId}`);
   console.log(`   Query: "${text.slice(0, 50)}..."`);
   console.log(`   Resurrected chunks:`, resurrectedChunks.map(c => ({
       turn: c.match.turn_id,
       text: c.match.text.slice(0, 30)
   })));
   ```

2. Log the full prompt sent to KoboldCPP:
   ```javascript
   const inputIds = this.conversation.getInputIds();
   console.log(`📤 Sending ${inputIds.length} tokens to model`);
   // Optionally decode and log first/last N tokens
   ```

3. Check if resurrected content is being placed in wrong position

---

## 🏗️ Architecture Notes

### Turn Management Clarity

The current pattern where `_addMessage()` calls `nextTurn()` for ALL roles is functional but unintuitive. Consider:

```javascript
// Current (confusing):
_addMessage(role, tokens) → addMessage() → nextTurn()

// Clearer alternative:
_addMessage(role, tokens) → addMessage() // Don't auto-increment
// Then in _handleSend():
await this._addMessage('user', text);
this.conversation.nextTurn();  // Explicit turn boundary
```

This would make the turn boundaries more obvious in the calling code.

### Recommended Logging Additions

For debugging the off-by-one issue, consider adding a debug mode:

```javascript
// In app.js constructor
this.debugMode = localStorage.getItem('halo_weave_debug') === 'true';

// Helper
_debug(...args) {
    if (this.debugMode) console.log(...args);
}

// Usage
this._debug(`🔄 Turn boundary: ${this.conversation.currentTurnId} → ${this.conversation.currentTurnId + 1}`);
```

---

## Summary

| Priority | Count | Action |
|----------|-------|--------|
| 🔴 Critical | 2 | Fix immediately - could cause data corruption or hangs |
| 🟡 Moderate | 3 | Fix soon - correctness/performance issues |
| 🟢 Minor | 2 | Fix when convenient - code quality |
| 📋 Investigate | 3 | Need more data to diagnose |

**Recommended Fix Order:**
1. Sentence key mismatch (Critical #1)
2. WebSocket promise handling (Critical #2)
3. Context window sorting (Moderate #3)
4. Add debug logging for off-by-one investigation
5. Worker ready polling (Moderate #4)
6. Doc/code sync (Moderate #5)
7. Cleanup dead code (Minor #6)
