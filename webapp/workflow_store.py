from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, MutableMapping, Optional, Sequence, Tuple


PlaceholderUsage = Tuple[str, Tuple[str, ...]]

MEDIA_TYPE_LABELS: Dict[str, str] = {
    "image": "图像",
    "video": "视频",
    "audio": "音频",
    "gif": "动图",
    "text": "文本",
    "file": "文件",
}


@dataclass(frozen=True)
class PlaceholderInfo:
    name: str
    media_type: str


@dataclass
class WorkflowInfo:
    identifier: str
    name: str
    path: Path
    placeholders: List[PlaceholderInfo] = field(default_factory=list)
    output_types: List[str] = field(default_factory=list)

    @property
    def input_signature(self) -> Tuple[Tuple[str, str], ...]:
        return tuple(sorted((placeholder.name, placeholder.media_type) for placeholder in self.placeholders))

    @property
    def output_signature(self) -> Tuple[str, ...]:
        return tuple(sorted(self.output_types))


@dataclass
class WorkflowGroup:
    identifier: str
    input_signature: Tuple[Tuple[str, str], ...]
    output_signature: Tuple[str, ...]
    workflows: List[WorkflowInfo]

    @property
    def label(self) -> str:
        input_counts = self._count_by_type(self.input_signature)
        output_counts = self._count_by_type(tuple((item, item_type) for item_type in self.output_signature for item in [item_type]))

        input_label = self._render_counts(input_counts, default="无输入")
        output_label = self._render_counts(output_counts, default="未检测")
        return f"输入：{input_label} 输出：{output_label}"

    @staticmethod
    def _count_by_type(items: Tuple[Tuple[str, str], ...]) -> Dict[str, int]:
        counts: Dict[str, int] = {}
        for _, media_type in items:
            counts[media_type] = counts.get(media_type, 0) + 1
        return counts

    @staticmethod
    def _render_counts(counts: Mapping[str, int], *, default: str) -> str:
        if not counts:
            return default
        labels = []
        for media_type in sorted(counts):
            label = MEDIA_TYPE_LABELS.get(media_type, media_type)
            labels.append(f"{counts[media_type]}{label}")
        return "、".join(labels)


