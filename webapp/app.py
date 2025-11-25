from __future__ import annotations

import json
import logging
import mimetypes
import os
from pathlib import Path
from typing import Dict, List, Optional, Tuple

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
    _apply_text_inputs,
    _replace_placeholders,
    _sanitize_for_fs,
)
from .config import (
    DATASET_ROOT,
    DEFAULT_OUTPUT_ROOT,
    DEFAULT_SERVER_URL,
    MEDIA_ROOT,
    WORKFLOW_ROOT,
    ensure_dataset_root,
    ensure_media_root,
)
from .dataset_jobs import DatasetJobManager
from .dataset_manager import DatasetManager
from .jobs import JobManager
from .media_manager import MediaEntry, MediaManager
from .workflow_manager import WorkflowManager
from .workflow_store import PlaceholderInfo, WorkflowGroup, WorkflowInfo, WorkflowStore


LOG = logging.getLogger("webapp")

AUDIO_EXTENSIONS = {".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a"}
# ComfyUI统一使用 /upload/image 接口上传所有类型的文件（图片、视频、音频等）
UPLOAD_ENDPOINTS = {
    "image": "/upload/image",
    "video": "/upload/image",  # ComfyUI没有单独的video端点
    "audio": "/upload/image",  # ComfyUI没有单独的audio端点
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


class DeleteMediaPayload(BaseModel):
    paths: List[str] = Field(..., description="需要删除的媒体文件或文件夹路径列表，相对于 media 根目录")


class DatasetRunOptions(BaseModel):
    server_url: Optional[str] = None
    convert_images_to_jpg: bool = True
    append: bool = False


class PromptOverride(BaseModel):
    node_id: str = Field(..., description="需要修改的节点ID")
    field: str = Field(..., description="节点输入字段名称")
    value: str = Field(..., description="要写入的提示词内容")


class DatasetRunRequest(BaseModel):
    dataset_name: str
    workflow_id: str
    placeholders: Dict[str, List[str]]
    options: Optional[DatasetRunOptions] = None
    prompt_overrides: Optional[List[PromptOverride]] = None
    dataset_prompt: Optional[str] = None


class DatasetPromptUpdate(BaseModel):
    text: Optional[str] = Field(None, description="更新后的提示词内容，留空则删除")


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
    ensure_dataset_root()
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
    app.mount("/datasets", StaticFiles(directory=DATASET_ROOT), name="datasets")

    store = WorkflowStore(WORKFLOW_ROOT)
    media_manager = MediaManager(MEDIA_ROOT)
    job_manager = JobManager()
    dataset_manager = DatasetManager(DATASET_ROOT)
    dataset_job_manager = DatasetJobManager()
    workflow_manager = WorkflowManager(WORKFLOW_ROOT)

    app.state.store = store
    app.state.media = media_manager
    app.state.jobs = job_manager
    app.state.datasets = dataset_manager
    app.state.dataset_jobs = dataset_job_manager
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

    @app.post("/api/media/delete")
    async def delete_media(payload: DeleteMediaPayload = Body(...)) -> Dict[str, object]:
        if not payload.paths:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="未选择任何媒体项")
        failures: List[str] = []
        for path in payload.paths:
            try:
                media_manager.delete(path)
            except (FileNotFoundError, ValueError, PermissionError) as exc:
                failures.append(f"{path}: {exc}")
        if failures:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="; ".join(failures))
        return {"status": "ok"}

    @app.get("/api/datasets")
    async def list_datasets() -> Dict[str, object]:
        datasets = [serialize_dataset(info) for info in dataset_manager.list_datasets()]
        return {"datasets": datasets}

    @app.get("/api/datasets/{dataset_name}")
    async def get_dataset(dataset_name: str) -> Dict[str, object]:
        safe_name = _sanitize_for_fs(dataset_name)
        try:
            pairs = dataset_manager.collect_pairs(safe_name)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
        metadata_path = DATASET_ROOT / safe_name / "metadata.json"
        metadata: Dict[str, object] = {}
        if metadata_path.exists():
            with metadata_path.open("r", encoding="utf-8") as handle:
                metadata = json.load(handle)
        metadata["actual_runs"] = len(pairs)
        if "total_runs" in metadata:
            metadata["recorded_runs"] = metadata.get("total_runs", len(pairs))
        return {
            "metadata": metadata,
            "pairs": pairs,
            "stats": {
                "total_runs": metadata.get("total_runs", len(pairs)),
                "actual_runs": len(pairs),
                "controls": metadata.get("control_slots", {}),
            },
        }

    @app.delete("/api/datasets/{dataset_name}")
    async def delete_dataset(dataset_name: str) -> Dict[str, object]:
        dataset_manager.remove_dataset(_sanitize_for_fs(dataset_name))
        return {"status": "ok"}

    @app.delete("/api/datasets/{dataset_name}/pair/{index}")
    async def delete_dataset_pair(dataset_name: str, index: int) -> Dict[str, object]:
        dataset_manager.remove_pair(_sanitize_for_fs(dataset_name), index)
        return {"status": "ok"}

    @app.post("/api/datasets/{dataset_name}/pair/{index}/prompt")
    async def update_dataset_pair_prompt(dataset_name: str, index: int, payload: DatasetPromptUpdate) -> Dict[str, object]:
        safe_name = _sanitize_for_fs(dataset_name)
        try:
            prompt_info = dataset_manager.update_prompt_annotation(safe_name, index, payload.text or "")
        except FileNotFoundError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
        return {"status": "ok", "prompt": prompt_info}

    @app.post("/api/datasets/run", status_code=status.HTTP_202_ACCEPTED)
    async def run_dataset(payload: DatasetRunRequest, background_tasks: BackgroundTasks) -> Dict[str, object]:
        dataset_name_raw = (payload.dataset_name or "").strip()
        if not dataset_name_raw:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="数据集名称不能为空")
        safe_name = _sanitize_for_fs(dataset_name_raw)
        options = payload.options or DatasetRunOptions()
        normalized_server = normalize_server_url(options.server_url or DEFAULT_SERVER_URL)
        safe_options = options.copy(update={"server_url": normalized_server})
        safe_payload = payload.copy(update={"dataset_name": safe_name, "options": safe_options})
        job = dataset_job_manager.create_job(safe_name, safe_payload.workflow_id, server_url=normalized_server)

        def _task() -> None:
            try:
                summary = execute_dataset_run(store, dataset_manager, safe_payload, dataset_job_manager, job.job_id)
                dataset_job_manager.mark_finished(job.job_id, summary)
            except HTTPException as exc:
                dataset_job_manager.mark_failed(job.job_id, str(exc.detail))
            except Exception as exc:  # pylint: disable=broad-except
                LOG.exception("数据集任务失败: %s", exc)
                dataset_job_manager.mark_failed(job.job_id, str(exc))

        background_tasks.add_task(_task)
        return {"job_id": job.job_id}

    @app.get("/api/dataset-jobs")
    async def list_dataset_jobs() -> Dict[str, object]:
        jobs = [serialize_dataset_job(job) for job in dataset_job_manager.list_jobs()]
        return {"jobs": jobs}

    @app.get("/api/dataset-jobs/{job_id}")
    async def get_dataset_job(job_id: str) -> Dict[str, object]:
        job = dataset_job_manager.get(job_id)
        if job is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到数据集任务")
        return serialize_dataset_job(job)

    @app.get("/api/dataset/workflows")
    async def dataset_workflow_candidates() -> Dict[str, object]:
        store.refresh()
        workflows: List[Dict[str, object]] = []
        for info in store.list_workflows():
            placeholders: List[Dict[str, object]] = []
            auto_placeholders: List[Dict[str, str]] = []
            for placeholder in info.placeholders:
                if placeholder.default_value is not None:
                    auto_placeholders.append(
                        {
                            "name": placeholder.name,
                            "value": placeholder.default_value,
                        }
                    )
                    continue
                normalized = normalize_placeholder_key(placeholder.name)
                if not normalized.strip("{}").lower().startswith("input"):
                    continue
                placeholders.append(
                    {
                        "name": normalized,
                        "display": placeholder.name,
                        "type": placeholder.media_type,
                    }
                )
            if not placeholders:
                continue
            prompt_fields = [
                {
                    "node_id": field.node_id,
                    "field": field.field,
                    "label": field.label,
                    "default_value": field.default_value,
                }
                for field in info.prompt_fields
            ]
            workflows.append(
                {
                    "id": info.identifier,
                    "name": info.name,
                    "path": str(info.path),
                    "placeholders": placeholders,
                    "prompt_fields": prompt_fields,
                    "auto_placeholders": auto_placeholders,
                }
            )
        return {"workflows": workflows}

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
                if placeholder.default_value is not None:
                    case_inputs[placeholder.name] = {"upload": False, "name": placeholder.default_value}
                    continue
                remote_name = uploaded_names.get(placeholder.name)
                if not remote_name:
                    raise RuntimeError(f"占位符 {placeholder.name} 缺少已上传的资源")
                case_inputs[placeholder.name] = {"upload": False, "name": remote_name, "path": remote_name}
            case = WorkflowTestCase(name=info.name, workflow_path=info.path, inputs=case_inputs)
            cases.append(case)
        total = len(cases)
        for index, case in enumerate(cases, start=1):
            job_manager.append_log(job_id, f"开始执行第 {index}/{total} 个工作流：{case.name}")
            result = tester.run_case(case)
            if result.get("status") == "success":
                job_manager.append_log(job_id, f"完成第 {index}/{total} 个工作流：{case.name}")
            else:
                job_manager.append_log(
                    job_id,
                    f"第 {index}/{total} 个工作流失败：{case.name} -> {result.get('error', '未知错误')}",
                )
        job_manager.mark_finished(job_id, tester.results)
        job_manager.append_log(job_id, "任务执行完成")
    except Exception as exc:  # pylint: disable=broad-except
        LOG.exception("任务执行失败: %s", exc)
        job_manager.mark_failed(job_id, str(exc))
        job_manager.append_log(job_id, f"任务失败: {exc}")


