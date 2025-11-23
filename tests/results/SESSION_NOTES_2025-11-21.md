# Session Notes - 2025-11-21

## Quick Start (Next Session)

### To continue data capture work:

1. **Check servers running:**
   ```bash
   # Frontend (should be running)
   curl http://127.0.0.1:8080

   # KoboldCPP (should be running)
   curl http://localhost:5001/api/v1/model

   # Save server (background ID: e1ddfa)
   curl http://127.0.0.1:8081/save_capture
   ```

2. **Fix remaining issue in app.js:**

   Line ~389 in `/home/evans/Coding_Projects/Halo_Weave/halo_weave/js/app.js`:

   ```javascript
   // CURRENT (synchronous):
   document.getElementById('save-capture-button')?.addEventListener('click', () => {
       this.dataCapture.saveToFile();
       // ...
   });

   // NEEDS TO BE (async with progress):
   document.getElementById('save-capture-button')?.addEventListener('click', async () => {
       document.getElementById('capture-status').textContent = '⏳ Saving (may take 30s+)...';
       try {
           const filename = await this.dataCapture.saveToFile();
           document.getElementById('save-capture-button').style.display = 'none';
           document.getElementById('capture-status').textContent = `✅ Saved: ${filename}`;
       } catch (err) {
           document.getElementById('capture-status').textContent = `❌ Save failed: ${err.message}`;
           console.error(err);
       }
   });
   ```

3. **Test data capture:**
   - Hard refresh: Ctrl+Shift+R
   - Click "🎬 Start Capture"
   - Send message, generate response
   - Click "⏹️ Stop Capture"
   - Click "💾 Save Data"
   - Check for `attention_capture_*.json` in `/home/evans/Coding_Projects/Halo_Weave/halo_weave/`

## Issues Encountered & Solutions

### Issue 1: Tokens rendering as dots/question marks
**Cause:** Loop bug - always rendering `tokens[tokens.length-1]`
**Fix:** Track start/end index properly in app.js lines 87-92, 242-247

### Issue 2: Model incoherent output
**Cause:** Missing ChatML format tokens
**Fix:** Added `<|im_start|>` and `<|im_end|>` wrapping in app.js

### Issue 3: Attention scores clamped to [0, 1]
**Cause:** `Math.max(0, Math.min(1, score))` in conversation_state.js:115
**Fix:** Removed clamping - allow negative raw logits

### Issue 4: "allocation size overflow" on save
**Cause:** 820MB JSON too large for browser memory
**Fix:** Created save_server.py to handle server-side saves

## Data Observations

### Raw Logit Ranges
```
Total: 676 tokens
Min: -140,624.2%
Max: +94,060.7%
Avg: -48,151.0%
```

**Interpretation:**
- Tokens start at 1.0 (fail bright)
- Accumulate raw attention each generation step
- Negative = not attended → fade naturally
- Positive = attended → stay bright
- **No manual decay needed!**

### Color Scale Tuning

Current ranges in `heatmap.js`:

**Background (sentence peak):**
- [-20, +20] logits → blue gradient
- May need adjustment based on data

**Text color (individual tokens):**
- [-100, +100] logits → gray to white
- May need adjustment based on data

## Next Steps

### Immediate (Data Capture)
1. Fix async handler in app.js
2. Test full capture workflow
3. Generate 512 token dataset
4. Analyze with Python (see DATA_CAPTURE_GUIDE.md)

### Short Term (Validation)
1. Determine if negative logits = sufficient decay
2. Test pruning with real data (max_context_tokens slider)
3. Validate sentence peak brightness for pruning decisions

### Medium Term (Tuning)
1. Adjust color scale based on observed ranges
2. Calculate optimal boost_multiplier from data
3. Test distance weighting effectiveness
4. Build analysis pipeline for captured data

## File Changes This Session

### Modified:
- `js/app.js` - ChatML format, data capture integration
- `js/kobold_client.js` - SSE instead of WebSocket
- `js/conversation_state.js` - Removed clamping, added peak/history
- `js/attention_tracker.js` - Removed clamping
- `js/heatmap.js` - Dual color system, sentence backgrounds
- `index.html` - Added data capture buttons
- `CLAUDE.md` - This update

### Created:
- `js/data_capture.js` - Full attention tensor recording
- `save_server.py` - Server-side save for large files
- `DATA_CAPTURE_GUIDE.md` - Usage instructions
- `SESSION_NOTES_2025-11-21.md` - This file

### Not Modified (Working):
- `css/style.css`
- `js/conversation_state.js` (core logic)

## Background Processes

```bash
# Check running processes:
ps aux | grep python3 | grep -E "(http.server|koboldcpp|save_server)"

# Expected:
# - Port 8080: http.server (frontend)
# - Port 5001: koboldcpp (inference)
# - Port 8081: save_server.py (data upload)
```

## Quick Test Commands

```bash
# Test frontend
curl -I http://127.0.0.1:8080/index.html

# Test KoboldCPP
curl -s http://localhost:5001/api/v1/model | head -3

# Test save server
curl -X POST http://127.0.0.1:8081/save_capture \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}'
```

## Known Issues

1. **Data capture save incomplete** - Need async handler
2. **Pruning untested** - Works in theory, not validated
3. **Color scale needs tuning** - Based on assumptions, not data
4. **Context window wrapping** - Model at 640, frontend set to 512

## Questions for Next Session

1. Should we start tokens at 0 instead of 1.0?
2. Do we need decay at all with negative logits?
3. What's the real attention range? (Current: -140k to +94k)
4. Should distance weighting stay enabled?
5. Test pruning - does it work?
