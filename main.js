const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const xlsx = require('xlsx'); 

// --- CAMBIO IMPORTANTE PARA .EXE ---
// En vez de __dirname, usamos 'userData'. 
// Esto guarda la DB en C:\Users\TuNombre\AppData\Roaming\SHESYSTEM
const dbPath = path.join(app.getPath('userData'), 'SHE.db');
app.disableHardwareAcceleration();
console.log("Ruta de la Base de Datos:", dbPath); // Para que sepas dónde está
// -----------------------------------

const db = new sqlite3.Database(dbPath);

// --- INICIALIZACIÓN DE TABLAS ---
// --- INICIALIZACIÓN DE TABLAS Y MIGRACIONES ROBUSTAS ---
db.serialize(() => {
    // 1. Crear tablas base si no existen
    db.run(`CREATE TABLE IF NOT EXISTS products (code TEXT PRIMARY KEY, name TEXT, supplier TEXT, brand TEXT, category TEXT, subcategory TEXT, size TEXT, color TEXT, cost REAL, margin REAL, price REAL, qty INTEGER)`);
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, pin TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS closures (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, user TEXT, sys_cash REAL, real_cash REAL, diff REAL, status TEXT, details_json TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS sales (id INTEGER PRIMARY KEY, date TEXT, seller TEXT, total REAL, payment TEXT, card_name TEXT, surcharge REAL, discount REAL, client_id INTEGER, items_json TEXT, cuit TEXT, fiscal TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT, address TEXT, balance REAL DEFAULT 0, dni TEXT, credit_limit REAL DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS client_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER, date TEXT, type TEXT, amount REAL, note TEXT)`);
    // AGREGAR ESTO EN db.serialize:
db.run(`CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, description TEXT, amount REAL, method TEXT, user TEXT)`);
    // 2. RECUPERACIÓN ADMIN
    db.get("SELECT * FROM users WHERE name = 'Admin'", (err, row) => {
        if(!row) db.run("INSERT INTO users (name, pin) VALUES ('Admin', '1111')");
    });

    // 3. MIGRADOR DE COLUMNAS FALTANTES (¡ESTO SOLUCIONA TU ERROR!)
    // Función auxiliar para agregar columnas si faltan
    function addCol(table, col, type) {
        db.all(`PRAGMA table_info(${table})`, (err, cols) => {
            if (!err && cols) {
                // Verificamos si la columna ya existe
                const exists = cols.some(c => c.name === col);
                if (!exists) {
                    console.log(`[Migración] Agregando columna ${col} a ${table}...`);
                    db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`, (err) => {
                        if(err) console.log(`Error migrando ${col}:`, err.message);
                    });
                }
            }
        });
    }

    // Lista de columnas nuevas que quizás tu DB vieja no tiene
    addCol('clients', 'dni', 'TEXT');
    addCol('clients', 'credit_limit', 'REAL DEFAULT 0'); // <--- AQUÍ ESTÁ EL ARREGLO
    addCol('products', 'brand', 'TEXT');
    addCol('products', 'category', 'TEXT');
    addCol('products', 'subcategory', 'TEXT');
    addCol('sales', 'cuit', 'TEXT');
    addCol('sales', 'fiscal', 'TEXT');
});

// --- API ---