# ---------------------------------------------------------------- dataset run
def execute_dataset_run(
    store: WorkflowStore,
    dataset_manager: DatasetManager,
    payload: DatasetRunRequest,
    job_manager: DatasetJobManager,
    job_id: str,
) -> Dict[str, object]:
    options = payload.options or DatasetRunOptions()
    dataset_name_raw = (payload.dataset_name or "").strip()
    if not dataset_name_raw:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="数据集名称不能为空")
    dataset_name = _sanitize_for_fs(dataset_name_raw)
    dataset_dir = DATASET_ROOT / dataset_name
    metadata_path = dataset_dir / "metadata.json"
    dataset_pre_exists = dataset_dir.exists()
    dataset_exists = dataset_pre_exists and any(dataset_dir.iterdir())
    existing_metadata: Dict[str, object] = {}
    if metadata_path.exists():
        with metadata_path.open("r", encoding="utf-8") as handle:
            existing_metadata = json.load(handle)
    if dataset_exists and not options.append:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="数据集已存在，请勾选追加或更换名称")

    placeholder_map = payload.placeholders or {}
    if not placeholder_map:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="必须指定占位符素材")

    normalized_order: List[str] = []
    normalized_map: Dict[str, List[str]] = {}
    placeholder_labels: Dict[str, str] = {}
    for key, values in placeholder_map.items():
        normalized = normalize_placeholder_key(key)
        normalized_order.append(normalized)
        placeholder_labels[normalized] = key
        normalized_map[normalized] = list(values)
    workflow_info = store.get_workflow(payload.workflow_id)
    if workflow_info is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到指定的工作流")

    existing_control_map = existing_metadata.get("control_slots") if existing_metadata else None

    structure, control_slot_map, last_index = dataset_manager.ensure_structure(
        dataset_name,
        normalized_order or ["input_image"],
        existing_control_map,
    )
    # 获取 target 目录：兼容新旧命名规则
    # 旧格式：target
    # 新格式：{dataset_name}_target
    target_dir = structure.get("target") or next((v for k, v in structure.items() if k.endswith("_target")), None)
    if target_dir is None:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="未找到输出目录")
    server_url = normalize_server_url(options.server_url or DEFAULT_SERVER_URL)
    client = ComfyAPIClient(server_url)

    pairs = list(dataset_manager.iter_pairs(normalized_map))
    total_runs = len(pairs)
    if total_runs == 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="未生成任何运行批次")

    job_manager.mark_running(job_id, total_runs)
    job_manager.append_log(job_id, f"使用服务器：{server_url}")
    prompt_mapping: Dict[str, Dict[str, str]] = {}
    prompt_overrides_list: List[Dict[str, str]] = []
    for override in payload.prompt_overrides or []:
        text_value = (override.value or "").strip()
        node_id = (override.node_id or "").strip()
        field = (override.field or "").strip()
        if not text_value or not node_id or not field:
            continue
        key = f"id:{node_id}"
        prompt_mapping.setdefault(key, {})[field] = text_value
        prompt_overrides_list.append({"node_id": node_id, "field": field, "value": text_value})
    dataset_prompt_text = (payload.dataset_prompt or "").strip()
    try:
        for offset, pair in enumerate(pairs, start=1):
            index = last_index + offset
            remote_mapping: Dict[str, str] = {}
            for placeholder in normalized_order:
                slot_name = control_slot_map.get(placeholder, "control")
                control_dir = structure[slot_name]
                source_path = pair[placeholder]
                saved_control = dataset_manager.save_control(
                    control_dir,
                    index,
                    source_path,
                    force_jpg=options.convert_images_to_jpg,
                )
                uploaded_name = client.upload_file(saved_control)
                for alias in placeholder_aliases(placeholder):
                    remote_mapping[alias] = uploaded_name
            for placeholder in workflow_info.placeholders:
                if placeholder.default_value is None:
                    continue
                for alias in placeholder_aliases(placeholder.name):
                    remote_mapping.setdefault(alias, placeholder.default_value)

            with workflow_info.path.open("r", encoding="utf-8") as handle:
                workflow_data = json.load(handle)
            _replace_placeholders(workflow_data, remote_mapping)
            if prompt_mapping:
                _apply_text_inputs(workflow_data, prompt_mapping)
            prompt_id, history = client.execute_prompt(workflow_data)
            outputs = client.collect_outputs(history)
            asset = next((item for item in outputs if item.bucket in ("images", "videos")), None)
            if asset is None:
                raise RuntimeError("工作流未返回图像或视频输出")
            convert_output = options.convert_images_to_jpg and asset.bucket == "images"
            dataset_manager.save_target_asset(
                target_dir,
                index,
                asset.original_filename,
                asset.data,
                convert_to_jpg=convert_output,
            )
            if dataset_prompt_text:
                dataset_manager.save_prompt_annotation(target_dir, index, dataset_prompt_text)
            job_manager.update_progress(job_id, offset, f"第 {offset}/{total_runs} 次运行完成")
    except Exception:
        if not dataset_pre_exists:
            dataset_manager.remove_dataset(dataset_name)
        raise

    existing_runs = existing_metadata.get("total_runs", 0)
    metadata = {
        "dataset_name": dataset_name,
        "workflow_id": workflow_info.identifier,
        "workflow_path": str(workflow_info.path),
        "workflow_name": workflow_info.name,
        "total_runs": existing_runs + total_runs,
        "placeholders": [placeholder_labels[p] for p in normalized_order],
        "placeholder_map": placeholder_labels,
        "control_slots": control_slot_map,
        "prompt_overrides": prompt_overrides_list,
        "dataset_prompt": dataset_prompt_text,
    }
    dataset_manager.save_metadata(dataset_name, metadata)
    return {
        "dataset": dataset_name,
        "total_runs": total_runs,
        "previous_runs": existing_runs,
        "total_count": existing_runs + total_runs,
    }


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
        "prompt_fields": [
            {
                "node_id": field.node_id,
                "field": field.field,
                "label": field.label,
                "default_value": field.default_value,
            }
            for field in workflow.prompt_fields
        ],
        "auto_placeholders": [
            {"name": placeholder.name, "value": placeholder.default_value}
            for placeholder in workflow.placeholders
            if placeholder.default_value is not None
        ],
    }


