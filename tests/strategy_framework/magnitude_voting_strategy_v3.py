#!/usr/bin/env python3
"""
Magnitude-Weighted Voting Strategy v3 - FULLY VECTORIZED

Optimizations:
1. O(1) mean calculation - Softmax sums to 1, so mean = 1/n
2. BOS exclusion - Skip position 0 from threshold and scoring
3. FULL NumPy vectorization - NO PYTHON LOOPS during computation

Uses numpy array for scores instead of dict during computation.
Only converts back to dict at the end for compatibility with base class.

For each generation step:
1. Aggregate attention across layers/heads
2. Calculate threshold excluding BOS: (1.0 - bos_attention) / (n - 1)
3. FULLY vectorized update (single numpy operation):
   scores_array[1:] += np.where(above_threshold, ratios, -1)

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


class MagnitudeVotingStrategyV3(BrightnessStrategy):
    """Magnitude-weighted voting v3 - fully vectorized, NO Python loops"""

    def __init__(self, capture_dir: Path, **kwargs):
        """
        Args:
            capture_dir: Path to capture directory
        """
        super().__init__(capture_dir, **kwargs)

    def get_strategy_name(self) -> str:
        return "Magnitude-Weighted Voting v3 (Fully Vectorized)"

    def compute_scores(self) -> dict:
        """
        Compute brightness score with magnitude-weighted voting.
        FULLY vectorized with NumPy arrays - NO Python loops!

        Returns:
            {position: score} mapping
        """
        start_time = time.time()

        # Use numpy array for scores, indexed by position
        # Initialize all to 255, BOS to 0 (excluded from scoring)
        max_position = max(t['position'] for t in self.all_tokens)
        scores_array = np.full(max_position + 1, 255, dtype=np.int32)
        scores_array[0] = 0  # BOS excluded

        token_files = self._load_token_files()

        print(f"Analyzing {len(token_files)} generation steps...")
        print(f"Total context: {len(self.all_tokens)} tokens ({len(self.all_tokens) - 1} non-BOS)")
        print(f"Initial score: 255 (all non-BOS tokens)")
        print(f"BOS token (position 0) excluded from scoring\n")

        skipped = 0
        # Track increment stats with running aggregates (no list allocation)
        increment_sum = 0
        increment_count = 0
        increment_min = float('inf')
        increment_max = 0

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

            # O(1) threshold calculation excluding BOS
            bos_attention = aggregated[0]
            # Context length varies per generation step, clip to actual array size
            context_len = min(len(aggregated), len(scores_array))
            non_bos_attention = aggregated[1:context_len]
            threshold = (1.0 - bos_attention) / len(non_bos_attention)

            # Vectorized operations on non-BOS tokens
            above_threshold = non_bos_attention > threshold
            ratios = (non_bos_attention / threshold).astype(np.int32)

            # Track increment stats (no memory allocation)
            if above_threshold.any():
                increment_sum += ratios[above_threshold].sum()
                increment_count += above_threshold.sum()
                increment_min = min(increment_min, ratios[above_threshold].min())
                increment_max = max(increment_max, ratios[above_threshold].max())

            # FULLY VECTORIZED UPDATE - NO PYTHON LOOP!
            # Apply +ratio where above threshold, -1 elsewhere
            updates = np.where(above_threshold, ratios, -1)
            # Only update positions that exist in this generation step's context
            scores_array[1:context_len] += updates

            # Progress indicator
            if (idx + 1) % 50 == 0:
                print(f"  Processed {idx + 1}/{len(token_files)} steps...")

        if skipped > 0:
            print(f"  Skipped {skipped} malformed files")

        elapsed = time.time() - start_time
        print(f"\n⏱️  Total time: {elapsed:.2f}s ({elapsed/len(token_files)*1000:.2f}ms per token)")

        # Convert array back to dict for compatibility with base class
        scores = {}
        for token in self.all_tokens:
            if token['position'] > 0:  # Skip BOS
                scores[token['position']] = int(scores_array[token['position']])

        print(f"Completed: {len(scores)} tokens scored")

        # Print score distribution
        score_values = list(scores.values())
        print(f"Score distribution:")
        print(f"  Min: {min(score_values)}, Max: {max(score_values)}")
        print(f"  Mean: {np.mean(score_values):.2f}, Median: {np.median(score_values):.2f}")

        # Print increment statistics
        if increment_count > 0:
            print(f"\nIncrement statistics (when attention > threshold):")
            print(f"  Min: {increment_min}, Max: {increment_max}")
            print(f"  Mean: {increment_sum/increment_count:.2f}, Count: {increment_count}")

        return scores


def main():
    """Standalone execution"""
    if len(sys.argv) < 2:
        print("Usage: python3 magnitude_voting_strategy_v3.py <capture_dir> [export_file]")
        sys.exit(1)

    capture_dir = Path(sys.argv[1])
    export_file = Path(sys.argv[2]) if len(sys.argv) > 2 else None

    # Run strategy
    strategy = MagnitudeVotingStrategyV3(capture_dir, export_file=export_file)
    sentences, metadata = strategy.run()

    # Export results
    output_dir = Path('test_results') / capture_dir.name
    output_dir.mkdir(parents=True, exist_ok=True)

    strategy.export_markdown(sentences, metadata, output_dir / 'magnitude_voting_strategy_v3.md')
    strategy.export_json(sentences, metadata, output_dir / 'magnitude_voting_strategy_v3.json')

    print(f"\n{'='*80}")
    print(f"Results written to: {output_dir}")
    print(f"{'='*80}")


if __name__ == '__main__':
    main()
