/**
 * AttentionTracker - Attention Aggregation and Decay
 *
 * Processes RAW PRE-SOFTMAX LOGITS from KoboldCPP:
 * - Input: Raw logits (typically -100 to +100, can be negative!)
 * - Aggregates across layers/heads (mean, max, weighted, last_layer)
 * - Applies distance weighting (filters local attention noise)
 * - Accumulates scores over time with optional decay
 * - NO CLAMPING: Negative scores represent "dark" tokens naturally
 * - Updates conversation state with new scores
 */

export class AttentionTracker {
    constructor(config = {}) {
        this.config = {
            // Aggregation mode: 'mean', 'max', 'last_layer', 'weighted_layers'
            aggregationMode: config.aggregationMode || 'mean',

            // Decay settings
            decayMode: config.decayMode || 'additive',  // 'additive', 'none', 'exponential'
            decayRate: config.decayRate || 0.003,

            // Distance weighting (filter local attention)
            distanceWeightMode: config.distanceWeightMode || 'logarithmic',
            minDistance: config.minDistance || 20,
            distanceScale: config.distanceScale || 10.0,

            // Normalization
            normalize: config.normalize !== false,
            scalingMode: config.scalingMode || 'linear',
            scalingFactor: config.scalingFactor || 1.0,
            boostMultiplier: config.boostMultiplier || 1.0
        };

        this.step = 0;
    }

    /**
     * Update attention scores for all tokens
     * @param {Object} attention - Decoded attention tensor from KoboldClient
     * @param {number} newTokenPosition - Position of newly generated token
     * @param {ConversationState} conversationState - Conversation state to update
     */
    updateAttention(attention, newTokenPosition, conversationState) {
        const indexToPosition = conversationState.buildIndexToPositionMap();
        const activeTokens = conversationState.getActiveTokens();

        // Aggregate attention across layers/heads
        const aggregated = this._aggregateAttention(attention);

        // Apply distance weighting and decay, update scores
        for (let i = 0; i < aggregated.length; i++) {
            const position = indexToPosition.get(i);
            if (position === undefined) continue;

            const token = conversationState.tokens[position];
            if (!token) continue;

            // Calculate distance from generation head
            const distance = newTokenPosition - position;

            // Apply distance weighting
            const weightedAttention = this._applyDistanceWeight(
                aggregated[i],
                distance
            );

            // Update score with decay
            const oldScore = token.attention_score;
            const decay = this._calculateDecay(oldScore, this.step);
            let newScore = oldScore + weightedAttention - decay;

            // NO CLAMPING: Raw logits can be negative!
            // Negative scores = "dark" tokens (not attended to)
            // Positive scores = "bright" tokens (actively attended)
            // This is MORE informative than normalized [0, 1] range

            // Update token
            conversationState.updateAttentionScore(position, newScore, aggregated[i]);
        }

        this.step++;
    }

    /**
     * Aggregate attention across layers and heads
     * @param {Object} attention - {data: Float32Array, shape: [layers, heads, contextLen]}
     * @returns {Float32Array} Aggregated attention [contextLen]
     */
    _aggregateAttention(attention) {
        const [layers, heads, contextLen] = attention.shape;
        const data = attention.data;
        const result = new Float32Array(contextLen);

        if (this.config.aggregationMode === 'mean') {
            // Average across all layers and heads
            for (let i = 0; i < contextLen; i++) {
                let sum = 0;
                for (let l = 0; l < layers; l++) {
                    for (let h = 0; h < heads; h++) {
                        const idx = l * heads * contextLen + h * contextLen + i;
                        sum += data[idx];
                    }
                }
                result[i] = sum / (layers * heads);
            }

        } else if (this.config.aggregationMode === 'max') {
            // Max across all layers and heads
            for (let i = 0; i < contextLen; i++) {
                let max = 0;
                for (let l = 0; l < layers; l++) {
                    for (let h = 0; h < heads; h++) {
                        const idx = l * heads * contextLen + h * contextLen + i;
                        max = Math.max(max, data[idx]);
                    }
                }
                result[i] = max;
            }

        } else if (this.config.aggregationMode === 'last_layer') {
            // Only last layer, average across heads
            const lastLayer = layers - 1;
            for (let i = 0; i < contextLen; i++) {
                let sum = 0;
                for (let h = 0; h < heads; h++) {
                    const idx = lastLayer * heads * contextLen + h * contextLen + i;
                    sum += data[idx];
                }
                result[i] = sum / heads;
            }

        } else if (this.config.aggregationMode === 'weighted_layers') {
            // Weight later layers more heavily (linear 0.5 -> 1.5)
            for (let i = 0; i < contextLen; i++) {
                let weightedSum = 0;
                let totalWeight = 0;
                for (let l = 0; l < layers; l++) {
                    const weight = 0.5 + (l / layers);  // 0.5 to 1.5
                    for (let h = 0; h < heads; h++) {
                        const idx = l * heads * contextLen + h * contextLen + i;
                        weightedSum += data[idx] * weight;
                        totalWeight += weight;
                    }
                }
                result[i] = weightedSum / totalWeight;
            }
        }

        return result;
    }

