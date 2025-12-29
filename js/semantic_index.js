/**
 * Semantic Index - Append-Only Vector Database for Context Resurrection
 * 
 * Replaces graveyard.js with a fundamentally different approach:
 * - Index ALL chunks on creation (not just pruned ones)
 * - Context-window embeddings (N-1, N, N+1 up to 256 tokens)
 * - Append-only (entries never removed)
 * - Lookup by (turn_id, sentence_id, role) tuple
 * 
 * The semantic index enables resurrection of pruned content when it becomes
 * semantically relevant to new user queries.
 * 
 * Uses a Web Worker for embedding computation to avoid blocking the UI.
 */

// Fallback: main-thread model (used if worker fails)
let embeddingModel = null;

export class SemanticIndex {
    constructor(options = {}) {
        // Append-only entry list (in-memory, backed by IndexedDB)
        this.entries = [];

        // Persistent storage
        this.store = options.store || null;  // PersistentStore instance

        // Configuration
        this.embeddingDim = 384;  // all-MiniLM-L6-v2 output dimension
        this.embeddingContextTokens = options.embeddingContextTokens || 256;
        this.queryMaxResults = options.queryMaxResults || 128;
        this.resurrectionBudget = options.resurrectionBudget || 1024;
        this.userBoost = options.userBoost || 1.5;  // Boost user content in retrieval
        
        // Model loading state
        this.modelLoading = false;
        this.modelReady = false;
        this.modelError = null;
        
        // Stats
        this.totalIndexed = 0;
        this.totalResurrected = 0;
        
        // Timing stats
        this._timing = {
            lastEmbedMs: 0,
            lastQueryMs: 0,
            lastSearchMs: 0,
            totalEmbedMs: 0,
            totalQueryMs: 0,
            embedCount: 0,
            queryCount: 0
        };
        
        // Track which chunks are already indexed (by key)
        this._indexedChunks = new Set();
        
        // Embedding queue for sequential processing
        this._embedQueue = [];
        this._embedProcessing = false;
        
        // Web Worker for off-thread embedding
        this._worker = null;
        this._workerReady = false;
        this._workerPending = new Map();  // id -> {resolve, reject}
        this._nextEmbedId = 0;
        
        // Promise-based worker ready signaling
        this._workerReadyPromise = null;
        this._resolveWorkerReady = null;
        
        // Try to initialize worker
        this._initWorker();
    }
    
    /**
     * Initialize the embedding Web Worker
     */
    _initWorker() {
        try {
            // Get the base URL for the worker script
            const scriptUrl = new URL('./embedding_worker.js', import.meta.url);
            this._worker = new Worker(scriptUrl, { type: 'module' });
            
            // Create promise for worker ready signaling
            this._workerReadyPromise = new Promise((resolve, reject) => {
                this._resolveWorkerReady = resolve;
                // Timeout after 30s
                setTimeout(() => reject(new Error('Worker init timeout')), 30000);
            });
            
            this._worker.onmessage = (event) => {
                const { type, id, embedding, elapsed, error } = event.data;
                
                switch (type) {
                    case 'ready':
                        this._workerReady = true;
                        this.modelReady = true;
                        this._resolveWorkerReady?.();
                        console.log('📚 SemanticIndex: Embedding worker ready');
                        break;
                        
                    case 'embedding':
                        const pending = this._workerPending.get(id);
                        if (pending) {
                            this._workerPending.delete(id);
                            this._timing.lastEmbedMs = elapsed;
                            this._timing.totalEmbedMs += elapsed;
                            this._timing.embedCount++;
                            pending.resolve(embedding);
                        }
                        break;
                        
                    case 'error':
                        console.warn('📚 Worker error:', error);
                        if (id !== undefined) {
                            const p = this._workerPending.get(id);
                            if (p) {
                                this._workerPending.delete(id);
                                p.reject(new Error(error));
                            }
                        }
                        break;
                }
            };
            
            this._worker.onerror = (err) => {
                console.warn('📚 Worker failed, falling back to main thread:', err.message);
                this._worker = null;
            };
            
        } catch (err) {
            console.warn('📚 Could not create worker, using main thread:', err.message);
            this._worker = null;
        }
    }

