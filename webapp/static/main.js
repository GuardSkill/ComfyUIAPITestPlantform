const state = {
  groups: [],
  selectedGroupId: null,
  selectedWorkflows: new Set(),
  assignments: {},
  mediaPath: "",
  currentPlaceholder: null,
  modalPlaceholderType: null,
  jobs: [],
  jobPoller: null,
  activeTab: "workflows",
  workflowTree: null,
  workflowNodeMeta: new Map(),
  expandedTreeNodes: new Set(),
  selectedTreeNodes: new Set(),
  treeActivePath: null,
};

const MODAL_EMPTY_TEXT = "暂无可用媒体，请先在媒体素材管理页上传。";
const TREE_ROOT_KEY = "__root__";

const refs = {
  groupList: document.getElementById("group-list"),
  workflowTitle: document.getElementById("workflow-title"),
  workflowList: document.getElementById("workflow-list"),
  placeholderList: document.getElementById("placeholder-list"),
  placeholderTip: document.getElementById("placeholder-tip"),
  runButton: document.getElementById("run-batch"),
  serverInput: document.getElementById("server-url"),
  outputInput: document.getElementById("output-dir"),
  tabButtons: document.querySelectorAll(".tab-button"),
  tabContents: document.querySelectorAll(".tab-content"),
  mediaFolders: document.getElementById("media-folders"),
  mediaFiles: document.getElementById("media-files"),
  mediaPath: document.getElementById("media-path"),
  mediaUpButton: document.getElementById("media-up"),
  uploadForm: document.getElementById("upload-form"),
  uploadInput: document.getElementById("upload-file"),
  createFolderForm: document.getElementById("create-folder-form"),
  newFolderInput: document.getElementById("new-folder-name"),
  preview: document.getElementById("preview"),
  previewContent: document.getElementById("preview-content"),
  toast: document.getElementById("toast"),
  refreshGroups: document.getElementById("refresh-groups"),
  testServer: document.getElementById("test-server"),
  resultsTableBody: document.getElementById("results-table-body"),
  overlay: document.getElementById("overlay"),
  mediaModal: document.getElementById("media-modal"),
  modalPlaceholder: document.getElementById("modal-placeholder"),
  modalPlaceholderType: document.getElementById("modal-placeholder-type"),
  modalMediaGrid: document.getElementById("modal-media-grid"),
  modalMediaEmpty: document.getElementById("modal-media-empty"),
  modalUploadButton: document.getElementById("modal-upload-btn"),
  modalUploadInput: document.getElementById("modal-upload-input"),
  resultsModal: document.getElementById("results-modal"),
  resultsModalContent: document.getElementById("results-modal-content"),
  workflowTree: document.getElementById("workflow-tree"),
  workflowUploadInput: document.getElementById("workflow-upload-input"),
  workflowUploadButton: document.getElementById("workflow-upload-btn"),
  workflowRenameButton: document.getElementById("workflow-rename-btn"),
  workflowDeleteButton: document.getElementById("workflow-delete-btn"),
  workflowTreeRefresh: document.getElementById("workflow-tree-refresh"),
};

function updateOverlayVisibility() {
  const shouldShow = !refs.mediaModal.classList.contains("hidden") || !refs.resultsModal.classList.contains("hidden");
  if (shouldShow) {
    refs.overlay.classList.remove("hidden");
  } else {
    refs.overlay.classList.add("hidden");
  }
}

async function fetchJSON(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const detail = await safeJson(response);
    const message = detail?.detail || response.statusText;
    throw new Error(message);
  }
  return response.json();
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function showToast(message, duration = 2400) {
  refs.toast.textContent = message;
  refs.toast.classList.remove("hidden");
  setTimeout(() => {
    refs.toast.classList.add("hidden");
  }, duration);
}

function formatTime(timestamp) {
  if (!timestamp) {
    return "-";
  }
  const date = new Date(timestamp * 1000);
  return date.toLocaleString();
}

function formatMediaTypeLabel(mediaType) {
  switch (mediaType) {
    case "image":
      return "图像";
    case "video":
      return "视频";
    case "audio":
      return "音频";
    default:
      return mediaType || "";
  }
}

function resolveMediaUrl(entry) {
  if (!entry || entry.is_dir) {
    return "";
  }
  const raw = entry.url || `/media/${entry.path.replace(/\\/g, "/")}`;
  return encodeURI(raw);
}

function extractErrorDetail(raw) {
  if (!raw || typeof raw !== "string") {
    return null;
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    const jsonText = raw.slice(start, end + 1);
    try {
      return JSON.parse(jsonText);
    } catch (error) {
      return null;
    }
  }
  return null;
}

