#!/usr/bin/env python3
"""
Visualize anchor token distribution and identify prunable sentences.
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

    # Calculate peak brightness for each sentence
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
            'positions': data['positions']
        })

    return sentence_stats

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 visualize_anchors.py <capture_dir> [threshold]")
        sys.exit(1)

    capture_dir = sys.argv[1]
    threshold = int(sys.argv[2]) if len(sys.argv) > 2 else 19  # Default from analysis

    votes, total_steps, prompt_tokens = analyze_anchors(capture_dir)
    sentence_stats = group_by_sentence(prompt_tokens, votes)

    # Sort by peak votes (descending)
    sentence_stats.sort(key=lambda x: x['peak_votes'], reverse=True)

    print(f"\n{'='*120}")
    print(f"SENTENCE-LEVEL ANCHOR ANALYSIS")
    print(f"Total generation steps: {total_steps}")
    print(f"Pruning threshold: {threshold} votes ({threshold/total_steps*100:.1f}%)")
    print(f"{'='*120}\n")

    # Separate into keep vs prune
    keep_sentences = []
    prune_sentences = []

    for sent in sentence_stats:
        if sent['peak_votes'] >= threshold:
            keep_sentences.append(sent)
        else:
            prune_sentences.append(sent)

    # Display keepers
    print(f"✅ KEEP ({len(keep_sentences)} sentences) - Peak votes >= {threshold}\n")
    print(f"{'Turn':<6} {'Role':<10} {'Tokens':<8} {'Peak':<8} {'Mean':<8} {'Text':<70}")
    print("-"*120)

    for sent in keep_sentences:
        role = sent['message_role'][:8]
        text_preview = sent['text'][:68]
        print(f"{sent['turn_id']:<6} {role:<10} {sent['n_tokens']:<8} "
              f"{sent['peak_votes']:<8} {sent['mean_votes']:<8.1f} {text_preview}")

    # Display prunable
    print(f"\n❌ PRUNE ({len(prune_sentences)} sentences) - Peak votes < {threshold}\n")
    print(f"{'Turn':<6} {'Role':<10} {'Tokens':<8} {'Peak':<8} {'Mean':<8} {'Text':<70}")
    print("-"*120)

    for sent in prune_sentences:
        role = sent['message_role'][:8]
        text_preview = sent['text'][:68]
        print(f"{sent['turn_id']:<6} {role:<10} {sent['n_tokens']:<8} "
              f"{sent['peak_votes']:<8} {sent['mean_votes']:<8.1f} {text_preview}")

    # Statistics
    total_tokens = len(prompt_tokens)
    pruned_tokens = sum(sent['n_tokens'] for sent in prune_sentences)
    kept_tokens = total_tokens - pruned_tokens

    print(f"\n{'='*120}")
    print(f"PRUNING IMPACT:")
    print(f"  Original context: {total_tokens} tokens")
    print(f"  After pruning: {kept_tokens} tokens ({kept_tokens/total_tokens*100:.1f}%)")
    print(f"  Pruned: {pruned_tokens} tokens ({pruned_tokens/total_tokens*100:.1f}%)")
    print(f"  Sentences pruned: {len(prune_sentences)}/{len(sentence_stats)} ({len(prune_sentences)/len(sentence_stats)*100:.1f}%)")

    # Distribution histogram
    all_votes = list(votes.values())
    print(f"\nVOTE DISTRIBUTION:")
    bins = [0, 19, 50, 100, 150, 200, 302]
    hist, _ = np.histogram(all_votes, bins=bins)

    for i in range(len(bins)-1):
        count = hist[i]
        pct = count / len(all_votes) * 100
        bar = '█' * int(pct / 2)
        print(f"  {bins[i]:3d}-{bins[i+1]:3d} votes: {bar} {count:3d} tokens ({pct:5.1f}%)")

if __name__ == '__main__':
    main()
