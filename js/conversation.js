/**
 * Conversation - Token Storage + Magnitude Voting v3
 *
 * Single source of truth for conversation history with integrated brightness scoring.
 *
 * Algorithm (per generation step):
 * 1. Aggregate attention across layers/heads
 * 2. Find attention sink dynamically (max attention token - varies by model)
 * 3. Calculate threshold excluding sink: (1.0 - sink_attention) / (context_len - 1)
 * 4. Calculate mean brightness across all active tokens
 * 5. For each token:
 *    - If attention > threshold: score += int(attention / threshold), cap at 10000
 *    - If attention <= threshold: score -= 1
 * 6. New tokens start at 10000 (fail-bright)
 * 7. Resurrected tokens start at mean brightness (unproven but relevant)
 * 8. No floor - scores can go negative
 *
 * Pruning: while (activeTokenCount > budget) { delete lowest peak brightness sentence }
 */

export class Conversation {
    constructor(options = {}) {
        // Master token list - soft delete only
        this.tokens = [];

        // Persistent storage
        this.store = options.store || null;  // PersistentStore instance

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

        // === VISUALIZATION: Dynamic pruning threshold ===
        // Rolling average of pruned chunk brightness levels
        // Updated when chunks are selected for pruning (not just when actually pruned)
        // Formula: brightnessFloor = (brightnessFloor + selectedPeakBrightness) / 2
        this.brightnessFloor = null;

        // === Mean brightness tracking ===
        // Updated during brightness scoring, used for resurrection
        this.meanBrightness = 5000;  // Default for theoretical empty-context case

        // === System Prompt (External to conversation) ===
        // Stored separately, prepended at generation time, never pruned
        // Can grow/shrink dynamically when tools update notes
        this.systemPromptTokens = [];  // Array of {token_id, text}
        this.systemPromptText = '';    // Raw text for reference
    }

    // ========== Token Management ==========

    /**
     * Load all live tokens from IndexedDB into memory
     * Called on app startup to rehydrate the conversation
     */
    async loadAllLiveTokensFromStore() {
        if (!this.store) return;

        console.log('📥 Loading all live tokens from IndexedDB...');
        const allTokens = await this.store.getAllLiveTokens();

        // Sort by position
        allTokens.sort((a, b) => a.position - b.position);

        // MIGRATION: Filter out old ST0 tokens (turn_id=0, role='system')
        // System prompt is now stored separately in metadata.systemPromptTokens
        const conversationTokens = allTokens.filter(t =>
            !(t.turn_id === 0 && t.role === 'system')
        );

        const migratedCount = allTokens.length - conversationTokens.length;
        if (migratedCount > 0) {
            console.log(`📥 Migrated: filtered out ${migratedCount} old ST0 tokens`);
            // Mark old ST0 tokens as deleted so they don't reappear
            for (const token of allTokens) {
                if (token.turn_id === 0 && token.role === 'system') {
                    token.deleted = true;
                    await this.store.saveToken(token);
                }
            }
        }

        // Replace in-memory tokens with conversation tokens only
        this.tokens = conversationTokens;

        // Update nextPosition if needed
        if (this.tokens.length > 0) {
            const maxPos = this.tokens[this.tokens.length - 1].position;
            if (maxPos >= this.nextPosition) {
                this.nextPosition = maxPos + 1;
            }
        }

        this._invalidateCache();

        console.log(`📥 Loaded ${conversationTokens.length} live tokens`);
    }

    /**
     * Load tokens from IndexedDB by position IDs
     * Used during resurrection to populate in-memory token list
     * @param {Array<number>} positions - Position IDs to load
     */
    async loadTokensFromStore(positions) {
        if (!this.store || positions.length === 0) return;

        // Load tokens in parallel
        const promises = positions.map(pos => this.store.getToken(pos));
        const tokens = await Promise.all(promises);

        // Add to in-memory list (skip nulls)
        for (const token of tokens) {
            if (token && !this.tokens.find(t => t.position === token.position)) {
                this.tokens.push(token);
            }
        }

        // Sort by position to maintain order
        this.tokens.sort((a, b) => a.position - b.position);

        // Update nextPosition if needed
        if (this.tokens.length > 0) {
            const maxPos = this.tokens[this.tokens.length - 1].position;
            if (maxPos >= this.nextPosition) {
                this.nextPosition = maxPos + 1;
            }
        }

        this._invalidateCache();
    }

