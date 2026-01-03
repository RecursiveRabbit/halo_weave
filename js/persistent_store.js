/**
 * PersistentStore - IndexedDB Layer for Infinite Conversation
 *
 * Split-Store Architecture for Performance:
 * 1. liveTokens - Active context (fast retrieval, small size)
 * 2. deadTokens - Pruned but recoverable (semantic search targets)
 * 3. semantic_entries - All semantic index entries with embeddings
 * 4. metadata - Singleton state (nextPosition, nextTurn, etc.)
 *
 * Philosophy:
 * - Position IDs are absolute and never reused across ALL time
 * - This is ONE infinite conversation, not separate sessions
 * - Split stores optimize for most common operations:
 *   1. Get active context (liveTokens.toArray() - O(k) not O(n))
 *   2. Prune/resurrect (move between stores)
 */

export class PersistentStore {
    constructor(dbName = 'halo_weave', version = 3) {
        this.dbName = dbName;
        this.version = version;
        this.db = null;

        // Write batching for performance
        this._writeBatch = [];
        this._writeTimeout = null;
        this._batchDelay = 100; // ms
    }

    /**
     * Initialize database connection
     * Creates stores if they don't exist
     */
    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                console.log('💾 PersistentStore: Database opened (split-store v2)');
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                const oldVersion = event.oldVersion;

                // Migration from v1 (single tokens store) to v2 (split stores)
                if (oldVersion < 2) {
                    // Delete old tokens store if it exists
                    if (db.objectStoreNames.contains('tokens')) {
                        db.deleteObjectStore('tokens');
                        console.log('💾 Migrated: deleted old tokens store');
                    }
                }

                // Store 1: liveTokens - Active context (optimized for fast retrieval)
                if (!db.objectStoreNames.contains('liveTokens')) {
                    const liveStore = db.createObjectStore('liveTokens', { keyPath: 'position' });
                    liveStore.createIndex('turn_id', 'turn_id', { unique: false });
                    liveStore.createIndex('turn_sentence_role', ['turn_id', 'sentence_id', 'role'], { unique: false });
                    console.log('💾 Created liveTokens store');
                }

                // Store 2: deadTokens - Pruned but recoverable (semantic search targets)
                if (!db.objectStoreNames.contains('deadTokens')) {
                    const deadStore = db.createObjectStore('deadTokens', { keyPath: 'position' });
                    deadStore.createIndex('turn_id', 'turn_id', { unique: false });
                    deadStore.createIndex('turn_sentence_role', ['turn_id', 'sentence_id', 'role'], { unique: false });
                    console.log('💾 Created deadTokens store');
                }

                // Store 3: semantic_entries (unchanged)
                if (!db.objectStoreNames.contains('semantic_entries')) {
                    const entryStore = db.createObjectStore('semantic_entries', { keyPath: 'id', autoIncrement: true });
                    entryStore.createIndex('turn_sentence_role', ['turn_id', 'sentence_id', 'role'], { unique: true });
                    entryStore.createIndex('turn_id', 'turn_id', { unique: false });
                    console.log('💾 Created semantic_entries store');
                }

                // Store 4: metadata (unchanged)
                if (!db.objectStoreNames.contains('metadata')) {
                    db.createObjectStore('metadata', { keyPath: 'key' });
                    console.log('💾 Created metadata store');
                }

