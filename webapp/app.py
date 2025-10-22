from __future__ import annotations

import logging
import mimetypes
import os
from pathlib import Path
from typing import Dict, List, Tuple

import requests
from fastapi import BackgroundTasks, Body, FastAPI, File, Form, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from batch_workflow_tester import (
    IMAGE_EXTENSIONS,
    VIDEO_EXTENSIONS,
    BatchWorkflowTester,
    ComfyAPIClient,
    WorkflowTestCase,
)
from .config import DEFAULT_OUTPUT_ROOT, DEFAULT_SERVER_URL, MEDIA_ROOT, WORKFLOW_ROOT, ensure_media_root
from .jobs import JobManager
from .media_manager import MediaEntry, MediaManager
from .workflow_manager import WorkflowManager
from .workflow_store import PlaceholderInfo, WorkflowGroup, WorkflowInfo, WorkflowStore


LOG = logging.getLogger("webapp")

AUDIO_EXTENSIONS = {".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a"}
UPLOAD_ENDPOINTS = {
    "image": "/upload/image",
    "video": "/upload/video",
    "audio": "/upload/audio",
    "file": "/upload/image",
}


class CreateFolderPayload(BaseModel):
    parent: str = Field("", description="父级目录，相对于媒体根目录")
    name: str = Field(..., description="新建文件夹名称")


class RenamePayload(BaseModel):
    path: str = Field(..., description="目标文件或文件夹的相对路径")
    new_name: str = Field(..., description="新的名称")


class DeletePayload(BaseModel):
    paths: List[str] = Field(..., description="需要删除的工作流文件或文件夹相对路径列表")


class RunBatchPayload(BaseModel):
    group_id: str = Field(..., description="工作流分组标识")
    workflow_ids: List[str] = Field(..., description="要批量执行的工作流id列表")
    placeholders: Dict[str, str] = Field(..., description="占位符到媒体资源相对路径的映射")
    server_url: str = Field(DEFAULT_SERVER_URL, description="ComfyUI服务器地址")
    output_dir: str | None = Field(None, description="输出目录（可选）")


class ServerTestPayload(BaseModel):
    server_url: str = Field(..., description="需要测试的 ComfyUI 服务器地址")


