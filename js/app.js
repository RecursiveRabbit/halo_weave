/**
 * App - Main Application Controller
 *
 * Coordinates all components:
 * - KoboldClient for API communication
 * - ConversationState for token management
 * - AttentionTracker for attention processing
 * - Heatmap for visualization
 */

import { KoboldClient } from './kobold_client.js';
import { ConversationState } from './conversation_state.js';
import { AttentionTracker } from './attention_tracker.js';
import { Heatmap } from './heatmap.js';
import { DataCapture } from './data_capture.js';

class App {
    constructor() {
        // Core components
        this.client = new KoboldClient('http://localhost:5001');
        this.conversation = new ConversationState();
        this.tracker = new AttentionTracker();
        this.heatmap = new Heatmap(document.getElementById('heatmap'));
        this.dataCapture = new DataCapture();

        // UI elements
        this.userInput = document.getElementById('user-input');
        this.sendButton = document.getElementById('send-button');
        this.clearButton = document.getElementById('clear-button');
        this.statusElement = document.getElementById('status');
        this.statsElement = document.getElementById('stats');

        // State
        this.isGenerating = false;
        this.modelInfo = null;
        this.config = this._loadConfig();

        // Bind event handlers
        this._bindEvents();
    }

    /**
     * Initialize the application
     */
    async initialize() {
        this._updateStatus('Connecting to KoboldCPP...', 'info');

        try {
            // Check if server is reachable
            const reachable = await this.client.ping();
            if (!reachable) {
                throw new Error('KoboldCPP server not reachable at http://localhost:5001');
            }

            // Get model info
            this.modelInfo = await this.client.getModelInfo();
            this._updateStatus(`Connected: ${this.modelInfo.model_name}`, 'success');

            // Update tracker config with model info if needed
            this._updateTrackerFromUI();

            // Add system message
            await this._addSystemMessage();

        } catch (err) {
            this._updateStatus(`Error: ${err.message}`, 'error');
            console.error('Initialization error:', err);
        }
    }

    /**
     * Send user message and generate response
     */
    async sendMessage() {
        const text = this.userInput.value.trim();
        if (!text || this.isGenerating) return;

        this.isGenerating = true;
        this.sendButton.disabled = true;
        this.userInput.disabled = true;

        try {
            // Tokenize user message with ChatML format
            this._updateStatus('Tokenizing...', 'info');
            const formattedText = `<|im_start|>user\n${text}<|im_end|>\n`;
            const tokens = await this.client.tokenize(formattedText);

            // Add to conversation
            this.heatmap.startTurn(this.conversation.currentTurnId, 'user');
            const startIndex = this.conversation.tokens.length;
            this.conversation.addMessage('user', tokens);
            const endIndex = this.conversation.tokens.length;
            for (let i = startIndex; i < endIndex; i++) {
                this.heatmap.addToken(this.conversation.tokens[i]);
            }
            this.conversation.nextTurn();

            // Clear input
            this.userInput.value = '';

            // Generate response
            this._updateStatus('Generating...', 'info');
            await this._generateResponse();

        } catch (err) {
            this._updateStatus(`Error: ${err.message}`, 'error');
            console.error('Send message error:', err);
        } finally {
            this.isGenerating = false;
            this.sendButton.disabled = false;
            this.userInput.disabled = false;
            this.userInput.focus();
        }
    }

