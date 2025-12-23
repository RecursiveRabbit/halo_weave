/**
 * KoboldClient - API Adapter for KoboldCPP
 *
 * Handles all communication with KoboldCPP server:
 * - REST API for model info, tokenization
 * - SSE for streaming generation with base64-encoded attention
 */

export class KoboldClient {
    constructor(baseUrl = 'http://localhost:5001') {
        this.baseUrl = baseUrl;
        this.modelInfo = null;
    }


    /**
     * Get model information (architecture, special tokens, etc.)
     * @returns {Promise<Object>} Model info
     */
    async getModelInfo() {
        const response = await fetch(`${this.baseUrl}/api/v1/model`);
        if (!response.ok) {
            throw new Error(`Failed to get model info: ${response.statusText}`);
        }
        this.modelInfo = await response.json();
        return this.modelInfo;
    }


    /**
     * Tokenize text using the model's tokenizer
     * @param {string} text - Text to tokenize
     * @param {boolean} addSpecialTokens - Whether to add special tokens
     * @returns {Promise<Array>} Array of {token_id, text}
     */
    async tokenize(text, addSpecialTokens = false) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        try {
            console.log('🔤 tokenize() starting...');
            // Use text/plain to avoid CORS preflight (server still parses as JSON)
            const response = await fetch(`${this.baseUrl}/api/v1/tokenize`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain'
                },
                body: JSON.stringify({
                    text: text,
                    add_special_tokens: addSpecialTokens
                }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            console.log('🔤 tokenize() got response:', response.status);

            if (!response.ok) {
                throw new Error(`Tokenization failed: ${response.statusText}`);
            }

            const data = await response.json();
            console.log('🔤 tokenize() complete, got', data.tokens?.length, 'tokens');
            return data.tokens;  // Array of {token_id, text}
        } catch (err) {
            clearTimeout(timeoutId);
            if (err.name === 'AbortError') {
                throw new Error('Tokenization timed out after 5s');
            }
            throw err;
        }
    }