def create_app() -> FastAPI:
    ensure_media_root()
    app = FastAPI(title="ComfyUI批量测试平台", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    static_dir = Path(__file__).parent / "static"
    app.mount("/static", StaticFiles(directory=static_dir), name="static")
    app.mount("/media", StaticFiles(directory=MEDIA_ROOT), name="media")

    store = WorkflowStore(WORKFLOW_ROOT)
    media_manager = MediaManager(MEDIA_ROOT)
    job_manager = JobManager()
    workflow_manager = WorkflowManager(WORKFLOW_ROOT)

    app.state.store = store
    app.state.media = media_manager
    app.state.jobs = job_manager
    app.state.workflow_files = workflow_manager

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(static_dir / "index.html")

    # ------------------------------------------------------------- workflow API
    @app.get("/api/workflow-groups")
    async def list_workflow_groups() -> Dict[str, object]:
        store.refresh()
        groups = [serialize_group(group) for group in store.list_groups()]
        return {"groups": groups}

    @app.get("/api/workflows/{workflow_id}")
    async def get_workflow(workflow_id: str) -> Dict[str, object]:
        info = store.get_workflow(workflow_id)
        if info is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到指定的工作流")
        return serialize_workflow(info)

    @app.post("/api/workflows/upload", status_code=status.HTTP_201_CREATED)
    async def upload_workflows(files: List[UploadFile] = File(...)) -> Dict[str, object]:
        if not files:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="未选择文件")
        try:
            payload = []
            for upload in files:
                content = await upload.read()
                payload.append((upload.filename or "", content))
            saved = workflow_manager.save_batch(payload)
        except FileExistsError as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
        finally:
            for upload in files:
                await upload.close()
        store.refresh()
        return saved

    @app.get("/api/workflow-tree")
    async def get_workflow_tree() -> Dict[str, object]:
        store.refresh()
        tree = workflow_manager.list_tree()
        workflow_map: Dict[str, WorkflowInfo] = {info.identifier: info for info in store.list_workflows()}
        group_map: Dict[str, List[Dict[str, object]]] = {}
        for group in store.list_groups():
            for workflow in group.workflows:
                entry = group_map.setdefault(workflow.identifier, [])
                entry.append({"id": group.identifier, "label": group.label})
        enriched = _enrich_tree(tree, workflow_map, group_map)
        return {"tree": enriched}

    @app.post("/api/workflow-tree/rename")
    async def rename_workflow_entry(payload: RenamePayload) -> Dict[str, object]:
        try:
            entry = workflow_manager.rename(payload.path, payload.new_name)
        except FileExistsError as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
        store.refresh()
        return {"entry": entry}

    @app.post("/api/workflow-tree/delete")
    async def delete_workflow_entries(payload: DeletePayload = Body(...)) -> Dict[str, object]:
        if not payload.paths:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="未选择需要删除的路径")
        failures: List[str] = []
        for path in payload.paths:
            try:
                workflow_manager.delete(path)
            except (FileNotFoundError, ValueError, PermissionError) as exc:
                failures.append(f"{path}: {exc}")
        store.refresh()
        if failures:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="; ".join(failures))
        return {"status": "ok"}

    # --------------------------------------------------------------- media API
    @app.get("/api/media")
    async def list_media(path: str = "") -> Dict[str, object]:
        try:
            listing = media_manager.list_directory(path)
        except (FileExistsError, FileNotFoundError, ValueError) as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
        return {
            "path": path,
            "directories": [serialize_media(entry) for entry in listing["directories"]],
            "files": [serialize_media(entry) for entry in listing["files"]],
        }

    @app.post("/api/media/create-folder", status_code=status.HTTP_201_CREATED)
    async def create_folder(payload: CreateFolderPayload) -> Dict[str, object]:
        try:
            entry = media_manager.create_folder(payload.parent, payload.name)
        except FileExistsError as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
        return {"entry": serialize_media(entry)}

    @app.post("/api/media/rename")
    async def rename_media(payload: RenamePayload) -> Dict[str, object]:
        try:
            entry = media_manager.rename(payload.path, payload.new_name)
        except FileExistsError as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
        return {"entry": serialize_media(entry)}

    @app.post("/api/media/upload", status_code=status.HTTP_201_CREATED)
    async def upload_media(parent: str = Form(""), file: UploadFile = File(...)) -> Dict[str, object]:
        data = await file.read()
        try:
            entry = media_manager.save_file(parent, file.filename, data, overwrite=True)
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
        return {"entry": serialize_media(entry)}

    @app.get("/api/media/all")
    async def list_all_media(media_type: str = "") -> Dict[str, object]:
        normalized = media_type.strip().lower()
        if normalized and normalized not in {"image", "video", "audio"}:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="不支持的媒体类型")
        files = media_manager.list_all_files(normalized or None)
        return {"files": [serialize_media(entry) for entry in files]}

    # ----------------------------------------------------------------- job API
    @app.get("/api/jobs")
    async def list_jobs() -> Dict[str, object]:
        jobs = [job.to_dict() for job in job_manager.list_jobs()]
        return {"jobs": jobs}

    @app.get("/api/jobs/{job_id}")
    async def get_job(job_id: str) -> Dict[str, object]:
        job = job_manager.get(job_id)
        if job is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到任务")
        return job.to_dict()

    @app.get("/api/jobs/{job_id}/artifacts/{artifact_id}")
    async def get_job_artifact(job_id: str, artifact_id: str) -> FileResponse:
        job = job_manager.get(job_id)
        if job is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到任务")
        artifact = next((item for item in job.artifacts if item.artifact_id == artifact_id), None)
        if artifact is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到输出文件")
        path = Path(artifact.path)
        if not path.exists():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="输出文件已不存在")
        guessed_type, _ = mimetypes.guess_type(str(path))
        return FileResponse(path, media_type=guessed_type or "application/octet-stream", filename=artifact.filename)

    @app.post("/api/test-server")
    async def test_server(payload: ServerTestPayload) -> Dict[str, object]:
        try:
            ok, message = ping_comfy_server(payload.server_url)
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
        except requests.RequestException as exc:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc

        status_label = "ok" if ok else "error"
        return {"status": status_label, "detail": message}

    @app.post("/api/run-batch", status_code=status.HTTP_202_ACCEPTED)
    async def run_batch(payload: RunBatchPayload = Body(...), background_tasks: BackgroundTasks = BackgroundTasks()) -> Dict[str, object]:
        store.refresh()
        group = store.get_group(payload.group_id)
        if group is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到分组")
        if not payload.workflow_ids:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请选择至少一个工作流")

        available_ids = {workflow.identifier for workflow in group.workflows}
        if invalid := [identifier for identifier in payload.workflow_ids if identifier not in available_ids]:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"以下工作流不属于该分组: {', '.join(invalid)}")

        required_placeholders = {name for name, _ in group.input_signature}
        provided = set(payload.placeholders.keys())
        if required_placeholders != provided:
            missing = required_placeholders - provided
            extra = provided - required_placeholders
            issues: List[str] = []
            if missing:
                issues.append(f"缺少占位符: {', '.join(sorted(missing))}")
            if extra:
                issues.append(f"多余占位符: {', '.join(sorted(extra))}")
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="; ".join(issues))

        uploaded_names: Dict[str, str] = {}
        upload_cache: Dict[Path, str] = {}
        for placeholder, relative in payload.placeholders.items():
            try:
                real_path = media_manager.resolve_path(relative)
            except ValueError as exc:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
            if not real_path.exists() or real_path.is_dir():
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"资源不存在: {relative}")
            cached = upload_cache.get(real_path)
            if cached is None:
                try:
                    cached = upload_media_asset(payload.server_url, real_path)
                except ValueError as exc:
                    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
                except requests.RequestException as exc:
                    raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
                upload_cache[real_path] = cached
            uploaded_names[placeholder] = cached

        output_root = Path(payload.output_dir) if payload.output_dir else DEFAULT_OUTPUT_ROOT
        if not output_root.is_absolute():
            output_root = (Path.cwd() / output_root).resolve()
        output_root.mkdir(parents=True, exist_ok=True)

        job = job_manager.create_job(
            group_id=payload.group_id,
            workflow_ids=payload.workflow_ids,
            placeholders=dict(payload.placeholders),
            server_url=payload.server_url,
            output_dir=str(output_root),
            uploaded_names=uploaded_names,
        )

        background_tasks.add_task(
            execute_job,
            job.identifier,
            payload.workflow_ids,
            uploaded_names,
            payload.server_url,
            output_root,
            store,
            job_manager,
        )
        return {"job_id": job.identifier}

    return app