function renderErrorDetail(parent, rawError) {
  if (!rawError) {
    return;
  }
  const block = document.createElement("div");
  block.className = "error-block";
  const title = document.createElement("strong");
  title.textContent = "错误信息";
  block.appendChild(title);
  const detail = extractErrorDetail(rawError);
  const pre = document.createElement("pre");
  pre.className = "error-pre";
  if (detail) {
    pre.textContent = JSON.stringify(detail, null, 2);
  } else {
    pre.textContent = rawError;
  }
  block.appendChild(pre);
  parent.appendChild(block);
}

function getNodeKey(node) {
  const path = node.path || "";
  return path ? path : TREE_ROOT_KEY;
}

function indexWorkflowTree(root) {
  const metaMap = new Map();

  const walk = (node, parentKey) => {
    const key = getNodeKey(node);
    const meta = {
      node,
      parent: parentKey,
      files: [],
    };
    if (node.is_dir) {
      (node.children || []).forEach((child) => {
        const childMeta = walk(child, key);
        meta.files.push(...childMeta.files);
      });
    } else if (node.workflow && node.path) {
      meta.files.push(node.path);
    }
    if (!node.is_dir && !meta.files.length && node.path) {
      meta.files.push(node.path);
    }
    if (node.is_dir && node.path) {
      meta.files.push(node.path);
    }
    metaMap.set(key, meta);
    if (node.path) {
      metaMap.set(node.path, meta);
    }
    return meta;
  };

  walk(root, null);
  state.workflowNodeMeta = metaMap;
  if (!state.expandedTreeNodes.size) {
    state.expandedTreeNodes.add(TREE_ROOT_KEY);
    (root.children || []).forEach((child) => {
      if (child.is_dir) {
        state.expandedTreeNodes.add(getNodeKey(child));
      }
    });
  } else if (!state.expandedTreeNodes.has(TREE_ROOT_KEY)) {
    state.expandedTreeNodes.add(TREE_ROOT_KEY);
  }

  state.selectedTreeNodes.forEach((path) => {
    if (!state.workflowNodeMeta.has(path)) {
      state.selectedTreeNodes.delete(path);
    }
  });

  if (state.treeActivePath && !state.workflowNodeMeta.has(state.treeActivePath)) {
    state.treeActivePath = null;
  }
}

function renderWorkflowTree() {
  if (!refs.workflowTree) {
    return;
  }
  refs.workflowTree.innerHTML = "";
  if (!state.workflowTree) {
    const empty = document.createElement("li");
    empty.textContent = "暂无工作流";
    refs.workflowTree.appendChild(empty);
    return;
  }
  const root = state.workflowTree;
  (root.children || []).forEach((child) => {
    refs.workflowTree.appendChild(buildTreeNode(child, 0));
  });
}

function buildTreeNode(node, depth) {
  const key = getNodeKey(node);
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "tree-row";
  row.style.paddingLeft = `${depth * 16}px`;

  if (node.is_dir) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    const expanded = state.expandedTreeNodes.has(key);
    toggle.className = `tree-toggle ${expanded ? "expanded" : "collapsed"}`;
    toggle.addEventListener("click", () => {
      toggleTreeNode(key);
    });
    row.appendChild(toggle);
  } else {
    const spacer = document.createElement("span");
    spacer.style.width = "20px";
    row.appendChild(spacer);
  }

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "tree-checkbox";
  const meta = state.workflowNodeMeta.get(key) || state.workflowNodeMeta.get(node.path || "");
  const files = meta?.files || [];
  const selectedCount = files.filter((path) => state.selectedTreeNodes.has(path)).length;
  if (node.is_dir) {
    if (selectedCount === files.length && (files.length || state.selectedTreeNodes.has(node.path))) {
      checkbox.checked = true;
    } else if (selectedCount > 0) {
      checkbox.indeterminate = true;
    }
  } else if (node.path) {
    checkbox.checked = state.selectedTreeNodes.has(node.path);
  }
  checkbox.addEventListener("change", (event) => {
    setTreeSelection(key, event.target.checked);
  });
  row.appendChild(checkbox);

  const label = document.createElement("span");
  label.className = "tree-label";
  label.textContent = node.name || (node.is_dir ? "(根目录)" : node.path);
  if (state.treeActivePath === key) {
    label.classList.add("active");
  }
  if (node.workflow && node.workflow.groups?.length) {
    label.title = node.workflow.groups.map((group) => group.label).join("\n");
  }
  label.addEventListener("click", () => {
    state.treeActivePath = key;
    renderWorkflowTree();
  });
  row.appendChild(label);

  li.appendChild(row);

  if (node.is_dir && state.expandedTreeNodes.has(key)) {
    const childList = document.createElement("ul");
    childList.className = "tree-children";
    (node.children || []).forEach((child) => {
      childList.appendChild(buildTreeNode(child, depth + 1));
    });
    li.appendChild(childList);
  }
  return li;
}

function toggleTreeNode(key) {
  if (state.expandedTreeNodes.has(key)) {
    state.expandedTreeNodes.delete(key);
  } else {
    state.expandedTreeNodes.add(key);
  }
  renderWorkflowTree();
}

