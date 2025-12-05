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
        
        for (const sentence of sentences) {
            this._ensureTurnElement(sentence.turn_id, sentence.role);
            this._renderSentence(sentence, conversation);
        }
    }

    /**
     * Update colors for all visible tokens (debounced with rAF)
     * Only updates tokens whose visual appearance has actually changed
     * @param {Conversation} conversation
     */
    updateColors(conversation) {
        // Store conversation for rAF callback
        this._pendingConversation = conversation;
        
        // Coalesce multiple calls per frame
        if (this.pendingUpdate) return;
        this.pendingUpdate = true;
        
        requestAnimationFrame(() => {
            this._doUpdateColors(this._pendingConversation);
            this.pendingUpdate = false;
        });
    }

    /**
     * Actual color update logic - only updates changed tokens
     */
    _doUpdateColors(conversation) {
        const sentences = conversation.getSentences();
        
        for (const sentence of sentences) {
            if (sentence.fullyDeleted) continue;
            
            const activeTokens = sentence.tokens.filter(t => !t.deleted);
            if (activeTokens.length === 0) continue;
            
            const sentenceKey = `${sentence.turn_id}:${sentence.sentence_id}`;
            const peakBrightness = Math.max(...activeTokens.map(t => t.brightness));
            
            // Check if paragraph peak changed (affects all non-bright tokens)
            const lastPeak = this.lastParagraphPeak.get(sentenceKey);
            const peakChanged = lastPeak !== peakBrightness;
            if (peakChanged) {
                this.lastParagraphPeak.set(sentenceKey, peakBrightness);
            }
            
            const paragraphColor = this._brightnessToYellow(peakBrightness);
            
            for (const token of sentence.tokens) {
                const el = this.tokenElements.get(token.position);
                if (!el) continue;
                
                if (token.deleted) {
                    if (!el.classList.contains('deleted')) {
                        el.classList.add('deleted');
                    }
                    continue;
                }
                
                const lastB = this.lastBrightness.get(token.position);
                const currentB = token.brightness;
                
                // Skip if this token's brightness hasn't changed
                // AND the paragraph peak hasn't changed (which affects non-bright tokens)
                const isBright = currentB > 255;
                const wasBright = lastB !== undefined && lastB > 255;
                
                if (lastB === currentB && !peakChanged) continue;
                if (!isBright && !wasBright && !peakChanged) continue;
                
                this.lastBrightness.set(token.position, currentB);
                
                // Bright tokens (above baseline) get white text + yellow background
                if (isBright) {
                    el.style.color = '#ffffff';
                    const highlightAlpha = Math.min(0.5, (currentB - 255) / 1000 * 0.5);
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
        const sentenceEl = this._ensureSentenceElement(token.turn_id, token.sentence_id);
        
        const span = document.createElement('span');
        span.className = 'token';
        span.dataset.position = token.position;
        span.style.color = this._brightnessToYellow(token.brightness);
        span.textContent = token.text;
        span.title = `pos:${token.position} b:${token.brightness}`;
        
        sentenceEl.appendChild(span);
        this.tokenElements.set(token.position, span);  // Cache for O(1) lookup
    }

    /**
     * Mark sentences as deleted (visual fade before removal)
     * @param {Array} sentences - Sentences that were pruned
     */
    markDeleted(sentences) {
        for (const sentence of sentences) {
            for (const token of sentence.tokens) {
                const el = this.tokenElements.get(token.position);
                if (el) {
                    el.classList.add('deleted');
                }
            }
        }
    }

    /**
     * Remove deleted tokens from DOM
     */
    removeDeleted() {
        const deleted = this.container.querySelectorAll('.token.deleted');
        deleted.forEach(el => el.remove());
        
        // Clean up empty turn containers
        this.turnElements.forEach((el, turnId) => {
            if (el.querySelectorAll('.token').length === 0) {
                el.remove();
                this.turnElements.delete(turnId);
            }
        });
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
    _ensureSentenceElement(turnId, sentenceId) {
        const key = `${turnId}:${sentenceId}`;
        if (this.sentenceElements.has(key)) {
            return this.sentenceElements.get(key);
        }
        
        const turnEl = this.turnElements.get(turnId);
        if (!turnEl) return null;
        
        const span = document.createElement('span');
        span.className = 'sentence';
        span.dataset.turnId = turnId;
        span.dataset.sentenceId = sentenceId;
        
        turnEl.appendChild(span);
        this.sentenceElements.set(key, span);
        return span;
    }

    /**
     * Render a paragraph - all tokens same yellow shade, bright tokens highlighted
     */
    _renderSentence(sentence, conversation) {
        const turnEl = this.turnElements.get(sentence.turn_id);
        if (!turnEl) return;
        
        // Create sentence container
        const sentenceEl = this._ensureSentenceElement(sentence.turn_id, sentence.sentence_id);
        if (!sentenceEl) return;
        
        if (sentence.deleted) {
            sentenceEl.classList.add('deleted');
        }
        
        // Calculate peak brightness for paragraph color
        const activeTokens = sentence.tokens.filter(t => !t.deleted);
        const peakBrightness = activeTokens.length > 0 
            ? Math.max(...activeTokens.map(t => t.brightness))
            : 255;
        const paragraphColor = this._brightnessToYellow(peakBrightness);
        
        // Render tokens
        for (const token of sentence.tokens) {
            const span = document.createElement('span');
            span.className = 'token' + (token.deleted ? ' deleted' : '');
            span.dataset.position = token.position;
            span.style.color = paragraphColor;  // All tokens same shade
            span.textContent = token.text;
            span.title = `pos:${token.position} b:${token.brightness}`;
            
            // Bright tokens get white text + yellow background
            if (token.brightness > 255) {
                span.style.color = '#ffffff';  // Override paragraph color
                const highlightAlpha = Math.min(0.5, (token.brightness - 255) / 1000 * 0.5);
                span.style.backgroundColor = `rgba(255, 200, 50, ${highlightAlpha.toFixed(3)})`;
            }
            
            sentenceEl.appendChild(span);
            this.tokenElements.set(token.position, span);  // Cache for O(1) lookup
        }
    }

    /**
     * Convert brightness to yellow text color
     * Dim = dark yellow/olive, bright = golden yellow
     * @param {number} brightness - Brightness score
     * @returns {string} CSS color string
     */
    _brightnessToYellow(brightness) {
        // Map brightness to yellow intensity
        // 0 -> dim olive (100, 90, 40)
        // 255 -> medium yellow (200, 180, 80)
        // 500+ -> bright gold (255, 220, 100)
        
        const b = Math.max(0, brightness);
        
        if (b <= 255) {
            // 0-255: olive to medium yellow
            const t = b / 255;
            const r = Math.round(100 + t * 100);  // 100 -> 200
            const g = Math.round(90 + t * 90);    // 90 -> 180
            const blue = Math.round(40 + t * 40); // 40 -> 80
            return `rgb(${r}, ${g}, ${blue})`;
        } else {
            // 255+: medium yellow to bright gold
            const excess = Math.min(b - 255, 500) / 500;  // Cap at 755
            const r = Math.round(200 + excess * 55);   // 200 -> 255
            const g = Math.round(180 + excess * 40);   // 180 -> 220
            const blue = Math.round(80 + excess * 20); // 80 -> 100
            return `rgb(${r}, ${g}, ${blue})`;
        }
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