    /**
     * Load metadata from IndexedDB and restore state
     */
    async loadMetadataFromStore() {
        if (!this.store) return;

        const metadata = await this.store.getMetadata();

        this.nextPosition = metadata.nextPosition || 0;
        this.currentTurnId = metadata.nextTurn || 0;
        this.currentSentenceId = metadata.currentSentence || 0;
        this.currentRole = metadata.currentRole || null;

        // Load system prompt if stored
        if (metadata.systemPromptTokens) {
            this.systemPromptTokens = metadata.systemPromptTokens;
            this.systemPromptText = metadata.systemPromptText || '';
            console.log(`📝 Loaded system prompt: ${this.systemPromptTokens.length} tokens`);
        }

        console.log(`📝 Loaded metadata: position=${this.nextPosition}, turn=${this.currentTurnId}`);
    }

    /**
     * Save metadata to IndexedDB
     */
    async saveMetadataToStore() {
        if (!this.store) return;

        await this.store.saveMetadata({
            nextPosition: this.nextPosition,
            nextTurn: this.currentTurnId,
            currentSentence: this.currentSentenceId,
            currentRole: this.currentRole,
            // System prompt stored separately from conversation tokens
            systemPromptTokens: this.systemPromptTokens,
            systemPromptText: this.systemPromptText
        });
    }

    /**
     * Add a message (multiple tokens) to the conversation
     * @param {string} role - "system", "user", or "assistant"
     * @param {Array} tokens - Array of {token_id, text} from tokenizer
     * @param {Object} options - Options for persistence
     * @param {boolean} options.waitForPersist - If true, await database persistence (default: false)
     */
    async addMessage(role, tokens, options = {}) {
        this.currentRole = role;
        this.currentSentenceId = 0;

        for (const token of tokens) {
            await this._addToken(token.token_id, token.text, options);
        }
    }

    /**
     * Add a single streaming token during generation
     * Fire-and-forget persistence for speed (DB writes async in background)
     * @param {number} tokenId - Token ID
     * @param {string} text - Token text
     * @param {Object} options - Optional settings
     * @param {number} options.sentenceIdOverride - Force specific sentence_id (for tool results)
     * @param {boolean} options.skipBoundaryDetection - Skip boundary detection (for metadata tokens)
     * @param {boolean} options.isToolResult - Mark token as tool result
     * @returns {Object} The created token (synchronously for rendering)
     */
    addStreamingToken(tokenId, text, options = {}) {
        // Use override if provided, otherwise current sentence
        const sentenceId = options.sentenceIdOverride ?? this.currentSentenceId;

        const token = {
            token_id: tokenId,
            text: text,
            position: this.nextPosition++,
            brightness: 10000,  // Fail-bright: start high, prove relevance or decay
            turn_id: this.currentTurnId,
            role: this.currentRole,
            sentence_id: sentenceId,
            deleted: false,
            pinned: false,
            isToolResult: options.isToolResult || false
        };

        this.tokens.push(token);

        // Fire-and-forget persistence (don't block streaming)
        if (this.store) {
            this.store.saveToken(token).catch(err => {
                console.warn('Failed to persist streaming token:', err);
            });
        }

        // Update cache
        if (this._activeTokensCache !== null) {
            this._activeTokensCache.push(token);
            this._activeTokenCount++;
        }

        // Detect sentence boundaries (skip for metadata tokens like tool results)
        if (!options.skipBoundaryDetection) {
            this._updateSentenceBoundary(text);
        }

        return token;
    }

    /**
     * Internal: Add a single token
     * @param {boolean} options.waitForPersist - If true, await database persistence (default: false for streaming performance)
     */
    async _addToken(tokenId, text, options = {}) {
        const sentenceId = this.currentSentenceId;

        const token = {
            token_id: tokenId,
            text: text,
            position: this.nextPosition++,
            brightness: 10000,  // Fail-bright: start high, prove relevance or decay
            turn_id: this.currentTurnId,
            role: this.currentRole,
            sentence_id: sentenceId,
            deleted: false,
            pinned: false
        };

        this.tokens.push(token);

        // Persist to IndexedDB
        if (this.store) {
            if (options.waitForPersist) {
                // Block until persistence completes (for critical writes like user messages)
                await this.store.saveToken(token);
            } else {
                // Fire-and-forget for streaming performance
                this.store.saveToken(token).catch(err => {
                    console.warn('Failed to persist token:', err);
                });
            }
        }

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
        // Prepend system prompt tokens, then conversation tokens
        const sysIds = this.systemPromptTokens.map(t => t.token_id);
        const convIds = this.getActiveTokens().map(t => t.token_id);
        return [...sysIds, ...convIds];
    }

