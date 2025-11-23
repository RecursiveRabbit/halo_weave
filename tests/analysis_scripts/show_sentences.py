#!/usr/bin/env python3
"""
Show sentence boundaries from metadata.json
Displays each sentence on one line with turn:sentence prefix
"""

import json
import sys
from collections import defaultdict

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 show_sentences.py <metadata.json>")
        sys.exit(1)

    metadata_path = sys.argv[1]

    with open(metadata_path, 'r') as f:
        data = json.load(f)

    # metadata.json has 'prompt_tokens' field
    tokens = data.get('prompt_tokens', data.get('tokens', []))

    # Group tokens by (turn_id, sentence_id, message_role)
    sentences = defaultdict(list)
    for token in tokens:
        if token.get('deleted', False):
            continue
        key = (token['turn_id'], token['sentence_id'], token['message_role'])
        sentences[key].append(token)

    # Sort by turn, then sentence
    sorted_keys = sorted(sentences.keys(), key=lambda x: (x[0], x[1]))

    print("=" * 80)
    print("SENTENCE BOUNDARIES")
    print("=" * 80)

    for turn_id, sentence_id, role in sorted_keys:
        tokens_in_sentence = sentences[(turn_id, sentence_id, role)]
        text = ''.join([t['text'] for t in tokens_in_sentence])
        num_tokens = len(tokens_in_sentence)

        print(f"\nTurn {turn_id}, Sentence {sentence_id} ({role}) [{num_tokens} tokens]:")
        print(f"  {text}")

    print("\n" + "=" * 80)
    print(f"Total sentences: {len(sentences)}")
    print(f"Total tokens: {len(tokens)}")
    print("=" * 80)

if __name__ == '__main__':
    main()
