/**
 * Renderer - Dual-Layer Brightness Visualization
 * 
 * Two-layer visual hierarchy:
 * - Sentence background: yellow glow based on peak brightness
 * - Token text: white for bright tokens, gray for dim
 * 
 * This makes important sentences visible at a glance while
 * still highlighting the specific tokens getting attention.
 */

export class Renderer {
    constructor(containerElement) {
        this.container = containerElement;
        this.turnElements = new Map();      // turn_id -> DOM element
        this.sentenceElements = new Map();  // "turn_id:sentence_id" -> DOM element
        this.tokenElements = new Map();     // position -> DOM element (O(1) lookup)
        this.lastBrightness = new Map();    // position -> last rendered brightness
        this.lastParagraphPeak = new Map(); // "turn_id:sentence_id" -> last peak brightness
        this.pendingUpdate = false;         // Coalesce updates with rAF
        this.onPinToggle = null;            // Callback: (turnId, sentenceId, role) => newPinnedState
        this.onMerge = null;                // Callback: (turnId, sentenceId, role) => void
    }

    /**
     * Full rebuild of the display from conversation state
     * @param {Conversation} conversation
     */
    rebuild(conversation) {
        this.container.innerHTML = '';
        this.turnElements.clear();
        this.sentenceElements.clear();
        this.tokenElements.clear();
        this.lastBrightness.clear();
        this.lastParagraphPeak.clear();

        const sentences = conversation.getSentences();

        // Get brightness range for dynamic scaling
        const stats = conversation.getStats();

        // Use brightnessFloor (rolling average of pruned chunks) if available
        // Otherwise fall back to actual minimum
        const minB = stats.brightnessFloor !== null
            ? stats.brightnessFloor
            : stats.minBrightness;
        const maxB = stats.maxBrightness;

        for (const sentence of sentences) {
            this._ensureTurnElement(sentence.turn_id, sentence.role);
            this._renderSentence(sentence, conversation, { minBrightness: minB, maxBrightness: maxB });
        }
    }

    /**
     * Update colors for all visible tokens (debounced with rAF)
     * Only updates tokens whose visual appearance has actually changed
     * @param {Conversation} conversation
     * @param {Object} options - Optional brightness range for dynamic scaling
     * @param {number} options.minBrightness - Minimum brightness in active context
     * @param {number} options.maxBrightness - Maximum brightness in active context
     */
    updateColors(conversation, options = {}) {
        // Store conversation and options for rAF callback
        this._pendingConversation = conversation;
        this._pendingOptions = options;

        // Coalesce multiple calls per frame
        if (this.pendingUpdate) return;
        this.pendingUpdate = true;

        requestAnimationFrame(() => {
            this._doUpdateColors(this._pendingConversation, this._pendingOptions);
            this.pendingUpdate = false;
        });
    }