function setTreeSelection(key, checked) {
  const meta = state.workflowNodeMeta.get(key) || state.workflowNodeMeta.get(key === TREE_ROOT_KEY ? "" : key);
  if (!meta) {
    return;
  }
  const files = new Set(meta.files || []);
  if (meta.node?.path) {
    files.add(meta.node.path);
  }
  files.forEach((path) => {
    if (!path) {
      return;
    }
    if (checked) {
      state.selectedTreeNodes.add(path);
    } else {
      state.selectedTreeNodes.delete(path);
    }
  });
  renderWorkflowTree();
  applyTreeSelectionToGroups();
}

function getSelectedWorkflowIdsFromTree() {
  const ids = [];
  state.selectedTreeNodes.forEach((path) => {
    const meta = state.workflowNodeMeta.get(path);
    if (meta?.node?.workflow?.id) {
      ids.push(meta.node.workflow.id);
    }
  });
  return ids;
}

function applyTreeSelectionToGroups() {
  const selectedIds = new Set(getSelectedWorkflowIdsFromTree());
  if (!selectedIds.size) {
    return;
  }
  const matches = [];
  state.groups.forEach((group) => {
    const matched = group.workflows.filter((workflow) => selectedIds.has(workflow.id));
    if (matched.length) {
      matches.push({ group, workflows: matched });
    }
  });
  if (!matches.length) {
    return;
  }
  if (matches.length > 1) {
    showToast("所选工作流包含多种输入输出，请按分类分别运行");
    return;
  }
  const target = matches[0];
  state.selectedGroupId = target.group.id;
  state.selectedWorkflows = new Set(target.workflows.map((item) => item.id));
  renderGroups();
  renderPlaceholders(target.group);
  renderWorkflows(target.group);
  updateRunButton();
}

function renderGroups() {
  refs.groupList.innerHTML = "";
  state.groups.forEach((group) => {
    const item = document.createElement("li");
    item.textContent = group.label;
    item.dataset.id = group.id;
    if (group.id === state.selectedGroupId) {
      item.classList.add("active");
    }
    item.addEventListener("click", () => selectGroup(group.id));
    refs.groupList.appendChild(item);
  });
}

function renderPlaceholders(group) {
  refs.placeholderList.innerHTML = "";
  if (!group) {
    refs.placeholderTip.textContent = "选择分组后配置输入资源。";
    updateRunButton();
    return;
  }

  if (!group.input_signature.length) {
    refs.placeholderTip.textContent = "该分组不需要额外输入。";
    updateRunButton();
    return;
  }

  refs.placeholderTip.textContent = "点击“选择媒体”弹窗绑定测试素材。";

  group.input_signature.forEach((placeholder) => {
    const item = document.createElement("li");
    const info = document.createElement("div");
    info.className = "placeholder-assignment";

    const title = document.createElement("strong");
    const typeLabel = formatMediaTypeLabel(placeholder.type);
    title.textContent = typeLabel ? `${placeholder.name} (${typeLabel})` : placeholder.name;
    info.appendChild(title);

    const path = document.createElement("span");
    const value = state.assignments[placeholder.name] || "";
    path.textContent = value || "未选择";
    info.appendChild(path);

    const actions = document.createElement("div");
    actions.className = "placeholder-actions";

    const selectBtn = document.createElement("button");
    selectBtn.type = "button";
    selectBtn.textContent = "选择媒体";
    selectBtn.addEventListener("click", () => openMediaModal(placeholder.name, placeholder.type));

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "清空";
    clearBtn.addEventListener("click", () => {
      state.assignments[placeholder.name] = "";
      renderPlaceholders(group);
      updateRunButton();
    });

    actions.appendChild(selectBtn);
    actions.appendChild(clearBtn);

    item.appendChild(info);
    item.appendChild(actions);
    refs.placeholderList.appendChild(item);
  });

  updateRunButton();
}

function renderWorkflows(group) {
  refs.workflowList.innerHTML = "";
  if (!group) {
    refs.workflowTitle.textContent = "请选择分组";
    return;
  }

  refs.workflowTitle.textContent = group.label;

  group.workflows.forEach((workflow) => {
    const item = document.createElement("li");
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedWorkflows.has(workflow.id);
    checkbox.addEventListener("change", (event) => {
      if (event.target.checked) {
        state.selectedWorkflows.add(workflow.id);
      } else {
        state.selectedWorkflows.delete(workflow.id);
      }
      updateRunButton();
    });

    const name = document.createElement("span");
    name.textContent = workflow.name;

    label.appendChild(checkbox);
    label.appendChild(name);
    item.appendChild(label);

    const meta = document.createElement("small");
    meta.textContent = workflow.output_types.length ? `输出：${workflow.output_types.join(" / ")}` : "输出类型未知";
    item.appendChild(meta);

    refs.workflowList.appendChild(item);
  });

  updateRunButton();
}

