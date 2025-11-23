#!/usr/bin/env python3
"""
Find exact transition points between normalized and raw logits.
"""

import json
import numpy as np
from pathlib import Path
import sys

def classify_token(filepath):
    """Quick classification: NORMALIZED or RAW LOGITS"""
    with open(filepath, 'r') as f:
        data = json.load(f)

    if not data.get('attention') or not data['attention'].get('data'):
        return None, None, None

    attention_data = np.array(data['attention']['data'])

    min_val = float(np.min(attention_data))
    max_val = float(np.max(attention_data))

    # Simple classification
    if min_val < -1 or max_val > 10:
        return "RAW_LOGITS", min_val, max_val
    elif min_val >= -0.01 and max_val <= 1.01:
        return "NORMALIZED", min_val, max_val
    else:
        return "UNKNOWN", min_val, max_val

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 find_transitions.py <capture_dir>")
        sys.exit(1)

    capture_dir = Path(sys.argv[1])
    token_files = sorted(capture_dir.glob('token_*.json'))

    print(f"Analyzing {len(token_files)} tokens for transitions...\n")

    prev_type = None
    transition_count = 0

    for idx, filepath in enumerate(token_files):
        type_str, min_val, max_val = classify_token(filepath)

        if type_str is None:
            continue

        # Detect transition
        if prev_type and prev_type != type_str:
            transition_count += 1
            print(f"🔄 TRANSITION #{transition_count} at token {idx}")
            print(f"   {prev_type} → {type_str}")
            print(f"   Token {idx-1}: min={prev_min:.2f}, max={prev_max:.2f}")
            print(f"   Token {idx}: min={min_val:.2f}, max={max_val:.2f}")
            print()

        prev_type = type_str
        prev_min = min_val
        prev_max = max_val

    print("="*60)
    print(f"Total transitions: {transition_count}")
    print()

    # Pattern analysis
    print("Checking for periodic pattern...")
    print()

    # Sample every 10 tokens
    for i in range(0, min(100, len(token_files)), 10):
        type_str, min_val, max_val = classify_token(token_files[i])
        print(f"Token {i:3d}: {type_str:12s} (min={min_val:8.2f}, max={max_val:8.2f})")

if __name__ == '__main__':
    main()
