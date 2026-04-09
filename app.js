const STORAGE_KEY = "day-recordings.v1";
const UI_PREF_KEY = "day-recordings.ui.v2";
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const PAGE_SIZE = 80;
const nativeAPI = window.dayRecordingsAPI || null;
let persistTimer = null;
let persistInFlight = Promise.resolve();
let saveStatusHideTimer = null;
let removeSettingsWheelGuard = null;

const state = {
  selectedDate: getDateKey(new Date()),
  monthView: startOfMonth(new Date()),
  onlyFavorites: false,
  onlyDuplicates: false,
  deletedOnly: false,
  searchQuery: "",
  typeFilter: "all",
  activeDuplicateKey: "",
  isTopMost: false,
  compactMode: false,
  ultraCompactMode: false,
  visibleCount: PAGE_SIZE,
  saveStatus: "空闲",
  recordsByDate: {},
  ui: {
    guideShown: false,
    skipDupImport: false,
    defaultLayout: "normal",
    closeToTray: false,
    minimizeToBall: true,
  },
};

const els = {
  monthLabel: document.getElementById("monthLabel"),
  calendarGrid: document.getElementById("calendarGrid"),
  selectedDateLabel: document.getElementById("selectedDateLabel"),
  timelineList: document.getElementById("timelineList"),
  timelineItemTemplate: document.getElementById("timelineItemTemplate"),
  prevMonthBtn: document.getElementById("prevMonthBtn"),
  nextMonthBtn: document.getElementById("nextMonthBtn"),
  dropZone: document.getElementById("dropZone"),
  fileInput: document.getElementById("fileInput"),
  tagInput: document.getElementById("tagInput"),
  textInput: document.getElementById("textInput"),
  saveTextBtn: document.getElementById("saveTextBtn"),
  clearDateBtn: document.getElementById("clearDateBtn"),
  exportBtn: document.getElementById("exportBtn"),
  importInput: document.getElementById("importInput"),
  favOnlyCheck: document.getElementById("favOnlyCheck"),
  layoutModeBtn: document.getElementById("layoutModeBtn"),
  topMostBtn: document.getElementById("topMostBtn"),
  searchInput: document.getElementById("searchInput"),
  typeFilter: document.getElementById("typeFilter"),
  dupOnlyCheck: document.getElementById("dupOnlyCheck"),
  deletedOnlyCheck: document.getElementById("deletedOnlyCheck"),
  loadMoreBtn: document.getElementById("loadMoreBtn"),
  saveStatusBar: document.getElementById("saveStatusBar"),
  toastContainer: document.getElementById("toastContainer"),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsDialog: document.getElementById("settingsDialog"),
  skipDupImportCheck: document.getElementById("skipDupImportCheck"),
  closeToTrayCheck: document.getElementById("closeToTrayCheck"),
  minimizeToBallCheck: document.getElementById("minimizeToBallCheck"),
  defaultLayoutSelect: document.getElementById("defaultLayoutSelect"),
  pathFromInput: document.getElementById("pathFromInput"),
  pathToInput: document.getElementById("pathToInput"),
  applyPathMapBtn: document.getElementById("applyPathMapBtn"),
  saveSettingsBtn: document.getElementById("saveSettingsBtn"),
  guideDialog: document.getElementById("guideDialog"),
};

bindEvents();
initApp();

async function initApp() {
  loadUIPreferences();
  applyDefaultLayout();
  renderAll();

  const [records] = await Promise.all([
    loadRecords(),
    syncTopMostState(),
    syncCloseToTrayState(),
    syncMinimizeToBallState(),
  ]);
  state.recordsByDate = records;

  setTimeout(() => {
    refreshDuplicateFlags();
    renderAll();
    maybeShowGuide();
  }, 0);
}

