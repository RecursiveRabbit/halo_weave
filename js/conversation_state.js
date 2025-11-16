/**
 * ConversationState - Token Dictionary
 *
 * Maintains the master list of all tokens in the conversation with metadata.
 * This is the single source of truth for conversation history.
 *
 * Core principles:
 * - Tokenize once, never retokenize
 * - Soft-delete architecture (deleted tokens stay in list, marked deleted=true)
 * - Position IDs are unique and never reused
 * - Fail bright: new tokens start at attention_score=1.0
 */

export class ConversationState {
    constructor() {
        // Master token list - never remove items, only mark deleted
        this.tokens = [];

        // Position counter - monotonically increasing, never reused
        this.nextPosition = 0;

        // Turn tracking
        this.currentTurnId = 0;
        this.currentRole = null;

        // Sentence/line tracking within current message
        this.currentSentenceId = 0;
        this.currentLineId = 0;
    }

    /**
     * Add a new message to the conversation
     * @param {string} role - "system", "user", or "Qwen"
     * @param {Array} tokens - Array of {token_id, text} from tokenizer
     */
    addMessage(role, tokens) {
        this.currentRole = role;
        this.currentSentenceId = 0;
        this.currentLineId = 0;

        for (const token of tokens) {
            this.addToken(token.token_id, token.text);
        }
    }

    /**
     * Add a single token to the conversation
     * @param {number} tokenId - Token ID from tokenizer
     * @param {string} text - Text representation of token
     */
    addToken(tokenId, text) {
        // Detect sentence boundaries
        if (text.trim().match(/[.!?]$/)) {
            this.currentSentenceId++;
        }

        // Detect line boundaries
        if (text.includes('\n')) {
            this.currentLineId++;
        }

        this.tokens.push({
            token_id: tokenId,
            text: text,
            position: this.nextPosition++,
            attention_score: 1.0,  // Fail bright
            raw_attention: 0.0,    // Last raw attention value
            turn_id: this.currentTurnId,
            message_role: this.currentRole,
            sentence_id: this.currentSentenceId,
            line_id: this.currentLineId,
            deleted: false
        });
    }

    /**
     * Get all active (non-deleted) tokens
     * @returns {Array} Active tokens
     */
    getActiveTokens() {
        return this.tokens.filter(t => !t.deleted);
    }

    /**
     * Get input_ids for sending to model
     * @returns {Array<number>} Token IDs for active tokens
     */
    getInputIds() {
        return this.getActiveTokens().map(t => t.token_id);
    }

    /**
     * Build mapping from array index to position ID
     * Critical for mapping attention scores back after pruning
     * @returns {Map<number, number>} index -> position
     */
    buildIndexToPositionMap() {
        const activeTokens = this.getActiveTokens();
        const map = new Map();
        activeTokens.forEach((token, index) => {
            map.set(index, token.position);
        });
        return map;
    }

    /**
     * Update attention score for a token at given position
     * @param {number} position - Token position ID
     * @param {number} score - New attention score (0.0-1.0)
     * @param {number} rawAttention - Raw attention value from model
     */
    updateAttentionScore(position, score, rawAttention) {
        const token = this.tokens[position];
        if (token) {
            token.attention_score = Math.max(0.0, Math.min(1.0, score));
            token.raw_attention = rawAttention;
        }
    }

    /**
     * Prune a sentence (mark all tokens in sentence as deleted)
     * @param {number} turnId - Turn ID
     * @param {number} sentenceId - Sentence ID within turn
     * @param {string} role - Message role
     * @returns {number} Number of tokens pruned
     */
    pruneSentence(turnId, sentenceId, role) {
        let count = 0;
        for (const token of this.tokens) {
            if (token.turn_id === turnId &&
                token.sentence_id === sentenceId &&
                token.message_role === role &&
                !token.deleted) {
                token.deleted = true;
                count++;
            }
        }
        return count;
    }

    /**
     * Get statistics about conversation
     * @returns {Object} Stats
     */
    getStats() {
        const active = this.getActiveTokens();
        return {
            total_tokens: this.tokens.length,
            active_tokens: active.length,
            deleted_tokens: this.tokens.length - active.length,
            turns: this.currentTurnId,
            next_position: this.nextPosition
        };
    }

    /**
     * Increment turn counter (call after assistant response completes)
     */
    nextTurn() {
        this.currentTurnId++;
        this.currentSentenceId = 0;
        this.currentLineId = 0;
    }

    /**
     * Get all sentences grouped by turn and sentence_id
     * @returns {Array} Array of sentence objects with metadata
     */
    getSentences() {
        const sentences = new Map();

        for (const token of this.tokens) {
            const key = `${token.turn_id}-${token.sentence_id}-${token.message_role}`;

            if (!sentences.has(key)) {
                sentences.set(key, {
                    turn_id: token.turn_id,
                    sentence_id: token.sentence_id,
                    message_role: token.message_role,
                    tokens: [],
                    max_brightness: 0,
                    partially_deleted: false,
                    fully_deleted: true
                });
            }

            const sentence = sentences.get(key);
            sentence.tokens.push(token);
            sentence.max_brightness = Math.max(sentence.max_brightness, token.attention_score);

            if (!token.deleted) {
                sentence.fully_deleted = false;
            } else {
                sentence.partially_deleted = true;
            }
        }

        return Array.from(sentences.values());
    }

    /**
     * Reconstruct text from tokens
     * @param {Array} tokens - Token array
     * @returns {string} Reconstructed text
     */
    reconstructText(tokens) {
        return tokens.map(t => t.text).join('');
    }

    /**
     * Clear all conversation state (reset)
     */
    clear() {
        this.tokens = [];
        this.nextPosition = 0;
        this.currentTurnId = 0;
        this.currentRole = null;
        this.currentSentenceId = 0;
        this.currentLineId = 0;
    }

    /**
     * Export full state for debugging
     * @returns {Object} Full state snapshot
     */
    exportState() {
        return {
            tokens: this.tokens,
            stats: this.getStats(),
            sentences: this.getSentences()
        };
    }
}
