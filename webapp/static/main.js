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
  treeWorkflowIds: new Set(),
  previewEntryPath: null,
  modalContext: {
    mode: "workflow",
    placeholder: null,
    multi: false,
  },
  dataset: {
    workflows: [],
    selectedWorkflowId: null,
    placeholders: [],
    placeholderSelections: {},
    datasetName: "",
    newDatasetName: "",
    datasets: [],
    selectedDataset: null,
    datasetPairs: [],
    isRunning: false,
    appendMode: false,
    appendTarget: "",
    currentJobId: null,
    jobStatus: null,
    jobPoller: null,
    serverUrl: "",
    promptFields: [],
    selectedPromptField: "",
    promptOverrideText: "",
    datasetPromptText: "",
    datasetPromptEdited: false,
  },
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
  clearSelectionButton: document.getElementById("clear-selection"),
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
  previewClose: document.getElementById("preview-close"),
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
  datasetWorkflowSelect: document.getElementById("dataset-workflow"),
  datasetNameInput: document.getElementById("dataset-name"),
  datasetAppendToggle: document.getElementById("dataset-append-toggle"),
  datasetExistingSelect: document.getElementById("dataset-existing-select"),
  datasetRunButton: document.getElementById("dataset-run"),
  datasetPlaceholderContainer: document.getElementById("dataset-placeholders"),
  datasetRefreshButton: document.getElementById("dataset-refresh"),
  datasetList: document.getElementById("dataset-list"),
  datasetViewer: document.getElementById("dataset-viewer"),
  datasetViewerTitle: document.getElementById("dataset-viewer-title"),
  datasetViewerClose: document.getElementById("dataset-viewer-close"),
  datasetViewerContent: document.getElementById("dataset-viewer-content"),
  datasetJobStatus: document.getElementById("dataset-job-status"),
  datasetPromptField: document.getElementById("dataset-prompt-field"),
  datasetPromptText: document.getElementById("dataset-prompt-text"),
  datasetAnnotationText: document.getElementById("dataset-annotation-text"),
  datasetServerStatus: document.getElementById("dataset-server-status"),
  workflowTree: document.getElementById("workflow-tree"),
  workflowUploadInput: document.getElementById("workflow-upload-input"),
  workflowUploadButton: document.getElementById("workflow-upload-btn"),
  workflowRenameButton: document.getElementById("workflow-rename-btn"),
  workflowDeleteButton: document.getElementById("workflow-delete-btn"),
  workflowSelectAllButton: document.getElementById("workflow-select-all"),
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

function normalizePlaceholderKey(name) {
  const bare = (name || "").replace(/^\{|\}$/g, "");
  return `{${bare}}`;
}

function getConfiguredServerUrl() {
  const input = refs.serverInput;
  if (!input) {
    return "";
  }
  const value = input.value ? input.value.trim() : "";
  if (value) {
    return value;
  }
  const fallback = typeof input.defaultValue === "string" ? input.defaultValue.trim() : "";
  return fallback;
}

function updateDatasetServerStatus() {
  if (!refs.datasetServerStatus) {
    return;
  }
  const jobStatus = state.dataset.jobStatus;
  const runningServer =
    jobStatus && jobStatus.status === "running" && jobStatus.server_url ? jobStatus.server_url : "";
  const configured = getConfiguredServerUrl();
  const label = runningServer || configured;
  const prefix = runningServer ? "正在使用服务器" : "计划使用服务器";
  refs.datasetServerStatus.textContent = label ? `${prefix}：${label}` : `${prefix}：未设置`;
}

function isImagePath(path) {
  return /\.(png|jpe?g|webp|bmp|gif|tif?f)$/i.test(path || "");
}

