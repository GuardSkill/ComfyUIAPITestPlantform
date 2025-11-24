# ComfyUI API 测试平台 - AI 助手指南

本文档为 Claude 等 AI 助手提供项目的全面理解，便于快速定位代码、诊断问题和实现新功能。

---

## 项目概述

**ComfyUI API Test Platform** 是一个基于 FastAPI + Python 的 Web 应用，用于批量测试 ComfyUI 工作流。它提供了工作流管理、媒体资源管理、批量任务执行、数据集生成等完整功能。

**核心价值**：
- 自动化 ComfyUI 工作流的批量测试
- 支持图像、视频、音频等多种输入类型
- 提供 Web UI 和 CLI 两种操作方式
- 生成可复用的测试数据集

**技术栈**：
- 后端：FastAPI, Python 3.10+, Requests, WebSocket
- 前端：原生 JavaScript + HTML/CSS（单页应用）
- 存储：本地文件系统（JSON + 媒体文件）

---

## 项目结构速查

```
ComfyUIAPITestPlantform/
├── batch_workflow_tester.py    # 核心执行引擎（CLI + Web共用）
├── util.py                      # 遗留工具函数
├── test_comfyui.py             # 基础测试脚本
├── requirements.txt            # Python依赖
├── start.sh                    # 启动脚本
├── Agent.md                    # 开发笔记（人类视角）
├── CLAUDE.md                   # 本文档（AI助手视角）
│
├── webapp/                     # Web服务核心
│   ├── app.py                  # FastAPI主应用（900行）
│   ├── config.py               # 路径配置
│   ├── workflow_store.py       # 工作流解析与分组
│   ├── workflow_manager.py     # 工作流文件管理
│   ├── media_manager.py        # 媒体资源管理
│   ├── jobs.py                 # 批量任务追踪
│   ├── dataset_jobs.py         # 数据集任务追踪
│   ├── dataset_manager.py      # 数据集生成管理
│   └── static/                 # 前端资源
│       ├── index.html          # 单页应用入口
│       ├── main.js             # 前端逻辑
│       └── styles.css          # 样式
│
├── docs/                       # 文档目录
│   ├── architecture_overview.md    # 架构总览
│   ├── web_ui_guide.md            # Web UI使用指南
│   └── batch_workflow_tester.md   # CLI工具说明
│
├── workflow/                   # 工作流JSON存储（.gitignore）
├── media/                      # 测试素材存储（.gitignore）
├── datasets/                   # 生成的数据集（.gitignore）
└── workflow_test_output/       # 执行输出目录（.gitignore）
```

---

## 核心模块详解

### 1. ComfyUI API 客户端 (`batch_workflow_tester.py`)

**关键类**：`ComfyAPIClient` (58-222行)

**核心职责**：
- 文件上传到 ComfyUI 服务器
- 工作流提交（prompt queue）
- WebSocket 监听执行进度
- 输出结果下载

**重要方法**：
```python
# 上传文件（图片、视频、音频统一使用 /upload/image 接口）
upload_file(path: Path, *, upload_type: Optional[str] = None) -> str

# 执行工作流并等待完成
execute_prompt(prompt: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]

# 下载输出结果
collect_outputs(history: Mapping[str, Any]) -> List[OutputAsset]
```

**关键技术细节**：
- **ComfyUI 上传接口统一性**：所有文件类型（图片、视频、音频）都通过 `/upload/image` 接口上传，不存在 `/upload/video` 或 `/upload/audio` 端点
- **WebSocket 消息监听**：通过 `ws://{server}/ws?clientId={uuid}` 监听执行状态
- **错误处理**：捕获 `execution_error` 消息，提取 `node_errors` 详情

### 2. Web 服务主应用 (`webapp/app.py`)

**文件大小**：900行，包含所有 API 端点

**关键配置** (47-53行)：
```python
# ComfyUI统一使用 /upload/image 接口上传所有类型的文件
UPLOAD_ENDPOINTS = {
    "image": "/upload/image",
    "video": "/upload/image",  # 注意：不是 /upload/video
    "audio": "/upload/image",  # 注意：不是 /upload/audio
    "file": "/upload/image",
}
```

**核心 API 端点分类**：

#### 工作流管理
- `GET /api/workflow-groups` - 获取分组列表
- `GET /api/workflows/{id}` - 获取单个工作流详情
- `GET /api/workflow-tree` - 获取工作流树结构
- `POST /api/workflows/upload` - 批量上传工作流JSON
- `POST /api/workflow-tree/rename` - 重命名工作流
- `POST /api/workflow-tree/delete` - 删除工作流

