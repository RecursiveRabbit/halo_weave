/**
 * Halo Weave - Main Application Controller
 * 
 * Coordinates:
 * - KoboldClient for model communication
 * - Conversation for token storage + brightness scoring
 * - Renderer for grayscale visualization
 * - DataCapture for attention recording
 */

import { KoboldClient } from './kobold_client.js';
import { Conversation } from './conversation.js';
import { Renderer } from './renderer.js';
import { DataCapture } from './data_capture.js';
import { SemanticIndex } from './semantic_index.js';

class App {
    constructor() {
        // Core components
        this.client = new KoboldClient('http://127.0.0.1:5001');
        this.conversation = new Conversation();
        this.renderer = new Renderer(document.getElementById('tokens'));
        this.capture = new DataCapture();
        this.semanticIndex = new SemanticIndex();
        
        // State
        this.isGenerating = false;
        this.generationStep = 0;
        this.totalPruned = 0;
        this.resurrectionBudget = 512;  // Max tokens to resurrect per user message
        this._statsPending = false;  // Coalesce stats updates with rAF
        
        // DOM elements
        this.elements = {
            status: document.getElementById('status'),
            userName: document.getElementById('user-name'),
            aiName: document.getElementById('ai-name'),
            systemPrompt: document.getElementById('system-prompt'),
            maxTokens: document.getElementById('max-tokens'),
            maxTokensVal: document.getElementById('max-tokens-val'),
            temperature: document.getElementById('temperature'),
            temperatureVal: document.getElementById('temperature-val'),
            topP: document.getElementById('top-p'),
            topPVal: document.getElementById('top-p-val'),
            maxContext: document.getElementById('max-context'),
            userInput: document.getElementById('user-input'),
            btnSend: document.getElementById('btn-send'),
            btnClear: document.getElementById('btn-clear'),
            btnExport: document.getElementById('btn-export'),
            btnImport: document.getElementById('btn-import'),
            importFile: document.getElementById('import-file'),
            btnStartCapture: document.getElementById('btn-start-capture'),
            btnStopCapture: document.getElementById('btn-stop-capture'),
            captureStatus: document.getElementById('capture-status'),
            statTokens: document.getElementById('stat-tokens'),
            statBrightness: document.getElementById('stat-brightness'),
            statPruned: document.getElementById('stat-pruned')
        };
        
        this._bindEvents();
        this._init();
    }

    async _init() {
        this._setStatus('Connecting...', '');
        
        try {
            const modelInfo = await this.client.getModelInfo();
            this._setStatus(`Connected: ${modelInfo.model_name || 'Unknown Model'}`, 'connected');
            console.log('Model info:', modelInfo);
        } catch (err) {
            this._setStatus('Connection failed - is KoboldCPP running?', 'error');
            console.error('Connection error:', err);
        }
        
        this._loadSettings();
        this._updateStats();
    }