    // ========== Embedding Pipeline ==========

    /**
     * Initialize the embedding model (lazy load on first use)
     * Falls back to main thread if worker is not available
     */
    async _ensureModel() {
        // If worker is ready, we're good
        if (this._workerReady) return true;
        
        // If worker exists but not ready, wait for it via promise
        if (this._worker && this._workerReadyPromise) {
            try {
                await this._workerReadyPromise;
                return true;
            } catch (err) {
                // Worker failed or timed out, fall through to main thread
                console.warn('📚 Worker init failed:', err.message);
            }
        }
        
        // Fallback to main thread
        if (this.modelReady) return true;
        if (this.modelError) throw this.modelError;
        if (this.modelLoading) {
            while (this.modelLoading) {
                await new Promise(r => setTimeout(r, 100));
            }
            if (this.modelError) throw this.modelError;
            return this.modelReady;
        }

        this.modelLoading = true;
        console.log('📚 SemanticIndex: Loading embedding model (main thread fallback)...');
        
        try {
            const { pipeline: createPipeline } = await import(
                'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1'
            );
            
            embeddingModel = await createPipeline(
                'feature-extraction',
                'Xenova/all-MiniLM-L6-v2',
                { quantized: true }
            );
            
            this.modelReady = true;
            console.log('📚 SemanticIndex: Embedding model ready (main thread)');
            return true;
            
        } catch (err) {
            this.modelError = err;
            console.error('📚 SemanticIndex: Failed to load embedding model:', err);
            throw err;
        } finally {
            this.modelLoading = false;
        }
    }

    /**
     * Embed text into a vector
     * Uses worker if available, falls back to main thread
     * @param {string} text - Text to embed
     * @returns {Promise<Float32Array>} - 384-dimensional embedding
     */
    async embed(text) {
        // Try worker first
        if (this._workerReady && this._worker) {
            return this._embedViaWorker(text);
        }
        
        // Fallback to main thread
        await this._ensureModel();
        
        const t0 = performance.now();
        
        const output = await embeddingModel(text, {
            pooling: 'mean',
            normalize: true
        });
        
        const elapsed = performance.now() - t0;
        this._timing.lastEmbedMs = elapsed;
        this._timing.totalEmbedMs += elapsed;
        this._timing.embedCount++;
        
        return new Float32Array(output.data);
    }
    
    /**
     * Embed via Web Worker (off main thread)
     */
    _embedViaWorker(text) {
        return new Promise((resolve, reject) => {
            const id = this._nextEmbedId++;
            this._workerPending.set(id, { resolve, reject });
            this._worker.postMessage({ type: 'embed', id, text });
        });
    }

    // ========== Chunk Key Utilities ==========

    /**
     * Generate unique key for a chunk
     */
    _chunkKey(turn_id, sentence_id, role) {
        const roleNum = { system: 0, user: 1, assistant: 2 };
        return turn_id * 1000000 + sentence_id * 10 + (roleNum[role] || 0);
    }

    // ========== Core Operations ==========

