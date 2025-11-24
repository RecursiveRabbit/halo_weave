# Halo Weave - Attention-Based Context Management

**Version 2.0** - Pure Frontend Edition

Halo Weave is an experimental tool for visualizing transformer attention patterns during text generation and automatically pruning low-attention context to extend effective conversation length.

## Key Features

✨ **Real-time Attention Visualization** - Watch which tokens the model attends to as it generates text

🧠 **Brightness-Based Pruning** - Automatically remove low-attention sentences to stay under context limits

🎯 **Distance Weighting** - Filter local structural attention to focus on semantic references

🔧 **Experimental Controls** - Tune decay rates, aggregation modes, and distance weighting live

📊 **Token Dictionary Architecture** - Never retokenize, soft-delete pruned content for full audit trail

## What's New in V2

- **Pure JavaScript** - No Python backend, no dependencies beyond KoboldCPP
- **KoboldCPP Integration** - Uses KoboldCPP as inference backend (requires modified version with attention extraction)
- **Lighter** - Just HTML, CSS, and vanilla JS
- **Portable** - Run directly from `file://` or any static server

## Architecture

```
Browser (index.html)
  ↓
JavaScript Modules:
  - conversation_state.js  (Token dictionary)
  - attention_tracker.js   (Aggregation, decay, distance weighting)
  - kobold_client.js       (WebSocket to KoboldCPP)
  - heatmap.js            (Visualization)
  - app.js                (Main controller)
  ↓
KoboldCPP Server (localhost:5001)
  - Model inference
  - Attention extraction
  - Tokenization
```

## Requirements

### KoboldCPP with Attention Extraction (REQUIRED)

**This version requires a modified KoboldCPP** that exposes attention tensors via API. See `../KOBOLD_API_SPEC.md` for the required API specification.

**Required endpoints:**
- `GET /api/v1/model/info` - Model architecture details
- `POST /api/v1/tokenize` - Tokenize text
- `WS /api/v1/generate/stream` - Streaming generation with attention

**Status:** KoboldCPP modifications pending. Use `../attention_heatmap/` (PyTorch version) until KoboldCPP supports attention extraction.

### Browser

Any modern browser with:
- WebSocket support
- ES6 module support
- Float32Array support

Tested on Chrome 120+, Firefox 120+

## Quick Start

### 1. Start KoboldCPP (when available)

```bash
cd /path/to/koboldcpp
python3 koboldcpp.py --model /home/evans/Coding_Projects/Halo_Weave/models/Qwen2.5-VL-7B-Instruct-Q8_0.gguf --port 5001 --usecublas 0 --gpulayers 999 --contextsize 512

```

### 2. Serve Frontend

Option A: Open directly (may have CORS issues with WebSocket)
```bash
# Just open index.html in your browser
firefox /path/to/halo_weave/index.html
```

Option B: Use a static server (recommended)
```bash
cd /path/to/halo_weave
python -m http.server 8080
# Open http://localhost:8080 in browser
```

### 3. Start Chatting

1. Check that status shows "Connected: [model name]"
2. Type a message
3. Watch tokens appear with color-coded brightness
4. Observe attention patterns as conversation grows

## How It Works

### Token Dictionary

Every chat app maintains two views of the conversation:
1. **Display text** - for showing to the user
2. **Token IDs** - for feeding to the model

Halo Weave replaces the display text with a **token dictionary**:

```javascript
{
  token: "Hello",
  token_id: 9707,
  position: 42,            // Unique ID, never reused
  attention_score: 0.67,   // Accumulated brightness (0-1)
  turn_id: 2,              // Which conversation turn
  sentence_id: 0,          // Which sentence in message
  deleted: false           // Soft-delete flag
}
```

**Key principle:** Tokenize once when a message enters the conversation, never retokenize.

### Attention Accumulation

On each generation step:
1. Model generates new token
2. KoboldCPP returns attention tensor: `[layers, heads, context_length]`
3. Aggregate across layers/heads (mean/max/weighted/last_layer)
4. Apply distance weighting (filter attention within N tokens)
5. Update scores: `score = old_score + weighted_attention - decay_rate`
6. Update visualization colors

### Brightness-Based Pruning

When context exceeds threshold:
1. Find sentence with lowest max brightness
2. Mark all tokens in sentence as `deleted=true`
3. Animate removal (red flash → fade out)
4. Rebuild input_ids without deleted tokens
5. Repeat until under threshold

**Result:** Low-attention procedural text removed, important context preserved.

## Configuration

### Generation Settings

- **Max New Tokens** (10-512): Maximum tokens to generate per turn
- **Temperature** (0.1-2.0): Sampling temperature
- **Top-P** (0.0-1.0): Nucleus sampling threshold

### Attention Settings

- **Aggregation Mode**: How to combine attention across layers/heads
  - `mean` - Average (default, most stable)
  - `max` - Maximum (highlights peak attention)
  - `last_layer` - Only last layer (faster, less complete)
  - `weighted_layers` - Weight later layers more heavily

- **Decay Mode**: How attention fades over time
  - `additive` - Fixed decay per step (default)
  - `none` - No decay (only shows raw accumulation)
  - `exponential` - Exponential time-based decay

- **Decay Rate** (0.0001-0.01): How fast tokens fade
  - Higher = faster fade
  - Lower = longer memory
  - Recommended: 0.003

- **Boost Multiplier** (1-20): Amplify attention before decay
  - Higher = more contrast between bright/dim tokens
  - Lower = more uniform brightness
  - Recommended: 1-5

