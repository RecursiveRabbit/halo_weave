/**
 * Conversation - Token Storage + Magnitude Voting v3
 * 
 * Single source of truth for conversation history with integrated brightness scoring.
 * 
 * Algorithm (per generation step):
 * 1. Aggregate attention across layers/heads
 * 2. Calculate threshold excluding BOS: (1.0 - bos_attention) / (context_len - 1)
 * 3. For each non-BOS token:
 *    - If attention > threshold: score += int(attention / threshold)
 *    - If attention <= threshold: score -= 1
 * 4. New tokens start at 255
 * 5. No clamping - scores can go negative
 * 
 * Pruning: while (activeTokenCount > budget) { delete lowest peak brightness sentence }
 */

export class Conversation {
    constructor() {
        // Master token list - soft delete only
        this.tokens = [];
        
        // Position counter - monotonically increasing, never reused
        this.nextPosition = 0;
        
        // Turn tracking
        this.currentTurnId = 0;
        this.currentRole = null;
        
        // Sentence tracking within current turn
        this.currentSentenceId = 0;
        
        // Paragraph-based chunking state
        // Chunks on: \n\n (paragraph), ^} (code block end), ^``` (fenced code end)
        // But only if chunk has >= minChunkTokens
        this._recentText = '';  // Rolling buffer for boundary detection
        this._inCodeBlock = false;  // Track if inside ``` fenced block
        this._currentChunkTokens = 0;  // Tokens in current chunk
        this.minChunkTokens = 64;  // Minimum tokens before allowing chunk break
        
        // === OPTIMIZATION: Cached active token list ===
        // Invalidated on add/delete, rebuilt lazily
        this._activeTokensCache = null;
        this._activeTokenCount = 0;
    }

    // ========== Token Management ==========

    /**
     * Add a message (multiple tokens) to the conversation
     * @param {string} role - "system", "user", or "assistant"
     * @param {Array} tokens - Array of {token_id, text} from tokenizer
     */
    addMessage(role, tokens) {
        this.currentRole = role;
        this.currentSentenceId = 0;
        
        for (const token of tokens) {
            this._addToken(token.token_id, token.text);
        }
    }

    /**
     * Add a single streaming token during generation
     * @param {number} tokenId - Token ID
     * @param {string} text - Token text
     * @returns {Object} The created token
     */
    addStreamingToken(tokenId, text) {
        return this._addToken(tokenId, text);
    }

    /**
     * Internal: Add a single token
     */
    _addToken(tokenId, text) {
        const sentenceId = this.currentSentenceId;
        
        const token = {
            token_id: tokenId,
            text: text,
            position: this.nextPosition++,
            brightness: 255,  // Start bright (fail-safe)
            turn_id: this.currentTurnId,
            role: this.currentRole,
            sentence_id: sentenceId,
            deleted: false,
            pinned: false
        };
        
        this.tokens.push(token);
        
        // SAFETY: Append-to-cache optimization is safe because:
        // 1. Tokens are only added via _addToken(), never modified during add
        // 2. New tokens always start with deleted=false
        // 3. Cache is invalidated on any deletion operation (_invalidateCache)
        if (this._activeTokensCache !== null) {
            this._activeTokensCache.push(token);
            this._activeTokenCount++;
        }
        
        // Detect sentence boundaries for NEXT token
        this._updateSentenceBoundary(text);
        
        return token;
    }

    /**
     * Detect chunk boundaries based on semantic structure
     * 
     * Chunks on:
     * - \n\n (paragraph break)
     * - ^} (closing brace at line start - end of code block)
     * - ^``` (fenced code block boundary)
     * 
     * But only if the current chunk has >= minChunkTokens (default 30).
     * This prevents tiny chunks from short lists or headers.
     */
    _updateSentenceBoundary(text) {
        // Count token toward current chunk
        this._currentChunkTokens++;
        
        // Append to rolling buffer (keep last 10 chars for pattern detection)
        this._recentText += text;
        if (this._recentText.length > 10) {
            this._recentText = this._recentText.slice(-10);
        }
        
        // Check for chunk boundaries
        let boundaryDetected = false;
        
        // 1. Paragraph break: \n\n
        if (this._recentText.includes('\n\n')) {
            boundaryDetected = true;
        }
        
        // 2. Fenced code block boundary: ``` at start of line
        // Match \n``` pattern
        if (this._recentText.includes('\n```')) {
            boundaryDetected = true;
            this._inCodeBlock = !this._inCodeBlock;
        }
        
        // 3. Code block end: } at start of line (not inside fenced block)
        // Match \n} pattern
        if (!this._inCodeBlock && this._recentText.includes('\n}')) {
            boundaryDetected = true;
        }
        
        // Only break if we have enough tokens in this chunk
        if (boundaryDetected && this._currentChunkTokens >= this.minChunkTokens) {
            this.currentSentenceId++;
            this._currentChunkTokens = 0;
            // Clear buffer to avoid double-triggering
            this._recentText = '';
        }
    }

