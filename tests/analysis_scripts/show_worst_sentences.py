#!/usr/bin/env python3
"""
Show the N worst sentences ranked by peak anchor score.
If you had to delete N sentences, which would they be?
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
    return metadata.get('prompt_tokens', [])

def aggregate_attention(attention_data, shape):
    """Aggregate attention tensor across layers and heads."""
    n_layers, n_heads, context_len = shape
    tensor = np.array(attention_data).reshape(shape)
    return np.mean(tensor, axis=(0, 1))

def analyze_anchors(capture_dir):
    """Calculate vote counts for each token."""
    capture_dir = Path(capture_dir)
    prompt_tokens = load_metadata(capture_dir)

    votes = defaultdict(int)
    token_files = sorted(capture_dir.glob('token_*.json'))

    for filepath in token_files:
        with open(filepath, 'r') as f:
            data = json.load(f)

        if not data.get('attention') or not data['attention'].get('data'):
            continue

        aggregated = aggregate_attention(data['attention']['data'], data['attention']['shape'])
        local_mean = np.mean(aggregated)

        for pos_idx, attn_value in enumerate(aggregated):
            if pos_idx < len(prompt_tokens):
                position = prompt_tokens[pos_idx]['position']
                if attn_value > local_mean:
                    votes[position] += 1

    return votes, len(token_files), prompt_tokens

def group_by_sentence(prompt_tokens, votes):
    """Group tokens by sentence and calculate sentence-level statistics."""
    sentences = defaultdict(lambda: {
        'tokens': [],
        'positions': [],
        'votes': [],
        'turn_id': None,
        'message_role': None
    })

    for token in prompt_tokens:
        sent_id = token['sentence_id']
        position = token['position']

        sentences[sent_id]['tokens'].append(token['text'])
        sentences[sent_id]['positions'].append(position)
        sentences[sent_id]['votes'].append(votes.get(position, 0))
        sentences[sent_id]['turn_id'] = token['turn_id']
        sentences[sent_id]['message_role'] = token['message_role']

    # Calculate statistics for each sentence
    sentence_stats = []
    for sent_id, data in sentences.items():
        peak_votes = max(data['votes'])
        mean_votes = np.mean(data['votes'])
        min_votes = min(data['votes'])
        text = ''.join(data['tokens'])

        sentence_stats.append({
            'sentence_id': sent_id,
            'turn_id': data['turn_id'],
            'message_role': data['message_role'],
            'text': text,
            'n_tokens': len(data['tokens']),
            'peak_votes': peak_votes,
            'mean_votes': mean_votes,
            'min_votes': min_votes,
        })

    return sentence_stats

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 show_worst_sentences.py <capture_dir> [n_worst]")
        sys.exit(1)

    capture_dir = sys.argv[1]
    n_worst = int(sys.argv[2]) if len(sys.argv) > 2 else 10

    votes, total_steps, prompt_tokens = analyze_anchors(capture_dir)
    sentence_stats = group_by_sentence(prompt_tokens, votes)

    # Sort by peak votes (ascending - worst first)
    sentence_stats.sort(key=lambda x: x['peak_votes'])

    total_sentences = len(sentence_stats)
    worst_sentences = sentence_stats[:n_worst]

    print(f"\n{'='*140}")
    print(f"WORST {n_worst} SENTENCES (Ranked by Peak Anchor Score)")
    print(f"Total sentences: {total_sentences}")
    print(f"Total generation steps: {total_steps}")
    print(f"{'='*140}\n")

    print(f"{'Rank':<6} {'Peak':<8} {'Mean':<8} {'Tokens':<8} {'Turn':<6} {'Role':<10} {'Text':<70}")
    print("-"*140)

    total_tokens = len(prompt_tokens)
    pruned_tokens = 0

    for rank, sent in enumerate(worst_sentences, 1):
        role = sent['message_role'][:8]
        text_preview = sent['text'][:68].replace('\n', '\\n')

        print(f"{rank:<6} {sent['peak_votes']:<8} {sent['mean_votes']:<8.1f} "
              f"{sent['n_tokens']:<8} {sent['turn_id']:<6} {role:<10} {text_preview}")

        pruned_tokens += sent['n_tokens']

    # Show pruning impact
    print("\n" + "="*140)
    print(f"PRUNING IMPACT:")
    print(f"  Total context: {total_tokens} tokens")
    print(f"  Sentences to prune: {n_worst}/{total_sentences} ({n_worst/total_sentences*100:.1f}%)")
    print(f"  Tokens to prune: {pruned_tokens}/{total_tokens} ({pruned_tokens/total_tokens*100:.1f}%)")
    print(f"  After pruning: {total_tokens - pruned_tokens} tokens ({(total_tokens-pruned_tokens)/total_tokens*100:.1f}%)")

    # Statistics on the worst
    worst_peaks = [s['peak_votes'] for s in worst_sentences]
    print(f"\nWORST {n_worst} STATISTICS:")
    print(f"  Peak vote range: {min(worst_peaks)} - {max(worst_peaks)}")
    print(f"  Mean peak: {np.mean(worst_peaks):.1f}")
    print(f"  Median peak: {np.median(worst_peaks):.1f}")

    # Compare to overall
    all_peaks = [s['peak_votes'] for s in sentence_stats]
    print(f"\nOVERALL STATISTICS:")
    print(f"  Peak vote range: {min(all_peaks)} - {max(all_peaks)}")
    print(f"  Mean peak: {np.mean(all_peaks):.1f}")
    print(f"  Median peak: {np.median(all_peaks):.1f}")

    # Show best sentences for comparison
    print(f"\n{'='*140}")
    print(f"BEST {min(5, total_sentences)} SENTENCES (For Comparison)")
    print(f"{'='*140}\n")

    best_sentences = sentence_stats[-5:][::-1]  # Top 5, reversed

    print(f"{'Rank':<6} {'Peak':<8} {'Mean':<8} {'Tokens':<8} {'Turn':<6} {'Role':<10} {'Text':<70}")
    print("-"*140)

    for rank, sent in enumerate(best_sentences, 1):
        role = sent['message_role'][:8]
        text_preview = sent['text'][:68].replace('\n', '\\n')

        print(f"{rank:<6} {sent['peak_votes']:<8} {sent['mean_votes']:<8.1f} "
              f"{sent['n_tokens']:<8} {sent['turn_id']:<6} {role:<10} {text_preview}")

if __name__ == '__main__':
    main()