class WorkflowStore:
    def __init__(self, root: Path):
        self.root = root
        self._workflows: Dict[str, WorkflowInfo] = {}
        self._groups: Dict[str, WorkflowGroup] = {}
        self.refresh()

    # --------------------------------------------------------------------- API
    def refresh(self) -> None:
        self._workflows.clear()
        if not self.root.exists():
            return
        for path in sorted(self.root.rglob("*.json")):
            info = self._inspect(path)
            if info is None:
                continue
            self._workflows[info.identifier] = info
        self._rebuild_groups()

    def list_groups(self) -> List[WorkflowGroup]:
        return sorted(self._groups.values(), key=lambda group: group.label)

    def get_group(self, identifier: str) -> Optional[WorkflowGroup]:
        return self._groups.get(identifier)

    def get_workflow(self, identifier: str) -> Optional[WorkflowInfo]:
        return self._workflows.get(identifier)

    def list_workflows(self) -> List[WorkflowInfo]:
        return sorted(self._workflows.values(), key=lambda info: info.identifier)

    # ------------------------------------------------------------ internal
    def _rebuild_groups(self) -> None:
        grouped: Dict[Tuple[Tuple[Tuple[str, str], ...], Tuple[str, ...]], List[WorkflowInfo]] = {}
        for info in self._workflows.values():
            key = (info.input_signature, info.output_signature)
            grouped.setdefault(key, []).append(info)

        self._groups.clear()
        for (input_signature, output_signature), items in grouped.items():
            signature_blob = json.dumps({"inputs": input_signature, "outputs": output_signature}, ensure_ascii=False, sort_keys=True)
            identifier = hashlib.sha1(signature_blob.encode("utf-8")).hexdigest()[:12]
            self._groups[identifier] = WorkflowGroup(identifier=identifier, input_signature=input_signature, output_signature=output_signature, workflows=sorted(items, key=lambda info: info.name))

    def _inspect(self, path: Path) -> Optional[WorkflowInfo]:
        try:
            with path.open("r", encoding="utf-8") as handle:
                workflow: MutableMapping[str, Any] = json.load(handle)  # type: ignore[assignment]
        except Exception:
            return None

        placeholders = self._collect_placeholders(workflow)
        placeholder_infos = [
            PlaceholderInfo(name=name, media_type=self._infer_media_type(name, usages))
            for name, usages in sorted(placeholders.items())
        ]
        output_types = sorted(self._infer_output_types(workflow))
        identifier = str(path.relative_to(self.root))
        name = path.stem

        return WorkflowInfo(
            identifier=identifier,
            name=name,
            path=path,
            placeholders=placeholder_infos,
            output_types=output_types,
        )

    def _collect_placeholders(self, workflow: MutableMapping[str, Any]) -> Dict[str, List[PlaceholderUsage]]:
        collected: Dict[str, List[PlaceholderUsage]] = {}
        placeholder_pattern = re.compile(r"^\{?(input_[^{}]+)\}?$")
        for node_id, raw_node in workflow.items():
            if not isinstance(raw_node, MutableMapping):
                continue
            class_type = str(raw_node.get("class_type", ""))
            for path_keys, value in self._iter_paths(raw_node):
                if isinstance(value, str):
                    match = placeholder_pattern.match(value)
                    if not match:
                        continue
                    placeholder = match.group(1)
                    normalized = f"{{{placeholder}}}"
                    collected.setdefault(normalized, []).append((class_type, path_keys))
        return collected

    def _iter_paths(self, obj: Any, prefix: Tuple[str, ...] = ()) -> Iterable[Tuple[Tuple[str, ...], Any]]:
        if isinstance(obj, MutableMapping):
            for key, value in obj.items():
                yield from self._iter_paths(value, prefix + (str(key),))
        elif isinstance(obj, list):
            for index, value in enumerate(obj):
                yield from self._iter_paths(value, prefix + (str(index),))
        else:
            yield prefix, obj

    def _infer_media_type(self, name: str, usages: Sequence[PlaceholderUsage]) -> str:
        lowered_name = name.strip("{}").lower()
        if "video" in lowered_name:
            return "video"
        if "audio" in lowered_name or "sound" in lowered_name:
            return "audio"
        if "mask" in lowered_name:
            return "image"
        if "text" in lowered_name:
            return "text"

        for class_type, path_keys in usages:
            lowered_class = class_type.lower()
            path_label = ".".join(path_keys).lower()
            if "video" in lowered_class or "video" in path_label:
                return "video"
            if "audio" in lowered_class or "audio" in path_label or "sound" in lowered_class:
                return "audio"
            if "mask" in lowered_class or "mask" in path_label:
                return "image"
            if "text" in lowered_class or "prompt" in path_label:
                return "text"
            if "image" in lowered_class or "image" in path_label:
                return "image"

        return "file"

    def _infer_output_types(self, workflow: MutableMapping[str, Any]) -> List[str]:
        detected: set[str] = set()
        for raw_node in workflow.values():
            if not isinstance(raw_node, MutableMapping):
                continue
            class_type = str(raw_node.get("class_type", ""))
            inputs = raw_node.get("inputs")
            if not isinstance(inputs, Mapping):
                continue
            if "filename_prefix" not in inputs and not inputs.get("save_output"):
                continue
            media_type = self._output_type_from_class(class_type, inputs)
            if media_type:
                detected.add(media_type)
        return sorted(detected)

    def _output_type_from_class(self, class_type: str, inputs: Mapping[str, Any]) -> Optional[str]:
        lowered = class_type.lower()
        if "video" in lowered or "video" in json.dumps(inputs, ensure_ascii=False).lower():
            return "video"
        if "image" in lowered:
            return "image"
        if "audio" in lowered:
            return "audio"
        if "gif" in lowered:
            return "gif"
        if "text" in lowered:
            return "text"
        return None
