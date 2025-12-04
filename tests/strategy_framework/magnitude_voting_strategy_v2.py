#!/usr/bin/env python3
"""
Magnitude-Weighted Voting Strategy v2 - OPTIMIZED

Optimizations:
1. O(1) mean calculation - Softmax sums to 1, so mean = 1/n
2. BOS exclusion - Skip position 0 from threshold and scoring
3. NumPy vectorization - Replace Python loops with vectorized ops

For each generation step:
1. Aggregate attention across layers/heads
2. Calculate threshold excluding BOS: (1.0 - bos_attention) / (n - 1)
3. Vectorized updates:
   - If token attention > threshold: score += int(attention / threshold)
   - If token attention <= threshold: score -= 1

Strong references award bigger boosts (+6 for 6.5x threshold, +50 for 50x threshold).
Weak/no references apply gentle decay (-1).
New tokens start at 255.
BOS (position 0) is never scored or pruned.
"""

import json
import numpy as np
from pathlib import Path
from collections import defaultdict
import sys
import time

from base_strategy import BrightnessStrategy


class MagnitudeVotingStrategyV2(BrightnessStrategy):
    """Magnitude-weighted voting v2 - optimized with vectorization"""

    def __init__(self, capture_dir: Path, **kwargs):
        """
        Args:
            capture_dir: Path to capture directory
        """
        super().__init__(capture_dir, **kwargs)

    def get_strategy_name(self) -> str:
        return "Magnitude-Weighted Voting v2 (Optimized)"

    def compute_scores(self) -> dict:
        """
        Compute brightness score with magnitude-weighted voting.
        Optimized with vectorization and O(1) mean calculation.

        Returns:
            {position: score} mapping
        """
        start_time = time.time()

        # Initialize all tokens to 255, EXCEPT position 0 (BOS)
        scores = {}
        non_bos_tokens = []
        for token in self.all_tokens:
            if token['position'] > 0:
                scores[token['position']] = 255
                non_bos_tokens.append(token['position'])

        # Convert to numpy array for vectorized operations
        positions_array = np.array(non_bos_tokens)

        token_files = self._load_token_files()

        print(f"Analyzing {len(token_files)} generation steps...")
        print(f"Total context: {len(self.all_tokens)} tokens ({len(non_bos_tokens)} non-BOS)")
        print(f"Initial score: 255 (all non-BOS tokens)")
        print(f"BOS token (position 0) excluded from scoring\n")

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

            # O(1) threshold calculation excluding BOS
            bos_attention = aggregated[0]
            non_bos_attention = aggregated[1:len(self.all_tokens)]
            threshold = (1.0 - bos_attention) / len(non_bos_attention)

            # Vectorized operations on non-BOS tokens
            above_threshold = non_bos_attention > threshold
            ratios = (non_bos_attention / threshold).astype(int)

            # Apply updates (still need loop for dict access, but comparison/math is vectorized)
            for i, pos in enumerate(positions_array):
                if i >= len(non_bos_attention):
                    break

                if above_threshold[i]:
                    increment = ratios[i]
                    scores[pos] += increment
                    total_increments.append(increment)
                else:
                    scores[pos] -= 1

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
            print(f"\nIncrement statistics (when attention > threshold):")
            print(f"  Min: {min(total_increments)}, Max: {max(total_increments)}")
            print(f"  Mean: {np.mean(total_increments):.2f}, Median: {np.median(total_increments):.2f}")

        return scores


def main():
    """Standalone execution"""
    if len(sys.argv) < 2:
        print("Usage: python3 magnitude_voting_strategy_v2.py <capture_dir> [export_file]")
        sys.exit(1)

    capture_dir = Path(sys.argv[1])
    export_file = Path(sys.argv[2]) if len(sys.argv) > 2 else None

    # Run strategy
    strategy = MagnitudeVotingStrategyV2(capture_dir, export_file=export_file)
    sentences, metadata = strategy.run()

    # Export results
    output_dir = Path('test_results') / capture_dir.name
    output_dir.mkdir(parents=True, exist_ok=True)

    strategy.export_markdown(sentences, metadata, output_dir / 'magnitude_voting_strategy_v2.md')
    strategy.export_json(sentences, metadata, output_dir / 'magnitude_voting_strategy_v2.json')

    print(f"\n{'='*80}")
    print(f"Results written to: {output_dir}")
    print(f"{'='*80}")


if __name__ == '__main__':
    main()
