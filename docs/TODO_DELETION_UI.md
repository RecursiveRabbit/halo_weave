# TODO: Chunk Deletion UI

## Status: Backend Complete, UI Pending

All backend logic for chunk deletion is implemented and ready. Only UI components remain.

---

## Completed ✅

### Backend Implementation

**semantic_index.js:**
- ✅ `deleteChunkFromSearch()` - Removes embedding from semantic index, preserves tokens in database
- ✅ Marks chunk as indexed (prevents re-embedding)

**conversation.js:**
- ✅ `deleteTurn(turn_id)` - Sets deleted=true for all tokens in turn
- ✅ `reconstructTurnText(turn_id)` - Rebuilds text from turn (for input restoration)
- ✅ Persists deletion to IndexedDB via `store.pruneChunk()`

**app.js:**
- ✅ `_handleDeleteChunk(turn_id, sentence_id, role)` - Main orchestrator
- ✅ `_deleteSingleChunk()` - Delete individual chunk
- ✅ `_deleteTurnPair(userTurn, assistantTurn, restoreText)` - Delete Q→A pair
- ✅ `renderer.onDelete` callback wired up

### Deletion Logic (Fully Implemented)

**Rule 1: Delete User turn N, sentence 0**
```javascript
// Deletes user turn N + assistant turn N+1
// No text restoration
await this._deleteTurnPair(turn_id, turn_id + 1);
```

**Rule 2: Delete Assistant turn N**
```javascript
// Check if most recent assistant turn
const mostRecentAssistantTurn = this.conversation.currentTurnId - 1;
const isRecent = (turn_id === mostRecentAssistantTurn);

// Delete both turns, restore text if recent
await this._deleteTurnPair(userTurn, turn_id, isRecent);
```

**Rule 3: Delete any other chunk**
```javascript
// Just delete that single chunk
await this._deleteSingleChunk(turn_id, sentence_id, role);
```

---

## Remaining Work ⏳

### 1. Add X Button to Renderer (renderer.js)

**Location:** In `_renderSentence()` method, alongside existing pin button

**Current code pattern (pin button):**
```javascript
// Pin button (existing)
const pinBtn = document.createElement('button');
pinBtn.className = 'sentence-pin';
pinBtn.textContent = sentence.pinned ? '📌' : '📍';
pinBtn.onclick = (e) => {
    e.stopPropagation();
    if (this.onPinToggle) {
        const newState = this.onPinToggle(sentence.turn_id, sentence.sentence_id, sentence.role);
        pinBtn.textContent = newState ? '📌' : '📍';
    }
};
```

**Add delete button (new):**
```javascript
// Delete button (NEW)
const deleteBtn = document.createElement('button');
deleteBtn.className = 'sentence-delete';
deleteBtn.textContent = '❌';
deleteBtn.title = 'Delete chunk from search index';
deleteBtn.onclick = (e) => {
    e.stopPropagation();
    if (this.onDelete) {
        this.onDelete(sentence.turn_id, sentence.sentence_id, sentence.role);
    }
};
controls.appendChild(deleteBtn);
```

**CSS Styling (add to index.html or styles):**
```css
.sentence-delete {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 14px;
    padding: 2px 4px;
    opacity: 0.3;
    transition: opacity 0.2s;
}

.sentence-delete:hover {
    opacity: 1;
}
```

### 2. Test Delete Functionality

**Test cases:**

1. **Delete single chunk (not S0)**
   - Click X on Assistant turn 5, sentence 2
   - Expected: Only that chunk deleted, rest of turn remains
   - Verify: Chunk disappears, embedding gone

2. **Delete User S0 (ancient history)**
   - Click X on User turn 100, sentence 0
   - Current turn: 500
   - Expected: User 100 + Assistant 101 deleted, no input restoration
   - Verify: Both turns gone, input box unchanged

3. **Delete Assistant turn (ancient)**
   - Click X on any chunk in Assistant turn 101
   - Current turn: 500
   - Expected: User 100 + Assistant 101 deleted, no input restoration
   - Verify: Both turns gone, input box unchanged

4. **Delete Assistant turn (most recent)**
   - User sends: "What is brightness scoring?"
   - Assistant responds with hallucination
   - Click X on any chunk in that assistant turn
   - Expected: Both turns deleted, user text restored to input box
   - Verify: Turns gone, input shows "What is brightness scoring?"
   - User can edit and retry

5. **Verify transcript preservation**
   - After deletion, export conversation state
   - Expected: Tokens exist in database with deleted=true
   - Expected: No embedding in semantic_entries for deleted chunks
   - Verify: `conversation.tokens` includes deleted tokens
   - Verify: `semanticIndex.entries` excludes deleted chunks

6. **Verify no resurrection**
   - Delete a chunk
   - Continue conversation
   - Search for keywords from deleted chunk
   - Expected: Deleted chunk never resurfaces
   - Verify: Semantic search skips chunks without embeddings

---

## Implementation Notes

### File to Edit