    /**
     * Increment turn counter (call after assistant response completes)
     */
    nextTurn() {
        this.currentTurnId++;
        this.currentSentenceId = 0;
        this._recentText = '';
        this._inCodeBlock = false;
        this._currentChunkTokens = 0;
    }

    /**
     * Get all active (non-deleted) tokens (cached)
     */
    getActiveTokens() {
        if (this._activeTokensCache === null) {
            this._rebuildActiveCache();
        }
        return this._activeTokensCache;
    }
    
    /**
     * Get count of active tokens (O(1) when cached)
     */
    getActiveTokenCount() {
        if (this._activeTokensCache === null) {
            this._rebuildActiveCache();
        }
        return this._activeTokenCount;
    }
    
    /**
     * Get count of active tokens excluding current turn
     * Used for budget checking - current turn is immune until next generation
     */
    getPrunableTokenCount() {
        let count = 0;
        for (let i = 0; i < this.tokens.length; i++) {
            const t = this.tokens[i];
            if (!t.deleted && t.turn_id !== this.currentTurnId) {
                count++;
            }
        }
        return count;
    }
    
    /**
     * Rebuild active token cache
     */
    _rebuildActiveCache() {
        this._activeTokensCache = [];
        for (let i = 0; i < this.tokens.length; i++) {
            if (!this.tokens[i].deleted) {
                this._activeTokensCache.push(this.tokens[i]);
            }
        }
        this._activeTokenCount = this._activeTokensCache.length;
    }
    
    /**
     * Invalidate active token cache (call after add/delete)
     */
    _invalidateCache() {
        this._activeTokensCache = null;
    }

    /**
     * Get input_ids for model
     */
    getInputIds() {
        return this.getActiveTokens().map(t => t.token_id);
    }

    /**
     * Build index -> position mapping (for attention score mapping after pruning)
     */
    buildIndexToPositionMap() {
        const map = new Map();
        this.getActiveTokens().forEach((token, index) => {
            map.set(index, token.position);
        });
        return map;
    }

    // ========== Magnitude Voting v3 ==========

    /**
     * Update brightness scores using magnitude voting algorithm
     * @param {Object} attention - {data: Float32Array, shape: [layers, heads, contextLen], preAggregated?: boolean}
     */
    updateBrightness(attention) {
        // Build active token list with positions in one pass
        const activeTokens = [];
        for (let i = 0; i < this.tokens.length; i++) {
            if (!this.tokens[i].deleted) {
                activeTokens.push(this.tokens[i]);
            }
        }
        
        const contextLen = activeTokens.length;
        if (contextLen < 2) return;  // Need at least BOS + 1 token
        
        // Use pre-aggregated data if available, otherwise aggregate client-side
        const aggregated = attention.preAggregated 
            ? attention.data 
            : this._aggregateAttention(attention);
        
        // O(1) threshold calculation excluding BOS
        const bosAttention = aggregated[0];
        const threshold = (1.0 - bosAttention) / (contextLen - 1);
        
        // Skip if threshold is invalid
        if (threshold <= 0 || !isFinite(threshold)) return;
        
        // Update scores for non-BOS tokens (activeTokens[i] is already the token)
        // Skip current turn tokens - they're in their local attention wave
        const len = Math.min(aggregated.length, contextLen);
        for (let i = 1; i < len; i++) {
            const token = activeTokens[i];
            
            // Skip current turn - these tokens get massive local attention
            // They'll start competing fairly on the next turn
            if (token.turn_id === this.currentTurnId) continue;
            
            const att = aggregated[i];
            
            if (att > threshold) {
                // Strong reference: +ratio (e.g., 6.5x threshold → +6)
                token.brightness += (att / threshold) | 0;  // Faster than Math.floor
                // Cap at 10000 to prevent immortal tokens
                if (token.brightness > 10000) token.brightness = 10000;
            } else {
                // Weak/no reference: gentle decay
                token.brightness -= 1;
            }
        }
    }

