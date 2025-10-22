from __future__ import annotations

import datetime
import os
from pathlib import Path
from typing import Dict, List, Optional

class WorkflowManager:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def save_batch(self, files: List[tuple[str, bytes]]) -> Dict[str, object]:
        if not files:
            raise ValueError("未选择任何工作流文件")
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        target_dir = self.root / timestamp
        suffix = 1
        while target_dir.exists():
            target_dir = self.root / f"{timestamp}_{suffix}"
            suffix += 1
        target_dir.mkdir(parents=True, exist_ok=False)

        saved: List[str] = []
        for filename, content in files:
            filename = Path(filename or "").name
            if not filename:
                continue
            if not filename.lower().endswith(".json"):
                raise ValueError(f"仅支持上传 JSON 工作流文件：{filename}")
            if not content:
                continue
            destination = target_dir / filename
            destination.write_bytes(content)
            saved.append(str(destination.relative_to(self.root)).replace(os.sep, "/"))
        if not saved:
            raise ValueError("未成功保存任何工作流文件")
        return {"folder": str(target_dir.relative_to(self.root)).replace(os.sep, "/"), "files": saved}

    def list_tree(self) -> Dict[str, object]:
        return self._build_node(self.root)

    def rename(self, relative_path: str, new_name: str) -> Dict[str, object]:
        target = self._resolve(relative_path)
        if target == self.root:
            raise ValueError("禁止重命名根目录")
        sanitized = Path(new_name).name
        if not sanitized:
            raise ValueError("新名称不能为空")
        destination = target.with_name(sanitized)
        if destination.exists():
            raise FileExistsError("已存在同名文件或文件夹")
        destination.parent.mkdir(parents=True, exist_ok=True)
        target.rename(destination)
        return self._node_payload(destination)

    def delete(self, relative_path: str) -> None:
        target = self._resolve(relative_path)
        if target == self.root:
            raise ValueError("禁止删除根目录")
        if target.is_dir():
            for child in target.iterdir():
                self.delete(str(child.relative_to(self.root)))
            target.rmdir()
        else:
            target.unlink()

    # ------------------------------------------------------------------ helpers
    def _resolve(self, relative_path: str) -> Path:
        path = Path(relative_path or "")
        if path.is_absolute():
            raise ValueError("路径必须是相对路径")
        target = (self.root / path).resolve()
        if self._is_outside_root(target):
            raise ValueError("禁止访问 workflow 目录以外的路径")
        return target

    def _is_outside_root(self, path: Path) -> bool:
        try:
            path.relative_to(self.root.resolve())
        except ValueError:
            return True
        return False

    def _build_node(self, path: Path) -> Dict[str, object]:
        payload = self._node_payload(path)
        if path.is_dir():
            children = []
            for child in sorted(path.iterdir(), key=self._sort_key):
                if child.is_file() and child.suffix.lower() != ".json":
                    continue
                children.append(self._build_node(child))
            payload["children"] = children
        return payload

    def _node_payload(self, path: Path) -> Dict[str, object]:
        if path == self.root:
            rel = ""
            name = ""
        else:
            rel = str(path.relative_to(self.root)).replace(os.sep, "/")
            name = path.name
        return {"name": name, "path": rel, "is_dir": path.is_dir()}

    @staticmethod
    def _sort_key(path: Path) -> tuple[int, str]:
        return (0 if path.is_dir() else 1, path.name.lower())
