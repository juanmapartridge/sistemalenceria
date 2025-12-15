const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getAllData: () => ipcRenderer.invoke('db-get-all'),
    saveProduct: (p) => ipcRenderer.invoke('db-save-product', p),
    bulkUpdate: (data) => ipcRenderer.invoke('db-bulk-update', data),
    saveSale: (s) => ipcRenderer.invoke('db-save-sale', s),
    saveClosure: (c) => ipcRenderer.invoke('db-save-closure', c),
    addUser: (u) => ipcRenderer.invoke('db-add-user', u),
    factoryReset: () => ipcRenderer.invoke('db-factory-reset'),
    restoreBackup: (data) => ipcRenderer.invoke('db-restore-backup', data),
    saveClient: (c) => ipcRenderer.invoke('db-save-client', c),
    payDebt: (data) => ipcRenderer.invoke('db-pay-debt', data),
    exportarExcel: (d) => ipcRenderer.invoke('exportar-excel', d),
    facturar: (v) => ipcRenderer.invoke('facturar-afip', v)
});