    /**
     * Aggregate attention across layers and heads (mean)
     * Optimized: no modulo, process in contextLen-sized chunks
     */
    _aggregateAttention(attention) {
        const [layers, heads, contextLen] = attention.shape;
        const data = attention.data;
        const result = new Float32Array(contextLen);
        
        const totalHeads = layers * heads;
        const scale = 1 / totalHeads;
        
        // Process in chunks of contextLen (one head at a time)
        // Data layout: [layer0_head0_tokens..., layer0_head1_tokens..., ...]
        // This avoids modulo by iterating in natural chunk boundaries
        let offset = 0;
        for (let h = 0; h < totalHeads; h++) {
            for (let i = 0; i < contextLen; i++) {
                result[i] += data[offset++];
            }
        }
        
        // Scale in separate pass (better cache locality)
        for (let i = 0; i < contextLen; i++) {
            result[i] *= scale;
        }
        
        return result;
    }

    // ========== Pruning ==========

    /**
     * Prune lowest brightness sentences until under token budget
     * @param {number} maxTokens - Maximum allowed active tokens
     * @returns {Array} Array of pruned sentence objects (for graveyard)
     */
    pruneToFit(maxTokens) {
        const prunedSentences = [];
        
        // Check total active tokens (including current turn) against budget
        // Current turn is immune from deletion, but still counts toward the limit
        while (this.getActiveTokenCount() > maxTokens) {
            const sentences = this.getSentences();
            
            // Find lowest prunable sentence in single pass
            let lowestSentence = null;
            let lowestPeak = Infinity;
            let prunableSentenceCount = 0;
            
            for (let i = 0; i < sentences.length; i++) {
                const s = sentences[i];
                if (s.fullyDeleted) continue;
                
                // Skip current turn - immune until next generation
                if (s.turn_id === this.currentTurnId) continue;
                
                // Skip system prompt (turn_id 0, role system) - never prune
                if (s.turn_id === 0 && s.role === 'system') continue;
                
                // Skip pinned sentences
                if (s.pinned) continue;
                
                prunableSentenceCount++;
                
                if (s.peakBrightness < lowestPeak) {
                    lowestPeak = s.peakBrightness;
                    lowestSentence = s;
                }
            }
            
            // Keep at least one prunable sentence
            if (prunableSentenceCount <= 1) break;
            
            if (lowestSentence) {
                this._deleteSentence(lowestSentence);
                prunedSentences.push(lowestSentence);
            } else {
                break;
            }
        }
        
        return prunedSentences;
    }
    
    /**
     * Resurrect a sentence from the graveyard (legacy - by position IDs)
     * @param {Array<number>} tokenPositions - Position IDs of tokens to resurrect
     */
    resurrect(tokenPositions) {
        const positionSet = new Set(tokenPositions);
        let resurrectedCount = 0;
        
        for (const token of this.tokens) {
            if (positionSet.has(token.position) && token.deleted) {
                token.deleted = false;
                // Keep earned brightness if higher than floor
                token.brightness = Math.max(255, token.brightness_at_deletion || 255);
                resurrectedCount++;
            }
        }
        
        if (resurrectedCount > 0) {
            this._invalidateCache();
        }
        
        return resurrectedCount;
    }
    
    /**
     * Resurrect a chunk by tuple (for semantic index)
     * @param {number} turn_id - Turn ID
     * @param {number} sentence_id - Sentence/chunk ID
     * @param {string} role - Role ("system", "user", "assistant")
     * @returns {number} Count of tokens resurrected
     */
    resurrectByTuple(turn_id, sentence_id, role) {
        let resurrectedCount = 0;
        
        for (const token of this.tokens) {
            if (token.turn_id === turn_id && 
                token.sentence_id === sentence_id && 
                token.role === role &&
                token.deleted) {
                token.deleted = false;
                // Keep earned brightness if higher than floor
                token.brightness = Math.max(255, token.brightness_at_deletion || 255);
                resurrectedCount++;
            }
        }
        
        if (resurrectedCount > 0) {
            this._invalidateCache();
        }
        
        return resurrectedCount;
    }
    
