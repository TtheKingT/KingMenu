const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const { defineSecret } = require('firebase-functions/params');
const { HttpsError, onCall } = require('firebase-functions/v2/https');
const QRCode = require('qrcode');

if (!getApps().length) initializeApp();
const db = getFirestore();
const adminAuth = getAuth();

const APP_ID = 'kingmenu-caa89';
const MAX_ITEMS = 50;
const MAX_ITEM_QUANTITY = 20;
const RATE_WINDOW_MS = 60_000;
const USER_ORDER_LIMIT = 5;
const TABLE_ORDER_LIMIT = 12;
const TABLE_CALL_COOLDOWN_MS = 60_000;
const TABLE_QR_SECRET = defineSecret('TABLE_QR_SECRET');

function requireString(value, label, maxLength, { allowEmpty = false } = {}) {
    if (typeof value !== 'string') throw new HttpsError('invalid-argument', `${label} inválido.`);
    const normalized = value.trim();
    if ((!allowEmpty && !normalized) || normalized.length > maxLength) {
        throw new HttpsError('invalid-argument', `${label} inválido.`);
    }
    return normalized;
}

function parseRequest(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new HttpsError('invalid-argument', 'El pedido no tiene un formato válido.');
    }
    const allowedKeys = [
        'requestId', 'customer', 'table', 'tableId', 'tableSignature',
        'orderId', 'timestamp', 'status', 'notes', 'items'
    ];
    if (Object.keys(data).some(key => !allowedKeys.includes(key))) {
        throw new HttpsError('invalid-argument', 'El pedido contiene campos no permitidos.');
    }

    const requestId = requireString(data.requestId, 'Identificador del pedido', 64);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
        throw new HttpsError('invalid-argument', 'El identificador del pedido no es válido.');
    }
    const customer = requireString(data.customer, 'Nombre del cliente', 60);
    const table = requireString(data.tableId ?? data.table, 'Número de mesa', 3);
    if (!/^[0-9]{1,3}$/.test(table)) {
        throw new HttpsError('invalid-argument', 'El número de mesa debe contener entre 1 y 3 dígitos.');
    }
    if (data.table !== undefined && data.table !== table) {
        throw new HttpsError('invalid-argument', 'El número de mesa no coincide.');
    }
    const orderId = requireString(data.orderId ?? `#${requestId.replace(/-/g, '').slice(-6).toUpperCase()}`, 'Identificador de comanda', 9);
    if (!/^#[A-Z0-9]{4,8}$/.test(orderId)) {
        throw new HttpsError('invalid-argument', 'El identificador de comanda no es válido.');
    }
    if (data.timestamp !== undefined && (!Number.isSafeInteger(data.timestamp) || data.timestamp <= 0)) {
        throw new HttpsError('invalid-argument', 'La fecha de creación no es válida.');
    }
    if (data.status !== undefined && data.status !== 'pending') {
        throw new HttpsError('invalid-argument', 'El estado inicial de la comanda no es válido.');
    }
    const tableSignature = data.tableSignature === undefined
        ? ''
        : requireString(data.tableSignature, 'Firma del código QR', 64, { allowEmpty: true });
    if (tableSignature && !isValidTableSignature(table, tableSignature)) {
        throw new HttpsError('permission-denied', 'Escanee el código QR válido de su mesa para continuar.');
    }
    const notes = requireString(data.notes ?? '', 'Instrucciones', 500, { allowEmpty: true });
    if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > MAX_ITEMS) {
        throw new HttpsError('invalid-argument', `El pedido debe incluir entre 1 y ${MAX_ITEMS} platillos.`);
    }
    const items = data.items.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)
            || Object.keys(item).some(key => !['id', 'qty', 'notes'].includes(key))) {
            throw new HttpsError('invalid-argument', `El platillo ${index + 1} tiene un formato inválido.`);
        }
        const id = requireString(item.id, `Platillo ${index + 1}`, 128);
        if (!Number.isInteger(item.qty) || item.qty < 1 || item.qty > MAX_ITEM_QUANTITY) {
            throw new HttpsError('invalid-argument', `La cantidad del platillo ${index + 1} no es válida.`);
        }
        const itemNotes = requireString(item.notes ?? '', `Nota del platillo ${index + 1}`, 300, { allowEmpty: true });
        return { id, qty: item.qty, notes: itemNotes };
    });
    return {
        requestId,
        orderId,
        legacyRequest: typeof data.orderId !== 'string',
        timestamp: data.timestamp ?? Date.now(),
        customer,
        table,
        tableId: table,
        tableSignature,
        notes,
        items
    };
}

