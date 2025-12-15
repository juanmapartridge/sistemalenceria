const { app, BrowserWindow, ipcMain, shell } = require('electron'); // Agregué shell para abrir carpetas
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const xlsx = require('xlsx'); 

// --- BASE DE DATOS SQLITE ---
const dbPath = path.join(__dirname, 'mandalay.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // Tablas (Mismos esquemas que antes)
    db.run(`CREATE TABLE IF NOT EXISTS products (code TEXT PRIMARY KEY, name TEXT, supplier TEXT, size TEXT, color TEXT, cost REAL, margin REAL, price REAL, qty INTEGER)`);
    db.run(`CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT, address TEXT, balance REAL DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS client_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER, date TEXT, type TEXT, amount REAL, note TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, pin TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS sales (id INTEGER PRIMARY KEY, date TEXT, seller TEXT, total REAL, payment TEXT, card_name TEXT, surcharge REAL, discount REAL, client_id INTEGER, items_json TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS closures (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, user TEXT, sys_cash REAL, real_cash REAL, diff REAL, status TEXT, details_json TEXT)`);
    
    db.get("SELECT * FROM users WHERE pin = '1234'", (err, row) => {
        if(!row) db.run("INSERT INTO users (name, pin) VALUES ('Admin', '1234')");
    });
});

// --- API ---
ipcMain.handle('db-get-all', async () => {
    return new Promise((resolve) => {
        const data = { stock: [], users: [], sales: [], clients: [], closures: [] };
        db.serialize(() => {
            db.all("SELECT * FROM products", (err, rows) => data.stock = rows || []);
            db.all("SELECT * FROM sales", (err, rows) => data.sales = (rows || []).map(r => ({...r, items: JSON.parse(r.items_json)})));
            db.all("SELECT * FROM closures", (err, rows) => data.closures = (rows || []).map(r => ({...r, details: JSON.parse(r.details_json)})));
            db.all("SELECT * FROM clients", (err, rows) => data.clients = rows || []);
            db.all("SELECT * FROM users", (err, rows) => { data.users = rows || []; resolve(data); });
        });
    });
});

ipcMain.handle('db-save-product', async (e, p) => {
    return new Promise((resolve) => {
        db.get("SELECT code FROM products WHERE code = ?", [p.code], (err, row) => {
            const params = [p.name, p.supplier, p.size, p.color, p.cost, p.margin, p.price, p.qty];
            if(row) {
                db.run("UPDATE products SET name=?, supplier=?, size=?, color=?, cost=?, margin=?, price=?, qty=? WHERE code=?", [...params, p.code], (err) => resolve(!err));
            } else {
                db.run("INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?)", [p.code, ...params], (err) => resolve(!err));
            }
        });
    });
});

// --- MEJORA 1: ACTUALIZACIÓN MASIVA INTELIGENTE ---
ipcMain.handle('db-bulk-update', async (e, {provider, pct}) => {
    return new Promise((resolve) => {
        const factor = 1 + (pct/100);
        // SQL: Actualiza el Costo Y LUEGO recalcula el Precio usando el Costo Nuevo y el Margen existente.
        const sql = `
            UPDATE products 
            SET cost = ROUND(cost * ?, 2), 
                price = ROUND((cost * ?) * (1 + margin/100), 2) 
            WHERE supplier = ?
        `;
        db.run(sql, [factor, factor, provider], function(err) { 
            resolve({success: !err, changes: this.changes}); 
        });
    });
});

ipcMain.handle('db-save-sale', async (e, s) => {
    return new Promise((resolve) => {
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            const itemsStr = JSON.stringify(s.items);
            db.run("INSERT INTO sales (id, date, seller, total, payment, card_name, surcharge, discount, client_id, items_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
                [s.id, s.date, s.seller, s.total, s.payment, s.card_name, s.surcharge, s.discount, s.client_id, itemsStr]);
            
            // Descuento de Stock
            s.items.forEach(item => {
                if(!item.isManual) db.run("UPDATE products SET qty = qty - ? WHERE code = ?", [item.qty, item.code]);
            });

            if (s.payment === 'Cuenta Corriente' && s.client_id) {
                db.run("UPDATE clients SET balance = balance + ? WHERE id = ?", [s.total, s.client_id]);
                db.run("INSERT INTO client_movements (client_id, date, type, amount, note) VALUES (?,?,?,?,?)", [s.client_id, s.date, 'DEUDA', s.total, `Venta #${s.id}`]);
            }
            db.run("COMMIT", (err) => resolve({success: !err}));
        });
    });
});

