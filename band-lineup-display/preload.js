const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lineup', {
  addImagesDialog: () => ipcRenderer.invoke('add-images-dialog'),
  addImagesPaths: (paths) => ipcRenderer.invoke('add-images-paths', paths),
  loadState: () => ipcRenderer.invoke('load-state'),
  saveState: (payload) => ipcRenderer.invoke('save-state', payload),
  deleteLibraryImage: (fileName) => ipcRenderer.invoke('delete-library-image', fileName),
  imageUrl: (fileName) => ipcRenderer.invoke('image-url', fileName),
  parallaxAssets: (fileName) => ipcRenderer.invoke('parallax-assets', fileName),
  pcoStatus: () => ipcRenderer.invoke('pco-status'),
  pcoConnect: (payload) => ipcRenderer.invoke('pco-connect', payload),
  pcoDisconnect: () => ipcRenderer.invoke('pco-disconnect'),
  pcoServiceTypes: () => ipcRenderer.invoke('pco-service-types'),
  pcoPositionOptions: (serviceTypeId) => ipcRenderer.invoke('pco-position-options', serviceTypeId),
  pcoSyncUpcomingPlan: (payload) => ipcRenderer.invoke('pco-sync-upcoming-plan', payload),
  onMenuAddPhotos: (cb) => {
    ipcRenderer.on('menu-add-photos', () => cb());
  },
  appVersion: () => ipcRenderer.invoke('app-version'),
  display: {
    status: () => ipcRenderer.invoke('display-status'),
    setEnabled: (enabled) => ipcRenderer.invoke('display-set-enabled', enabled),
    setPort: (port) => ipcRenderer.invoke('display-set-port', port),
    copyUrl: (url) => ipcRenderer.invoke('display-copy-url', url),
  },
  proPresenter: {
    status: () => ipcRenderer.invoke('pp-status'),
    connect: (payload) => ipcRenderer.invoke('pp-connect', payload),
    disconnect: () => ipcRenderer.invoke('pp-disconnect'),
    start: () => ipcRenderer.invoke('pp-start'),
    listPlaylists: () => ipcRenderer.invoke('pp-playlists'),
    selectPlaylist: (payload) => ipcRenderer.invoke('pp-select-playlist', payload),
    onData: (cb) => {
      ipcRenderer.on('pp-data', (_event, data) => cb(data));
    },
  },
});
