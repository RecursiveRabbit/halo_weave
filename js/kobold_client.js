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
        const response = await fetch(`${this.baseUrl}/api/v1/model/info`);
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
     * @param {Array<number>} inputIds - Input token IDs
     * @param {Object} config - Generation config
     * @param {Function} onToken - Callback for each token: (tokenId, text, attention) => void
     * @param {Function} onDone - Callback when generation completes
     * @param {Function} onError - Callback for errors
     */
    async generateStream(inputIds, config, onToken, onDone, onError) {
        // Close existing connection if any
        if (this.ws) {
            this.ws.close();
        }

        // Open WebSocket connection
        const wsUrl = this.baseUrl.replace('http://', 'ws://').replace('https://', 'wss://');
        this.ws = new WebSocket(`${wsUrl}/api/v1/generate/stream`);

        this.ws.onopen = () => {
            // Send generation request
            const request = {
                type: 'generate',
                request_id: this._generateRequestId(),
                input_ids: inputIds,
                max_new_tokens: config.maxNewTokens || 50,
                temperature: config.temperature || 0.7,
                top_p: config.topP || 0.9,
                top_k: config.topK || 40,
                repetition_penalty: config.repetitionPenalty || 1.0,
                stop_tokens: config.stopTokens || [],
                banned_tokens: config.bannedTokens || [],
                return_attention: config.returnAttention !== false,
                attention_format: 'per_layer'
            };

            this.ws.send(JSON.stringify(request));
        };

        this.ws.onmessage = (event) => {
            const data = JSON.parse(event.data);

            if (data.type === 'token') {
                // Decode attention if present
                let attention = null;
                if (data.attention && config.returnAttention !== false) {
                    attention = this._decodeAttention(data.attention);
                }

                // Call token callback
                onToken(data.token.token_id, data.token.text, attention);

            } else if (data.type === 'done') {
                this.ws.close();
                onDone(data);

            } else if (data.type === 'error') {
                this.ws.close();
                onError(new Error(data.error));
            }
        };

        this.ws.onerror = (event) => {
            onError(new Error('WebSocket error'));
        };

        this.ws.onclose = (event) => {
            if (!event.wasClean) {
                onError(new Error('WebSocket connection closed unexpectedly'));
            }
        };
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
     * Close WebSocket connection
     */
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    /**
     * Check if server is reachable
     * @returns {Promise<boolean>} True if reachable
     */
    async ping() {
        try {
            const response = await fetch(`${this.baseUrl}/api/v1/model/info`, {
                method: 'GET',
                signal: AbortSignal.timeout(5000)
            });
            return response.ok;
        } catch (err) {
            return false;
        }
    }
}