function bindEvents() {
  els.prevMonthBtn.addEventListener("click", () => {
    state.monthView = addMonths(state.monthView, -1);
    renderCalendar();
  });

  els.nextMonthBtn.addEventListener("click", () => {
    state.monthView = addMonths(state.monthView, 1);
    renderCalendar();
  });

  els.fileInput.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) {
      return;
    }
    await addFileRecords(files);
    event.target.value = "";
  });

  els.saveTextBtn.addEventListener("click", () => {
    const raw = els.textInput.value.trim();
    if (!raw) {
      return;
    }
    addTextRecord(raw);
    els.textInput.value = "";
  });

  els.textInput.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.key === "Enter") {
      event.preventDefault();
      els.saveTextBtn.click();
    }
  });

  els.clearDateBtn.addEventListener("click", () => {
    const list = state.recordsByDate[state.selectedDate] || [];
    if (!list.length) {
      return;
    }
    const ok = window.confirm(`确认清空 ${state.selectedDate} 的全部记录吗？`);
    if (!ok) {
      return;
    }
    delete state.recordsByDate[state.selectedDate];
    refreshDuplicateFlags();
    persist();
    showToast("已清空当天记录");
    renderAll();
  });

  els.favOnlyCheck.addEventListener("change", (event) => {
    state.onlyFavorites = event.target.checked;
    resetPagination();
    renderTimeline();
  });

  els.dupOnlyCheck.addEventListener("change", (event) => {
    state.onlyDuplicates = event.target.checked;
    resetPagination();
    renderTimeline();
  });

  els.deletedOnlyCheck.addEventListener("change", (event) => {
    state.deletedOnly = event.target.checked;
    resetPagination();
    renderTimeline();
  });

  els.searchInput.addEventListener("input", (event) => {
    state.searchQuery = String(event.target.value || "").trim().toLowerCase();
    resetPagination();
    renderTimeline();
  });

  els.typeFilter.addEventListener("change", (event) => {
    state.typeFilter = String(event.target.value || "all");
    resetPagination();
    renderTimeline();
  });

  els.loadMoreBtn.addEventListener("click", () => {
    state.visibleCount += PAGE_SIZE;
    renderTimeline();
  });

  els.exportBtn.addEventListener("click", exportBackup);

  els.importInput.addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) {
      return;
    }

    try {
      await importBackup(file);
    } finally {
      event.target.value = "";
    }
  });

  els.topMostBtn.addEventListener("click", async () => {
    if (!nativeAPI || typeof nativeAPI.setTopMost !== "function") {
      return;
    }
    const result = await nativeAPI.setTopMost(!state.isTopMost);
    if (result && result.ok) {
      state.isTopMost = Boolean(result.value);
      updateTopMostButton();
    }
  });

  els.layoutModeBtn.addEventListener("click", () => {
    cycleLayoutMode();
  });

  els.settingsBtn.addEventListener("click", () => {
    openSettings();
  });

  els.saveSettingsBtn.addEventListener("click", () => {
    saveSettings();
  });

  els.applyPathMapBtn.addEventListener("click", () => {
    applyPathRemap();
  });

  if (nativeAPI && typeof nativeAPI.onQuickEntryFocus === "function") {
    nativeAPI.onQuickEntryFocus(() => {
      els.textInput.focus();
      els.textInput.select();
    });
  }

  if (nativeAPI && typeof nativeAPI.onRecordsChanged === "function") {
    nativeAPI.onRecordsChanged(async (payload) => {
      const next = await loadRecords();
      state.recordsByDate = next;
      refreshDuplicateFlags();
      resetPagination();
      renderAll();
      if (payload && payload.source === "ball" && payload.added) {
        showToast(`悬浮球已记录 ${payload.added} 条`, "success");
      }
    });
  }

  window.addEventListener("keydown", (event) => {
    if (event.key === "/" && document.activeElement !== els.textInput && document.activeElement !== els.searchInput) {
      event.preventDefault();
      els.searchInput.focus();
    }
  });

  setupDropZone();
  updateTopMostButton();
  updateLayoutModeButton();
  setSaveStatus("空闲", "info", 1);
}

function setupDropZone() {
  const enter = (event) => {
    event.preventDefault();
    els.dropZone.classList.add("drag-over");
  };

  const leave = (event) => {
    event.preventDefault();
    els.dropZone.classList.remove("drag-over");
  };

  ["dragenter", "dragover"].forEach((name) => {
    els.dropZone.addEventListener(name, enter);
  });

  ["dragleave", "dragend"].forEach((name) => {
    els.dropZone.addEventListener(name, leave);
  });

  els.dropZone.addEventListener("drop", async (event) => {
    event.preventDefault();
    els.dropZone.classList.remove("drag-over");
    const dt = event.dataTransfer;
    if (!dt) {
      return;
    }

    const files = Array.from(dt.files || []);
    if (files.length) {
      await addFileRecords(files);
      return;
    }

    const text = dt.getData("text/plain").trim();
    const url = dt.getData("text/uri-list").trim();
    const payload = (url || text).trim();
    if (payload) {
      addTextRecord(payload);
    }
  });

  window.addEventListener("dragover", (event) => {
    event.preventDefault();
  });

  window.addEventListener("drop", (event) => {
    event.preventDefault();
  });
}

function renderAll() {
  renderCalendar();
  renderTimeline();
  updateTopMostButton();
  applyCompactMode();
  updateLayoutModeButton();
}

