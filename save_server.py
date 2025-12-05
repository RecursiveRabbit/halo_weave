#!/usr/bin/env python3
"""
Stream-to-disk capture server for Halo Weave.
Writes attention data incrementally as tokens generate.
"""

from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import time
from pathlib import Path
from urllib.parse import urlparse, parse_qs

# Output directory for captures
CAPTURE_BASE_DIR = Path('tests/captures/Capture_Data')

class CaptureHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        """Handle CORS preflight"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        """Handle capture requests"""
        parsed = urlparse(self.path)

        if parsed.path != '/capture':
            self.send_error(404)
            return

        # Parse query params
        params = parse_qs(parsed.query)
        action = params.get('action', [''])[0]
        timestamp = params.get('ts', [''])[0]

        try:
            if action == 'start':
                self._handle_start(timestamp)
            elif action == 'write_metadata':
                self._handle_write_metadata(timestamp)
            elif action == 'write_token':
                # Legacy: combined JSON (deprecated)
                self._handle_write_token(timestamp, params)
            elif action == 'write_token_meta':
                # New: small JSON metadata only
                self._handle_write_token_meta(timestamp, params)
            elif action == 'write_token_attn':
                # New: raw binary attention tensor
                self._handle_write_token_attn(timestamp, params)
            elif action == 'write_state':
                self._handle_write_state(timestamp)
            elif action == 'ping':
                # Health check endpoint
                self._send_json_response({'status': 'ok'})
            else:
                self._send_error_with_cors(400, f"Unknown action: {action}")

        except Exception as e:
            print(f"❌ Error: {e}")
            self.send_error(500, str(e))

    def _handle_start(self, timestamp):
        """Create capture directory"""
        if not timestamp:
            raise ValueError("Missing timestamp")

        capture_dir = CAPTURE_BASE_DIR / f'capture_{timestamp}'
        capture_dir.mkdir(parents=True, exist_ok=True)

        print(f"📁 Created {capture_dir}")

        self._send_json_response({
            'success': True,
            'capture_dir': str(capture_dir)
        })

    def _handle_write_metadata(self, timestamp):
        """Write metadata.json"""
        if not timestamp:
            raise ValueError("Missing timestamp")

        capture_dir = CAPTURE_BASE_DIR / f'capture_{timestamp}'
        if not capture_dir.exists():
            raise ValueError(f"Capture directory not found: {capture_dir}")

        # Read JSON body
        content_length = int(self.headers['Content-Length'])
        body = self.rfile.read(content_length)
        metadata = json.loads(body)

        # Write metadata file
        metadata_file = capture_dir / 'metadata.json'
        with open(metadata_file, 'w') as f:
            json.dump(metadata, f, indent=2)

        print(f"📝 Wrote {metadata_file.name}")

        self._send_json_response({
            'success': True,
            'file': str(metadata_file)
        })

    def _handle_write_token(self, timestamp, params):
        """Write individual token file"""
        if not timestamp:
            raise ValueError("Missing timestamp")

        index = params.get('index', [''])[0]
        if not index:
            raise ValueError("Missing index")

        capture_dir = CAPTURE_BASE_DIR / f'capture_{timestamp}'
        if not capture_dir.exists():
            raise ValueError(f"Capture directory not found: {capture_dir}")

        # Read JSON body
        content_length = int(self.headers['Content-Length'])
        body = self.rfile.read(content_length)
        token_data = json.loads(body)

        # Write token file with zero-padded index
        token_file = capture_dir / f'token_{int(index):05d}.json'
        with open(token_file, 'w') as f:
            json.dump(token_data, f)

        # Progress indicator every 10 tokens
        if int(index) % 10 == 0:
            print(f"💾 Wrote token {index}")

        self._send_json_response({
            'success': True,
            'file': str(token_file)
        })

    def _handle_write_token_meta(self, timestamp, params):
        """Write token metadata JSON (small, ~200 bytes)"""
        if not timestamp:
            raise ValueError("Missing timestamp")

        index = params.get('index', [''])[0]
        if not index:
            raise ValueError("Missing index")

        capture_dir = CAPTURE_BASE_DIR / f'capture_{timestamp}'
        if not capture_dir.exists():
            raise ValueError(f"Capture directory not found: {capture_dir}")

        # Read JSON body
        content_length = int(self.headers['Content-Length'])
        body = self.rfile.read(content_length)
        meta_data = json.loads(body)

        # Write metadata file
        meta_file = capture_dir / f'token_{int(index):05d}_meta.json'
        with open(meta_file, 'w') as f:
            json.dump(meta_data, f)

        self._send_json_response({
            'success': True,
            'file': str(meta_file)
        })

    def _handle_write_token_attn(self, timestamp, params):
        """Write raw binary attention tensor (fast!)"""
        if not timestamp:
            raise ValueError("Missing timestamp")

        index = params.get('index', [''])[0]
        if not index:
            raise ValueError("Missing index")

        capture_dir = CAPTURE_BASE_DIR / f'capture_{timestamp}'
        if not capture_dir.exists():
            raise ValueError(f"Capture directory not found: {capture_dir}")

        # Read raw binary body
        content_length = int(self.headers['Content-Length'])
        binary_data = self.rfile.read(content_length)

        # Write binary file directly - no parsing, no serialization!
        attn_file = capture_dir / f'token_{int(index):05d}_attn.bin'
        with open(attn_file, 'wb') as f:
            f.write(binary_data)

        # Progress indicator every 10 tokens
        if int(index) % 10 == 0:
            print(f"💾 Token {index}: {len(binary_data):,} bytes")

        self._send_json_response({
            'success': True,
            'file': str(attn_file),
            'bytes': len(binary_data)
        })

    def _handle_write_state(self, timestamp):
        """Write conversation state snapshot"""
        if not timestamp:
            raise ValueError("Missing timestamp")

        capture_dir = CAPTURE_BASE_DIR / f'capture_{timestamp}'
        if not capture_dir.exists():
            raise ValueError(f"Capture directory not found: {capture_dir}")

        # Read JSON body
        content_length = int(self.headers['Content-Length'])
        body = self.rfile.read(content_length)
        state_data = json.loads(body)

        # Write state file
        state_file = capture_dir / 'conversation_state.json'
        with open(state_file, 'w') as f:
            json.dump(state_data, f, indent=2)

        print(f"📸 Wrote {state_file.name}")

        self._send_json_response({
            'success': True,
            'file': str(state_file)
        })

    def _send_json_response(self, data):
        """Send JSON response with CORS"""
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def _send_error_with_cors(self, code, message):
        """Send error response with CORS headers"""
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps({'error': message}).encode())

    def log_message(self, format, *args):
        """Suppress default logging"""
        pass

if __name__ == '__main__':
    port = 8081
    server = HTTPServer(('127.0.0.1', port), CaptureHandler)
    print(f"🚀 Capture server running on http://127.0.0.1:{port}")
    print(f"   POST to http://127.0.0.1:{port}/capture?action=...")
    print(f"   Captures saved to {CAPTURE_BASE_DIR}/")
    server.serve_forever()