**renderer.js** - Line ~180-220 (in `_renderSentence()` method)

Look for the existing pin button code and add the delete button alongside it.

### Callback Already Wired

The `renderer.onDelete` callback is already connected in app.js:
```javascript
this.renderer.onDelete = async (turnId, sentenceId, role) => {
    await this._handleDeleteChunk(turnId, sentenceId, role);
};
```

So once the button is added and calls `this.onDelete()`, everything will work.

### Error Handling

The backend already handles:
- ✅ Chunk not found (warns, doesn't crash)
- ✅ Turn doesn't exist (skips gracefully)
- ✅ IndexedDB errors (logs warning, continues)

### Database Impact

**What gets deleted:**
- Embedding from `semantic_entries` store
- Entry from `semanticIndex.entries` (in-memory)

**What gets preserved:**
- Tokens in `deadTokens` store (deleted=true)
- Complete transcript for audit/export
- Position IDs remain absolute (no gaps)

---

## Quick Start for Next Developer

1. Open `renderer.js`
2. Find `_renderSentence()` method
3. Locate the pin button code (`sentence-pin`)
4. Copy-paste the delete button code above
5. Add CSS styling for `.sentence-delete`
6. Test with the scenarios above
7. Done!

---

## Future Enhancements (Optional)

### Confirmation Dialog

Add confirmation before deleting turn pairs:
```javascript
deleteBtn.onclick = async (e) => {
    e.stopPropagation();

    // Warn for S0 or assistant deletions (deletes turn pair)
    if (sentence.sentence_id === 0 || sentence.role === 'assistant') {
        const confirmed = confirm(
            'This will delete the entire turn pair (question + answer). Continue?'
        );
        if (!confirmed) return;
    }

    if (this.onDelete) {
        await this.onDelete(sentence.turn_id, sentence.sentence_id, sentence.role);
    }
};
```

### Visual Feedback

Show deleted chunks temporarily before rebuild:
```javascript
deleteBtn.onclick = async (e) => {
    e.stopPropagation();

    // Visual feedback
    sentenceElement.style.opacity = '0.3';
    sentenceElement.style.textDecoration = 'line-through';

    if (this.onDelete) {
        await this.onDelete(sentence.turn_id, sentence.sentence_id, sentence.role);
    }

    // Rebuild will remove the element
};
```

### Undo Support

Store last deleted chunks for undo:
```javascript
// In app.js
this._lastDeleted = null;

async _deleteSingleChunk(turn_id, sentence_id, role) {
    // Store for undo
    this._lastDeleted = {
        turn_id, sentence_id, role,
        tokens: this.conversation.tokens.filter(/* matches */),
        embedding: this.semanticIndex.entries.find(/* matches */)
    };

    // Continue with deletion...
}

_undoDelete() {
    if (!this._lastDeleted) return;
    // Restore tokens and embedding
}
```

### Bulk Delete

Select multiple chunks and delete at once:
```javascript
// Add checkbox to each chunk
// Collect selected chunks
// Delete all in single operation
```

---

## Architecture Notes

### Why This Design?

**Preserve transcript, control search:**
- Tokens remain in database (complete history)
- Embeddings deleted (chunk never resurfaces)
- Maintains audit trail for model accountability
- User can export and analyze what was said vs. what's searchable

**Smart deletion rules:**
- User S0 → likely wants to erase Q→A pair
- Assistant turn → likely wants to retry with better prompt
- Other chunks → surgical removal

**Absolute position IDs:**
- Deleted chunks leave gaps in position sequence
- This is correct and expected
- Preserves complete timeline
- Turn 146-147 deleted → Turn 148-149 continue
- No confusion, clean audit trail

### Integration with Existing Systems

**Brightness scoring:** Deleted chunks excluded (deleted=true filter)
**Pruning:** Deleted chunks already pruned (in deadTokens)
**Resurrection:** Never happens (no embedding)
**Export:** Shows all tokens including deleted (transparency)
**Rendering:** Deleted chunks hidden (not in active context)

---

## Questions to Ask While Implementing UI

1. Should delete button always be visible, or only on hover (like pin)?
2. Should there be a keyboard shortcut (e.g., Delete key)?
3. Should deleted chunks flash red before disappearing?
4. Should there be a "Recently deleted" panel (like trash)?
5. Should export highlight which chunks are deleted?

For now, keep it simple: ❌ button, always visible, instant deletion, no undo.

---

## Completion Checklist

- [ ] Add delete button to renderer.js (`_renderSentence()`)
- [ ] Add CSS styling for `.sentence-delete`
- [ ] Test single chunk deletion
- [ ] Test user S0 deletion (turn pair)
- [ ] Test assistant turn deletion (ancient)
- [ ] Test assistant turn deletion (recent, with text restore)
- [ ] Verify no resurrection of deleted chunks
- [ ] Verify transcript preservation in export
- [ ] Update CLAUDE.md with deletion feature
- [ ] Consider confirmation dialog for turn pair deletion
- [ ] Ship it! 🚀
