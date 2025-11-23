#!/usr/bin/env python3
"""
Anchor Token Discovery - Rolling Average Voting System

For each generation step:
1. Aggregate attention across layers/heads
2. Calculate local mean attention
3. Award +1 point to each token above local mean

Tokens with the most points = Anchor tokens (consistently referenced)
"""

import json
import numpy as np
from pathlib import Path
import sys
from collections import defaultdict

def load_metadata(capture_dir):
    """Load prompt tokens from metadata"""
    metadata_file = capture_dir / 'metadata.json'
    with open(metadata_file, 'r') as f:
        metadata = json.load(f)

    prompt_tokens = metadata.get('prompt_tokens', [])
    print(f"Loaded metadata: {len(prompt_tokens)} prompt tokens")

    return prompt_tokens

def aggregate_attention(attention_data, shape):
    """
    Aggregate attention tensor across layers and heads.
    Input: [layers, heads, context_length]
    Output: [context_length] - mean attention per token
    """
    n_layers, n_heads, context_len = shape

    # Reshape to [layers, heads, context_length]
    tensor = np.array(attention_data).reshape(shape)

    # Mean across layers and heads
    aggregated = np.mean(tensor, axis=(0, 1))  # [context_length]

    return aggregated

def analyze_anchors(capture_dir, aggregation='mean', min_distance=50):
    """
    Find anchor tokens using rolling average voting.

    Args:
        min_distance: Only count votes for tokens at least this far behind generation head

    Returns:
        dict: {position: {'votes': count, 'text': str, 'avg_attention': float}}
    """
    capture_dir = Path(capture_dir)

    # Load prompt tokens
    prompt_tokens = load_metadata(capture_dir)
    prompt_length = len(prompt_tokens)

    # Build position -> text mapping
    position_to_text = {}
    for token in prompt_tokens:
        position_to_text[token['position']] = token['text']

    # Vote tracking
    votes = defaultdict(int)        # position -> vote count
    attention_sum = defaultdict(float)  # position -> sum of attention values
    attention_count = defaultdict(int)  # position -> count of measurements

    # Find all token files
    token_files = sorted(capture_dir.glob('token_*.json'))

    print(f"\nAnalyzing {len(token_files)} generation steps...")
    print(f"Prompt context: {prompt_length} tokens")

    skipped = 0
    for idx, filepath in enumerate(token_files):
        try:
            with open(filepath, 'r') as f:
                data = json.load(f)
        except json.JSONDecodeError as e:
            print(f"  Warning: Skipping {filepath.name} - malformed JSON", file=sys.stderr)
            skipped += 1
            continue

        # Skip if no attention
        if not data.get('attention') or not data['attention'].get('data'):
            continue

        # Aggregate attention for this generation step
        attention_data = data['attention']['data']
        shape = data['attention']['shape']

        aggregated = aggregate_attention(attention_data, shape)  # [context_length]

        # Calculate local mean for this step
        local_mean = np.mean(aggregated)

        # Current generation position (context length)
        current_position = shape[2]  # context_length from shape

        # Award votes to tokens above mean
        for pos_idx, attn_value in enumerate(aggregated):
            # pos_idx is the index in the attention vector
            # For prompt tokens, this maps directly to position
            if pos_idx < prompt_length:
                actual_position = prompt_tokens[pos_idx]['position']

                # CRITICAL: Only count votes for tokens at least min_distance behind generation head
                # This prevents newly generated tokens from getting inflated scores
                if (current_position - actual_position) < min_distance:
                    continue

                # Accumulate statistics
                attention_sum[actual_position] += attn_value
                attention_count[actual_position] += 1

                # Vote if above local mean
                if attn_value > local_mean:
                    votes[actual_position] += 1

        # Progress indicator
        if (idx + 1) % 50 == 0:
            print(f"  Processed {idx + 1}/{len(token_files)} steps...")

    if skipped > 0:
        print(f"  Skipped {skipped} malformed files")

    # Calculate average attention per token
    results = {}
    for position in votes.keys():
        avg_attn = attention_sum[position] / attention_count[position] if attention_count[position] > 0 else 0

        results[position] = {
            'votes': votes[position],
            'text': position_to_text.get(position, '?'),
            'avg_attention': avg_attn,
            'vote_rate': votes[position] / len(token_files) * 100  # % of steps voted for
        }

    return results, len(token_files)

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 find_anchors.py <capture_dir> [top_n] [min_distance]")
        sys.exit(1)

    capture_dir = sys.argv[1]
    top_n = int(sys.argv[2]) if len(sys.argv) > 2 else 50
    min_distance = int(sys.argv[3]) if len(sys.argv) > 3 else 50

    # Analyze
    print(f"Min distance from generation head: {min_distance} tokens", file=sys.stderr)
    results, total_steps = analyze_anchors(capture_dir, min_distance=min_distance)

    # Sort by vote count (descending)
    sorted_tokens = sorted(results.items(), key=lambda x: x[1]['votes'], reverse=True)

    print("\n" + "="*100)
    print(f"ANCHOR TOKENS - Top {top_n} (from {total_steps} generation steps)")
    print("="*100)
    print(f"\n{'Pos':<6} {'Votes':<8} {'Vote%':<8} {'Avg Attn':<12} {'Text':<40}")
    print("-"*100)

    for position, stats in sorted_tokens[:top_n]:
        text_preview = stats['text'][:38] if stats['text'] else '?'
        print(f"{position:<6} {stats['votes']:<8} {stats['vote_rate']:<7.1f}% {stats['avg_attention']:<12.6f} {text_preview}")

    print("\n" + "="*100)
    print("\nANCHOR INTERPRETATION:")
    print("- Votes: How many generation steps this token was above local mean")
    print("- Vote%: Percentage of steps that voted for this token")
    print("- Avg Attn: Average attention value across all steps")
    print()
    print("High vote count = Consistently referenced = ANCHOR TOKEN")
    print("Low vote count = Rarely referenced = Safe to delete")

    # Statistics
    vote_counts = [s['votes'] for s in results.values()]
    print(f"\nVOTE STATISTICS:")
    print(f"  Max votes: {max(vote_counts)}")
    print(f"  Mean votes: {np.mean(vote_counts):.1f}")
    print(f"  Median votes: {np.median(vote_counts):.1f}")
    print(f"  Min votes: {min(vote_counts)}")

    # Recommendation
    threshold = np.percentile(vote_counts, 25)  # Bottom 25%
    print(f"\nRECOMMENDED PRUNING THRESHOLD:")
    print(f"  Delete tokens with < {threshold:.0f} votes ({threshold/total_steps*100:.1f}% vote rate)")
    print(f"  This would prune ~25% of context")

if __name__ == '__main__':
    main()
