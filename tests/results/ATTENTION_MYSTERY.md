# 🔍 The Mystery of Oscillating Attention Data

**Date:** 2025-11-22
**Investigator:** Claude (Data Science Mode)

---

## 📊 The Phenomenon

During data capture of 387 generated tokens, attention values **oscillate** between:

1. **NORMALIZED probabilities**: min=0, max≈1, sum≈784 (28 layers × 28 heads)
2. **RAW logits**: min=-230, max=190, sum=-881,000

**Frequency:** 182 transitions out of 387 tokens = switching **every ~2 tokens**

**Pattern:** Semi-random, NOT periodic. Examples:
- Tokens 0-5: NORMALIZED
- Token 6: RAW LOGITS
- Token 7: NORMALIZED
- Token 8: RAW LOGITS
- Token 9-10: NORMALIZED
- Token 11: RAW LOGITS
...and so on for 387 tokens

---

## 🕵️ Investigation Findings

### Configuration
- **Model:** Qwen2.5-VL-7B-Instruct-Q8_0
- **Flash Attention:** DISABLED (`llama_context: flash_attn = disabled`)
- **Context:** 512 tokens max
- **Architecture:** 28 layers, 28 heads (GQA with 4 KV heads)

### Code Path Analysis

**gpttype_adapter.cpp:252-256:**
```cpp
// Only capture softmax attention tensors (no enabled check)
if (strcmp(name, "kq_soft_max") != 0) {
    return;
}
```

**llama-graph.cpp:1439-1441** (normal attention path, used by all tokens):
```cpp
kq = ggml_soft_max_ext(ctx0, kq, kq_mask, kq_scale, hparams.f_max_alibi_bias);
ggml_soft_max_add_sinks(kq, sinks);
cb(kq, "kq_soft_max", il);  // ← Callback triggers HERE
```

**Key insight:** All tokens use the same code path (`ggml_soft_max_ext` → callback with "kq_soft_max"), so they **should** all be normalized!

---

## 🤔 Hypothesis: Race Condition

### Theory
The callback `attention_capture_callback()` is called **during graph construction**, storing tensor **pointers**:

```cpp
// gpttype_adapter.cpp:268
g_pending_attentions.push_back({cur, il});
```

Then `extract_pending_attention_data()` is called **after graph execution** to read the actual data:

```cpp
// gpttype_adapter.cpp:274-282
void extract_pending_attention_data() {
    for (const auto & pending : g_pending_attentions) {
        ggml_tensor * cur = pending.tensor;
        // Read cur->data HERE
    }
}
```

### The Problem
**Timing matters!** The tensor named "kq_soft_max" exists **before** and **after** the actual `ggml_soft_max_ext()` operation:

1. Tensor is created (pre-softmax, contains raw logits)
2. Graph is executed, softmax runs (tensor now contains normalized probs)
3. Our extraction reads from tensor

**If extraction happens at the wrong time**, we might read:
- ❌ **Stale data from previous token** (raw logits still in buffer)
- ✅ **Fresh data from current token** (normalized after softmax)

This would explain the **semi-random oscillation** - it's a **race between** graph execution and data extraction!

---

## 🔬 Supporting Evidence

1. **Non-periodic pattern** - Suggests timing/scheduling, not deterministic code path
2. **Mixed within same session** - Rules out configuration or initialization issue
3. **No correlation with token position** - Token 6 (early) and token 365 (late) both show raw logits
4. **Flash attention disabled** - All tokens use identical code path, yet produce different results

---

## 🔧 Potential Fixes

### Option 1: Synchronize Extraction
Add explicit synchronization after graph execution:
```cpp
llama_decode(ctx, batch);  // Run graph
ggml_backend_synchronize(backend);  // WAIT for GPU
extract_pending_attention_data();  // Now safe to read
```

### Option 2: Use Graph Output Callback
Instead of capturing during graph construction, use a **post-execution callback** that runs after softmax completes.

### Option 3: Copy Data Immediately
Instead of storing pointers, **copy tensor data** during callback (expensive but guaranteed correct).

### Option 4: Add Validation
Detect corrupted data and retry:
```cpp
if (min_val < -10 || max_val > 10) {
    fprintf(stderr, "WARNING: Attention data looks like raw logits, retrying...\n");
    // Retry or skip this token
}
```

---

## 🎯 Next Steps

1. **Add timing logs** to see when extraction happens relative to graph execution
2. **Check backend synchronization** - is ggml_backend_synchronize() called before extraction?
3. **Verify tensor buffer ownership** - does the tensor buffer get reused between tokens?
4. **Test with CPU-only** - Does the issue occur without CUDA? (eliminates GPU async)

---

## 📈 Impact

**For Halo Weave:**
- **Current state:** ~50% of captured tokens have **corrupted attention data**
- **Workaround:** Post-process to detect and filter raw logits (but we lose half the data!)
- **Proper fix:** Needed in KoboldCPP before production use

**Good news:** The normalized tokens (when we get them) appear to be **correct** - they sum to 1.0 per head as expected.

---

## 💡 Immediate Action

For tonight's testing:
1. ✅ **Use the data we have** - 182 tokens with normalized attention are still useful
2. ⚠️ **Filter out raw logits** - Detect min < -1 or max > 10, skip those tokens
3. 📝 **Log the issue** - Document for KoboldCPP team to investigate race condition

For tomorrow:
1. Add backend synchronization to extract_pending_attention_data()
2. Test if that eliminates the oscillation
3. If not, investigate tensor buffer lifecycle

---

**Status:** Mystery partially solved - race condition suspected, fix needed in KoboldCPP.