#### 媒体资源管理
- `GET /api/media` - 列出目录下媒体文件
- `GET /api/media/all` - 获取所有媒体（可按类型过滤）
- `POST /api/media/upload` - 上传媒体文件
- `POST /api/media/create-folder` - 创建文件夹
- `POST /api/media/rename` - 重命名
- `POST /api/media/delete` - 删除

#### 任务执行与追踪
- `POST /api/run-batch` - 提交批量执行任务（核心接口，458-542行）
- `GET /api/jobs` - 获取任务列表
- `GET /api/jobs/{id}` - 获取任务详情
- `GET /api/jobs/{id}/artifacts/{artifact_id}` - 下载输出文件

#### 数据集操作
- `GET /api/datasets` - 列出所有数据集
- `GET /api/datasets/{name}` - 获取数据集详情（输入输出对）
- `POST /api/datasets/run` - 执行数据集生成（核心接口，325-347行）
- `DELETE /api/datasets/{name}` - 删除整个数据集
- `DELETE /api/datasets/{name}/pairs/{index}` - 删除单条数据对
- `PUT /api/datasets/{name}/pairs/{index}/prompt` - 更新数据对提示词

#### 工具类接口
- `POST /api/test-server` - 测试 ComfyUI 服务器连通性
- `GET /api/dataset/workflows` - 获取适合生成数据集的工作流

**关键函数详解**：

##### `upload_media_asset()` (884-899行)
```python
def upload_media_asset(server_url: str, path: Path) -> str:
    """将本地媒体文件上传到 ComfyUI 服务器"""
    media_type = detect_media_type(path)  # 检测文件类型
    endpoint = UPLOAD_ENDPOINTS.get(media_type, UPLOAD_ENDPOINTS["image"])
    url = f"{normalize_server_url(server_url)}{endpoint}"

    with path.open("rb") as handle:
        response = requests.post(url, files={"image": handle}, timeout=60)

    response.raise_for_status()
    data = response.json()
    return data.get("name")  # 返回远程文件名
```

##### `/api/run-batch` 执行流程 (458-542行)
1. 验证分组ID和工作流ID一致性
2. 上传占位符对应的媒体文件到 ComfyUI（带缓存）
3. 创建 Job 记录并生成唯一ID
4. 启动后台线程执行 `BatchWorkflowTester.run_batch()`
5. 保存执行日志和输出结果
6. 更新 Job 状态（running → finished/failed）

##### `/api/datasets/run` 执行流程 (325-347行)
1. 验证工作流适合数据集生成（单输入单输出）
2. 组合占位符路径生成笛卡尔积
3. 为每个组合执行工作流
4. 保存输入控制图和输出结果到 `datasets/{name}/`
5. 生成 `metadata.json` 记录数据集信息
6. 支持追加模式（append=True）延续编号

### 3. 工作流解析与分组 (`webapp/workflow_store.py`)

**核心类**：`WorkflowStore` (50-316行)

**关键功能**：
- 扫描 `workflow/` 目录下的 JSON 文件
- 解析占位符（`{input_image}`, `{input_video}` 等）
- 检测输出节点类型（SaveImage, VHS_VideoCombine 等）
- 根据输入输出签名分组工作流

**占位符检测逻辑** (218-247行)：
```python
def find_placeholders(workflow: Mapping[str, Any]) -> Set[str]:
    """递归查找 JSON 中的 {placeholder} 模式"""
    # 支持格式：
    # - {input_image}
    # - {base_image}
    # - {input_video}
    # - 默认值格式：{input_image|default.png}
```

**输出类型检测** (102-166行)：
```python
# 支持的输出节点类型
OUTPUT_NODE_CLASSES = {
    "SaveImage": "image",
    "VHS_VideoCombine": "video",
    "SaveAnimatedWEBP": "image",
    "ADE_AnimateDiffCombine": "video",
    # ... 更多节点类型
}
```

**分组哈希算法** (167-187行)：
```python
def compute_workflow_signature(info: WorkflowInfo) -> str:
    """生成工作流签名：输入占位符 + 输出类型"""
    placeholders_sorted = sorted(info.placeholders)
    outputs_sorted = sorted(info.output_types)
    combined = f"{placeholders_sorted}:{outputs_sorted}"
    return hashlib.sha256(combined.encode()).hexdigest()[:16]
```

