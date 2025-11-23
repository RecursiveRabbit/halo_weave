#!/usr/bin/env python3
"""
Analyze attention data to detect raw logits vs normalized probabilities.
"""

import json
import numpy as np
from pathlib import Path
import sys

def analyze_token_file(filepath):
    """Analyze attention statistics for a single token file."""
    with open(filepath, 'r') as f:
        data = json.load(f)

    if not data.get('attention') or not data['attention'].get('data'):
        return None

    attention_data = np.array(data['attention']['data'])
    shape = data['attention']['shape']
    context_length = data['attention']['context_length']

    # Statistics
    stats = {
        'token_id': data['token_id'],
        'text': data['text'],
        'step': data['step'],
        'shape': shape,
        'context_length': context_length,
        'min': float(np.min(attention_data)),
        'max': float(np.max(attention_data)),
        'mean': float(np.mean(attention_data)),
        'std': float(np.std(attention_data)),
        'sum': float(np.sum(attention_data)),
        # Key indicators
        'has_negatives': bool(np.any(attention_data < 0)),
        'all_positive': bool(np.all(attention_data >= 0)),
        'looks_normalized': False,
        'looks_like_logits': False
    }

    # Detection heuristics (order matters - more specific checks first)
    # Strong indicators of raw logits
    if stats['has_negatives'] or stats['max'] > 10 or stats['min'] < -10:
        stats['looks_like_logits'] = True
    # Strong indicators of normalized probabilities
    elif stats['all_positive'] and stats['max'] <= 1.01 and stats['min'] >= -0.01:
        stats['looks_normalized'] = True

    # Check if sums to 1 per head (normalized probabilities)
    # Reshape to [layers, heads, context_length]
    if len(shape) == 3:
        reshaped = attention_data.reshape(shape)
        # Sum across context dimension for first few heads
        sums_per_head = []
        for layer in range(min(3, shape[0])):
            for head in range(min(3, shape[1])):
                head_sum = np.sum(reshaped[layer, head, :])
                sums_per_head.append(head_sum)

        stats['sample_head_sums'] = [float(s) for s in sums_per_head[:5]]

        # Only override if NOT already detected as logits
        if not stats['looks_like_logits']:
            if any(0.95 <= s <= 1.05 for s in sums_per_head):
                stats['looks_normalized'] = True

    return stats

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 analyze_attention.py <capture_dir>")
        sys.exit(1)

    capture_dir = Path(sys.argv[1])

    if not capture_dir.exists():
        print(f"Error: Directory {capture_dir} not found")
        sys.exit(1)

    # Find all token files
    token_files = sorted(capture_dir.glob('token_*.json'))

    print(f"Found {len(token_files)} token files in {capture_dir}")
    print("\nAnalyzing samples...\n")

    # Analyze specific tokens mentioned by user
    targets = [17, 150, 364]

    # Also sample throughout the sequence
    if len(token_files) > 10:
        samples = [0, 1, 5, 10, 20, 50, 100, 200, 300, len(token_files) - 1]
    else:
        samples = list(range(len(token_files)))

    # Combine targets and samples
    indices_to_check = sorted(set(targets + samples))
    indices_to_check = [i for i in indices_to_check if i < len(token_files)]

    print(f"{'Step':<6} {'Text':<20} {'Min':<12} {'Max':<12} {'Mean':<12} {'Sum':<12} {'Type':<15}")
    print("-" * 100)

    for idx in indices_to_check:
        filepath = token_files[idx]
        stats = analyze_token_file(filepath)

        if not stats:
            print(f"{idx:<6} [No attention data]")
            continue

        # Determine type
        if stats['looks_normalized']:
            type_str = "NORMALIZED"
        elif stats['looks_like_logits']:
            type_str = "RAW LOGITS"
        else:
            type_str = "UNKNOWN"

        text_preview = stats['text'][:18] if stats['text'] else '?'

        print(f"{stats['step']:<6} {text_preview:<20} {stats['min']:<12.4f} {stats['max']:<12.4f} "
              f"{stats['mean']:<12.4f} {stats['sum']:<12.2f} {type_str:<15}")

        # Show head sums if available
        if 'sample_head_sums' in stats and idx in targets:
            print(f"       Sample head sums: {stats['sample_head_sums']}")

    print("\n" + "="*100)
    print("\nDETECTION LOGIC:")
    print("- NORMALIZED: All positive, max ≤ 1, min ≥ 0, or head sums ≈ 1.0")
    print("- RAW LOGITS: Has negatives, or |values| > 10")
    print("\nIf there's a transition, it indicates KoboldCPP behavior changed mid-generation.")

if __name__ == '__main__':
    main()