def execute_job(
    job_id: str,
    workflow_ids: List[str],
    uploaded_names: Dict[str, str],
    server_url: str,
    output_root: Path,
    store: WorkflowStore,
    job_manager: JobManager,
) -> None:
    job_manager.mark_running(job_id)
    job_manager.append_log(job_id, f"开始执行任务，共 {len(workflow_ids)} 个工作流")
    try:
        client = ComfyAPIClient(server_url)
        tester = BatchWorkflowTester(client, output_root=output_root)
        cases: List[WorkflowTestCase] = []
        for identifier in workflow_ids:
            info = store.get_workflow(identifier)
            if info is None:
                raise RuntimeError(f"工作流 {identifier} 不存在或已被删除")
            case_inputs: Dict[str, Dict[str, str]] = {}
            for placeholder in info.placeholders:
                remote_name = uploaded_names.get(placeholder.name)
                if not remote_name:
                    raise RuntimeError(f"占位符 {placeholder.name} 缺少已上传的资源")
                case_inputs[placeholder.name] = {"upload": False, "name": remote_name, "path": remote_name}
            case = WorkflowTestCase(name=info.name, workflow_path=info.path, inputs=case_inputs)
            cases.append(case)
        tester.run_all(cases)
        job_manager.mark_finished(job_id, tester.results)
        job_manager.append_log(job_id, "任务执行完成")
    except Exception as exc:  # pylint: disable=broad-except
        LOG.exception("任务执行失败: %s", exc)
    job_manager.mark_failed(job_id, str(exc))
    job_manager.append_log(job_id, f"任务失败: {exc}")


