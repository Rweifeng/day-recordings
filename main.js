const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  clipboard,
  Tray,
  Menu,
  globalShortcut,
  nativeImage,
  screen,
} = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const APP_DATA_DIR = path.join(app.getPath("userData"), "day-recordings-data");
const LEGACY_APP_DATA_DIR = path.join(process.cwd(), "day-recordings-data");
const RECORDS_PATH = path.join(APP_DATA_DIR, "records.json");
const FILES_DIR = path.join(APP_DATA_DIR, "files");
const BACKUP_DIR = path.join(APP_DATA_DIR, "backups");
const LAST_BACKUP_META = path.join(APP_DATA_DIR, "last-backup.json");
const SETTINGS_PATH = path.join(APP_DATA_DIR, "settings.json");
const isWidgetMode = process.argv.includes("--widget");
const windowMinWidth = isWidgetMode ? 360 : 520;
const windowMinHeight = isWidgetMode ? 280 : 360;
const APP_ICON_PNG_PATH = path.join(__dirname, "assets", "icon.png");
const APP_ICON_ICO_PATH = path.join(__dirname, "assets", "icon.ico");
let isShuttingDown = false;
let saveQueue = Promise.resolve();
let tray = null;
let minimizeToTrayOnClose = false;
let minimizeToBallOnMinimize = true;
let ballWindow = null;
let mainWindow = null;
let legacyMigrated = false;
let settingsLoaded = false;
let customFilesDir = "";

function createWindow() {
  const win = new BrowserWindow({
    width: windowMinWidth,
    height: windowMinHeight,
    minWidth: windowMinWidth,
    minHeight: windowMinHeight,
    alwaysOnTop: isWidgetMode,
    skipTaskbar: isWidgetMode,
    autoHideMenuBar: true,
    icon: process.platform === "win32" ? APP_ICON_ICO_PATH : APP_ICON_PNG_PATH,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile("index.html");
  win.on("minimize", (event) => {
    if (!minimizeToBallOnMinimize || isShuttingDown) {
      return;
    }
    event.preventDefault();
    win.hide();
    showBallWindow();
  });
  win.on("close", (event) => {
    if (isShuttingDown) {
      return;
    }
    if (minimizeToTrayOnClose) {
      event.preventDefault();
      win.hide();
      showBallWindow(true);
      return;
    }
    // If close-to-tray is disabled, close should fully quit app and remove tray icon.
    event.preventDefault();
    shutdownApp();
  });
  win.on("show", () => hideBallWindow());
  win.on("restore", () => hideBallWindow());
  if (isWidgetMode) {
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true);
  }
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });
  return win;
}

function getMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }
  return null;
}

async function ensureDataDirs() {
  await migrateLegacyDataIfNeeded();
  await loadSettingsIfNeeded();
  await fsp.mkdir(getFilesDir(), { recursive: true });
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
}

function getFilesDir() {
  if (customFilesDir && path.isAbsolute(customFilesDir)) {
    return customFilesDir;
  }
  return FILES_DIR;
}

async function loadSettingsIfNeeded() {
  if (settingsLoaded) {
    return;
  }
  settingsLoaded = true;
  await fsp.mkdir(APP_DATA_DIR, { recursive: true });
  if (!fs.existsSync(SETTINGS_PATH)) {
    return;
  }
  try {
    const raw = await fsp.readFile(SETTINGS_PATH, "utf8");
    const parsed = raw ? JSON.parse(raw) : {};
    const nextDir = typeof parsed.customFilesDir === "string" ? parsed.customFilesDir.trim() : "";
    customFilesDir = nextDir;
  } catch {
    customFilesDir = "";
  }
}

async function saveSettings() {
  await fsp.mkdir(APP_DATA_DIR, { recursive: true });
  const payload = {
    customFilesDir,
  };
  await fsp.writeFile(SETTINGS_PATH, JSON.stringify(payload, null, 2), "utf8");
}

