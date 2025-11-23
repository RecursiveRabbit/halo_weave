# Data Capture Guide

## Overview

The Data Capture feature records **complete attention tensors** for every generated token, allowing offline analysis of attention patterns.

## Data Size

- **Per token**: ~1.6 MB (28 layers × 28 heads × context_length floats)
- **512 tokens**: ~820 MB total
- Format: JSON with float32 arrays

## How to Use

### 1. Start Capture

1. Open Halo Weave frontend
2. Click **"🎬 Start Capture"** button in settings
3. Status shows "🔴 Recording..."

### 2. Run Your Experiment

**Recommended experiment structure:**

```
System Prompt: [Your task description]

User Message: [Multi-sentence prompt with varied importance]

Example:
"Please analyze the following data.
First, consider the primary factors: X, Y, and Z.
These are critical to understanding the outcome.
By the way, it's a nice day today.
The weather forecast shows rain tomorrow.
Secondary factors include A and B.
Finally, summarize your findings."
```

- **Critical sentences**: "primary factors", "critical to understanding"
- **Irrelevant sentences**: "nice day today", "weather forecast"
- **Secondary sentences**: "Secondary factors"

Then generate 512 tokens and observe which sentences the model attends to!

### 3. Stop & Save

1. Click **"⏹️ Stop Capture"** when done
2. Click **"💾 Save Data"**
3. File downloads: `attention_capture_[timestamp].json`

## Data Format

```json
{
  "metadata": {
    "timestamp": 1763681849744,
    "model": "Qwen2.5-VL-7B-Instruct-Q8_0",
    "description": "Attention pattern analysis experiment",
    "config": {
      "max_length": 512,
      "temperature": 0.7,
      "top_p": 0.9
    }
  },
  "prompt_tokens": [
    {
      "token_id": 9707,
      "text": "Hello",
      "position": 0,
      "turn_id": 0,
      "message_role": "system",
      "sentence_id": 0
    },
    ...
  ],
  "generated_tokens": [
    {
      "step": 0,
      "token_id": 358,
      "text": " I",
      "position": 28,
      "timestamp": 1763681850123,
      "attention": {
        "shape": [28, 28, 256],
        "context_length": 256,
        "data": [/* Float32Array of 401,408 values */]
      }
    },
    ...
  ]
}
```

## Analyzing the Data

### Python Example

```python
import json
import numpy as np
import matplotlib.pyplot as plt

# Load data
with open('attention_capture_xyz.json', 'r') as f:
    data = json.load(f)

# Extract attention for token 10
token_10 = data['generated_tokens'][10]
attention = np.array(token_10['attention']['data'])
shape = token_10['attention']['shape']  # [28, 28, 256]

# Reshape
attention = attention.reshape(shape)

# Aggregate across layers and heads
attention_mean = attention.mean(axis=(0, 1))  # [256]

# Plot which prompt tokens were attended to
plt.figure(figsize=(15, 5))
plt.bar(range(len(attention_mean)), attention_mean)
plt.xlabel('Prompt Token Position')
plt.ylabel('Mean Attention')
plt.title(f'Token {token_10["text"]!r} attention distribution')
plt.show()

# Find peak attention positions
top_k = 10
top_positions = np.argsort(attention_mean)[-top_k:][::-1]

print(f"Token {token_10['text']!r} attended most to:")
for pos in top_positions:
    prompt_token = data['prompt_tokens'][pos]
    print(f"  Pos {pos}: {prompt_token['text']!r} (score: {attention_mean[pos]:.4f})")
```

### Analysis Questions

1. **Which prompt sentences stay bright?**
   - Track attention to sentence positions over 512 generation steps

2. **Does irrelevant context fade naturally?**
   - Compare attention to "nice day today" vs "primary factors"

3. **Do negative logits = natural decay?**
   - Plot raw attention over time for each prompt token

4. **What's the optimal decay rate?**
   - If negative logits aren't enough, calculate synthetic decay from data

5. **Distance weighting needed?**
   - Do local tokens (last 20) get artificial attention?

## Experiment Ideas

### 1. Importance Decay Test

Prompt with 10 sentences:
- 3 critical (facts about a math problem)
- 4 irrelevant (weather, greetings)
- 3 helpful (secondary context)

Generate 512 tokens solving the problem. Plot attention to each sentence group.

**Hypothesis**: Critical sentences stay bright, irrelevant fade to negative.

### 2. Context Window Pruning Simulation

1. Capture 512 tokens with full context
2. Offline: Prune bottom 30% by peak brightness
3. Rerun generation with pruned context (separate session)
4. Compare outputs - did it change the result?

### 3. Attention Pattern Visualization

Create heatmaps showing:
- X-axis: Generation step (0-512)
- Y-axis: Prompt token position
- Color: Attention intensity

Watch sentences fade over time!

## Tips

- **Start with short prompts**: Test with 50-100 token prompts before 512
- **Check file size**: Monitor disk space, files get large!
- **Compress afterward**: `gzip attention_capture.json` saves ~80%
- **Incremental analysis**: Process tokens 0-100 first, then full dataset

## Memory Management

If 820 MB is too large:
- Capture fewer tokens (256 instead of 512)
- Sample every Nth token instead of all
- Save binary format instead of JSON (future feature)

## Next Steps

After collecting data:
1. Determine if raw logits provide natural decay
2. Calculate optimal boost multiplier from data
3. Validate pruning thresholds empirically
4. Build automated analysis pipeline

---

**Questions?** Check `js/data_capture.js` for implementation details.