function isVideoPath(path) {
  return /\.(mp4|mov|avi|mkv|webm)$/i.test(path || "");
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
  renderGroups();
  const group = state.groups.find((item) => item.id === state.selectedGroupId);
  renderPlaceholders(group || null);
  renderWorkflows(group || null);
  updateRunButton();
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

function selectAllTreeWorkflows() {
  if (!state.workflowNodeMeta.size) {
    return;
  }
  state.selectedTreeNodes.clear();
  state.workflowNodeMeta.forEach((meta, key) => {
    if (meta.node?.workflow?.id) {
      state.selectedTreeNodes.add(meta.node.path || key);
    }
  });
  state.treeActivePath = null;
  renderWorkflowTree();
  applyTreeSelectionToGroups();
}

function applyTreeSelectionToGroups() {
  const selectedIds = new Set(getSelectedWorkflowIdsFromTree());
  state.treeWorkflowIds = selectedIds;
  if (!selectedIds.size) {
    state.selectedGroupId = null;
    state.selectedWorkflows = new Set();
    renderGroups();
    renderPlaceholders(null);
    renderWorkflows(null);
    updateRunButton();
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
    state.selectedGroupId = null;
    state.selectedWorkflows = new Set();
    renderGroups();
    renderPlaceholders(null);
    renderWorkflows(null);
    updateRunButton();
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
  const activeIds = new Set(state.selectedWorkflows);
  const treeIds = state.treeWorkflowIds instanceof Set ? state.treeWorkflowIds : new Set();
  const useFilter = treeIds.size > 0;
  let rendered = false;
  state.groups.forEach((group) => {
    const hasTreeMatch = group.workflows.some((workflow) => treeIds.has(workflow.id));
    const hasSelection = group.workflows.some((workflow) => activeIds.has(workflow.id));
    if (useFilter && !hasTreeMatch) {
      return;
    }
    const item = document.createElement("li");
    item.textContent = group.label;
    item.dataset.id = group.id;
    if (group.id === state.selectedGroupId) {
      item.classList.add("active");
    }
    item.addEventListener("click", () => selectGroup(group.id));
    refs.groupList.appendChild(item);
    rendered = true;
  });
  if (!rendered) {
    const placeholder = document.createElement("li");
    placeholder.textContent = "请选择工作流";
    placeholder.style.color = "#5c6784";
    placeholder.style.cursor = "default";
    refs.groupList.appendChild(placeholder);
  }
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
  const hasTreeSelection = state.selectedTreeNodes.size > 0;
  let workflowsToSelect = [];
  if (group) {
    if (hasTreeSelection) {
      workflowsToSelect = group.workflows.filter((item) => treeSelectedIds.has(item.id));
    } else {
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

function createMediaThumbnail(entry) {
  const container = document.createElement("div");
  container.className = "media-thumb";
  const mediaUrl = entry.url || `/media/${entry.path}`;
  if (entry.mime_type?.startsWith("image")) {
    const img = document.createElement("img");
    img.src = mediaUrl;
    container.appendChild(img);
  } else if (entry.mime_type?.startsWith("video")) {
    const video = document.createElement("video");
    video.src = mediaUrl;
    video.muted = true;
    video.loop = true;
    video.autoplay = true;
    video.controls = false;
    video.preload = "metadata";
    video.playsInline = true;
    container.appendChild(video);
  } else {
    const span = document.createElement("span");
    span.textContent = "文件";
    container.appendChild(span);
  }
  return container;
}

async function deleteMediaEntry(entry) {
  if (!entry.path) {
    return;
  }
  if (!confirm(`确认删除 ${entry.name} 吗？`)) {
    return;
  }
  try {
    await fetchJSON("/api/media/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [entry.path] }),
    });
    showToast("删除成功");
    if (state.previewEntryPath && isAncestorPath(entry.path, state.previewEntryPath)) {
      clearPreview();
    }
    await loadMediaTab();
  } catch (error) {
    showToast(`删除失败：${error.message}`);
  }
}

function clearPreview() {
  refs.previewContent.innerHTML = "";
  refs.preview.classList.add("hidden");
  state.previewEntryPath = null;
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
    const row = document.createElement("div");
    row.className = "media-file-row";

    const info = document.createElement("div");
    info.className = "media-file-info";
    const thumb = createMediaThumbnail(entry);
    info.appendChild(thumb);
    const name = document.createElement("span");
    name.textContent = entry.name;
    info.appendChild(name);
    info.addEventListener("click", () => renderPreview(entry));
    row.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "media-file-actions";

    const previewButton = document.createElement("button");
    previewButton.type = "button";
    previewButton.textContent = "预览";
    previewButton.addEventListener("click", () => renderPreview(entry));
    actions.appendChild(previewButton);

    const renameButton = document.createElement("button");
    renameButton.type = "button";
    renameButton.textContent = "重命名";
    renameButton.addEventListener("click", () => promptRename(entry));
    actions.appendChild(renameButton);

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.textContent = "删除";
    deleteButton.addEventListener("click", () => deleteMediaEntry(entry));
    actions.appendChild(deleteButton);

    row.appendChild(actions);
    item.appendChild(row);
  refs.mediaFiles.appendChild(item);
  });
}

async function loadDatasetWorkflows() {
  try {
    const { workflows } = await fetchJSON("/api/dataset/workflows");
    const previous = state.dataset.selectedWorkflowId;
    state.dataset.workflows = workflows || [];
    if (!state.dataset.workflows.length) {
      state.dataset.selectedWorkflowId = null;
      state.dataset.placeholders = [];
      state.dataset.placeholderSelections = {};
      state.dataset.promptFields = [];
      state.dataset.selectedPromptField = "";
      state.dataset.promptOverrideText = "";
      state.dataset.datasetPromptText = "";
      state.dataset.datasetPromptEdited = false;
      renderDatasetBuilder();
      return;
    }
    const hasPrevious = previous && state.dataset.workflows.some((item) => item.id === previous);
    const nextWorkflowId = hasPrevious ? previous : state.dataset.workflows[0].id;
    setDatasetWorkflow(nextWorkflowId);
  } catch (error) {
    showToast(`加载数据集工作流失败：${error.message}`);
  }
}

function renderDatasetBuilder() {
  renderDatasetWorkflowOptions();
  renderDatasetPlaceholderList();
  renderDatasetPromptControls();
  updateDatasetRunButton();
  if (refs.datasetNameInput) {
    refs.datasetNameInput.value = state.dataset.datasetName;
    refs.datasetNameInput.disabled = state.dataset.appendMode;
  }
  if (refs.datasetAppendToggle) {
    refs.datasetAppendToggle.checked = state.dataset.appendMode;
  }
  if (refs.datasetExistingSelect) {
    refs.datasetExistingSelect.innerHTML = "";
    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = state.dataset.appendMode ? "请选择" : "不可用";
    refs.datasetExistingSelect.appendChild(defaultOption);
    state.dataset.datasets.forEach((dataset) => {
      const option = document.createElement("option");
      option.value = dataset.name;
      const actualRuns = dataset.total_runs || 0;
      const recordedRuns = dataset.recorded_runs ?? dataset.total_runs ?? 0;
      const label =
        recordedRuns && recordedRuns !== actualRuns
          ? `${dataset.name} (${actualRuns} 条 · 记录 ${recordedRuns})`
          : `${dataset.name} (${actualRuns} 条)`;
      option.textContent = label;
      if (dataset.name === state.dataset.appendTarget) {
        option.selected = true;
      }
      refs.datasetExistingSelect.appendChild(option);
    });
    refs.datasetExistingSelect.disabled = !state.dataset.appendMode;
    if (!state.dataset.appendMode) {
      refs.datasetExistingSelect.value = "";
    } else if (state.dataset.appendTarget) {
      refs.datasetExistingSelect.value = state.dataset.appendTarget;
    }
  }
  renderDatasetJobStatus();
}

function renderDatasetWorkflowOptions() {
  if (!refs.datasetWorkflowSelect) {
    return;
  }
  refs.datasetWorkflowSelect.innerHTML = "";
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "请选择需要批量运行的工作流";
  refs.datasetWorkflowSelect.appendChild(defaultOption);
  state.dataset.workflows.forEach((workflow) => {
    const option = document.createElement("option");
    option.value = workflow.id;
    option.textContent = workflow.name;
    if (workflow.id === state.dataset.selectedWorkflowId) {
      option.selected = true;
    }
    refs.datasetWorkflowSelect.appendChild(option);
  });
  refs.datasetWorkflowSelect.value = state.dataset.selectedWorkflowId || "";
}

function setDatasetWorkflow(workflowId) {
  const previousWorkflowId = state.dataset.selectedWorkflowId;
  state.dataset.selectedWorkflowId = workflowId || null;
  const workflow = state.dataset.workflows.find((item) => item.id === workflowId);
  if (workflow) {
    state.dataset.placeholders = workflow.placeholders || [];
    const selections = {};
    state.dataset.placeholders.forEach((placeholder) => {
      const key = normalizePlaceholderKey(placeholder.name);
      selections[key] = state.dataset.placeholderSelections[key] || [];
    });
    state.dataset.placeholderSelections = selections;
    state.dataset.promptFields = workflow.prompt_fields || [];
    const currentSelectionValid =
      state.dataset.selectedPromptField &&
      state.dataset.promptFields.some((item) => `${item.node_id}:${item.field}` === state.dataset.selectedPromptField);
    if (!currentSelectionValid || previousWorkflowId !== workflowId) {
      state.dataset.selectedPromptField = "";
      state.dataset.promptOverrideText = "";
    }
    if (previousWorkflowId !== workflowId) {
      state.dataset.datasetPromptText = "";
      state.dataset.datasetPromptEdited = false;
    }
  } else {
    state.dataset.placeholders = [];
    state.dataset.placeholderSelections = {};
    state.dataset.promptFields = [];
    state.dataset.selectedPromptField = "";
    state.dataset.promptOverrideText = "";
    state.dataset.datasetPromptText = "";
    state.dataset.datasetPromptEdited = false;
  }
  renderDatasetBuilder();
}

function renderDatasetPlaceholderList() {
  if (!refs.datasetPlaceholderContainer) {
    return;
  }
  refs.datasetPlaceholderContainer.innerHTML = "";
  if (!state.dataset.selectedWorkflowId) {
    const hint = document.createElement("p");
    hint.className = "dataset-empty";
    hint.textContent = "请选择一个工作流以配置输入素材。";
    refs.datasetPlaceholderContainer.appendChild(hint);
    return;
  }
  if (!state.dataset.placeholders.length) {
    const hint = document.createElement("p");
    hint.className = "dataset-empty";
    hint.textContent = "该工作流未检测到可替换的输入。";
    refs.datasetPlaceholderContainer.appendChild(hint);
    return;
  }
  state.dataset.placeholders.forEach((placeholder) => {
    const key = normalizePlaceholderKey(placeholder.name);
    if (!state.dataset.placeholderSelections[key]) {
      state.dataset.placeholderSelections[key] = [];
    }
  });
  state.dataset.placeholders.forEach((placeholder) => {
    const key = normalizePlaceholderKey(placeholder.name);
    const selections = state.dataset.placeholderSelections[key] || [];
    const card = document.createElement("div");
    card.className = "dataset-placeholder-card";
    card.dataset.placeholder = key;

    const header = document.createElement("div");
    header.className = "dataset-placeholder-header";
    const title = document.createElement("div");
    title.innerHTML = `<strong>${placeholder.display || placeholder.name}</strong><span>${formatMediaTypeLabel(placeholder.type)} · 已选 ${selections.length} 项</span>`;
    header.appendChild(title);
    const actions = document.createElement("div");
    actions.className = "dataset-placeholder-actions";
    const selectBtn = document.createElement("button");
    selectBtn.type = "button";
    selectBtn.textContent = "选择素材";
    selectBtn.dataset.action = "select";
    selectBtn.dataset.placeholder = key;
    selectBtn.dataset.type = placeholder.type || "";
    selectBtn.dataset.display = placeholder.display || placeholder.name;
    actions.appendChild(selectBtn);
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "清空";
    clearBtn.dataset.action = "clear";
    clearBtn.dataset.placeholder = key;
    actions.appendChild(clearBtn);
    header.appendChild(actions);
    card.appendChild(header);

    const list = document.createElement("div");
    list.className = "dataset-selected-list";
    if (!selections.length) {
      const empty = document.createElement("span");
      empty.className = "dataset-empty";
      empty.textContent = "尚未选择素材";
      list.appendChild(empty);
    } else {
      selections.forEach((item, index) => {
        const chip = document.createElement("span");
        chip.className = "dataset-selected-item";
        chip.textContent = item.name;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "移除";
        remove.dataset.action = "remove";
        remove.dataset.placeholder = key;
        remove.dataset.index = String(index);
        chip.appendChild(remove);
        list.appendChild(chip);
      });
    }
    card.appendChild(list);
    refs.datasetPlaceholderContainer.appendChild(card);
  });
}

function renderDatasetPromptControls() {
  if (!refs.datasetPromptField || !refs.datasetPromptText || !refs.datasetAnnotationText) {
    return;
  }
  const fields = state.dataset.promptFields || [];
  const select = refs.datasetPromptField;
  select.innerHTML = "";
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = fields.length ? "不修改提示词" : "当前工作流暂无可修改提示词";
  select.appendChild(defaultOption);
  fields.forEach((field) => {
    const option = document.createElement("option");
    const value = `${field.node_id}:${field.field}`;
    option.value = value;
    option.textContent = field.label || value;
    option.dataset.defaultValue = field.default_value || "";
    if (value === state.dataset.selectedPromptField) {
      option.selected = true;
    }
    select.appendChild(option);
  });

  if (state.dataset.selectedPromptField) {
    select.value = state.dataset.selectedPromptField;
  }

  const textarea = refs.datasetPromptText;
  const hasSelection = Boolean(state.dataset.selectedPromptField);
  textarea.disabled = !hasSelection;
  textarea.classList.toggle("dataset-prompt-text-readonly", !hasSelection);
  textarea.placeholder = hasSelection
    ? "输入自定义提示词"
    : fields.length
    ? "选择节点后可修改提示词"
    : "当前工作流无可修改提示词";
  textarea.value = state.dataset.promptOverrideText || "";

  const annotation = refs.datasetAnnotationText;
  annotation.value = state.dataset.datasetPromptText || "";
}

function handleDatasetPromptFieldChange(event) {
  const value = event.target.value;
  if (!value) {
    state.dataset.selectedPromptField = "";
    state.dataset.promptOverrideText = "";
    renderDatasetPromptControls();
    return;
  }
  const field = state.dataset.promptFields.find((item) => `${item.node_id}:${item.field}` === value);
  state.dataset.selectedPromptField = value;
  const defaultValue = field?.default_value || "";
  state.dataset.promptOverrideText = defaultValue;
  if (!state.dataset.datasetPromptEdited) {
    state.dataset.datasetPromptText = defaultValue;
    if (refs.datasetAnnotationText) {
      refs.datasetAnnotationText.value = defaultValue;
    }
    state.dataset.datasetPromptEdited = false;
  }
  renderDatasetPromptControls();
}

function handleDatasetPromptTextInput(event) {
  if (!state.dataset.selectedPromptField) {
    event.target.value = "";
    return;
  }
  const value = event.target.value;
  state.dataset.promptOverrideText = value;
  if (!state.dataset.datasetPromptEdited) {
    state.dataset.datasetPromptText = value;
    if (refs.datasetAnnotationText && refs.datasetAnnotationText !== event.target) {
      refs.datasetAnnotationText.value = value;
    }
  }
}

function handleDatasetAnnotationInput(event) {
  const value = event.target.value;
  state.dataset.datasetPromptText = value;
  state.dataset.datasetPromptEdited = Boolean(value.trim());
}

function updateDatasetRunButton() {
  if (!refs.datasetRunButton) {
    return;
  }
  const ready =
    !state.dataset.isRunning &&
    ((state.dataset.appendMode && state.dataset.appendTarget) || (!state.dataset.appendMode && state.dataset.datasetName)) &&
    state.dataset.selectedWorkflowId &&
    state.dataset.placeholders.every((placeholder) => {
      const key = normalizePlaceholderKey(placeholder.name);
      return (state.dataset.placeholderSelections[key] || []).length > 0;
    });
  refs.datasetRunButton.disabled = !ready;
  refs.datasetRunButton.textContent = state.dataset.isRunning ? "创建中..." : "开始创建";
}

async function runDataset() {
  if (!state.dataset.selectedWorkflowId) {
    showToast("请先选择工作流");
    return;
  }
  const targetDatasetName = state.dataset.appendMode ? state.dataset.appendTarget : state.dataset.datasetName;
  if (!targetDatasetName) {
    showToast(state.dataset.appendMode ? "请选择需要追加的数据集" : "请填写数据集名称");
    return;
  }
  const serverUrl = getConfiguredServerUrl();
  if (!serverUrl) {
    showToast("请先在数据集服务器地址中填写可用的 ComfyUI 地址");
    return;
  }
  const promptOverrides = [];
  if (state.dataset.selectedPromptField && state.dataset.promptOverrideText.trim()) {
    const [nodeId, ...rest] = state.dataset.selectedPromptField.split(":");
    const field = rest.join(":");
    if (nodeId && field) {
      promptOverrides.push({ node_id: nodeId, field, value: state.dataset.promptOverrideText });
    }
  }
  const datasetPrompt = state.dataset.datasetPromptText?.trim();
  const payload = {
    dataset_name: targetDatasetName,
    workflow_id: state.dataset.selectedWorkflowId,
    placeholders: {},
    options: {
      convert_images_to_jpg: true,
      append: state.dataset.appendMode,
      server_url: serverUrl,
    },
  };
  state.dataset.serverUrl = serverUrl;
  state.dataset.placeholders.forEach((placeholder) => {
    const key = normalizePlaceholderKey(placeholder.name);
    const selections = state.dataset.placeholderSelections[key] || [];
    if (!selections.length) {
      return;
    }
    payload.placeholders[key] = selections.map((item) => item.path);
  });
  if (!Object.keys(payload.placeholders).length) {
    showToast("请为每个输入占位符选择至少一个素材");
    return;
  }
  if (promptOverrides.length) {
    payload.prompt_overrides = promptOverrides;
  }
  if (datasetPrompt) {
    payload.dataset_prompt = datasetPrompt;
  }
  showToast("正在创建数据集任务...");
  state.dataset.isRunning = true;
  updateDatasetRunButton();
  renderDatasetJobStatus();
  try {
    const { job_id: jobId } = await fetchJSON("/api/datasets/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.dataset.currentJobId = jobId;
    state.dataset.jobStatus = { status: "queued", total: 0, completed: 0, server_url: serverUrl };
    renderDatasetJobStatus();
    updateDatasetServerStatus();
    startDatasetJobPolling(jobId);
  } catch (error) {
    showToast(`创建数据集失败：${error.message}`);
    state.dataset.isRunning = false;
    updateDatasetRunButton();
    renderDatasetJobStatus();
    updateDatasetServerStatus();
  }
}

async function loadDatasetsList() {
  try {
    const { datasets } = await fetchJSON("/api/datasets");
    state.dataset.datasets = datasets || [];
    if (state.dataset.appendMode && !state.dataset.appendTarget) {
      state.dataset.appendTarget = state.dataset.datasets.length ? state.dataset.datasets[0].name : "";
      if (state.dataset.appendTarget) {
        state.dataset.datasetName = state.dataset.appendTarget;
        if (refs.datasetNameInput) {
          refs.datasetNameInput.value = state.dataset.datasetName;
        }
      }
    }
    renderDatasetList();
    if (state.dataset.selectedDataset?.dataset_name) {
      const name = state.dataset.selectedDataset.dataset_name;
      if (state.dataset.datasets.some((item) => item.name === name)) {
        await viewDataset(name);
      } else {
        closeDatasetViewer();
      }
    }
    renderDatasetBuilder();
  } catch (error) {
    showToast(`加载数据集失败：${error.message}`);
  }
}

function renderDatasetList() {
  if (!refs.datasetList) {
    return;
  }
  refs.datasetList.innerHTML = "";
  if (!state.dataset.datasets.length) {
    const empty = document.createElement("li");
    empty.className = "dataset-empty";
    empty.textContent = "暂无数据集，请先创建。";
    refs.datasetList.appendChild(empty);
    return;
  }
  state.dataset.datasets.forEach((dataset) => {
    const item = document.createElement("li");
    if (state.dataset.selectedDataset?.dataset_name === dataset.name) {
      item.classList.add("active");
    }
    const info = document.createElement("div");
    const actualRuns = dataset.total_runs || 0;
    const recordedRuns = dataset.recorded_runs ?? dataset.total_runs ?? 0;
    const countLabel =
      recordedRuns && recordedRuns !== actualRuns
        ? `${actualRuns} 条（记录 ${recordedRuns}）`
        : `${actualRuns} 条`;
    info.innerHTML = `<strong>${dataset.name}</strong><span>${countLabel}</span>`;
    info.style.display = "flex";
    info.style.flexDirection = "column";
    info.style.gap = "4px";
    item.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "dataset-list-actions";
    const viewBtn = document.createElement("button");
    viewBtn.type = "button";
    viewBtn.textContent = "查看";
    viewBtn.dataset.action = "view";
    viewBtn.dataset.name = dataset.name;
    actions.appendChild(viewBtn);
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = "删除";
    deleteBtn.dataset.action = "delete";
    deleteBtn.dataset.name = dataset.name;
    actions.appendChild(deleteBtn);
    item.appendChild(actions);
    refs.datasetList.appendChild(item);
  });
}

function startDatasetJobPolling(jobId) {
  stopDatasetJobPolling();
  state.dataset.currentJobId = jobId;
  state.dataset.jobStatus = state.dataset.jobStatus || { status: "queued", total: 0, completed: 0 };
  renderDatasetJobStatus();
  pollDatasetJob(jobId);
  state.dataset.jobPoller = setInterval(() => pollDatasetJob(jobId), 1000);
}

function stopDatasetJobPolling() {
  if (state.dataset.jobPoller) {
    clearInterval(state.dataset.jobPoller);
    state.dataset.jobPoller = null;
  }
  state.dataset.currentJobId = null;
}

async function pollDatasetJob(jobId) {
  try {
    const job = await fetchJSON(`/api/dataset-jobs/${jobId}`);
    state.dataset.jobStatus = job;
    renderDatasetJobStatus();
    updateDatasetServerStatus();
    if (job.status === "running") {
      state.dataset.isRunning = true;
      updateDatasetRunButton();
    }
    if (job.status === "finished") {
      stopDatasetJobPolling();
      state.dataset.isRunning = false;
      updateDatasetRunButton();
      const result = job.result || {};
      const totalText = result.total_runs ? `新增 ${result.total_runs} 条，累计 ${result.total_count || result.total_runs} 条` : "任务完成";
      showToast(`数据集 ${result.dataset || state.dataset.datasetName} ${totalText}`);
      await loadDatasetsList();
      const datasetName = result.dataset || state.dataset.datasetName;
      if (datasetName) {
        await viewDataset(datasetName);
      }
      if (!state.dataset.appendMode) {
        state.dataset.datasetName = "";
        state.dataset.newDatasetName = "";
        if (refs.datasetNameInput) {
          refs.datasetNameInput.value = "";
        }
      }
    } else if (job.status === "failed") {
      stopDatasetJobPolling();
      state.dataset.isRunning = false;
      updateDatasetRunButton();
      showToast(`数据集任务失败：${job.error || "未知错误"}`);
    }
  } catch (error) {
    stopDatasetJobPolling();
    state.dataset.isRunning = false;
    updateDatasetRunButton();
    showToast(`查询数据集任务失败：${error.message}`);
  }
  renderDatasetJobStatus();
  updateDatasetServerStatus();
}

function renderDatasetJobStatus() {
  if (!refs.datasetJobStatus) {
    return;
  }
  const job = state.dataset.jobStatus;
  if (!job) {
    refs.datasetJobStatus.classList.add("hidden");
    refs.datasetJobStatus.textContent = "";
    return;
  }
  refs.datasetJobStatus.classList.remove("hidden");
  let text = `任务状态：${translateJobStatus(job.status)}`;
  if (job.total) {
    text += ` · ${job.completed}/${job.total}`;
  }
  if (job.server_url) {
    text += ` · 服务器：${job.server_url}`;
  }
  if (job.status === "finished" && job.result) {
    text += ` · 新增 ${job.result.total_runs} 条，累计 ${job.result.total_count} 条`;
  }
  if (job.status === "failed" && job.error) {
    text += ` · 错误：${job.error}`;
  }
  refs.datasetJobStatus.textContent = text;
}

function translateJobStatus(status) {
  switch (status) {
    case "queued":
      return "排队中";
    case "running":
      return "运行中";
    case "finished":
      return "已完成";
    case "failed":
      return "已失败";
    default:
      return status || "未知";
  }
}

async function viewDataset(datasetName) {
  try {
    const { metadata, pairs } = await fetchJSON(`/api/datasets/${encodeURIComponent(datasetName)}`);
    state.dataset.selectedDataset = metadata;
    if (state.dataset.selectedDataset) {
      state.dataset.selectedDataset.dataset_name = state.dataset.selectedDataset.dataset_name || datasetName;
      if (state.dataset.appendMode && state.dataset.selectedDataset.workflow_id) {
        state.dataset.selectedWorkflowId = state.dataset.selectedDataset.workflow_id;
        setDatasetWorkflow(state.dataset.selectedWorkflowId);
      }
    }
    state.dataset.datasetPairs = pairs || [];
    const actualRuns = state.dataset.datasetPairs.length;
    if (state.dataset.selectedDataset) {
      state.dataset.selectedDataset.actual_runs = actualRuns;
      if (typeof state.dataset.selectedDataset.total_runs === "number") {
        state.dataset.selectedDataset.recorded_runs = state.dataset.selectedDataset.total_runs;
      }
    }
    if (state.dataset.appendMode) {
      state.dataset.appendTarget = datasetName;
      state.dataset.datasetName = datasetName;
      if (refs.datasetNameInput) {
        refs.datasetNameInput.value = datasetName;
      }
    }
    renderDatasetViewer(datasetName);
  } catch (error) {
    showToast(`加载数据集详情失败：${error.message}`);
  }
}

function renderDatasetViewer(datasetName) {
  if (!refs.datasetViewer || !refs.datasetViewerContent) {
    return;
  }
  refs.datasetViewer.classList.remove("hidden");
  refs.datasetViewerTitle.textContent = `数据集：${datasetName}`;
  refs.datasetViewerContent.innerHTML = "";
  const metadata = state.dataset.selectedDataset || {};
  const actualRuns =
    typeof metadata.actual_runs === "number" ? metadata.actual_runs : state.dataset.datasetPairs.length;
  const recordedRuns =
    typeof metadata.recorded_runs === "number"
      ? metadata.recorded_runs
      : typeof metadata.total_runs === "number"
      ? metadata.total_runs
      : metadata.totalCount || actualRuns;
  const summary = document.createElement("p");
  summary.className = "dataset-empty";
  summary.textContent =
    recordedRuns && recordedRuns !== actualRuns
      ? `累计 ${actualRuns} 条数据（记录 ${recordedRuns} 条）`
      : `累计 ${actualRuns} 条数据`;
  refs.datasetViewerContent.appendChild(summary);
  const placeholderLabels = metadata.placeholder_map || {};
  const controlSlots = metadata.control_slots || {};
  const slotLabelMap = {};
  Object.entries(controlSlots).forEach(([placeholderKey, slotName]) => {
    slotLabelMap[slotName] = placeholderLabels[placeholderKey] || placeholderKey;
  });
  if (!state.dataset.datasetPairs.length) {
    const empty = document.createElement("p");
    empty.className = "dataset-empty";
    empty.textContent = "暂时没有数据对。";
    refs.datasetViewerContent.appendChild(empty);
    return;
  }
  state.dataset.datasetPairs.forEach((pair) => {
    const card = document.createElement("div");
    card.className = "dataset-pair-card";
    const header = document.createElement("div");
    header.className = "dataset-pair-header";
    header.innerHTML = `<strong>#${String(pair.index).padStart(3, "0")}</strong>`;
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = "删除";
    deleteBtn.dataset.action = "delete-pair";
    deleteBtn.dataset.index = pair.index;
    deleteBtn.dataset.dataset = datasetName;
    header.appendChild(deleteBtn);
    card.appendChild(header);

    const mediaRow = document.createElement("div");
    mediaRow.className = "dataset-pair-media";
    Object.entries(pair.controls || {}).forEach(([slot, entry]) => {
      const label = slotLabelMap[slot] || slot;
      mediaRow.appendChild(createDatasetMediaThumb(entry, label));
    });
    if (pair.target) {
      mediaRow.appendChild(createDatasetMediaThumb(pair.target, "target"));
    }
    card.appendChild(mediaRow);
    if (pair.prompt && pair.prompt.text) {
      const promptSection = document.createElement("div");
      promptSection.className = "dataset-prompt-section";
      const promptLabel = document.createElement("span");
      promptLabel.className = "dataset-prompt-label";
      promptLabel.textContent = "提示词";
      const promptBlock = document.createElement("pre");
      promptBlock.className = "dataset-prompt-display";
      promptBlock.textContent = pair.prompt.text;
      promptSection.appendChild(promptLabel);
      promptSection.appendChild(promptBlock);
      card.appendChild(promptSection);
    }
    refs.datasetViewerContent.appendChild(card);
  });
}

function createDatasetMediaThumb(entry, label) {
  const wrapper = document.createElement("div");
  wrapper.className = "dataset-media-thumb";
  const caption = document.createElement("span");
  caption.textContent = label;
  wrapper.appendChild(caption);
  if (!entry) {
    const placeholder = document.createElement("div");
    placeholder.className = "placeholder";
    placeholder.textContent = "无文件";
    wrapper.appendChild(placeholder);
    return wrapper;
  }
  const url = entry.url ? encodeURI(entry.url) : `/datasets/${entry.path}`;
  if (isImagePath(entry.path || entry.name)) {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    const img = document.createElement("img");
    img.src = url;
    img.alt = entry.name;
    link.appendChild(img);
    wrapper.appendChild(link);
  } else if (isVideoPath(entry.path || entry.name)) {
    const video = document.createElement("video");
    video.src = url;
    video.controls = true;
    video.loop = true;
    video.preload = "metadata";
    wrapper.appendChild(video);
  } else {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.textContent = entry.name;
    wrapper.appendChild(link);
  }
  return wrapper;
}

async function deleteDataset(name) {
  if (!confirm(`确认删除数据集 ${name} 吗？该操作不可恢复。`)) {
    return;
  }
  try {
    await fetchJSON(`/api/datasets/${encodeURIComponent(name)}`, { method: "DELETE" });
    showToast("数据集已删除");
    if (state.dataset.selectedDataset?.dataset_name === name) {
      closeDatasetViewer();
    }
    await loadDatasetsList();
  } catch (error) {
    showToast(`删除数据集失败：${error.message}`);
  }
}

async function deleteDatasetPairRequest(name, index) {
  try {
    await fetchJSON(`/api/datasets/${encodeURIComponent(name)}/pair/${index}`, { method: "DELETE" });
    showToast("已删除该数据对");
    await viewDataset(name);
  } catch (error) {
    showToast(`删除失败：${error.message}`);
  }
}

function closeDatasetViewer() {
  if (refs.datasetViewer) {
    refs.datasetViewer.classList.add("hidden");
  }
  if (refs.datasetViewerContent) {
    refs.datasetViewerContent.innerHTML = "";
  }
  state.dataset.selectedDataset = null;
  state.dataset.datasetPairs = [];
  renderDatasetList();
}

function renderPreview(entry) {
  refs.preview.classList.remove("hidden");
  refs.previewContent.innerHTML = "";
  const mediaUrl = entry.url || `/media/${entry.path}`;
  state.previewEntryPath = entry.path;

  if (entry.mime_type?.startsWith("image")) {
    const img = document.createElement("img");
    img.src = mediaUrl;
    refs.previewContent.appendChild(img);
  } else if (entry.mime_type?.startsWith("video")) {
    const video = document.createElement("video");
    video.src = mediaUrl;
    video.controls = true;
    video.loop = true;
    video.preload = "metadata";
    video.playsInline = true;
    refs.previewContent.appendChild(video);
  } else {
    const link = document.createElement("a");
    link.href = mediaUrl;
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

function openMediaModal(placeholderName, placeholderType, context = {}) {
  state.modalContext = {
    mode: context.mode || "workflow",
    placeholder: placeholderName,
    multi: Boolean(context.multi),
  };
  if (state.modalContext.mode === "workflow") {
    state.currentPlaceholder = placeholderName;
  } else {
    state.currentPlaceholder = null;
  }
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
  state.modalContext = { mode: "workflow", placeholder: null, multi: false };
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
  const context = state.modalContext;
  let selectedPaths = new Set();
  if (context?.mode === "dataset" && context.placeholder) {
    const key = normalizePlaceholderKey(context.placeholder);
    const selections = state.dataset.placeholderSelections[key] || [];
    selectedPaths = new Set(selections.map((item) => item.path));
  }
  const currentValue = state.currentPlaceholder ? state.assignments[state.currentPlaceholder] : null;
  files.forEach((entry) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "media-card";
    card.title = entry.path;
    if (context?.mode === "dataset" && selectedPaths.has(entry.path)) {
      card.classList.add("selected");
    } else if (context?.mode !== "dataset" && currentValue === entry.path) {
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
  const context = state.modalContext;
  if (!context || !context.placeholder) {
    return;
  }
  if (context.mode === "dataset") {
    const key = normalizePlaceholderKey(context.placeholder);
    const selections = state.dataset.placeholderSelections[key] || [];
    const existingIndex = selections.findIndex((item) => item.path === entry.path);
    if (existingIndex >= 0) {
      selections.splice(existingIndex, 1);
      showToast(`已移除 ${entry.name}`);
    } else {
      selections.push({
        name: entry.name,
        path: entry.path,
        mime_type: entry.mime_type,
        media_type: entry.media_type,
        url: resolveMediaUrl(entry),
      });
      showToast(`已添加 ${entry.name}`);
    }
    state.dataset.placeholderSelections[key] = selections;
    renderDatasetPlaceholderList();
    updateDatasetRunButton();
    loadModalMedia();
    return;
  }
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

function clearAllSelections() {
  state.selectedGroupId = null;
  state.selectedWorkflows = new Set();
  state.assignments = {};
  state.treeActivePath = null;
  state.selectedTreeNodes.clear();
  state.treeWorkflowIds = new Set();
  renderGroups();
  renderPlaceholders(null);
  renderWorkflows(null);
  renderWorkflowTree();
  updateRunButton();
  showToast("已取消所有选择");
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
    const totalWorkflows = Array.isArray(job.results) ? job.results.length : 0;
    const successWorkflows = Array.isArray(job.results)
      ? job.results.filter((result) => result.status === "success").length
      : 0;
    let summary = totalWorkflows ? `${successWorkflows}/${totalWorkflows} 成功` : "";
    if (remark) {
      summary = summary ? `${summary} | ${remark}` : remark;
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
      remarkCell.textContent = summary;
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
  } else if (tabId === "dataset") {
    loadDatasetWorkflows();
    loadDatasetsList();
    renderDatasetBuilder();
  }
}

function setupEventListeners() {
  refs.runButton.addEventListener("click", runBatch);
  refs.clearSelectionButton?.addEventListener("click", clearAllSelections);
  refs.refreshGroups.addEventListener("click", () => {
    showToast("刷新工作流分组...");
    Promise.all([loadGroups(), loadWorkflowTree()]);
  });
  refs.testServer.addEventListener("click", testServerConnection);
  refs.serverInput?.addEventListener("input", () => {
    state.dataset.serverUrl = getConfiguredServerUrl();
    updateDatasetServerStatus();
  });

  refs.datasetWorkflowSelect?.addEventListener("change", (event) => {
    setDatasetWorkflow(event.target.value);
  });

  refs.datasetNameInput?.addEventListener("input", (event) => {
    state.dataset.datasetName = event.target.value.trim();
    if (!state.dataset.appendMode) {
      state.dataset.newDatasetName = state.dataset.datasetName;
    }
    updateDatasetRunButton();
  });
  refs.datasetPromptField?.addEventListener("change", (event) => handleDatasetPromptFieldChange(event));
  refs.datasetPromptText?.addEventListener("input", (event) => handleDatasetPromptTextInput(event));
  refs.datasetAnnotationText?.addEventListener("input", (event) => handleDatasetAnnotationInput(event));

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

  refs.workflowSelectAllButton?.addEventListener("click", () => {
    selectAllTreeWorkflows();
  });

  refs.datasetWorkflowSelect?.addEventListener("change", (event) => {
    setDatasetWorkflow(event.target.value);
  });

  refs.datasetNameInput?.addEventListener("input", (event) => {
    state.dataset.datasetName = event.target.value.trim();
    updateDatasetRunButton();
  });

  refs.datasetAppendToggle?.addEventListener("change", (event) => {
    const checked = Boolean(event.target.checked);
    state.dataset.appendMode = checked;
    if (checked) {
      state.dataset.newDatasetName = state.dataset.datasetName;
      if (refs.datasetExistingSelect) {
        refs.datasetExistingSelect.disabled = false;
        if (!state.dataset.appendTarget) {
          const first = state.dataset.datasets[0]?.name;
          state.dataset.appendTarget = first || "";
          if (first) {
            refs.datasetExistingSelect.value = first;
          }
        }
      }
      if (state.dataset.appendTarget) {
        state.dataset.datasetName = state.dataset.appendTarget;
        if (refs.datasetNameInput) {
          refs.datasetNameInput.value = state.dataset.datasetName;
        }
      }
    } else {
      state.dataset.appendTarget = "";
      if (refs.datasetExistingSelect) {
        refs.datasetExistingSelect.disabled = true;
        refs.datasetExistingSelect.value = "";
      }
      state.dataset.datasetName = state.dataset.newDatasetName || "";
      if (refs.datasetNameInput) {
        refs.datasetNameInput.value = state.dataset.datasetName;
      }
    }
    updateDatasetRunButton();
    renderDatasetBuilder();
  });

  refs.datasetExistingSelect?.addEventListener("change", (event) => {
    state.dataset.appendTarget = event.target.value;
    if (state.dataset.appendMode && state.dataset.appendTarget) {
      state.dataset.datasetName = state.dataset.appendTarget;
      if (refs.datasetNameInput) {
        refs.datasetNameInput.value = state.dataset.appendTarget;
      }
    }
    updateDatasetRunButton();
  });

  refs.datasetRunButton?.addEventListener("click", runDataset);
  refs.datasetRefreshButton?.addEventListener("click", () => {
    loadDatasetsList();
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

  refs.datasetRunButton?.addEventListener("click", runDataset);
  refs.datasetRefreshButton?.addEventListener("click", () => {
    loadDatasetsList();
  });

  refs.datasetViewerClose?.addEventListener("click", () => {
    closeDatasetViewer();
  });

  refs.datasetPlaceholderContainer?.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) {
      return;
    }
    const placeholder = button.dataset.placeholder;
    if (!placeholder) {
      return;
    }
    if (button.dataset.action === "select") {
      openMediaModal(placeholder, button.dataset.type || "", { mode: "dataset", multi: true });
    } else if (button.dataset.action === "clear") {
      state.dataset.placeholderSelections[placeholder] = [];
      renderDatasetPlaceholderList();
      updateDatasetRunButton();
      showToast("已清空选择");
    } else if (button.dataset.action === "remove") {
      const index = Number(button.dataset.index);
      const selections = state.dataset.placeholderSelections[placeholder] || [];
      if (!Number.isNaN(index) && selections[index]) {
        selections.splice(index, 1);
        state.dataset.placeholderSelections[placeholder] = selections;
        renderDatasetPlaceholderList();
        updateDatasetRunButton();
        showToast("已移除素材");
      }
    }
  });

  refs.datasetList?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }
    const datasetName = button.dataset.name;
    if (!datasetName) {
      return;
    }
    if (button.dataset.action === "view") {
      viewDataset(datasetName);
    } else if (button.dataset.action === "delete") {
      deleteDataset(datasetName);
    }
  });

  refs.datasetViewerContent?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }
    if (button.dataset.action === "delete-pair") {
      const datasetName = button.dataset.dataset;
      const index = Number(button.dataset.index);
      if (datasetName && !Number.isNaN(index)) {
        if (confirm(`确认删除编号 ${String(index).padStart(3, "0")} 的数据对吗？`)) {
          deleteDatasetPairRequest(datasetName, index);
        }
      }
    }
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

  refs.previewClose?.addEventListener("click", () => {
    clearPreview();
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
  state.dataset.serverUrl = getConfiguredServerUrl();
  updateDatasetServerStatus();
  await Promise.all([loadGroups(), loadWorkflowTree(), loadDatasetWorkflows(), loadDatasetsList()]);
  renderDatasetBuilder();
  switchTab("workflows");
  startPolling();
}

bootstrap();
