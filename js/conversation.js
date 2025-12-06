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
            deleted: false
        };
        
        this.tokens.push(token);
        
        // Invalidate cache and update count
        // Optimization: append to cache instead of full invalidate
        if (this._activeTokensCache !== null) {
            this._activeTokensCache.push(token);
            this._activeTokenCount++;
        }
        
        // Detect sentence boundaries for NEXT token
        this._updateSentenceBoundary(text);
        
        return token;
    }

    /**
     * Detect paragraph boundaries (newlines only)
     * Simpler and more reliable than sentence detection
     */
    _updateSentenceBoundary(text) {
        // Paragraph = newline-delimited chunk
        // This avoids mid-sentence splits on abbreviations like "Dr." or "U.S."
        if (text.includes('\n')) {
            this.currentSentenceId++;
        }
    }

    /**
     * Increment turn counter (call after assistant response completes)
     */
    nextTurn() {
        this.currentTurnId++;
        this.currentSentenceId = 0;
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
     * @returns {number} Number of sentences pruned
     */
    pruneToFit(maxTokens) {
        let pruned = 0;
        
        // Use prunable count - excludes current turn (immune until next generation)
        while (this.getPrunableTokenCount() > maxTokens) {
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
                pruned++;
            } else {
                break;
            }
        }
        
        return pruned;
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
                    fullyDeleted: true
                };
                sentenceMap.set(key, sentence);
            }
            
            sentence.tokens.push(token);
            
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