    _bindEvents() {
        // Slider value displays
        this.elements.maxTokens.addEventListener('input', (e) => {
            this.elements.maxTokensVal.textContent = e.target.value;
        });
        this.elements.temperature.addEventListener('input', (e) => {
            this.elements.temperatureVal.textContent = e.target.value;
        });
        this.elements.topP.addEventListener('input', (e) => {
            this.elements.topPVal.textContent = e.target.value;
        });
        
        // Send button
        this.elements.btnSend.addEventListener('click', () => this._handleSend());
        
        // Enter to send (Shift+Enter for newline)
        this.elements.userInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this._handleSend();
            }
        });
        
        // Clear button
        this.elements.btnClear.addEventListener('click', () => this._handleClear());
        
        // Export/Import buttons
        this.elements.btnExport.addEventListener('click', () => this._handleExport());
        this.elements.btnImport.addEventListener('click', () => this.elements.importFile.click());
        this.elements.importFile.addEventListener('change', (e) => this._handleImport(e));
        
        // Capture buttons
        this.elements.btnStartCapture.addEventListener('click', () => this._handleStartCapture());
        this.elements.btnStopCapture.addEventListener('click', () => this._handleStopCapture());
        
        // Check capture server availability on load
        this._checkCaptureServer();
        
        // Save settings on change
        ['maxTokens', 'temperature', 'topP', 'maxContext', 'systemPrompt'].forEach(key => {
            this.elements[key].addEventListener('change', () => this._saveSettings());
        });
    }

    async _handleSend() {
        const text = this.elements.userInput.value.trim();
        if (!text || this.isGenerating) return;
        
        console.log('📤 _handleSend starting');
        // Don't clear input yet - wait until we know tokenization succeeded
        this.isGenerating = true;
        this.elements.btnSend.disabled = true;
        
        try {
            // Add system prompt if this is the first message
            if (this.conversation.tokens.length === 0) {
                const systemPrompt = this.elements.systemPrompt.value.trim();
                if (systemPrompt) {
                    console.log('📤 Adding system prompt...');
                    await this._addMessage('system', systemPrompt);
                    console.log('📤 System prompt added');
                }
            }
            
            // Query graveyard for relevant context before adding user message
            await this._resurrectRelevantContext(text);
            
            // Add user message
            console.log('📤 Adding user message...');
            await this._addMessage('user', text);
            console.log('📤 User message added, starting generation...');
            
            // Only clear input after user message successfully added (tokenization worked)
            this.elements.userInput.value = '';
            
            // Generate response
            await this._generate();
            
            // End assistant turn
            this.conversation.nextTurn();
            
        } catch (err) {
            console.error('Generation error:', err);
            this._setStatus('Generation failed: ' + err.message, 'error');
            // Input is preserved - user can retry after restarting KoboldCPP
        } finally {
            this.isGenerating = false;
            this.elements.btnSend.disabled = false;
        }
    }
    
    /**
     * Query semantic index and resurrect relevant pruned context
     * @param {string} userText - The user's message text
     */
    async _resurrectRelevantContext(userText) {
        // Calculate token budget for resurrection
        // Budget = resurrectionBudget - estimated user message tokens
        // Rough estimate: 4 chars per token
        const estimatedUserTokens = Math.ceil(userText.length / 4);
        const tokenBudget = Math.max(0, this.resurrectionBudget - estimatedUserTokens);
        
        if (tokenBudget <= 0) {
            console.log('📚 No resurrection budget (user message too long)');
            return;
        }
        
        // Query semantic index
        const matches = await this.semanticIndex.query(userText, {
            maxResults: 20,
            tokenBudget: tokenBudget
        });
        
        if (matches.length === 0) {
            console.log('📚 No relevant context in semantic index');
            return;
        }
        
        // Resurrect each matching chunk (only if currently dead)
        let totalResurrected = 0;
        for (const match of matches) {
            // Skip if chunk is already alive
            if (this.conversation.isChunkAlive(match.turn_id, match.sentence_id, match.role)) {
                continue;
            }
            
            const count = this.conversation.resurrectByTuple(
                match.turn_id, 
                match.sentence_id, 
                match.role
            );
            
            if (count > 0) {
                // Mark as referenced in index (for stats/pruning priority)
                this.semanticIndex.markReferenced(match.turn_id, match.sentence_id, match.role);
                totalResurrected += count;
                console.log(`📚 Resurrected ${count} tokens: "${match.text.substring(0, 50)}..." (similarity: ${match.similarity.toFixed(3)})`);
            }
        }
        
        if (totalResurrected > 0) {
            // Rebuild UI to show resurrected tokens
            this.renderer.rebuild(this.conversation);
            this._updateStats();
            console.log(`📚 Total resurrected: ${totalResurrected} tokens from semantic index`);
        }
    }

    async _addMessage(role, text) {
        // Get custom names (fall back to defaults)
        const userName = this.elements.userName.value.trim() || 'user';
        const aiName = this.elements.aiName.value.trim() || 'assistant';
        
        // Format with ChatML using custom names
        const formatted = role === 'system' 
            ? `<|im_start|>system\n${text}<|im_end|>\n`
            : role === 'user'
            ? `<|im_start|>${userName}\n${text}<|im_end|>\n`
            : text;
        
        // Tokenize
        const tokens = await this.client.tokenize(formatted);
        
        // Add to conversation
        this.conversation.addMessage(role, tokens);
        this.conversation.nextTurn();
        
        // Record prompt tokens if capturing
        if (this.capture.isCapturing && role !== 'assistant') {
            await this.capture.recordPromptTokens(this.conversation.tokens);
        }
        
        // Render
        this.renderer.rebuild(this.conversation);
        this._updateStats();
    }

    async _generate() {
        // Get custom AI name
        const aiName = this.elements.aiName.value.trim() || 'assistant';
        
        // Start AI turn
        this.conversation.currentRole = 'assistant';  // Internal role stays 'assistant'
        this.conversation.currentSentenceId = 0;
        
        // Add AI prefix with custom name
        const prefix = `<|im_start|>${aiName}\n`;
        const prefixTokens = await this.client.tokenize(prefix);
        for (const t of prefixTokens) {
            const token = this.conversation.addStreamingToken(t.token_id, t.text);
            this.renderer.addToken(token, this.conversation);
        }
        
        // Build prompt from active tokens
        const inputIds = this.conversation.getInputIds();
        
        // Generation config
        const config = {
            maxNewTokens: parseInt(this.elements.maxTokens.value),
            temperature: parseFloat(this.elements.temperature.value),
            topP: parseFloat(this.elements.topP.value),
            returnAttention: true
        };
        
        this.generationStep = 0;
        
        // Timing stats
        this._timingStats = {
            addToken: 0,
            updateBrightness: 0,
            updateColors: 0,
            renderToken: 0,
            capture: 0,
            pruning: 0,
            stats: 0,
            total: 0,
            count: 0,
            lastTokenTime: performance.now(),
            tokenGaps: 0,  // Time between tokens (network + model)
            startTime: performance.now(),
            attentionSize: 0  // Track attention data size
        };
        
        // Stream generation - callback signature: (tokenId, text, attention)
        await new Promise((resolve, reject) => {
            this.client.generateStream(
                inputIds,
                config,
                // onToken callback
                async (tokenId, text, attention) => {
                    const t0 = performance.now();
                    
                    // Measure gap since last token (network + model inference)
                    this._timingStats.tokenGaps += t0 - this._timingStats.lastTokenTime;
                    
                    // Skip if no valid token
                    if (tokenId === null && !text) return;
                    
                    // Add token to conversation
                    let t1 = performance.now();
                    const token = this.conversation.addStreamingToken(
                        tokenId,
                        text
                    );
                    this._timingStats.addToken += performance.now() - t1;
                    
                    // Update brightness if we have attention data
                    if (attention) {
                        this._timingStats.attentionSize = attention.data.length * 4;  // bytes
                        
                        t1 = performance.now();
                        this.conversation.updateBrightness(attention);
                        this._timingStats.updateBrightness += performance.now() - t1;
                        
                        t1 = performance.now();
                        this.renderer.updateColors(this.conversation);
                        this._timingStats.updateColors += performance.now() - t1;
                        
                        // Record if capturing (fire-and-forget to not block token stream)
                        if (this.capture.isCapturing) {
                            t1 = performance.now();
                            // Don't await - let writes happen in background
                            this.capture.recordGeneratedToken(
                                token,
                                attention,
                                this.generationStep
                            ).catch(err => console.warn('Capture error:', err));
                            this._timingStats.capture += performance.now() - t1;
                        }
                    }
                    
                    // Render new token
                    t1 = performance.now();
                    this.renderer.addToken(token, this.conversation);
                    this._timingStats.renderToken += performance.now() - t1;
                    
                    // Note: Pruning moved to onDone - all tokens need a chance to accumulate attention
                    
                    t1 = performance.now();
                    this._updateStats();
                    this._timingStats.stats += performance.now() - t1;
                    
                    this._timingStats.total += performance.now() - t0;
                    this._timingStats.count++;
                    this._timingStats.lastTokenTime = performance.now();
                    this.generationStep++;
                },
                // onDone callback
                async (data) => {
                    console.log('Generation complete:', data);
                    
                    // Index new chunks after generation completes
                    // This happens while user reads response (hides latency)
                    await this.semanticIndex.indexNewChunks(this.conversation);
                    
                    // Prune after generation - all tokens have had a chance to accumulate attention
                    this._checkPruning();
                    
                    // Print timing report
                    const s = this._timingStats;
                    const n = s.count || 1;
                    const wallClock = performance.now() - s.startTime;
                    console.log(`\n⏱️ TIMING REPORT (${n} tokens)`);
                    console.log(`   Wall clock:       ${(wallClock/1000).toFixed(1)}s (${(wallClock/n).toFixed(1)}ms/token)`);
                    console.log(`   Token gaps:       ${(s.tokenGaps/1000).toFixed(1)}s (${(s.tokenGaps/n).toFixed(1)}ms/token) [network+model+decode]`);
                    console.log(`   Our processing:   ${s.total.toFixed(0)}ms (${(s.total/n).toFixed(2)}ms/token)`);
                    console.log(`   ├─ addToken:      ${s.addToken.toFixed(1)}ms (${(s.addToken/n).toFixed(2)}ms/token)`);
                    console.log(`   ├─ updateBright:  ${s.updateBrightness.toFixed(1)}ms (${(s.updateBrightness/n).toFixed(2)}ms/token)`);
                    console.log(`   ├─ updateColors:  ${s.updateColors.toFixed(1)}ms (${(s.updateColors/n).toFixed(2)}ms/token)`);
                    console.log(`   ├─ renderToken:   ${s.renderToken.toFixed(1)}ms (${(s.renderToken/n).toFixed(2)}ms/token)`);
                    console.log(`   ├─ stats:         ${s.stats.toFixed(1)}ms (${(s.stats/n).toFixed(2)}ms/token)`);
                    console.log(`   └─ capture:       ${s.capture.toFixed(1)}ms (${(s.capture/n).toFixed(2)}ms/token)`);
                    console.log(`   Unaccounted:      ${(wallClock - s.tokenGaps - s.total).toFixed(0)}ms [browser paint/layout]`);
                    console.log(`   Attention size:   ${(s.attentionSize / 1024 / 1024).toFixed(1)}MB per token`);
                    
                    // Semantic index timing report
                    const idx = this.semanticIndex.getTiming(true);  // Get and reset
                    const idxStats = this.semanticIndex.getStats();
                    if (idx.embedCount > 0 || idx.queryCount > 0) {
                        console.log(`\n📚 SEMANTIC INDEX TIMING`);
                        console.log(`   Entries:          ${idxStats.entries} (${idxStats.embedded} embedded, ${idxStats.tokens} tokens)`);
                        if (idx.embedCount > 0) {
                            console.log(`   Embed:            ${idx.totalEmbedMs.toFixed(1)}ms total (${idx.avgEmbedMs.toFixed(1)}ms avg, ${idx.embedCount} calls)`);
                        }
                        if (idx.queryCount > 0) {
                            console.log(`   Query:            ${idx.totalQueryMs.toFixed(1)}ms total (${idx.avgQueryMs.toFixed(1)}ms avg, ${idx.queryCount} calls)`);
                            console.log(`   └─ Search:        ${idx.lastSearchMs.toFixed(1)}ms [cosine similarity + sort]`);
                        }
                    }
                    
                    resolve();
                },
                // onError callback
                (error) => {
                    console.error('Generation error:', error);
                    reject(error);
                }
            );
        });
        
        console.log('🔓 Generation Promise resolved');
        
        // TODO: End token tokenization is hanging - skip for now
        // try {
        //     const endTokens = await this.client.tokenize('<|im_end|>\n');
        //     for (const t of endTokens) {
        //         const token = this.conversation.addStreamingToken(t.token_id, t.text);
        //         this.renderer.addToken(token, this.conversation);
        //     }
        // } catch (err) {
        //     console.warn('Failed to add end token:', err);
        // }
        
        this._updateStats();
        console.log('🔓 _generate() complete');
    }

    _checkPruning() {
        const maxContext = parseInt(this.elements.maxContext.value);
        if (maxContext <= 0) return;  // Pruning disabled
        
        const prunedSentences = this.conversation.pruneToFit(maxContext);
        if (prunedSentences.length > 0) {
            this.totalPruned += prunedSentences.length;
            this.renderer.rebuild(this.conversation);
            
            // No need to add to semantic index - chunks are already indexed on creation
            console.log(`Pruned ${prunedSentences.length} chunks to fit budget`);
        }
    }

    _handleClear() {
        if (this.isGenerating) return;
        
        this.conversation.clear();
        this.semanticIndex.clear();
        this.renderer.clear();
        this.totalPruned = 0;
        this._updateStats();
    }

    _handleExport() {
        const state = {
            conversation: this.conversation.exportState(),
            semanticIndex: this.semanticIndex.exportState()
        };
        const json = JSON.stringify(state, null, 2);
        
        // Download as file
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `halo_weave_export_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    async _handleImport(event) {
        const file = event.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const data = JSON.parse(e.target.result);
                
                // Handle old format (flat), graveyard format, and new semantic index format
                const conversationState = data.conversation || data;
                const semanticIndexState = data.semanticIndex || null;
                const graveyardState = data.graveyard || null;  // Legacy support
                
                // Validate it looks like our export
                if (!conversationState.tokens || !Array.isArray(conversationState.tokens)) {
                    throw new Error('Invalid export file: missing tokens array');
                }
                
                // Import conversation state
                this.conversation.importState(conversationState);
                
                // Import semantic index state if present
                if (semanticIndexState) {
                    await this.semanticIndex.importState(semanticIndexState);
                } else if (graveyardState) {
                    // Legacy: migrate graveyard entries to semantic index
                    console.log('📚 Migrating legacy graveyard to semantic index...');
                    this.semanticIndex.clear();
                    // Re-index all chunks from conversation
                    await this.semanticIndex.indexNewChunks(this.conversation);
                } else {
                    // No index data - rebuild from conversation
                    this.semanticIndex.clear();
                    await this.semanticIndex.indexNewChunks(this.conversation);
                }
                
                // Rebuild UI
                this.renderer.rebuild(this.conversation);
                this._updateStats();
                this.totalPruned = conversationState.stats?.deletedTokens || 0;
                
                const indexInfo = `, ${this.semanticIndex.getStats().entries} in semantic index`;
                this._setStatus(`Imported ${conversationState.tokens.length} tokens${indexInfo}`, 'success');
            } catch (err) {
                console.error('Import error:', err);
                this._setStatus('Import failed: ' + err.message, 'error');
            }
        };
        reader.readAsText(file);
        
        // Reset file input so same file can be re-imported
        event.target.value = '';
    }

    async _checkCaptureServer() {
        const available = await this.capture.isServerAvailable();
        
        if (available) {
            this.elements.btnStartCapture.disabled = false;
            this.elements.captureStatus.textContent = '';
        } else {
            this.elements.btnStartCapture.disabled = true;
            this.elements.captureStatus.textContent = '⚠️ Capture server not running (port 8081)';
        }
    }

    async _handleStartCapture() {
        // Re-check server availability
        const available = await this.capture.isServerAvailable();
        if (!available) {
            this.elements.captureStatus.textContent = '❌ Capture server not reachable';
            return;
        }
        
        try {
            await this.capture.startCapture({
                model: 'KoboldCPP',
                config: {
                    max_tokens: this.elements.maxTokens.value,
                    temperature: this.elements.temperature.value,
                    top_p: this.elements.topP.value
                }
            });
            
            this.elements.btnStartCapture.disabled = true;
            this.elements.btnStopCapture.disabled = false;
            this.elements.captureStatus.textContent = '🔴 Recording...';
            
        } catch (err) {
            this.elements.captureStatus.textContent = '❌ Failed to start capture';
            console.error('Capture start error:', err);
        }
    }

    async _handleStopCapture() {
        // Stop capture and write state snapshot
        const state = this.conversation.exportState();
        const summary = await this.capture.stopCapture(state);
        
        this.elements.btnStartCapture.disabled = false;
        this.elements.btnStopCapture.disabled = true;
        
        if (summary) {
            this.elements.captureStatus.textContent = 
                `✅ Saved ${summary.tokens_captured} tokens`;
        } else {
            this.elements.captureStatus.textContent = '';
        }
    }

    _updateStats() {
        // Coalesce multiple calls per frame
        if (this._statsPending) return;
        this._statsPending = true;
        
        requestAnimationFrame(() => {
            this._statsPending = false;
            const stats = this.conversation.getStats();
            this.elements.statTokens.textContent = stats.activeTokens;
            this.elements.statBrightness.textContent = 
                stats.activeTokens > 0 
                    ? `${stats.minBrightness} - ${stats.maxBrightness}` 
                    : '-';
            this.elements.statPruned.textContent = this.totalPruned;
        });
    }

    _setStatus(text, className) {
        this.elements.status.textContent = text;
        this.elements.status.className = 'status ' + (className || '');
    }

    _saveSettings() {
        const settings = {
            systemPrompt: this.elements.systemPrompt.value,
            maxTokens: this.elements.maxTokens.value,
            temperature: this.elements.temperature.value,
            topP: this.elements.topP.value,
            maxContext: this.elements.maxContext.value
        };
        localStorage.setItem('halo_weave_settings', JSON.stringify(settings));
    }

    _loadSettings() {
        try {
            const saved = localStorage.getItem('halo_weave_settings');
            if (saved) {
                const settings = JSON.parse(saved);
                if (settings.systemPrompt) this.elements.systemPrompt.value = settings.systemPrompt;
                if (settings.maxTokens) {
                    this.elements.maxTokens.value = settings.maxTokens;
                    this.elements.maxTokensVal.textContent = settings.maxTokens;
                }
                if (settings.temperature) {
                    this.elements.temperature.value = settings.temperature;
                    this.elements.temperatureVal.textContent = settings.temperature;
                }
                if (settings.topP) {
                    this.elements.topP.value = settings.topP;
                    this.elements.topPVal.textContent = settings.topP;
                }
                if (settings.maxContext) this.elements.maxContext.value = settings.maxContext;
            }
        } catch (err) {
            console.warn('Failed to load settings:', err);
        }
    }
}

// Initialize app
window.app = new App();
