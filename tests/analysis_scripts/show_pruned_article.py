#!/usr/bin/env python3
"""
Show the article before and after pruning.
Display what gets kept (peak > 0) vs what gets deleted (peak = 0).
"""

import json
import numpy as np
from pathlib import Path
import sys
from collections import defaultdict

def load_metadata(capture_dir):
    metadata_file = capture_dir / 'metadata.json'
    with open(metadata_file, 'r') as f:
        metadata = json.load(f)
    return metadata.get('prompt_tokens', [])

def aggregate_attention(attention_data, shape):
    n_layers, n_heads, context_len = shape
    tensor = np.array(attention_data).reshape(shape)
    return np.mean(tensor, axis=(0, 1))

def analyze_anchors(capture_dir, min_distance=50):
    capture_dir = Path(capture_dir)
    prompt_tokens = load_metadata(capture_dir)

    votes = defaultdict(int)
    token_files = sorted(capture_dir.glob('token_*.json'))

    print(f"Analyzing {len(token_files)} generation steps...", file=sys.stderr)
    print(f"Min distance from generation head: {min_distance} tokens", file=sys.stderr)

    for filepath in token_files:
        try:
            with open(filepath, 'r') as f:
                data = json.load(f)
        except json.JSONDecodeError:
            continue  # Skip malformed files

        if not data.get('attention') or not data['attention'].get('data'):
            continue

        aggregated = aggregate_attention(data['attention']['data'], data['attention']['shape'])
        shape = data['attention']['shape']
        local_mean = np.mean(aggregated)
        current_position = shape[2]

        for pos_idx, attn_value in enumerate(aggregated):
            if pos_idx < len(prompt_tokens):
                position = prompt_tokens[pos_idx]['position']

                # Only count votes for tokens at least min_distance behind generation head
                if (current_position - position) < min_distance:
                    continue

                if attn_value > local_mean:
                    votes[position] += 1

    return votes, len(token_files), prompt_tokens

def group_by_sentence(prompt_tokens, votes):
    sentences = defaultdict(lambda: {
        'tokens': [],
        'positions': [],
        'votes': [],
        'turn_id': None,
        'sentence_id': None,
        'role': None
    })

    for token in prompt_tokens:
        # Key by (turn_id, sentence_id) since sentence_id resets each turn
        key = (token['turn_id'], token['sentence_id'])
        position = token['position']

        sentences[key]['tokens'].append(token['text'])
        sentences[key]['positions'].append(position)
        sentences[key]['votes'].append(votes.get(position, 0))
        sentences[key]['turn_id'] = token['turn_id']
        sentences[key]['sentence_id'] = token['sentence_id']
        sentences[key]['role'] = token['message_role']

    sentence_list = []
    for key, data in sentences.items():
        peak_votes = max(data['votes']) if data['votes'] else 0
        text = ''.join(data['tokens'])

        sentence_list.append({
            'turn_id': data['turn_id'],
            'sentence_id': data['sentence_id'],
            'role': data['role'],
            'text': text,
            'peak_votes': peak_votes,
            'n_tokens': len(data['tokens'])
        })

    return sentence_list

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 show_pruned_article.py <capture_dir>")
        sys.exit(1)

    capture_dir = sys.argv[1]

    votes, total_steps, prompt_tokens = analyze_anchors(capture_dir)
    sentences = group_by_sentence(prompt_tokens, votes)

    # Sort by (turn_id, sentence_id) to preserve original order
    sentences.sort(key=lambda x: (x['turn_id'], x['sentence_id']))

    # Separate kept vs pruned
    kept = [s for s in sentences if s['peak_votes'] > 0]
    pruned = [s for s in sentences if s['peak_votes'] == 0]

    # Calculate token counts
    kept_tokens = sum(s['n_tokens'] for s in kept)
    pruned_tokens = sum(s['n_tokens'] for s in pruned)
    total_tokens = kept_tokens + pruned_tokens

    print("\n" + "="*80)
    print("PRUNING ANALYSIS")
    print("="*80)
    print(f"Total sentences: {len(sentences)}")
    print(f"Total tokens: {total_tokens}")
    print(f"\nKEPT (peak > 0): {len(kept)} sentences, {kept_tokens} tokens ({kept_tokens/total_tokens*100:.1f}%)")
    print(f"PRUNED (peak = 0): {len(pruned)} sentences, {pruned_tokens} tokens ({pruned_tokens/total_tokens*100:.1f}%)")
    print(f"\nGeneration steps analyzed: {total_steps}")
    print("="*80)

    # Show kept content
    print("\n" + "="*80)
    print("AFTER PRUNING - WHAT THE MODEL SEES:")
    print("="*80)
    print()

    current_turn = None
    for sent in kept:
        # Add turn headers
        if sent['turn_id'] != current_turn:
            if current_turn is not None:
                print()  # Blank line between turns
            print(f"[{sent['role'].upper()}]")
            current_turn = sent['turn_id']

        # Print sentence with peak annotation
        print(f"{sent['text']}", end='')

    print("\n\n" + "="*80)
    print("WHAT GOT PRUNED:")
    print("="*80)
    print()

    current_turn = None
    for sent in pruned:
        # Add turn headers
        if sent['turn_id'] != current_turn:
            if current_turn is not None:
                print()
            print(f"[{sent['role'].upper()}]")
            current_turn = sent['turn_id']

        # Print sentence
        print(f"{sent['text']}", end='')

    print("\n\n" + "="*80)
    print("SUMMARY")
    print("="*80)
    print(f"Compression ratio: {pruned_tokens/total_tokens*100:.1f}% reduction")
    print(f"Context saved: {pruned_tokens} tokens")
    print("="*80)

if __name__ == '__main__':
    main()