async function migrateLegacyDataIfNeeded() {
  if (legacyMigrated) {
    return;
  }
  legacyMigrated = true;
  if (APP_DATA_DIR === LEGACY_APP_DATA_DIR) {
    return;
  }
  if (!fs.existsSync(LEGACY_APP_DATA_DIR)) {
    return;
  }
  if (fs.existsSync(RECORDS_PATH)) {
    return;
  }
  await fsp.mkdir(APP_DATA_DIR, { recursive: true });

  const legacyRecords = path.join(LEGACY_APP_DATA_DIR, "records.json");
  if (fs.existsSync(legacyRecords)) {
    await fsp.copyFile(legacyRecords, RECORDS_PATH);
  }

  const legacyFiles = path.join(LEGACY_APP_DATA_DIR, "files");
  if (fs.existsSync(legacyFiles)) {
    await fsp.cp(legacyFiles, getFilesDir(), { recursive: true });
  }

  const legacyBackups = path.join(LEGACY_APP_DATA_DIR, "backups");
  if (fs.existsSync(legacyBackups)) {
    await fsp.cp(legacyBackups, BACKUP_DIR, { recursive: true });
  }

  const legacyMeta = path.join(LEGACY_APP_DATA_DIR, "last-backup.json");
  if (fs.existsSync(legacyMeta)) {
    await fsp.copyFile(legacyMeta, LAST_BACKUP_META);
  }
}

function isURLText(value) {
  if (!value || typeof value !== "string") {
    return false;
  }
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function guessMimeTypeByExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
  };
  return map[ext] || "";
}

async function appendQuickRecords(items) {
  saveQueue = saveQueue.then(async () => {
    await ensureDataDirs();
    let recordsByDate = {};
    if (fs.existsSync(RECORDS_PATH)) {
      try {
        const raw = await fsp.readFile(RECORDS_PATH, "utf8");
        recordsByDate = raw ? JSON.parse(raw) : {};
      } catch {
        recordsByDate = {};
      }
    }
    const key = todayKey();
    if (!Array.isArray(recordsByDate[key])) {
      recordsByDate[key] = [];
    }
    for (const item of items) {
      recordsByDate[key].push(item);
    }
    await fsp.writeFile(RECORDS_PATH, JSON.stringify(recordsByDate, null, 2), "utf8");
  });
  await saveQueue;
}

function focusMainWindowAndInput() {
  const win = getMainWindow();
  if (!win) {
    return false;
  }
  if (win.isMinimized()) {
    win.restore();
  }
  win.show();
  win.focus();
  hideBallWindow();
  win.webContents.send("quick-entry:focus-input");
  return true;
}

function notifyRecordsChanged(payload = {}) {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) {
    return;
  }
  win.webContents.send("records:changed", payload);
}

function createBallWindow() {
  if (ballWindow && !ballWindow.isDestroyed()) {
    return ballWindow;
  }
  ballWindow = new BrowserWindow({
    width: 56,
    height: 56,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    icon: process.platform === "win32" ? APP_ICON_ICO_PATH : APP_ICON_PNG_PATH,
    webPreferences: {
      preload: path.join(__dirname, "ball-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  ballWindow.setAlwaysOnTop(true, "screen-saver");
  ballWindow.setVisibleOnAllWorkspaces(true);
  positionBallWindow();
  ballWindow.loadFile("ball.html");
  ballWindow.on("closed", () => {
    ballWindow = null;
  });
  return ballWindow;
}

function positionBallWindow() {
  const win = createBallWindow();
  const area = screen.getPrimaryDisplay().workArea;
  const [w, h] = win.getSize();
  const x = area.x + area.width - w - 10;
  const y = area.y + Math.max(10, Math.floor((area.height - h) / 2));
  win.setPosition(x, y);
}

function showBallWindow(force = false) {
  if (!force && !minimizeToBallOnMinimize) {
    return;
  }
  const win = createBallWindow();
  positionBallWindow();
  win.showInactive();
}

function hideBallWindow() {
  if (ballWindow && !ballWindow.isDestroyed()) {
    ballWindow.hide();
  }
}

function createTrayImage() {
  const appIcon = nativeImage.createFromPath(APP_ICON_PNG_PATH);
  if (!appIcon.isEmpty()) {
    return appIcon.resize({ width: 16, height: 16 });
  }
  return nativeImage.createEmpty();
}

function setupTray() {
  if (tray) {
    return;
  }
  tray = new Tray(createTrayImage());
  tray.setToolTip("day-recordings");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "快速记录", click: () => focusMainWindowAndInput() },
      { label: "显示主窗口", click: () => focusMainWindowAndInput() },
      { type: "separator" },
      { label: "退出", click: () => shutdownApp() },
    ])
  );
  tray.on("double-click", () => focusMainWindowAndInput());
}

function setupShortcuts() {
  globalShortcut.register("CommandOrControl+Shift+D", () => {
    focusMainWindowAndInput();
  });
}

