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
} = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const APP_DATA_DIR = path.join(process.cwd(), "day-recordings-data");
const RECORDS_PATH = path.join(APP_DATA_DIR, "records.json");
const FILES_DIR = path.join(APP_DATA_DIR, "files");
const BACKUP_DIR = path.join(APP_DATA_DIR, "backups");
const LAST_BACKUP_META = path.join(APP_DATA_DIR, "last-backup.json");
const isWidgetMode = process.argv.includes("--widget");
const windowMinWidth = isWidgetMode ? 360 : 520;
const windowMinHeight = isWidgetMode ? 280 : 360;
const APP_ICON_PATH = path.join(__dirname, "assets", "icon.png");
const TRAY_ICON_PATH = path.join(__dirname, "assets", "tray.png");
let isShuttingDown = false;
let saveQueue = Promise.resolve();
let tray = null;
let minimizeToTrayOnClose = false;

function createWindow() {
  const win = new BrowserWindow({
    width: windowMinWidth,
    height: windowMinHeight,
    minWidth: windowMinWidth,
    minHeight: windowMinHeight,
    alwaysOnTop: isWidgetMode,
    skipTaskbar: isWidgetMode,
    autoHideMenuBar: true,
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile("index.html");
  win.on("close", (event) => {
    if (isShuttingDown || !minimizeToTrayOnClose) {
      return;
    }
    event.preventDefault();
    win.hide();
  });
  if (isWidgetMode) {
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true);
  }
}

function getMainWindow() {
  return BrowserWindow.getAllWindows()[0] || null;
}

async function ensureDataDirs() {
  await fsp.mkdir(FILES_DIR, { recursive: true });
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
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
  win.webContents.send("quick-entry:focus-input");
  return true;
}

function createTrayImage() {
  const trayImage = nativeImage.createFromPath(TRAY_ICON_PATH);
  if (!trayImage.isEmpty()) {
    return trayImage.resize({ width: 16, height: 16 });
  }
  const fallback = nativeImage.createFromPath(APP_ICON_PATH);
  if (!fallback.isEmpty()) {
    return fallback.resize({ width: 16, height: 16 });
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
  const absPath = path.join(FILES_DIR, storedName);
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
    if (BrowserWindow.getAllWindows().length === 0) {
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
