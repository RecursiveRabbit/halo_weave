/**
 * DataCapture - Stream-to-Disk Attention Data Recording
 *
 * Writes attention data incrementally to disk as tokens generate.
 * No memory accumulation - each token written immediately.
 * 
 * File format (per token):
 *   token_XXXXX_meta.json  - Small metadata (~200 bytes)
 *   token_XXXXX_attn.bin   - Raw Float32 attention tensor (~1.5MB)
 * 
 * Binary format eliminates JSON serialization bottleneck.
 * Analysis scripts use: np.fromfile('token_00000_attn.bin', dtype=np.float32)
 * 
 * TODO: Consider Web Workers if UI still stutters during capture.
 */

const CAPTURE_SERVER = 'http://127.0.0.1:8081';

export class DataCapture {
    constructor() {
        this.isCapturing = false;
        this.captureTimestamp = null;
        this.captureDir = null;
        this.tokenCount = 0;
        this.nextFileIndex = 0;  // Own counter - never resets during capture session
        this._writeQueue = [];
        this._isProcessingQueue = false;
    }

    /**
     * Check if capture server is reachable
     * @returns {Promise<boolean>} True if server responds
     */
    async isServerAvailable() {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 2000);
            
            const response = await fetch(`${CAPTURE_SERVER}/capture?action=ping`, {
                method: 'POST',
                signal: controller.signal
            });
            
