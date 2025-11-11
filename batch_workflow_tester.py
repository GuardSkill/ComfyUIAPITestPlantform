#!/usr/bin/env python
"""Batch execution helper for ComfyUI workflows.

This script reads a JSON configuration that describes which workflows to run,
which local assets to upload, and how to patch prompts or other node inputs
before execution. It uploads the required assets, runs each workflow in
sequence, downloads any image/video outputs, and stores run metadata for later
inspection.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, MutableMapping, Optional, Sequence, Tuple

import requests
import websocket


LOG = logging.getLogger("batch_workflow_tester")

DEFAULT_CONFIG_PATH = "workflow_test_config.json"
DEFAULT_OUTPUT_ROOT = "workflow_test_output"

# Very small helper to hint upload endpoint selection when the config omits it.
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".gif"}


class ComfyAPIError(RuntimeError):
    """Represents an error reported by the ComfyUI API during execution."""


def _sanitize_for_fs(value: str) -> str:
    cleaned = re.sub(r"[^\w.\-]+", "_", value).strip("_")
    return cleaned or "workflow"


def _ensure_dict(obj: MutableMapping[str, Any], key: str) -> MutableMapping[str, Any]:
    if key not in obj or not isinstance(obj[key], MutableMapping):
        obj[key] = {}
    return obj[key]  # type: ignore[return-value]


def _iter_dict_items(data: Mapping[str, Any]) -> Iterable[Tuple[str, Any]]:
    for key, value in data.items():
        yield key, value


class ComfyAPIClient:
    """Thin wrapper around the ComfyUI HTTP/WebSocket API."""

    def __init__(self, base_url: str, *, timeout: float = 120.0):
        base_url = base_url.rstrip("/")
        if base_url.endswith("/json"):
            base_url = base_url[:-5]
        self.base_url = base_url
        self.session = requests.Session()
        self.client_id = str(uuid.uuid4())
        self.timeout = timeout

    # ------------------------------------------------------------------ uploads
    def upload_file(self, path: Path, *, upload_type: Optional[str] = None) -> str:
        upload_type = (upload_type or self._guess_upload_type(path)).strip("/")
        endpoint = f"{self.base_url}/upload/{upload_type}"
        LOG.debug("Uploading %s -> %s", path, endpoint)

        if not path.exists():
            raise FileNotFoundError(f"Input asset not found: {path}")

        with path.open("rb") as handle:
            response = self.session.post(endpoint, files={"image": handle})
        self._ensure_success(response, f"Upload failed for {path}")

        payload = response.json()
        uploaded_name = payload.get("name")
        if not uploaded_name:
            raise ComfyAPIError(f"Upload response missing name for {path}")
        LOG.debug("Uploaded %s as %s", path.name, uploaded_name)
        return uploaded_name

    @staticmethod
    def _guess_upload_type(path: Path) -> str:
        suffix = path.suffix.lower()
        if suffix in VIDEO_EXTENSIONS:
            return "video"
        return "image"

    # --------------------------------------------------------------- execution
    def execute_prompt(self, prompt: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
        prompt_id = self._queue_prompt(prompt)
        self._wait_for_completion(prompt_id)
        history = self._get_history(prompt_id)
        return prompt_id, history

    def _queue_prompt(self, prompt: Dict[str, Any]) -> str:
        endpoint = f"{self.base_url}/prompt"
        # print(prompt)
        payload = {"prompt": prompt, "client_id": self.client_id}
        response = self.session.post(endpoint, json=payload, timeout=self.timeout)
        self._ensure_success(response, "Queue prompt failed")
        data = response.json()
        prompt_id = data.get("prompt_id")
        if not prompt_id:
            raise ComfyAPIError("Prompt response missing prompt_id")
        return prompt_id

    def _wait_for_completion(self, prompt_id: str) -> None:
        ws_url = self._build_ws_url()
        LOG.debug("Opening websocket %s", ws_url)
        ws = websocket.WebSocket()
        ws.settimeout(self.timeout)
        ws.connect(ws_url)
        try:
            while True:
                try:
                    raw_message = ws.recv()
                except websocket.WebSocketTimeoutException as exc:
                    raise ComfyAPIError(f"Timed out waiting for prompt {prompt_id}") from exc
                if isinstance(raw_message, bytes):
                    continue
                message = json.loads(raw_message)
                message_type = message.get("type")
                data = message.get("data", {})
                if message_type == "progress":
                    node_label = data.get("node") or "pipeline"
                    LOG.debug("Progress %s: %s/%s", node_label, data.get("value"), data.get("max"))
                if message_type == "execution_error":
                    raise ComfyAPIError(f"Execution error: {data}")
                if message_type == "execution_interrupted":
                    raise ComfyAPIError("Execution interrupted by server")
                if message_type == "executing":
                    if data.get("node") is None and data.get("prompt_id") == prompt_id:
                        break
        finally:
            ws.close()

    def _get_history(self, prompt_id: str) -> Dict[str, Any]:
        endpoint = f"{self.base_url}/history/{prompt_id}"
        response = self.session.get(endpoint, timeout=self.timeout)
        self._ensure_success(response, "History fetch failed")
        wrapper = response.json()
        if prompt_id not in wrapper:
            raise ComfyAPIError(f"History for prompt {prompt_id} missing in response")
        return wrapper[prompt_id]

    def _build_ws_url(self) -> str:
        if self.base_url.startswith("https://"):
            scheme = "wss://"
            remainder = self.base_url[8:]
        elif self.base_url.startswith("http://"):
            scheme = "ws://"
            remainder = self.base_url[7:]
        else:
            scheme = "ws://"
            remainder = self.base_url
        return f"{scheme}{remainder}/ws?clientId={self.client_id}"

    # -------------------------------------------------------------- downloads
    def collect_outputs(self, history: Mapping[str, Any]) -> List["OutputAsset"]:
        outputs: List[OutputAsset] = []
        node_outputs: Mapping[str, Any] = history.get("outputs", {})
        for node_id, node_data in _iter_dict_items(node_outputs):
            for bucket in ("images", "files", "gifs", "videos", "audio"):
                items = node_data.get(bucket)
                if not items:
                    continue
                for index, item in enumerate(items):
                    data = self._download_item(item)
                    outputs.append(
                        OutputAsset(
                            node_id=node_id,
                            bucket=bucket,
                            original_filename=os.path.basename(item.get("filename", f"{bucket}_{index}")),
                            index=index,
                            data=data,
                        )
                    )
        return outputs

    def _download_item(self, descriptor: Mapping[str, Any]) -> bytes:
        params = {
            "filename": descriptor.get("filename"),
            "subfolder": descriptor.get("subfolder", ""),
            "type": descriptor.get("type", "output"),
        }
        response = self.session.get(f"{self.base_url}/view", params=params, timeout=self.timeout)
        self._ensure_success(response, f"Download failed for {params.get('filename')}")
        return response.content

    def _ensure_success(self, response: requests.Response, context: str) -> None:
        try:
            response.raise_for_status()
        except requests.HTTPError as exc:
            detail = self._extract_error_detail(response)
            message = f"{context}: {exc}"
            if detail:
                message = f"{message} | details: {detail}"
            raise ComfyAPIError(message) from exc

    @staticmethod
    def _extract_error_detail(response: requests.Response) -> str:
        content_type = (response.headers.get("content-type") or "").lower()
        text = (response.text or "").strip()
        if not text:
            return ""
        if "application/json" in content_type:
            try:
                parsed = response.json()
            except Exception:  # pylint: disable=broad-except
                return text[:500]
            return json.dumps(parsed, ensure_ascii=False, indent=2)[:1000]
        return text[:500]


@dataclass
class OutputAsset:
    node_id: str
    bucket: str
    original_filename: str
    index: int
    data: bytes


@dataclass
class WorkflowTestCase:
    name: str
    workflow_path: Path
    inputs: Mapping[str, Any] = field(default_factory=dict)
    text_inputs: Mapping[str, Any] = field(default_factory=dict)
    overrides: Mapping[str, Any] = field(default_factory=dict)
    output_dir: Optional[Path] = None


class BatchWorkflowTester:
    """Coordinates reading configuration, running workflows, and persisting outputs."""

    def __init__(self, client: ComfyAPIClient, *, output_root: Path):
        self.client = client
        self.output_root = output_root
        self.results: List[Dict[str, Any]] = []

    # ----------------------------------------------------------- public entry
    def run_all(self, cases: Sequence[WorkflowTestCase]) -> None:
        for case in cases:
            self.run_case(case)

    def run_case(self, case: WorkflowTestCase) -> Dict[str, Any]:
        LOG.info("==== Running workflow: %s ====", case.name)
        try:
            run_info = self._run_case(case)
        except Exception as exc:  # pylint: disable=broad-except
            LOG.exception("Workflow %s failed: %s", case.name, exc)
            result = {"name": case.name, "status": "failed", "error": str(exc)}
            self.results.append(result)
            return result
        LOG.info("Workflow %s finished successfully", case.name)
        result = {"name": case.name, "status": "success", **run_info}
        self.results.append(result)
        return result

    # ---------------------------------------------------------- case handling
    def _run_case(self, case: WorkflowTestCase) -> Dict[str, Any]:
        workflow = self._load_workflow(case.workflow_path)
        upload_mappings = self._prepare_inputs(case.inputs)
        _replace_placeholders(workflow, upload_mappings)
        _apply_text_inputs(workflow, case.text_inputs)
        _apply_overrides(workflow, case.overrides)

        prompt_id, history = self.client.execute_prompt(workflow)
        status_info = history.get("status", {})
        if status_info.get("status") not in (None, "success"):
            raise ComfyAPIError(f"Workflow reported non-success status: {status_info}")

        outputs = self.client.collect_outputs(history)
        output_folder = self._resolve_output_dir(case)
        saved_paths = self._persist_outputs(outputs, output_folder)
        metadata_path = self._write_metadata(output_folder, case, prompt_id, status_info, saved_paths)

        return {
            "prompt_id": prompt_id,
            "output_dir": str(output_folder),
            "saved_files": saved_paths,
            "metadata_file": str(metadata_path),
        }

    @staticmethod
    def _load_workflow(path: Path) -> Dict[str, Any]:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)

    def _prepare_inputs(self, inputs: Mapping[str, Any]) -> Dict[str, str]:
        mapping: Dict[str, str] = {}
        for placeholder, raw in inputs.items():
            if isinstance(raw, str):
                path = Path(raw)
                upload_type = None
            elif isinstance(raw, Mapping):
                path = Path(raw.get("path", ""))
                upload_type = raw.get("upload_type")
                if raw.get("upload", True) is False:
                    # Use the provided name directly without uploading.
                    remote_name = raw.get("name") or raw.get("path", "")
                    for key in self._placeholder_aliases(placeholder):
                        mapping[key] = remote_name
                    LOG.debug("Using existing server asset %s -> %s", placeholder, remote_name)
                    continue
            else:
                raise ValueError(f"Unsupported input definition for {placeholder}: {raw}")
            uploaded_name = self.client.upload_file(path, upload_type=upload_type)
            for key in self._placeholder_aliases(placeholder):
                mapping[key] = uploaded_name
        return mapping

    @staticmethod
    def _placeholder_aliases(placeholder: str) -> List[str]:
        normalized = placeholder.strip("{}")
        aliases = {placeholder}
        if normalized:
            aliases.add(normalized)
            aliases.add(f"{{{normalized}}}")
        return list(aliases)

    def _resolve_output_dir(self, case: WorkflowTestCase) -> Path:
        target = case.output_dir or self.output_root / _sanitize_for_fs(case.name)
        timestamp = time.strftime("%Y%m%d-%H%M%S")
        final_dir = Path(target) / timestamp
        final_dir.mkdir(parents=True, exist_ok=True)
        return final_dir

    @staticmethod
    def _persist_outputs(outputs: Sequence[OutputAsset], output_folder: Path) -> List[str]:
        saved: List[str] = []
        for asset in outputs:
            filename = f"{asset.node_id}_{asset.bucket}_{asset.index}_{asset.original_filename}"
            target_path = output_folder / filename
            target_path.write_bytes(asset.data)
            saved.append(str(target_path))
        return saved

    @staticmethod
    def _write_metadata(
        output_folder: Path,
        case: WorkflowTestCase,
        prompt_id: str,
        status_info: Mapping[str, Any],
        saved_paths: Sequence[str],
    ) -> Path:
        metadata = {
            "case_name": case.name,
            "workflow_path": str(case.workflow_path),
            "prompt_id": prompt_id,
            "status": status_info,
            "saved_files": list(saved_paths),
        }
        metadata_path = output_folder / "run_metadata.json"
        with metadata_path.open("w", encoding="utf-8") as handle:
            json.dump(metadata, handle, ensure_ascii=False, indent=2)
        return metadata_path


def _replace_placeholders(workflow: MutableMapping[str, Any], mapping: Mapping[str, str]) -> None:
    def _replace(value: Any) -> Any:
        if isinstance(value, str) and value in mapping:
            return mapping[value]
        if isinstance(value, list):
            return [_replace(item) for item in value]
        if isinstance(value, dict):
            return {key: _replace(val) for key, val in value.items()}
        return value

    for node_id, node in list(workflow.items()):
        if isinstance(node, MutableMapping):
            workflow[node_id] = _replace(node)  # type: ignore[assignment]


def _apply_text_inputs(workflow: MutableMapping[str, Any], text_inputs: Mapping[str, Any]) -> None:
    if not text_inputs:
        return
    for identifier, updates in text_inputs.items():
        if identifier.startswith("id:"):
            node = workflow.get(identifier[3:])
            if not isinstance(node, MutableMapping):
                LOG.warning("Text input skipped, node id %s not found", identifier)
                continue
            inputs = _ensure_dict(node, "inputs")
            inputs.update(updates)
        else:
            matches = [
                node
                for node in workflow.values()
                if isinstance(node, MutableMapping) and node.get("_meta", {}).get("title") == identifier
            ]
            if not matches:
                LOG.warning("Text input skipped, title %s not found", identifier)
            for node in matches:
                inputs = _ensure_dict(node, "inputs")
                inputs.update(updates)


def _apply_overrides(workflow: MutableMapping[str, Any], overrides: Mapping[str, Any]) -> None:
    if not overrides:
        return
    for key, value in overrides.items():
        if key.startswith("id:"):
            node = workflow.get(key[3:])
            if not isinstance(node, MutableMapping):
                LOG.warning("Override skipped, node id %s not found", key)
                continue
            if isinstance(value, Mapping):
                node.update(value)
            else:
                LOG.warning("Override for %s should be a mapping", key)
        elif "." in key:
            node_id, *path_parts = key.split(".")
            node = workflow.get(node_id)
            if not isinstance(node, MutableMapping):
                LOG.warning("Override skipped, node id %s not found", node_id)
                continue
            target: MutableMapping[str, Any] = node
            for part in path_parts[:-1]:
                next_target = target.get(part)
                if not isinstance(next_target, MutableMapping):
                    next_target = {}
                    target[part] = next_target
                target = next_target  # type: ignore[assignment]
            target[path_parts[-1]] = value
        else:
            matches = [
                node
                for node in workflow.values()
                if isinstance(node, MutableMapping) and node.get("_meta", {}).get("title") == key
            ]
            if not matches:
                LOG.warning("Override skipped, title %s not found", key)
                continue
            for node in matches:
                if isinstance(value, Mapping):
                    node.update(value)
                else:
                    LOG.warning("Override for %s should be a mapping", key)


def load_config(path: Path, *, overrides: Optional[argparse.Namespace] = None) -> Tuple[str, Path, List[WorkflowTestCase]]:
    with path.open("r", encoding="utf-8") as handle:
        config = json.load(handle)

    server = config.get("server") or "http://127.0.0.1:8189"
    if overrides and overrides.server:
        server = overrides.server

    output_root = Path(overrides.output_dir if overrides and overrides.output_dir else config.get("output_dir", DEFAULT_OUTPUT_ROOT))

    raw_cases = config.get("workflows", [])
    if not isinstance(raw_cases, list) or not raw_cases:
        raise ValueError("Configuration must include a non-empty 'workflows' list")

    allowed_names: Optional[set[str]] = None
    if overrides and overrides.workflows:
        allowed_names = {name for name in overrides.workflows}

    cases: List[WorkflowTestCase] = []
    for raw in raw_cases:
        name = raw.get("name")
        if not name:
            raise ValueError("Each workflow entry must include a 'name'")
        if allowed_names and name not in allowed_names:
            continue
        workflow_path = Path(raw.get("workflow_path"))
        case = WorkflowTestCase(
            name=name,
            workflow_path=workflow_path,
            inputs=raw.get("inputs", {}),
            text_inputs=raw.get("text_inputs", {}),
            overrides=raw.get("overrides", {}),
            output_dir=Path(raw["output_dir"]) if raw.get("output_dir") else None,
        )
        cases.append(case)

    if allowed_names and not cases:
        raise ValueError("No workflows matched the provided filters")

    return server, output_root, cases


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Batch tester for ComfyUI workflows")
    parser.add_argument("--config", default=DEFAULT_CONFIG_PATH, help="Path to the workflow batch configuration JSON file")
    parser.add_argument("--server", help="Override the ComfyUI server base URL (e.g. http://127.0.0.1:8189)")
    parser.add_argument("--workflow", "-w", action="append", dest="workflows", help="Only run workflows matching this name (repeatable)")
    parser.add_argument("--output-dir", help="Override the directory used for saving outputs")
    parser.add_argument("--log-level", default="INFO", help="Logging verbosity (DEBUG, INFO, WARNING, ...)")
    return parser.parse_args(argv)


def configure_logging(level: str) -> None:
    logging.basicConfig(level=getattr(logging, level.upper(), logging.INFO), format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    configure_logging(args.log_level)

    config_path = Path(args.config)
    if not config_path.exists():
        LOG.error("Configuration file not found: %s", config_path)
        return 2

    try:
        server, output_root, cases = load_config(config_path, overrides=args)
    except Exception as exc:  # pylint: disable=broad-except
        LOG.error("Failed to load configuration: %s", exc)
        return 2

    client = ComfyAPIClient(server)
    tester = BatchWorkflowTester(client, output_root=output_root)
    tester.run_all(cases)

    succeeded = [result for result in tester.results if result.get("status") == "success"]
    failed = [result for result in tester.results if result.get("status") == "failed"]

    LOG.info("Run complete: %s succeeded, %s failed", len(succeeded), len(failed))
    if failed:
        LOG.info("Failed workflows: %s", ", ".join(item["name"] for item in failed))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
