# ComfyUI 批量测试平台工作笔记

## 核心功能概览
- **批量执行引擎**：`batch_workflow_tester.py` 统一封装上传输入、排队执行、下载输出、写入元数据；对 ComfyUI 的 HTTP/WebSocket 交互均做了错误捕获（`ComfyAPIError`），日志与前端弹窗会显示详细的 `node_errors`。
- **Web 服务 (`webapp/app.py`)**：FastAPI 提供工作流分组、媒体库 CRUD、工作流树管理、任务提交/状态查询、产出物下载等接口；执行前自动将所选图像/视频/音频上传到 ComfyUI 并缓存远端文件名。
- **前端 UI (`webapp/static/`)**：
  - “工作流管理”树支持批量上传（自动创建时间戳子目录）、多选、重命名、删除、空文件夹勾选，以及与分组联动。
  - “占位符配置”支持按类型过滤的媒体弹窗，可直接上传本地素材，图像/视频缩略图即时预览。
  - “运行结果”按工作流展示输出列表，内置图像/视频预览、错误详情和执行日志。
  - “媒体素材管理”列表提供缩略图展示、重命名、删除与可关闭的预览窗口；批量测试面板新增“一键取消选择”操作。
- **文档**：`docs/architecture_overview.md` 描述整体架构、接口与数据流；`docs/web_ui_guide.md` 给出启动步骤与页面操作指南。

## 目录说明
- `webapp/`：后端与辅助模块
  - `config.py`：路径常量（workflow/media/output）。
  - `workflow_store.py`：解析工作流 JSON，提取 `{input_*}` 占位符和输出签名。
  - `workflow_manager.py`：工作流树的上传/重命名/删除/遍历。
  - `media_manager.py`：媒体目录文件操作。
  - `jobs.py`：任务状态、日志与产出物记录。
  - `static/`：前端 HTML/CSS/JS。
- `batch_workflow_tester.py`：CLI 与 Web 共用的批量执行脚本。
- `docs/`：架构与使用文档。
- `media/`：测试素材目录（前端可管理，提交时忽略）。
- `workflow/`：工作流 JSON 目录（含自动上传的时间戳子目录，提交时忽略）。
- `workflow_test_output/`：执行产出目录（提交时忽略）。