    /**
     * Index new chunks from the conversation after an exchange completes
     * Uses context-window embedding: includes N-1, N, N+1 chunks up to token budget
     * 
     * @param {Conversation} conversation - The conversation object
     */
    async indexNewChunks(conversation) {
        const sentences = conversation.getSentences();
        const newChunks = [];
        
        // Find chunks not yet indexed
        for (const sentence of sentences) {
            const key = this._chunkKey(sentence.turn_id, sentence.sentence_id, sentence.role);
            if (!this._indexedChunks.has(key)) {
                newChunks.push({ sentence, key });
            }
        }
        
        if (newChunks.length === 0) return;
        
        console.log(`📚 Indexing ${newChunks.length} new chunks...`);
        
        // Build sentence lookup for context window
        const sentenceByKey = new Map();
        for (const s of sentences) {
            sentenceByKey.set(this._chunkKey(s.turn_id, s.sentence_id, s.role), s);
        }
        
        // Index each new chunk with context window
        for (const { sentence, key } of newChunks) {
            const text = conversation.reconstructText(sentence.tokens);
            if (!text || text.trim().length === 0) {
                this._indexedChunks.add(key);  // Mark as indexed even if empty
                continue;
            }
            
            // Build context window for embedding
            const contextText = this._buildContextWindow(sentence, sentences, conversation);
            
            // Create entry
            // Use peakBrightnessAtDeletion if available (pruned chunk),
            // otherwise use current peakBrightness (active chunk, default to 10k if never seen attention)
            const brightness = sentence.peakBrightnessAtDeletion !== null
                ? sentence.peakBrightnessAtDeletion
                : (sentence.peakBrightness === -Infinity ? 10000 : sentence.peakBrightness);

            const entry = {
                turn_id: sentence.turn_id,
                sentence_id: sentence.sentence_id,
                role: sentence.role,
                text: text,
                tokenCount: sentence.tokens.length,
                brightness_at_deletion: brightness,  // Preserve brightness for resurrection
                embedding: null,
                referenceCount: 0
            };
            
            this.entries.push(entry);
            this._indexedChunks.add(key);
            this.totalIndexed++;

            // Queue embedding (processed sequentially to avoid WASM contention)
            this._queueEmbedding(entry, contextText);
        }
    }

    /**
     * Load all semantic entries from IndexedDB into memory
     * Call this on startup to restore the full index
     */
    async loadFromStore() {
        if (!this.store) {
            console.warn('📚 No persistent store configured, skipping load');
            return;
        }

        console.log('📚 Loading semantic index from IndexedDB...');
        const t0 = performance.now();

        const entries = await this.store.getAllSemanticEntries();

        this.entries = entries;
        this._indexedChunks.clear();
        for (const e of entries) {
            this._indexedChunks.add(this._chunkKey(e.turn_id, e.sentence_id, e.role));
        }

        const elapsed = performance.now() - t0;
        console.log(`📚 Loaded ${entries.length} entries in ${elapsed.toFixed(0)}ms`);
    }

    /**
     * Persist a semantic entry to IndexedDB after embedding
     */
    async _persistEntry(entry) {
        if (!this.store || !entry.embedding) return;

        try {
            await this.store.saveSemanticEntry(entry);
        } catch (err) {
            console.warn('📚 Failed to persist entry to IndexedDB:', err);
        }
    }

