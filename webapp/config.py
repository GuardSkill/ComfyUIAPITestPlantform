from __future__ import annotations

from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent.parent
WORKFLOW_ROOT = BASE_DIR / "workflow"
MEDIA_ROOT = BASE_DIR / "media"
DEFAULT_SERVER_URL = "http://127.0.0.1:8189"
DEFAULT_OUTPUT_ROOT = BASE_DIR / "workflow_test_output"
DATASET_ROOT = BASE_DIR / "datasets"


def ensure_media_root() -> None:
    MEDIA_ROOT.mkdir(parents=True, exist_ok=True)


def ensure_dataset_root() -> None:
    DATASET_ROOT.mkdir(parents=True, exist_ok=True)
