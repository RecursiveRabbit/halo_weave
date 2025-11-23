/**
 * KoboldClient - API Adapter for KoboldCPP
 *
 * Handles all communication with KoboldCPP server:
 * - REST API for model info, tokenization
 * - WebSocket for streaming generation
 * - Base64 attention tensor decoding
 */

export class KoboldClient {
    constructor(baseUrl = 'http://localhost:5001') {
        this.baseUrl = baseUrl;
        this.ws = null;
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
     * Uses SSE (Server-Sent Events) instead of WebSocket
     * @param {Array<number>} inputIds - Input token IDs
     * @param {Object} config - Generation config
     * @param {Function} onToken - Callback for each token: (tokenId, text, attention) => void
     * @param {Function} onDone - Callback when generation completes
     * @param {Function} onError - Callback for errors
     */
    async generateStream(inputIds, config, onToken, onDone, onError) {
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

            while (true) {
                const { done, value } = await reader.read();

                if (done) break;

                // Decode chunk and add to buffer
                buffer += decoder.decode(value, { stream: true });

                // Process complete SSE messages
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // Keep incomplete line in buffer

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const jsonData = line.slice(6); // Remove 'data: ' prefix

                        try {
                            const data = JSON.parse(jsonData);

                            if (data.type === 'token') {
                                // Decode attention if present
                                let attention = null;
                                if (data.attention && config.returnAttention !== false) {
                                    attention = this._decodeAttention(data.attention);
                                }

                                // Call token callback
                                onToken(data.token.token_id, data.token.text, attention);

                            } else if (data.type === 'done') {
                                onDone(data);
                                return;

                            } else if (data.finish_reason) {
                                // Old format: {token: "text", finish_reason: "length"}
                                if (data.token) {
                                    // This is the last token
                                    onToken(null, data.token, null);
                                }
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
        // Decode base64 to binary
        const binaryString = atob(attentionInfo.data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        // Convert to Float32Array
        const floats = new Float32Array(bytes.buffer);

        // Reshape according to provided shape
        // Note: JavaScript doesn't have native multi-dimensional arrays,
        // so we keep it as flat array but store shape metadata
        return {
            data: floats,
            shape: attentionInfo.shape,  // [layers, heads, context_length]
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
