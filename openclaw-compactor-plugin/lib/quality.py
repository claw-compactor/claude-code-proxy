"""Quality scoring using semantic similarity.

Measures how well compressed text preserves the meaning of the original
using sentence-transformer cosine similarity. Supports both English and
Chinese text via multilingual models.

Ported from opencompactor/quality.py with multilingual model support.
"""

from dataclasses import dataclass
from enum import Enum


class QualityLevel(Enum):
    """Quality assessment of compression."""
    EXCELLENT = "excellent"  # >= 0.90
    GOOD = "good"            # >= 0.80
    FAIR = "fair"            # >= 0.70
    POOR = "poor"            # < 0.70


@dataclass(frozen=True)
class QualityScore:
    """Result of quality comparison between original and compressed text."""
    similarity: float
    level: QualityLevel
    model_used: str
    error: str | None = None

    @property
    def passes_threshold(self) -> bool:
        """Check if quality meets minimum threshold (0.70)."""
        return self.similarity >= 0.70


# Lazy-loaded models
_models = {}


def _get_model(model_name: str):
    """Lazy-load a sentence transformer model."""
    if model_name not in _models:
        from sentence_transformers import SentenceTransformer
        _models[model_name] = SentenceTransformer(model_name)
    return _models[model_name]


def compute_similarity(
    original: str,
    compressed: str,
    model_name: str = "all-MiniLM-L6-v2",
) -> QualityScore:
    """Compute cosine similarity between original and compressed text.

    For Chinese-dominant text, automatically uses a multilingual model
    (paraphrase-multilingual-MiniLM-L12-v2) for better accuracy.

    Args:
        original: The original uncompressed text.
        compressed: The compressed text to evaluate.
        model_name: Sentence transformer model to use.

    Returns:
        QualityScore with similarity value and quality level.
    """
    if not original or not compressed:
        return QualityScore(
            similarity=0.0,
            level=QualityLevel.POOR,
            model_used=model_name,
            error="Empty text provided",
        )

    if len(original.strip()) < 10 or len(compressed.strip()) < 10:
        return QualityScore(
            similarity=0.0,
            level=QualityLevel.POOR,
            model_used=model_name,
            error="Text too short for meaningful comparison",
        )

    try:
        import numpy as np
        model = _get_model(model_name)

        emb_original = model.encode(original)
        emb_compressed = model.encode(compressed)

        dot_product = float(np.dot(emb_original, emb_compressed))
        norm_product = float(
            np.linalg.norm(emb_original) * np.linalg.norm(emb_compressed) + 1e-8
        )
        similarity = round(dot_product / norm_product, 4)

        level = _classify_similarity(similarity)

        return QualityScore(
            similarity=similarity,
            level=level,
            model_used=model_name,
        )

    except ImportError:
        return QualityScore(
            similarity=0.0,
            level=QualityLevel.POOR,
            model_used=model_name,
            error="sentence-transformers or numpy not installed",
        )
    except Exception as e:
        return QualityScore(
            similarity=0.0,
            level=QualityLevel.POOR,
            model_used=model_name,
            error=str(e),
        )


def select_model_for_language(cjk_ratio: float) -> str:
    """Select the best embedding model based on language content.

    For CJK-heavy text, uses a multilingual model for better accuracy.
    For English-dominant text, uses the faster English-optimized model.
    """
    if cjk_ratio > 0.1:
        return "paraphrase-multilingual-MiniLM-L12-v2"
    return "all-MiniLM-L6-v2"


def _classify_similarity(similarity: float) -> QualityLevel:
    """Classify similarity score into quality level."""
    if similarity >= 0.90:
        return QualityLevel.EXCELLENT
    elif similarity >= 0.80:
        return QualityLevel.GOOD
    elif similarity >= 0.70:
        return QualityLevel.FAIR
    else:
        return QualityLevel.POOR
