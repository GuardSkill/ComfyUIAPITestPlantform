# 项目架构总览

本项目围绕 ComfyUI 工作流批量测试需求构建，划分为四个主要层次：命令行工具、Web 服务端、前端界面以及测试资源/配置。整体流程如下：

1. **工作流发现与分组**  
   `webapp/workflow_store.py` 扫描 `workflow/` 目录下的 JSON，提取占位符与输出节点，生成「输入签名 + 输出签名」的哈希分组。只有同组工作流允许在前端被批量勾选。

2. **媒体资源管理**  
   `webapp/media_manager.py` 针对 `media/` 目录提供安全的文件操作（遍历、创建、上传、重命名），并新增 `list_all_files` 支持按类型拉取全局素材。前端所有占位符配置均基于此目录。

3. **批量任务执行管线**  
   `webapp/app.py` FastAPI 服务暴露的核心接口：
   - `/api/workflow-groups`：刷新工作流分组；
   - `/api/workflow-tree`、`/api/workflows/upload`、`/api/workflow-tree/rename`、`/api/workflow-tree/delete`：管理工作流目录树，支持批量上传、重命名、删除和树状浏览；
   - `/api/media`、`/api/media/all`、`/api/media/*`：媒体目录 CRUD + 全局素材列表；
   - `/api/test-server`：探测 ComfyUI 服务可达性；
   - `/api/run-batch`：校验分组与占位符后，**自动将所选图像/视频/音频上传至 ComfyUI**，并将返回的远端文件名缓存进任务；随后触发后台执行；
   - `/api/jobs/*` 与 `/api/jobs/{id}/artifacts/{artifact_id}`：查询任务状态、日志、占位符映射、产出物列表并下载图像/视频结果；
   - `/api/dataset/workflows`、`/api/datasets/*`：支持数据集批量生成、列表、详情及删除（含单条输入/输出对的删除）。
   后台通过 `webapp/jobs.JobManager` 与新增的 `webapp/dataset_manager.DatasetManager` 维护批量任务及数据集产出物。

4. **用户界面**  
   `webapp/static/index.html` + `main.js` + `styles.css` 构成单页应用：
   - “工作流管理”树：自动拉取 `workflow/` 目录，可批量上传（时间戳子目录）、重命名、删除、目录/文件多选，并与分组选择联动；
   - “批量测试”面板：分组列表、占位符配置、工作流勾选、服务器连通性测试；
   - “数据集制作”分页：选择工作流、多选输入素材、批量运行生成 `datasets/` 目录，并提供数据集列表、对比预览及删除；
   - “媒体素材管理”分页：目录浏览、上传、预览、删除；
   - “运行结果”分页：轮询 `/api/jobs` 展示执行状态、错误详情、日志及按工作流分组的图像/视频预览；
   - 媒体选择弹窗支持本地上传 + 缩略图预览，并按占位符类型过滤候选素材。

5. **底层执行器**  
   `batch_workflow_tester.py` 负责与 ComfyUI API 通信，复用 CLI 和 Web 输入流程。Web 端将上传后的远端文件名传入占位符，保持执行逻辑与 CLI 一致。

## 模块依赖

```text
FastAPI (webapp/app.py) ──使用──▶ WorkflowStore / MediaManager / JobManager
                                  │
                                  └──▶ batch_workflow_tester (执行 ComfyUI 任务)

前端 main.js ──请求──▶ FastAPI 接口
媒体资源 ──落地──▶ media/ 目录
工作流 JSON ──存放──▶ workflow/ 目录
输出结果 ──默认──▶ workflow_test_output/
```

## 运行路径

1. `uvicorn webapp.app:app --host 0.0.0.0 --port 8000 --reload` 启动服务；
2. 浏览器访问 `/`，选择分组 → 配置占位符 → 勾选工作流 → 提交任务；
3. 后台任务完成后，可在任务队列查看状态，并在输出目录检查生成的图像或视频。

该架构支持在 Linux 环境下快速部署，并保持后续扩展（添加新占位符类型、输出类型或接入其他存储）的灵活性。