# ----------------------------------------------------------------- serializers
def _enrich_tree(
    node: Dict[str, object],
    workflow_map: Dict[str, WorkflowInfo],
    group_map: Dict[str, List[Dict[str, object]]],
) -> Dict[str, object]:
    enriched: Dict[str, object] = {
        "name": node.get("name", ""),
        "path": node.get("path", ""),
        "is_dir": node.get("is_dir", False),
    }
    if node.get("is_dir"):
        children = node.get("children", []) or []
        enriched["children"] = [
            _enrich_tree(child, workflow_map, group_map)  # type: ignore[arg-type]
            for child in children
        ]
    else:
        identifier = str(node.get("path", ""))
        info = workflow_map.get(identifier)
        if info:
            enriched["workflow"] = {
                "id": info.identifier,
                "name": info.name,
                "placeholders": [serialize_placeholder(p) for p in info.placeholders],
                "output_types": info.output_types,
                "groups": group_map.get(info.identifier, []),
            }
    return enriched


def serialize_group(group: WorkflowGroup) -> Dict[str, object]:
    return {
        "id": group.identifier,
        "label": group.label,
        "input_signature": [{"name": name, "type": media_type} for name, media_type in group.input_signature],
        "output_signature": list(group.output_signature),
        "workflows": [serialize_workflow(workflow) for workflow in group.workflows],
    }


def serialize_workflow(workflow: WorkflowInfo) -> Dict[str, object]:
    return {
        "id": workflow.identifier,
        "name": workflow.name,
        "path": str(workflow.path),
        "placeholders": [serialize_placeholder(placeholder) for placeholder in workflow.placeholders],
        "output_types": workflow.output_types,
    }


def serialize_placeholder(placeholder: PlaceholderInfo) -> Dict[str, str]:
    return {"name": placeholder.name, "type": placeholder.media_type}


def serialize_media(entry: MediaEntry) -> Dict[str, object]:
    relative_path = entry.path.replace(os.sep, "/")
    return {
        "name": entry.name,
        "path": entry.path,
        "is_dir": entry.is_dir,
        "size": entry.size,
        "mime_type": entry.mime_type,
        "media_type": entry.media_type,
        "url": None if entry.is_dir else f"/media/{relative_path}",
    }


app = create_app()


def normalize_server_url(server_url: str) -> str:
    cleaned = (server_url or "").strip()
    if not cleaned:
        raise ValueError("服务器地址不能为空")
    if not cleaned.startswith(("http://", "https://")):
        cleaned = f"http://{cleaned}"
    return cleaned.rstrip("/")


def ping_comfy_server(server_url: str) -> Tuple[bool, str]:
    base = normalize_server_url(server_url)
    endpoints = ("/system_stats", "/queue/status", "")
    session = requests.Session()
    last_error = ""
    for endpoint in endpoints:
        url = f"{base}{endpoint}"
        try:
            response = session.get(url, timeout=5)
        except requests.RequestException as exc:  # type: ignore[no-untyped-call]
            last_error = str(exc)
            continue
        if response.ok:
            return True, f"连接成功（{response.status_code}）"
        last_error = f"{response.status_code} {response.reason}"
    return False, last_error or "无法连接服务器"


def detect_media_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in IMAGE_EXTENSIONS:
        return "image"
    if suffix in VIDEO_EXTENSIONS:
        return "video"
    if suffix in AUDIO_EXTENSIONS:
        return "audio"
    return "file"


def upload_media_asset(server_url: str, path: Path) -> str:
    if not path.exists():
        raise ValueError(f"文件不存在: {path}")
    if not path.is_file():
        raise ValueError(f"路径不是文件: {path}")
    media_type = detect_media_type(path)
    endpoint = UPLOAD_ENDPOINTS.get(media_type, UPLOAD_ENDPOINTS["image"])
    url = f"{normalize_server_url(server_url)}{endpoint}"
    with path.open("rb") as handle:
        response = requests.post(url, files={"image": handle}, timeout=60)
    response.raise_for_status()
    data = response.json()
    uploaded_name = data.get("name")
    if not uploaded_name:
        raise ValueError("上传响应缺少文件名")
    return uploaded_name
