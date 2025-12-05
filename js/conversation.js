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
     * Get all active (non-deleted) tokens
     */
    getActiveTokens() {
        return this.tokens.filter(t => !t.deleted);
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
     * @param {Object} attention - {data: Float32Array, shape: [layers, heads, contextLen]}
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
        
        // Aggregate attention across layers/heads
        const aggregated = this._aggregateAttention(attention);
        
        // O(1) threshold calculation excluding BOS
        const bosAttention = aggregated[0];
        const threshold = (1.0 - bosAttention) / (contextLen - 1);
        
        // Skip if threshold is invalid
        if (threshold <= 0 || !isFinite(threshold)) return;
        
        // Update scores for non-BOS tokens (activeTokens[i] is already the token)
        const len = Math.min(aggregated.length, contextLen);
        for (let i = 1; i < len; i++) {
            const token = activeTokens[i];
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
     * Optimized: single pass through data array
     */
    _aggregateAttention(attention) {
        const [layers, heads, contextLen] = attention.shape;
        const data = attention.data;
        const result = new Float32Array(contextLen);
        
        const totalHeads = layers * heads;
        
        // Single pass: iterate through flat array once
        // Data layout: [layer0_head0_tokens..., layer0_head1_tokens..., ...]
        for (let idx = 0; idx < data.length; idx++) {
            const tokenPos = idx % contextLen;
            result[tokenPos] += data[idx];
        }
        
        // Divide by total heads
        const scale = 1 / totalHeads;
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
        
        while (this.getActiveTokens().length > maxTokens) {
            const sentences = this.getSentences();
            const activeSentences = sentences.filter(s => !s.fullyDeleted);
            
            if (activeSentences.length <= 1) break;  // Keep at least one sentence
            
            // Find sentence with lowest peak brightness
            // Skip system prompt (turn_id 0, role system) - never prune
            const prunableSentences = activeSentences.filter(s => 
                !(s.turn_id === 0 && s.role === 'system')
            );
            
            if (prunableSentences.length === 0) break;
            
            let lowestSentence = null;
            let lowestPeak = Infinity;
            
            for (const sentence of prunableSentences) {
                if (sentence.peakBrightness < lowestPeak) {
                    lowestPeak = sentence.peakBrightness;
                    lowestSentence = sentence;
                }
            }
            
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
            }
        }
    }

    /**
     * Get all sentences with metadata
     */
    getSentences() {
        const sentenceMap = new Map();
        
        for (const token of this.tokens) {
            const key = `${token.turn_id}-${token.sentence_id}-${token.role}`;
            
            if (!sentenceMap.has(key)) {
                sentenceMap.set(key, {
                    turn_id: token.turn_id,
                    sentence_id: token.sentence_id,
                    role: token.role,
                    tokens: [],
                    peakBrightness: -Infinity,
                    fullyDeleted: true
                });
            }
            
            const sentence = sentenceMap.get(key);
            sentence.tokens.push(token);
            
            if (!token.deleted) {
                sentence.fullyDeleted = false;
                sentence.peakBrightness = Math.max(sentence.peakBrightness, token.brightness);
            }
        }
        
        return Array.from(sentenceMap.values());
    }

    // ========== Utilities ==========

    /**
     * Get statistics
     */
    getStats() {
        const active = this.getActiveTokens();
        const brightnesses = active.map(t => t.brightness);
        
        return {
            totalTokens: this.tokens.length,
            activeTokens: active.length,
            deletedTokens: this.tokens.length - active.length,
            turns: this.currentTurnId,
            minBrightness: brightnesses.length ? Math.min(...brightnesses) : 0,
            maxBrightness: brightnesses.length ? Math.max(...brightnesses) : 0,
            avgBrightness: brightnesses.length ? 
                Math.round(brightnesses.reduce((a, b) => a + b, 0) / brightnesses.length) : 0
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
    }

    /**
     * Export full state for debugging/saving
     */
    exportState() {
        return {
            tokens: this.tokens,
            stats: this.getStats(),
            sentences: this.getSentences().map(s => ({
                turn_id: s.turn_id,
                sentence_id: s.sentence_id,
                role: s.role,
                text: this.reconstructText(s.tokens),
                peakBrightness: s.peakBrightness,
                tokenCount: s.tokens.length,
                deleted: s.fullyDeleted
            }))
        };
    }
}