    /**
     * Build context window for embedding using turn-pair strategy
     *
     * Strategy:
     * - Assistant chunks: embed with user sentence_0 from turn N-1, assistant sentence_0 from turn N
     * - User chunks: embed with user sentence_0 from turn N, assistant sentence_0 from turn N+1
     * - System chunks: embed in isolation
     *
     * This captures conversational structure (Q→A pairs) rather than sequential proximity.
     */
    _buildContextWindow(targetSentence, allSentences, conversation) {
        const targetTurn = targetSentence.turn_id;
        const targetRole = targetSentence.role;

        // System chunks embed in isolation (no turn pair)
        if (targetRole === 'system') {
            return conversation.reconstructText(targetSentence.tokens);
        }

        // Build sentence lookup by (turn_id, sentence_id, role)
        const sentenceLookup = new Map();
        for (const s of allSentences) {
            const key = `${s.turn_id}_${s.sentence_id}_${s.role}`;
            sentenceLookup.set(key, s);
        }

        // Helper to get sentence_0 of a turn
        const getSentence0 = (turnId, role) => {
            const key = `${turnId}_0_${role}`;
            return sentenceLookup.get(key);
        };

        const chunks = [];
        let totalTokens = 0;

        // Strategy for Assistant chunks
        if (targetRole === 'assistant') {
            // 1. Add user sentence_0 from previous turn (the question)
            const userS0 = getSentence0(targetTurn - 1, 'user');
            if (userS0 && totalTokens + userS0.tokens.length <= this.embeddingContextTokens) {
                chunks.push(userS0);
                totalTokens += userS0.tokens.length;
            }

            // 2. Add assistant sentence_0 from current turn (opening of response)
            // Only add if target is NOT sentence_0
            if (targetSentence.sentence_id !== 0) {
                const assistantS0 = getSentence0(targetTurn, 'assistant');
                if (assistantS0 && totalTokens + assistantS0.tokens.length <= this.embeddingContextTokens) {
                    chunks.push(assistantS0);
                    totalTokens += assistantS0.tokens.length;
                }
            }

            // 3. Add target chunk
            chunks.push(targetSentence);
            totalTokens += targetSentence.tokens.length;
        }
        // Strategy for User chunks
        else if (targetRole === 'user') {
            // 1. Add user sentence_0 from current turn (opening of question)
            // Only add if target is NOT sentence_0
            if (targetSentence.sentence_id !== 0) {
                const userS0 = getSentence0(targetTurn, 'user');
                if (userS0 && totalTokens + userS0.tokens.length <= this.embeddingContextTokens) {
                    chunks.push(userS0);
                    totalTokens += userS0.tokens.length;
                }
            }

            // 2. Add target chunk
            chunks.push(targetSentence);
            totalTokens += targetSentence.tokens.length;

            // 3. Add assistant sentence_0 from next turn (the response)
            const assistantS0 = getSentence0(targetTurn + 1, 'assistant');
            if (assistantS0 && totalTokens + assistantS0.tokens.length <= this.embeddingContextTokens) {
                chunks.push(assistantS0);
                totalTokens += assistantS0.tokens.length;
            }
        }

        // Reconstruct text from chunks (in order added)
        return chunks.map(s => conversation.reconstructText(s.tokens)).join(' ');
    }

    /**
     * Queue embedding computation (processed sequentially to avoid overwhelming WASM)
     */
    _queueEmbedding(entry, contextText) {
        this._embedQueue.push({ entry, contextText });
        this._processEmbedQueue();
    }
    
    /**
     * Process embedding queue sequentially
     */
    async _processEmbedQueue() {
        if (this._embedProcessing) return;
        this._embedProcessing = true;

        while (this._embedQueue.length > 0) {
            const { entry, contextText } = this._embedQueue.shift();
            try {
                entry.embedding = await this.embed(contextText);

                // Persist to IndexedDB after successful embedding
                await this._persistEntry(entry);
            } catch (err) {
                console.warn('📚 Embedding failed for entry:', entry.text.substring(0, 30));
            }
        }

        this._embedProcessing = false;
    }

    /**
     * Query the index for chunks similar to the query text
     * @param {string} queryText - Text to search for (usually user message)
     * @param {Object} options - Query options
     * @returns {Promise<Array>} - Matching entries sorted by relevance
     */
    async query(queryText, options = {}) {
        const maxResults = options.maxResults || this.queryMaxResults;
        const tokenBudget = options.tokenBudget || this.resurrectionBudget;
        
        const t0 = performance.now();
        
        if (this.entries.length === 0) return [];
        
        // Embed the query
        let queryEmbedding;
        try {
            queryEmbedding = await this.embed(queryText);
        } catch (err) {
            console.warn('📚 Query embedding failed:', err);
            return [];
        }
        
        // Score all entries with embeddings
        const tSearch = performance.now();
        const scored = [];
        for (const entry of this.entries) {
            if (!entry.embedding) continue;
            
            let similarity = this._cosineSimilarity(queryEmbedding, entry.embedding);
            
            // Boost user content - denser signal, smaller chunks
            if (entry.role === 'user') {
                similarity *= this.userBoost;
            }
            
            scored.push({ entry, similarity });
        }
        
        // Sort by similarity descending
        scored.sort((a, b) => b.similarity - a.similarity);
        
        this._timing.lastSearchMs = performance.now() - tSearch;
        
        // Return top N results by similarity (budget filtering happens in caller)
        const results = [];
        for (const { entry, similarity } of scored) {
            if (results.length >= maxResults) break;
            results.push({
                ...entry,
                similarity
            });
        }
        
        // Track timing
        const elapsed = performance.now() - t0;
        this._timing.lastQueryMs = elapsed;
        this._timing.totalQueryMs += elapsed;
        this._timing.queryCount++;
        
        return results;
    }