    /**
     * Toggle pinned state for all tokens in a sentence
     * @param {number} turn_id - Turn ID
     * @param {number} sentence_id - Sentence/chunk ID
     * @param {string} role - Role
     * @returns {boolean} New pinned state
     */
    togglePinned(turn_id, sentence_id, role) {
        // First, determine current state (pinned if ANY token is pinned)
        let currentlyPinned = false;
        for (const token of this.tokens) {
            if (token.turn_id === turn_id && 
                token.sentence_id === sentence_id && 
                token.role === role &&
                token.pinned) {
                currentlyPinned = true;
                break;
            }
        }
        
        // Toggle all tokens in this sentence
        const newState = !currentlyPinned;
        let resurrected = false;
        for (const token of this.tokens) {
            if (token.turn_id === turn_id && 
                token.sentence_id === sentence_id && 
                token.role === role) {
                token.pinned = newState;
                // Pinning also resurrects deleted tokens
                if (newState && token.deleted) {
                    token.deleted = false;
                    // Keep earned brightness if higher than floor
                    token.brightness = Math.max(255, token.brightness_at_deletion || 255);
                    resurrected = true;
                }
            }
        }
        
        if (resurrected) {
            this._invalidateCache();
        }
        
        return newState;
    }
    
    /**
     * Merge a sentence into the previous non-empty sentence
     * @param {number} turn_id - Turn ID
     * @param {number} sentence_id - Sentence/chunk ID to merge
     * @param {string} role - Role
     * @returns {{success: boolean, targetSentenceId: number}} Result with target sentence ID
     */
    mergeSentenceIntoPrevious(turn_id, sentence_id, role) {
        if (sentence_id <= 0) {
            console.warn('Cannot merge sentence 0 - no previous sentence');
            return { success: false, targetSentenceId: -1 };
        }
        
        // Find the previous sentence that actually has tokens
        // (in case previous sentences were already merged away)
        let targetSentenceId = -1;
        for (let i = sentence_id - 1; i >= 0; i--) {
            const hasTokens = this.tokens.some(t => 
                t.turn_id === turn_id && 
                t.sentence_id === i && 
                t.role === role
            );
            if (hasTokens) {
                targetSentenceId = i;
                break;
            }
        }
        
        if (targetSentenceId === -1) {
            console.warn(`No previous sentence with tokens found for turn ${turn_id}, sentence ${sentence_id}`);
            return { success: false, targetSentenceId: -1 };
        }
        
        let mergedCount = 0;
        
        // Resurrect all tokens in target sentence (in case it was deleted)
        for (const token of this.tokens) {
            if (token.turn_id === turn_id && 
                token.sentence_id === targetSentenceId && 
                token.role === role) {
                token.deleted = false;
            }
        }
        
        // Move source tokens to target and resurrect them
        for (const token of this.tokens) {
            if (token.turn_id === turn_id && 
                token.sentence_id === sentence_id && 
                token.role === role) {
                token.sentence_id = targetSentenceId;
                token.deleted = false;
                mergedCount++;
            }
        }
        
        if (mergedCount > 0) {
            this._invalidateCache();
            console.log(`Merged ${mergedCount} tokens from sentence ${sentence_id} into ${targetSentenceId} (all resurrected)`);
        }
        
        return { success: mergedCount > 0, targetSentenceId };
    }
    
    /**
     * Check if a chunk is currently alive (not deleted)
     * @param {number} turn_id - Turn ID
     * @param {number} sentence_id - Sentence/chunk ID  
     * @param {string} role - Role
     * @returns {boolean} True if any token in chunk is alive
     */
    isChunkAlive(turn_id, sentence_id, role) {
        for (const token of this.tokens) {
            if (token.turn_id === turn_id && 
                token.sentence_id === sentence_id && 
                token.role === role &&
                !token.deleted) {
                return true;
            }
        }
        return false;
    }

    /**
     * Delete all tokens in a sentence
     */
    _deleteSentence(sentence) {
        for (const token of this.tokens) {
            if (token.turn_id === sentence.turn_id &&
                token.sentence_id === sentence.sentence_id &&
                token.role === sentence.role &&
                !token.deleted) {
                token.deleted = true;
                token.brightness_at_deletion = token.brightness;
            }
        }
        // Invalidate cache after deletion
        this._invalidateCache();
    }