    /**
     * Actual color update logic - only updates changed tokens
     * @param {Conversation} conversation
     * @param {Object} options - Brightness range for dynamic scaling
     */
    _doUpdateColors(conversation, options = {}) {
        const sentences = conversation.getSentences();

        // Get brightness range for dynamic scaling
        // If not provided, fall back to stats calculation
        let minB = options.minBrightness;
        let maxB = options.maxBrightness;

        if (minB === undefined || maxB === undefined) {
            const stats = conversation.getStats();

            // Use brightnessFloor (rolling average of pruned chunks) if available
            // Otherwise fall back to actual minimum
            minB = stats.brightnessFloor !== null
                ? stats.brightnessFloor
                : stats.minBrightness;
            maxB = stats.maxBrightness;
        }

        for (let s = 0; s < sentences.length; s++) {
            const sentence = sentences[s];
            if (sentence.fullyDeleted) continue;

            // peakBrightness already computed by getSentences()
            const peakBrightness = sentence.peakBrightness;
            if (peakBrightness === -Infinity) continue;  // No active tokens

            // Numeric key matching conversation.js format
            const roleNum = { system: 0, user: 1, assistant: 2 };
            const sentenceKey = sentence.turn_id * 1000000 + sentence.sentence_id * 10 + (roleNum[sentence.role] || 0);

            // Check if paragraph peak changed (affects all non-bright tokens)
            const lastPeak = this.lastParagraphPeak.get(sentenceKey);
            const peakChanged = lastPeak !== peakBrightness;
            if (peakChanged) {
                this.lastParagraphPeak.set(sentenceKey, peakBrightness);
            }

            const paragraphColor = this._brightnessToYellow(peakBrightness, minB, maxB);
            
            for (const token of sentence.tokens) {
                const el = this.tokenElements.get(token.position);
                if (!el) continue;

                if (token.deleted) {
                    if (!el.classList.contains('deleted')) {
                        el.classList.add('deleted');
                    }
                    continue;
                }

                // Tool result tokens keep their distinctive cyan color
                // Check both the flag and text markers for robustness
                const isToolToken = token.isToolResult || this._isToolMarkerToken(token.text);
                if (isToolToken) {
                    this._applyToolTokenStyling(el);
                    continue;
                }

                const currentB = token.brightness;

                // Calculate brightness threshold for "bright" tokens (top 20% of range)
                const brightThreshold = minB + (maxB - minB) * 0.8;
                const isBright = currentB >= brightThreshold;

                // No skip optimization - always update colors
                // (Optimization was skipping updates when global min/max range changed)

                this.lastBrightness.set(token.position, currentB);

                // Bright tokens (top 20%) get white text + yellow background
                if (isBright) {
                    el.style.color = '#ffffff';
                    // Alpha based on position within top 20% (0.2 to 0.5)
                    const topRangeSize = maxB - brightThreshold;
                    const positionInTopRange = topRangeSize > 0 ? (currentB - brightThreshold) / topRangeSize : 1;
                    const highlightAlpha = 0.2 + positionInTopRange * 0.3;
                    el.style.backgroundColor = `rgba(255, 200, 50, ${highlightAlpha.toFixed(3)})`;
                } else {
                    // Normal tokens get paragraph yellow shade
                    el.style.color = paragraphColor;
                    el.style.backgroundColor = 'transparent';
                }
            }
        }
    }

    /**
     * Add a single streaming token to the display
     * @param {Object} token - Token object from conversation
     * @param {Conversation} conversation
     */
    addToken(token, conversation) {
        this._ensureTurnElement(token.turn_id, token.role);
        const sentenceEl = this._ensureSentenceElement(token.turn_id, token.sentence_id, token.role);

        const span = document.createElement('span');
        span.className = 'token';
        span.dataset.position = token.position;
        span.textContent = token.text;

        // Tool result tokens get distinctive cyan color
        const isToolToken = token.isToolResult || this._isToolMarkerToken(token.text);
        if (isToolToken) {
            span.classList.add('tool-result-token');
            this._applyToolTokenStyling(span);
            span.title = `pos:${token.position} b:${token.brightness} [tool]`;
        } else {
            span.style.color = this._brightnessToYellow(token.brightness);
            span.title = `pos:${token.position} b:${token.brightness}`;
        }

        sentenceEl.appendChild(span);
        this.tokenElements.set(token.position, span);  // Cache for O(1) lookup
    }

    /**
     * Ensure turn container exists
     */
    _ensureTurnElement(turnId, role) {
        if (this.turnElements.has(turnId)) return;
        
        const div = document.createElement('div');
        div.className = `turn turn-${role}`;
        div.dataset.turnId = turnId;
        
        // Role label
        const label = document.createElement('div');
        label.className = 'turn-label';
        label.textContent = role === 'system' ? '⚙️ System' :
                           role === 'user' ? '👤 User' : '🤖 Assistant';
        div.appendChild(label);
        
        this.container.appendChild(div);
        this.turnElements.set(turnId, div);
    }