function selectGroup(groupId) {
  if (state.selectedGroupId === groupId) {
    return;
  }

  state.selectedGroupId = groupId;
  const group = state.groups.find((item) => item.id === groupId);
  const treeSelectedIds = new Set(getSelectedWorkflowIdsFromTree());
  let workflowsToSelect = [];
  if (group) {
    workflowsToSelect = group.workflows.filter((item) => !treeSelectedIds.size || treeSelectedIds.has(item.id));
    if (!workflowsToSelect.length) {
      workflowsToSelect = group.workflows;
    }
  }
  state.selectedWorkflows = new Set(workflowsToSelect.map((item) => item.id));

  const nextAssignments = {};
  if (group) {
    group.input_signature.forEach((placeholder) => {
      nextAssignments[placeholder.name] = state.assignments[placeholder.name] || "";
    });
  }
  state.assignments = nextAssignments;

  renderGroups();
  renderPlaceholders(group);
  renderWorkflows(group);
}

function updateRunButton() {
  const group = state.groups.find((item) => item.id === state.selectedGroupId);
  if (!group) {
    refs.runButton.disabled = true;
    return;
  }
  const hasWorkflows = state.selectedWorkflows.size > 0;
  const placeholders = group.input_signature || [];
  const allFilled = placeholders.every((placeholder) => Boolean(state.assignments[placeholder.name]));
  refs.runButton.disabled = !(hasWorkflows && allFilled);
}

function renderMedia(listing) {
  refs.mediaFolders.innerHTML = "";
  refs.mediaFiles.innerHTML = "";
  refs.mediaPath.textContent = listing.path || "/";

  listing.directories.forEach((entry) => {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = entry.name || "/";
    name.addEventListener("click", () => {
      state.mediaPath = entry.path;
      loadMediaTab();
    });
    const rename = document.createElement("button");
    rename.type = "button";
    rename.textContent = "重命名";
    rename.addEventListener("click", () => promptRename(entry));
    item.appendChild(name);
    item.appendChild(rename);
    refs.mediaFolders.appendChild(item);
  });

  listing.files.forEach((entry) => {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = entry.name;
    name.addEventListener("click", () => renderPreview(entry));
    const rename = document.createElement("button");
    rename.type = "button";
    rename.textContent = "重命名";
    rename.addEventListener("click", () => promptRename(entry));
    item.appendChild(name);
    item.appendChild(rename);
    refs.mediaFiles.appendChild(item);
  });
}

function renderPreview(entry) {
  refs.preview.classList.remove("hidden");
  refs.previewContent.innerHTML = "";
  const fullPath = `/media/${entry.path}`;

  if (entry.mime_type?.startsWith("image")) {
    const img = document.createElement("img");
    img.src = fullPath;
    refs.previewContent.appendChild(img);
  } else if (entry.mime_type?.startsWith("video")) {
    const video = document.createElement("video");
    video.src = fullPath;
    video.controls = true;
    refs.previewContent.appendChild(video);
  } else {
    const link = document.createElement("a");
    link.href = fullPath;
    link.textContent = "下载查看";
    link.target = "_blank";
    refs.previewContent.appendChild(link);
  }
}

async function promptRename(entry) {
  const newName = prompt(`重命名 ${entry.name} 为：`, entry.name);
  if (!newName || newName === entry.name) {
    return;
  }
  try {
    await fetchJSON("/api/media/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: entry.path, new_name: newName }),
    });
    showToast("重命名成功");
    loadMediaTab();
  } catch (error) {
    showToast(`重命名失败：${error.message}`);
  }
}

function openMediaModal(placeholderName, placeholderType) {
  state.currentPlaceholder = placeholderName;
  state.modalPlaceholderType = placeholderType || null;
  refs.modalPlaceholder.textContent = `（${placeholderName}）`;
  const subtitle = formatMediaTypeLabel(placeholderType);
  refs.modalPlaceholderType.textContent = subtitle ? `类型：${subtitle}` : "";
  refs.modalMediaEmpty.textContent = MODAL_EMPTY_TEXT;
  refs.modalMediaEmpty.classList.add("hidden");
  refs.modalMediaGrid.innerHTML = "";
  refs.mediaModal.classList.remove("hidden");
  updateOverlayVisibility();
  loadModalMedia();
}

function closeMediaModal() {
  state.currentPlaceholder = null;
  state.modalPlaceholderType = null;
  refs.modalPlaceholderType.textContent = "";
  refs.mediaModal.classList.add("hidden");
  updateOverlayVisibility();
}

async function loadModalMedia() {
  const params = new URLSearchParams();
  if (state.modalPlaceholderType) {
    params.set("type", state.modalPlaceholderType);
  }
  try {
    const query = params.toString();
    const url = query ? `/api/media/all?${query}` : "/api/media/all";
    const { files } = await fetchJSON(url);
    renderModalMedia(files || []);
  } catch (error) {
    refs.modalMediaGrid.innerHTML = "";
    refs.modalMediaEmpty.textContent = `读取媒体失败：${error.message}`;
    refs.modalMediaEmpty.classList.remove("hidden");
    showToast(`读取媒体失败：${error.message}`);
  }
}