    /**
     * Get all sentences with metadata
     * Optimized: numeric key instead of string concatenation
     */
    getSentences() {
        const sentenceMap = new Map();
        
        // Role to number mapping (avoid string in key)
        const roleNum = { system: 0, user: 1, assistant: 2 };
        
        for (let i = 0; i < this.tokens.length; i++) {
            const token = this.tokens[i];
            // Numeric key: turn_id * 1000000 + sentence_id * 10 + role
            // Supports up to 1M turns, 100K sentences per turn, 10 roles
            const key = token.turn_id * 1000000 + token.sentence_id * 10 + (roleNum[token.role] || 0);
            
            let sentence = sentenceMap.get(key);
            if (sentence === undefined) {
                sentence = {
                    turn_id: token.turn_id,
                    sentence_id: token.sentence_id,
                    role: token.role,
                    tokens: [],
                    peakBrightness: -Infinity,
                    peakBrightnessAtDeletion: null,
                    fullyDeleted: true,
                    pinned: false
                };
                sentenceMap.set(key, sentence);
            }
            
            sentence.tokens.push(token);
            
            // Sentence is pinned if ANY token is pinned
            if (token.pinned) {
                sentence.pinned = true;
            }
            
            if (!token.deleted) {
                sentence.fullyDeleted = false;
                if (token.brightness > sentence.peakBrightness) {
                    sentence.peakBrightness = token.brightness;
                }
            } else if (token.brightness_at_deletion !== undefined) {
                // Track peak brightness at deletion for deleted sentences
                if (sentence.peakBrightnessAtDeletion === null || 
                    token.brightness_at_deletion > sentence.peakBrightnessAtDeletion) {
                    sentence.peakBrightnessAtDeletion = token.brightness_at_deletion;
                }
            }
        }
        
        return Array.from(sentenceMap.values());
    }

    // ========== Utilities ==========

    /**
     * Get statistics
     * Optimized: single pass, no intermediate arrays
     */
    getStats() {
        const active = this.getActiveTokens();
        const len = active.length;
        
        if (len === 0) {
            return {
                totalTokens: this.tokens.length,
                activeTokens: 0,
                deletedTokens: this.tokens.length,
                turns: this.currentTurnId,
                minBrightness: 0,
                maxBrightness: 0,
                avgBrightness: 0
            };
        }
        
        let min = active[0].brightness;
        let max = min;
        let sum = min;
        
        for (let i = 1; i < len; i++) {
            const b = active[i].brightness;
            if (b < min) min = b;
            if (b > max) max = b;
            sum += b;
        }
        
        return {
            totalTokens: this.tokens.length,
            activeTokens: len,
            deletedTokens: this.tokens.length - len,
            turns: this.currentTurnId,
            minBrightness: min,
            maxBrightness: max,
            avgBrightness: Math.round(sum / len)
        };
    }

    /**
     * Reconstruct text from tokens
     */
    reconstructText(tokens) {
        return tokens.map(t => t.text).join('');
    }

    /**
     * Clear all state
     */
    clear() {
        this.tokens = [];
        this.nextPosition = 0;
        this.currentTurnId = 0;
        this.currentRole = null;
        this.currentSentenceId = 0;
        this._recentText = '';
        this._inCodeBlock = false;
        this._currentChunkTokens = 0;
        this._activeTokensCache = null;
        this._activeTokenCount = 0;
    }

    /**
     * Export full state for debugging/saving
     */
    exportState() {
        return {
            version: 1,
            tokens: this.tokens,
            currentTurnId: this.currentTurnId,
            currentRole: this.currentRole,
            currentSentenceId: this.currentSentenceId,
            nextPosition: this.nextPosition,
            stats: this.getStats(),
            sentences: this.getSentences().map(s => ({
                turn_id: s.turn_id,
                sentence_id: s.sentence_id,
                role: s.role,
                text: this.reconstructText(s.tokens),
                peakBrightness: s.peakBrightness,
                peakBrightnessAtDeletion: s.peakBrightnessAtDeletion,
                tokenCount: s.tokens.length,
                deleted: s.fullyDeleted
            }))
        };
    }

    /**
     * Import state from exported JSON
     * @param {Object} state - Previously exported state
     */
    importState(state) {
        // Clear current state
        this.clear();
        
        // Restore tokens
        this.tokens = state.tokens || [];
        
        // Infer tracking state from tokens if not in export (older format)
        let maxTurnId = 0;
        let maxSentenceId = 0;
        let lastRole = null;
        for (const t of this.tokens) {
            if (t.turn_id > maxTurnId) {
                maxTurnId = t.turn_id;
                maxSentenceId = t.sentence_id;
                lastRole = t.role;
            } else if (t.turn_id === maxTurnId && t.sentence_id > maxSentenceId) {
                maxSentenceId = t.sentence_id;
            }
        }
        
        // Restore tracking state (use saved values or inferred)
        this.currentTurnId = state.currentTurnId ?? maxTurnId;
        this.currentRole = state.currentRole ?? lastRole;
        this.currentSentenceId = state.currentSentenceId ?? maxSentenceId;
        this.nextPosition = state.nextPosition ?? this.tokens.length;
        
        // Invalidate cache
        this._invalidateCache();
        
        console.log(`Imported ${this.tokens.length} tokens, turn ${this.currentTurnId}, sentence ${this.currentSentenceId}`);
    }
}
