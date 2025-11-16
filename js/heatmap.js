/**
 * Heatmap - Token Visualization
 *
 * Renders conversation tokens with color-coded attention brightness.
 * Handles incremental token rendering, pruning animations, and user interactions.
 */

export class Heatmap {
    constructor(containerElement) {
        this.container = containerElement;
        this.currentTurnElement = null;
        this.currentSentenceElement = null;
    }

    /**
     * Clear all visualizations
     */
    clear() {
        this.container.innerHTML = '';
        this.currentTurnElement = null;
        this.currentSentenceElement = null;
    }

    /**
     * Start a new turn
     * @param {number} turnId - Turn ID
     * @param {string} role - Message role ("system", "user", "Qwen")
     */
    startTurn(turnId, role) {
        this.currentTurnElement = document.createElement('div');
        this.currentTurnElement.className = `attention-turn turn-${role}`;
        this.currentTurnElement.dataset.turnId = turnId;
        this.currentTurnElement.dataset.role = role;

        // Turn header
        const header = document.createElement('div');
        header.className = 'turn-header';
        header.textContent = `Turn ${turnId} - ${role}`;
        this.currentTurnElement.appendChild(header);

        // Sentence container
        this.currentSentenceElement = document.createElement('div');
        this.currentSentenceElement.className = 'sentence';
        this.currentTurnElement.appendChild(this.currentSentenceElement);

        this.container.appendChild(this.currentTurnElement);
    }

    /**
     * Start a new sentence within current turn
     * @param {number} sentenceId - Sentence ID
     */
    startSentence(sentenceId) {
        if (!this.currentTurnElement) {
            console.warn('startSentence called without active turn');
            return;
        }

        this.currentSentenceElement = document.createElement('div');
        this.currentSentenceElement.className = 'sentence';
        this.currentSentenceElement.dataset.sentenceId = sentenceId;
        this.currentTurnElement.appendChild(this.currentSentenceElement);
    }

    /**
     * Add a token to the current sentence
     * @param {Object} token - Token object from ConversationState
     */
    addToken(token) {
        if (!this.currentSentenceElement) {
            console.warn('addToken called without active sentence');
            return;
        }

        const span = document.createElement('span');
        span.className = 'token';
        span.dataset.position = token.position;
        span.textContent = token.text;
        span.style.backgroundColor = this._getColorForScore(token.attention_score);

        // Tooltip with metadata
        span.title = `Position: ${token.position}\nScore: ${token.attention_score.toFixed(4)}\nRaw: ${token.raw_attention.toFixed(6)}`;

        this.currentSentenceElement.appendChild(span);

        // Check for sentence boundary
        if (token.text.trim().match(/[.!?]$/)) {
            this.startSentence(token.sentence_id + 1);
        }
    }

    /**
     * Update all token colors based on current scores
     * @param {ConversationState} conversationState
     */
    updateAll(conversationState) {
        for (const token of conversationState.tokens) {
            if (token.deleted) continue;

            const span = this.container.querySelector(`span[data-position="${token.position}"]`);
            if (span) {
                span.style.backgroundColor = this._getColorForScore(token.attention_score);
                span.title = `Position: ${token.position}\nScore: ${token.attention_score.toFixed(4)}\nRaw: ${token.raw_attention.toFixed(6)}`;
            }
        }
    }

    /**
     * Animate pruning of a sentence
     * @param {number} turnId - Turn ID
     * @param {number} sentenceId - Sentence ID
     * @param {string} role - Message role
     */
    animatePruning(turnId, sentenceId, role) {
        const turnElement = this.container.querySelector(
            `.attention-turn[data-turn-id="${turnId}"][data-role="${role}"]`
        );
        if (!turnElement) return;

        const sentenceElement = turnElement.querySelector(
            `.sentence[data-sentence-id="${sentenceId}"]`
        );
        if (!sentenceElement) return;

        // Red flash
        sentenceElement.style.backgroundColor = '#ff4444';
        sentenceElement.style.transition = 'background-color 0.1s, opacity 0.3s';

        // Fade out after flash
        setTimeout(() => {
            sentenceElement.style.backgroundColor = 'transparent';
            sentenceElement.style.opacity = '0';
        }, 100);

        // Remove from DOM
        setTimeout(() => {
            sentenceElement.remove();
        }, 400);
    }