function tableSignature(table) {
    let secret;
    try {
        secret = TABLE_QR_SECRET.value();
    } catch (error) {
        console.error('[Table QR] No se pudo leer TABLE_QR_SECRET:', error);
        throw new HttpsError('failed-precondition', 'Configure TABLE_QR_SECRET en Firebase Secret Manager para generar códigos QR.');
    }
    if (!secret) throw new HttpsError('failed-precondition', 'La firma de los códigos QR no está configurada.');
    return createHmac('sha256', secret).update(`${APP_ID}:${table}`).digest('hex');
}

function isValidTableSignature(table, signature) {
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
    const expected = Buffer.from(tableSignature(table), 'hex');
    const supplied = Buffer.from(signature, 'hex');
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function callableOperationError(error, operation, fallbackMessage) {
    if (error instanceof HttpsError) return error;
    console.error(`[${operation}] Error inesperado:`, error);
    if (error?.code === 'auth/email-already-exists') {
        return new HttpsError('already-exists', 'Ya existe una cuenta con ese correo electrónico.');
    }
    if (error?.code === 'auth/invalid-email') {
        return new HttpsError('invalid-argument', 'El correo electrónico no es válido.');
    }
    if (error?.code === 'auth/invalid-password') {
        return new HttpsError('invalid-argument', 'La contraseña inicial debe tener entre 12 y 128 caracteres.');
    }
    if (error?.code === 'auth/user-not-found') {
        return new HttpsError('not-found', 'No se encontró la cuenta de empleado.');
    }
    if (error?.code === 'permission-denied' || error?.code === 'unavailable') {
        return new HttpsError(error.code, 'No se pudo validar el acceso o conectar con Firestore. Inténtelo de nuevo.');
    }
    return new HttpsError('internal', fallbackMessage);
}

function getUserRole(uid) {
    return db.collection('artifacts').doc(APP_ID).collection('public').doc('data')
        .collection('users').doc(uid).get();
}

function hasMfaSignIn(request) {
    return ['phone', 'totp'].includes(request.auth?.token?.firebase?.sign_in_second_factor);
}

async function requireOwnerMfa(request) {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Inicie sesión con una cuenta owner.');
    let user;
    try {
        user = await getUserRole(request.auth.uid);
    } catch (error) {
        console.error('[Admin] No se pudo consultar el perfil del owner:', error);
        throw new HttpsError('unavailable', 'No se pudo consultar el perfil administrativo en Firestore.');
    }
    if (!user.exists || user.data()?.active === false || user.data()?.role !== 'owner') {
        throw new HttpsError('permission-denied', 'Solo un owner activo puede gestionar esta función.');
    }
    // Enable only in the isolated demo Firebase project, never in production.
    const demoMfaOptional = process.env.KINGMENU_DEMO_MFA_OPTIONAL === 'true';
    if (!demoMfaOptional && !hasMfaSignIn(request)) {
        throw new HttpsError('permission-denied', 'La cuenta owner requiere verificación en dos pasos.');
    }
}

function priceProduct(product, productId) {
    const basePrice = product.price;
    if (typeof basePrice !== 'number' || !Number.isFinite(basePrice) || basePrice < 0 || basePrice > 999_999_999) {
        throw new HttpsError('failed-precondition', `El precio de ${product.name || productId} no es válido.`);
    }
    if (product.available === false) {
        throw new HttpsError('failed-precondition', `${product.name || 'Un platillo'} ya no está disponible.`);
    }

    const discountValue = Number(product.discountValue);
    if (product.discountType === 'percent' && discountValue > 0 && discountValue < 100) {
        return Math.round(basePrice * (1 - discountValue / 100));
    }
    if (product.discountType === 'price' && discountValue > 0 && discountValue < basePrice) {
        return discountValue;
    }
    return basePrice;
}

function toStaffOrder(order) {
    return {
        userId: order.userId,
        ...(typeof order.orderId === 'string' ? { orderId: order.orderId } : {}),
        customer: order.customer,
        tableId: order.tableId || order.table,
        table: order.table,
        notes: order.notes,
        items: order.items.map(item => ({
            id: item.id,
            name: item.name,
            nameEn: item.nameEn,
            qty: item.qty,
            notes: item.notes,
            allergens: item.allergens,
            allergensEn: item.allergensEn
        })),
        status: order.status,
        timestamp: order.timestamp
    };
}

function checkRateLimit(snapshot, limit, now) {
    if (!snapshot.exists) return { count: 1, windowStartedAt: now };
    const record = snapshot.data();
    const startedAt = typeof record.windowStartedAt === 'number'
        ? record.windowStartedAt
        : record.windowStartedAt?.toMillis?.() || 0;
    if (now - startedAt >= RATE_WINDOW_MS || now < startedAt) {
        return { count: 1, windowStartedAt: now };
    }
    if (!Number.isInteger(record.count) || record.count >= limit) {
        throw new HttpsError('resource-exhausted', 'Se alcanzó el límite temporal de pedidos. Inténtelo de nuevo en un minuto.');
    }
    return { count: record.count + 1, windowStartedAt: startedAt };
}

exports.createOrder = onCall({
    region: 'us-central1',
    maxInstances: 20,
    enforceAppCheck: true,
    secrets: [TABLE_QR_SECRET]
}, async request => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Inicie una sesión para enviar el pedido.');
    const payload = parseRequest(request.data);
    const userId = request.auth.uid;
    const userKey = createHash('sha256').update(userId).digest('hex');
    const orders = db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('orders');
    const staffOrders = db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('staffOrders');
    const products = db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('products');
    const rateLimits = db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('orderRateLimits');
    const orderRef = orders.doc(payload.requestId);
    const staffOrderRef = staffOrders.doc(payload.requestId);
    const userRateRef = rateLimits.doc(`user_${userKey}`);
    const tableRateRef = rateLimits.doc(`table_${payload.table}`);

    return db.runTransaction(async transaction => {
        const existingOrder = await transaction.get(orderRef);
        if (existingOrder.exists) {
            if (existingOrder.data().userId !== userId) {
                throw new HttpsError('already-exists', 'El identificador del pedido ya fue utilizado.');
            }
            if (payload.legacyRequest) return { orderId: orderRef.id };
            return {
                id: orderRef.id,
                orderId: existingOrder.data().orderId || payload.orderId
            };
        }

        const productRefs = payload.items.map(item => products.doc(item.id));
        const reads = await transaction.getAll(userRateRef, tableRateRef, ...productRefs);
        const userRate = checkRateLimit(reads[0], USER_ORDER_LIMIT, Date.now());
        const tableRate = checkRateLimit(reads[1], TABLE_ORDER_LIMIT, Date.now());
        const products = new Map();
        productRefs.forEach((ref, index) => products.set(ref.id, reads[index + 2]));

        let total = 0;
        const items = payload.items.map(item => {
            const productSnapshot = products.get(item.id);
            if (!productSnapshot?.exists) {
                throw new HttpsError('not-found', 'Uno de los platillos ya no está en la carta.');
            }
            const product = productSnapshot.data();
            const price = priceProduct(product, item.id);
            total += price * item.qty;
            if (!Number.isFinite(total) || total > 999_999_999) {
                throw new HttpsError('failed-precondition', 'El total del pedido excede el límite permitido.');
            }
            return {
                id: item.id,
                name: requireString(product.name, 'Nombre del platillo', 120),
                nameEn: typeof product.nameEn === 'string' ? product.nameEn.slice(0, 120) : '',
                price,
                qty: item.qty,
                notes: item.notes,
                allergens: typeof product.allergens === 'string' ? product.allergens.slice(0, 500) : '',
                allergensEn: typeof product.allergensEn === 'string' ? product.allergensEn.slice(0, 500) : '',
                discountType: ['percent', 'price'].includes(product.discountType) ? product.discountType : 'none',
                discountValue: Number.isFinite(Number(product.discountValue)) ? Number(product.discountValue) : 0
            };
        });

        const order = {
            orderId: payload.orderId,
            customer: payload.customer,
            tableId: payload.tableId,
            table: payload.table,
            notes: payload.notes,
            items,
            total,
            status: payload.legacyRequest ? 'Recibido' : 'pending',
            userId,
            timestamp: FieldValue.serverTimestamp()
        };
        transaction.create(orderRef, order);
        transaction.create(staffOrderRef, toStaffOrder(order));
        transaction.set(userRateRef, {
            count: userRate.count,
            windowStartedAt: userRate.windowStartedAt,
            updatedAt: FieldValue.serverTimestamp()
        });
        transaction.set(tableRateRef, {
            count: tableRate.count,
            windowStartedAt: tableRate.windowStartedAt,
            updatedAt: FieldValue.serverTimestamp()
        });
        if (payload.legacyRequest) return { orderId: orderRef.id };
        return { id: orderRef.id, orderId: payload.orderId };
    });
});

