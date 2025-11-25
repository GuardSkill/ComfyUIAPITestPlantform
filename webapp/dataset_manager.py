from __future__ import annotations

import io
import json
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Optional, Sequence

from PIL import Image
from .config import DATASET_ROOT, MEDIA_ROOT, ensure_dataset_root


@dataclass
class DatasetRun:
    workflow_id: str
    placeholder_files: Dict[str, List[str]]
    total_runs: int


@dataclass
class DatasetInfo:
    name: str
    path: Path
    workflows: List[str] = field(default_factory=list)
    total_runs: int = 0
    recorded_runs: int = 0


class DatasetManager:
    def __init__(self, root: Path):
        self.root = root
        ensure_dataset_root()
        self.root.mkdir(parents=True, exist_ok=True)

    def list_datasets(self) -> List[DatasetInfo]:
        infos: List[DatasetInfo] = []
        for entry in sorted(self.root.iterdir()):
            if not entry.is_dir():
                continue
            metadata = entry / "metadata.json"
            info = DatasetInfo(name=entry.name, path=entry)
            actual_runs = len(self._collect_existing_indices(entry))
            info.total_runs = actual_runs
            if metadata.exists():
                with metadata.open("r", encoding="utf-8") as handle:
                    data = json.load(handle)
                info.workflows = data.get("workflows", [])
                info.recorded_runs = data.get("total_runs", actual_runs)
            infos.append(info)
        return infos

    def ensure_dataset_dir(self, name: str) -> Path:
        dataset_dir = self.root / name
        dataset_dir.mkdir(parents=True, exist_ok=True)
        return dataset_dir

    def save_metadata(self, name: str, metadata: Mapping[str, object]) -> None:
        dataset_dir = self.ensure_dataset_dir(name)
        path = dataset_dir / "metadata.json"
        with path.open("w", encoding="utf-8") as handle:
            json.dump(metadata, handle, ensure_ascii=False, indent=2)

    def remove_dataset(self, name: str) -> None:
        dataset_dir = self.root / name
        if dataset_dir.exists() and dataset_dir.is_dir():
            shutil.rmtree(dataset_dir)

    def resolve_media_path(self, relative: str) -> Path:
        candidate = (MEDIA_ROOT / relative).resolve()
        media_root = MEDIA_ROOT.resolve()
        if media_root not in candidate.parents and candidate != media_root:
            raise ValueError(f"非法媒体路径: {relative}")
        return candidate

    def iter_pairs(self, placeholder_map: Mapping[str, Sequence[str]]) -> Iterable[Dict[str, Path]]:
        normalized: Dict[str, List[Path]] = {}
        max_len = 0
        for key, values in placeholder_map.items():
            paths = [self.resolve_media_path(val) for val in values]
            if not paths:
                raise ValueError(f"占位符 {key} 未提供素材")
            normalized[key] = paths
            if len(paths) > max_len:
                max_len = len(paths)
        indices = range(max_len)
        for idx in indices:
            result: Dict[str, Path] = {}
            for key, items in normalized.items():
                result[key] = items[idx % len(items)]
            yield result

    def ensure_structure(
        self,
        dataset_name: str,
        slots: List[str],
        existing_slots: Optional[Dict[str, str]] = None,
    ) -> tuple[Dict[str, Path], Dict[str, str], int]:
        dataset_dir = self.ensure_dataset_dir(dataset_name)
        # 使用新的命名规则：{dataset_name}_target
        target_slot_name = f"{dataset_name}_target"
        target_dir = dataset_dir / target_slot_name
        target_dir.mkdir(parents=True, exist_ok=True)
        mapping: Dict[str, Path] = {target_slot_name: target_dir}
        control_slots: Dict[str, str] = {}
        assigned = set()

        # 处理已存在的数据集结构（兼容旧格式）
        if existing_slots:
            for placeholder, slot_name in existing_slots.items():
                control_slots[placeholder] = slot_name
                control_dir = dataset_dir / slot_name
                control_dir.mkdir(parents=True, exist_ok=True)
                mapping[slot_name] = control_dir
                assigned.add(placeholder)

        # 为新占位符分配文件夹
        # 统一使用 {dataset_name}_control1, {dataset_name}_control2, ... 命名
        for idx, placeholder in enumerate(slots, start=1):
            if placeholder in control_slots:
                continue
            slot_name = f"{dataset_name}_control{idx}"
            while slot_name in mapping:
                idx += 1
                slot_name = f"{dataset_name}_control{idx}"
            control_dir = dataset_dir / slot_name
            control_dir.mkdir(parents=True, exist_ok=True)
            control_slots[placeholder] = slot_name
            mapping[slot_name] = control_dir

        existing_indices = self._collect_existing_indices(dataset_dir)
        last_index = max(existing_indices) if existing_indices else 0
        return mapping, control_slots, last_index

    def save_control(self, folder: Path, index: int, source: Path, force_jpg: bool = True) -> Path:
        alias = f"{index:07d}"
        if force_jpg and self._is_image(source):
            dest = folder / f"{alias}.jpg"
            self._convert_to_jpg(source, dest)
        else:
            dest = folder / f"{alias}{source.suffix.lower()}"
            shutil.copy2(source, dest)
        return dest

    def save_target_asset(self, folder: Path, index: int, filename_hint: str, data: bytes, convert_to_jpg: bool = True) -> Path:
        alias = f"{index:07d}"
        suffix = Path(filename_hint).suffix.lower()
        if convert_to_jpg and suffix in {".png", ".webp", ".bmp"}:
            dest = folder / f"{alias}.jpg"
            with Image.open(io.BytesIO(data)) as image:
                image.convert("RGB").save(dest, format="JPEG")
        else:
            if not suffix:
                suffix = ".png"
            dest = folder / f"{alias}{suffix}"
            dest.write_bytes(data)
        return dest

    def save_prompt_annotation(self, folder: Path, index: int, text: str) -> Path:
        alias = f"{index:07d}"
        dest = folder / f"{alias}.txt"
        dest.write_text(text, encoding="utf-8")
        return dest

    def update_prompt_annotation(self, dataset_name: str, index: int, text: str) -> Optional[Dict[str, str]]:
        dataset_dir = self.root / dataset_name
        if not dataset_dir.exists():
            raise FileNotFoundError("未找到数据集")
        # 查找 target 目录：兼容新旧命名规则
        # 旧格式：target
        # 新格式：{dataset_name}_target
        target_dir = dataset_dir / "target"
        if not target_dir.exists():
            target_dir = dataset_dir / f"{dataset_name}_target"
        if not target_dir.exists():
            raise FileNotFoundError("数据集缺少目标目录")
        alias = f"{index:07d}"
        path = target_dir / f"{alias}.txt"
        normalized = (text or "").strip("\ufeff")
        if not normalized.strip():
            path.unlink(missing_ok=True)
            return None
        path.write_text(normalized, encoding="utf-8")
        return self._read_prompt_annotation(target_dir, index)

    def collect_pairs(self, dataset_name: str) -> List[Dict[str, object]]:
        dataset_dir = self.root / dataset_name
        if not dataset_dir.exists():
            raise FileNotFoundError("未找到数据集")
        controls = self._collect_control_dirs(dataset_dir)
        # 查找 target 目录：兼容新旧命名规则
        # 旧格式：target
        # 新格式：{dataset_name}_target
        target_dir = dataset_dir / "target"
        if not target_dir.exists():
            target_dir = dataset_dir / f"{dataset_name}_target"
        target_files = self._list_indexed_files(target_dir)
        indices = sorted({*target_files.keys(), *controls.get("combined_indices", set())})
        results: List[Dict[str, object]] = []
        for index in indices:
            entry: Dict[str, object] = {
                "index": index,
                "controls": {},
                "target": target_files.get(index),
            }
            for slot_name, items in controls.get("slots", {}).items():
                entry["controls"][slot_name] = items.get(index)
            prompt_data = self._read_prompt_annotation(target_dir, index)
            if prompt_data:
                entry["prompt"] = prompt_data
            results.append(entry)
        return results

    def remove_pair(self, dataset_name: str, index: int) -> None:
        dataset_dir = self.root / dataset_name
        if not dataset_dir.exists():
            return
        prefix = f"{index:07d}"
        for entry in dataset_dir.iterdir():
            if not entry.is_dir():
                continue
            # 兼容新旧命名规则：
            # 旧格式：target, control, control1, control2
            # 新格式：{dataset_name}_target, {dataset_name}_control1, {dataset_name}_control2
            is_target = entry.name == "target" or entry.name.endswith("_target")
            is_control = entry.name.startswith("control") or "control" in entry.name.lower()
            if not (is_target or is_control):
                continue
            for path in entry.glob(f"{prefix}*"):
                path.unlink(missing_ok=True)

    # ---------------------------- internal helpers -------------------------
    @staticmethod
    def _is_image(path: Path) -> bool:
        return path.suffix.lower() in {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff"}

    @staticmethod
    def _convert_to_jpg(source: Path, dest: Path) -> None:
        with Image.open(source) as image:
            image.convert("RGB").save(dest, format="JPEG")

    def _collect_control_dirs(self, dataset_dir: Path) -> Dict[str, object]:
        slots: Dict[str, Dict[int, Dict[str, str]]] = {}
        indices: set[int] = set()
        for entry in dataset_dir.iterdir():
            if not entry.is_dir():
                continue
            # 兼容新旧命名规则：
            # 旧格式：control, control1, control2
            # 新格式：{dataset_name}_control1, {dataset_name}_control2
            # 判断是否为 control 文件夹：包含 "control" 且不以 "target" 结尾
            if "control" not in entry.name.lower() or entry.name.endswith("target"):
                continue
            slot_name = entry.name
            slot_files = self._list_indexed_files(entry)
            slots[slot_name] = slot_files
            indices.update(slot_files.keys())
        return {"slots": slots, "combined_indices": indices}

    def _collect_existing_indices(self, dataset_dir: Path) -> set[int]:
        indices: set[int] = set()
        for entry in dataset_dir.iterdir():
            if not entry.is_dir():
                continue
            # 兼容新旧命名规则：
            # 旧格式：target, control, control1, control2
            # 新格式：{dataset_name}_target, {dataset_name}_control1, {dataset_name}_control2
            is_target = entry.name == "target" or entry.name.endswith("_target")
            is_control = entry.name.startswith("control") or "control" in entry.name.lower()
            if not (is_target or is_control):
                continue
            for file in entry.iterdir():
                if not file.is_file():
                    continue
                try:
                    index = int(file.stem)
                except ValueError:
                    continue
                indices.add(index)
        return indices

    def _list_indexed_files(self, folder: Path) -> Dict[int, Dict[str, str]]:
        if not folder.exists() or not folder.is_dir():
            return {}
        mapping: Dict[int, Dict[str, str]] = {}
        for file in sorted(folder.iterdir()):
            if not file.is_file():
                continue
            try:
                index = int(file.stem)
            except ValueError:
                continue
            if file.suffix.lower() == ".txt":
                continue
            relative = str(file.relative_to(self.root)).replace("\\", "/")
            mapping[index] = {
                "path": relative,
                "name": file.name,
                "url": f"/datasets/{relative}",
            }
        return mapping

    def _read_prompt_annotation(self, target_dir: Path, index: int) -> Optional[Dict[str, str]]:
        path = target_dir / f"{index:07d}.txt"
        if not path.exists() or not path.is_file():
            return None
        try:
            text = path.read_text(encoding="utf-8")
        except Exception:  # pylint: disable=broad-except
            return None
        relative = str(path.relative_to(self.root)).replace("\\", "/")
        return {
            "path": relative,
            "name": path.name,
            "url": f"/datasets/{relative}",
            "text": text,
        }
