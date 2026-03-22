'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, handler) {
  const wrapped = (_event, payload) => {
    handler(payload);
  };
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

contextBridge.exposeInMainWorld('loafHost', {
  getState: () => ipcRenderer.invoke('host:get-state'),
  copyRoomCode: () => ipcRenderer.invoke('host:copy-room-code'),
  updateSettings: (patch) => ipcRenderer.invoke('host:update-settings', patch),
  forceKeyframe: () => ipcRenderer.invoke('host:force-keyframe'),
  disconnect: () => ipcRenderer.invoke('host:disconnect'),
  openSignalingUrl: () => ipcRenderer.invoke('host:open-signaling-url'),

  onState: (handler) => on('host:state', handler),
  onStats: (handler) => on('host:stats', handler),
  onError: (handler) => on('host:error', handler),
  onUpdateDownloaded: (handler) => on('host:update-downloaded', handler),
});