exports.generateTableQr = onCall({
    region: 'us-central1',
    maxInstances: 5,
    enforceAppCheck: true,
    secrets: [TABLE_QR_SECRET]
}, async request => {
    try {
        await requireOwnerMfa(request);
        const table = requireString(request.data?.table, 'Número de mesa', 3);
        if (!/^[0-9]{1,3}$/.test(table)) {
            throw new HttpsError('invalid-argument', 'El número de mesa debe contener entre 1 y 3 dígitos.');
        }

        let pageUrl;
        try {
            pageUrl = new URL(requireString(request.data?.pageUrl, 'URL del menú', 2048));
        } catch {
            throw new HttpsError('invalid-argument', 'La URL del menú no es válida.');
        }
        const requestOrigin = request.rawRequest?.headers?.origin;
        if (!requestOrigin || pageUrl.username || pageUrl.password || pageUrl.origin !== requestOrigin
            || (pageUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(pageUrl.hostname))) {
            throw new HttpsError('invalid-argument', 'La URL del menú no pertenece al origen actual.');
        }
        const signature = tableSignature(table);
        pageUrl.search = '';
        pageUrl.hash = '';
        pageUrl.searchParams.set('m', table);
        pageUrl.searchParams.set('s', signature);
        const url = pageUrl.toString();
        const qrDataUrl = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 384 });
        return { table, url, qrDataUrl };
    } catch (error) {
        throw callableOperationError(error, 'Table QR', 'No se pudo generar el código QR. Verifique la configuración de TABLE_QR_SECRET e inténtelo de nuevo.');
    }
});