### 4. 媒体资源管理 (`webapp/media_manager.py`)

**核心类**：`MediaManager` (19-142行)

**文件类型检测** (8-17行)：
```python
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".gif"}
AUDIO_EXTENSIONS = {".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a"}

def detect_media_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in IMAGE_EXTENSIONS: return "image"
    if suffix in VIDEO_EXTENSIONS: return "video"
    if suffix in AUDIO_EXTENSIONS: return "audio"
    return "file"
```

**安全检查**：
- 路径遍历防护：确保所有操作在 `media/` 根目录下
- 文件名清理：使用 `Path.name` 防止路径注入

### 5. 数据集管理 (`webapp/dataset_manager.py`)

**核心类**：`DatasetManager` (27-292行)

**数据集结构**：
```
datasets/
└── {dataset_name}/
    ├── metadata.json          # 元数据（工作流ID、占位符、提示词覆盖等）
    ├── control_{slot}/        # 输入素材目录
    │   ├── 000000.jpg
    │   └── 000001.jpg
    └── output/                # 输出结果目录
        ├── 000000.png
        └── 000001.png
```

**追加模式支持** (128-150行)：
- 读取现有 `metadata.json` 获取 `total_runs`
- 从现有编号继续生成新数据对
- 保留原有占位符和提示词配置

---

## 常见任务操作指南

### 添加新的输出节点类型支持

**文件**：`webapp/workflow_store.py`
**位置**：102-166行的 `OUTPUT_NODE_CLASSES` 字典

```python
OUTPUT_NODE_CLASSES = {
    "YourNewNodeClass": "image",  # 或 "video", "audio"
}
```

### 修复 ComfyUI API 接口问题

**常见问题**：405 Method Not Allowed

**原因**：ComfyUI 只有 `/upload/image` 接口，没有 `/upload/video` 或 `/upload/audio`

**修复位置**：
1. `webapp/app.py:47-53` - 修改 `UPLOAD_ENDPOINTS` 配置
2. `batch_workflow_tester.py:90-93` - 修改 `_guess_upload_type()` 方法

### 添加新的 API 端点

**文件**：`webapp/app.py`

**步骤**：
1. 定义 Pydantic 模型（如果需要请求体验证）
2. 添加路由装饰器和处理函数
3. 使用 `HTTPException` 处理错误
4. 返回序列化的 JSON 响应

**示例**：
```python
@app.get("/api/your-endpoint")
async def your_handler() -> Dict[str, Any]:
    try:
        # 你的逻辑
        return {"success": True, "data": ...}
    except Exception as e:
        LOG.exception("操作失败")
        raise HTTPException(status_code=500, detail=str(e))
```

### 调试工作流执行失败

**检查清单**：
1. 查看 Job 日志：`GET /api/jobs/{id}` 返回的 `log` 字段
2. 检查 ComfyUI 服务器连接：`POST /api/test-server`
3. 验证占位符映射：Job 的 `placeholders` 字段
4. 查看 `node_errors`：执行失败时包含具体节点错误

**日志位置**：
- Web 端：Job 对象的 `log` 字段（内存存储）
- CLI 端：控制台输出 + `workflow_test_output/` 目录

### 添加新的媒体类型

**步骤**：
1. 在 `webapp/media_manager.py:8-17` 添加扩展名
2. 在 `webapp/app.py:46` 更新 `AUDIO_EXTENSIONS`（如果是音频）
3. 前端 `main.js` 的 `openMediaSelector()` 中添加类型过滤逻辑

---

## 重要技术细节

### ComfyUI API 通信协议

**HTTP 接口**：
- `POST /upload/image` - 上传文件（参数：`files={"image": file_handle}`）
- `POST /prompt` - 提交工作流（JSON body: `{"prompt": {...}, "client_id": "uuid"}`）
- `GET /history/{prompt_id}` - 获取执行历史
- `GET /view` - 下载输出文件（参数：`filename`, `subfolder`, `type`）

**WebSocket 接口**：
- 连接：`ws://{server}/ws?clientId={uuid}`
- 消息类型：
  - `{"type": "executing", "data": {"node": null}}` - 执行完成
  - `{"type": "execution_error", "data": {"node_errors": {...}}}` - 执行失败
  - `{"type": "progress", "data": {"value": 50, "max": 100}}` - 进度更新

### 工作流占位符替换机制