function removeShortcutsAndTray() {
  try {
    globalShortcut.unregisterAll();
  } catch {
    // Ignore shortcut cleanup errors.
  }
  if (tray) {
    try {
      tray.destroy();
    } catch {
      // Ignore tray cleanup errors.
    }
    tray = null;
  }
}

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function tryRestoreFromLatestBackup() {
  try {
    const names = await fsp.readdir(BACKUP_DIR);
    const candidates = names
      .filter((n) => n.endsWith(".json"))
      .sort()
      .reverse();
    for (const name of candidates) {
      const full = path.join(BACKUP_DIR, name);
      const json = await readJsonIfExists(full);
      if (json && typeof json === "object") {
        await fsp.writeFile(RECORDS_PATH, JSON.stringify(json, null, 2), "utf8");
        return json;
      }
    }
    return {};
  } catch {
    return {};
  }
}

async function ensureDailySnapshot(recordsByDate) {
  const key = todayKey();
  const meta = await readJsonIfExists(LAST_BACKUP_META);
  if (meta && meta.lastKey === key) {
    return;
  }
  const backupPath = path.join(BACKUP_DIR, `records-${key}.json`);
  await fsp.writeFile(backupPath, JSON.stringify(recordsByDate || {}, null, 2), "utf8");
  await fsp.writeFile(LAST_BACKUP_META, JSON.stringify({ lastKey: key }, null, 2), "utf8");
}

ipcMain.handle("records:load", async () => {
  await ensureDataDirs();
  if (!fs.existsSync(RECORDS_PATH)) {
    return {};
  }
  try {
    const raw = await fsp.readFile(RECORDS_PATH, "utf8");
    const data = raw ? JSON.parse(raw) : {};
    await ensureDailySnapshot(data);
    return data;
  } catch {
    return tryRestoreFromLatestBackup();
  }
});

ipcMain.handle("records:save", async (_, recordsByDate) => {
  saveQueue = saveQueue.then(async () => {
    await ensureDataDirs();
    await fsp.writeFile(RECORDS_PATH, JSON.stringify(recordsByDate, null, 2), "utf8");
  });
  await saveQueue;
  return { ok: true };
});

ipcMain.handle("files:save", async (_, payload) => {
  const { fileName, mimeType, bytes } = payload || {};
  if (!fileName || !Array.isArray(bytes)) {
    throw new Error("Invalid file payload");
  }

  await ensureDataDirs();
  const safeName = sanitizeFileName(fileName);
  const storedName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
  const absPath = path.join(getFilesDir(), storedName);
  const contentBuffer = Buffer.from(bytes);
  await fsp.writeFile(absPath, contentBuffer);
  const sha256 = crypto.createHash("sha256").update(contentBuffer).digest("hex");

  return {
    storedName,
    absPath,
    relativePath: path.relative(process.cwd(), absPath),
    mimeType: typeof mimeType === "string" ? mimeType : "",
    sha256,
  };
});

ipcMain.handle("files:open", async (_, absPath) => {
  if (!absPath || typeof absPath !== "string") {
    return { ok: false, message: "invalid path", exists: false };
  }
  if (!fs.existsSync(absPath)) {
    return { ok: false, message: "file not found", exists: false };
  }
  const result = await shell.openPath(absPath);
  return { ok: !result, message: result || "", exists: true };
});

ipcMain.handle("url:openExternal", async (_, url) => {
  if (!url || typeof url !== "string") {
    return { ok: false, message: "invalid url" };
  }
  try {
    await shell.openExternal(url);
    return { ok: true, message: "" };
  } catch (error) {
    return { ok: false, message: String(error && error.message ? error.message : error) };
  }
});

ipcMain.handle("clipboard:writeText", async (_, text) => {
  if (typeof text !== "string") {
    return { ok: false, message: "invalid text" };
  }
  clipboard.writeText(text);
  return { ok: true, message: "" };
});

ipcMain.handle("window:getTopMost", async () => {
  const win = getMainWindow();
  return { ok: Boolean(win), value: win ? win.isAlwaysOnTop() : false };
});

ipcMain.handle("window:setTopMost", async (_, value) => {
  const win = getMainWindow();
  if (!win) {
    return { ok: false, value: false };
  }
  const next = Boolean(value);
  win.setAlwaysOnTop(next, "screen-saver");
  if (isWidgetMode) {
    win.setVisibleOnAllWorkspaces(next);
  }
  return { ok: true, value: win.isAlwaysOnTop() };
});

ipcMain.handle("window:focusQuickEntry", async () => {
  return { ok: focusMainWindowAndInput() };
});

