# 5-Second Tokenize Bug

## Symptoms
- Tokenize requests from Halo Weave hang indefinitely (timeout after 5s)
- Server does NOT print debug messages - request never reaches Python handler
- curl to same endpoint works fine
- Kobold's own interface (same origin) works fine
- Hard refresh of page does NOT fix it
- Only fix is restarting KoboldCPP server

## Request Pattern
Two tokenize requests are made on each send:
1. First request: User message wrapper tokenization (`_addMessage`)
2. Second request: AI prefix tokenization (`_generate`)

**Update 2025-12-10**: Corrected - the FIRST request succeeds. The SECOND request (AI prefix) fails.

## New Evidence (2025-12-10 session 2)

Server logs show the preflight AND the first tokenize succeed:
```
[DEBUG] OPTIONS request for /api/v1/tokenize
[DEBUG] OPTIONS response sent
[DEBUG] Tokenize request received: 53 chars
[DEBUG] Tokenize complete: 10 tokens
[DEBUG] OPTIONS request for /api/v1/tokenize
[DEBUG] OPTIONS response sent
```

Client logs:
```
📤 Adding user message...
🔤 tokenize() starting...
🔤 tokenize() got response: 200
🔤 tokenize() complete, got 10 tokens
📤 User message added, starting generation...
🔤 tokenize() starting...
Generation error: Error: Tokenization timed out after 5s
```

**Key insight**: The second OPTIONS preflight succeeds, but the POST body is never received by the server. The request is stuck between preflight completion and POST transmission.

## HAR Data Analysis
```json
{
  "blocked": 5001.75,  // Entire 5 seconds spent BLOCKED
  "connect": -1,       // Never even tried to connect
  "send": 0,
  "wait": 0
}
```
- Request is blocked at browser level - never leaves browser
- CORS preflight (OPTIONS) request stuck pending
- Status shows `net::ERR_ABORTED` after 5s timeout

## Key Observations
1. **Different origin triggers CORS**: Halo Weave on :8080, KoboldCPP on :5001
   - Kobold's interface is same-origin, no preflight needed
   - Our requests require OPTIONS preflight

2. **Server architecture**: 
   - 24 HTTP server threads sharing same socket (pre-fork style)
   - `modelbusy` lock in `do_POST` but NOT in WebSocket `do_GET`
   - `do_OPTIONS` handler exists and looks correct (sends 200 + CORS headers)

3. **Timing**: Bug appears after WebSocket generation completes
   - WebSocket runs in `do_GET`, doesn't acquire `modelbusy` lock
   - But server is responding to curl, so not fully deadlocked

## Hypotheses

### 1. Browser Connection Pool Exhaustion
Browsers limit concurrent connections per host (~6). If previous connections are stuck open (from browser's perspective), new requests queue in "blocked" state.

**Against**: Hard refresh should clear connection pool

### 2. Stale Keep-Alive Connection
Browser reuses HTTP connection that server thinks is closed. Server waiting on dead socket, browser waiting for response.

**Against**: `Connection: close` header didn't help (browsers ignore it anyway)

### 3. Thread Stuck After WebSocket
One of the 24 server threads is stuck after WebSocket handling. Browser happens to reuse connection to that thread.

**For**: Would explain why curl works (gets different thread)
**Against**: Should eventually timeout

### 4. CORS Preflight Not Reaching Server
OPTIONS request blocked before reaching server. Possibly browser-side issue with Brave's privacy features.

**For**: Server never prints debug message for OPTIONS
**Against**: Works initially, only breaks after generation
**Update**: New evidence shows OPTIONS DOES reach server and responds - it's the POST after preflight that fails

### 5. POST Body Not Sent After Preflight (NEW - most likely)
Browser completes OPTIONS preflight successfully, but never sends the actual POST request body.
The server is waiting for the POST, the browser thinks it sent it (or is about to).

**For**: Server logs show OPTIONS success but no POST received
**For**: Happens on second rapid tokenize call, not first
**Possible cause**: Connection reuse issue - browser trying to reuse connection that server closed

## Attempted Fixes

### Client-side (kobold_client.js)
```javascript
// Tried adding these to fetch options:
'Connection': 'close'     // Browser ignores this header
cache: 'no-store'         // Prevent caching
keepalive: false          // Don't keep connection alive
```
None helped.

### Server-side (koboldcpp.py)
```python
# Added debug logging to OPTIONS handler:
def do_OPTIONS(self):
    print(f"[DEBUG] OPTIONS request for {self.path}", flush=True)
    self.send_response(200)
    self.end_headers(content_type='text/html')
    print(f"[DEBUG] OPTIONS response sent", flush=True)
```
Debug message never appears when bug is active - confirms request not reaching handler.
**Update**: With new debug logging, we now see OPTIONS succeeds but POST never arrives.

### Delay between tokenize calls (app.js)
```javascript
// Small delay to let browser close previous connection (debug: tokenize bug)
await new Promise(r => setTimeout(r, 100));
```
Added 100ms delay between first and second tokenize call - didn't help.

## SOLUTION FOUND (2025-12-10)

**Use `Content-Type: text/plain` instead of `application/json`**

```javascript
// Use text/plain to avoid CORS preflight (server still parses as JSON)
const response = await fetch(`${this.baseUrl}/api/v1/tokenize`, {
    method: 'POST',
    headers: {
        'Content-Type': 'text/plain'
    },
    body: JSON.stringify({ text, add_special_tokens: addSpecialTokens }),
    signal: controller.signal
});
```

**Why it works:**
- `application/json` triggers CORS preflight (OPTIONS request before POST)
- `text/plain` is a "simple" content type - no preflight needed
- Server parses the body as JSON regardless of Content-Type header
- Eliminates the OPTIONS→POST sequence that was breaking
- Also faster: one round trip instead of two

**Root cause**: The bug was in the preflight→POST handoff, not the preflight itself. Avoiding preflight entirely sidesteps the issue.

## Things to Try Next (if bug returns)

1. **Check `chrome://net-internals/#sockets`** when bug is active
   - Look for stuck sockets to 127.0.0.1:5001
   - Try "Flush socket pools"

2. **Try Firefox** to rule out Brave-specific issues

3. **Add connection timeout to server**
   - Python's HTTPServer has no default socket timeout
   - Stuck connections may never close

4. **Check if WebSocket close is clean**
   - Add logging after `self.connection.close()` in WebSocket handler
   - Verify socket is actually released

5. **Try ThreadingMixIn**
   - Current architecture shares socket across threads
   - ThreadingMixIn might handle connections more cleanly

6. **Reproduce reliably**
   - Document exact sequence that triggers bug
   - Is it always after WebSocket generation?
   - Does it happen with SSE streaming instead?

## Files Involved
- `/home/evans/Coding_Projects/Halo_Weave/halo_weave/js/kobold_client.js` - tokenize() method
- `/home/evans/Coding_Projects/koboldcpp/koboldcpp.py` - do_OPTIONS(), do_POST(), WebSocket handling

## Related
- WebSocket attention streaming was optimized in Session 12 (2025-12-05)
- Server-side aggregation reduced data 784x
- Bug may be related to WebSocket changes