function renderModalMedia(files) {
  refs.modalMediaGrid.innerHTML = "";
  if (!files.length) {
    refs.modalMediaEmpty.classList.remove("hidden");
    return;
  }
  refs.modalMediaEmpty.classList.add("hidden");
  const currentValue = state.currentPlaceholder ? state.assignments[state.currentPlaceholder] : null;
  files.forEach((entry) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "media-card";
    card.title = entry.path;
    if (currentValue === entry.path) {
      card.classList.add("selected");
    }

    const preview = document.createElement("div");
    preview.className = "media-card-preview";
    const mediaUrl = resolveMediaUrl(entry);
    if (entry.media_type === "image" && mediaUrl) {
      const img = document.createElement("img");
      img.src = mediaUrl;
      img.alt = entry.name;
      preview.appendChild(img);
    } else if (entry.media_type === "video" && mediaUrl) {
      const video = document.createElement("video");
      video.src = mediaUrl;
      video.muted = true;
      video.loop = true;
      video.autoplay = true;
      video.playsInline = true;
      video.controls = false;
      video.preload = "metadata";
      preview.appendChild(video);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "media-card-fallback";
      placeholder.textContent = formatMediaTypeLabel(entry.media_type) || "文件";
      preview.appendChild(placeholder);
    }
    card.appendChild(preview);

    const label = document.createElement("div");
    label.className = "media-card-label";
    label.textContent = entry.name;
    card.appendChild(label);

    if (entry.media_type && entry.media_type !== "image") {
      const meta = document.createElement("div");
      meta.className = "media-card-meta";
      meta.textContent = formatMediaTypeLabel(entry.media_type);
      card.appendChild(meta);
    }

    card.addEventListener("click", () => handleModalFileSelect(entry));
    refs.modalMediaGrid.appendChild(card);
  });
}

function handleModalFileSelect(entry) {
  if (!state.currentPlaceholder) {
    return;
  }
  state.assignments[state.currentPlaceholder] = entry.path;
  showToast(`已绑定 ${entry.name}`);
  closeMediaModal();
  const group = state.groups.find((item) => item.id === state.selectedGroupId);
  renderPlaceholders(group);
  updateRunButton();
}

async function openResultsModal(jobId) {
  try {
    const job = await fetchJSON(`/api/jobs/${jobId}`);
    renderResultsModal(job);
    refs.resultsModal.classList.remove("hidden");
    updateOverlayVisibility();
  } catch (error) {
    showToast(`获取详情失败：${error.message}`);
  }
}

function closeResultsModal() {
  refs.resultsModal.classList.add("hidden");
  refs.resultsModalContent.innerHTML = "";
  updateOverlayVisibility();
}