function renderCalendar() {
  const monthDate = state.monthView;
  const y = monthDate.getFullYear();
  const m = monthDate.getMonth();
  const todayKey = getDateKey(new Date());
  els.monthLabel.textContent = `${y}年${String(m + 1).padStart(2, "0")}月`;
  els.calendarGrid.innerHTML = "";

  WEEKDAYS.forEach((w) => {
    const head = document.createElement("div");
    head.className = "weekday";
    head.textContent = w;
    els.calendarGrid.appendChild(head);
  });

  const first = new Date(y, m, 1);
  const offset = (first.getDay() + 6) % 7;
  const visibleStart = new Date(y, m, 1 - offset);

  for (let i = 0; i < 42; i += 1) {
    const cur = new Date(visibleStart.getFullYear(), visibleStart.getMonth(), visibleStart.getDate() + i);
    const dateKey = getDateKey(cur);
    const btn = document.createElement("button");
    btn.className = "day-cell";
    btn.type = "button";
    btn.textContent = String(cur.getDate());

    if (cur.getMonth() !== m) {
      btn.classList.add("muted");
    }
    if (dateKey === state.selectedDate) {
      btn.classList.add("active");
    }
    if (dateKey === todayKey) {
      btn.classList.add("today");
    }

    const hasVisible = (state.recordsByDate[dateKey] || []).some((r) => !r.deletedAt);
    if (hasVisible) {
      btn.classList.add("has-items");
    }

    btn.addEventListener("click", () => {
      state.selectedDate = dateKey;
      state.monthView = startOfMonth(cur);
      resetPagination();
      renderAll();
    });

    els.calendarGrid.appendChild(btn);
  }
}

function renderTimeline() {
  const dateText = formatDateDisplay(state.selectedDate);
  els.selectedDateLabel.textContent = `${dateText} 的记录`;

  const all = [...(state.recordsByDate[state.selectedDate] || [])]
    .sort((a, b) => b.createdAt - a.createdAt)
    .filter((item) => (state.deletedOnly ? Boolean(item.deletedAt) : !item.deletedAt))
    .filter((item) => (state.onlyFavorites ? item.favorite : true))
    .filter((item) => (state.onlyDuplicates ? item.isDuplicate : true))
    .filter((item) => (state.typeFilter === "all" ? true : item.type === state.typeFilter))
    .filter((item) => filterBySearch(item, state.searchQuery));

  const list = all.slice(0, state.visibleCount);
  els.timelineList.innerHTML = "";

  els.loadMoreBtn.style.display = all.length > list.length ? "block" : "none";

  if (!list.length) {
    const li = document.createElement("li");
    li.className = "empty-tip";
    li.textContent = state.deletedOnly
      ? "回收站为空。"
      : "当天暂无记录，试试拖入文件、文字或链接。";
    els.timelineList.appendChild(li);
    return;
  }

  list.forEach((record) => {
    const frag = els.timelineItemTemplate.content.cloneNode(true);
    const item = frag.querySelector(".timeline-item");
    const time = frag.querySelector(".timeline-time");
    const type = frag.querySelector(".timeline-type");
    const content = frag.querySelector(".timeline-content");
    const tags = frag.querySelector(".timeline-tags");
    const star = frag.querySelector(".star-btn");
    const del = frag.querySelector(".delete-btn");

    time.textContent = formatTime(record.createdAt);
    type.textContent = typeText(record.type);

    if (record.tags && record.tags.length) {
      const tagWrap = document.createElement("div");
      tagWrap.className = "record-tags";
      record.tags.forEach((tag) => {
        const t = document.createElement("button");
        t.className = "tag-chip";
        t.type = "button";
        t.textContent = `#${tag}`;
        t.addEventListener("click", () => {
          els.searchInput.value = tag;
          state.searchQuery = tag.toLowerCase();
          resetPagination();
          renderTimeline();
        });
        tagWrap.appendChild(t);
      });
      content.appendChild(tagWrap);
    }

    if (record.isDuplicate) {
      const dup = document.createElement("button");
      dup.className = "dup-badge";
      dup.type = "button";
      dup.textContent = "重复";
      const key = duplicateKey(record);
      if (state.activeDuplicateKey && state.activeDuplicateKey === key) {
        dup.classList.add("active");
      }
      dup.addEventListener("click", () => {
        if (!key) {
          return;
        }
        state.activeDuplicateKey = state.activeDuplicateKey === key ? "" : key;
        renderTimeline();
      });
      tags.prepend(dup);
    }

    const recordDupKey = duplicateKey(record);
    if (state.activeDuplicateKey && recordDupKey && state.activeDuplicateKey === recordDupKey) {
      item.classList.add("dup-focus");
    }

    if (record.favorite) {
      star.classList.add("active");
      star.textContent = "★";
    }

    content.appendChild(renderRecordContent(record));

    star.addEventListener("click", () => {
      record.favorite = !record.favorite;
      persist();
      renderTimeline();
    });

    if (state.deletedOnly) {
      del.textContent = "彻底删除";
      const restore = document.createElement("button");
      restore.className = "ghost-btn";
      restore.textContent = "恢复";
      restore.addEventListener("click", () => restoreRecord(record.id));
      tags.appendChild(restore);
      del.addEventListener("click", () => removeRecord(record.id, true));
    } else {
      del.textContent = "删除";
      del.addEventListener("click", () => removeRecord(record.id, false));
    }

    item.dataset.recordId = record.id;
    els.timelineList.appendChild(frag);
  });
}

