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
  focusQuickEntry: () => ipcRenderer.invoke("window:focusQuickEntry"),
  onQuickEntryFocus: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("quick-entry:focus-input", handler);
    return () => ipcRenderer.removeListener("quick-entry:focus-input", handler);
  },
});
