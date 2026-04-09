const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dayBallAPI", {
  showMainWindow: () => ipcRenderer.invoke("window:showMain"),
  quickRecordDrop: (payload) => ipcRenderer.invoke("quickRecord:drop", payload),
});