    /**
     * Detokenize token IDs back to text
     * @param {Array<number>} tokenIds - Token IDs
     * @returns {Promise<string>} Detokenized text
     */
    async detokenize(tokenIds) {
        const response = await fetch(`${this.baseUrl}/api/v1/detokenize`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                token_ids: tokenIds
            })
        });

        if (!response.ok) {
            throw new Error(`Detokenization failed: ${response.statusText}`);
        }

        const data = await response.json();
        return data.text;
    }

    /**
     * Stream generation with attention extraction
     * Uses SSE (Server-Sent Events) with base64-encoded attention
     * @param {Array<number>} inputIds - Input token IDs
     * @param {Object} config - Generation config
     * @param {Function} onToken - Callback for each token: (tokenId, text, attention) => void
     * @param {Function} onDone - Callback when generation completes
     * @param {Function} onError - Callback for errors
     */
    async generateStream(inputIds, config, onToken, onDone, onError) {
        return this._generateStreamSSE(inputIds, config, onToken, onDone, onError);
    }


    /**
     * SSE streaming with base64-encoded attention
     */
    async _generateStreamSSE(inputIds, config, onToken, onDone, onError) {
        try {
            const requestId = this._generateRequestId();

            const response = await fetch(`${this.baseUrl}/api/extra/generate/stream`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream'
                },
                body: JSON.stringify({
                    input_ids: inputIds,
                    max_length: config.maxNewTokens || 50,
                    temperature: config.temperature || 0.7,
                    top_p: config.topP || 0.9,
                    top_k: config.topK || 40,
                    rep_pen: config.repetitionPenalty || 1.0,
                    output_attentions: config.returnAttention !== false,
                    request_id: requestId,
                    sampler_seed: config.seed || -1
                })
            });

            if (!response.ok) {
                throw new Error(`Generation failed: ${response.statusText}`);
            }

            // Parse SSE stream
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            this._jsonParseTime = 0;
            this._bufferOpTime = 0;

            while (true) {
                const { done, value } = await reader.read();

                if (done) break;

                // Decode chunk and add to buffer
                let t0 = performance.now();
                buffer += decoder.decode(value, { stream: true });

                // Process complete SSE messages
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // Keep incomplete line in buffer
                this._bufferOpTime += performance.now() - t0;

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const jsonData = line.slice(6); // Remove 'data: ' prefix

                        try {
                            t0 = performance.now();
                            const data = JSON.parse(jsonData);
                            this._jsonParseTime += performance.now() - t0;

                            if (data.type === 'token') {
                                // Decode attention if present
                                let attention = null;
                                if (data.attention && config.returnAttention !== false) {
                                    const t0 = performance.now();
                                    attention = this._decodeAttentionSSE(data.attention);
                                    this._decodeTime = (this._decodeTime || 0) + (performance.now() - t0);
                                    this._decodeCount = (this._decodeCount || 0) + 1;
                                }

                                // Call token callback
                                onToken(data.token.token_id, data.token.text, attention);

                            } else if (data.type === 'done') {
                                // Log decode timing
                                const n = this._decodeCount || 1;
                                console.log(`📊 SSE Processing breakdown:`);
                                console.log(`   Buffer ops:    ${(this._bufferOpTime/1000).toFixed(1)}s (${(this._bufferOpTime/n).toFixed(1)}ms/token)`);
                                console.log(`   JSON parse:    ${(this._jsonParseTime/1000).toFixed(1)}s (${(this._jsonParseTime/n).toFixed(1)}ms/token)`);
                                console.log(`   Base64 decode: ${(this._decodeTime/1000).toFixed(1)}s (${(this._decodeTime/n).toFixed(1)}ms/token)`);
                                this._decodeTime = 0;
                                this._decodeCount = 0;
                                this._jsonParseTime = 0;
                                this._bufferOpTime = 0;
                                onDone(data);
                                return;

                            } else if (data.finish_reason) {
                                // Old format: {token: "text", finish_reason: "length"}
                                if (data.token) {
                                    // This is the last token
                                    onToken(null, data.token, null);
                                }
                                // Log timing
                                const n = this._decodeCount || 1;
                                console.log(`📊 SSE Processing breakdown:`);
                                console.log(`   Buffer ops:    ${(this._bufferOpTime/1000).toFixed(1)}s (${(this._bufferOpTime/n).toFixed(1)}ms/token)`);
                                console.log(`   JSON parse:    ${(this._jsonParseTime/1000).toFixed(1)}s (${(this._jsonParseTime/n).toFixed(1)}ms/token)`);
                                console.log(`   Base64 decode: ${(this._decodeTime/1000).toFixed(1)}s (${(this._decodeTime/n).toFixed(1)}ms/token)`);
                                this._decodeTime = 0;
                                this._decodeCount = 0;
                                this._jsonParseTime = 0;
                                this._bufferOpTime = 0;
                                onDone({ finish_reason: data.finish_reason, request_id: requestId });
                                return;
                            }
                        } catch (parseError) {
                            console.warn('Failed to parse SSE data:', jsonData, parseError);
                        }
                    }
                }
            }

            // If we reach here without a done event, still call onDone
            // Log decode timing
            if (this._decodeCount) {
                console.log(`🔓 Base64 decode: ${(this._decodeTime/1000).toFixed(1)}s total (${(this._decodeTime/this._decodeCount).toFixed(1)}ms/token)`);
                this._decodeTime = 0;
                this._decodeCount = 0;
            }
            onDone({ finish_reason: 'complete', request_id: requestId });

        } catch (error) {
            onError(error);
        }
    }

    /**
     * Decode base64-encoded attention tensor from SSE response
     * @param {Object} attentionInfo - Attention data from server
     * @returns {Object} Attention object with {data, shape, contextLength}
     */
    _decodeAttentionSSE(attentionInfo) {
        // Decode base64 to binary - use native fetch for speed
        const binaryString = atob(attentionInfo.data);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        
        // Unrolled loop - process 4 bytes at a time
        let i = 0;
        const len4 = len - 3;
        for (; i < len4; i += 4) {
            bytes[i] = binaryString.charCodeAt(i);
            bytes[i+1] = binaryString.charCodeAt(i+1);
            bytes[i+2] = binaryString.charCodeAt(i+2);
            bytes[i+3] = binaryString.charCodeAt(i+3);
        }
        // Handle remaining bytes
        for (; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        // Convert to Float32Array (zero-copy view)
        const floats = new Float32Array(bytes.buffer);

        return {
            data: floats,
            shape: attentionInfo.shape,
            contextLength: attentionInfo.context_length
        };
    }

    /**
     * Generate a unique request ID
     * @returns {string} UUID
     */
    _generateRequestId() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    /**
     * Close any active connections and abort pending operations
     */
    disconnect() {
        // No persistent connections in SSE-only mode
    }

    /**
     * Abort any active generation
     */
    abort() {
        // No persistent connections in SSE-only mode
    }

    /**
     * Check if server is reachable
     * @returns {Promise<boolean>} True if reachable
     */
    async ping() {
        try {
            const response = await fetch(`${this.baseUrl}/api/v1/model`, {
                method: 'GET',
                signal: AbortSignal.timeout(5000)
            });
            return response.ok;
        } catch (err) {
            return false;
        }
    }
}