    /**
     * Ensure sentence container exists within turn
     */
    _ensureSentenceElement(turnId, sentenceId, role = 'assistant') {
        const roleNum = { system: 0, user: 1, assistant: 2 };
        const key = turnId * 1000000 + sentenceId * 10 + (roleNum[role] || 0);
        if (this.sentenceElements.has(key)) {
            return this.sentenceElements.get(key);
        }
        
        const turnEl = this.turnElements.get(turnId);
        if (!turnEl) return null;
        
        const span = document.createElement('span');
        span.className = 'sentence';
        span.dataset.turnId = turnId;
        span.dataset.sentenceId = sentenceId;
        span.dataset.role = role;
        
        // Add chunk separator for all but first chunk in turn
        if (sentenceId > 0) {
            span.classList.add('chunk-boundary');
            
            // Add merge button on the boundary line
            const mergeBtn = document.createElement('button');
            mergeBtn.className = 'merge-btn';
            mergeBtn.textContent = '➕';
            mergeBtn.title = 'Merge this chunk into the previous chunk';
            mergeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.onMerge) {
                    this.onMerge(
                        parseInt(span.dataset.turnId),
                        parseInt(span.dataset.sentenceId),
                        span.dataset.role
                    );
                }
            });
            span.appendChild(mergeBtn);
        }
        
        // Add pin button
        const pinBtn = document.createElement('button');
        pinBtn.className = 'pin-btn';
        pinBtn.textContent = '📌';
        pinBtn.title = 'Pin/unpin this chunk (immune to pruning)';
        pinBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.onPinToggle) {
                const isPinned = this.onPinToggle(
                    parseInt(span.dataset.turnId),
                    parseInt(span.dataset.sentenceId),
                    span.dataset.role
                );
                span.classList.toggle('pinned', isPinned);
            }
        });
        span.appendChild(pinBtn);

        // Add delete button
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-btn';
        deleteBtn.textContent = '❌';
        deleteBtn.title = 'Delete chunk from search index';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.onDelete) {
                this.onDelete(
                    parseInt(span.dataset.turnId),
                    parseInt(span.dataset.sentenceId),
                    span.dataset.role
                );
            }
        });
        span.appendChild(deleteBtn);

        turnEl.appendChild(span);
        this.sentenceElements.set(key, span);
        return span;
    }

    /**
     * Render a paragraph - all tokens same yellow shade, bright tokens highlighted
     * @param {Object} sentence - Sentence object from getSentences()
     * @param {Conversation} conversation - Conversation instance
     * @param {Object} options - Brightness range for dynamic scaling
     * @param {number} options.minBrightness - Minimum brightness in displayed context
     * @param {number} options.maxBrightness - Maximum brightness in displayed context
     */
    _renderSentence(sentence, conversation, options = {}) {
        const turnEl = this.turnElements.get(sentence.turn_id);
        if (!turnEl) return;

        // Create sentence container
        const sentenceEl = this._ensureSentenceElement(sentence.turn_id, sentence.sentence_id, sentence.role);
        if (!sentenceEl) return;

        if (sentence.fullyDeleted) {
            sentenceEl.classList.add('deleted');
        }

        // Set pinned state
        sentenceEl.classList.toggle('pinned', sentence.pinned);

        // Use peakBrightness for active sentences, 0 for deleted (darkest)
        const peakBrightness = sentence.fullyDeleted
            ? 0
            : (sentence.peakBrightness !== -Infinity ? sentence.peakBrightness : 10000);

        // Get brightness range for scaling
        const minB = options.minBrightness !== undefined ? options.minBrightness : 0;
        const maxB = options.maxBrightness !== undefined ? options.maxBrightness : 10000;

        const paragraphColor = this._brightnessToYellow(peakBrightness, minB, maxB);

        // Calculate dynamic bright threshold (top 20% of range) - same algorithm as _doUpdateColors
        const brightThreshold = minB + (maxB - minB) * 0.8;

        // Render tokens
        for (const token of sentence.tokens) {
            const span = document.createElement('span');
            span.className = 'token' + (token.deleted ? ' deleted' : '');
            span.dataset.position = token.position;
            span.textContent = token.text;

            // Tool result tokens get distinctive cyan color
            const isToolToken = token.isToolResult || this._isToolMarkerToken(token.text);
            if (isToolToken) {
                this._applyToolTokenStyling(span);
                span.title = `pos:${token.position} b:${token.brightness} [tool]`;
            } else {
                const isBright = token.brightness >= brightThreshold;

                if (isBright) {
                    // Bright tokens (top 20%) get white text + yellow background
                    span.style.color = '#ffffff';
                    // Alpha based on position within top 20% (0.2 to 0.5) - same as _doUpdateColors
                    const topRangeSize = maxB - brightThreshold;
                    const positionInTopRange = topRangeSize > 0 ? (token.brightness - brightThreshold) / topRangeSize : 1;
                    const highlightAlpha = 0.2 + positionInTopRange * 0.3;
                    span.style.backgroundColor = `rgba(255, 200, 50, ${highlightAlpha.toFixed(3)})`;
                } else {
                    // Normal tokens get paragraph yellow shade
                    span.style.color = paragraphColor;
                    span.style.backgroundColor = 'transparent';
                }
                span.title = `pos:${token.position} b:${token.brightness}`;
            }

            sentenceEl.appendChild(span);
            this.tokenElements.set(token.position, span);  // Cache for O(1) lookup
        }
    }

    /**
     * Convert brightness to yellow text color using dynamic scale
     * Maps min→max brightness to dim olive → bright gold gradient
     * @param {number} brightness - Brightness score
     * @param {number} minBrightness - Minimum brightness in context (darkest)
     * @param {number} maxBrightness - Maximum brightness in context (brightest)
     * @returns {string} CSS color string
     */
    _brightnessToYellow(brightness, minBrightness, maxBrightness) {
        // Handle edge cases
        if (minBrightness === maxBrightness) {
            // All tokens have same brightness - use medium yellow
            return 'rgb(200, 180, 80)';
        }

        // Normalize brightness to 0-1 range based on actual min/max
        const range = maxBrightness - minBrightness;
        const normalized = Math.max(0, Math.min(1, (brightness - minBrightness) / range));

        // Map to color gradient:
        // 0.0 (min) -> dim olive   (100, 90, 40)
        // 0.5 (mid) -> medium yellow (200, 180, 80)
        // 1.0 (max) -> bright gold  (255, 220, 100)

        let r, g, blue;

        if (normalized <= 0.5) {
            // 0.0-0.5: olive to medium yellow
            const t = normalized * 2;  // 0→1
            r = Math.round(100 + t * 100);   // 100 → 200
            g = Math.round(90 + t * 90);     // 90 → 180
            blue = Math.round(40 + t * 40);  // 40 → 80
        } else {
            // 0.5-1.0: medium yellow to bright gold
            const t = (normalized - 0.5) * 2;  // 0→1
            r = Math.round(200 + t * 55);    // 200 → 255
            g = Math.round(180 + t * 40);    // 180 → 220
            blue = Math.round(80 + t * 20);  // 80 → 100
        }

        return `rgb(${r}, ${g}, ${blue})`;
    }

    /**
     * Check if token text contains tool markers
     * Used for text-based detection that survives import/export
     * Markers: ⚙️ 【 】 → ✓ ❌
     */
    _isToolMarkerToken(text) {
        // Check for the distinctive markers we use
        return /[⚙️【】→✓❌]/.test(text);
    }

    /**
     * Apply tool token styling (cyan color + subtle background)
     * Used by _doUpdateColors, addToken, and _renderSentence
     */
    _applyToolTokenStyling(el) {
        el.style.color = '#4ecdc4';
        el.style.backgroundColor = 'rgba(78, 205, 196, 0.1)';
    }

    /**
     * Clear the display
     */
    clear() {
        this.container.innerHTML = '';
        this.turnElements.clear();
        this.sentenceElements.clear();
        this.tokenElements.clear();
        this.lastBrightness.clear();
        this.lastParagraphPeak.clear();
    }
}
