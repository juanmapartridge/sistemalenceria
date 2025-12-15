const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const xlsx = require('xlsx'); 

const dbPath = path.join(__dirname, 'mandalay.db');
const db = new sqlite3.Database(dbPath);

// --- INICIALIZACIÓN DE TABLAS ---
db.serialize(() => {
    // 1. Productos (Con todas las columnas nuevas)
    db.run(`CREATE TABLE IF NOT EXISTS products (
        code TEXT PRIMARY KEY, 
        name TEXT, 
        supplier TEXT, 
        brand TEXT,       -- Marca
        category TEXT,    -- Categoria
        subcategory TEXT, -- Subcategoria
        size TEXT, 
        color TEXT, 
        cost REAL, 
        margin REAL, 
        price REAL, 
        qty INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, pin TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS closures (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, user TEXT, sys_cash REAL, real_cash REAL, diff REAL, status TEXT, details_json TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS sales (id INTEGER PRIMARY KEY, date TEXT, seller TEXT, total REAL, payment TEXT, card_name TEXT, surcharge REAL, discount REAL, client_id INTEGER, items_json TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT, address TEXT, balance REAL DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS client_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER, date TEXT, type TEXT, amount REAL, note TEXT)`);
    
    // --- RECUPERACIÓN ADMIN ---
    db.get("SELECT * FROM users WHERE name = 'Admin'", (err, row) => {
        if(row) {
            db.run("UPDATE users SET pin = '1111' WHERE name = 'Admin'");
        } else {
            db.run("INSERT INTO users (name, pin) VALUES ('Admin', '1111')");
        }
    });
});

// --- API ---

// 1. OBTENER TODO
ipcMain.handle('db-get-all', async () => {
    return new Promise((resolve) => {
        setTimeout(() => {
            const data = { stock: [], users: [], sales: [], closures: [], clients: [], movements: [] };
            db.serialize(() => {
                db.all("SELECT * FROM products", (err, rows) => data.stock = rows || []);
                db.all("SELECT * FROM sales", (err, rows) => data.sales = (rows || []).map(r => ({...r, items: JSON.parse(r.items_json)})));
                db.all("SELECT * FROM closures", (err, rows) => data.closures = (rows || []).map(r => ({...r, details: JSON.parse(r.details_json)})));
                db.all("SELECT * FROM users", (err, rows) => data.users = rows || []);
                db.all("SELECT * FROM clients ORDER BY name ASC", (err, rows) => data.clients = rows || []);
                db.all("SELECT * FROM client_movements ORDER BY id DESC LIMIT 500", (err, rows) => {
                    data.movements = rows || [];
                    resolve(data);
                });
            });
        }, 500); 
    });
});

// 2. GUARDAR PRODUCTO (CORREGIDO: AHORA GUARDA MARCA Y CATEGORIA)
ipcMain.handle('db-save-product', async (e, p) => {
    return new Promise((resolve) => {
        db.get("SELECT code FROM products WHERE code = ?", [p.code], (err, row) => {
            // ERROR ESTABA AQUI: Faltaban brand, category y subcategory en este array
            const params = [
                p.name, 
                p.supplier, 
                p.brand,       // Agregado
                p.category,    // Agregado
                p.subcategory, // Agregado
                p.size, 
                p.color, 
                p.cost, 
                p.margin, 
                p.price, 
                p.qty
            ];
            
            if(row) {
                // UPDATE
                db.run(`UPDATE products SET name=?, supplier=?, brand=?, category=?, subcategory=?, size=?, color=?, cost=?, margin=?, price=?, qty=? WHERE code=?`, 
                    [...params, p.code], (err) => {
                        if(err) console.log("Error Update:", err); // Para ver errores
                        resolve(!err);
                    });
            } else {
                // INSERT
                db.run(`INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, 
                    [p.code, ...params], (err) => {
                        if(err) console.log("Error Insert:", err); // Para ver errores
                        resolve(!err);
                    });
            }
        });
    });
});

// 3. Guardar Venta
ipcMain.handle('db-save-sale', async (e, s) => {
    return new Promise((resolve) => {
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            try {
                db.run("INSERT INTO sales (id, date, seller, total, payment, card_name, surcharge, discount, client_id, items_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    [s.id, s.date, s.seller, s.total, s.payment, s.card_name, s.surcharge, s.discount, s.client_id, JSON.stringify(s.items)]);
                
                s.items.forEach(item => {
                    if(!item.isManual) db.run("UPDATE products SET qty = qty - ? WHERE code = ?", [item.qty, item.code]);
                });

                if (s.payment === 'Cuenta Corriente' && s.client_id) {
                    db.run("UPDATE clients SET balance = balance + ? WHERE id = ?", [s.total, s.client_id]);
                    db.run("INSERT INTO client_movements (client_id, date, type, amount, note) VALUES (?,?,?,?,?)", 
                        [s.client_id, s.date, 'DEUDA', s.total, `Compra #${s.id}`]);
                }
                db.run("COMMIT", (err) => resolve({success: !err}));
            } catch (error) {
                db.run("ROLLBACK");
                resolve({success: false, error: error.message});
            }
        });
    });
});

