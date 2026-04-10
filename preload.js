const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dayRecordingsAPI", {
  loadRecords: () => ipcRenderer.invoke("records:load"),
  saveRecords: (recordsByDate) => ipcRenderer.invoke("records:save", recordsByDate),
  saveDroppedFile: (payload) => ipcRenderer.invoke("files:save", payload),
  openFile: (absPath) => ipcRenderer.invoke("files:open", absPath),
  openExternalURL: (url) => ipcRenderer.invoke("url:openExternal", url),
  copyText: (text) => ipcRenderer.invoke("clipboard:writeText", text),
  getTopMost: () => ipcRenderer.invoke("window:getTopMost"),
  setTopMost: (value) => ipcRenderer.invoke("window:setTopMost", value),
  getCloseToTray: () => ipcRenderer.invoke("window:getCloseToTray"),
  setCloseToTray: (value) => ipcRenderer.invoke("window:setCloseToTray", value),
  getMinimizeToBall: () => ipcRenderer.invoke("window:getMinimizeToBall"),
  setMinimizeToBall: (value) => ipcRenderer.invoke("window:setMinimizeToBall", value),
  showMainWindow: () => ipcRenderer.invoke("window:showMain"),
  quickRecordDrop: (payload) => ipcRenderer.invoke("quickRecord:drop", payload),
  getFileStorageDir: () => ipcRenderer.invoke("storage:getFilesDir"),
  setFileStorageDir: (value) => ipcRenderer.invoke("storage:setFilesDir", value),
  openFileStorageDir: () => ipcRenderer.invoke("storage:openFilesDir"),
  getAppSettings: () => ipcRenderer.invoke("settings:get"),
  setAppSettings: (settings) => ipcRenderer.invoke("settings:set", settings),
  focusQuickEntry: () => ipcRenderer.invoke("window:focusQuickEntry"),
  onRecordsChanged: (callback) => {
    const handler = (_, payload) => callback(payload || {});
    ipcRenderer.on("records:changed", handler);
    return () => ipcRenderer.removeListener("records:changed", handler);
  },
  onQuickEntryFocus: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("quick-entry:focus-input", handler);
    return () => ipcRenderer.removeListener("quick-entry:focus-input", handler);
  },
});
