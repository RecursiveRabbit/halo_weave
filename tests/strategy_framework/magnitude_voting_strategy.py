#!/usr/bin/env python3
"""
Magnitude-Weighted Voting Strategy - Intensity-aware voting

For each generation step:
1. Aggregate attention across layers/heads
2. Calculate local mean attention
3. If token attention > mean: score += int(attention / mean)
4. If token attention <= mean: score -= 1
5. Clamp score to [0, 255]

Strong references award bigger boosts (+6 for 6.5x mean, +50 for 50x mean).
Weak/no references apply gentle decay (-1).
New tokens start at 255.
"""

import json
import numpy as np
from pathlib import Path
from collections import defaultdict
import sys
import time

from base_strategy import BrightnessStrategy


class MagnitudeVotingStrategy(BrightnessStrategy):
    """Magnitude-weighted voting - captures reference intensity"""

    def __init__(self, capture_dir: Path, **kwargs):
        """
        Args:
            capture_dir: Path to capture directory
        """
        super().__init__(capture_dir, **kwargs)

    def get_strategy_name(self) -> str:
        return "Magnitude-Weighted Voting"

    def compute_scores(self) -> dict:
        """
        Compute brightness score with magnitude-weighted voting.

        Returns:
            {position: score} mapping, scores in [0, 255]
        """
        start_time = time.time()

        # Initialize all tokens to 255
        scores = {}
        for token in self.all_tokens:
            scores[token['position']] = 255

        token_files = self._load_token_files()

        print(f"Analyzing {len(token_files)} generation steps...")
        print(f"Total context: {len(self.all_tokens)} tokens")
        print(f"Initial score: 255 (all tokens)\n")

        skipped = 0
        total_increments = []  # Track magnitude of boosts for stats

        for idx, filepath in enumerate(token_files):
            try:
                with open(filepath, 'r') as f:
                    data = json.load(f)
            except json.JSONDecodeError:
                print(f"  Warning: Skipping {filepath.name} - malformed JSON", file=sys.stderr)
                skipped += 1
                continue

            # Skip if no attention
            if not data.get('attention') or not data['attention'].get('data'):
                continue

            # Aggregate attention for this generation step
            attention_data = data['attention']['data']
            shape = data['attention']['shape']
            aggregated = self._aggregate_attention(attention_data, shape)

            # Calculate local mean for this step
            local_mean = np.mean(aggregated)

            # Apply magnitude-weighted voting
            for pos_idx, attn_value in enumerate(aggregated):
                # Map attention index to actual token position
                if pos_idx < len(self.all_tokens):
                    actual_position = self.all_tokens[pos_idx]['position']

                    # Magnitude-weighted voting
                    if attn_value > local_mean:
                        # Integer division: 6.5x mean → +6
                        ratio = int(attn_value / local_mean)
                        scores[actual_position] += ratio
                        total_increments.append(ratio)
                    else:
                        # Gentle decay
                        scores[actual_position] -= 1

                    # No clamping - let scores go where they want!

            # Progress indicator
            if (idx + 1) % 50 == 0:
                print(f"  Processed {idx + 1}/{len(token_files)} steps...")

        if skipped > 0:
            print(f"  Skipped {skipped} malformed files")

        elapsed = time.time() - start_time
        print(f"\n⏱️  Total time: {elapsed:.2f}s ({elapsed/len(token_files)*1000:.2f}ms per token)")
        print(f"Completed: {len(scores)} tokens scored")

        # Print score distribution
        score_values = list(scores.values())
        print(f"Score distribution:")
        print(f"  Min: {min(score_values)}, Max: {max(score_values)}")
        print(f"  Mean: {np.mean(score_values):.2f}, Median: {np.median(score_values):.2f}")

        # Print increment statistics
        if total_increments:
            print(f"\nIncrement statistics (when attention > mean):")
            print(f"  Min: {min(total_increments)}, Max: {max(total_increments)}")
            print(f"  Mean: {np.mean(total_increments):.2f}, Median: {np.median(total_increments):.2f}")

        return scores


def main():
    """Standalone execution"""
    if len(sys.argv) < 2:
        print("Usage: python3 magnitude_voting_strategy.py <capture_dir> [export_file]")
        sys.exit(1)

    capture_dir = Path(sys.argv[1])
    export_file = Path(sys.argv[2]) if len(sys.argv) > 2 else None

    # Run strategy
    strategy = MagnitudeVotingStrategy(capture_dir, export_file=export_file)
    sentences, metadata = strategy.run()

    # Export results
    output_dir = Path('test_results') / capture_dir.name
    output_dir.mkdir(parents=True, exist_ok=True)

    strategy.export_markdown(sentences, metadata, output_dir / 'magnitude_voting_strategy.md')
    strategy.export_json(sentences, metadata, output_dir / 'magnitude_voting_strategy.json')

    print(f"\n{'='*80}")
    print(f"Results written to: {output_dir}")
    print(f"{'='*80}")


if __name__ == '__main__':
    main()