// 4. Excel
ipcMain.handle('exportar-excel', async (event, payload) => {
    try {
        const { ventas, cierres } = payload;
        const reportDir = path.join(app.getPath('documents'), 'Sistema_Reportes');
        if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

        const today = new Date();
        const fileName = `Cierre_${String(today.getDate()).padStart(2,'0')}-${String(today.getMonth()+1).padStart(2,'0')}-${today.getFullYear()}.xlsx`;
        const filePath = path.join(reportDir, fileName);
        const wb = xlsx.utils.book_new();

        let totalEfectivo = 0, totalDigital = 0, totalCtaCte = 0, totalGeneral = 0;
        ventas.forEach(v => {
            totalGeneral += v.total;
            if(v.payment === 'Efectivo') totalEfectivo += v.total;
            else if(v.payment === 'Cuenta Corriente') totalCtaCte += v.total;
            else totalDigital += v.total;
        });

        const resumenData = [
            ["REPORTE DE CAJA"], ["Fecha:", new Date().toLocaleDateString()], [" "],
            ["RESUMEN FINANCIERO", "MONTO"],
            ["Total Efectivo", totalEfectivo], ["Total Digital", totalDigital], ["Total Fiado", totalCtaCte],
            ["TOTAL VENDIDO", totalGeneral], [" "],
            ["ARQUEOS"], ["Hora", "Usuario", "Sistema", "Real", "Diferencia", "Estado"]
        ];
        cierres.forEach(c => resumenData.push([c.date.split(',')[1], c.user, c.sys_cash, c.real_cash, c.diff, c.status]));
        xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(resumenData), "Resumen");
        
        const detalleData = [["ID", "Hora", "Vendedor", "Cliente", "Items", "Pago", "Total"]];
        ventas.forEach(v => {
            const itemsStr = v.items.map(i => `${i.qty}x ${i.name}`).join(" | ");
            detalleData.push([v.id, v.date.split(',')[1], v.seller, v.client_id?'Cliente':'Final', itemsStr, v.payment, v.total]);
        });
        xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(detalleData), "Detalle");

        xlsx.writeFile(wb, filePath);
        shell.showItemInFolder(filePath);
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
});

// Otros Handlers
ipcMain.handle('db-save-client', async (e, c) => {
    return new Promise(resolve => {
        if(c.id) db.run("UPDATE clients SET name=?, phone=?, address=? WHERE id=?", [c.name, c.phone, c.address, c.id], (err)=>resolve(!err));
        else db.run("INSERT INTO clients (name, phone, address, balance) VALUES (?,?,?,?)", [c.name, c.phone, c.address, c.balance||0], (err)=>resolve(!err));
    });
});
ipcMain.handle('db-pay-debt', async (e, {clientId, amount, note}) => {
    return new Promise(resolve => {
        db.serialize(() => {
            db.run("BEGIN");
            db.run("UPDATE clients SET balance = balance - ? WHERE id = ?", [amount, clientId]);
            db.run("INSERT INTO client_movements (client_id, date, type, amount, note) VALUES (?,?,?,?,?)", [clientId, new Date().toLocaleString(), 'PAGO', amount, note || 'Pago']);
            db.run("COMMIT", (err) => resolve({success: !err}));
        });
    });
});
ipcMain.handle('db-bulk-update', async (e, {provider, pct}) => {
    const factor = 1 + (pct/100);
    return new Promise(r => db.run(`UPDATE products SET cost = ROUND(cost * ?, 2), price = ROUND((cost * ?) * (1 + margin/100), 2) WHERE supplier = ?`, [factor, factor, provider], function(err) { r({success: !err}); }));
});
ipcMain.handle('db-save-closure', async (e, c) => {
    return new Promise(resolve => db.run("INSERT INTO closures (date, user, sys_cash, real_cash, diff, status, details_json) VALUES (?,?,?,?,?,?,?)", [c.date, c.user, c.sysCash, c.realCash, c.diff, c.status, JSON.stringify(c.details)], (err) => resolve(!err)));
});
ipcMain.handle('db-add-user', async (e, u) => { db.run("INSERT INTO users (name, pin) VALUES (?,?)", [u.name, u.pin]); return true; });
ipcMain.handle('db-factory-reset', async () => { return new Promise(r => db.serialize(() => { db.run("DELETE FROM products"); db.run("DELETE FROM sales"); db.run("DELETE FROM closures"); db.run("DELETE FROM clients"); db.run("DELETE FROM client_movements"); r({success:true}); })); });
ipcMain.handle('db-restore-backup', async () => ({success:true}));
ipcMain.handle('facturar-afip', async () => ({success:false, error:"Demo"}));
// En main.js
ipcMain.handle('db-delete-product', async (e, code) => {
    return new Promise(resolve => {
        db.run("DELETE FROM products WHERE code = ?", [code], (err) => {
            resolve({success: !err});
        });
    });
});
let mainWindow;
function createWindow() {
    mainWindow = new BrowserWindow({ width: 1200, height: 800, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
    mainWindow.loadFile('index.html');
}
app.whenReady().then(createWindow);