    /**
     * Apply distance-based weighting to filter local attention
     * @param {number} rawAttention - Raw attention value
     * @param {number} distance - Distance from generation head
     * @returns {number} Weighted attention
     */
    _applyDistanceWeight(rawAttention, distance) {
        if (this.config.distanceWeightMode === 'none') {
            return rawAttention;
        }

        // Filter out local attention (structural noise)
        if (distance < this.config.minDistance) {
            return 0.0;  // Just decay, no accumulation
        }

        let multiplier = 1.0;

        if (this.config.distanceWeightMode === 'threshold') {
            // Binary: 0 below threshold, 1 above
            multiplier = distance >= this.config.minDistance ? 1.0 : 0.0;

        } else if (this.config.distanceWeightMode === 'linear') {
            // Linear scaling
            multiplier = distance / this.config.distanceScale;

        } else if (this.config.distanceWeightMode === 'logarithmic') {
            // Logarithmic scaling (recommended)
            multiplier = Math.log(distance + 1) / Math.log(this.config.distanceScale + 1);

        } else if (this.config.distanceWeightMode === 'square_root') {
            // Square root scaling
            multiplier = Math.sqrt(distance) / Math.sqrt(this.config.distanceScale);
        }

        return rawAttention * multiplier * this.config.boostMultiplier;
    }

    /**
     * Calculate decay amount for this step
     * @param {number} currentScore - Current attention score
     * @param {number} step - Current generation step
     * @returns {number} Decay amount to subtract
     */
    _calculateDecay(currentScore, step) {
        if (this.config.decayMode === 'none') {
            return 0.0;
        }

        if (this.config.decayMode === 'additive') {
            // Fixed decay per step
            return this.config.decayRate;
        }

        if (this.config.decayMode === 'exponential') {
            // Exponential decay
            return currentScore * this.config.decayRate;
        }

        return 0.0;
    }

    /**
     * Normalize all attention scores in conversation
     * @param {ConversationState} conversationState - Conversation to normalize
     */
    normalize(conversationState) {
        if (!this.config.normalize) {
            return;
        }

        const activeTokens = conversationState.getActiveTokens();
        if (activeTokens.length === 0) return;

        // Find min and max
        let min = Infinity;
        let max = -Infinity;
        for (const token of activeTokens) {
            min = Math.min(min, token.attention_score);
            max = Math.max(max, token.attention_score);
        }

        // Avoid division by zero
        if (max === min) return;

        // Normalize to [0, 1]
        const range = max - min;
        for (const token of activeTokens) {
            const normalized = (token.attention_score - min) / range;
            token.attention_score = normalized;
        }
    }

    /**
     * Reset tracker state
     */
    reset() {
        this.step = 0;
    }

    /**
     * Update configuration
     * @param {Object} newConfig - New config values
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
    }

    /**
     * Get current configuration
     * @returns {Object} Current config
     */
    getConfig() {
        return { ...this.config };
    }
}
