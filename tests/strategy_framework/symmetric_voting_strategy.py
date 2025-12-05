#!/usr/bin/env python3
"""
Symmetric Voting Strategy - Balanced increment/decrement voting

For each generation step:
1. Aggregate attention across layers/heads
2. Calculate local mean attention
3. If token attention > mean: score += 1
4. If token attention <= mean: score -= 1
5. Clamp score to [0, 255]

New tokens start at 255. A token ignored for 255 generations drops to 0.
Tokens must "earn their keep" by being referenced to maintain brightness.
"""

import json
import numpy as np
from pathlib import Path
from collections import defaultdict
import sys

from base_strategy import BrightnessStrategy


class SymmetricVotingStrategy(BrightnessStrategy):
    """Symmetric ±1 voting - natural decay mechanism"""

    def __init__(self, capture_dir: Path, **kwargs):
        """
        Args:
            capture_dir: Path to capture directory
        """
        super().__init__(capture_dir, **kwargs)

    def get_strategy_name(self) -> str:
        return "Symmetric Voting (±1)"

    def compute_scores(self) -> dict:
        """
        Compute brightness score for each token with symmetric voting.

        Returns:
            {position: score} mapping, scores in [0, 255]
        """
        # Initialize all tokens to 255
        scores = {}
        for token in self.all_tokens:
            scores[token['position']] = 255

        token_files = self._load_token_files()

        print(f"Analyzing {len(token_files)} generation steps...")
        print(f"Total context: {len(self.all_tokens)} tokens")
        print(f"Initial score: 255 (all tokens)\n")

        skipped = 0
        for idx, filepath in enumerate(token_files):
            try:
                data = self._load_token_data(filepath)
            except (json.JSONDecodeError, IOError) as e:
                print(f"  Warning: Skipping {filepath.name} - {e}", file=sys.stderr)
                skipped += 1
                continue

            # Skip if no attention
            if data.get('attention_data') is None or data.get('attention_shape') is None:
                continue

            # Aggregate attention for this generation step
            attention_data = data['attention_data']
            shape = data['attention_shape']
            aggregated = self._aggregate_attention(attention_data, shape)

            # Calculate local mean for this step
            local_mean = np.mean(aggregated)

            # Apply symmetric voting
            for pos_idx, attn_value in enumerate(aggregated):
                # Map attention index to actual token position
                if pos_idx < len(self.all_tokens):
                    actual_position = self.all_tokens[pos_idx]['position']

                    # Symmetric voting: +1 if above mean, -1 if below
                    if attn_value > local_mean:
                        scores[actual_position] += 1
                    else:
                        scores[actual_position] -= 1

                    # No clamping - let scores go where they want!

            # Progress indicator
            if (idx + 1) % 50 == 0:
                print(f"  Processed {idx + 1}/{len(token_files)} steps...")

        if skipped > 0:
            print(f"  Skipped {skipped} malformed files")

        print(f"\nCompleted: {len(scores)} tokens scored")

        # Print score distribution
        score_values = list(scores.values())
        print(f"Score distribution:")
        print(f"  Min: {min(score_values)}, Max: {max(score_values)}")
        print(f"  Mean: {np.mean(score_values):.2f}, Median: {np.median(score_values):.2f}")

        return scores


def main():
    """Standalone execution"""
    if len(sys.argv) < 2:
        print("Usage: python3 symmetric_voting_strategy.py <capture_dir> [export_file]")
        sys.exit(1)

    capture_dir = Path(sys.argv[1])
    export_file = Path(sys.argv[2]) if len(sys.argv) > 2 else None

    # Run strategy
    strategy = SymmetricVotingStrategy(capture_dir, export_file=export_file)
    sentences, metadata = strategy.run()

    # Export results
    output_dir = Path('test_results') / capture_dir.name
    output_dir.mkdir(parents=True, exist_ok=True)

    strategy.export_markdown(sentences, metadata, output_dir / 'symmetric_voting_strategy.md')
    strategy.export_json(sentences, metadata, output_dir / 'symmetric_voting_strategy.json')

    print(f"\n{'='*80}")
    print(f"Results written to: {output_dir}")
    print(f"{'='*80}")


if __name__ == '__main__':
    main()
