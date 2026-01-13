const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // --- PRODUCTOS ---
    getAllData: () => ipcRenderer.invoke('db-get-all'),
    saveProduct: (p) => ipcRenderer.invoke('db-save-product', p),
    deleteProduct: (code) => ipcRenderer.invoke('db-delete-product', code),
    bulkUpdate: (data) => ipcRenderer.invoke('db-bulk-update', data),
    
    // Búsqueda rápida (Minimercado)
    searchProduct: (query) => ipcRenderer.invoke('db-search-product', query),

    // --- VENTAS Y CLIENTES ---
    saveSale: (s) => ipcRenderer.invoke('db-save-sale', s),
    saveClient: (c) => ipcRenderer.invoke('db-save-client', c),
    payDebt: (data) => ipcRenderer.invoke('db-pay-debt', data),
    deleteClient: (id) => ipcRenderer.invoke('db-delete-client', id), // <--- Ya la tenías, perfecto.
    
    // --- CAJA Y GASTOS (PROVEEDORES) ---
    saveClosure: (c) => ipcRenderer.invoke('db-save-closure', c),
    
    // 🔥 ESTA ES LA NUEVA (Para pagar a proveedores):
    saveExpense: (ex) => ipcRenderer.invoke('db-save-expense', ex),

    exportarExcel: (d) => ipcRenderer.invoke('exportar-excel', d),
    addUser: (u) => ipcRenderer.invoke('db-add-user', u),
    
    // --- MANTENIMIENTO ---
    factoryReset: () => ipcRenderer.invoke('db-factory-reset'),
    restoreBackup: (data) => ipcRenderer.invoke('db-restore-backup', data),
    
    // --- EXTRAS (Fiscal e Impresión) ---
    facturar: (v) => ipcRenderer.invoke('facturar-afip', v),
    imprimirTicket: (html) => ipcRenderer.invoke('print-ticket', html),
});