    /**
     * Generate assistant response
     */
    async _generateResponse() {
        // Start new turn for assistant
        this.heatmap.startTurn(this.conversation.currentTurnId, 'Qwen');

        // Add assistant start token
        const assistantStart = await this.client.tokenize('<|im_start|>assistant\n');
        const startIndex = this.conversation.tokens.length;
        this.conversation.addMessage('Qwen', assistantStart);
        const endIndex = this.conversation.tokens.length;
        for (let i = startIndex; i < endIndex; i++) {
            this.heatmap.addToken(this.conversation.tokens[i]);
        }

        // Get input IDs
        const inputIds = this.conversation.getInputIds();
        const indexToPosition = this.conversation.buildIndexToPositionMap();

        // Build generation config
        const config = {
            maxNewTokens: parseInt(document.getElementById('max-length').value) || 50,
            temperature: parseFloat(document.getElementById('temperature').value) || 0.7,
            topP: parseFloat(document.getElementById('top-p').value) || 0.9,
            returnAttention: true,
            bannedTokens: this.modelInfo?.special_tokens?.im_start_id ?
                [this.modelInfo.special_tokens.im_start_id] : []
        };

        let tokenCount = 0;

        // If capturing, record prompt tokens
        if (this.dataCapture.isCapturing) {
            this.dataCapture.recordPromptTokens(this.conversation.getActiveTokens());
        }

        // Stream generation
        await this.client.generateStream(
            inputIds,
            config,
            // onToken callback
            (tokenId, text, attention) => {
                // Add token to conversation
                this.conversation.addToken(tokenId, text);
                const newToken = this.conversation.tokens[this.conversation.tokens.length - 1];

                // Capture full attention data if recording
                if (this.dataCapture.isCapturing && attention) {
                    this.dataCapture.recordGeneratedToken(newToken, attention, tokenCount);
                }

                // Update attention if available
                if (attention) {
                    this.tracker.updateAttention(
                        attention,
                        newToken.position,
                        this.conversation
                    );
                }

                // Render token
                this.heatmap.addToken(newToken);

                // Update all token colors
                this.heatmap.updateAll(this.conversation);

                tokenCount++;
                this._updateStatus(`Generated ${tokenCount} tokens...`, 'info');
                this._updateStats();
            },
            // onDone callback
            (data) => {
                this._updateStatus(`Generation complete (${tokenCount} tokens)`, 'success');
                this.conversation.nextTurn();
                this.tracker.reset();

                // Check if pruning needed
                this._checkPruning();

                this.heatmap.scrollToBottom();
            },
            // onError callback
            (err) => {
                this._updateStatus(`Generation error: ${err.message}`, 'error');
                console.error('Generation error:', err);
            }
        );
    }

    /**
     * Check if pruning is needed and execute
     */
    _checkPruning() {
        const maxTokens = parseInt(document.getElementById('max-context-tokens').value);
        if (!maxTokens || maxTokens === 0) return;

        const stats = this.conversation.getStats();
        if (stats.active_tokens <= maxTokens) return;

        // Prune sentences until under threshold
        let iterations = 0;
        const maxIterations = 100;

        while (this.conversation.getStats().active_tokens > maxTokens && iterations < maxIterations) {
            const sentences = this.conversation.getSentences();
            const activeSentences = sentences.filter(s => !s.fully_deleted);

            if (activeSentences.length === 0) break;

            // Find dimmest sentence
            const dimmest = activeSentences.reduce((min, s) =>
                s.max_brightness < min.max_brightness ? s : min
            );

            // Prune it
            const pruned = this.conversation.pruneSentence(
                dimmest.turn_id,
                dimmest.sentence_id,
                dimmest.message_role
            );

            // Animate pruning
            this.heatmap.animatePruning(
                dimmest.turn_id,
                dimmest.sentence_id,
                dimmest.message_role
            );

            console.log(`Pruned sentence (turn ${dimmest.turn_id}, sentence ${dimmest.sentence_id}): ${pruned} tokens, brightness ${dimmest.max_brightness.toFixed(4)}`);

            iterations++;
        }

        if (iterations > 0) {
            this._updateStatus(`Pruned ${iterations} sentences`, 'info');
            this._updateStats();
        }
    }

    /**
     * Add system message to conversation
     */
    async _addSystemMessage() {
        const systemPrompt = document.getElementById('system-prompt').value;

        // Format with ChatML tokens: <|im_start|>system\n{prompt}<|im_end|>\n
        const formattedPrompt = `<|im_start|>system\n${systemPrompt}<|im_end|>\n`;
        const tokens = await this.client.tokenize(formattedPrompt);

        this.heatmap.startTurn(this.conversation.currentTurnId, 'system');
        const startIndex = this.conversation.tokens.length;
        this.conversation.addMessage('system', tokens);
        const endIndex = this.conversation.tokens.length;
        for (let i = startIndex; i < endIndex; i++) {
            this.heatmap.addToken(this.conversation.tokens[i]);
        }
        this.conversation.nextTurn();
    }

    /**
     * Clear conversation
     */
    async clearConversation() {
        if (this.isGenerating) return;

        this.conversation.clear();
        this.tracker.reset();
        this.heatmap.clear();

        await this._addSystemMessage();

        this._updateStatus('Conversation cleared', 'info');
        this._updateStats();
    }