function renderResultsModal(job) {
  const container = document.createElement("div");

  const summary = document.createElement("p");
  summary.textContent = `任务 ${job.id} 状态：${job.status}；工作流数量：${job.workflow_ids.length}`;
  container.appendChild(summary);

  if (job.error) {
    renderErrorDetail(container, job.error);
  }

  if (job.placeholders && Object.keys(job.placeholders).length) {
    const placeholdersTitle = document.createElement("p");
    placeholdersTitle.textContent = "占位符选择：";
    container.appendChild(placeholdersTitle);
    const placeholdersList = document.createElement("ul");
    Object.entries(job.placeholders).forEach(([name, value]) => {
      const item = document.createElement("li");
      item.textContent = `${name} → ${value}`;
      placeholdersList.appendChild(item);
    });
    container.appendChild(placeholdersList);
  }

  if (job.uploaded_names && Object.keys(job.uploaded_names).length) {
    const uploadsTitle = document.createElement("p");
    uploadsTitle.textContent = "服务器资源：";
    container.appendChild(uploadsTitle);
    const uploadsList = document.createElement("ul");
    Object.entries(job.uploaded_names).forEach(([name, remote]) => {
      const item = document.createElement("li");
      item.textContent = `${name} → ${remote}`;
      uploadsList.appendChild(item);
    });
    container.appendChild(uploadsList);
  }

  if (job.logs && job.logs.length) {
    const logsTitle = document.createElement("p");
    logsTitle.textContent = "执行日志：";
    container.appendChild(logsTitle);
    const logsList = document.createElement("ul");
    job.logs.forEach((entry) => {
      const item = document.createElement("li");
      const detail = extractErrorDetail(entry);
      if (detail) {
        const pre = document.createElement("pre");
        pre.className = "error-pre";
        pre.textContent = JSON.stringify(detail, null, 2);
        item.appendChild(pre);
      } else {
        item.textContent = entry;
      }
      logsList.appendChild(item);
    });
    container.appendChild(logsList);
  }

  const resultSummary = {};
  (job.results || []).forEach((result) => {
    const name = result.name || "未命名工作流";
    resultSummary[name] = result;
  });

  const artifactGroups = {};
  (job.artifacts || []).forEach((artifact) => {
    const name = artifact.workflow_name || "未命名工作流";
    if (!artifactGroups[name]) {
      artifactGroups[name] = [];
    }
    artifactGroups[name].push(artifact);
  });

  const workflowNames = Array.from(new Set([...Object.keys(resultSummary), ...Object.keys(artifactGroups)]));

  if (workflowNames.length) {
    const resultsWrapper = document.createElement("div");
    resultsWrapper.className = "workflow-results";

    workflowNames.forEach((name) => {
      const card = document.createElement("div");
      card.className = "workflow-result-card";

      const result = resultSummary[name] || {};
      const statusLabel = result.status === "success" ? "✅" : result.status === "failed" ? "❌" : result.status || "进行中";
      const title = document.createElement("h4");
      title.textContent = `${statusLabel} ${name}`;
      card.appendChild(title);

      if (result.error) {
        renderErrorDetail(card, result.error);
      }

      const artifacts = artifactGroups[name] || [];
      if (artifacts.length) {
        const grid = document.createElement("div");
        grid.className = "artifact-grid";
        artifacts.forEach((artifact) => {
          const thumb = document.createElement("div");
          thumb.className = "artifact-thumb";
          const link = document.createElement("a");
          link.href = artifact.url;
          link.target = "_blank";
          let mediaElement;
          if (artifact.media_type === "video") {
            mediaElement = document.createElement("video");
            mediaElement.src = artifact.url;
            mediaElement.controls = true;
            mediaElement.loop = true;
            mediaElement.preload = "metadata";
          } else if (artifact.media_type === "image") {
            mediaElement = document.createElement("img");
            mediaElement.src = artifact.url;
            mediaElement.alt = artifact.filename;
          } else {
            mediaElement = document.createElement("div");
            mediaElement.className = "media-card-fallback";
            mediaElement.textContent = artifact.filename;
          }
          link.appendChild(mediaElement);
          thumb.appendChild(link);

          const caption = document.createElement("span");
          caption.textContent = artifact.filename;
          thumb.appendChild(caption);

          grid.appendChild(thumb);
        });
        card.appendChild(grid);
      } else {
        const emptyHint = document.createElement("p");
        emptyHint.textContent = "无可预览输出";
        card.appendChild(emptyHint);
      }

      resultsWrapper.appendChild(card);
    });

    container.appendChild(resultsWrapper);
  } else {
    const empty = document.createElement("p");
    empty.textContent = "暂无输出文件。";
    container.appendChild(empty);
  }

  refs.resultsModalContent.innerHTML = "";
  refs.resultsModalContent.appendChild(container);
}

