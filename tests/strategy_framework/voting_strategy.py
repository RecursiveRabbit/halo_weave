#!/usr/bin/env python3
"""
Voting Strategy - Rolling Mean Voting System

For each generation step:
1. Aggregate attention across layers/heads
2. Calculate local mean attention
3. Award +1 vote to each token above local mean
4. Optional: Only count votes for tokens far from generation head (min_distance)

Tokens with the most votes = Anchor tokens (consistently referenced)
"""

import json
import numpy as np
from pathlib import Path
from collections import defaultdict
import sys

from base_strategy import BrightnessStrategy


class VotingStrategy(BrightnessStrategy):
    """Rolling mean voting - discrete vote counts"""

    def __init__(self, capture_dir: Path, min_distance: int = 50, **kwargs):
        """
        Args:
            capture_dir: Path to capture directory
            min_distance: Only count votes for tokens at least this far behind generation head
        """
        super().__init__(capture_dir, min_distance=min_distance, **kwargs)

    def get_strategy_name(self) -> str:
        return "Rolling Mean Voting"

    def compute_scores(self) -> dict:
        """
        Compute vote count for each token.

        Returns:
            {position: vote_count} mapping
        """
        votes = defaultdict(int)
        attention_sum = defaultdict(float)
        attention_count = defaultdict(int)

        prompt_length = len(self.prompt_tokens)
        token_files = self._load_token_files()

        print(f"Analyzing {len(token_files)} generation steps...")
        print(f"Total context: {len(self.all_tokens)} tokens")
        print(f"Min distance filter: {self.parameters['min_distance']} tokens\n")

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

            # Current generation position
            current_position = shape[2]  # context_length from shape

            # Award votes to tokens above mean
            for pos_idx, attn_value in enumerate(aggregated):
                # Map attention index to actual token position
                if pos_idx < len(self.all_tokens):
                    actual_position = self.all_tokens[pos_idx]['position']

                    # Min-distance filter: Only count votes for tokens far behind generation head
                    if (current_position - pos_idx) < self.parameters['min_distance']:
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

        print(f"\nCompleted: {len(votes)} tokens scored")

        # Return votes as scores
        return dict(votes)


def main():
    """Standalone execution"""
    if len(sys.argv) < 2:
        print("Usage: python3 voting_strategy.py <capture_dir> [min_distance] [export_file]")
        sys.exit(1)

    capture_dir = Path(sys.argv[1])
    min_distance = int(sys.argv[2]) if len(sys.argv) > 2 else 50
    export_file = Path(sys.argv[3]) if len(sys.argv) > 3 else None

    # Run strategy
    strategy = VotingStrategy(capture_dir, export_file=export_file, min_distance=min_distance)
    sentences, metadata = strategy.run()

    # Export results
    output_dir = Path('test_results') / capture_dir.name
    output_dir.mkdir(parents=True, exist_ok=True)

    strategy.export_markdown(sentences, metadata, output_dir / 'voting_strategy.md')
    strategy.export_json(sentences, metadata, output_dir / 'voting_strategy.json')

    print(f"\n{'='*80}")
    print(f"Results written to: {output_dir}")
    print(f"{'='*80}")


if __name__ == '__main__':
    main()