            clearTimeout(timeout);
            // Server returns 400 for unknown action, but that means it's alive
            return response.status === 400 || response.ok;
        } catch (err) {
            return false;
        }
    }

    /**
     * Start a new capture session
     * Creates directory and initializes metadata
     * @param {Object} metadata - Experiment metadata
     */
    async startCapture(metadata = {}) {
        this.captureTimestamp = Date.now();
        this.tokenCount = 0;
        this.nextFileIndex = 0;

        console.log('🎬 Starting data capture...');

        try {
            // Create capture directory
            const response = await fetch(
                `${CAPTURE_SERVER}/capture?action=start&ts=${this.captureTimestamp}`,
                { method: 'POST' }
            );

            if (!response.ok) {
                throw new Error(`Failed to create capture directory: ${response.statusText}`);
            }

            const result = await response.json();
            this.captureDir = result.capture_dir;
            this.isCapturing = true;

            console.log(`📁 Capture directory: ${this.captureDir}`);

            // Store metadata for later writing
            this._metadata = {
                timestamp: this.captureTimestamp,
                model: metadata.model || 'unknown',
                description: metadata.description || '',
                generation_config: metadata.config || {},
                ...metadata
            };

        } catch (err) {
            console.error('❌ Failed to start capture:', err);
            throw err;
        }
    }

    /**
     * Record input tokens (prompt) and write metadata file
     * @param {Array} tokens - Array of token objects
     */
    async recordPromptTokens(tokens) {
        if (!this.isCapturing) return;

        console.log(`📝 Writing metadata with ${tokens.length} prompt tokens...`);

        try {
            const metadata = {
                ...this._metadata,
                prompt_tokens: tokens.map(t => ({
                    token_id: t.token_id,
                    text: t.text,
                    position: t.position,
                    turn_id: t.turn_id,
                    message_role: t.message_role,
                    sentence_id: t.sentence_id
                }))
            };

            const response = await fetch(
                `${CAPTURE_SERVER}/capture?action=write_metadata&ts=${this.captureTimestamp}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(metadata)
                }
            );

            if (!response.ok) {
                throw new Error(`Failed to write metadata: ${response.statusText}`);
            }

            console.log('✅ Metadata written');

        } catch (err) {
            console.error('❌ Failed to write metadata:', err);
            // Don't stop capture, just log error
        }
    }

    /**
     * Record a generated token with its full attention tensor
     * Queues writes to prevent overwhelming the server
     * @param {Object} token - Token object
     * @param {Object} attention - Full attention tensor from KoboldCPP
     * @param {number} generationStep - Which token in this generation (for metadata)
     */
    async recordGeneratedToken(token, attention, generationStep) {
        if (!this.isCapturing) return;

        // Use our own file index (never resets during capture session)
        const fileIndex = this.nextFileIndex++;

        // Queue the write job (don't block)
        this._writeQueue.push({
            fileIndex,  // Used for file naming - unique across entire capture
            tokenMeta: {
                file_index: fileIndex,
                generation_step: generationStep,  // Token's position within its generation
                token_id: token.token_id,
                text: token.text,
                position: token.position,
                timestamp: Date.now(),
                attention_shape: attention ? attention.shape : null,
                attention_context_length: attention ? attention.contextLength : null
            },
            attentionBuffer: attention?.data?.buffer ?
                attention.data.buffer.slice(0) : null  // Copy buffer before it gets reused
        });

        // Start processing queue if not already running
        this._processQueue();
    }

    /**
     * Process write queue sequentially
     */
    async _processQueue() {
        if (this._isProcessingQueue) return;
        this._isProcessingQueue = true;

        while (this._writeQueue.length > 0) {
            const job = this._writeQueue.shift();
            await this._writeToken(job);
        }

        this._isProcessingQueue = false;
    }

    /**
     * Actually write a token to disk
     */
    async _writeToken(job) {
        const { fileIndex, tokenMeta, attentionBuffer } = job;

        try {
            // Write metadata JSON (tiny, fast)
            const metaResponse = await fetch(
                `${CAPTURE_SERVER}/capture?action=write_token_meta&ts=${this.captureTimestamp}&index=${fileIndex}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(tokenMeta)
                }
            );

            if (!metaResponse.ok) {
                console.warn(`⚠️  Failed to write token meta ${fileIndex}: ${metaResponse.statusText}`);
            }

            // Write attention binary
            if (attentionBuffer) {
                const binResponse = await fetch(
                    `${CAPTURE_SERVER}/capture?action=write_token_attn&ts=${this.captureTimestamp}&index=${fileIndex}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/octet-stream' },
                        body: attentionBuffer
                    }
                );

                if (!binResponse.ok) {
                    console.warn(`⚠️  Failed to write attention ${fileIndex}: ${binResponse.statusText}`);
                }
            }

            this.tokenCount++;

        } catch (err) {
            console.warn(`⚠️  Error writing token ${fileIndex}:`, err);
        }
    }

    /**
     * Stop capture and export conversation state snapshot
     * Data is already on disk, this adds the final state export
     * @param {Object} conversationState - Full conversation state to export
     * @returns {Object} Capture summary
     */
    async stopCapture(conversationState = null) {
        if (!this.isCapturing) {
            console.warn('No active capture session');
            return null;
        }

        // Export conversation state snapshot to capture folder
        if (conversationState) {
            await this._writeStateSnapshot(conversationState);
        }

        this.isCapturing = false;
        const summary = {
            capture_dir: this.captureDir,
            tokens_captured: this.tokenCount,
            timestamp: this.captureTimestamp
        };

        console.log(`✅ Capture complete: ${this.tokenCount} tokens written to ${this.captureDir}`);

        return summary;
    }

    /**
     * Write conversation state snapshot to capture directory
     * @param {Object} state - Conversation state from exportState()
     */
    async _writeStateSnapshot(state) {
        if (!this.captureTimestamp) return;

        console.log('📸 Writing conversation state snapshot...');

        try {
            const response = await fetch(
                `${CAPTURE_SERVER}/capture?action=write_state&ts=${this.captureTimestamp}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(state)
                }
            );

            if (!response.ok) {
                throw new Error(`Failed to write state: ${response.statusText}`);
            }

            console.log('✅ State snapshot written');

        } catch (err) {
            console.error('❌ Failed to write state snapshot:', err);
        }
    }

    /**
     * Get current capture status
     */
    getStatus() {
        if (!this.isCapturing) {
            return { capturing: false };
        }

        return {
            capturing: true,
            capture_dir: this.captureDir,
            tokens_written: this.tokenCount
        };
    }
}