    /**
     * Rebuild entire heatmap from conversation state
     * @param {ConversationState} conversationState
     */
    rebuild(conversationState) {
        this.clear();

        const sentences = conversationState.getSentences();

        let currentTurn = -1;
        let currentSentence = -1;

        for (const sentence of sentences) {
            if (sentence.fully_deleted) continue;

            // Start new turn if needed
            if (sentence.turn_id !== currentTurn) {
                this.startTurn(sentence.turn_id, sentence.message_role);
                currentTurn = sentence.turn_id;
                currentSentence = -1;
            }

            // Start new sentence if needed
            if (sentence.sentence_id !== currentSentence) {
                this.startSentence(sentence.sentence_id);
                currentSentence = sentence.sentence_id;
            }

            // Add tokens
            for (const token of sentence.tokens) {
                if (!token.deleted) {
                    this.addToken(token);
                }
            }
        }
    }

    /**
     * Get background color for attention score
     * @param {number} score - Attention score (0.0-1.0)
     * @returns {string} CSS color
     */
    _getColorForScore(score) {
        // Clamp to [0, 1]
        score = Math.max(0.0, Math.min(1.0, score));

        // Interpolate from dark (low attention) to bright (high attention)
        // Dark blue -> cyan -> white
        if (score < 0.5) {
            // 0.0 -> 0.5: dark blue (#001f3f) to cyan (#7fdbff)
            const t = score * 2;
            const r = Math.round(0 + t * 127);
            const g = Math.round(31 + t * 188);
            const b = Math.round(63 + t * 192);
            return `rgb(${r}, ${g}, ${b})`;
        } else {
            // 0.5 -> 1.0: cyan (#7fdbff) to white (#ffffff)
            const t = (score - 0.5) * 2;
            const r = Math.round(127 + t * 128);
            const g = Math.round(219 + t * 36);
            const b = Math.round(255 + t * 0);
            return `rgb(${r}, ${g}, ${b})`;
        }
    }

    /**
     * Scroll to bottom of container
     */
    scrollToBottom() {
        this.container.scrollTop = this.container.scrollHeight;
    }

    /**
     * Export heatmap as text with color codes
     * @param {ConversationState} conversationState
     * @returns {string} Formatted text
     */
    exportAsText(conversationState) {
        const sentences = conversationState.getSentences();
        let output = '';

        for (const sentence of sentences) {
            if (sentence.fully_deleted) continue;

            output += `\n[Turn ${sentence.turn_id} - ${sentence.message_role}]\n`;

            for (const token of sentence.tokens) {
                if (!token.deleted) {
                    const score = (token.attention_score * 100).toFixed(0);
                    output += `${token.text}[${score}%] `;
                }
            }

            output += '\n';
        }

        return output;
    }

    /**
     * Get statistics for display
     * @param {ConversationState} conversationState
     * @returns {Object} Statistics
     */
    getStats(conversationState) {
        const stats = conversationState.getStats();
        const activeTokens = conversationState.getActiveTokens();

        if (activeTokens.length === 0) {
            return {
                ...stats,
                avgBrightness: 0,
                maxBrightness: 0,
                minBrightness: 0
            };
        }

        let sum = 0;
        let max = -Infinity;
        let min = Infinity;

        for (const token of activeTokens) {
            sum += token.attention_score;
            max = Math.max(max, token.attention_score);
            min = Math.min(min, token.attention_score);
        }

        return {
            ...stats,
            avgBrightness: sum / activeTokens.length,
            maxBrightness: max,
            minBrightness: min
        };
    }
}