**输入格式**：
```json
{
  "node_id": {
    "inputs": {
      "image": "{input_image}"
    }
  }
}
```

**替换后**：
```json
{
  "node_id": {
    "inputs": {
      "image": "uploaded_filename.png"  // 远程文件名
    }
  }
}
```

**实现位置**：
- CLI：`batch_workflow_tester.py:380-394` (`replace_placeholders_inplace`)
- Web：`app.py:481-499` （上传后传入远程文件名）

### 前端与后端交互流程

**批量测试流程**：
```
1. 用户选择分组 → GET /api/workflow-groups
2. 配置占位符 → GET /api/media/all?type=image
3. 上传媒体文件 → POST /api/media/upload
4. 提交任务 → POST /api/run-batch
   ├─ 后端上传媒体到 ComfyUI
   ├─ 创建 Job 记录
   └─ 启动后台线程执行
5. 轮询状态 → GET /api/jobs（每2秒）
6. 下载结果 → GET /api/jobs/{id}/artifacts/{artifact_id}
```

**数据集生成流程**：
```
1. 选择工作流 → GET /api/dataset/workflows
2. 配置占位符 → 多选媒体文件
3. 提交生成 → POST /api/datasets/run
   ├─ 组合笛卡尔积
   ├─ 逐个执行工作流
   ├─ 保存到 datasets/{name}/
   └─ 生成 metadata.json
4. 查看结果 → GET /api/datasets/{name}
```

### 错误处理策略

**ComfyAPI 层** (`batch_workflow_tester.py`)：
- 抛出 `ComfyAPIError` 异常
- 捕获 HTTP 错误和 WebSocket 错误
- 提取 `node_errors` 详情

**FastAPI 层** (`webapp/app.py`)：
- 使用 `HTTPException` 返回标准错误响应
- 日志记录：`LOG.exception()` 输出堆栈
- 400：客户端错误（参数校验失败）
- 500：服务器错误（执行失败）

**前端层** (`main.js`)：
- `try-catch` 包裹所有 `fetch()` 调用
- `response.ok` 检查 HTTP 状态
- 显示 `alert()` 或 DOM 错误提示

---

## 调试技巧

### 启用详细日志

**方法1：修改日志级别**
```python
# webapp/app.py 或 batch_workflow_tester.py
import logging
logging.basicConfig(level=logging.DEBUG)
```

**方法2：查看 Uvicorn 日志**
```bash
uvicorn webapp.app:app --host 0.0.0.0 --port 8000 --log-level debug
```

### 测试 ComfyUI 连接

**CLI 测试**：
```python
from batch_workflow_tester import ComfyAPIClient
client = ComfyAPIClient("http://127.0.0.1:8188")
print(client._get_history("test"))  # 应返回空字典或历史记录
```

**Web 测试**：
```bash
curl -X POST http://localhost:8000/api/test-server \
  -H "Content-Type: application/json" \
  -d '{"server_url": "http://127.0.0.1:8188"}'
```

### 检查工作流分组

**方法1：API 查询**
```bash
curl http://localhost:8000/api/workflow-groups | jq
```

**方法2：直接调用**
```python
from webapp.workflow_store import WorkflowStore
store = WorkflowStore("workflow/")
groups = store.list_workflow_groups()
print(groups)
```

### 验证占位符解析

```python
from webapp.workflow_store import WorkflowStore
import json

with open("workflow/your_workflow.json") as f:
    workflow = json.load(f)

placeholders = WorkflowStore.find_placeholders(workflow)
print(f"找到占位符：{placeholders}")
```

---

## 代码规范与最佳实践

### Python 编码规范
- 使用 Type Hints（`Path`, `Dict[str, Any]`, `Optional[str]` 等）
- 函数和类使用 docstring 注释（支持中文）
- 异常处理：优先使用具体异常类型（`FileNotFoundError`, `ValueError`）
- 日志记录：使用 `LOG.debug/info/warning/exception`

### API 设计原则
- RESTful 风格：GET 查询，POST 创建，PUT/PATCH 更新，DELETE 删除
- 统一错误格式：`{"detail": "错误信息"}`
- 返回结构化数据：使用 Pydantic 模型或字典
- 状态码：200（成功），201（创建），400（客户端错误），500（服务器错误）

### 前端代码风格
- 异步操作使用 `async/await`
- DOM 操作集中在 `main.js` 中的独立函数
- 使用 `data-*` 属性存储元数据（如 `data-workflow-id`）
- 事件委托：使用 `event.target.closest()` 处理动态元素

