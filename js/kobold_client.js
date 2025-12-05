/**
 * KoboldClient - API Adapter for KoboldCPP
 *
 * Handles all communication with KoboldCPP server:
 * - REST API for model info, tokenization
 * - WebSocket for streaming generation with binary attention
 * - Fallback SSE for compatibility
 */

export class KoboldClient {
    constructor(baseUrl = 'http://localhost:5001') {
        this.baseUrl = baseUrl;
        this.wsUrl = baseUrl.replace(/^http/, 'ws');
        this.ws = null;
        this.modelInfo = null;
        this.useWebSocket = true;  // Prefer WebSocket for binary streaming
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
        const response = await fetch(`${this.baseUrl}/api/v1/tokenize`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                text: text,
                add_special_tokens: addSpecialTokens
            })
        });

        if (!response.ok) {
            throw new Error(`Tokenization failed: ${response.statusText}`);
        }

        const data = await response.json();
        return data.tokens;  // Array of {token_id, text}
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
     * Uses WebSocket with binary frames (fast) or falls back to SSE
     * @param {Array<number>} inputIds - Input token IDs
     * @param {Object} config - Generation config
     * @param {Function} onToken - Callback for each token: (tokenId, text, attention) => void
     * @param {Function} onDone - Callback when generation completes
     * @param {Function} onError - Callback for errors
     */
    async generateStream(inputIds, config, onToken, onDone, onError) {
        if (this.useWebSocket) {
            return this._generateStreamWS(inputIds, config, onToken, onDone, onError);
        }
        return this._generateStreamSSE(inputIds, config, onToken, onDone, onError);
    }

    /**
     * WebSocket streaming with binary attention frames
     * Zero-copy attention decoding - ~99% faster than SSE+base64
     */
    async _generateStreamWS(inputIds, config, onToken, onDone, onError) {
        return new Promise((resolve, reject) => {
            const requestId = this._generateRequestId();
            let pendingToken = null;
            let tokenCount = 0;
            const startTime = performance.now();
            
            // Get model info for attention shape
            const numLayers = this.modelInfo?.num_layers || 28;
            const numHeads = this.modelInfo?.num_attention_heads || 28;
            
            const ws = new WebSocket(`${this.wsUrl}/api/extra/generate/stream/ws`);
            ws.binaryType = 'arraybuffer';
            
            ws.onopen = () => {
                // Send generation config
                ws.send(JSON.stringify({
                    input_ids: inputIds,
                    max_length: config.maxNewTokens || 50,
                    temperature: config.temperature || 0.7,
                    top_p: config.topP || 0.9,
                    top_k: config.topK || 40,
                    rep_pen: config.repetitionPenalty || 1.0,
                    request_id: requestId,
                    sampler_seed: config.seed || -1
                }));
            };
            
            ws.onmessage = (event) => {
                if (typeof event.data === 'string') {
                    // Text frame - token metadata or done
                    const data = JSON.parse(event.data);
                    
                    if (data.type === 'token') {
                        pendingToken = data;
                        tokenCount++;
                        
                        // If no attention expected, deliver token immediately
                        if (config.returnAttention === false) {
                            onToken(data.token_id, data.text, null);
                            pendingToken = null;
                        }
                    } else if (data.type === 'done') {
                        const elapsed = (performance.now() - startTime) / 1000;
                        console.log(`🚀 WebSocket streaming: ${tokenCount} tokens in ${elapsed.toFixed(1)}s (${(tokenCount/elapsed).toFixed(1)} tok/s)`);
                        ws.close();
                        onDone(data);
                        resolve();
                    }
                } else {
                    // Binary frame - raw float32 attention data
                    const floats = new Float32Array(event.data);  // Zero-copy!
                    const contextLen = floats.length / (numLayers * numHeads);
                    
                    const attention = {
                        data: floats,
                        shape: [numLayers, numHeads, contextLen],
                        contextLength: contextLen
                    };
                    
                    // Deliver token with attention
                    if (pendingToken) {
                        onToken(pendingToken.token_id, pendingToken.text, attention);
                        pendingToken = null;
                    }
                }
            };
            
            ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                console.log('Falling back to SSE...');
                this.useWebSocket = false;
                ws.close();
                // Fallback to SSE
                this._generateStreamSSE(inputIds, config, onToken, onDone, onError)
                    .then(resolve)
                    .catch(reject);
            };
            
            ws.onclose = (event) => {
                if (!event.wasClean && pendingToken) {
                    onError(new Error(`WebSocket closed unexpectedly: ${event.code}`));
                    reject(new Error(`WebSocket closed: ${event.code}`));
                }
            };
        });
    }

    /**
     * SSE streaming with base64 attention (fallback)
     * Slower but more compatible
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
                                    attention = this._decodeAttention(data.attention);
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
     * Decode base64-encoded attention tensor
     * @param {Object} attentionInfo - Attention data from server
     * @returns {Float32Array} Attention array [layers, heads, context_length]
     */
    _decodeAttention(attentionInfo) {
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
     * Close any active connections (no-op for SSE, kept for API compatibility)
     */
    disconnect() {
        // SSE connections close automatically, nothing to do
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
