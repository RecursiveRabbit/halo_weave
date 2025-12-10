/**
 * Web Worker for embedding computation
 * Runs transformers.js off the main thread to avoid blocking UI
 */

let pipeline = null;
let modelReady = false;

async function initModel() {
    if (modelReady) return;
    
    const { pipeline: createPipeline } = await import(
        'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1'
    );
    
    pipeline = await createPipeline(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2',
        { quantized: true }
    );
    
    modelReady = true;
    self.postMessage({ type: 'ready' });
}

async function embed(id, text) {
    if (!modelReady) {
        await initModel();
    }
    
    const t0 = performance.now();
    const output = await pipeline(text, {
        pooling: 'mean',
        normalize: true
    });
    const elapsed = performance.now() - t0;
    
    // Transfer the embedding back
    const embedding = new Float32Array(output.data);
    self.postMessage({
        type: 'embedding',
        id: id,
        embedding: embedding,
        elapsed: elapsed
    }, [embedding.buffer]);  // Transfer ownership for zero-copy
}

// Handle messages from main thread
self.onmessage = async (event) => {
    const { type, id, text } = event.data;
    
    try {
        switch (type) {
            case 'init':
                await initModel();
                break;
                
            case 'embed':
                await embed(id, text);
                break;
                
            default:
                console.warn('Unknown message type:', type);
        }
    } catch (err) {
        self.postMessage({
            type: 'error',
            id: id,
            error: err.message
        });
    }
};

// Start loading model immediately
initModel().catch(err => {
    self.postMessage({ type: 'error', error: err.message });
});
