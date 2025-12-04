#!/usr/bin/env python3
"""
Run Comparison - Execute all strategies on same capture data

Generates side-by-side comparison reports showing how different strategies
rank sentences differently.
"""

import sys
from pathlib import Path
from typing import List, Dict
import json

from voting_strategy import VotingStrategy
from cumulative_strategy import CumulativeStrategy
from symmetric_voting_strategy import SymmetricVotingStrategy
from magnitude_voting_strategy import MagnitudeVotingStrategy
from base_strategy import ScoredSentence


def format_sentence_preview(sentence: ScoredSentence, max_len: int = 60) -> str:
    """Format sentence for table display"""
    text = sentence.text.replace('\n', ' ').strip()
    if len(text) > max_len:
        text = text[:max_len-3] + '...'
    return text


def generate_comparison_report(strategies_results: Dict[str, tuple], output_file: Path):
    """
    Generate side-by-side comparison report.

    Args:
        strategies_results: {strategy_name: (sentences, metadata)} mapping
        output_file: Output markdown file
    """
    with open(output_file, 'w') as f:
        f.write("# Strategy Comparison Report\n\n")

        # Header with all strategy names
        strategy_names = list(strategies_results.keys())
        f.write(f"**Strategies compared:** {', '.join(strategy_names)}\n\n")

        # Capture info (from first strategy)
        first_metadata = list(strategies_results.values())[0][1]
        f.write(f"**Capture:** `{Path(first_metadata['capture_dir']).name}`\n\n")

        # Parameters for each strategy
        f.write("## Strategy Parameters\n\n")
        for name, (sentences, metadata) in strategies_results.items():
            f.write(f"**{name}:**\n")
            for key, val in metadata['parameters'].items():
                f.write(f"- `{key}`: {val}\n")
            f.write("\n")

        # Statistics comparison
        f.write("## Score Statistics\n\n")
        f.write(f"| Strategy | Min | Max | Mean | Median |\n")
        f.write(f"|----------|-----|-----|------|--------|\n")
        for name, (sentences, metadata) in strategies_results.items():
            stats = metadata['score_stats']
            f.write(f"| {name} | {stats['min']:.2f} | {stats['max']:.2f} | {stats['mean']:.2f} | {stats['median']:.2f} |\n")

        # Top 20 ranking comparison
        f.write(f"\n## Top 20 Sentence Rankings\n\n")

        # Build rank table
        max_rank = 20
        f.write("| Rank | " + " | ".join(strategy_names) + " |\n")
        f.write("|------|" + "|".join(["---" for _ in strategy_names]) + "|\n")

        for rank in range(1, max_rank + 1):
            row = [f"{rank}"]
            for name in strategy_names:
                sentences, _ = strategies_results[name]
                if rank - 1 < len(sentences):
                    s = sentences[rank - 1]
                    cell = f"T{s.turn_id}:S{s.sentence_id} ({s.score:.1f})"
                else:
                    cell = "-"
                row.append(cell)
            f.write("| " + " | ".join(row) + " |\n")

        # Detailed sentence rankings for each strategy
        f.write(f"\n{'='*80}\n")
        f.write(f"## Detailed Rankings by Strategy\n")
        f.write(f"{'='*80}\n\n")

        for name, (sentences, metadata) in strategies_results.items():
            f.write(f"### {name}\n\n")

            # Show top 30
            for i, sentence in enumerate(sentences[:30], 1):
                f.write(f"**Rank {i} - Turn {sentence.turn_id}, Sentence {sentence.sentence_id}** ")
                f.write(f"(Score: {sentence.score:.2f}, {sentence.token_count} tokens)\n")
                f.write(f"```\n{sentence.text}\n```\n\n")

        # Agreement analysis
        f.write(f"\n{'='*80}\n")
        f.write(f"## Agreement Analysis\n")
        f.write(f"{'='*80}\n\n")

        # Find sentences that all strategies agree are top 10
        if len(strategies_results) > 1:
            top_10_sets = []
            for name, (sentences, _) in strategies_results.items():
                top_10 = set((s.turn_id, s.sentence_id) for s in sentences[:10])
                top_10_sets.append((name, top_10))

            # Find intersection
            common = top_10_sets[0][1]
            for _, s in top_10_sets[1:]:
                common &= s

            f.write(f"**Sentences in ALL strategies' top 10:**\n\n")
            if common:
                for turn_id, sentence_id in sorted(common):
                    # Get text from first strategy
                    for s in strategies_results[strategy_names[0]][0]:
                        if s.turn_id == turn_id and s.sentence_id == sentence_id:
                            f.write(f"- Turn {turn_id}, Sentence {sentence_id}: `{format_sentence_preview(s)}`\n")
            else:
                f.write("None - strategies disagree significantly!\n")

            f.write("\n")

        # Disagreement analysis - sentences in one strategy's top 10 but not others
        if len(strategies_results) > 1:
            f.write(f"**Unique to each strategy's top 10:**\n\n")
            for i, (name, top_10) in enumerate(top_10_sets):
                unique = top_10.copy()
                for j, (other_name, other_top_10) in enumerate(top_10_sets):
                    if i != j:
                        unique -= other_top_10

                f.write(f"**{name} only:**\n")
                if unique:
                    for turn_id, sentence_id in sorted(unique):
                        # Get text
                        for s in strategies_results[name][0]:
                            if s.turn_id == turn_id and s.sentence_id == sentence_id:
                                f.write(f"- Turn {turn_id}, Sentence {sentence_id}: `{format_sentence_preview(s)}`\n")
                else:
                    f.write("None\n")
                f.write("\n")

    print(f"\nComparison report written to: {output_file}")


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 run_comparison.py <capture_dir> [export_file]")
        print("\nRuns all strategies on the same capture and generates comparison report.")
        print("\nOptional: Provide export_file (halo_weave_*.json) for full token metadata.")
        print("If not provided, only analyzes prompt tokens from metadata.json.")
        sys.exit(1)

    capture_dir = Path(sys.argv[1])
    export_file = Path(sys.argv[2]) if len(sys.argv) > 2 else None

    if not capture_dir.exists():
        print(f"Error: Capture directory does not exist: {capture_dir}")
        sys.exit(1)

    if export_file and not export_file.exists():
        print(f"Error: Export file does not exist: {export_file}")
        sys.exit(1)

    # Create output directory
    output_dir = Path('test_results') / capture_dir.name
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n{'='*80}")
    print(f"STRATEGY COMPARISON")
    print(f"Capture: {capture_dir.name}")
    print(f"Output: {output_dir}")
    print(f"{'='*80}\n")

    # Run all strategies
    strategies_results = {}

    # Strategy 1: Voting
    print("\n" + "="*80)
    strategy = VotingStrategy(capture_dir, export_file=export_file, min_distance=50)
    sentences, metadata = strategy.run()
    strategy.export_markdown(sentences, metadata, output_dir / 'voting_strategy.md')
    strategy.export_json(sentences, metadata, output_dir / 'voting_strategy.json')
    strategies_results['Voting'] = (sentences, metadata)

    # Strategy 2: Cumulative
    print("\n" + "="*80)
    strategy = CumulativeStrategy(capture_dir, export_file=export_file, decay_rate=0.001, min_distance=20)
    sentences, metadata = strategy.run()
    strategy.export_markdown(sentences, metadata, output_dir / 'cumulative_strategy.md')
    strategy.export_json(sentences, metadata, output_dir / 'cumulative_strategy.json')
    strategies_results['Cumulative'] = (sentences, metadata)

    # Strategy 3: Symmetric Voting (±1)
    print("\n" + "="*80)
    strategy = SymmetricVotingStrategy(capture_dir, export_file=export_file)
    sentences, metadata = strategy.run()
    strategy.export_markdown(sentences, metadata, output_dir / 'symmetric_voting_strategy.md')
    strategy.export_json(sentences, metadata, output_dir / 'symmetric_voting_strategy.json')
    strategies_results['Symmetric Voting'] = (sentences, metadata)

    # Strategy 4: Magnitude-Weighted Voting
    print("\n" + "="*80)
    strategy = MagnitudeVotingStrategy(capture_dir, export_file=export_file)
    sentences, metadata = strategy.run()
    strategy.export_markdown(sentences, metadata, output_dir / 'magnitude_voting_strategy.md')
    strategy.export_json(sentences, metadata, output_dir / 'magnitude_voting_strategy.json')
    strategies_results['Magnitude Voting'] = (sentences, metadata)

    # Generate comparison report
    print("\n" + "="*80)
    print("Generating comparison report...")
    generate_comparison_report(strategies_results, output_dir / 'comparison_report.md')

    print(f"\n{'='*80}")
    print(f"COMPLETE")
    print(f"{'='*80}")
    print(f"\nAll results written to: {output_dir}/")
    print(f"\nFiles generated:")
    print(f"  - voting_strategy.md (human-readable)")
    print(f"  - voting_strategy.json (machine-readable)")
    print(f"  - cumulative_strategy.md (human-readable)")
    print(f"  - cumulative_strategy.json (machine-readable)")
    print(f"  - symmetric_voting_strategy.md (human-readable)")
    print(f"  - symmetric_voting_strategy.json (machine-readable)")
    print(f"  - magnitude_voting_strategy.md (human-readable)")
    print(f"  - magnitude_voting_strategy.json (machine-readable)")
    print(f"  - comparison_report.md (side-by-side analysis)")


if __name__ == '__main__':
    main()