exports.manageStaff = onCall({
    region: 'us-central1',
    maxInstances: 5,
    enforceAppCheck: true
}, async request => {
    try {
        await requireOwnerMfa(request);
        const data = request.data;
        if (!data || typeof data !== 'object' || Array.isArray(data)
            || !['list', 'create', 'deactivate'].includes(data.action)) {
            throw new HttpsError('invalid-argument', 'La operación de empleados no es válida.');
        }

        const users = db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('users');
        if (data.action === 'list') {
            if (Object.keys(data).some(key => key !== 'action')) {
                throw new HttpsError('invalid-argument', 'La solicitud contiene campos no permitidos.');
            }
            const snapshot = await users.where('role', '==', 'employee').get();
            if (snapshot.empty) return { employees: [] };
            const employees = await Promise.all(snapshot.docs.map(async employeeDoc => {
                const employee = employeeDoc.data();
                try {
                    const account = await adminAuth.getUser(employeeDoc.id);
                    return {
                        uid: employeeDoc.id,
                        email: account.email || employee.email || '',
                        disabled: account.disabled || employee.active === false
                    };
                } catch (error) {
                    if (error?.code !== 'auth/user-not-found') throw error;
                    console.warn(`[Staff] El perfil ${employeeDoc.id} no tiene una cuenta Auth; se mostrará como desactivado.`);
                    return {
                        uid: employeeDoc.id,
                        email: employee.email || '',
                        disabled: true
                    };
                }
            }));
            return { employees };
        }

        if (data.action === 'create') {
            if (Object.keys(data).some(key => !['action', 'email', 'password'].includes(key))) {
                throw new HttpsError('invalid-argument', 'La solicitud contiene campos no permitidos.');
            }
            const email = requireString(data.email, 'Correo electrónico', 254).toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                throw new HttpsError('invalid-argument', 'El correo electrónico no es válido.');
            }
            if (typeof data.password !== 'string' || data.password.length < 12 || data.password.length > 128) {
                throw new HttpsError('invalid-argument', 'La contraseña inicial debe tener entre 12 y 128 caracteres.');
            }

            const account = await adminAuth.createUser({ email, password: data.password });
            try {
                await users.doc(account.uid).create({
                    role: 'employee',
                    active: true,
                    email,
                    createdAt: FieldValue.serverTimestamp()
                });
            } catch (error) {
                try {
                    await adminAuth.deleteUser(account.uid);
                } catch (cleanupError) {
                    console.error('[Staff] No se pudo revertir la cuenta tras fallar la asignación del rol:', cleanupError);
                }
                throw error;
            }
            return { uid: account.uid };
        }

        if (Object.keys(data).some(key => !['action', 'uid'].includes(key))) {
            throw new HttpsError('invalid-argument', 'La solicitud contiene campos no permitidos.');
        }
        const uid = requireString(data.uid, 'Identificador de empleado', 128);
        if (!/^[A-Za-z0-9_-]+$/.test(uid)) {
            throw new HttpsError('invalid-argument', 'El identificador de empleado no es válido.');
        }
        const employeeRef = users.doc(uid);
        const employeeSnapshot = await employeeRef.get();
        if (!employeeSnapshot.exists || employeeSnapshot.data().role !== 'employee') {
            throw new HttpsError('not-found', 'No se encontró el empleado solicitado.');
        }

        await employeeRef.update({
            active: false,
            deactivatedAt: FieldValue.serverTimestamp()
        });
        try {
            await adminAuth.updateUser(uid, { disabled: true });
            await adminAuth.revokeRefreshTokens(uid);
        } catch (error) {
            console.error('[Staff] El rol fue revocado, pero no se pudo desactivar la cuenta de Firebase Auth:', error);
            throw new HttpsError('internal', 'Se revocó el acceso administrativo, pero no se pudo desactivar la cuenta de acceso.');
        }
        return { uid, disabled: true };
    } catch (error) {
        throw callableOperationError(error, 'Staff management', 'No se pudo completar la operación de empleados. Revise la configuración de Firebase Admin y vuelva a intentarlo.');
    }
});