    /**
     * Update status message
     */
    _updateStatus(message, type = 'info') {
        this.statusElement.textContent = message;
        this.statusElement.className = `status ${type}`;
    }

    /**
     * Update statistics display
     */
    _updateStats() {
        const stats = this.heatmap.getStats(this.conversation);
        this.statsElement.innerHTML = `
            <div>Total: ${stats.total_tokens} | Active: ${stats.active_tokens} | Deleted: ${stats.deleted_tokens}</div>
            <div>Turns: ${stats.turns} | Avg Brightness: ${(stats.avgBrightness * 100).toFixed(1)}%</div>
            <div>Min: ${(stats.minBrightness * 100).toFixed(1)}% | Max: ${(stats.maxBrightness * 100).toFixed(1)}%</div>
        `;
    }

    /**
     * Update tracker configuration from UI
     */
    _updateTrackerFromUI() {
        this.tracker.updateConfig({
            aggregationMode: document.getElementById('aggregation-mode').value,
            decayMode: document.getElementById('decay-mode').value,
            decayRate: parseFloat(document.getElementById('decay-rate').value),
            distanceWeightMode: document.getElementById('distance-mode').value,
            minDistance: parseInt(document.getElementById('min-distance').value),
            distanceScale: parseFloat(document.getElementById('distance-scale').value),
            boostMultiplier: parseFloat(document.getElementById('boost-multiplier').value)
        });
    }

    /**
     * Bind UI event handlers
     */
    _bindEvents() {
        // Send message
        this.sendButton.addEventListener('click', () => this.sendMessage());
        this.userInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        // Clear conversation
        this.clearButton.addEventListener('click', () => this.clearConversation());

        // Settings changes
        document.querySelectorAll('input, select').forEach(el => {
            el.addEventListener('change', () => {
                this._updateTrackerFromUI();
                this._saveConfig();
            });
        });

        // Export data
        document.getElementById('export-button')?.addEventListener('click', () => {
            const data = this.conversation.exportState();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `halo_weave_${Date.now()}.json`;
            a.click();
        });

        // Data capture buttons
        document.getElementById('start-capture-button')?.addEventListener('click', async () => {
            const status = document.getElementById('capture-status');
            const startBtn = document.getElementById('start-capture-button');
            const stopBtn = document.getElementById('stop-capture-button');

            status.textContent = '🎬 Starting capture...';
            startBtn.disabled = true;

            try {
                await this.dataCapture.startCapture({
                    model: this.modelInfo?.model_name || 'unknown',
                    description: 'Attention pattern analysis experiment',
                    config: {
                        max_length: parseInt(document.getElementById('max-length').value),
                        temperature: parseFloat(document.getElementById('temperature').value),
                        top_p: parseFloat(document.getElementById('top-p').value)
                    }
                });

                startBtn.style.display = 'none';
                stopBtn.style.display = 'block';
                startBtn.disabled = false;
                status.textContent = '🔴 Recording to disk...';
            } catch (err) {
                status.textContent = `❌ Failed to start: ${err.message}`;
                startBtn.disabled = false;
                console.error('Capture start error:', err);
            }
        });

        document.getElementById('stop-capture-button')?.addEventListener('click', () => {
            const summary = this.dataCapture.stopCapture();
            const status = document.getElementById('capture-status');
            const startBtn = document.getElementById('start-capture-button');
            const stopBtn = document.getElementById('stop-capture-button');

            stopBtn.style.display = 'none';
            startBtn.style.display = 'block';

            if (summary) {
                status.textContent = `✅ Saved ${summary.tokens_captured} tokens to ${summary.capture_dir}`;
            }
        });
    }

    /**
     * Load configuration from localStorage
     */
    _loadConfig() {
        const saved = localStorage.getItem('halo_weave_config');
        if (saved) {
            try {
                const config = JSON.parse(saved);
                // Apply to UI
                Object.keys(config).forEach(key => {
                    const el = document.getElementById(key);
                    if (el) el.value = config[key];
                });
                return config;
            } catch (err) {
                console.warn('Failed to load config:', err);
            }
        }
        return {};
    }

    /**
     * Save configuration to localStorage
     */
    _saveConfig() {
        const config = {};
        document.querySelectorAll('input[id], select[id]').forEach(el => {
            config[el.id] = el.value;
        });
        localStorage.setItem('halo_weave_config', JSON.stringify(config));
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.initialize();

    // Make app globally accessible for debugging
    window.app = app;
});