ipcMain.handle("window:getCloseToTray", async () => {
  return { ok: true, value: minimizeToTrayOnClose };
});

ipcMain.handle("window:setCloseToTray", async (_, value) => {
  minimizeToTrayOnClose = Boolean(value);
  return { ok: true, value: minimizeToTrayOnClose };
});

ipcMain.handle("window:getMinimizeToBall", async () => {
  return { ok: true, value: minimizeToBallOnMinimize };
});

ipcMain.handle("window:setMinimizeToBall", async (_, value) => {
  minimizeToBallOnMinimize = Boolean(value);
  if (!minimizeToBallOnMinimize) {
    hideBallWindow();
  }
  return { ok: true, value: minimizeToBallOnMinimize };
});

ipcMain.handle("storage:getFilesDir", async () => {
  await ensureDataDirs();
  return { ok: true, value: customFilesDir, effectiveDir: getFilesDir() };
});

ipcMain.handle("storage:setFilesDir", async (_, value) => {
  const next = typeof value === "string" ? value.trim() : "";
  if (next && !path.isAbsolute(next)) {
    return { ok: false, message: "path must be absolute", value: customFilesDir, effectiveDir: getFilesDir() };
  }
  customFilesDir = next;
  await ensureDataDirs();
  await saveSettings();
  return { ok: true, value: customFilesDir, effectiveDir: getFilesDir() };
});

ipcMain.handle("window:showMain", async () => {
  return { ok: focusMainWindowAndInput() };
});

ipcMain.handle("quickRecord:drop", async (_, payload) => {
  const text = typeof (payload && payload.text) === "string" ? payload.text.trim() : "";
  const paths = Array.isArray(payload && payload.paths) ? payload.paths.filter((p) => typeof p === "string" && p.trim()) : [];
  const items = [];

  if (text) {
    items.push({
      id: crypto.randomUUID(),
      type: isURLText(text) ? "link" : "text",
      text,
      tags: [],
      favorite: false,
      deletedAt: 0,
      createdAt: Date.now(),
    });
  }

  for (const p of [...new Set(paths)]) {
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) {
      continue;
    }
    const stat = await fsp.stat(abs);
    if (stat.isDirectory()) {
      items.push({
        id: crypto.randomUUID(),
        type: "file",
        fileName: path.basename(abs),
        fileSize: 0,
        mimeType: "folder",
        filePath: abs,
        relativePath: path.relative(process.cwd(), abs),
        sha256: "",
        tags: [],
        favorite: false,
        deletedAt: 0,
        createdAt: Date.now(),
      });
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    await ensureDataDirs();
    const safeName = sanitizeFileName(path.basename(abs));
    const storedName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
    const dest = path.join(getFilesDir(), storedName);
    await fsp.copyFile(abs, dest);
    const contentBuffer = await fsp.readFile(dest);
    const sha256 = crypto.createHash("sha256").update(contentBuffer).digest("hex");
    items.push({
      id: crypto.randomUUID(),
      type: "file",
      fileName: path.basename(abs),
      fileSize: stat.size,
      mimeType: guessMimeTypeByExt(abs),
      filePath: dest,
      relativePath: path.relative(process.cwd(), dest),
      sha256,
      tags: [],
      favorite: false,
      deletedAt: 0,
      createdAt: Date.now(),
    });
  }

  if (!items.length) {
    return { ok: false, added: 0 };
  }
  await appendQuickRecords(items);
  notifyRecordsChanged({ source: "ball", added: items.length, at: Date.now() });
  return { ok: true, added: items.length };
});

function sanitizeFileName(name) {
  return String(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

function shutdownApp() {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.removeAllListeners();
      win.destroy();
    } catch {
      // Ignore window cleanup errors during shutdown.
    }
  }

  app.removeAllListeners("activate");
  removeShortcutsAndTray();

  try {
    Promise.resolve(saveQueue).finally(() => {
      try {
        app.quit();
      } catch {
        // Ignore quit errors and fallback to hard exit.
      }
    });
  } catch {
    // Ignore queue errors and fallback to hard exit.
  }

  setTimeout(() => app.exit(0), 1500);
}

app.whenReady().then(() => {
  createWindow();
  setupTray();
  setupShortcuts();

  app.on("activate", () => {
    if (!getMainWindow()) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform === "darwin") {
    return;
  }
  shutdownApp();
});

app.on("before-quit", () => {
  if (!isShuttingDown) {
    shutdownApp();
  }
});
