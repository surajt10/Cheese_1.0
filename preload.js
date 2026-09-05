const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cheese', {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  on: (channel, fn) => {
    const handler = (_e, data) => fn(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
