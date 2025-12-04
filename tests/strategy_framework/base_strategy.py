#!/usr/bin/env python3
"""
Base Strategy - Abstract interface for brightness scoring strategies

All brightness strategies must implement this interface to be comparable.
"""

from abc import ABC, abstractmethod
from pathlib import Path
import json
import numpy as np
from typing import Dict, List, Tuple
from collections import defaultdict


class ScoredSentence:
    """Container for a sentence with its score"""
    def __init__(self, turn_id, sentence_id, role, tokens, score):
        self.turn_id = turn_id
        self.sentence_id = sentence_id
        self.role = role
        self.tokens = tokens  # List of token dicts
        self.score = score
        self.token_count = len(tokens)
        self.text = ''.join(t['text'] for t in tokens)

    def to_dict(self):
        """Convert to JSON-serializable dict"""
        return {
            'turn_id': self.turn_id,
            'sentence_id': self.sentence_id,
            'role': self.role,
            'score': float(self.score),
            'token_count': self.token_count,
            'text': self.text,
            'tokens': self.tokens
        }


class BrightnessStrategy(ABC):
    """Abstract base class for brightness scoring strategies"""

    def __init__(self, capture_dir: Path, export_file: Path = None, **kwargs):
        self.capture_dir = Path(capture_dir)
        self.export_file = Path(export_file) if export_file else None
        self.parameters = kwargs
        self.metadata = self._load_metadata()

        # Load all tokens from export file if provided, otherwise use prompt_tokens
        if self.export_file and self.export_file.exists():
            self.all_tokens = self._load_tokens_from_export()
            print(f"Loaded {len(self.all_tokens)} tokens from export: {self.export_file.name}")
        else:
            self.all_tokens = self.metadata.get('prompt_tokens', [])
            print(f"Loaded {len(self.all_tokens)} prompt tokens from metadata")

        # Keep prompt_tokens for backward compatibility
        self.prompt_tokens = self.all_tokens

    def _load_metadata(self) -> dict:
        """Load metadata.json from capture directory"""
        metadata_file = self.capture_dir / 'metadata.json'
        with open(metadata_file, 'r') as f:
            return json.load(f)

    def _load_tokens_from_export(self) -> List[dict]:
        """
        Load all tokens from halo_weave export JSON file.

        Returns:
            List of token dicts with position, text, turn_id, sentence_id, etc.
        """
        with open(self.export_file, 'r') as f:
            export_data = json.load(f)

        # Filter out deleted tokens
        active_tokens = [
            {
                'position': token['position'],
                'text': token['text'],
                'turn_id': token['turn_id'],
                'sentence_id': token['sentence_id'],
                'message_role': token['message_role']
            }
            for token in export_data['tokens']
            if not token.get('deleted', False)
        ]

        return active_tokens

    def _load_token_files(self) -> List[Path]:
        """Get sorted list of token JSON files"""
        return sorted(self.capture_dir.glob('token_*.json'))

    def _aggregate_attention(self, attention_data: List[float], shape: Tuple[int, int, int]) -> np.ndarray:
        """
        Aggregate attention tensor across layers and heads.

        Args:
            attention_data: Flattened attention values
            shape: (n_layers, n_heads, context_length)

        Returns:
            aggregated: (context_length,) array of mean attention per token
        """
        n_layers, n_heads, context_len = shape
        tensor = np.array(attention_data).reshape(shape)

        # Mean across layers and heads
        aggregated = np.mean(tensor, axis=(0, 1))

        return aggregated

    def _group_tokens_by_sentence(self, scored_tokens: Dict[int, float]) -> List[ScoredSentence]:
        """
        Group tokens into sentences and aggregate scores.

        Args:
            scored_tokens: {position: score} mapping

        Returns:
            List of ScoredSentence objects sorted by score (descending)
        """
        # Group tokens by (turn_id, sentence_id, role)
        sentences = defaultdict(list)

        for token in self.prompt_tokens:
            pos = token['position']
            if pos in scored_tokens:
                key = (token['turn_id'], token['sentence_id'], token['message_role'])
                sentences[key].append({
                    'position': pos,
                    'text': token['text'],
                    'score': scored_tokens[pos],
                    'turn_id': token['turn_id'],
                    'sentence_id': token['sentence_id'],
                    'role': token['message_role']
                })

        # Create ScoredSentence objects with peak score per sentence
        result = []
        for (turn_id, sentence_id, role), tokens in sentences.items():
            peak_score = max(t['score'] for t in tokens)
            result.append(ScoredSentence(turn_id, sentence_id, role, tokens, peak_score))

        # Sort by score descending
        result.sort(key=lambda s: s.score, reverse=True)

        return result

    @abstractmethod
    def compute_scores(self) -> Dict[int, float]:
        """
        Compute brightness score for each token position.

        Returns:
            {position: score} mapping
        """
        pass

    @abstractmethod
    def get_strategy_name(self) -> str:
        """Return human-readable strategy name"""
        pass

    def run(self) -> Tuple[List[ScoredSentence], dict]:
        """
        Execute strategy and return ranked sentences + metadata.

        Returns:
            (sentences, metadata) tuple
        """
        print(f"\n{'='*80}")
        print(f"Running: {self.get_strategy_name()}")
        print(f"Capture: {self.capture_dir.name}")
        print(f"Parameters: {self.parameters}")
        print(f"{'='*80}\n")

        # Compute token scores
        scored_tokens = self.compute_scores()

        # Group into sentences
        sentences = self._group_tokens_by_sentence(scored_tokens)

        # Build metadata
        metadata = {
            'strategy': self.get_strategy_name(),
            'parameters': self.parameters,
            'capture_dir': str(self.capture_dir),
            'total_sentences': len(sentences),
            'total_tokens': len(scored_tokens),
            'score_stats': {
                'min': float(min(scored_tokens.values())),
                'max': float(max(scored_tokens.values())),
                'mean': float(np.mean(list(scored_tokens.values()))),
                'median': float(np.median(list(scored_tokens.values())))
            }
        }

        return sentences, metadata

    def export_markdown(self, sentences: List[ScoredSentence], metadata: dict, output_file: Path):
        """Export human-readable markdown report"""
        with open(output_file, 'w') as f:
            f.write(f"# {metadata['strategy']} - Results\n\n")
            f.write(f"**Capture:** `{self.capture_dir.name}`\n\n")
            f.write(f"**Parameters:**\n")
            for key, val in metadata['parameters'].items():
                f.write(f"- `{key}`: {val}\n")

            f.write(f"\n**Statistics:**\n")
            f.write(f"- Total sentences: {metadata['total_sentences']}\n")
            f.write(f"- Total tokens: {metadata['total_tokens']}\n")
            f.write(f"- Score range: {metadata['score_stats']['min']:.2f} to {metadata['score_stats']['max']:.2f}\n")
            f.write(f"- Mean score: {metadata['score_stats']['mean']:.2f}\n")
            f.write(f"- Median score: {metadata['score_stats']['median']:.2f}\n")

            f.write(f"\n{'='*80}\n")
            f.write(f"## Sentence Rankings (Highest to Lowest)\n")
            f.write(f"{'='*80}\n\n")

            for i, sentence in enumerate(sentences, 1):
                f.write(f"**Rank {i} - Turn {sentence.turn_id}, Sentence {sentence.sentence_id}** ")
                f.write(f"(Score: {sentence.score:.2f}, {sentence.token_count} tokens, {sentence.role})\n")
                f.write(f"```\n{sentence.text}\n```\n\n")

        print(f"Exported markdown: {output_file}")

    def export_json(self, sentences: List[ScoredSentence], metadata: dict, output_file: Path):
        """Export machine-readable JSON data"""
        data = {
            'metadata': metadata,
            'sentences': [s.to_dict() for s in sentences]
        }

        with open(output_file, 'w') as f:
            json.dump(data, f, indent=2)

        print(f"Exported JSON: {output_file}")
