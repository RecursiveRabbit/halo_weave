/**
 * Graveyard - Semantic Context Resurrection via RAG
 * 
 * When sentences are pruned from active context, they enter the graveyard.
 * Sentences can be resurrected when semantically relevant to user queries.
 * 
 * Architecture:
 * - FIFO queue with revival refresh
 * - Vector embeddings for semantic search
 * - Brute-force cosine similarity (fast enough for 100K+ entries)
 * 
 * Performance targets:
 * - 10K sentences: ~4ms search, 15MB memory
 * - 100K sentences: ~40ms search, 150MB memory
 */

// Will be loaded lazily on first embed
let pipeline = null;
let embeddingModel = null;

export class Graveyard {
    constructor(options = {}) {
        // FIFO queue - front (index 0) is newest, back is oldest
        this.entries = [];
        
        // Configuration
        this.maxSize = options.maxSize || 100000;  // 100K sentences default
        this.embeddingDim = 384;  // all-MiniLM-L6-v2 output dimension
        
        // Model loading state
        this.modelLoading = false;
        this.modelReady = false;
        this.modelError = null;
        
        // Stats
        this.totalInterred = 0;      // Total sentences ever added
        this.totalResurrected = 0;   // Total resurrections
        this.totalEvicted = 0;       // True deaths (fell off back of queue)
        
        // Timing stats (reset per operation batch)
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

    // ========== Embedding Pipeline ==========

    /**
     * Initialize the embedding model (lazy load on first use)
     * Uses transformers.js with all-MiniLM-L6-v2
     */
    async _ensureModel() {
        if (this.modelReady) return true;
        if (this.modelError) throw this.modelError;
        if (this.modelLoading) {
            // Wait for in-progress load
            while (this.modelLoading) {
                await new Promise(r => setTimeout(r, 100));
            }
            if (this.modelError) throw this.modelError;
            return this.modelReady;
        }

        this.modelLoading = true;
        console.log('🪦 Graveyard: Loading embedding model...');
        
        try {
            // Dynamic import of transformers.js
            const { pipeline: createPipeline } = await import(
                'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1'
            );
            
            // Load the sentence embedding model
            // This downloads ~23MB on first use, cached thereafter
            embeddingModel = await createPipeline(
                'feature-extraction',
                'Xenova/all-MiniLM-L6-v2',
                { quantized: true }  // Use quantized for smaller size
            );
            
            this.modelReady = true;
            console.log('🪦 Graveyard: Embedding model ready');
            return true;
            
        } catch (err) {
            this.modelError = err;
            console.error('🪦 Graveyard: Failed to load embedding model:', err);
            throw err;
        } finally {
            this.modelLoading = false;
        }
    }

    /**
     * Embed a sentence into a vector
     * @param {string} text - Sentence text
     * @returns {Promise<Float32Array>} - 384-dimensional embedding
     */
    async embed(text) {
        await this._ensureModel();
        
        const t0 = performance.now();
        
        // Run the model
        const output = await embeddingModel(text, {
            pooling: 'mean',
            normalize: true
        });
        
        const elapsed = performance.now() - t0;
        this._timing.lastEmbedMs = elapsed;
        this._timing.totalEmbedMs += elapsed;
        this._timing.embedCount++;
        
        // Extract the embedding array
        return new Float32Array(output.data);
    }

    // ========== Core Operations ==========

    /**
     * Add a pruned sentence to the graveyard
     * @param {Object} sentence - Sentence object from conversation.getSentences()
     * @param {string} text - Reconstructed sentence text
     * @returns {Promise<void>}
     */
    async add(sentence, text) {
        // Don't add empty sentences
        if (!text || text.trim().length === 0) return;
        
        // Create entry
        const entry = {
            // Identity
            turn_id: sentence.turn_id,
            sentence_id: sentence.sentence_id,
            role: sentence.role,
            
            // Content
            text: text,
            token_positions: sentence.tokens.map(t => t.position),
            token_count: sentence.tokens.length,
            
            // Metadata for prioritization
            peak_brightness: sentence.peakBrightness,
            death_time: Date.now(),
            resurrection_count: 0,
            
            // Embedding (computed async)
            embedding: null
        };
        
        // Add to front of queue
        this.entries.unshift(entry);
        this.totalInterred++;
        
        // Evict from back if over capacity
        while (this.entries.length > this.maxSize) {
            this.entries.pop();
            this.totalEvicted++;
        }
        
        // Compute embedding async (don't block pruning)
        this._computeEmbedding(entry).catch(err => {
            console.warn('🪦 Graveyard: Failed to embed sentence:', err);
        });
        
        console.log(`🪦 Interred: "${text.substring(0, 50)}..." (${this.entries.length} in graveyard)`);
    }

    /**
     * Compute embedding for an entry (async, non-blocking)
     */
    async _computeEmbedding(entry) {
        try {
            entry.embedding = await this.embed(entry.text);
        } catch (err) {
            // Entry stays in graveyard but won't be found by semantic search
            console.warn('🪦 Embedding failed for entry:', entry.text.substring(0, 30));
        }
    }

    /**
     * Query the graveyard for sentences similar to the query text
     * @param {string} queryText - Text to search for (usually user message)
     * @param {number} maxResults - Maximum number of results
     * @param {number} tokenBudget - Maximum total tokens to return
     * @returns {Promise<Array>} - Matching entries sorted by relevance
     */
    async query(queryText, maxResults = 10, tokenBudget = 512) {
        const t0 = performance.now();
        
        if (this.entries.length === 0) return [];
        
        // Embed the query (timing tracked in embed())
        let queryEmbedding;
        try {
            queryEmbedding = await this.embed(queryText);
        } catch (err) {
            console.warn('🪦 Graveyard: Query embedding failed:', err);
            return [];
        }
        
        // Score all entries with embeddings
        const tSearch = performance.now();
        const scored = [];
        for (const entry of this.entries) {
            if (!entry.embedding) continue;  // Skip entries without embeddings
            
            const similarity = this._cosineSimilarity(queryEmbedding, entry.embedding);
            scored.push({ entry, similarity });
        }
        
        // Sort by similarity (descending), then peak_brightness (descending), then death_time (descending = more recent)
        scored.sort((a, b) => {
            if (Math.abs(a.similarity - b.similarity) > 0.01) {
                return b.similarity - a.similarity;  // Primary: similarity
            }
            if (a.entry.peak_brightness !== b.entry.peak_brightness) {
                return b.entry.peak_brightness - a.entry.peak_brightness;  // Secondary: peak brightness
            }
            return b.entry.death_time - a.entry.death_time;  // Tertiary: recency
        });
        
        this._timing.lastSearchMs = performance.now() - tSearch;
        
        // Select entries within token budget
        const results = [];
        let tokensUsed = 0;
        
        for (const { entry, similarity } of scored) {
            if (results.length >= maxResults) break;
            if (tokensUsed + entry.token_count > tokenBudget) continue;  // Skip if over budget
            
            results.push({
                ...entry,
                similarity
            });
            tokensUsed += entry.token_count;
        }
        
        // Track total query time
        const elapsed = performance.now() - t0;
        this._timing.lastQueryMs = elapsed;
        this._timing.totalQueryMs += elapsed;
        this._timing.queryCount++;
        
        return results;
    }

    /**
     * Remove an entry from the graveyard (called when resurrecting)
     * @param {Object} entry - Entry to remove
     */
    remove(entry) {
        const idx = this.entries.findIndex(e => 
            e.turn_id === entry.turn_id && 
            e.sentence_id === entry.sentence_id &&
            e.role === entry.role
        );
        
        if (idx !== -1) {
            this.entries.splice(idx, 1);
            this.totalResurrected++;
            console.log(`🪦 Resurrected: "${entry.text.substring(0, 50)}..." (${this.entries.length} remain)`);
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
     * Get graveyard statistics
     */
    getStats() {
        let totalTokens = 0;
        let embeddedCount = 0;
        
        for (const entry of this.entries) {
            totalTokens += entry.token_count;
            if (entry.embedding) embeddedCount++;
        }
        
        return {
            entries: this.entries.length,
            tokens: totalTokens,
            embedded: embeddedCount,
            totalInterred: this.totalInterred,
            totalResurrected: this.totalResurrected,
            totalEvicted: this.totalEvicted,
            modelReady: this.modelReady,
            memoryEstimateMB: Math.round((this.entries.length * this.embeddingDim * 4) / 1024 / 1024)
        };
    }
    
    /**
     * Get timing stats and optionally reset them
     * @param {boolean} reset - Whether to reset timing stats after reading
     */
    getTiming(reset = false) {
        const timing = { ...this._timing };
        
        // Calculate averages
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
     * Clear the graveyard
     */
    clear() {
        this.entries = [];
        // Keep stats for curiosity
    }

    /**
     * Export graveyard state for saving
     */
    exportState() {
        return {
            version: 1,
            entries: this.entries.map(e => ({
                turn_id: e.turn_id,
                sentence_id: e.sentence_id,
                role: e.role,
                text: e.text,
                token_positions: e.token_positions,
                token_count: e.token_count,
                peak_brightness: e.peak_brightness,
                death_time: e.death_time,
                resurrection_count: e.resurrection_count,
                // Store embedding as regular array for JSON serialization
                embedding: e.embedding ? Array.from(e.embedding) : null
            })),
            stats: {
                totalInterred: this.totalInterred,
                totalResurrected: this.totalResurrected,
                totalEvicted: this.totalEvicted
            }
        };
    }

    /**
     * Import graveyard state from saved data
     */
    importState(state) {
        if (!state || !state.entries) return;
        
        this.entries = state.entries.map(e => ({
            ...e,
            // Convert embedding back to Float32Array
            embedding: e.embedding ? new Float32Array(e.embedding) : null
        }));
        
        if (state.stats) {
            this.totalInterred = state.stats.totalInterred || 0;
            this.totalResurrected = state.stats.totalResurrected || 0;
            this.totalEvicted = state.stats.totalEvicted || 0;
        }
        
        console.log(`🪦 Imported ${this.entries.length} graveyard entries`);
    }

    /**
     * Preload the embedding model (call early to avoid delay on first prune)
     */
    async preloadModel() {
        try {
            await this._ensureModel();
        } catch (err) {
            // Logged in _ensureModel
        }
    }
}