---

## 常见问题 FAQ

### Q: 为什么视频上传报 405 错误？
**A**: ComfyUI 只有 `/upload/image` 接口，统一处理所有文件类型。确保 `UPLOAD_ENDPOINTS` 配置正确：
```python
UPLOAD_ENDPOINTS = {
    "video": "/upload/image",  # 不是 /upload/video
}
```

### Q: 工作流分组为什么不正确？
**A**: 检查占位符和输出节点解析：
- 占位符格式必须是 `{input_*}`
- 输出节点类型必须在 `OUTPUT_NODE_CLASSES` 中注册
- 签名算法基于输入+输出，任一变化都会产生新分组

### Q: 数据集生成失败但没有错误信息？
**A**: 检查以下几点：
1. 工作流是否适合数据集生成（`is_suitable_for_dataset` 检查）
2. 媒体文件路径是否存在（`media_manager.resolve_path`）
3. ComfyUI 服务器是否运行正常
4. 查看后台日志：`dataset_jobs.py` 中的 `LOG` 输出

### Q: 如何支持新的 ComfyUI 自定义节点？
**A**:
1. 如果是输出节点：在 `workflow_store.py:OUTPUT_NODE_CLASSES` 添加映射
2. 如果是输入节点：无需修改，占位符替换机制自动支持
3. 如果需要特殊处理：在 `batch_workflow_tester.py` 扩展逻辑

### Q: 前端轮询任务状态太频繁？
**A**: 修改 `main.js` 中的 `pollJobStatus()` 函数：
```javascript
const pollInterval = setInterval(async () => {
    // 逻辑
}, 2000);  // 修改这个值（毫秒）
```

---

## 扩展开发指南

### 添加新的存储后端（如 S3/OSS）

**修改模块**：
1. `webapp/media_manager.py` - 实现新的存储接口
2. `webapp/dataset_manager.py` - 适配数据集存储
3. `batch_workflow_tester.py` - 下载逻辑支持远程URL

**关键接口**：
```python
class StorageBackend:
    def save(self, path: str, data: bytes) -> str:
        """保存文件并返回访问URL"""
        pass

    def load(self, path: str) -> bytes:
        """读取文件内容"""
        pass
```

### 添加用户认证

**推荐方案**：FastAPI + JWT

**修改点**：
1. `webapp/app.py` - 添加认证中间件
2. 前端 - 在 `fetch()` 中添加 `Authorization` 头
3. 数据模型 - 添加 `user_id` 字段到 Job 和 Dataset

### 支持工作流版本控制

**设计思路**：
1. `workflow/` 目录下添加 `.meta` 文件记录版本
2. `workflow_store.py` 解析版本信息
3. API 接口返回版本列表和历史记录
4. 前端显示版本选择器

---

## 性能优化建议

### 后端优化
- **异步化**：将 `requests` 替换为 `httpx` 或 `aiohttp`
- **任务队列**：使用 Celery 或 RQ 替代后台线程
- **缓存**：使用 Redis 缓存工作流分组和媒体列表
- **数据库**：使用 SQLite/PostgreSQL 替代内存存储 Job

### 前端优化
- **虚拟滚动**：大量媒体文件时使用虚拟列表
- **懒加载**：缩略图按需加载（Intersection Observer）
- **WebSocket**：实时更新任务状态，替代轮询
- **Service Worker**：缓存静态资源

### 文件系统优化
- **目录分片**：媒体文件超过1000个时按首字母分目录
- **缩略图预生成**：上传时自动生成小尺寸预览图
- **清理策略**：定期删除过期的输出文件

---

## 总结

本项目采用简洁的架构设计，核心模块职责清晰，适合快速迭代和功能扩展。关键要点：

1. **统一的上传接口**：ComfyUI 只有 `/upload/image`
2. **工作流分组机制**：基于输入输出签名的哈希
3. **前后端分离**：FastAPI 提供 RESTful API，前端纯静态页面
4. **本地文件存储**：简单可靠，适合中小规模测试
5. **错误处理完善**：多层异常捕获和日志记录

遇到问题时，优先查看：
- Job 日志（`/api/jobs/{id}`）
- ComfyUI 服务器连接（`/api/test-server`）
- 工作流分组信息（`/api/workflow-groups`）
- 浏览器控制台（Network 和 Console 标签）

祝你高效地协助用户完成开发任务！