                // Store 5: tool_data - Persistent JSON storage for AI tools
                if (!db.objectStoreNames.contains('tool_data')) {
                    db.createObjectStore('tool_data', { keyPath: 'filename' });
                    console.log('💾 Created tool_data store');
                }
            };
        });
    }

    /**
     * Close database connection
     */
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }

    // ========== Metadata Operations ==========

    /**
     * Get metadata (nextPosition, nextTurn, etc.)
     * @returns {Promise<Object>} Metadata object or default values
     */
    async getMetadata() {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('metadata', 'readonly');
            const store = tx.objectStore('metadata');
            const request = store.get('state');

            request.onsuccess = () => {
                const data = request.result;
                resolve(data || {
                    key: 'state',
                    nextPosition: 0,
                    nextTurn: 0,
                    currentSentence: 0,
                    currentRole: null,
                    lastModified: Date.now()
                });
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Save metadata
     * @param {Object} metadata - Metadata to save
     */
    async saveMetadata(metadata) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('metadata', 'readwrite');
            const store = tx.objectStore('metadata');

            metadata.key = 'state';
            metadata.lastModified = Date.now();

            const request = store.put(metadata);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    // ========== Token Operations (Split Store) ==========

    /**
     * Save a single token to liveTokens (new tokens are always alive)
     * @param {Object} token - Token object with position, token_id, text, etc.
     */
    async saveToken(token) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('liveTokens', 'readwrite');
            const store = tx.objectStore('liveTokens');
            const request = store.put(token);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Save multiple tokens in a batch (to liveTokens)
     * @param {Array<Object>} tokens - Array of token objects
     */
    async saveTokensBatch(tokens) {
        if (!this.db) await this.init();
        if (tokens.length === 0) return;

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('liveTokens', 'readwrite');
            const store = tx.objectStore('liveTokens');

            let completed = 0;
            const total = tokens.length;

            for (const token of tokens) {
                const request = store.put(token);
                request.onsuccess = () => {
                    completed++;
                    if (completed === total) resolve();
                };
                request.onerror = () => reject(request.error);
            }
        });
    }

    /**
     * Get token by position (checks both live and dead stores)
     * @param {number} position - Absolute position ID
     * @returns {Promise<Object>} Token object or undefined
     */
    async getToken(position) {
        if (!this.db) await this.init();

        // Check liveTokens first (most likely)
        const live = await new Promise((resolve, reject) => {
            const tx = this.db.transaction('liveTokens', 'readonly');
            const store = tx.objectStore('liveTokens');
            const request = store.get(position);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        if (live) return live;

        // Check deadTokens
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('deadTokens', 'readonly');
            const store = tx.objectStore('deadTokens');
            const request = store.get(position);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get all live tokens (active context only - fast!)
     * @returns {Promise<Array>} Array of live token objects
     */
    async getAllLiveTokens() {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('liveTokens', 'readonly');
            const store = tx.objectStore('liveTokens');
            const request = store.getAll();

            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get all dead tokens (pruned context only)
     * @returns {Promise<Array>} Array of dead token objects
     */
    async getAllDeadTokens() {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('deadTokens', 'readonly');
            const store = tx.objectStore('deadTokens');
            const request = store.getAll();

            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get all tokens (live + dead - WARNING: can be huge)
     * @returns {Promise<Array>} Array of all token objects
     */
    async getAllTokens() {
        if (!this.db) await this.init();

        const [live, dead] = await Promise.all([
            this.getAllLiveTokens(),
            new Promise((resolve, reject) => {
                const tx = this.db.transaction('deadTokens', 'readonly');
                const store = tx.objectStore('deadTokens');
                const request = store.getAll();

                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error);
            })
        ]);

        return [...live, ...dead].sort((a, b) => a.position - b.position);
    }

    /**
     * Get tokens by turn_id (checks both live and dead stores)
     * @param {number} turnId - Turn ID to fetch
     * @returns {Promise<Array>} Array of tokens from that turn
     */
    async getTokensByTurn(turnId) {
        if (!this.db) await this.init();

        const [live, dead] = await Promise.all([
            new Promise((resolve, reject) => {
                const tx = this.db.transaction('liveTokens', 'readonly');
                const store = tx.objectStore('liveTokens');
                const index = store.index('turn_id');
                const request = index.getAll(turnId);

                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error);
            }),
            new Promise((resolve, reject) => {
                const tx = this.db.transaction('deadTokens', 'readonly');
                const store = tx.objectStore('deadTokens');
                const index = store.index('turn_id');
                const request = index.getAll(turnId);

                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error);
            })
        ]);

        return [...live, ...dead].sort((a, b) => a.position - b.position);
    }

    /**
     * Get tokens by chunk tuple from deadTokens (for resurrection)
     * @param {number} turnId - Turn ID
     * @param {number} sentenceId - Sentence ID
     * @param {string} role - Role
     * @returns {Promise<Array>} Array of dead tokens in chunk
     */
    async getDeadTokensByChunk(turnId, sentenceId, role) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('deadTokens', 'readonly');
            const store = tx.objectStore('deadTokens');
            const index = store.index('turn_sentence_role');
            const request = index.getAll([turnId, sentenceId, role]);

            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Check if chunk exists in liveTokens
     * @param {number} turnId - Turn ID
     * @param {number} sentenceId - Sentence ID
     * @param {string} role - Role
     * @returns {Promise<boolean>} True if any token from chunk is alive
     */
    async isChunkAlive(turnId, sentenceId, role) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('liveTokens', 'readonly');
            const store = tx.objectStore('liveTokens');
            const index = store.index('turn_sentence_role');
            const request = index.openCursor([turnId, sentenceId, role]);

            request.onsuccess = () => resolve(!!request.result);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Prune a chunk - move tokens from liveTokens to deadTokens
     * @param {number} turnId - Turn ID
     * @param {number} sentenceId - Sentence ID
     * @param {string} role - Role
     * @returns {Promise<number>} Number of tokens pruned
     */
    async pruneChunk(turnId, sentenceId, role) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['liveTokens', 'deadTokens'], 'readwrite');
            const liveStore = tx.objectStore('liveTokens');
            const deadStore = tx.objectStore('deadTokens');
            const index = liveStore.index('turn_sentence_role');

            // Get all tokens in chunk
            const getRequest = index.getAll([turnId, sentenceId, role]);

            getRequest.onsuccess = () => {
                const tokens = getRequest.result || [];

                if (tokens.length === 0) {
                    resolve(0);
                    return;
                }

                // Mark as deleted and store brightness_at_deletion
                const deadTokens = tokens.map(t => ({
                    ...t,
                    deleted: true,
                    brightness_at_deletion: t.brightness
                }));

                // Move to deadTokens
                for (const token of deadTokens) {
                    deadStore.put(token);
                    liveStore.delete(token.position);
                }

                tx.oncomplete = () => resolve(tokens.length);
                tx.onerror = () => reject(tx.error);
            };

            getRequest.onerror = () => reject(getRequest.error);
        });
    }

    /**
     * Resurrect a chunk - move tokens from deadTokens to liveTokens
     * @param {number} turnId - Turn ID
     * @param {number} sentenceId - Sentence ID
     * @param {string} role - Role
     * @returns {Promise<number>} Number of tokens resurrected
     */
    async resurrectChunk(turnId, sentenceId, role) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['liveTokens', 'deadTokens'], 'readwrite');
            const liveStore = tx.objectStore('liveTokens');
            const deadStore = tx.objectStore('deadTokens');
            const index = deadStore.index('turn_sentence_role');

            // Get all tokens in chunk
            const getRequest = index.getAll([turnId, sentenceId, role]);

            getRequest.onsuccess = () => {
                const tokens = getRequest.result || [];

                if (tokens.length === 0) {
                    resolve(0);
                    return;
                }

                // Mark as alive (brightness is already set by conversation.js)
                const liveTokens = tokens.map(t => ({
                    ...t,
                    deleted: false
                    // NOTE: brightness is set by conversation.js before this is called
                    // (semantic resurrection: meanBrightness, manual: 10000)
                }));

                // Move to liveTokens
                for (const token of liveTokens) {
                    liveStore.put(token);
                    deadStore.delete(token.position);
                }

                tx.oncomplete = () => resolve(tokens.length);
                tx.onerror = () => reject(tx.error);
            };

            getRequest.onerror = () => reject(getRequest.error);
        });
    }

    /**
     * Update brightness for live tokens only (in-place, no moves)
     * Used during generation for brightness scoring
     * @param {number} position - Token position
     * @param {number} brightness - New brightness value
     */
    async updateTokenBrightness(position, brightness) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('liveTokens', 'readwrite');
            const store = tx.objectStore('liveTokens');
            const getRequest = store.get(position);

            getRequest.onsuccess = () => {
                const token = getRequest.result;
                if (token) {
                    token.brightness = brightness;
                    const putRequest = store.put(token);
                    putRequest.onsuccess = () => resolve();
                    putRequest.onerror = () => reject(putRequest.error);
                } else {
                    resolve(); // Token not in liveTokens, skip
                }
            };
            getRequest.onerror = () => reject(getRequest.error);
        });
    }

    /**
     * Get count of live tokens in database
     * @returns {Promise<number>} Live token count
     */
    async getLiveTokenCount() {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('liveTokens', 'readonly');
            const store = tx.objectStore('liveTokens');
            const request = store.count();

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get count of dead tokens in database
     * @returns {Promise<number>} Dead token count
     */
    async getDeadTokenCount() {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('deadTokens', 'readonly');
            const store = tx.objectStore('deadTokens');
            const request = store.count();

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get count of total tokens in database (live + dead)
     * @returns {Promise<number>} Total token count
     */
    async getTokenCount() {
        const [live, dead] = await Promise.all([
            this.getLiveTokenCount(),
            this.getDeadTokenCount()
        ]);
        return live + dead;
    }

    // ========== Semantic Entry Operations ==========

    /**
     * Save a semantic index entry (upsert: update if exists, insert if new)
     * @param {Object} entry - Entry with turn_id, sentence_id, role, text, embedding, etc.
     */
    async saveSemanticEntry(entry) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('semantic_entries', 'readwrite');
            const store = tx.objectStore('semantic_entries');
            const index = store.index('turn_sentence_role');

            // First, check if entry exists
            const getRequest = index.getKey([entry.turn_id, entry.sentence_id, entry.role]);

            getRequest.onsuccess = () => {
                const existingId = getRequest.result;

                // Convert Float32Array to regular array for storage
                const storedEntry = {
                    ...entry,
                    embedding: entry.embedding ? Array.from(entry.embedding) : null,
                    timestamp: entry.timestamp || Date.now()
                };

                // If exists, include the ID for update; otherwise omit for insert
                if (existingId !== undefined) {
                    storedEntry.id = existingId;
                }

                const putRequest = store.put(storedEntry);
                putRequest.onsuccess = () => resolve(putRequest.result);
                putRequest.onerror = () => reject(putRequest.error);
            };

            getRequest.onerror = () => reject(getRequest.error);
        });
    }

    /**
     * Get all semantic entries (WARNING: includes embeddings, can be large)
     * @returns {Promise<Array>} Array of all semantic entries
     */
    async getAllSemanticEntries() {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('semantic_entries', 'readonly');
            const store = tx.objectStore('semantic_entries');
            const request = store.getAll();

            request.onsuccess = () => {
                const entries = request.result || [];
                // Convert arrays back to Float32Array
                const converted = entries.map(e => ({
                    ...e,
                    embedding: e.embedding ? new Float32Array(e.embedding) : null
                }));
                resolve(converted);
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get semantic entry by (turn_id, sentence_id, role) tuple
     * @param {number} turnId - Turn ID
     * @param {number} sentenceId - Sentence ID
     * @param {string} role - Role
     * @returns {Promise<Object>} Entry or undefined
     */
    async getSemanticEntry(turnId, sentenceId, role) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('semantic_entries', 'readonly');
            const store = tx.objectStore('semantic_entries');
            const index = store.index('turn_sentence_role');
            const request = index.get([turnId, sentenceId, role]);

            request.onsuccess = () => {
                const entry = request.result;
                if (entry) {
                    entry.embedding = entry.embedding ? new Float32Array(entry.embedding) : null;
                }
                resolve(entry);
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Delete semantic entry by (turn_id, sentence_id, role) tuple
     * @param {number} turnId - Turn ID
     * @param {number} sentenceId - Sentence ID
     * @param {string} role - Role
     */
    async deleteSemanticEntry(turnId, sentenceId, role) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('semantic_entries', 'readwrite');
            const store = tx.objectStore('semantic_entries');
            const index = store.index('turn_sentence_role');
            const getRequest = index.getKey([turnId, sentenceId, role]);

            getRequest.onsuccess = () => {
                const id = getRequest.result;
                if (id !== undefined) {
                    const deleteRequest = store.delete(id);
                    deleteRequest.onsuccess = () => resolve(true);
                    deleteRequest.onerror = () => reject(deleteRequest.error);
                } else {
                    resolve(false); // Entry not found
                }
            };
            getRequest.onerror = () => reject(getRequest.error);
        });
    }

    /**
     * Get count of semantic entries
     * @returns {Promise<number>} Total entry count
     */
    async getSemanticEntryCount() {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('semantic_entries', 'readonly');
            const store = tx.objectStore('semantic_entries');
            const request = store.count();

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    // ========== Bulk Operations ==========

    /**
     * Clear all data (for debugging/testing)
     */
    async clearAll() {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['liveTokens', 'deadTokens', 'semantic_entries', 'metadata'], 'readwrite');

            let completed = 0;
            const onComplete = () => {
                completed++;
                if (completed === 4) resolve();
            };

            tx.objectStore('liveTokens').clear().onsuccess = onComplete;
            tx.objectStore('deadTokens').clear().onsuccess = onComplete;
            tx.objectStore('semantic_entries').clear().onsuccess = onComplete;
            tx.objectStore('metadata').clear().onsuccess = onComplete;

            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * Get database statistics
     * @returns {Promise<Object>} Stats about database size
     */
    async getStats() {
        if (!this.db) await this.init();

        const [liveCount, deadCount, entryCount, metadata] = await Promise.all([
            this.getLiveTokenCount(),
            this.getDeadTokenCount(),
            this.getSemanticEntryCount(),
            this.getMetadata()
        ]);

        return {
            liveTokens: liveCount,
            deadTokens: deadCount,
            totalTokens: liveCount + deadCount,
            semanticEntries: entryCount,
            nextPosition: metadata.nextPosition,
            nextTurn: metadata.nextTurn,
            lastModified: metadata.lastModified
        };
    }

    // ========== Export/Import for Backup ==========

    /**
     * Export entire database to JSON (for backup)
     * WARNING: Can be very large for long conversations
     * @returns {Promise<Object>} Full database export
     */
    async exportAll() {
        if (!this.db) await this.init();

        const [tokens, entries, metadata] = await Promise.all([
            this.getAllTokens(),
            this.getAllSemanticEntries(),
            this.getMetadata()
        ]);

        return {
            version: 1,
            exported: Date.now(),
            metadata,
            tokens,
            semanticEntries: entries.map(e => ({
                ...e,
                embedding: e.embedding ? Array.from(e.embedding) : null
            }))
        };
    }

    /**
     * Import database from JSON export
     * @param {Object} data - Previously exported data
     */
    async importAll(data) {
        if (!this.db) await this.init();

        // Clear existing data
        await this.clearAll();

        // Import metadata
        if (data.metadata) {
            await this.saveMetadata(data.metadata);
        }

        // Import tokens in batches (more efficient)
        if (data.tokens && data.tokens.length > 0) {
            console.log(`💾 Importing ${data.tokens.length} tokens...`);
            const batchSize = 1000;
            for (let i = 0; i < data.tokens.length; i += batchSize) {
                const batch = data.tokens.slice(i, i + batchSize);
                await this.saveTokensBatch(batch);
            }
        }

        // Import semantic entries
        if (data.semanticEntries && data.semanticEntries.length > 0) {
            console.log(`💾 Importing ${data.semanticEntries.length} semantic entries...`);
            for (const entry of data.semanticEntries) {
                await this.saveSemanticEntry({
                    ...entry,
                    embedding: entry.embedding ? new Float32Array(entry.embedding) : null
                });
            }
        }

        console.log('💾 Import complete');
    }

    // ========== Tool Data Operations ==========

    /**
     * Save tool data (JSON storage for AI tools)
     * @param {string} filename - The filename to store under
     * @param {object} data - The JSON data to store
     */
    async saveToolData(filename, data) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('tool_data', 'readwrite');
            const store = tx.objectStore('tool_data');

            // Store as actual JSON string
            const record = {
                filename: filename,
                data: JSON.stringify(data),  // Store as JSON string
                lastModified: new Date().toISOString()
            };

            const request = store.put(record);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get tool data
     * @param {string} filename - The filename to retrieve
     * @returns {Promise<object|null>} The stored data or null if not found
     */
    async getToolData(filename) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('tool_data', 'readonly');
            const store = tx.objectStore('tool_data');
            const request = store.get(filename);

            request.onsuccess = () => {
                const result = request.result;
                if (result && result.data) {
                    // Handle both old (object) and new (JSON string) formats
                    if (typeof result.data === 'string') {
                        try {
                            // New format: Parse JSON string back to object
                            resolve(JSON.parse(result.data));
                        } catch (e) {
                            console.warn('Failed to parse tool data JSON:', e);
                            resolve(null);
                        }
                    } else if (typeof result.data === 'object') {
                        // Old format: Already an object, migrate it
                        console.log('📦 Migrating old tool data format to JSON string...');

                        // Return the object for now
                        resolve(result.data);

                        // Migrate to new format in background
                        this.saveToolData(filename, result.data).catch(err => {
                            console.warn('Failed to migrate tool data:', err);
                        });
                    } else {
                        console.warn('Unknown tool data format:', typeof result.data);
                        resolve(null);
                    }
                } else {
                    resolve(null);
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Delete tool data
     * @param {string} filename - The filename to delete
     */
    async deleteToolData(filename) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('tool_data', 'readwrite');
            const store = tx.objectStore('tool_data');
            const request = store.delete(filename);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * List all tool data files
     * @returns {Promise<Array>} List of {filename, lastModified} objects
     */
    async listToolData() {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('tool_data', 'readonly');
            const store = tx.objectStore('tool_data');
            const request = store.getAll();

            request.onsuccess = () => {
                const results = request.result.map(r => ({
                    filename: r.filename,
                    lastModified: r.lastModified
                }));
                resolve(results);
            };
            request.onerror = () => reject(request.error);
        });
    }
}
