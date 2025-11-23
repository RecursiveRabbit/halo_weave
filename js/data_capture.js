/**
 * DataCapture - Stream-to-Disk Attention Data Recording
 *
 * Writes attention data incrementally to disk as tokens generate.
 * No memory accumulation - each token written immediately.
 */

const CAPTURE_SERVER = 'http://127.0.0.1:8081';

export class DataCapture {
    constructor() {
        this.isCapturing = false;
        this.captureTimestamp = null;
        this.captureDir = null;
        this.tokenCount = 0;
    }

    /**
     * Start a new capture session
     * Creates directory and initializes metadata
     * @param {Object} metadata - Experiment metadata
     */
    async startCapture(metadata = {}) {
        this.captureTimestamp = Date.now();
        this.tokenCount = 0;

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
     * Writes immediately to disk - no memory accumulation
     * @param {Object} token - Token object
     * @param {Object} attention - Full attention tensor from KoboldCPP
     * @param {number} generationStep - Which token in generation (0-indexed)
     */
    async recordGeneratedToken(token, attention, generationStep) {
        if (!this.isCapturing) return;

        const tokenData = {
            step: generationStep,
            token_id: token.token_id,
            text: token.text,
            position: token.position,
            timestamp: Date.now(),
            attention: null
        };

        // Include full attention tensor if available
        if (attention) {
            tokenData.attention = {
                shape: attention.shape,
                context_length: attention.contextLength,
                // Convert Float32Array to regular array for JSON serialization
                data: Array.from(attention.data)
            };
        }

        try {
            // Write token file immediately
            const response = await fetch(
                `${CAPTURE_SERVER}/capture?action=write_token&ts=${this.captureTimestamp}&index=${generationStep}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(tokenData)
                }
            );

            if (!response.ok) {
                console.warn(`⚠️  Failed to write token ${generationStep}: ${response.statusText}`);
            }

            this.tokenCount++;

        } catch (err) {
            console.warn(`⚠️  Error writing token ${generationStep}:`, err);
            // Don't stop capture, just log error
        }
    }

    /**
     * Stop capture
     * Data is already on disk, so just update status
     * @returns {Object} Capture summary
     */
    stopCapture() {
        if (!this.isCapturing) {
            console.warn('No active capture session');
            return null;
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