    /**
     * Increment reference count for an entry (called on resurrection)
     */
    markReferenced(turn_id, sentence_id, role) {
        const key = this._chunkKey(turn_id, sentence_id, role);
        for (const entry of this.entries) {
            if (this._chunkKey(entry.turn_id, entry.sentence_id, entry.role) === key) {
                entry.referenceCount++;
                this.totalResurrected++;
                return;
            }
        }
    }

    /**
     * Delete an entry from the index (both memory and IndexedDB)
     * Used for re-indexing operations
     * @param {number} turn_id - Turn ID
     * @param {number} sentence_id - Sentence/chunk ID
     * @param {string} role - Role
     * @returns {boolean} True if entry was found and deleted
     */
    async deleteEntry(turn_id, sentence_id, role) {
        const key = this._chunkKey(turn_id, sentence_id, role);
        const idx = this.entries.findIndex(e =>
            this._chunkKey(e.turn_id, e.sentence_id, e.role) === key
        );

        if (idx !== -1) {
            this.entries.splice(idx, 1);

            // Delete from IndexedDB
            if (this.store) {
                try {
                    await this.store.deleteSemanticEntry(turn_id, sentence_id, role);
                } catch (err) {
                    console.warn('📚 Failed to delete entry from IndexedDB:', err);
                }
            }

            console.log(`📚 Deleted index entry for turn ${turn_id}, sentence ${sentence_id}`);
            return true;
        }
        return false;
    }

    /**
     * Delete chunk from search (user-initiated deletion)
     * Removes embedding but preserves token transcript
     * @param {number} turn_id - Turn ID
     * @param {number} sentence_id - Sentence/chunk ID
     * @param {string} role - Role
     */
    async deleteChunkFromSearch(turn_id, sentence_id, role) {
        // Delete embedding from semantic index
        await this.deleteEntry(turn_id, sentence_id, role);

        // Mark as indexed so it won't be re-indexed
        const key = this._chunkKey(turn_id, sentence_id, role);
        this._indexedChunks.add(key);

        console.log(`📚 Removed chunk from search: turn ${turn_id}, sentence ${sentence_id}, ${role}`);
    }
    
    /**
     * Re-index a specific chunk (delete old entry and create new one)
     * @param {Conversation} conversation - The conversation object
     * @param {number} turn_id - Turn ID
     * @param {number} sentence_id - Sentence/chunk ID
     * @param {string} role - Role
     */
    async reindexChunk(conversation, turn_id, sentence_id, role) {
        // Delete existing entry
        this.deleteEntry(turn_id, sentence_id, role);
        
        // Get the sentence from conversation
        const sentences = conversation.getSentences();
        const sentence = sentences.find(s => 
            s.turn_id === turn_id && 
            s.sentence_id === sentence_id && 
            s.role === role
        );
        
        if (!sentence || sentence.tokens.length === 0) {
            console.log(`📚 No tokens found for turn ${turn_id}, sentence ${sentence_id} - skipping reindex`);
            return;
        }
        
        // Build text from tokens
        const text = sentence.tokens.map(t => t.text).join('');
        const tokenCount = sentence.tokens.length;
        
        // Build context window
        const contextText = this._buildContextWindow(sentence, sentences, conversation);
        
        // Create new entry
        const entry = {
            turn_id,
            sentence_id,
            role,
            text,
            tokenCount,
            embedding: null,
            referenceCount: 0,
            indexedAt: Date.now()
        };
        
        this.entries.push(entry);
        this.totalIndexed++;
        
        // Queue embedding
        this._queueEmbedding(entry, contextText);
        
        console.log(`📚 Reindexed turn ${turn_id}, sentence ${sentence_id} (${tokenCount} tokens)`);
    }

