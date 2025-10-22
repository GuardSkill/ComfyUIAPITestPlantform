from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional


@dataclass
class BatchJob:
    identifier: str
    group_id: str
    workflow_ids: List[str]
    placeholders: Dict[str, str]
    server_url: str
    output_dir: Optional[str]
    uploaded_names: Dict[str, str] = field(default_factory=dict)
    artifacts: List["JobArtifact"] = field(default_factory=list)
    status: str = "queued"
    created_at: float = field(default_factory=lambda: time.time())
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    results: List[Dict[str, object]] = field(default_factory=list)
    error: Optional[str] = None
    logs: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, object]:
        return {
            "id": self.identifier,
            "group_id": self.group_id,
            "workflow_ids": self.workflow_ids,
            "placeholders": self.placeholders,
            "uploaded_names": self.uploaded_names,
            "server_url": self.server_url,
            "output_dir": self.output_dir,
            "status": self.status,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "results": self.results,
            "error": self.error,
            "logs": self.logs,
            "artifacts": [artifact.to_dict(self.identifier) for artifact in self.artifacts],
        }


@dataclass
class JobArtifact:
    artifact_id: str
    workflow_name: str
    path: str
    media_type: str
    filename: str

    def to_dict(self, job_id: str) -> Dict[str, object]:
        return {
            "id": self.artifact_id,
            "workflow_name": self.workflow_name,
            "media_type": self.media_type,
            "filename": self.filename,
            "url": f"/api/jobs/{job_id}/artifacts/{self.artifact_id}",
        }


class JobManager:
    def __init__(self):
        self._jobs: Dict[str, BatchJob] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ lookup
    def list_jobs(self) -> List[BatchJob]:
        with self._lock:
            return sorted(self._jobs.values(), key=lambda job: job.created_at, reverse=True)

    def get(self, identifier: str) -> Optional[BatchJob]:
        with self._lock:
            return self._jobs.get(identifier)

    # ---------------------------------------------------------------- creation
    def create_job(
        self,
        *,
        group_id: str,
        workflow_ids: List[str],
        placeholders: Dict[str, str],
        uploaded_names: Optional[Dict[str, str]],
        server_url: str,
        output_dir: Optional[str],
    ) -> BatchJob:
        identifier = uuid.uuid4().hex[:12]
        job = BatchJob(
            identifier=identifier,
            group_id=group_id,
            workflow_ids=list(workflow_ids),
            placeholders=dict(placeholders),
            uploaded_names=dict(uploaded_names or {}),
            server_url=server_url,
            output_dir=output_dir,
        )
        with self._lock:
            self._jobs[identifier] = job
        return job

    # ----------------------------------------------------------------- updates
    def mark_running(self, identifier: str) -> None:
        with self._lock:
            job = self._require(identifier)
            job.status = "running"
            job.started_at = time.time()

    def append_log(self, identifier: str, message: str) -> None:
        with self._lock:
            job = self._require(identifier)
            job.logs.append(message)

    def mark_finished(self, identifier: str, results: List[Dict[str, object]]) -> None:
        with self._lock:
            job = self._require(identifier)
            job.status = "finished"
            job.finished_at = time.time()
            job.results = results
            job.artifacts = self._build_artifacts(job, results)

    def mark_failed(self, identifier: str, error: str) -> None:
        with self._lock:
            job = self._require(identifier)
            job.status = "failed"
            job.finished_at = time.time()
            job.error = error
            job.artifacts = []

    def _require(self, identifier: str) -> BatchJob:
        job = self._jobs.get(identifier)
        if job is None:
            raise KeyError(f"job {identifier} not found")
        return job

    def _build_artifacts(self, job: BatchJob, results: List[Dict[str, object]]) -> List[JobArtifact]:
        artifacts: List[JobArtifact] = []
        counter = 0
        for result in results or []:
            workflow_name = result.get("name") or "未命名工作流"
            for saved in result.get("saved_files") or []:
                path = Path(saved)
                media_type = self._guess_media_type(path)
                artifact_id = f"{job.identifier}-{counter}"
                counter += 1
                artifacts.append(
                    JobArtifact(
                        artifact_id=artifact_id,
                        workflow_name=workflow_name,
                        path=str(path),
                        media_type=media_type,
                        filename=path.name,
                    )
                )
        return artifacts

    @staticmethod
    def _guess_media_type(path: Path) -> str:
        suffix = path.suffix.lower()
        if suffix in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}:
            return "image"
        if suffix in {".mp4", ".mov", ".avi", ".mkv", ".webm"}:
            return "video"
        if suffix in {".mp3", ".wav", ".flac", ".aac", ".ogg"}:
            return "audio"
        return "file"