def serialize_placeholder(placeholder: PlaceholderInfo) -> Dict[str, str]:
    payload: Dict[str, str] = {"name": placeholder.name, "type": placeholder.media_type}
    if placeholder.default_value is not None:
        payload["default_value"] = placeholder.default_value
    return payload


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


def serialize_dataset(info) -> Dict[str, object]:
    return {
        "name": info.name,
        "total_runs": info.total_runs,
        "recorded_runs": info.recorded_runs,
        "workflows": info.workflows,
    }


def placeholder_aliases(placeholder: str) -> List[str]:
    bare = placeholder.strip("{}")
    return list({placeholder, bare, f"{{{bare}}}"})


def normalize_placeholder_key(key: str) -> str:
    bare = key.strip().strip("{}")
    if not bare:
        raise ValueError("占位符名称不能为空")
    return f"{{{bare}}}"


def serialize_dataset_job(job) -> Dict[str, object]:
    return {
        "job_id": job.job_id,
        "dataset_name": job.dataset_name,
        "workflow_id": job.workflow_id,
        "server_url": job.server_url,
        "status": job.status,
        "total": job.total,
        "completed": job.completed,
        "error": job.error,
        "result": job.result,
        "logs": job.logs,
        "started_at": job.started_at,
        "finished_at": job.finished_at,
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
