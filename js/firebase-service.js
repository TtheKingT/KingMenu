/**
 * ==========================================================================
 * KingMenu | Firebase & Firestore Service Module (Resilient & High-Performance)
 * ==========================================================================
 */

import { deleteApp, getApp, getApps, initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app-check.js";
import {
    getAuth,
    createUserWithEmailAndPassword,
    signInAnonymously,
    signInWithEmailAndPassword,
    deleteUser,
    signOut,
    onAuthStateChanged,
    connectAuthEmulator,
    getMultiFactorResolver,
    PhoneAuthProvider,
    PhoneMultiFactorGenerator,
    RecaptchaVerifier
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import {
    getFirestore,
    collection,
    doc,
    getDoc,
    getDocs,
    setDoc,
    updateDoc,
    onSnapshot,
    addDoc,
    deleteDoc,
    serverTimestamp,
    query,
    where,
    writeBatch,
    connectFirestoreEmulator
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import {
    connectStorageEmulator,
    getDownloadURL,
    getStorage,
    ref as storageRef,
    uploadBytesResumable
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-storage.js";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-functions.js";

export const appId = 'kingmenu-caa89';

export let db = null;
export let auth = null;
export let currentUser = null;
export let currentUserRole = null;

const ACTIVE_ORDER_STATUSES = ['pending', 'preparing', 'cooking', 'ready', 'Recibido', 'Preparando', 'Cocina', 'Listo'];
let functions = null;
let storage = null;
let appCheck = null;
let pendingOrderRequestId = null;
let pendingOrderFingerprint = null;
let pendingOrderTicketId = null;
let pendingOrderTimestamp = null;
let emulatorsConnected = false;
let adminMfaResolver = null;
let adminMfaVerificationId = null;
let adminMfaVerifier = null;

export function isAdminMfaOptional() {
    const environment = document.querySelector('meta[name="kingmenu-environment"]')
        ?.content.trim().toLowerCase();
    return environment === 'demo' || environment === 'prototype';
}

function requireOwnerRole() {
    if (currentUserRole !== 'owner') throw new Error("Esta operación requiere permisos de owner.");
}

function requireStaffRole() {
    if (!['owner', 'employee'].includes(currentUserRole)) {
        throw new Error("Esta operación requiere permisos administrativos.");
    }
}

const firebaseConfig = {
    apiKey: "AIzaSyB8npzwQK9k7BkCFuAzBCWN1E-962daljk",
    authDomain: "kingmenu-caa89.firebaseapp.com",
    projectId: "kingmenu-caa89",
    messagingSenderId: "458611284043",
    appId: "1:458611284043:web:8d6d457fc278ec8f7b15ce",
    measurementId: "G-6PHGWRMZXY"
};

function startPrivilegedListeners(callbacks = {}, role = null) {
    if (!db) return;
    orderUnsubscribe?.();
    callsUnsubscribe?.();
    orderUnsubscribe = null;
    callsUnsubscribe = null;

    if (!currentUser) {
        callbacks.onOrders?.([]);
        callbacks.onCalls?.([]);
        return;
    }

    try {
        const ordersRef = collection(db, "artifacts", appId, "public", "data", role === 'employee' ? "staffOrders" : "orders");
        let receivedInitialOrdersSnapshot = false;
        const ordersQuery = role === 'owner'
            ? ordersRef
            : role === 'employee'
                ? query(ordersRef, where("status", "in", ACTIVE_ORDER_STATUSES))
                : query(ordersRef, where("userId", "==", currentUser.uid));
        orderUnsubscribe = onSnapshot(ordersQuery, (snap) => {
            const orders = snap.docs.map(d => {
                const data = d.data();
                const ts = data.timestamp;
                let seconds = 0;
                if (ts) {
                    if (typeof ts.seconds === 'number') seconds = ts.seconds;
                    else if (typeof ts.toDate === 'function') seconds = ts.toDate().getTime() / 1000;
                    else if (ts instanceof Date) seconds = ts.getTime() / 1000;
                    else if (typeof ts === 'number') seconds = ts > 1e11 ? ts / 1000 : ts;
                }
                return {
                    ...data,
                    id: d.id,
                    _normalizedSeconds: seconds > 0 ? seconds : null
                };
            }).sort((a, b) => (b._normalizedSeconds || 0) - (a._normalizedSeconds || 0));

            callbacks.onOrders?.(orders);
            if (receivedInitialOrdersSnapshot) {
                const ordersById = new Map(orders.map(order => [order.id, order]));
                const addedOrders = snap.docChanges()
                    .filter(change => change.type === 'added')
                    .map(change => ordersById.get(change.doc.id))
                    .filter(Boolean);
                if (addedOrders.length) callbacks.onNewOrders?.(addedOrders);
            } else {
                receivedInitialOrdersSnapshot = true;
            }
            if (role === 'owner' && !staffOrderBackfillPromise) {
                staffOrderBackfillPromise = backfillStaffOrders(orders)
                    .catch(error => {
                        staffOrderBackfillPromise = null;
                        console.error("[Firestore] No se pudieron preparar las órdenes activas para empleados:", error);
                    });
            }
        }, (error) => {
            console.error("[Firestore] No se pudieron leer los pedidos:", error);
            callbacks.onOrders?.([]);
        });
    } catch (error) {
        console.error("[Firestore] No se pudo iniciar el listener de pedidos:", error);
    }

    if (!['owner', 'employee'].includes(role)) {
        callbacks.onCalls?.([]);
        return;
    }

    try {
        callsUnsubscribe = onSnapshot(collection(db, "artifacts", appId, "public", "data", "calls"), (snap) => {
            callbacks.onCalls?.(snap.docs.map(d => ({ ...d.data(), id: d.id })));
        }, (error) => {
            console.error("[Firestore] No se pudieron leer los llamados:", error);
            callbacks.onCalls?.([]);
        });
    } catch (error) {
        console.error("[Firestore] No se pudo iniciar el listener de llamados:", error);
    }
}

/* ==========================================================================
   FIRESTORE SERVICE STATE
   ========================================================================== */

let orderUnsubscribe = null;
let callsUnsubscribe = null;
let firestoreListenersStarted = false;
let staffOrderBackfillPromise = null;

function isActiveOrder(status) {
    return ACTIVE_ORDER_STATUSES.includes(status) || ['pending', 'preparing', 'cooking', 'ready'].includes(normalizeOrderStatus(status));
}

function canTransitionOrderStatus(currentStatus, nextStatus) {
    const nextByStatus = {
        pending: 'preparing',
        preparing: 'cooking',
        cooking: 'ready',
        ready: 'delivered',
        delivered: 'paid'
    };
    return nextByStatus[normalizeOrderStatus(currentStatus)] === normalizeOrderStatus(nextStatus);
}

function normalizeOrderStatus(status) {
    return ({
        Recibido: 'pending',
        Preparando: 'preparing',
        Cocina: 'cooking',
        Listo: 'ready',
        Entregado: 'delivered',
        Finalizado: 'paid'
    })[status] || status;
}

function toStaffOrder(order) {
    return {
        userId: order.userId,
        ...(typeof order.orderId === 'string' ? { orderId: order.orderId } : {}),
        customer: order.customer || '',
        tableId: order.tableId || order.table || '',
        table: order.table || '',
        ...(typeof order.notes === 'string' ? { notes: order.notes } : {}),
        items: (Array.isArray(order.items) ? order.items : []).filter(item => item && typeof item === 'object').map(item => ({
            ...(typeof item.id === 'string' ? { id: item.id } : {}),
            ...(typeof item.name === 'string' ? { name: item.name } : {}),
            ...(typeof item.nameEn === 'string' ? { nameEn: item.nameEn } : {}),
            ...(Number.isFinite(item.qty) ? { qty: item.qty } : {}),
            ...(typeof item.notes === 'string' ? { notes: item.notes } : {}),
            ...(typeof item.allergens === 'string' ? { allergens: item.allergens } : {}),
            ...(typeof item.allergensEn === 'string' ? { allergensEn: item.allergensEn } : {})
        })),
        status: order.status || 'pending',
        ...(order.timestamp !== undefined ? { timestamp: order.timestamp } : {})
    };
}

async function backfillStaffOrders(orders) {
    const staffOrdersRef = collection(db, "artifacts", appId, "public", "data", "staffOrders");
    const activeOrders = orders.filter(order => isActiveOrder(order.status || 'pending'));
    const activeIds = new Set(activeOrders.map(order => order.id));
    const existing = await getDocs(query(staffOrdersRef, where("status", "in", ACTIVE_ORDER_STATUSES)));
    const operations = [
        ...activeOrders.map(order => ({
            type: 'set',
            ref: doc(staffOrdersRef, order.id),
            data: toStaffOrder(order)
        })),
        ...existing.docs
            .filter(staffOrder => !activeIds.has(staffOrder.id))
            .map(staffOrder => ({ type: 'delete', ref: staffOrder.ref }))
    ];

    for (let offset = 0; offset < operations.length; offset += 450) {
        const batch = writeBatch(db);
        operations.slice(offset, offset + 450).forEach(operation => {
            if (operation.type === 'set') batch.set(operation.ref, operation.data);
            else batch.delete(operation.ref);
        });
        await batch.commit();
    }
}

/**
 * Initializes Firebase App, Auth and Firestore real-time listeners.
 */
export async function initFirebaseService(listeners = {}) {
    try {
        const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
        const emulatorMode = new URLSearchParams(window.location.search).get('emulator') === '1';
        if (!emulatorMode) {
            const siteKey = document.querySelector('meta[name="firebase-app-check-site-key"]')?.content.trim();
            if (!siteKey) {
                console.error('[App Check] Falta configurar la site key de reCAPTCHA Enterprise; las Cloud Functions protegidas rechazarán solicitudes.');
            } else if (!appCheck) {
                appCheck = initializeAppCheck(app, {
                    provider: new ReCaptchaEnterpriseProvider(siteKey),
                    isTokenAutoRefreshEnabled: true
                });
            }
        }
        db = getFirestore(app);
        const storageBucket = document.querySelector('meta[name="firebase-storage-bucket"]')?.content.trim();
        if (storageBucket) {
            storage = getStorage(app, `gs://${storageBucket}`);
        } else {
            console.error("[Firebase Storage] Falta configurar el bucket; las cargas de imágenes administrativas no estarán disponibles.");
            storage = null;
        }
        auth = getAuth(app);
        functions = getFunctions(app, 'us-central1');
        if (emulatorMode && !emulatorsConnected) {
            connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
            connectFirestoreEmulator(db, '127.0.0.1', 8080);
            connectFunctionsEmulator(functions, '127.0.0.1', 5001);
            if (storage) connectStorageEmulator(storage, '127.0.0.1', 9199);
            emulatorsConnected = true;
        }

        const authenticate = async () => {
            if (auth.currentUser) return;
            try {
                await signInAnonymously(auth);
            } catch (error) {
                console.error("[Auth] No se pudo iniciar una sesión anónima:", error);
                throw error;
            }
        };

        await authenticate();

        onAuthStateChanged(auth, async (user) => {
            let role = null;
            try {
                role = await getAdminRole(user);
                if (role === 'owner' && !isAdminMfaOptional() && !await hasMfaSignIn(user)) role = null;
            } catch (error) {
                console.error("[Auth] No se pudo cargar el rol de la sesión actual:", error);
            }
            if (auth.currentUser?.uid !== user?.uid) return;
            currentUser = user;
            currentUserRole = role;
            if (listeners.onAuth) listeners.onAuth(user, role);
            if (!firestoreListenersStarted) {
                startFirestoreListeners(listeners);
                firestoreListenersStarted = true;
            }
            startPrivilegedListeners(listeners, role);
        });

        return { app, db, auth };
    } catch (err) {
        console.error("[Firebase Service] Inicialización resiliente activada:", err);
        listeners.onCategories?.([]);
        listeners.onProducts?.([]);
        listeners.onError?.(err);
        return { db: null, auth: null };
    }
}

/**
 * Starts all real-time Firestore listeners with safe fallback and error handling.
 */
async function getAdminRole(user) {
    if (!db || !user || user.isAnonymous) return null;
    try {
        const userRef = doc(db, "artifacts", appId, "public", "data", "users", user.uid);
        const userSnapshot = await getDoc(userRef);
        const userData = userSnapshot.exists() ? userSnapshot.data() : null;
        const role = userData?.active === false ? null : userData?.role;
        return role === 'owner' || role === 'employee' ? role : null;
    } catch (error) {
        console.error("[Auth] No se pudo validar el rol administrativo en Firestore:", error);
        const profileError = new Error("No se pudo consultar el perfil administrativo en Firestore.");
        profileError.code = 'auth/admin-profile-unavailable';
        throw profileError;
    }
}

async function hasMfaSignIn(user) {
    if (!user || user.isAnonymous) return false;
    const token = await user.getIdTokenResult();
    return ['phone', 'totp'].includes(token.claims.firebase?.sign_in_second_factor);
}

function startFirestoreListeners(callbacks = {}) {
    if (!db) return;

    // 1. Products Listener
    try {
        onSnapshot(collection(db, "artifacts", appId, "public", "data", "products"), (snap) => {
            if (snap.empty) {
                callbacks.onProducts?.([]);
                return;
            }

            const products = snap.docs.map(d => {
                const data = d.data();
                let modelUrl = typeof data.model3dUrl === 'string' ? data.model3dUrl : '';
                if (modelUrl && modelUrl.trim().endsWith('.gl')) {
                    modelUrl = modelUrl.trim() + 'b';
                }
                return {
                    id: d.id,
                    ...data,
                    model3dUrl: modelUrl
                };
            });

            callbacks.onProducts?.(products);
        }, (err) => {
            console.error("[Firestore] No se pudieron leer los productos:", err);
            callbacks.onError?.(err);
        });
    } catch (e) {
        console.warn("[Firestore] Excepción al configurar listener de productos:", e);
    }

    // 2. Categories Listener
    try {
        onSnapshot(collection(db, "artifacts", appId, "public", "data", "categories"), async (snap) => {
            if (snap.empty) {
                callbacks.onCategories?.([]);
                return;
            }

            const categories = snap.docs.map(d => ({
                id: d.id,
                ...d.data()
            })).sort((a, b) => {
                const aOrder = Number.isInteger(a.order) ? a.order : null;
                const bOrder = Number.isInteger(b.order) ? b.order : null;
                if (aOrder === null && bOrder !== null) return -1;
                if (bOrder === null && aOrder !== null) return 1;
                return (aOrder === null ? 0 : aOrder - bOrder) || (a.name || '').localeCompare(b.name || '');
            });

            callbacks.onCategories?.(categories);
        }, (err) => {
            console.error("[Firestore] No se pudieron leer las categorías:", err);
            callbacks.onError?.(err);
        });
    } catch (e) {
        console.warn("[Firestore] Excepción al configurar listener de categorías:", e);
    }

    // 3. Reviews Listener
    try {
        onSnapshot(collection(db, "artifacts", appId, "public", "data", "reviews"), (snap) => {
            const reviews = snap.docs.map(d => ({
                id: d.id,
                ...d.data()
            }));
            if (callbacks.onReviews) callbacks.onReviews(reviews);
        }, (err) => {
            console.warn("[Firestore] Error en reviews listener:", err);
        });
    } catch (e) {
        console.warn("[Firestore] Excepción al configurar listener de reseñas:", e);
    }

    // 4. Sales Configuration & Reset Listener
    try {
        onSnapshot(doc(db, "artifacts", appId, "public", "data", "config", "sales"), (snap) => {
            if (snap.exists()) {
                const data = snap.data();
                let lastResetMs = 0;
                if (data.lastReset) {
                    if (typeof data.lastReset.seconds === 'number') lastResetMs = data.lastReset.seconds * 1000;
                    else if (typeof data.lastReset.toDate === 'function') lastResetMs = data.lastReset.toDate().getTime();
                    else if (data.lastReset instanceof Date) lastResetMs = data.lastReset.getTime();
                } else if (typeof data.resetAt === 'number') {
                    lastResetMs = data.resetAt;
                }
                if (callbacks.onSalesConfig) callbacks.onSalesConfig(lastResetMs);
            }
        }, (err) => {
            console.warn("[Firestore] Error en sales config listener:", err);
        });
    } catch (e) {
        console.warn("[Firestore] Excepción al configurar listener de configuración de ventas:", e);
    }
}

/* ==========================================================================
   CRUD OPERATIONS (Wrapped with Safe Try/Catch)
   ========================================================================== */

export async function loginAdmin(email, password) {
    if (!auth) throw new Error("Firebase Authentication no está conectado.");
    const credential = await signInWithEmailAndPassword(auth, email, password);
    return validateAdminCredential(credential.user);
}

async function validateAdminCredential(user) {
    let authenticatedRole;
    try {
        authenticatedRole = await getAdminRole(user);
    } catch (error) {
        await signOut(auth);
        await signInAnonymously(auth);
        throw error;
    }
    if (!authenticatedRole) {
        await signOut(auth);
        await signInAnonymously(auth);
        const profileError = new Error(
            "La cuenta se autenticó, pero no tiene un perfil administrativo activo con rol owner o employee."
        );
        profileError.code = 'auth/admin-profile-not-configured';
        throw profileError;
    }
    if (authenticatedRole === 'owner' && !isAdminMfaOptional()) {
        let secondFactor;
        try {
            const token = await user.getIdTokenResult(true);
            secondFactor = token.claims.firebase?.sign_in_second_factor;
        } catch (error) {
            console.error("[Auth] No se pudo verificar el segundo factor del owner:", error);
            const mfaError = new Error("No se pudo validar la verificación en dos pasos de la cuenta owner.");
            mfaError.code = 'auth/admin-mfa-verification-failed';
            throw mfaError;
        }
        if (!['phone', 'totp'].includes(secondFactor)) {
            await signOut(auth);
            await signInAnonymously(auth);
            const mfaError = new Error("La cuenta owner requiere un segundo factor MFA registrado.");
            mfaError.code = 'auth/admin-mfa-not-enrolled';
            throw mfaError;
        }
    }
    currentUser = user;
    currentUserRole = authenticatedRole;
    return user;
}

export function isAdminMfaRequired(error) {
    return error?.code === 'auth/multi-factor-auth-required';
}

export async function beginAdminMfa(error) {
    if (!auth || !isAdminMfaRequired(error)) throw error;
    clearAdminMfaState();
    adminMfaResolver = getMultiFactorResolver(auth, error);
    const phoneHint = adminMfaResolver.hints.find(
        hint => hint.factorId === PhoneMultiFactorGenerator.FACTOR_ID
    );
    if (!phoneHint) {
        clearAdminMfaState();
        throw new Error("La cuenta requiere un segundo factor SMS registrado para iniciar sesión.");
    }

    try {
        adminMfaVerifier = new RecaptchaVerifier(auth, 'admin-mfa-recaptcha', { size: 'invisible' });
        const provider = new PhoneAuthProvider(auth);
        adminMfaVerificationId = await provider.verifyPhoneNumber({
            multiFactorHint: phoneHint,
            session: adminMfaResolver.session
        }, adminMfaVerifier);
        return phoneHint.phoneNumber || '';
    } catch (mfaError) {
        clearAdminMfaState();
        throw mfaError;
    }
}

export async function completeAdminMfa(code) {
    if (!auth || !adminMfaResolver || !adminMfaVerificationId) {
        throw new Error("No hay una verificación MFA pendiente. Inicie sesión de nuevo.");
    }
    if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code.trim())) {
        throw new Error("Ingrese el código de seis dígitos enviado a su teléfono.");
    }
    const credential = PhoneAuthProvider.credential(adminMfaVerificationId, code.trim());
    const assertion = PhoneMultiFactorGenerator.assertion(credential);
    const result = await adminMfaResolver.resolveSignIn(assertion);
    clearAdminMfaState();
    return validateAdminCredential(result.user);
}

export function cancelAdminMfa() {
    clearAdminMfaState();
}

function clearAdminMfaState() {
    adminMfaResolver = null;
    adminMfaVerificationId = null;
    if (adminMfaVerifier) {
        adminMfaVerifier.clear();
        adminMfaVerifier = null;
    }
}

export async function logoutAdmin() {
    if (!auth) throw new Error("Firebase Authentication no está conectado.");
    await signOut(auth);
    currentUser = null;
    currentUserRole = null;
    await signInAnonymously(auth);
}

export async function resetSalesConfig() {
    if (!db) throw new Error("Database not connected");
    requireOwnerRole();
    try {
        const configRef = doc(db, "artifacts", appId, "public", "data", "config", "sales");
        await setDoc(configRef, { lastReset: serverTimestamp(), resetAt: Date.now() }, { merge: true });
    } catch (e) {
        console.warn("[Firestore] Error actualizando resetSales config:", e);
        throw e;
    }
}

export async function addProduct(productData, productId = crypto.randomUUID()) {
    if (!db) throw new Error("Database not connected");
    requireOwnerRole();
    const col = collection(db, "artifacts", appId, "public", "data", "products");
    const productRef = doc(col, productId);
    await setDoc(productRef, normalizeProductImages(productData));
    return productRef;
}

export async function updateProduct(id, productData) {
    if (!db) throw new Error("Database not connected");
    requireOwnerRole();
    const docRef = doc(db, "artifacts", appId, "public", "data", "products", id);
    return await setDoc(docRef, normalizeProductImages(productData), { merge: true });
}

function normalizeProductImages(productData) {
    if (!Array.isArray(productData.imageUrls)) return productData;
    const imageUrls = productData.imageUrls.map(image => {
        if (typeof image === 'string') return { url: image, largestUrl: image, srcset: '' };
        const url = typeof image?.url === 'string'
            ? image.url
            : typeof image?.cropped === 'string' ? image.cropped : '';
        if (!url) throw new Error("Formato de imagen de platillo inválido.");
        return {
            url,
            largestUrl: typeof image.largestUrl === 'string' ? image.largestUrl : url,
            srcset: typeof image.srcset === 'string' ? image.srcset : '',
            width: Number.isInteger(image.width) && image.width > 0 ? image.width : 800,
            height: Number.isInteger(image.height) && image.height > 0 ? image.height : 600
        };
    });
    return {
        ...productData,
        imageUrl: typeof productData.imageUrl === 'string'
            ? productData.imageUrl
            : productData.imageUrl?.url || productData.imageUrl?.cropped || '',
        imageUrls
    };
}

export function uploadProductImageVariant(productId, imageId, width, blob, onProgress = () => {}) {
    if (!storage) throw new Error("Firebase Storage no está conectado.");
    requireOwnerRole();
    if (!Number.isInteger(width) || ![400, 800, 1600].includes(width)) {
        throw new Error("Tamaño de imagen inválido.");
    }
    if (!(blob instanceof Blob) || blob.type !== 'image/webp' || blob.size > 1024 * 1024) {
        throw new Error("La imagen debe ser WebP y no superar 1 MB.");
    }

    const path = `products/${appId}/${productId}/${imageId}-${width}.webp`;
    const task = uploadBytesResumable(storageRef(storage, path), blob, {
        contentType: 'image/webp',
        cacheControl: 'public,max-age=31536000,immutable'
    });
    return new Promise((resolve, reject) => {
        task.on('state_changed', snapshot => {
            onProgress(snapshot.bytesTransferred / snapshot.totalBytes);
        }, reject, async () => {
            try {
                resolve(await getDownloadURL(task.snapshot.ref));
            } catch (error) {
                reject(error);
            }
        });
    });
}

export async function deleteProduct(id) {
    if (!db) throw new Error("Database not connected");
    requireOwnerRole();
    const docRef = doc(db, "artifacts", appId, "public", "data", "products", id);
    return await deleteDoc(docRef);
}

export async function addCategory(name, imageData = {}) {
    if (!db) throw new Error("Database not connected");
    requireOwnerRole();
    const col = collection(db, "artifacts", appId, "public", "data", "categories");
    return await addDoc(col, { name, ...imageData });
}

export async function updateCategory(categoryIds, name, imageData = {}, previousName = "", previousNameEn = "") {
    if (!db) throw new Error("Database not connected");
    requireOwnerRole();
    const ids = [...new Set((Array.isArray(categoryIds) ? categoryIds : [categoryIds]).filter(Boolean))];
    const batch = writeBatch(db);
    if (previousName && (previousName !== name || previousNameEn !== imageData.nameEn)) {
        const productsRef = collection(db, "artifacts", appId, "public", "data", "products");
        const referencedProducts = new Map();
        if (previousName !== name || previousNameEn !== imageData.nameEn) {
            const productsSnapshot = await getDocs(query(productsRef, where("category", "==", previousName)));
            productsSnapshot.docs.forEach(product => referencedProducts.set(product.ref.path, product));
        }
        if (previousNameEn && previousNameEn !== imageData.nameEn) {
            const englishProducts = await getDocs(query(productsRef, where("categoryEn", "==", previousNameEn)));
            englishProducts.docs.forEach(product => referencedProducts.set(product.ref.path, product));
        }
        if (referencedProducts.size + ids.length > 500) {
            throw new Error("Hay demasiados platillos en esta categoría para renombrarla en una sola operación.");
        }
        referencedProducts.forEach(product => {
            batch.set(product.ref, { category: name, categoryEn: imageData.nameEn || '' }, { merge: true });
        });
    }
    const categoryRefs = ids.length
        ? ids.map(id => doc(db, "artifacts", appId, "public", "data", "categories", id))
        : [doc(collection(db, "artifacts", appId, "public", "data", "categories"))];
    categoryRefs.forEach(categoryRef => batch.set(categoryRef, { name, ...imageData }, { merge: true }));
    return batch.commit();
}

export async function deleteCategory(categoryIds) {
    if (!db) throw new Error("Database not connected");
    requireOwnerRole();
    const ids = [...new Set((Array.isArray(categoryIds) ? categoryIds : [categoryIds]).filter(Boolean))];
    if (!ids.length) throw new Error("No se encontró la categoría que desea eliminar.");
    const categoryDocs = await Promise.all(ids.map(id => getDoc(doc(db, "artifacts", appId, "public", "data", "categories", id))));
    const categoryNames = [...new Set(categoryDocs
        .filter(snapshot => snapshot.exists())
        .flatMap(snapshot => [snapshot.data().name, snapshot.data().nameEn])
        .filter(name => typeof name === 'string' && name.trim()))];
    const productsRef = collection(db, "artifacts", appId, "public", "data", "products");
    for (const name of categoryNames) {
        const references = await Promise.all([
            getDocs(query(productsRef, where("category", "==", name))),
            getDocs(query(productsRef, where("categoryEn", "==", name)))
        ]);
        if (references.some(snapshot => !snapshot.empty)) {
            throw new Error(`No se puede eliminar "${name}" porque tiene platillos asignados.`);
        }
    }
    const batch = writeBatch(db);
    ids.forEach(id => {
        const docRef = doc(db, "artifacts", appId, "public", "data", "categories", id);
        batch.delete(docRef);
    });
    return batch.commit();
}

export async function updateCategoryOrder(orderById) {
    if (!db) throw new Error("Database not connected");
    requireOwnerRole();
    const entries = Object.entries(orderById || {});
    if (!entries.length || entries.length > 500
        || entries.some(([id, order]) => !id || !Number.isInteger(order) || order < 0)) {
        throw new Error("El orden de categorías no es válido.");
    }
    const batch = writeBatch(db);
    entries.forEach(([id, order]) => {
        batch.update(doc(db, "artifacts", appId, "public", "data", "categories", id), { order });
    });
    return batch.commit();
}

export async function createOrder(orderPayload) {
    if (!functions) throw new Error("Firebase Functions no está conectado.");
    if (!Array.isArray(orderPayload?.items)) throw new Error("El pedido no contiene platillos válidos.");
    const tableAccess = getTableQrAccess();
    if (!tableAccess) throw new Error("Abra el menú desde el código QR de su mesa para realizar un pedido.");
    if (orderPayload.tableId !== tableAccess.table) {
        throw new Error("La mesa del pedido no coincide con el código QR verificado.");
    }
    if (typeof orderPayload.orderId !== 'string' || !/^#[A-Z0-9]{4,8}$/.test(orderPayload.orderId)
        || !Number.isSafeInteger(orderPayload.timestamp) || orderPayload.timestamp <= 0
        || orderPayload.status !== 'pending') {
        throw new Error("Los datos del ticket no son válidos.");
    }
    const items = orderPayload.items.map(item => ({
        id: item.id,
        qty: item.qty,
        notes: item.notes || ''
    }));
    const fingerprint = JSON.stringify({
        customer: orderPayload.customer,
        tableId: tableAccess.table,
        notes: orderPayload.notes || '',
        items
    });
    if (fingerprint !== pendingOrderFingerprint) {
        pendingOrderFingerprint = fingerprint;
        pendingOrderRequestId = crypto.randomUUID();
        pendingOrderTicketId = orderPayload.orderId;
        pendingOrderTimestamp = orderPayload.timestamp;
    }
    const payload = {
        customer: orderPayload.customer,
        table: tableAccess.table,
        tableId: tableAccess.table,
        tableSignature: tableAccess.signature,
        orderId: pendingOrderTicketId,
        timestamp: pendingOrderTimestamp,
        status: 'pending',
        notes: orderPayload.notes || '',
        items
    };

    const callable = httpsCallable(functions, 'createOrder');
    const result = await callable({ ...payload, requestId: pendingOrderRequestId });
    if (typeof result.data?.id !== 'string' || !result.data.id
        || typeof result.data?.orderId !== 'string' || !result.data.orderId) {
        throw new Error("La función no devolvió un identificador de pedido válido.");
    }
    pendingOrderRequestId = null;
    pendingOrderFingerprint = null;
    pendingOrderTicketId = null;
    pendingOrderTimestamp = null;
    return { id: result.data.id, orderId: result.data.orderId };
}

export function getTableQrAccess() {
    const params = new URLSearchParams(window.location.search);
    const table = [params.get('table'), params.get('m'), params.get('mesa')]
        .find(value => value && /^[0-9]{1,3}$/.test(value)) || '';
    const signature = params.get('s') || '';
    if (!/^[0-9]{1,3}$/.test(table)) return null;
    if (/^[a-f0-9]{64}$/i.test(signature)) return { table, signature };
    return !signature && /^[0-9]{1,3}$/.test(params.get('table') || '')
        ? { table, signature: '' }
        : null;
}

export async function generateTableQr(tableNumber) {
    requireOwnerRole();
    const table = String(tableNumber ?? '').trim();
    if (!/^[0-9]{1,3}$/.test(table)) throw new Error("El número de mesa debe contener entre 1 y 3 dígitos.");
    const tableUrl = window.location.origin + '/?table=' + table;
    const qrDataUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(tableUrl)}`;
    return { data: { url: tableUrl, qrDataUrl } };
}

export async function manageStaff(payload = {}) {
    requireOwnerRole();
    const { action } = payload;
    if (!['list', 'create', 'deactivate'].includes(action)) {
        throw new Error("La operación de empleados no es válida.");
    }
    if (!db) throw new Error("Firestore no está conectado.");

    const usersRef = collection(db, "artifacts", appId, "public", "data", "users");
    if (action === 'list') {
        const snapshot = await getDocs(query(usersRef, where('role', '==', 'employee')));
        return {
            data: {
                employees: snapshot.docs.map(employeeDoc => {
                    const employee = employeeDoc.data();
                    return {
                        uid: employeeDoc.id,
                        email: typeof employee.email === 'string' ? employee.email : '',
                        disabled: employee.active === false
                    };
                })
            }
        };
    }

    if (action === 'create') {
        const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
        const password = payload.password;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
            throw new Error("El correo electrónico no es válido.");
        }
        if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
            throw new Error("La contraseña inicial debe tener entre 12 y 128 caracteres.");
        }

        const secondaryApp = initializeApp(firebaseConfig, 'SecondaryApp');
        const secondaryAuth = getAuth(secondaryApp);
        try {
            if (new URLSearchParams(window.location.search).get('emulator') === '1') {
                connectAuthEmulator(secondaryAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
            }

            const credential = await createUserWithEmailAndPassword(secondaryAuth, email, password);
            try {
                await setDoc(doc(usersRef, credential.user.uid), {
                    role: 'employee',
                    active: true,
                    email,
                    createdAt: serverTimestamp()
                });
            } catch (error) {
                try {
                    await deleteUser(credential.user);
                } catch (cleanupError) {
                    console.error('[Staff] No se pudo limpiar la cuenta Auth tras fallar la creación del perfil:', cleanupError);
                }
                throw error;
            }
            return { data: { success: true } };
        } finally {
            try {
                await signOut(secondaryAuth);
            } finally {
                await deleteApp(secondaryApp);
            }
        }
    }

    const uid = typeof payload.uid === 'string' ? payload.uid : '';
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) {
        throw new Error("El identificador de empleado no es válido.");
    }
    const employeeRef = doc(usersRef, uid);
    const employeeSnapshot = await getDoc(employeeRef);
    if (!employeeSnapshot.exists() || employeeSnapshot.data().role !== 'employee') {
        throw new Error("No se encontró el empleado solicitado.");
    }
    await updateDoc(employeeRef, {
        active: false,
        deactivatedAt: serverTimestamp()
    });
    return { data: { uid, disabled: true } };
}

export async function updateOrderStatus(id, status) {
    if (!db) throw new Error("Database not connected");
    requireStaffRole();
    const normalizedStatus = normalizeOrderStatus(status);
    if (!['pending', 'preparing', 'cooking', 'ready', 'delivered', 'paid'].includes(normalizedStatus)) {
        throw new Error("El estado solicitado no es válido.");
    }
    const orderRef = doc(db, "artifacts", appId, "public", "data", "orders", id);
    const staffOrderRef = doc(db, "artifacts", appId, "public", "data", "staffOrders", id);
    const sourceRef = currentUserRole === 'owner' ? orderRef : staffOrderRef;
    const orderSnapshot = await getDoc(sourceRef);
    if (!orderSnapshot.exists()) throw new Error("No se encontró la orden que desea actualizar.");
    const currentOrder = orderSnapshot.data();
    if (!canTransitionOrderStatus(currentOrder.status || 'pending', normalizedStatus)) {
        throw new Error("La orden debe avanzar al siguiente estado válido.");
    }
    const statusUpdate = {
        status: normalizedStatus,
        statusUpdatedBy: currentUser.uid,
        statusUpdatedAt: serverTimestamp()
    };
    const batch = writeBatch(db);
    batch.update(orderRef, statusUpdate);
    if (currentUserRole === 'owner') {
        if (isActiveOrder(normalizedStatus)) {
            batch.set(staffOrderRef, { ...toStaffOrder({ ...currentOrder, ...statusUpdate }), ...statusUpdate }, { merge: true });
        } else {
            batch.delete(staffOrderRef);
        }
    } else {
        if (isActiveOrder(normalizedStatus)) batch.update(staffOrderRef, statusUpdate);
        else batch.delete(staffOrderRef);
    }
    return batch.commit();
}

export async function createWaiterCall(tableNumber) {
    if (!functions) throw new Error("Firebase Functions no está conectado.");
    const tableAccess = getTableQrAccess();
    if (!tableAccess || tableNumber !== tableAccess.table) {
        throw new Error("Abra el menú desde el código QR de su mesa para solicitar asistencia.");
    }
    const callable = httpsCallable(functions, 'createWaiterCall');
    const result = await callable({
        table: tableAccess.table,
        tableSignature: tableAccess.signature
    });
    if (typeof result.data?.callId !== 'string' || !result.data.callId) {
        throw new Error("La función no devolvió un identificador de llamado válido.");
    }
    return { id: result.data.callId };
}

export async function resolveWaiterCall(id) {
    if (!db) throw new Error("Database not connected");
    requireStaffRole();
    const docRef = doc(db, "artifacts", appId, "public", "data", "calls", id);
    return await deleteDoc(docRef);
}

export async function addReview(productId, rating, comment) {
    if (!db) throw new Error("Database not connected");
    if (!currentUser) throw new Error("Se requiere una sesión para registrar una reseña.");
    if (typeof productId !== 'string' || !productId.trim()) throw new Error("Platillo inválido.");
    if (productId.trim().length > 128) throw new Error("Platillo inválido.");
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error("La calificación debe estar entre 1 y 5.");
    if (typeof comment !== 'string' || comment.length > 1000) throw new Error("La reseña supera el límite permitido.");
    const normalizedProductId = productId.trim();
    const reviewRef = doc(db, "artifacts", appId, "public", "data", "reviews", `${currentUser.uid}_${normalizedProductId}`);
    await setDoc(reviewRef, {
        productId: normalizedProductId,
        rating,
        comment: comment.trim(),
        userId: currentUser.uid,
        date: new Date().toISOString(),
        timestamp: serverTimestamp()
    });
    return reviewRef;
}

export async function deleteReview(reviewId) {
    if (!db) throw new Error("Database not connected");
    requireOwnerRole();
    if (typeof reviewId !== 'string' || !reviewId.trim()) throw new Error("Reseña inválida.");
    return deleteDoc(doc(db, "artifacts", appId, "public", "data", "reviews", reviewId));
}

/**
 * Seeds default imperial dishes and categories with separated ES & EN fields safely.
 */
export async function seedDefaultMenu(existingCategories = [], existingProducts = [], defaultCategories, defaultProducts) {
    if (!db) throw new Error("Database not connected");
    requireOwnerRole();
    if (!Array.isArray(defaultCategories) || !Array.isArray(defaultProducts)) {
        throw new Error("Los datos del menú de demostración no son válidos.");
    }

    try {
        const catCol = collection(db, "artifacts", appId, "public", "data", "categories");
        for (const [order, cat] of defaultCategories.entries()) {
            if (!existingCategories.some(c => c.name === cat)) {
                await addDoc(catCol, { name: cat, order });
            }
        }

        const prodCol = collection(db, "artifacts", appId, "public", "data", "products");
        for (const prod of defaultProducts) {
            if (!existingProducts.some(p => p.name === prod.name)) {
                const { id, ...prodData } = prod;
                await addDoc(prodCol, {
                    ...prodData,
                    allergens: prodData.allergens || 'No declarado',
                    allergensEn: prodData.allergensEn || 'Not declared'
                });
            }
        }
        console.log("[Firestore] Menú Imperial sembrado con éxito.");
    } catch (err) {
        console.error("[Firestore] Error al sembrar menú:", err);
        throw err;
    }
}