async function runBatch() {
  const group = state.groups.find((item) => item.id === state.selectedGroupId);
  if (!group) {
    showToast("请先选择工作流分组");
    return;
  }
  const workflowIds = Array.from(state.selectedWorkflows);
  if (!workflowIds.length) {
    showToast("请至少选择一个工作流");
    return;
  }
  const placeholders = {};
  let missing = [];
  group.input_signature.forEach((placeholder) => {
    const value = state.assignments[placeholder.name];
    if (value) {
      placeholders[placeholder.name] = value;
    } else {
      missing.push(placeholder.name);
    }
  });
  if (missing.length) {
    showToast(`缺少占位符资源：${missing.join("、")}`);
    return;
  }

  const payload = {
    group_id: state.selectedGroupId,
    workflow_ids: workflowIds,
    placeholders,
    server_url: refs.serverInput.value.trim() || "http://127.0.0.1:8189",
  };
  const outputDir = refs.outputInput.value.trim();
  if (outputDir) {
    payload.output_dir = outputDir;
  }

  refs.runButton.disabled = true;
  try {
    const { job_id } = await fetchJSON("/api/run-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    showToast(`任务已提交：${job_id}`);
    pollJobs();
  } catch (error) {
    showToast(`提交任务失败：${error.message}`);
  } finally {
    updateRunButton();
  }
}

async function loadGroups() {
  try {
    const { groups } = await fetchJSON("/api/workflow-groups");
    state.groups = groups;
    renderGroups();
    const activeGroup = state.groups.find((item) => item.id === state.selectedGroupId) || state.groups[0];
    if (activeGroup) {
      selectGroup(activeGroup.id);
    } else {
      state.selectedGroupId = null;
      state.selectedWorkflows = new Set();
      state.assignments = {};
      renderGroups();
      renderPlaceholders(null);
      renderWorkflows(null);
      updateRunButton();
    }
    renderWorkflowTree();
    applyTreeSelectionToGroups();
  } catch (error) {
    showToast(`加载工作流失败：${error.message}`);
  }
}

async function loadMediaTab() {
  const params = new URLSearchParams();
  if (state.mediaPath) {
    params.set("path", state.mediaPath);
  }
  try {
    const query = params.toString();
    const url = query ? `/api/media?${query}` : "/api/media";
    const listing = await fetchJSON(url);
    renderMedia(listing);
  } catch (error) {
    showToast(`加载媒体资源失败：${error.message}`);
  }
}

async function loadWorkflowTree() {
  try {
    const { tree } = await fetchJSON("/api/workflow-tree");
    state.workflowTree = tree;
    if (tree) {
      indexWorkflowTree(tree);
    } else {
      state.workflowNodeMeta = new Map();
    }
    renderWorkflowTree();
    applyTreeSelectionToGroups();
  } catch (error) {
    showToast(`加载工作流树失败：${error.message}`);
  }
}

async function pollJobs() {
  try {
    const { jobs } = await fetchJSON("/api/jobs");
    state.jobs = jobs;
    renderJobs();
  } catch (error) {
    console.error("读取任务失败", error);
  }
}

function renderJobs() {
  refs.resultsTableBody.innerHTML = "";
  state.jobs.forEach((job) => {
    const row = document.createElement("tr");
    const lastLog = job.logs && job.logs.length ? job.logs[job.logs.length - 1] : "";
    let remark = job.error || lastLog;
    const parsedRemark = extractErrorDetail(remark);
    if (parsedRemark && parsedRemark.error && parsedRemark.error.message) {
      remark = parsedRemark.error.message;
    } else if (parsedRemark && parsedRemark.message) {
      remark = parsedRemark.message;
    }
    row.innerHTML = `
      <td>${job.id}</td>
      <td>${job.status}</td>
      <td>${job.workflow_ids.length}</td>
      <td>${formatTime(job.started_at)}</td>
      <td>${formatTime(job.finished_at)}</td>
      <td class="job-remark"></td>
      <td></td>
    `;
    const detailCell = row.lastElementChild;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "查看";
    button.addEventListener("click", () => openResultsModal(job.id));
    detailCell.appendChild(button);
    const remarkCell = row.querySelector(".job-remark");
    if (remarkCell) {
      remarkCell.textContent = remark || "";
    }
    if (job.status === "failed") {
      row.classList.add("job-row-failed");
    }
    refs.resultsTableBody.appendChild(row);
  });
}

async function uploadWorkflowFiles(fileList) {
  if (!fileList || !fileList.length) {
    return;
  }
  const formData = new FormData();
  Array.from(fileList).forEach((file) => {
    formData.append("files", file);
  });
  try {
    const result = await fetchJSON("/api/workflows/upload", {
      method: "POST",
      body: formData,
    });
    showToast(`已上传至 ${result.folder}`);
    await loadWorkflowTree();
    await loadGroups();
  } catch (error) {
    showToast(`上传工作流失败：${error.message}`);
  } finally {
    refs.workflowUploadInput.value = "";
  }
}

async function renameWorkflowNode() {
  const path = state.treeActivePath;
  if (!path || path === TREE_ROOT_KEY) {
    showToast("请选择需要重命名的文件或文件夹");
    return;
  }
  const meta = state.workflowNodeMeta.get(path) || state.workflowNodeMeta.get(path === TREE_ROOT_KEY ? "" : path);
  if (!meta || !meta.node) {
    showToast("无法重命名所选节点");
    return;
  }
  const currentName = meta.node.name || meta.node.path;
  const newName = prompt("输入新的名称", currentName);
  if (!newName || newName === currentName) {
    return;
  }
  try {
    await fetchJSON("/api/workflow-tree/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: meta.node.path, new_name: newName }),
    });
    showToast("重命名成功");
    await loadWorkflowTree();
    await loadGroups();
  } catch (error) {
    showToast(`重命名失败：${error.message}`);
  }
}

async function deleteWorkflowNodes() {
  const targets = new Set();
  if (state.treeActivePath && state.treeActivePath !== TREE_ROOT_KEY) {
    targets.add(state.treeActivePath);
  }
  state.selectedTreeNodes.forEach((path) => targets.add(path));
  targets.delete("");
  if (!targets.size) {
    showToast("请选择需要删除的工作流或文件夹");
    return;
  }
  const ordered = Array.from(targets).sort((a, b) => a.length - b.length);
  const finalTargets = [];
  ordered.forEach((path) => {
    if (!finalTargets.some((parent) => isAncestorPath(parent, path))) {
      finalTargets.push(path);
    }
  });
  if (!finalTargets.length) {
    showToast("未找到可删除的目标");
    return;
  }
  if (!confirm(`确认删除选中的 ${finalTargets.length} 个项目吗？`)) {
    return;
  }
  try {
    await fetchJSON("/api/workflow-tree/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: finalTargets }),
    });
    finalTargets.forEach((path) => {
      state.selectedTreeNodes.forEach((selected) => {
        if (isAncestorPath(path, selected)) {
          state.selectedTreeNodes.delete(selected);
        }
      });
      if (state.treeActivePath && isAncestorPath(path, state.treeActivePath)) {
        state.treeActivePath = null;
      }
    });
    showToast("删除成功");
    await loadWorkflowTree();
    await loadGroups();
  } catch (error) {
    showToast(`删除失败：${error.message}`);
  }
}

