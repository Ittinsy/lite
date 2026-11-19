const { contextBridge, ipcRenderer } = require('electron')

const call = (name) => (...args) => ipcRenderer.invoke(name, ...args)
const listen = (channel) => (cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload))

contextBridge.exposeInMainWorld('api', {
  list: call('list'),
  create: call('create'),
  update: call('update'),
  remove: call('remove'),
  launch: call('launch'),
  stop: call('stop'),
  onState: listen('state'),
  onNotice: listen('notice'),
})
