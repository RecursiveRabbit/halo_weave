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
        this.currentSentenceTokens = []; // Track tokens in current sentence for peak calculation
        this.lastTurnId = null;
        this.lastSentenceId = null;
    }

    /**
     * Clear all visualizations
     */
    clear() {
        this.container.innerHTML = '';
        this.currentTurnElement = null;
        this.currentSentenceElement = null;
        this.lastTurnId = null;
        this.lastSentenceId = null;
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

        // Update background color of previous sentence based on its peak
        this._updateSentenceBackground();

        this.currentSentenceElement = document.createElement('div');
        this.currentSentenceElement.className = 'sentence';
        this.currentSentenceElement.dataset.sentenceId = sentenceId;
        this.currentTurnElement.appendChild(this.currentSentenceElement);
        this.currentSentenceTokens = []; // Reset for new sentence
    }

    /**
     * Add a token to the current sentence
     * @param {Object} token - Token object from ConversationState
     */
    addToken(token) {
        // Check if we need to create a new sentence element
        // Trust the sentence_id from ConversationState (single source of truth)
        if (!this.currentSentenceElement ||
            token.sentence_id !== this.lastSentenceId ||
            token.turn_id !== this.lastTurnId) {

            // Update background of previous sentence before starting new one
            if (this.currentSentenceElement && this.currentSentenceTokens.length > 0) {
                this._updateSentenceBackground();
            }

            this.startSentence(token.sentence_id);
            this.lastSentenceId = token.sentence_id;
            this.lastTurnId = token.turn_id;
        }

        // Track token for sentence peak calculation
        this.currentSentenceTokens.push(token);

        const span = document.createElement('span');
        span.className = 'token';
        span.dataset.position = token.position;
        span.textContent = token.text;

        // Text color based on individual token score
        span.style.color = this._getTextColorForScore(token.attention_score);

        // Tooltip with metadata
        const historyStr = token.attention_history ? token.attention_history.map(v => v.toFixed(3)).join(', ') : 'none';
        span.title = `Position: ${token.position}\nScore: ${token.attention_score.toFixed(2)}\nPeak: ${token.peak_attention.toFixed(2)}\nRaw: ${token.raw_attention.toFixed(4)}\nHistory: [${historyStr}]`;

        this.currentSentenceElement.appendChild(span);
    }

    /**
     * Update sentence background based on peak brightness of current sentence
     */
    _updateSentenceBackground() {
        if (!this.currentSentenceElement || this.currentSentenceTokens.length === 0) {
            return;
        }

        // Find peak attention in sentence
        const peakScore = Math.max(...this.currentSentenceTokens.map(t => t.attention_score));

        // Set background color based on peak
        this.currentSentenceElement.style.backgroundColor = this._getColorForScore(peakScore);
    }

    /**
     * Update all token colors based on current scores
     * @param {ConversationState} conversationState
     */
    updateAll(conversationState) {
        // Group tokens by sentence for peak calculation
        const sentenceMap = new Map();
        for (const token of conversationState.tokens) {
            if (token.deleted) continue;
            const key = `${token.turn_id}-${token.sentence_id}-${token.message_role}`;
            if (!sentenceMap.has(key)) {
                sentenceMap.set(key, []);
            }
            sentenceMap.get(key).push(token);
        }

        // Update each sentence background and token colors
        for (const [key, tokens] of sentenceMap) {
            const peakScore = Math.max(...tokens.map(t => t.attention_score));
            const [turnId, sentenceId, role] = key.split('-');

            // Find sentence element
            const turnEl = this.container.querySelector(
                `.attention-turn[data-turn-id="${turnId}"][data-role="${role}"]`
            );
            if (turnEl) {
                const sentenceEl = turnEl.querySelector(`.sentence[data-sentence-id="${sentenceId}"]`);
                if (sentenceEl) {
                    sentenceEl.style.backgroundColor = this._getColorForScore(peakScore);
                }
            }

            // Update individual token text colors
            for (const token of tokens) {
                const span = this.container.querySelector(`span[data-position="${token.position}"]`);
                if (span) {
                    span.style.color = this._getTextColorForScore(token.attention_score);
                    const historyStr = token.attention_history ? token.attention_history.map(v => v.toFixed(3)).join(', ') : 'none';
                    span.title = `Position: ${token.position}\nScore: ${token.attention_score.toFixed(2)}\nPeak: ${token.peak_attention.toFixed(2)}\nRaw: ${token.raw_attention.toFixed(4)}\nHistory: [${historyStr}]`;
                }
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
     * Get background color for attention score (RAW LOGITS)
     * @param {number} score - Raw attention score (can be negative!)
     * @returns {string} CSS color
     *
     * Color scale for raw logits (typical range: -100 to +100):
     * - Very negative (<-10): Very dark blue (almost black) - "dead" tokens
     * - Negative (-10 to 0): Dark blue to gray - "fading" tokens
     * - Neutral (0): Gray - baseline
     * - Positive (0 to +10): Gray to cyan - "lit" tokens
     * - Very positive (>10): Cyan to white - "bright" tokens
     *
     * This is tunable after observing real data!
     */
    _getColorForScore(score) {
        // Map raw logits to color scale
        // We'll use a range of [-20, +20] mapped to [0, 1] for color interpolation
        // This is adjustable based on observed data
        const minLogit = -20;
        const maxLogit = 20;

        // Normalize to [0, 1] for color mapping
        let normalized = (score - minLogit) / (maxLogit - minLogit);
        normalized = Math.max(0.0, Math.min(1.0, normalized)); // Clamp for color only

        // Interpolate from dark (negative attention) to bright (positive attention)
        // Very dark blue -> dark blue -> cyan -> white
        if (normalized < 0.5) {
            // 0.0 -> 0.5: very dark blue (#000a1f) to dark blue (#001f3f) to gray-blue (#4080a0)
            const t = normalized * 2;
            const r = Math.round(0 + t * 64);
            const g = Math.round(10 + t * 118);
            const b = Math.round(31 + t * 129);
            return `rgb(${r}, ${g}, ${b})`;
        } else {
            // 0.5 -> 1.0: gray-blue (#4080a0) to cyan (#7fdbff) to white (#ffffff)
            const t = (normalized - 0.5) * 2;
            const r = Math.round(64 + t * 191);
            const g = Math.round(128 + t * 127);
            const b = Math.round(160 + t * 95);
            return `rgb(${r}, ${g}, ${b})`;
        }
    }

    /**
     * Get text color for individual token brightness
     * @param {number} score - Raw attention score (can be very large or negative)
     * @returns {string} CSS color
     *
     * Text brightness scale:
     * - Very negative (<-50): Dark gray (#404040) - "forgotten" tokens
     * - Negative (-50 to 0): Gray to light gray - "fading" tokens
     * - Neutral (0): Medium light gray (#b0b0b0) - baseline
     * - Positive (0 to +50): Light gray to white - "lit" tokens
     * - Very positive (>50): Bright white (#ffffff) - "bright" tokens
     */
    _getTextColorForScore(score) {
        // Map score to brightness range [-100, +100] → [0, 1]
        const minScore = -100;
        const maxScore = 100;
        let normalized = (score - minScore) / (maxScore - minScore);
        normalized = Math.max(0.0, Math.min(1.0, normalized)); // Clamp for color only

        // Interpolate from dark gray to white
        if (normalized < 0.5) {
            // 0.0 -> 0.5: dark gray (#404040) to medium gray (#808080)
            const t = normalized * 2;
            const gray = Math.round(64 + t * 64);
            return `rgb(${gray}, ${gray}, ${gray})`;
        } else {
            // 0.5 -> 1.0: medium gray (#808080) to white (#ffffff)
            const t = (normalized - 0.5) * 2;
            const gray = Math.round(128 + t * 127);
            return `rgb(${gray}, ${gray}, ${gray})`;
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
                    // Show raw logit score (not percentage)
                    const score = token.attention_score.toFixed(2);
                    output += `${token.text}[${score}] `;
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
