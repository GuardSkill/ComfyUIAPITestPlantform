from __future__ import annotations

import mimetypes
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional


@dataclass
class MediaEntry:
    name: str
    path: str
    is_dir: bool
    size: Optional[int] = None
    mime_type: Optional[str] = None
    media_type: Optional[str] = None


class MediaManager:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ helpers
    def _resolve(self, relative_path: str = "") -> Path:
        safe_relative = Path(relative_path)
        if safe_relative.is_absolute():
            raise ValueError("路径必须是相对于媒体根目录的相对路径")
        target = (self.root / safe_relative).resolve()
        if self._is_outside_root(target):
            raise ValueError("禁止访问媒体目录以外的路径")
        return target

    def _is_outside_root(self, path: Path) -> bool:
        try:
            path.relative_to(self.root.resolve())
        except ValueError:
            return True
        return False

    def _entry_from_path(self, path: Path) -> MediaEntry:
        relative = path.relative_to(self.root)
        if path.is_dir():
            return MediaEntry(name=path.name, path=str(relative), is_dir=True, size=None, mime_type=None)
        size = path.stat().st_size
        mime_type, _ = mimetypes.guess_type(path.name)
        return MediaEntry(
            name=path.name,
            path=str(relative),
            is_dir=False,
            size=size,
            mime_type=mime_type,
            media_type=self._guess_media_type(path),
        )

    def resolve_path(self, relative_path: str) -> Path:
        return self._resolve(relative_path)

    # ---------------------------------------------------------------- directory
    def list_directory(self, relative_path: str = "") -> Dict[str, List[MediaEntry]]:
        target = self._resolve(relative_path)
        if not target.exists():
            target.mkdir(parents=True, exist_ok=True)
        if not target.is_dir():
            raise ValueError("目标路径不是文件夹")

        directories: List[MediaEntry] = []
        files: List[MediaEntry] = []
        for entry in sorted(target.iterdir(), key=lambda item: item.name.lower()):
            media_entry = self._entry_from_path(entry)
            if media_entry.is_dir:
                directories.append(media_entry)
            else:
                files.append(media_entry)
        return {"directories": directories, "files": files}

    # ----------------------------------------------------------------- mutating
    def create_folder(self, parent: str, name: str) -> MediaEntry:
        sanitized = Path(name).name
        if not sanitized:
            raise ValueError("文件夹名称不能为空")
        target_dir = self._resolve(parent) / sanitized
        target_dir.mkdir(parents=False, exist_ok=False)
        return self._entry_from_path(target_dir)

    def save_file(self, parent: str, filename: str, data: bytes, *, overwrite: bool = False) -> MediaEntry:
        sanitized = Path(filename).name
        if not sanitized:
            raise ValueError("文件名不能为空")
        target_dir = self._resolve(parent)
        target_dir.mkdir(parents=True, exist_ok=True)
        target_file = target_dir / sanitized
        if target_file.exists() and not overwrite:
            raise FileExistsError("目标文件已存在")
        target_file.write_bytes(data)
        return self._entry_from_path(target_file)

    def rename(self, relative_path: str, new_name: str) -> MediaEntry:
        target = self._resolve(relative_path)
        sanitized = Path(new_name).name
        if not sanitized:
            raise ValueError("新名称不能为空")
        destination = target.with_name(sanitized)
        if destination.exists():
            raise FileExistsError("已存在同名文件或文件夹")
        shutil.move(str(target), str(destination))
        return self._entry_from_path(destination)

    def delete(self, relative_path: str) -> None:
        target = self._resolve(relative_path)
        if target == self.root:
            raise ValueError("禁止删除媒体根目录")
        if not target.exists():
            raise FileNotFoundError("目标不存在")
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink()

    def list_all_files(self, media_type: Optional[str] = None) -> List[MediaEntry]:
        entries: List[MediaEntry] = []
        target_type = (media_type or "").lower() or None
        for path in sorted(self.root.rglob("*")):
            if not path.is_file():
                continue
            entry = self._entry_from_path(path)
            if target_type and entry.media_type != target_type:
                continue
            entries.append(entry)
        return entries

    def _guess_media_type(self, path: Path) -> Optional[str]:
        suffix = path.suffix.lower()
        if suffix in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}:
            return "image"
        if suffix in {".mp4", ".mov", ".avi", ".mkv", ".webm", ".gif"}:
            return "video"
        if suffix in {".mp3", ".wav", ".flac", ".aac", ".ogg"}:
            return "audio"
        return None
