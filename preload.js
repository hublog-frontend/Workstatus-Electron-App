const { contextBridge, ipcRenderer } = require('electron');

window.addEventListener("DOMContentLoaded", () => {
  const replaceText = (selector, text) => {
    const element = document.getElementById(selector);
    if (element) element.innerText = text;
  };

  for (const type of ["chrome", "node", "electron"]) {
    replaceText(`${type}-version`, process.versions[type]);
  }
});

contextBridge.exposeInMainWorld('electronAPI', {
  closeWindow: () => ipcRenderer.send('close-window'),
  takeScreenshot: () => ipcRenderer.invoke('take-screenshot'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  startTracking: (userId) => ipcRenderer.send('start-tracking', userId),
  stopTracking: () => ipcRenderer.send('stop-tracking'),
  checkSystemIdleTime: () => ipcRenderer.invoke('get-system-idle-time'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  onLogActivity: (callback) => ipcRenderer.on('log-activity', (event, data) => callback(data))
});