exports.createWaiterCall = onCall({
    region: 'us-central1',
    maxInstances: 20,
    enforceAppCheck: true,
    secrets: [TABLE_QR_SECRET]
}, async request => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Se requiere una sesión para llamar a un mesero.');
    const table = requireString(request.data?.table, 'Número de mesa', 3);
    const signature = request.data?.tableSignature === undefined
        ? ''
        : requireString(request.data.tableSignature, 'Firma del código QR', 64, { allowEmpty: true });
    if (!/^[0-9]{1,3}$/.test(table) || (signature && !isValidTableSignature(table, signature))) {
        throw new HttpsError('permission-denied', 'Escanee el código QR válido de su mesa para solicitar asistencia.');
    }

    const limits = db.collection('artifacts').doc(APP_ID).collection('public').doc('data')
        .collection('waiterCallLimits');
    const calls = db.collection('artifacts').doc(APP_ID).collection('public').doc('data')
        .collection('calls');
    const limitRef = limits.doc(`table_${table}`);
    const callRef = calls.doc();
    const now = Date.now();
    await db.runTransaction(async transaction => {
        const limitSnapshot = await transaction.get(limitRef);
        const lastCallAt = limitSnapshot.data()?.lastCallAt?.toMillis?.() || 0;
        if (now - lastCallAt < TABLE_CALL_COOLDOWN_MS) {
            throw new HttpsError('resource-exhausted', 'Ya se solicitó asistencia para esta mesa. Espere un minuto.');
        }
        transaction.create(callRef, {
            table,
            userId: request.auth.uid,
            time: new Date(now).toISOString(),
            timestamp: FieldValue.serverTimestamp()
        });
        transaction.set(limitRef, {
            lastCallAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
        });
    });
    return { callId: callRef.id };
});