function renderRecordContent(record) {
  if (record.type === "file") {
    const box = document.createElement("div");
    const name = document.createElement("div");
    name.textContent = `文件: ${record.fileName}`;
    const details = document.createElement("div");
    details.style.color = "#677489";
    details.style.fontSize = "13px";

    const locationText = record.filePath
      ? ` | 路径: ${record.filePath}`
      : (record.relativePath ? ` | 路径: ${record.relativePath}` : "");
    const missingText = record.pathMissing ? " | 文件失效" : "";
    details.textContent = `${formatSize(record.fileSize)} | ${record.mimeType || "未知类型"}${locationText}${missingText}`;

    box.appendChild(name);
    box.appendChild(details);

    if (record.mimeType && record.mimeType.startsWith("image/") && record.filePath) {
      const img = document.createElement("img");
      img.className = "preview-image";
      img.loading = "lazy";
      img.src = pathToFileURL(record.filePath);
      img.alt = record.fileName;
      box.appendChild(img);
    }

    if (record.filePath && nativeAPI) {
      const openBtn = document.createElement("button");
      openBtn.className = "ghost-btn";
      openBtn.textContent = "打开文件";
      openBtn.addEventListener("click", async () => {
        const result = await nativeAPI.openFile(record.filePath);
        if (!result || !result.ok) {
          record.pathMissing = true;
          persist();
          renderTimeline();
          const msg = result && result.exists === false
            ? "文件不存在，可能已被移动或删除。"
            : "打开文件失败，请检查路径权限。";
          showToast(msg, "warning");
        }
      });
      const copyBtn = document.createElement("button");
      copyBtn.className = "ghost-btn";
      copyBtn.textContent = "复制路径";
      copyBtn.addEventListener("click", async () => {
        const ok = await copyTextToClipboard(record.filePath);
        showToast(ok ? "已复制完整路径" : "复制失败，请重试", ok ? "success" : "warning");
      });
      box.appendChild(openBtn);
      box.appendChild(copyBtn);
      return box;
    }

    const link = document.createElement("a");
    link.href = record.fileData || "#";
    link.download = record.fileName;
    link.textContent = "下载/打开";
    box.appendChild(link);
    return box;
  }

  const isURL = maybeURL(record.text);
  if (isURL) {
    const a = document.createElement("a");
    a.href = record.text;
    a.target = "_self";
    a.rel = "noopener noreferrer";
    a.textContent = record.text;
    if (nativeAPI) {
      a.addEventListener("click", async (event) => {
        event.preventDefault();
        await nativeAPI.openExternalURL(record.text);
      });
    }
    return a;
  }

  const text = document.createElement("div");
  text.textContent = record.text;
  return text;
}

function addTextRecord(raw) {
  const targetDate = getDateKey(new Date());
  const item = {
    id: crypto.randomUUID(),
    type: maybeURL(raw) ? "link" : "text",
    text: raw,
    tags: parseTags(els.tagInput.value),
    favorite: false,
    deletedAt: 0,
    createdAt: Date.now(),
  };
  addRecord(item, true, targetDate);
  els.tagInput.value = "";
}

async function addFileRecords(files) {
  const targetDate = getDateKey(new Date());
  const tagList = parseTags(els.tagInput.value);
  const records = [];
  for (const file of files) {
    if (isURLShortcut(file)) {
      const shortcutURL = await parseURLShortcut(file);
      if (shortcutURL) {
        records.push({
          id: crypto.randomUUID(),
          type: "link",
          text: shortcutURL,
          tags: tagList,
          favorite: false,
          deletedAt: 0,
          createdAt: Date.now(),
        });
        continue;
      }
    }

    if (nativeAPI) {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const saved = await nativeAPI.saveDroppedFile({
        fileName: file.name,
        mimeType: file.type,
        bytes,
      });
      records.push({
        id: crypto.randomUUID(),
        type: "file",
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        filePath: saved.absPath,
        relativePath: saved.relativePath,
        sha256: saved.sha256 || "",
        tags: tagList,
        favorite: false,
        deletedAt: 0,
        createdAt: Date.now(),
      });
    } else {
      const data = await fileToDataURL(file);
      records.push({
        id: crypto.randomUUID(),
        type: "file",
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        fileData: data,
        tags: tagList,
        favorite: false,
        deletedAt: 0,
        createdAt: Date.now(),
      });
    }
  }

  records.forEach((item) => addRecord(item, false, targetDate));
  els.tagInput.value = "";
  state.selectedDate = targetDate;
  state.monthView = startOfMonth(new Date());
  refreshDuplicateFlags();
  persist();
  resetPagination();
  renderAll();
}

