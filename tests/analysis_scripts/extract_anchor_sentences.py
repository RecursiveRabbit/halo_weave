#!/usr/bin/env python3
"""
Extract sentences with peak > 0 and show them in original order.
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
        'sentence_id': None
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

    sentence_list = []
    for key, data in sentences.items():
        peak_votes = max(data['votes'])
        text = ''.join(data['tokens'])

        sentence_list.append({
            'turn_id': data['turn_id'],
            'sentence_id': data['sentence_id'],
            'text': text,
            'peak_votes': peak_votes,
            'n_tokens': len(data['tokens'])
        })

    return sentence_list

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 extract_anchor_sentences.py <capture_dir>")
        sys.exit(1)

    capture_dir = sys.argv[1]

    votes, total_steps, prompt_tokens = analyze_anchors(capture_dir)
    sentences = group_by_sentence(prompt_tokens, votes)

    # Sort by (turn_id, sentence_id) to preserve original order
    sentences.sort(key=lambda x: (x['turn_id'], x['sentence_id']))

    # Separate peak=0 and peak>0
    zero_peak = [s for s in sentences if s['peak_votes'] == 0]
    nonzero_peak = [s for s in sentences if s['peak_votes'] > 0]

    print(f"Total sentences: {len(sentences)}")
    print(f"Sentences with peak = 0: {len(zero_peak)}")
    print(f"Sentences with peak > 0: {len(nonzero_peak)}")
    print(f"Total generation steps: {total_steps}")
    print()

    # Show the sentences with peak > 0
    print("="*80)
    print("SENTENCES WITH PEAK > 0 (in original order)")
    print("="*80)
    print()

    for sent in nonzero_peak:
        print(f"[Turn {sent['turn_id']}, Sentence {sent['sentence_id']}, Peak={sent['peak_votes']}, Tokens={sent['n_tokens']}]")
        print(sent['text'])
        print()

if __name__ == '__main__':
    main()