    /**
     * Get the length of the system prompt in tokens
     * Used for attention index offset mapping
     */
    getSystemPromptLength() {
        return this.systemPromptTokens.length;
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
        // Build active token list (conversation tokens only, no system prompt)
        const activeTokens = [];
        for (let i = 0; i < this.tokens.length; i++) {
            if (!this.tokens[i].deleted) {
                activeTokens.push(this.tokens[i]);
            }
        }

        const convLen = activeTokens.length;
        if (convLen < 1) return;  // Need at least 1 conversation token

        // System prompt offset: attention indices 0..sysLen-1 are system tokens (ignored)
        // Conversation tokens map to attention indices sysLen..sysLen+convLen-1
        const sysLen = this.systemPromptTokens.length;

        // Use pre-aggregated data if available, otherwise aggregate client-side
        const aggregated = attention.preAggregated
            ? attention.data
            : this._aggregateAttention(attention);

        // Total context includes system prompt
        const totalLen = sysLen + convLen;

        // Find attention sink dynamically (highest attention token)
        // Different models use different tokens as sinks - can't assume index 0
        let sinkAttention = 0;
        for (let i = 0; i < aggregated.length; i++) {
            if (aggregated[i] > sinkAttention) {
                sinkAttention = aggregated[i];
            }
        }

        // Threshold = average attention excluding the sink
        const threshold = (1.0 - sinkAttention) / (totalLen - 1);

        // Skip if threshold is invalid
        if (threshold <= 0 || !isFinite(threshold)) return;

        // Calculate mean brightness across all active conversation tokens
        let brightnessSum = 0;
        let brightnessCount = 0;

        for (let i = 0; i < this.tokens.length; i++) {
            const token = this.tokens[i];
            if (!token.deleted) {
                brightnessSum += token.brightness;
                brightnessCount++;
            }
        }

        // Update mean (should always have brightnessCount > 0 in practice)
        this.meanBrightness = brightnessCount > 0 ? Math.floor(brightnessSum / brightnessCount) : 5000;

        // Update scores for conversation tokens
        // activeTokens[i] maps to aggregated[sysLen + i]
        for (let i = 0; i < convLen; i++) {
            const attentionIndex = sysLen + i;
            if (attentionIndex >= aggregated.length) break;

            const token = activeTokens[i];
            const att = aggregated[attentionIndex];

            if (att > threshold) {
                // Strong reference: +ratio (e.g., 6.5x threshold → +6)
                token.brightness += (att / threshold) | 0;  // Faster than Math.floor
                // Cap at 10000 to prevent runaway scores
                if (token.brightness > 10000) token.brightness = 10000;
            } else {
                // Weak/no reference: flat -1 decay
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
     * Check if a sentence is an S0 anchor and if it's protected from pruning
     *
     * Anchor Protection Rule:
     * - S0 chunks are conversation anchors (opening of each turn)
     * - For turn pairs (User Turn N → Assistant Turn N+1):
     *   - UT_N S0 and AT_(N+1) S0 form an anchor pair
     * - Anchors can ONLY be pruned when:
     *   1. The anchor is the ONLY remaining chunk from its turn
     *   2. Its paired anchor is ALSO the only remaining chunk from its turn
     *   3. They prune together (atomically)
     *
     * This ensures any surviving chunk has conversational context.
     */
    _isAnchorProtected(sentence, sentences) {
        // Only S0 chunks are anchors
        if (sentence.sentence_id !== 0) return false;

        // Check if this is the only remaining chunk from this turn
        const turnChunks = sentences.filter(s =>
            s.turn_id === sentence.turn_id &&
            s.role === sentence.role &&
            !s.fullyDeleted
        );

        if (turnChunks.length > 1) {
            // Not the only chunk - anchor is protected
            return true;
        }

        // This anchor is the only chunk from its turn
        // Check if paired anchor exists and is also the only chunk

        let pairedTurnId, pairedRole;

        if (sentence.role === 'user') {
            // User S0 pairs with Assistant S0 from next turn
            pairedTurnId = sentence.turn_id + 1;
            pairedRole = 'assistant';
        } else if (sentence.role === 'assistant') {
            // Assistant S0 pairs with User S0 from previous turn
            pairedTurnId = sentence.turn_id - 1;
            pairedRole = 'user';
        } else {
            // System messages have no pair
            return false;
        }

        // Find the paired anchor
        const pairedAnchor = sentences.find(s =>
            s.turn_id === pairedTurnId &&
            s.sentence_id === 0 &&
            s.role === pairedRole &&
            !s.fullyDeleted
        );

        if (!pairedAnchor) {
            // No paired anchor exists (already deleted or doesn't exist)
            return false;
        }

        // Check if paired anchor is also the only chunk from its turn
        const pairedTurnChunks = sentences.filter(s =>
            s.turn_id === pairedTurnId &&
            s.role === pairedRole &&
            !s.fullyDeleted
        );

        if (pairedTurnChunks.length > 1) {
            // Paired anchor has siblings - both are protected
            return true;
        }

        // Both anchors are solo - can be pruned together
        return false;
    }

    /**
     * Prune lowest brightness sentences until under token budget
     * Implements anchor protection: S0 chunks from turn pairs must be pruned together
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

                // Skip anchor-protected sentences
                if (this._isAnchorProtected(s, sentences)) continue;

                prunableSentenceCount++;

                if (s.peakBrightness < lowestPeak) {
                    lowestPeak = s.peakBrightness;
                    lowestSentence = s;
                }
            }

            // Keep at least one prunable sentence
            if (prunableSentenceCount <= 1) break;

            if (lowestSentence) {
                // Update brightness floor with rolling average
                // This smooths out variations and tracks the overall pruning trend
                if (this.brightnessFloor === null) {
                    this.brightnessFloor = lowestSentence.peakBrightness;
                } else {
                    this.brightnessFloor = (this.brightnessFloor + lowestSentence.peakBrightness) / 2;
                }

                // Check if this is an anchor that needs to be pruned with its pair
                if (lowestSentence.sentence_id === 0 && (lowestSentence.role === 'user' || lowestSentence.role === 'assistant')) {
                    // Find paired anchor and prune both together
                    const pairedTurnId = lowestSentence.role === 'user'
                        ? lowestSentence.turn_id + 1
                        : lowestSentence.turn_id - 1;
                    const pairedRole = lowestSentence.role === 'user' ? 'assistant' : 'user';

                    const pairedAnchor = sentences.find(s =>
                        s.turn_id === pairedTurnId &&
                        s.sentence_id === 0 &&
                        s.role === pairedRole &&
                        !s.fullyDeleted
                    );

                    if (pairedAnchor) {
                        // Prune both anchors atomically
                        this._deleteSentence(lowestSentence);
                        this._deleteSentence(pairedAnchor);
                        prunedSentences.push(lowestSentence, pairedAnchor);
                        console.log(`🔗 Pruned anchor pair: ${lowestSentence.role} turn ${lowestSentence.turn_id} + ${pairedAnchor.role} turn ${pairedAnchor.turn_id}`);
                    } else {
                        // Paired anchor doesn't exist, prune solo
                        this._deleteSentence(lowestSentence);
                        prunedSentences.push(lowestSentence);
                    }
                } else {
                    // Regular chunk, prune normally
                    this._deleteSentence(lowestSentence);
                    prunedSentences.push(lowestSentence);
                }
            } else {
                break;
            }
        }

        return prunedSentences;
    }
    
    /**
     * Resurrect a sentence from the graveyard (legacy - by position IDs)
     * Semantic resurrection: preserve earned brightness (no gifts)
     * @param {Array<number>} tokenPositions - Position IDs of tokens to resurrect
     */
    resurrect(tokenPositions) {
        const positionSet = new Set(tokenPositions);
        let resurrectedCount = 0;

        // Group by chunk for efficient DB operations
        const chunks = new Map(); // key: turn_sentence_role → {turn_id, sentence_id, role, tokens}

        for (const token of this.tokens) {
            if (positionSet.has(token.position) && token.deleted) {
                token.deleted = false;
                // Semantic resurrection: keep earned brightness (token already has brightness_at_deletion)
                // Resurrection is just a chance to earn MORE attention, not a boost
                if (token.brightness_at_deletion !== undefined) {
                    token.brightness = token.brightness_at_deletion;
                }
                // If no brightness_at_deletion, keep current brightness (shouldn't happen)
                resurrectedCount++;

                // Collect for chunk-based DB operation
                const key = `${token.turn_id}_${token.sentence_id}_${token.role}`;
                if (!chunks.has(key)) {
                    chunks.set(key, { turn_id: token.turn_id, sentence_id: token.sentence_id, role: token.role });
                }
            }
        }

        // Persist chunk resurrection to IndexedDB (move from dead to live, brightness already preserved)
        if (this.store && chunks.size > 0) {
            for (const chunk of chunks.values()) {
                this.store.resurrectChunk(chunk.turn_id, chunk.sentence_id, chunk.role).catch(err => {
                    console.warn('Failed to persist chunk resurrection:', err);
                });
            }
        }

        if (resurrectedCount > 0) {
            this._invalidateCache();
        }

        return resurrectedCount;
    }
    
    /**
     * Resurrect a chunk by tuple (for semantic index)
     * Semantic resurrection: preserve earned brightness (no gifts)
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
                // Semantic resurrection: keep earned brightness
                // Resurrection is just a chance to earn MORE attention, not a boost
                if (token.brightness_at_deletion !== undefined) {
                    token.brightness = token.brightness_at_deletion;
                }
                // If no brightness_at_deletion, keep current brightness (shouldn't happen)
                resurrectedCount++;
            }
        }

        // Persist chunk resurrection to IndexedDB (move from dead to live, brightness already preserved)
        if (this.store && resurrectedCount > 0) {
            this.store.resurrectChunk(turn_id, sentence_id, role).catch(err => {
                console.warn('Failed to persist chunk resurrection:', err);
            });
        }

        if (resurrectedCount > 0) {
            this._invalidateCache();
        }

        return resurrectedCount;
    }
    
    /**
     * Toggle pinned state for all tokens in a sentence
     * Manual resurrection: starts at 10k (strongest user signal)
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
                // Pinning also resurrects deleted tokens at 10k (strongest signal)
                if (newState && token.deleted) {
                    token.deleted = false;
                    // Manual pin/resurrection: start at 10k (user declared importance)
                    token.brightness = 10000;
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

        // Persist chunk pruning to IndexedDB (move from live to dead)
        if (this.store) {
            this.store.pruneChunk(sentence.turn_id, sentence.sentence_id, sentence.role).catch(err => {
                console.warn('Failed to persist chunk pruning:', err);
            });
        }

        // Invalidate cache after deletion
        this._invalidateCache();
    }

    /**
     * Delete all tokens in a turn (user-initiated deletion)
     * @param {number} turn_id - Turn ID to delete
     * @returns {number} Number of tokens deleted
     */
    deleteTurn(turn_id) {
        let deletedCount = 0;

        for (const token of this.tokens) {
            if (token.turn_id === turn_id && !token.deleted) {
                token.deleted = true;
                token.brightness_at_deletion = token.brightness;
                deletedCount++;
            }
        }

        // Persist to IndexedDB (prune all chunks from this turn)
        if (this.store && deletedCount > 0) {
            const sentences = this.getSentences().filter(s => s.turn_id === turn_id);
            for (const sentence of sentences) {
                this.store.pruneChunk(turn_id, sentence.sentence_id, sentence.role).catch(err => {
                    console.warn('Failed to persist turn deletion:', err);
                });
            }
        }

        // Invalidate cache
        this._invalidateCache();

        return deletedCount;
    }

    /**
     * Reconstruct text from all tokens in a turn
     * @param {number} turn_id - Turn ID
     * @returns {string} Reconstructed text
     */
    reconstructTurnText(turn_id) {
        const turnTokens = this.tokens.filter(t => t.turn_id === turn_id);
        return this.reconstructText(turnTokens);
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
            avgBrightness: Math.round(sum / len),
            brightnessFloor: this.brightnessFloor  // Rolling average visualization floor
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