### Distance Weighting

Filters out "local attention" (model attending to current sentence). Only counts backward references.

- **Mode**: Weighting function
  - `logarithmic` - Diminishing returns at distance (recommended)
  - `threshold` - Binary on/off at min_distance
  - `linear` - Linear scaling
  - `square_root` - Square root scaling
  - `none` - Disable distance weighting

- **Min Distance** (0-100): Filter attention within this many tokens
  - Recommended: 20 (filters current sentence)
  - Higher = more aggressive (only long backward references count)
  - 0 = disable filtering

- **Distance Scale** (1-100): Scaling factor for multiplier
  - Affects how much distant attention is amplified
  - Recommended: 10

### Pruning Settings

- **Max Context Tokens** (0 = disabled): Prune when exceeding this limit
  - Recommended: 500-1000
  - 0 = no pruning (will OOM eventually)
  - Model-dependent (larger models = larger context)

## Tips & Tricks

### For Testing

1. **Start with short conversations** - 2-3 turns to verify attention extraction works
2. **Watch decay in action** - Set decay rate high (0.01) to see tokens fade quickly
3. **Test distance weighting** - Set min_distance to 50 and watch only distant references stay bright
4. **Trigger pruning** - Set max_context_tokens to 100 and have a long conversation

### For Production Use

1. **Conservative pruning** - Start with max_context_tokens around 70% of model's limit
2. **Moderate decay** - 0.003 is tested and works well
3. **Enable distance weighting** - Logarithmic mode with min_distance=20
4. **Save settings** - Settings persist in localStorage across sessions

### Debugging

1. **Open browser console** - All errors and pruning logs appear here
2. **Check `window.app`** - Main app instance is globally accessible
3. **Export data** - Use "Export Data" button to save full conversation state
4. **Inspect tokens** - Hover over any token to see metadata tooltip

## Known Limitations

1. **Requires modified KoboldCPP** - Attention extraction not yet implemented
2. **VRAM still limiting** - Pruning extends conversation but doesn't reduce per-token VRAM usage
3. **No KV cache** - Each generation processes full context (slower but more accurate)
4. **Single-threaded JS** - Attention aggregation blocks UI briefly on very long contexts
5. **No undo** - Once pruned, tokens can't be restored (soft-delete preserves audit trail but model never sees them again)

## Performance

### JavaScript Attention Aggregation

- **28 layers × 28 heads × 500 tokens** = 392K float operations
- Modern V8 JIT: ~5-10ms per token
- Negligible compared to model inference (~50-200ms per token)

### Memory Usage

- **75MB per 50-token generation** (attention tensors in system RAM)
- Lightweight compared to model weights in VRAM
- JavaScript heap usage: ~5-10MB for 1000-token conversation

## Comparison: V1 vs V2

| Feature | V1 (attention_heatmap) | V2 (halo_weave) |
|---------|------------------------|-----------------|
| Backend | Python + FastAPI + PyTorch | None (pure frontend) |
| Inference | PyTorch (local) | KoboldCPP (separate process) |
| Dependencies | transformers, torch, CUDA | None (just a browser) |
| VRAM Usage | 14-28GB (model + attention) | 0GB (model in KoboldCPP) |
| Attention Extraction | ✅ Working | ⏳ Pending KoboldCPP mods |
| Setup Complexity | High (venv, pip, CUDA) | Low (open HTML file) |
| Portability | Requires Python env | Runs anywhere |

## Development

### File Structure

```
halo_weave/
├── index.html              # Main UI
├── css/
│   └── style.css          # Styling
├── js/
│   ├── app.js             # Main controller
│   ├── kobold_client.js   # API client
│   ├── conversation_state.js  # Token dictionary
│   ├── attention_tracker.js   # Attention processing
│   └── heatmap.js         # Visualization
├── README.md              # This file
└── CLAUDE.md              # Development docs
```

### Contributing

This is an experimental research tool. Core architecture decisions should be discussed before implementation. See `CLAUDE.md` for development guidelines.

## Troubleshooting

### "KoboldCPP server not reachable"

- Check KoboldCPP is running: `curl http://localhost:5001/api/v1/model/info`
- Verify port 5001 is correct
- Check firewall settings

### "WebSocket connection failed"

- Browser may block WebSocket from `file://` - use a static server instead
- Check KoboldCPP WebSocket endpoint is implemented
- Verify no browser extensions blocking WebSocket

### "Attention data missing"

- KoboldCPP may not support attention extraction yet
- Check browser console for errors
- Verify `return_attention: true` in generation config

### Tokens not fading

- Check decay rate > 0
- Verify decay mode is not "none"
- Open console and check `app.tracker.config`

### Pruning not working

- Check max_context_tokens > 0
- Verify context exceeds threshold
- Check console for pruning logs

## License

MIT License - See `../LICENSE`

## Links

- **Repository:** https://github.com/RecursiveRabbit/Halo-Weave
- **V1 (PyTorch):** `../attention_heatmap/`
- **API Spec:** `../KOBOLD_API_SPEC.md`
- **Issues:** https://github.com/RecursiveRabbit/Halo-Weave/issues

## Acknowledgments

Built on insights from:
- HuggingFace Transformers (attention extraction patterns)
- KoboldAI (inference server architecture)
- The transformer interpretability research community

Inspired by the question: *"What if the model could tell us what to delete?"*