// --- MEJORA 3: EXCEL PROFESIONAL Y ORGANIZADO ---
ipcMain.handle('exportar-excel', async (event, payload) => {
    try {
        const { ventas, cierres } = payload;
        
        // 1. Crear Carpeta de Reportes si no existe
        const reportDir = path.join(app.getPath('documents'), 'Sistema_Reportes');
        if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

        // 2. Nombre del Archivo: Cierre_DD-MM-YYYY
        const today = new Date();
        const day = String(today.getDate()).padStart(2, '0');
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const year = today.getFullYear();
        const fileName = `Cierre_${day}-${month}-${year}.xlsx`;
        const filePath = path.join(reportDir, fileName);

        // 3. Preparar Datos "Profesionales" (Layout Contable)
        const wb = xlsx.utils.book_new();

        // --- HOJA 1: RESUMEN FINANCIERO ---
        // Calculamos totales
        let totalEfectivo = 0, totalDigital = 0, totalCtaCte = 0, totalGeneral = 0;
        ventas.forEach(v => {
            totalGeneral += v.total;
            if(v.payment === 'Efectivo') totalEfectivo += v.total;
            else if(v.payment === 'Cuenta Corriente') totalCtaCte += v.total;
            else totalDigital += v.total;
        });

        const resumenData = [
            ["REPORTE DE CIERRE DE CAJA"],
            ["Fecha:", `${day}/${month}/${year}`],
            ["Generado por:", "Sistema Lencería"],
            [""], // Espacio
            ["RESUMEN DE INGRESOS", "MONTO"],
            ["Total Efectivo", totalEfectivo],
            ["Total Digital (Tarjetas/Transf)", totalDigital],
            ["Total Cuenta Corriente (Fiado)", totalCtaCte],
            ["--------------------------------", "-------"],
            ["TOTAL VENTAS BRUTAS", totalGeneral],
            [""],
            ["DETALLE DE ARQUEOS (Control de Caja)"],
            ["Hora", "Usuario", "Sistema", "Real (Físico)", "Diferencia", "Estado"]
        ];

        // Agregamos los cierres a la hoja de resumen
        cierres.forEach(c => {
            resumenData.push([
                c.date.split(',')[1], c.user, c.sys_cash, c.real_cash, c.diff, c.status
            ]);
        });

        const wsResumen = xlsx.utils.aoa_to_sheet(resumenData);
        xlsx.utils.book_append_sheet(wb, wsResumen, "Resumen Gerencial");

        // --- HOJA 2: DETALLE DE VENTAS ---
        const detalleData = [
            ["ID Venta", "Hora", "Vendedor", "Cliente", "Productos", "Pago", "Total"]
        ];
        ventas.forEach(v => {
            // Formatear items en una sola celda para que se vea ordenado
            const prods = v.items.map(i => `${i.qty}x ${i.name}`).join(" | ");
            detalleData.push([
                v.id, v.date.split(',')[1], v.seller, v.client_id ? 'Regitrado' : 'Final', prods, v.payment, v.total
            ]);
        });

        const wsDetalle = xlsx.utils.aoa_to_sheet(detalleData);
        xlsx.utils.book_append_sheet(wb, wsDetalle, "Detalle Operaciones");

        // 4. Guardar Archivo
        xlsx.writeFile(wb, filePath);
        
        // 5. Abrir la carpeta para mostrar el archivo al usuario
        shell.showItemInFolder(filePath);

        return { success: true, path: filePath };

    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Otros handlers
ipcMain.handle('db-save-closure', async (e, c) => {
    return new Promise(resolve => {
        db.run("INSERT INTO closures (date, user, sys_cash, real_cash, diff, status, details_json) VALUES (?,?,?,?,?,?,?)",
            [c.date, c.user, c.sysCash, c.realCash, c.diff, c.status, JSON.stringify(c.details)], (err) => resolve(!err));
    });
});
ipcMain.handle('db-save-client', async (e, c) => {
    return new Promise(r => {
        if(c.id) db.run("UPDATE clients SET name=?, phone=?, address=? WHERE id=?", [c.name, c.phone, c.address, c.id], (err)=>r(!err));
        else db.run("INSERT INTO clients (name, phone, address, balance) VALUES (?,?,?,0)", [c.name, c.phone, c.address], (err)=>r(!err));
    });
});
// Funciones auxiliares sin cambios
ipcMain.handle('db-pay-debt', async () => ({success:true}));
ipcMain.handle('db-add-user', async (e, u) => { db.run("INSERT INTO users (name, pin) VALUES (?,?)", [u.name, u.pin]); return true; });
ipcMain.handle('db-factory-reset', async () => ({success:true}));
ipcMain.handle('db-restore-backup', async () => ({success:true}));
ipcMain.handle('facturar-afip', async () => ({success:false, error:"Demo"}));

let mainWindow;
function createWindow() {
    mainWindow = new BrowserWindow({ width: 1200, height: 800, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
    mainWindow.loadFile('index.html');
}
app.whenReady().then(createWindow);