function addRecord(record, shouldRender = true, targetDate = state.selectedDate) {
  if (!state.recordsByDate[targetDate]) {
    state.recordsByDate[targetDate] = [];
  }
  state.recordsByDate[targetDate].push(record);
  state.selectedDate = targetDate;
  state.monthView = startOfMonth(new Date(targetDate));
  refreshDuplicateFlags();
  persist();
  if (shouldRender) {
    resetPagination();
    renderAll();
  }
}

function removeRecord(recordId, hardDelete = false) {
  const list = state.recordsByDate[state.selectedDate] || [];
  if (hardDelete) {
    const next = list.filter((item) => item.id !== recordId);
    state.recordsByDate[state.selectedDate] = next;
    if (!next.length) {
      delete state.recordsByDate[state.selectedDate];
    }
    showToast("已彻底删除", "success");
  } else {
    const hit = list.find((item) => item.id === recordId);
    if (hit) {
      hit.deletedAt = Date.now();
      showToast("已移入回收站", "success");
    }
  }

  refreshDuplicateFlags();
  persist();
  renderAll();
}

function restoreRecord(recordId) {
  const list = state.recordsByDate[state.selectedDate] || [];
  const hit = list.find((item) => item.id === recordId);
  if (!hit) {
    return;
  }
  hit.deletedAt = 0;
  refreshDuplicateFlags();
  persist();
  showToast("已恢复记录", "success");
  renderAll();
}

async function persist() {
  if (nativeAPI) {
    setSaveStatus("保存中...", "info");
    if (persistTimer) {
      clearTimeout(persistTimer);
    }
    const snapshot = JSON.parse(JSON.stringify(state.recordsByDate));
    persistInFlight = persistInFlight.then(() => new Promise((resolve) => {
      persistTimer = setTimeout(async () => {
        try {
          const result = await nativeAPI.saveRecords(snapshot);
          if (!result || result.ok === false) {
            setSaveStatus("保存失败", "warning");
            showToast("保存失败，请稍后重试", "warning");
          } else {
            setSaveStatus("已保存", "success", 1200);
          }
        } finally {
          persistTimer = null;
          resolve();
        }
      }, 120);
    }));
    await persistInFlight;
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.recordsByDate));
  setSaveStatus("已保存", "success", 1200);
}

async function loadRecords() {
  if (nativeAPI) {
    const data = await nativeAPI.loadRecords();
    return data && typeof data === "object" ? data : {};
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    console.error("读取本地记录失败", error);
    return {};
  }
}

function getDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDateDisplay(dateKey) {
  const [y, m, d] = dateKey.split("-");
  return `${y}年${m}月${d}日`;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function typeText(type) {
  const map = {
    text: "文本",
    link: "链接",
    file: "文件",
  };
  return map[type] || "记录";
}

function maybeURL(text) {
  try {
    const u = new URL(text);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function loadUIPreferences() {
  try {
    const raw = localStorage.getItem(UI_PREF_KEY);
    if (!raw) {
      return;
    }
    const prefs = JSON.parse(raw);
    state.compactMode = Boolean(prefs && prefs.compactMode);
    state.ultraCompactMode = Boolean(prefs && prefs.ultraCompactMode);
    state.ui.guideShown = Boolean(prefs && prefs.guideShown);
    state.ui.skipDupImport = Boolean(prefs && prefs.skipDupImport);
    state.ui.defaultLayout = String((prefs && prefs.defaultLayout) || "normal");
    state.ui.closeToTray = Boolean(prefs && prefs.closeToTray);
    state.ui.minimizeToBall = prefs && typeof prefs.minimizeToBall === "boolean" ? prefs.minimizeToBall : true;
    normalizeLayoutMode();
  } catch {
    state.compactMode = false;
    state.ultraCompactMode = false;
  }
}

function saveUIPreferences() {
  try {
    localStorage.setItem(UI_PREF_KEY, JSON.stringify({
      compactMode: state.compactMode,
      ultraCompactMode: state.ultraCompactMode,
      guideShown: state.ui.guideShown,
      skipDupImport: state.ui.skipDupImport,
      defaultLayout: state.ui.defaultLayout,
      closeToTray: state.ui.closeToTray,
      minimizeToBall: state.ui.minimizeToBall,
    }));
  } catch {
    // Ignore preference persistence errors.
  }
}

function applyCompactMode() {
  normalizeLayoutMode();
  document.body.classList.toggle("compact-mode", state.compactMode);
  document.body.classList.toggle("ultra-compact-mode", state.ultraCompactMode);
}

function updateLayoutModeButton() {
  if (!els.layoutModeBtn) {
    return;
  }
  const label = state.ultraCompactMode ? "超紧凑" : (state.compactMode ? "紧凑" : "普通");
  els.layoutModeBtn.textContent = `布局: ${label}`;
  els.layoutModeBtn.classList.toggle("active", state.compactMode || state.ultraCompactMode);
}

function normalizeLayoutMode() {
  if (state.ultraCompactMode) {
    state.compactMode = false;
  }
}

function cycleLayoutMode() {
  if (!state.compactMode && !state.ultraCompactMode) {
    state.compactMode = true;
    state.ultraCompactMode = false;
  } else if (state.compactMode && !state.ultraCompactMode) {
    state.compactMode = false;
    state.ultraCompactMode = true;
  } else {
    state.compactMode = false;
    state.ultraCompactMode = false;
  }
  state.ui.defaultLayout = getCurrentLayoutMode();
  saveUIPreferences();
  applyCompactMode();
  updateLayoutModeButton();
}

function applyDefaultLayout() {
  setLayoutMode(state.ui.defaultLayout);
}

async function syncTopMostState() {
  if (!nativeAPI || typeof nativeAPI.getTopMost !== "function") {
    state.isTopMost = false;
    return;
  }
  const result = await nativeAPI.getTopMost();
  state.isTopMost = Boolean(result && result.ok && result.value);
}

async function syncCloseToTrayState() {
  if (!nativeAPI || typeof nativeAPI.setCloseToTray !== "function") {
    return;
  }
  const result = await nativeAPI.setCloseToTray(state.ui.closeToTray);
  if (result && result.ok) {
    state.ui.closeToTray = Boolean(result.value);
  }
}

async function syncMinimizeToBallState() {
  if (!nativeAPI || typeof nativeAPI.setMinimizeToBall !== "function") {
    return;
  }
  const result = await nativeAPI.setMinimizeToBall(state.ui.minimizeToBall);
  if (result && result.ok) {
    state.ui.minimizeToBall = Boolean(result.value);
  }
}

function updateTopMostButton() {
  if (!els.topMostBtn) {
    return;
  }
  const supported = nativeAPI && typeof nativeAPI.setTopMost === "function";
  els.topMostBtn.disabled = !supported;
  if (!supported) {
    els.topMostBtn.classList.remove("active");
    els.topMostBtn.textContent = "置顶: 不可用";
    return;
  }
  els.topMostBtn.textContent = `置顶: ${state.isTopMost ? "开" : "关"}`;
  els.topMostBtn.classList.toggle("active", state.isTopMost);
}

async function copyTextToClipboard(text) {
  if (!text) {
    return false;
  }
  if (nativeAPI && typeof nativeAPI.copyText === "function") {
    const result = await nativeAPI.copyText(String(text));
    return Boolean(result && result.ok);
  }
  try {
    await navigator.clipboard.writeText(String(text));
    return true;
  } catch {
    return false;
  }
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function isURLShortcut(file) {
  if (!file || typeof file.name !== "string") {
    return false;
  }
  return file.name.toLowerCase().endsWith(".url");
}

async function parseURLShortcut(file) {
  try {
    const text = await file.text();
    const match = text.match(/^\s*URL\s*=\s*(.+)\s*$/im);
    if (!match) {
      return "";
    }
    const value = match[1].trim();
    return maybeURL(value) ? value : "";
  } catch {
    return "";
  }
}

function formatSize(size) {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 ** 2) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 ** 2).toFixed(1)} MB`;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date, delta) {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function exportBackup() {
  const payload = {
    version: 2,
    exportedAt: Date.now(),
    recordsByDate: state.recordsByDate,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `day-recordings-backup-${state.selectedDate}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast("已导出备份", "success");
}

async function importBackup(file) {
  const text = await file.text();
  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch {
    showToast("导入失败：文件不是合法的 JSON。", "warning");
    return;
  }

  const source = parsed && typeof parsed === "object" && parsed.recordsByDate && typeof parsed.recordsByDate === "object"
    ? parsed.recordsByDate
    : parsed;

  if (!source || typeof source !== "object") {
    showToast("导入失败：备份格式不正确。", "warning");
    return;
  }

  const existingKeys = new Set();
  if (state.ui.skipDupImport) {
    for (const list of Object.values(state.recordsByDate)) {
      (list || []).forEach((r) => existingKeys.add(duplicateKey(r)));
    }
  }

  let importedCount = 0;
  let skippedDup = 0;

  for (const [dateKey, list] of Object.entries(source)) {
    if (!isDateKey(dateKey) || !Array.isArray(list)) {
      continue;
    }
    if (!state.recordsByDate[dateKey]) {
      state.recordsByDate[dateKey] = [];
    }

    for (const item of list) {
      const normalized = normalizeRecord(item);
      if (!normalized) {
        continue;
      }

      if (state.ui.skipDupImport) {
        const key = duplicateKey(normalized);
        if (key && existingKeys.has(key)) {
          skippedDup += 1;
          continue;
        }
        if (key) {
          existingKeys.add(key);
        }
      }

      state.recordsByDate[dateKey].push(normalized);
      importedCount += 1;
    }
  }

  refreshDuplicateFlags();
  await persist();
  resetPagination();
  renderAll();
  showToast(`导入完成：${importedCount} 条，跳过重复 ${skippedDup} 条`, "success");
}

function normalizeRecord(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const base = {
    id: typeof item.id === "string" && item.id ? item.id : crypto.randomUUID(),
    favorite: Boolean(item.favorite),
    createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
    isDuplicate: Boolean(item.isDuplicate),
    deletedAt: Number.isFinite(item.deletedAt) ? item.deletedAt : 0,
    tags: Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === "string").map((t) => t.trim()).filter(Boolean) : [],
  };

  if (item.type === "file") {
    if (typeof item.fileName !== "string") {
      return null;
    }
    return {
      ...base,
      type: "file",
      fileName: item.fileName,
      fileSize: Number.isFinite(item.fileSize) ? item.fileSize : 0,
      mimeType: typeof item.mimeType === "string" ? item.mimeType : "",
      fileData: typeof item.fileData === "string" ? item.fileData : "",
      filePath: typeof item.filePath === "string" ? item.filePath : "",
      relativePath: typeof item.relativePath === "string" ? item.relativePath : "",
      sha256: typeof item.sha256 === "string" ? item.sha256 : "",
      pathMissing: Boolean(item.pathMissing),
    };
  }

  if (item.type === "link" || item.type === "text") {
    if (typeof item.text !== "string") {
      return null;
    }
    return {
      ...base,
      type: maybeURL(item.text) ? "link" : "text",
      text: item.text,
    };
  }

  if (typeof item.text === "string") {
    return {
      ...base,
      type: maybeURL(item.text) ? "link" : "text",
      text: item.text,
    };
  }

  return null;
}

