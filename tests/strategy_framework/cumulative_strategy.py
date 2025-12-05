#!/usr/bin/env python3
"""
Cumulative Strategy - Accumulate raw attention with decay

For each generation step:
1. Aggregate attention across layers/heads
2. Apply distance weighting (optional)
3. Update: score_new = score_old + weighted_attention - decay
4. Raw logits (no clamping)

Tokens with highest cumulative scores = Important tokens
"""

import json
import numpy as np
from pathlib import Path
from collections import defaultdict
import sys

from base_strategy import BrightnessStrategy


class CumulativeStrategy(BrightnessStrategy):
    """Cumulative brightness with decay"""

    def __init__(self,
                 capture_dir: Path,
                 decay_rate: float = 0.001,
                 decay_mode: str = 'additive',
                 distance_mode: str = 'logarithmic',
                 min_distance: int = 20,
                 distance_scale: float = 10.0,
                 **kwargs):
        """
        Args:
            capture_dir: Path to capture directory
            decay_rate: Decay per step
            decay_mode: 'additive', 'exponential', or 'none'
            distance_mode: 'none', 'threshold', 'linear', 'logarithmic', 'square_root'
            min_distance: Minimum distance for distance weighting
            distance_scale: Scale factor for distance weighting
        """
        super().__init__(
            capture_dir,
            decay_rate=decay_rate,
            decay_mode=decay_mode,
            distance_mode=distance_mode,
            min_distance=min_distance,
            distance_scale=distance_scale,
            **kwargs
        )

    def get_strategy_name(self) -> str:
        return "Cumulative Brightness"

    def _apply_distance_weight(self, raw_attention: float, distance: int) -> float:
        """Apply distance-based weighting to filter local attention"""
        if self.parameters['distance_mode'] == 'none':
            return raw_attention

        # Filter out local attention
        if distance < self.parameters['min_distance']:
            return 0.0

        multiplier = 1.0

        if self.parameters['distance_mode'] == 'threshold':
            multiplier = 1.0 if distance >= self.parameters['min_distance'] else 0.0

        elif self.parameters['distance_mode'] == 'linear':
            multiplier = distance / self.parameters['distance_scale']

        elif self.parameters['distance_mode'] == 'logarithmic':
            multiplier = np.log(distance + 1) / np.log(self.parameters['distance_scale'] + 1)

        elif self.parameters['distance_mode'] == 'square_root':
            multiplier = np.sqrt(distance) / np.sqrt(self.parameters['distance_scale'])

        return raw_attention * multiplier

    def _calculate_decay(self, current_score: float, step: int) -> float:
        """Calculate decay amount for this step"""
        if self.parameters['decay_mode'] == 'none':
            return 0.0

        if self.parameters['decay_mode'] == 'additive':
            return self.parameters['decay_rate']

        if self.parameters['decay_mode'] == 'exponential':
            return current_score * self.parameters['decay_rate']

        return 0.0

    def compute_scores(self) -> dict:
        """
        Compute cumulative brightness score for each token.

        Returns:
            {position: cumulative_score} mapping
        """
        # Token scores (start at 0.0 - "fail dark")
        scores = defaultdict(float)

        prompt_length = len(self.prompt_tokens)
        token_files = self._load_token_files()

        print(f"Analyzing {len(token_files)} generation steps...")
        print(f"Total context: {len(self.all_tokens)} tokens")
        print(f"Decay: {self.parameters['decay_mode']} @ {self.parameters['decay_rate']}")
        print(f"Distance: {self.parameters['distance_mode']} (min={self.parameters['min_distance']}, scale={self.parameters['distance_scale']})\n")

        skipped = 0
        for step, filepath in enumerate(token_files):
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

            # Current generation position (context length before adding new token)
            current_position = shape[2]

            # Update scores for each token in context
            for pos_idx, attn_value in enumerate(aggregated):
                # Map attention index to actual token position
                # pos_idx is the index in the attention tensor
                # We need to find the token at that position in all_tokens
                if pos_idx < len(self.all_tokens):
                    actual_position = self.all_tokens[pos_idx]['position']

                    # Calculate distance from generation head
                    distance = current_position - pos_idx

                    # Apply distance weighting
                    weighted_attention = self._apply_distance_weight(attn_value, distance)

                    # Update score with decay
                    old_score = scores[actual_position]
                    decay = self._calculate_decay(old_score, step)
                    new_score = old_score + weighted_attention - decay

                    # NO CLAMPING - raw logits can be negative
                    scores[actual_position] = new_score

            # Progress indicator
            if (step + 1) % 50 == 0:
                print(f"  Processed {step + 1}/{len(token_files)} steps...")

        if skipped > 0:
            print(f"  Skipped {skipped} malformed files")

        print(f"\nCompleted: {len(scores)} tokens scored")

        return dict(scores)


def main():
    """Standalone execution"""
    if len(sys.argv) < 2:
        print("Usage: python3 cumulative_strategy.py <capture_dir> [decay_rate] [min_distance] [export_file]")
        sys.exit(1)

    capture_dir = Path(sys.argv[1])
    decay_rate = float(sys.argv[2]) if len(sys.argv) > 2 else 0.001
    min_distance = int(sys.argv[3]) if len(sys.argv) > 3 else 20
    export_file = Path(sys.argv[4]) if len(sys.argv) > 4 else None

    # Run strategy
    strategy = CumulativeStrategy(
        capture_dir,
        export_file=export_file,
        decay_rate=decay_rate,
        min_distance=min_distance
    )
    sentences, metadata = strategy.run()

    # Export results
    output_dir = Path('test_results') / capture_dir.name
    output_dir.mkdir(parents=True, exist_ok=True)

    strategy.export_markdown(sentences, metadata, output_dir / 'cumulative_strategy.md')
    strategy.export_json(sentences, metadata, output_dir / 'cumulative_strategy.json')

    print(f"\n{'='*80}")
    print(f"Results written to: {output_dir}")
    print(f"{'='*80}")


if __name__ == '__main__':
    main()