// 1. OBTENER TODO
ipcMain.handle('db-get-all', async () => {
    return new Promise((resolve) => {
        setTimeout(() => {
            // AGREGAMOS expenses: [] AQUI
            const data = { stock: [], users: [], sales: [], closures: [], clients: [], movements: [], expenses: [] };
            db.serialize(() => {
                db.all("SELECT * FROM products", (err, rows) => data.stock = rows || []);
                db.all("SELECT * FROM sales", (err, rows) => data.sales = (rows || []).map(r => ({...r, items: JSON.parse(r.items_json)})));
                db.all("SELECT * FROM closures", (err, rows) => data.closures = (rows || []).map(r => ({...r, details: JSON.parse(r.details_json)})));
                db.all("SELECT * FROM users", (err, rows) => data.users = rows || []);
                db.all("SELECT * FROM clients ORDER BY name ASC", (err, rows) => data.clients = rows || []);
                db.all("SELECT * FROM client_movements ORDER BY id DESC LIMIT 500", (err, rows) => data.movements = rows || []);
                
                // --- NUEVO: CARGAR GASTOS ---
                db.all("SELECT * FROM expenses ORDER BY id DESC LIMIT 100", (err, rows) => {
                    data.expenses = rows || [];
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
// REEMPLAZAR EL BLOQUE ipcMain.handle('exportar-excel'...) EN main.js

ipcMain.handle('exportar-excel', async (event, payload) => {
    try {
        const { ventas, cierres } = payload;
        const reportDir = path.join(app.getPath('documents'), 'Sistema_Reportes');
        if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

        const today = new Date();
        const fileName = `Cierre_${String(today.getDate()).padStart(2,'0')}-${String(today.getMonth()+1).padStart(2,'0')}-${today.getFullYear()}.xlsx`;
        const filePath = path.join(reportDir, fileName);
        const wb = xlsx.utils.book_new();

        // 1. Cálculos Generales
        let totalEfectivo = 0, totalDigital = 0, totalCtaCte = 0, totalGeneral = 0;
        ventas.forEach(v => {
            totalGeneral += v.total;
            if(v.payment === 'Efectivo') totalEfectivo += v.total;
            else if(v.payment === 'Cuenta Corriente') totalCtaCte += v.total;
            else totalDigital += v.total;
        });

        // 2. Armado de Hoja Resumen
        // Agregamos la columna "Detalle Físico" al final
        const resumenData = [
            ["REPORTE DE CAJA"], ["Fecha:", new Date().toLocaleDateString()], [" "],
            ["RESUMEN FINANCIERO", "MONTO"],
            ["Total Efectivo", totalEfectivo], ["Total Digital", totalDigital], ["Total Fiado", totalCtaCte],
            ["TOTAL VENDIDO", totalGeneral], [" "],
            ["HISTORIAL DE CIERRES (ARQUEOS)"], 
            ["Hora", "Usuario", "Sistema (Debería)", "Real (Contado)", "Diferencia", "Estado", "Detalle Físico (Billetes)"]
        ];

        cierres.forEach(c => {
            // Convertimos el JSON de detalles a texto legible para el Excel
            // Ej: "5 x $1000 | 2 x $500"
            let detalleTexto = "";
            try {
                // Si viene como string, lo parseamos, si ya es objeto lo usamos
                const det = (typeof c.details === 'string') ? JSON.parse(c.details) : c.details;
                
                if(det) {
                    // Recorremos las claves (ej: $1000) y valores (ej: 5)
                    detalleTexto = Object.entries(det)
                        .map(([billete, cant]) => `${cant} x ${billete}`)
                        .join(" | ");
                }
            } catch(e) { detalleTexto = "-"; }

            resumenData.push([
                c.date.split(',')[1] || c.date, // Hora
                c.user, 
                c.sys_cash, 
                c.real_cash, 
                c.diff, 
                c.status,
                detalleTexto // <--- Aquí va el desglose de billetes
            ]);
        });

        xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(resumenData), "Resumen");
        
        // 3. Armado de Hoja Detalle Ventas
        const detalleData = [["ID", "Hora", "Vendedor", "Cliente", "Items", "Pago", "Total"]];
        ventas.forEach(v => {
            let itemsStr = "";
            try {
                 const items = (typeof v.items === 'string') ? JSON.parse(v.items) : v.items;
                 itemsStr = items.map(i => `${i.qty}x ${i.name}`).join(" | ");
            } catch(e){ itemsStr = "Error datos"; }
            
            detalleData.push([v.id, v.date.split(',')[1], v.seller, v.client_id?'Cliente':'Final', itemsStr, v.payment, v.total]);
        });
        xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(detalleData), "Detalle Ventas");

        xlsx.writeFile(wb, filePath);
        shell.showItemInFolder(filePath);
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
});

// Otros Handlers
// REEMPLAZAR EN main.js
// --- MEJORA 1: VALIDACIÓN DE CLIENTES DUPLICADOS ---
ipcMain.handle('db-save-client', async (e, c) => {
    return new Promise(resolve => {
        // 1. Si es un cliente NUEVO (no tiene ID), verificamos duplicados
        if (!c.id) {
            // Buscamos si existe alguien con ese DNI (si no está vacío) O con ese Nombre exacto
            const checkSql = "SELECT id FROM clients WHERE (dni = ? AND dni != '') OR name = ?";
            db.get(checkSql, [c.dni, c.name], (err, row) => {
                if (row) {
                    // Si encontramos una fila, devolvemos error
                    resolve({ success: false, error: "Ya existe un cliente con ese Nombre o DNI." });
                } else {
                    // Si no existe, procedemos al INSERT
                    db.run("INSERT INTO clients (name, dni, phone, address, balance) VALUES (?,?,?,?,?)",
                        [c.name, c.dni, c.phone, c.address, c.balance || 0],
                        (err) => resolve({ success: !err, error: err ? err.message : null }));
                }
            });
        } else {
            // 2. Si es UPDATE (tiene ID), actualizamos normal
            db.run("UPDATE clients SET name=?, dni=?, phone=?, address=? WHERE id=?",
                [c.name, c.dni, c.phone, c.address, c.id],
                (err) => resolve({ success: !err, error: err ? err.message : null }));
        }
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
// REEMPLAZAR EN main.js
// EN MAIN.JS: Reemplaza todo el ipcMain.handle('db-bulk-update'...) por esto:

ipcMain.handle('db-bulk-update', async (e, {criteria, value, pct}) => {
    const factor = 1 + (pct/100);
    let sql = "";
    let params = [];

    // LÓGICA CORREGIDA:
    // Actualizamos Costo Y Precio multiplicando cada uno por el porcentaje.
    // Así, si el costo es 0 pero el precio es 100, el precio sube correctamente.

    if(criteria === 'supplier'){
        sql = `UPDATE products SET cost = ROUND(cost * ?, 2), price = ROUND(price * ?, 2) WHERE supplier = ?`;
        params = [factor, factor, value];
    } 
    else if (criteria === 'category'){
        sql = `UPDATE products SET cost = ROUND(cost * ?, 2), price = ROUND(price * ?, 2) WHERE category = ?`;
        params = [factor, factor, value];
    }

    return new Promise(r => db.run(sql, params, function(err) { 
        if(err) console.log(err);
        r({success: !err, count: this.changes}); 
    }));
});
ipcMain.handle('db-save-closure', async (e, c) => {
    return new Promise(resolve => db.run("INSERT INTO closures (date, user, sys_cash, real_cash, diff, status, details_json) VALUES (?,?,?,?,?,?,?)", [c.date, c.user, c.sysCash, c.realCash, c.diff, c.status, JSON.stringify(c.details)], (err) => resolve(!err)));
});
ipcMain.handle('db-add-user', async (e, u) => { db.run("INSERT INTO users (name, pin) VALUES (?,?)", [u.name, u.pin]); return true; });
// REEMPLAZAR EN main.js
ipcMain.handle('db-factory-reset', async () => { 
    return new Promise(r => db.serialize(() => { 
        // 1. Borramos todas las tablas
        db.run("DELETE FROM products"); 
        db.run("DELETE FROM sales"); 
        db.run("DELETE FROM closures"); 
        db.run("DELETE FROM clients"); 
        db.run("DELETE FROM client_movements"); 
        
        // --- LAS QUE FALTABAN ---
        db.run("DELETE FROM expenses"); // Borra pagos a proveedores/retiros
        db.run("DELETE FROM users");    // Borra a Brisa y a todos los demás

        // 2. IMPORTANTE: Recrear al usuario Admin por defecto
        // Si no hacemos esto, el sistema queda vacío y nadie puede entrar.
        db.run("INSERT INTO users (name, pin) VALUES ('Admin', '1111')");

        r({success:true}); 
    })); 
});
// --- RESTAURACIÓN INTELIGENTE (ADMITE BACKUPS VIEJOS) ---
// --- RESTAURACIÓN INTELIGENTE (ADMITE BACKUPS VIEJOS) ---
// --- NUEVO: BORRAR CLIENTE ---
ipcMain.handle('db-delete-client', async (e, id) => {
    return new Promise(resolve => {
        // Primero verificamos si tiene deuda
        db.get("SELECT balance FROM clients WHERE id = ?", [id], (err, row) => {
            if(row && row.balance > 0.5) { // Si debe más de 50 centavos
                resolve({ success: false, error: "El cliente tiene deuda pendiente. No se puede borrar." });
            } else {
                // Si no debe nada, lo borramos
                db.run("DELETE FROM clients WHERE id = ?", [id], (err) => {
                    if(!err){
                        // Opcional: Borrar historial de movimientos de ese cliente para limpiar DB
                        db.run("DELETE FROM client_movements WHERE client_id = ?", [id]);
                    }
                    resolve({ success: !err, error: err ? err.message : null });
                });
            }
        });
    });
});

ipcMain.handle('db-restore-backup', async (e, data) => {
    return new Promise((resolve) => {
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            try {
                // 1. LIMPIEZA TOTAL (Borramos datos actuales para evitar duplicados)
                db.run("DELETE FROM products");
                db.run("DELETE FROM clients");
                db.run("DELETE FROM sales");
                db.run("DELETE FROM closures");
                db.run("DELETE FROM client_movements");
                db.run("DELETE FROM users");

                // 2. RESTAURAR PRODUCTOS (Adaptando estructura vieja a nueva)
                if (data.stock && data.stock.length > 0) {
                    const stmt = db.prepare(`INSERT INTO products (
                        code, name, supplier, brand, category, subcategory, 
                        size, color, cost, margin, price, qty
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

                    data.stock.forEach(p => {
                        stmt.run(
                            p.code, 
                            p.name, 
                            p.supplier || 'General',   // Si no tiene proveedor, pone 'General'
                            p.brand || '',             // Rellena huecos nuevos con vacío
                            p.category || '', 
                            p.subcategory || '', 
                            p.size || '', 
                            p.color || '', 
                            p.cost || 0, 
                            p.margin || 0, 
                            p.price || 0, 
                            p.qty || 0
                        );
                    });
                    stmt.finalize();
                }

                // 3. RESTAURAR CLIENTES (Adaptando estructura vieja)
                if (data.clients && data.clients.length > 0) {
                    const stmt = db.prepare("INSERT INTO clients (id, name, phone, address, balance, dni, credit_limit) VALUES (?,?,?,?,?,?,?)");
                    data.clients.forEach(c => {
                        stmt.run(
                            c.id, 
                            c.name, 
                            c.phone || '', 
                            c.address || '', 
                            c.balance || 0,
                            c.dni || '',           // Campo nuevo
                            c.credit_limit || 0    // Campo nuevo
                        );
                    });
                    stmt.finalize();
                }

                // 4. RESTAURAR VENTAS (Sales)
                if (data.sales && data.sales.length > 0) {
                    // Nota: items_json es vital. Si el backup viejo lo tiene, genial.
                    const stmt = db.prepare("INSERT INTO sales (id, date, seller, total, payment, card_name, surcharge, discount, client_id, items_json) VALUES (?,?,?,?,?,?,?,?,?,?)");
                    data.sales.forEach(s => {
                        // Aseguramos que items_json sea un string válido
                        let itemsStr = typeof s.items_json === 'string' ? s.items_json : JSON.stringify(s.items || []);
                        
                        stmt.run(
                            s.id, s.date, s.seller, s.total, s.payment, 
                            s.card_name || '', 
                            s.surcharge || 0, 
                            s.discount || 0, 
                            s.client_id, 
                            itemsStr
                        );
                    });
                    stmt.finalize();
                }

                // 5. RESTAURAR EL RESTO (Cierres, Movimientos, Usuarios)
                // Estos suelen cambiar menos, pero aplicamos la misma lógica si hiciera falta.
                if(data.closures) {
                    const stmt = db.prepare("INSERT INTO closures VALUES (?,?,?,?,?,?,?,?)");
                    data.closures.forEach(c => stmt.run(c.id, c.date, c.user, c.sys_cash, c.real_cash, c.diff, c.status, (typeof c.details_json === 'string' ? c.details_json : JSON.stringify(c.details))));
                    stmt.finalize();
                }
                
                if(data.movements) {
                    const stmt = db.prepare("INSERT INTO client_movements VALUES (?,?,?,?,?,?)");
                    data.movements.forEach(m => stmt.run(m.id, m.client_id, m.date, m.type, m.amount, m.note));
                    stmt.finalize();
                }

                if(data.users) {
                    const stmt = db.prepare("INSERT INTO users VALUES (?,?,?)");
                    data.users.forEach(u => stmt.run(u.id, u.name, u.pin));
                    stmt.finalize();
                }

                db.run("COMMIT", () => resolve({ success: true }));

            } catch (err) {
                db.run("ROLLBACK"); // Si algo falla, deshace todo para no romper la DB
                console.error("Error Restore:", err);
                resolve({ success: false, error: err.message });
            }
        });
    });
});
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

// --- NUEVO: GUARDAR GASTO ---
ipcMain.handle('db-save-expense', async (e, ex) => {
    return new Promise(resolve => {
        db.run("INSERT INTO expenses (date, description, amount, method, user) VALUES (?,?,?,?,?)",
            [ex.date, ex.description, ex.amount, ex.method, ex.user],
            (err) => resolve({ success: !err, error: err ? err.message : null })
        );
    });
});

function createWindow() {
    mainWindow = new BrowserWindow({ width: 1200, height: 800, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
    mainWindow.loadFile('index.html');
}

ipcMain.handle('print-ticket', async (event, content) => {
    // Creamos una ventana invisible solo para imprimir
    const workerWindow = new BrowserWindow({ show: false });
    
    // Cargamos el HTML del ticket
    await workerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(content)}`);
    
    // Cuando termine de cargar, imprimimos
    return new Promise((resolve) => {
        workerWindow.webContents.once('did-finish-load', () => {
            workerWindow.webContents.print({
                silent: false, // false = abre cuadro de diálogo (true = imprime directo si hay impresora default)
                printBackground: true
            }, (success, errorType) => {
                if (!success) console.log("Error impresión:", errorType);
                workerWindow.close(); // Cerramos la ventana fantasma
                resolve({ success });
            });
        });
    });
});

app.whenReady().then(createWindow);