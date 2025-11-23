#!/usr/bin/env python3
"""
Inspect individual token breakdown to see how "U.S." is tokenized
"""

import json
import sys

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 inspect_tokens.py <metadata.json>")
        sys.exit(1)

    metadata_path = sys.argv[1]

    with open(metadata_path, 'r') as f:
        data = json.load(f)

    tokens = data.get('prompt_tokens', data.get('tokens', []))

    print("=" * 80)
    print("INSPECTING SENTENCE 4 TOKENS (The U.S.)")
    print("=" * 80)

    # Find tokens in Turn 1, Sentence 4
    sentence_4_tokens = [t for t in tokens if t['turn_id'] == 1 and t['sentence_id'] == 4]

    for i, token in enumerate(sentence_4_tokens):
        text_repr = repr(token['text'])
        print(f"Token {i}: {text_repr}")
        print(f"  Token ID: {token['token_id']}")
        print(f"  Position: {token['position']}")
        print(f"  Sentence ID: {token['sentence_id']}")
        print()

    print("=" * 80)
    print(f"Total tokens in sentence 4: {len(sentence_4_tokens)}")
    print(f"Reconstructed text: '{' '.join([t['text'] for t in sentence_4_tokens])}'")
    print("=" * 80)

if __name__ == '__main__':
    main()
