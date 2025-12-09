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
 */

// Will be loaded lazily on first embed
let embeddingModel = null;

export class SemanticIndex {
    constructor(options = {}) {
        // Append-only entry list
        this.entries = [];
        
        // Configuration
        this.embeddingDim = 384;  // all-MiniLM-L6-v2 output dimension
        this.embeddingContextTokens = options.embeddingContextTokens || 256;
        this.queryMaxResults = options.queryMaxResults || 20;
        this.resurrectionBudget = options.resurrectionBudget || 1024;
        
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
    }

    // ========== Embedding Pipeline ==========

    /**
     * Initialize the embedding model (lazy load on first use)
     */
    async _ensureModel() {
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
        console.log('📚 SemanticIndex: Loading embedding model...');
        
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
            console.log('📚 SemanticIndex: Embedding model ready');
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
     * @param {string} text - Text to embed
     * @returns {Promise<Float32Array>} - 384-dimensional embedding
     */
    async embed(text) {
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
            const entry = {
                turn_id: sentence.turn_id,
                sentence_id: sentence.sentence_id,
                role: sentence.role,
                text: text,
                tokenCount: sentence.tokens.length,
                embedding: null,
                referenceCount: 0
            };
            
            this.entries.push(entry);
            this._indexedChunks.add(key);
            this.totalIndexed++;
            
            // Compute embedding async (don't block)
            this._computeEmbedding(entry, contextText).catch(err => {
                console.warn('📚 Failed to embed chunk:', err);
            });
        }
    }

    /**
     * Build context window for embedding (N-1, N, N+1, ... up to token budget)
     */
    _buildContextWindow(targetSentence, allSentences, conversation) {
        // Sort sentences by position (turn_id, then sentence_id)
        const sorted = [...allSentences].sort((a, b) => {
            if (a.turn_id !== b.turn_id) return a.turn_id - b.turn_id;
            return a.sentence_id - b.sentence_id;
        });
        
        // Find target index
        const targetIdx = sorted.findIndex(s => 
            s.turn_id === targetSentence.turn_id && 
            s.sentence_id === targetSentence.sentence_id &&
            s.role === targetSentence.role
        );
        
        if (targetIdx === -1) {
            return conversation.reconstructText(targetSentence.tokens);
        }
        
        // Start with target
        const chunks = [targetSentence];
        let totalTokens = targetSentence.tokens.length;
        
        // Add N-1 if room
        if (targetIdx > 0) {
            const prev = sorted[targetIdx - 1];
            if (totalTokens + prev.tokens.length <= this.embeddingContextTokens) {
                chunks.unshift(prev);
                totalTokens += prev.tokens.length;
            }
        }
        
        // Add N+1, N+2, ... while room
        for (let i = targetIdx + 1; i < sorted.length; i++) {
            const next = sorted[i];
            if (totalTokens + next.tokens.length > this.embeddingContextTokens) break;
            chunks.push(next);
            totalTokens += next.tokens.length;
        }
        
        // Reconstruct text from all chunks
        return chunks.map(s => conversation.reconstructText(s.tokens)).join(' ');
    }

    /**
     * Compute embedding for an entry
     */
    async _computeEmbedding(entry, contextText) {
        try {
            entry.embedding = await this.embed(contextText);
        } catch (err) {
            console.warn('📚 Embedding failed for entry:', entry.text.substring(0, 30));
        }
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
            
            const similarity = this._cosineSimilarity(queryEmbedding, entry.embedding);
            scored.push({ entry, similarity });
        }
        
        // Sort by similarity descending
        scored.sort((a, b) => b.similarity - a.similarity);
        
        this._timing.lastSearchMs = performance.now() - tSearch;
        
        // Select entries within token budget
        const results = [];
        let tokensUsed = 0;
        
        for (const { entry, similarity } of scored) {
            if (results.length >= maxResults) break;
            if (tokensUsed + entry.tokenCount > tokenBudget) continue;
            
            results.push({
                ...entry,
                similarity
            });
            tokensUsed += entry.tokenCount;
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