function isDateKey(text) {
  return /^\d{4}-\d{2}-\d{2}$/.test(text);
}

function refreshDuplicateFlags() {
  const counts = new Map();
  const allRecords = [];

  for (const list of Object.values(state.recordsByDate)) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const record of list) {
      allRecords.push(record);
      const key = duplicateKey(record);
      if (!key) {
        continue;
      }
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  for (const record of allRecords) {
    const key = duplicateKey(record);
    record.isDuplicate = Boolean(key && (counts.get(key) || 0) > 1);
  }

  if (state.activeDuplicateKey && (counts.get(state.activeDuplicateKey) || 0) <= 1) {
    state.activeDuplicateKey = "";
  }
}

function duplicateKey(record) {
  if (!record || typeof record !== "object" || record.deletedAt) {
    return "";
  }

  if (record.type === "file") {
    if (record.sha256) {
      return `file-hash:${record.sha256}`;
    }
    return `file-legacy:${record.fileName || ""}:${record.fileSize || 0}`;
  }

  if (record.type === "text" || record.type === "link") {
    return `${record.type}:${(record.text || "").trim()}`;
  }

  return "";
}

function parseTags(raw) {
  return String(raw || "")
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function filterBySearch(item, query) {
  if (!query) {
    return true;
  }
  const parts = [
    item.text,
    item.fileName,
    item.filePath,
    item.relativePath,
    ...(Array.isArray(item.tags) ? item.tags : []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return parts.includes(query);
}

function resetPagination() {
  state.visibleCount = PAGE_SIZE;
}

function setSaveStatus(text, type = "info", autoHideMs = 0) {
  state.saveStatus = text;
  if (els.saveStatusBar) {
    els.saveStatusBar.textContent = `状态：${text}`;
    els.saveStatusBar.classList.remove("success", "warning", "show");
    if (type === "success" || type === "warning") {
      els.saveStatusBar.classList.add(type);
    }
    els.saveStatusBar.classList.add("show");
  }

  if (saveStatusHideTimer) {
    clearTimeout(saveStatusHideTimer);
    saveStatusHideTimer = null;
  }

  if (autoHideMs > 0 && els.saveStatusBar) {
    saveStatusHideTimer = setTimeout(() => {
      els.saveStatusBar.classList.remove("show");
      saveStatusHideTimer = null;
    }, autoHideMs);
  }
}

function showToast(text, type = "info") {
  if (!els.toastContainer) {
    return;
  }
  const div = document.createElement("div");
  div.className = `toast-item ${type}`;
  div.textContent = text;
  els.toastContainer.appendChild(div);
  setTimeout(() => {
    div.classList.add("hide");
    setTimeout(() => div.remove(), 240);
  }, 1800);
}

function pathToFileURL(absPath) {
  const normalized = String(absPath || "").replace(/\\/g, "/");
  return encodeURI(`file:///${normalized}`);
}

function openSettings() {
  if (!els.settingsDialog) {
    return;
  }
  els.skipDupImportCheck.checked = state.ui.skipDupImport;
  els.closeToTrayCheck.checked = state.ui.closeToTray;
  els.minimizeToBallCheck.checked = state.ui.minimizeToBall;
  els.defaultLayoutSelect.value = getCurrentLayoutMode();
  if (removeSettingsWheelGuard) {
    removeSettingsWheelGuard();
    removeSettingsWheelGuard = null;
  }
  removeSettingsWheelGuard = attachModalWheelGuard(els.settingsDialog);
  document.body.classList.add("modal-lock");
  els.settingsDialog.addEventListener("close", () => {
    if (removeSettingsWheelGuard) {
      removeSettingsWheelGuard();
      removeSettingsWheelGuard = null;
    }
    document.body.classList.remove("modal-lock");
  }, { once: true });
  els.settingsDialog.showModal();
}

function saveSettings() {
  state.ui.skipDupImport = els.skipDupImportCheck.checked;
  state.ui.closeToTray = Boolean(els.closeToTrayCheck.checked);
  state.ui.minimizeToBall = Boolean(els.minimizeToBallCheck.checked);
  state.ui.defaultLayout = String(els.defaultLayoutSelect.value || "normal");
  setLayoutMode(state.ui.defaultLayout);
  applyCompactMode();
  updateLayoutModeButton();
  if (nativeAPI && typeof nativeAPI.setCloseToTray === "function") {
    nativeAPI.setCloseToTray(state.ui.closeToTray);
  }
  if (nativeAPI && typeof nativeAPI.setMinimizeToBall === "function") {
    nativeAPI.setMinimizeToBall(state.ui.minimizeToBall);
  }
  saveUIPreferences();
  showToast("设置已保存", "success");
  if (els.settingsDialog.open) {
    els.settingsDialog.close();
  }
}

function getCurrentLayoutMode() {
  return state.ultraCompactMode ? "ultra" : (state.compactMode ? "compact" : "normal");
}

function setLayoutMode(mode) {
  if (mode === "compact") {
    state.compactMode = true;
    state.ultraCompactMode = false;
    return;
  }
  if (mode === "ultra") {
    state.compactMode = false;
    state.ultraCompactMode = true;
    return;
  }
  state.compactMode = false;
  state.ultraCompactMode = false;
}

function applyPathRemap() {
  const fromRoot = String(els.pathFromInput.value || "").trim();
  const toRoot = String(els.pathToInput.value || "").trim();
  if (!fromRoot || !toRoot) {
    showToast("请先填写旧路径和新路径", "warning");
    return;
  }

  let changed = 0;
  const fromLower = fromRoot.toLowerCase();
  for (const list of Object.values(state.recordsByDate)) {
    for (const record of list || []) {
      if (record.type !== "file" || !record.filePath) {
        continue;
      }
      const lower = record.filePath.toLowerCase();
      if (!lower.startsWith(fromLower)) {
        continue;
      }
      record.filePath = toRoot + record.filePath.slice(fromRoot.length);
      record.pathMissing = false;
      changed += 1;
    }
  }

  if (!changed) {
    showToast("没有匹配到可重映射的文件路径", "warning");
    return;
  }
  persist();
  renderTimeline();
  showToast(`已重映射 ${changed} 条文件路径`, "success");
}

function maybeShowGuide() {
  if (!els.guideDialog || state.ui.guideShown) {
    return;
  }
  const wheelBlocker = (event) => {
    event.preventDefault();
  };
  document.body.classList.add("modal-lock");
  document.addEventListener("wheel", wheelBlocker, { passive: false });
  els.guideDialog.addEventListener("close", () => {
    document.removeEventListener("wheel", wheelBlocker);
    document.body.classList.remove("modal-lock");
    state.ui.guideShown = true;
    saveUIPreferences();
  }, { once: true });
  els.guideDialog.showModal();
}

function attachModalWheelGuard(dialog) {
  const onWheel = (event) => {
    if (!dialog.open) {
      return;
    }
    if (!dialog.contains(event.target)) {
      event.preventDefault();
    }
  };
  document.addEventListener("wheel", onWheel, { passive: false, capture: true });
  return () => document.removeEventListener("wheel", onWheel, { capture: true });
}
