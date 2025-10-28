from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional


@dataclass
class DatasetJob:
    job_id: str
    dataset_name: str
    workflow_id: str
    server_url: Optional[str] = None
    status: str = "queued"
    total: int = 0
    completed: int = 0
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    error: Optional[str] = None
    result: Optional[Dict[str, object]] = None
    logs: List[str] = field(default_factory=list)


class DatasetJobManager:
    def __init__(self) -> None:
        self._jobs: Dict[str, DatasetJob] = {}
        self._lock = threading.Lock()

    def create_job(self, dataset_name: str, workflow_id: str, *, server_url: Optional[str] = None) -> DatasetJob:
        job = DatasetJob(job_id=uuid.uuid4().hex[:12], dataset_name=dataset_name, workflow_id=workflow_id, server_url=server_url)
        with self._lock:
            self._jobs[job.job_id] = job
        return job

    def list_jobs(self) -> List[DatasetJob]:
        with self._lock:
            return sorted(self._jobs.values(), key=lambda job: job.started_at or 0, reverse=True)

    def get(self, job_id: str) -> Optional[DatasetJob]:
        with self._lock:
            return self._jobs.get(job_id)

    def mark_running(self, job_id: str, total: int) -> None:
        with self._lock:
            job = self._require(job_id)
            job.status = "running"
            job.total = total
            job.started_at = time.time()
            job.logs.append(f"开始执行，预计 {total} 次运行")

    def update_progress(self, job_id: str, completed: int, message: Optional[str] = None) -> None:
        with self._lock:
            job = self._require(job_id)
            job.completed = completed
            if message:
                job.logs.append(message)

    def mark_finished(self, job_id: str, result: Dict[str, object]) -> None:
        with self._lock:
            job = self._require(job_id)
            job.status = "finished"
            job.completed = job.total
            job.finished_at = time.time()
            job.result = result
            job.logs.append("数据集任务完成")

    def mark_failed(self, job_id: str, error: str) -> None:
        with self._lock:
            job = self._require(job_id)
            job.status = "failed"
            job.error = error
            job.finished_at = time.time()
            job.logs.append(f"任务失败: {error}")

    def append_log(self, job_id: str, message: str) -> None:
        with self._lock:
            job = self._require(job_id)
            job.logs.append(message)

    def _require(self, job_id: str) -> DatasetJob:
        job = self._jobs.get(job_id)
        if job is None:
            raise KeyError(f"dataset job {job_id} not found")
        return job