    /**
     * Cosine similarity between two vectors
     */
    _cosineSimilarity(a, b) {
        let dot = 0;
        let normA = 0;
        let normB = 0;
        
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom > 0 ? dot / denom : 0;
    }

    // ========== Utilities ==========

    /**
     * Get index statistics
     */
    getStats() {
        let embeddedCount = 0;
        let totalTokens = 0;
        
        for (const entry of this.entries) {
            if (entry.embedding) embeddedCount++;
            totalTokens += entry.tokenCount;
        }
        
        return {
            entries: this.entries.length,
            embedded: embeddedCount,
            tokens: totalTokens,
            totalIndexed: this.totalIndexed,
            totalResurrected: this.totalResurrected,
            modelReady: this.modelReady,
            memoryEstimateMB: Math.round((this.entries.length * this.embeddingDim * 4) / 1024 / 1024)
        };
    }

    /**
     * Get timing stats
     */
    getTiming(reset = false) {
        const timing = { ...this._timing };
        
        timing.avgEmbedMs = timing.embedCount > 0 ? timing.totalEmbedMs / timing.embedCount : 0;
        timing.avgQueryMs = timing.queryCount > 0 ? timing.totalQueryMs / timing.queryCount : 0;
        
        if (reset) {
            this._timing = {
                lastEmbedMs: 0,
                lastQueryMs: 0,
                lastSearchMs: 0,
                totalEmbedMs: 0,
                totalQueryMs: 0,
                embedCount: 0,
                queryCount: 0
            };
        }
        
        return timing;
    }

    /**
     * Clear the index
     */
    clear() {
        this.entries = [];
        this._indexedChunks.clear();
        this.totalIndexed = 0;
        this.totalResurrected = 0;
    }

    /**
     * Export state for saving (without embeddings by default)
     */
    exportState(includeEmbeddings = false) {
        return {
            version: 1,
            entries: this.entries.map(e => ({
                turn_id: e.turn_id,
                sentence_id: e.sentence_id,
                role: e.role,
                text: e.text,
                tokenCount: e.tokenCount,
                referenceCount: e.referenceCount,
                embedding: includeEmbeddings && e.embedding ? Array.from(e.embedding) : null
            })),
            stats: {
                totalIndexed: this.totalIndexed,
                totalResurrected: this.totalResurrected
            }
        };
    }

    /**
     * Import state from saved data
     */
    async importState(state, regenerateEmbeddings = true) {
        if (!state || !state.entries) return;
        
        this.entries = state.entries.map(e => ({
            ...e,
            embedding: e.embedding ? new Float32Array(e.embedding) : null
        }));
        
        // Rebuild indexed chunks set
        this._indexedChunks.clear();
        for (const e of this.entries) {
            this._indexedChunks.add(this._chunkKey(e.turn_id, e.sentence_id, e.role));
        }
        
        if (state.stats) {
            this.totalIndexed = state.stats.totalIndexed || 0;
            this.totalResurrected = state.stats.totalResurrected || 0;
        }
        
        // Regenerate missing embeddings if requested
        if (regenerateEmbeddings) {
            const missing = this.entries.filter(e => !e.embedding);
            if (missing.length > 0) {
                console.log(`📚 Regenerating ${missing.length} embeddings...`);
                for (const entry of missing) {
                    await this._computeEmbedding(entry, entry.text);
                }
            }
        }
        
        console.log(`📚 Imported ${this.entries.length} index entries`);
    }

    /**
     * Preload the embedding model
     */
    async preloadModel() {
        try {
            await this._ensureModel();
        } catch (err) {
            // Logged in _ensureModel
        }
    }
}
