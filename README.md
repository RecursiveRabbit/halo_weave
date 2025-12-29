# Halo Weave - Attention-Based Context Management

Halo Weave visualizes transformer attention patterns during text generation and automatically prunes low-attention context to extend effective conversation length. Pruned content is indexed for semantic resurrection - when you mention something from earlier, it can come back.

## Key Features

- **Real-time Attention Visualization** - Watch which tokens the model attends to as it generates
- **Magnitude Voting** - Tokens earn brightness when strongly referenced, decay when ignored
- **Automatic Pruning** - Lowest-brightness chunks removed to stay under context limits
- **Semantic Resurrection** - Pruned content indexed with transformers.js, resurrected when relevant
- **Manual Controls** - Pin chunks to protect them, merge chunks to adjust boundaries

## Quick Start

### 1. Start KoboldCPP with Attention Extraction

```bash
python3 koboldcpp.py --model your_model.gguf --port 5001 --usecublas --gpulayers 999 --contextsize 8192
```

Requires modified KoboldCPP with attention extraction and SSE streaming.

### 2. Serve Frontend

```bash
cd halo_weave
python3 -m http.server 8080
# Open http://localhost:8080
```

### 3. Chat

Type a message, watch tokens appear with brightness colors. Yellow = high attention, dim = low attention, strikethrough = pruned.

## Architecture

```
index.html
  ↓
app.js (Main Controller)
  ├─> kobold_client.js   (KoboldCPP API - SSE + REST)
  ├─> conversation.js    (Token storage + Magnitude Voting + pruning)
  ├─> renderer.js        (DOM rendering + brightness visualization)
  └─> semantic_index.js  (Vector DB for resurrection via transformers.js)
```

**Pure frontend** - No build step, no npm, no webpack. Just ES6 modules.

## How It Works

### Magnitude Voting (Brightness Scoring)

Each generation step:
1. Server sends base64-encoded attention tensor `[layers, heads, context_length]`
2. Client aggregates across layers and heads
3. Calculate threshold: `(1.0 - bos_attention) / (context_len - 1)`
4. For each token (excluding current turn):
   - `attention > threshold`: brightness += int(attention / threshold)
   - `attention <= threshold`: brightness -= 1
5. Brightness capped at 10,000 to prevent immortal tokens

### Pruning

When context exceeds budget:
1. Find chunk with lowest peak brightness (excluding current turn, system prompt, pinned)
2. Mark tokens as `deleted=true`, preserve `brightness_at_deletion`
3. Repeat until under budget

### Semantic Resurrection

Before each user message:
1. Query semantic index with user text
2. Find relevant pruned chunks by cosine similarity
3. Resurrect top matches within token budget
4. Resurrected tokens keep their earned brightness (floor of 255)

## Controls

- **📌 Pin** - Click pin button on any chunk to protect it from pruning
- **➕ Merge** - Click merge button on chunk boundary to combine with previous chunk
- **Max Tokens** - Context budget slider
- **Temperature/Top-P** - Generation parameters

## File Structure

```
halo_weave/
├── index.html           # Main UI
├── css/style.css        # Styling
├── js/
│   ├── app.js           # Main controller
│   ├── kobold_client.js # KoboldCPP client
│   ├── conversation.js  # Token storage + scoring
│   ├── renderer.js      # DOM rendering
│   └── semantic_index.js # Vector search
├── README.md            # This file
└── CLAUDE.md            # Development docs
```

## Requirements

- Modern browser (Chrome 120+, Firefox 120+)
- KoboldCPP with attention extraction and SSE support
- transformers.js (loaded from CDN on first semantic index use, ~23MB)

## License

MIT License

## Links

- **Repository:** https://github.com/RecursiveRabbit/halo_weave
- **Issues:** https://github.com/RecursiveRabbit/halo_weave/issues

*"What if the model could tell us what to delete?"*
