'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The page receives named actions, never Node, a filesystem API, or the local capability.
contextBridge.exposeInMainWorld('nemoDesktop', Object.freeze({
  request: (action, input = {}, profileId) => ipcRenderer.invoke('nemo:setup', action, input, profileId),
  setStartAtLogin: (enabled, profileId) => ipcRenderer.invoke('nemo:start-at-login', enabled === true, profileId),
  getStartAtLogin: profileId => ipcRenderer.invoke('nemo:get-start-at-login', profileId),
}));
// One window, one preload. Main checks the exact document and signed-in owner
// before any home-level action; no setup capability is exposed here.
contextBridge.exposeInMainWorld('nemoShell', Object.freeze({
  openHost: () => ipcRenderer.invoke('nemo:host-access'),
  connectGmail: profileId => ipcRenderer.invoke('nemo:chat-gmail', 'start', profileId),
  cancelGmail: profileId => ipcRenderer.invoke('nemo:chat-gmail', 'cancel', profileId),
}));
