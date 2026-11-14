const { contextBridge, ipcRenderer } = require('electron')
const call = (n) => (...a) => ipcRenderer.invoke(n, ...a)
contextBridge.exposeInMainWorld('api', {
  list: call('list'), create: call('create'), update: call('update'),
  remove: call('remove'), launch: call('launch'), stop: call('stop'),
  onState: (cb) => ipcRenderer.on('state', (_e, ids) => cb(ids)),
})