function isAncestorPath(parent, child) {
  if (parent === child) {
    return true;
  }
  if (!parent) {
    return true;
  }
  if (!child) {
    return false;
  }
  const prefix = parent.endsWith("/") ? parent : `${parent}/`;
  return child.startsWith(prefix);
}

async function testServerConnection() {
  const serverUrl = refs.serverInput.value.trim();
  if (!serverUrl) {
    showToast("请输入服务器地址");
    return;
  }
  try {
    const result = await fetchJSON("/api/test-server", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server_url: serverUrl }),
    });
    if (result.status === "ok") {
      showToast(result.detail || "连接成功");
    } else {
      showToast(result.detail || "连接失败");
    }
  } catch (error) {
    showToast(`连接失败：${error.message}`);
  }
}

function switchTab(tabId) {
  state.activeTab = tabId;
  refs.tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tabId);
  });
  refs.tabContents.forEach((content) => {
    content.classList.toggle("active", content.id === `tab-${tabId}`);
  });

  if (tabId === "media") {
    loadMediaTab();
  }
}

function setupEventListeners() {
  refs.runButton.addEventListener("click", runBatch);
  refs.refreshGroups.addEventListener("click", () => {
    showToast("刷新工作流分组...");
    Promise.all([loadGroups(), loadWorkflowTree()]);
  });
  refs.testServer.addEventListener("click", testServerConnection);

  refs.workflowUploadButton?.addEventListener("click", () => {
    refs.workflowUploadInput?.click();
  });

  refs.workflowUploadInput?.addEventListener("change", (event) => {
    uploadWorkflowFiles(event.target.files);
  });

  refs.workflowRenameButton?.addEventListener("click", () => {
    renameWorkflowNode();
  });

  refs.workflowDeleteButton?.addEventListener("click", () => {
    deleteWorkflowNodes();
  });

  refs.modalUploadButton?.addEventListener("click", () => {
    refs.modalUploadInput?.click();
  });

  refs.modalUploadInput?.addEventListener("change", async (event) => {
    const files = event.target.files;
    if (!files || !files.length) {
      return;
    }
    try {
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append("parent", state.mediaPath || "");
        formData.append("file", file);
        await fetchJSON("/api/media/upload", { method: "POST", body: formData });
      }
      showToast("媒体上传成功");
      await loadMediaTab();
      await loadModalMedia();
    } catch (error) {
      showToast(`上传媒体失败：${error.message}`);
    } finally {
      refs.modalUploadInput.value = "";
    }
  });

  refs.workflowTreeRefresh?.addEventListener("click", () => {
    loadWorkflowTree();
  });

  refs.uploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!refs.uploadInput.files.length) {
      return;
    }
    const files = Array.from(refs.uploadInput.files);
    for (const file of files) {
      const formData = new FormData();
      formData.append("parent", state.mediaPath);
      formData.append("file", file);
      try {
        await fetchJSON("/api/media/upload", { method: "POST", body: formData });
      } catch (error) {
        showToast(`上传 ${file.name} 失败：${error.message}`);
      }
    }
    refs.uploadInput.value = "";
    showToast("上传完成");
    loadMediaTab();
  });

  refs.createFolderForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = refs.newFolderInput.value.trim();
    if (!name) {
      return;
    }
    try {
      await fetchJSON("/api/media/create-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent: state.mediaPath, name }),
      });
      refs.newFolderInput.value = "";
      showToast("文件夹已创建");
      loadMediaTab();
    } catch (error) {
      showToast(`创建失败：${error.message}`);
    }
  });

  refs.mediaUpButton.addEventListener("click", () => {
    if (!state.mediaPath) {
      return;
    }
    const parts = state.mediaPath.split("/").filter(Boolean);
    parts.pop();
    state.mediaPath = parts.join("/");
    loadMediaTab();
  });

  refs.overlay.addEventListener("click", () => {
    closeMediaModal();
    closeResultsModal();
  });

  document.querySelectorAll("[data-modal-close]").forEach((button) => {
    button.addEventListener("click", () => {
      closeMediaModal();
      closeResultsModal();
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMediaModal();
      closeResultsModal();
    }
  });

  refs.tabButtons.forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });
}

function startPolling() {
  if (state.jobPoller) {
    clearInterval(state.jobPoller);
  }
  state.jobPoller = setInterval(pollJobs, 5000);
  pollJobs();
}

async function bootstrap() {
  setupEventListeners();
  await loadGroups();
  await loadWorkflowTree();
  switchTab("workflows");
  startPolling();
}

bootstrap();
