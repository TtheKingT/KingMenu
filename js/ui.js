/**
 * ==========================================================================
 * KingMenu | UI, Cart, Modals & Rendering Module (High-Performance & Luxury)
 * ==========================================================================
 */

import { t, currentLang, formatPrice, getCatLocalized, getProductLocalized, getLocalizedField, setLanguage } from "./i18n.js";
import * as dbService from "./firebase-service.js";
import { animateExperienceItems, transitionExperienceView } from "./animations.js";
import { escapeHtml } from "./utils/escape.js";

/* --- Global Reactive State --- */
export const state = {
    products: [],
    productsReady: false,
    categories: [],
    orders: [],
    lastSubmittedOrderId: null,
    employees: [],
    reviews: [],
    calls: [],
    cart: [],
    diners: [],
    activeCategory: 'Todos',
    isAdmin: false,
    role: null,
    currentDetailId: null,
    selectedRatingValue: 0,
    currentCartTab: 'items',
    carouselImages: [],
    carouselImageSrcsets: [],
    currentSlideIndex: 0,
    carouselIntervalId: null,
    touchStartX: 0,
    touchEndX: 0,
    audioReady: false,
    pendingAction: null,
    editingCategoryId: null,
    editingCategoryIds: [],
    editingCategoryOriginalName: null,
    editingCategoryOriginalNameEn: null
};

let navigateExperience = null;
let activeExperienceView = 'experience-menu';
let experienceTransitioning = false;
let queuedExperienceView = null;
let selectedExperienceCategory = '';
let renderedExperienceCategories = null;
let renderedExperienceProducts = null;
let product3DModule = null;
let modelViewerModulePromise = null;
let adminImages = [];
let adminImageCrop = null;
let adminImageLoadController = null;
let adminSaveInProgress = false;
const modalReturnFocus = new Map();
let chefDrawerReturnFocus = null;
let adminCategoryImages = [];
let adminCategorySaveInProgress = false;
let waiterCallPending = false;
let isAdminMfaStep = false;
let adminLoginLoadPromise = null;
let adminPanelLoadPromise = null;
let kitchenWakeLock = null;
let kitchenClockInterval = null;
let kitchenWakeLockVisibilityHandler = null;
const publicDocumentTitle = document.title;

function isOwner() {
    return state.role === 'owner';
}

function requireOwner() {
    if (!isOwner()) {
        showToast('Acceso restringido', currentLang === 'en'
            ? 'Only an owner can manage the menu and analytics.'
            : 'Solo un owner puede administrar la carta y las estadísticas.', true);
        return false;
    }
    return true;
}

function applyRoleVisibility() {
    document.querySelectorAll('[data-role-owner]').forEach(element => {
        element.classList.toggle('hidden', !isOwner());
    });
    document.getElementById('view-admin')?.classList.toggle('employee-admin-view', state.role === 'employee');
}

export async function loadAdminPanel() {
    if (!state.isAdmin) throw new Error('El panel requiere un rol administrativo validado.');
    if (document.getElementById('view-admin')) return;
    if (adminPanelLoadPromise) return adminPanelLoadPromise;

    adminPanelLoadPromise = (async () => {
        const response = await fetch('/admin-panel.html', { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`No se pudo cargar el panel administrativo (${response.status}).`);
        const html = await response.text();
        const parsedDocument = new DOMParser().parseFromString(html, 'text/html');
        const adminView = parsedDocument.body.querySelector('#view-admin');
        const adminHost = document.getElementById('experience-admin-host');
        if (!adminView || !adminHost || parsedDocument.body.children.length !== 1) {
            throw new Error('El recurso del panel administrativo tiene una estructura inválida.');
        }
        if (document.querySelector('meta[name="kingmenu-environment"]')?.content !== 'staging') {
            adminView.querySelectorAll('[data-action="seed-demo"]').forEach(button => button.remove());
        }
        adminHost.appendChild(document.importNode(adminView, true));
        applyRoleVisibility();
        updateTranslations();
        renderAdminOrders();
        renderCalls();
        recalcSales();
        if (isOwner()) {
            renderCategoriesManage();
            void refreshStaffList();
        }
    })().catch(error => {
        adminPanelLoadPromise = null;
        throw error;
    });
    return adminPanelLoadPromise;
}

function unloadAdminPanel() {
    document.getElementById('view-admin')?.remove();
    adminPanelLoadPromise = null;
}

function withAdminOperationTimeout(operation, label, timeoutMs = 15000) {
    let timeoutId;
    return Promise.race([
        operation,
        new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error(`${label} tardó demasiado. Compruebe la conexión y los permisos de Firebase e inténtelo de nuevo.`)), timeoutMs);
        })
    ]).finally(() => clearTimeout(timeoutId));
}

function readImageAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener('load', () => {
            if (typeof reader.result !== 'string') {
                reject(new Error('No se pudo convertir la imagen a Base64.'));
                return;
            }
            resolve(reader.result);
        }, { once: true });
        reader.addEventListener('error', () => reject(reader.error || new Error('No se pudo leer el archivo de imagen.')), { once: true });
        reader.readAsDataURL(file);
    });
}

function getProductImageData(image) {
    if (typeof image === 'string') {
        return { original: image, cropped: image, url: image, largestUrl: image, srcset: '' };
    }
    const url = typeof image?.url === 'string' ? image.url : image?.cropped;
    if (typeof url !== 'string') return null;
    return {
        original: typeof image.original === 'string' ? image.original : url,
        cropped: url,
        url,
        largestUrl: typeof image.largestUrl === 'string' ? image.largestUrl : url,
        srcset: typeof image.srcset === 'string' ? image.srcset : '',
        width: Number(image.width) || 800,
        height: Number(image.height) || 600
    };
}

function createWebpVariants(source) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.addEventListener('error', () => reject(new Error('No se pudo procesar la imagen. Verifique su URL y CORS.')), { once: true });
        image.addEventListener('load', async () => {
            try {
                const variants = [];
                for (const width of [400, 800, 1600]) {
                    const variantWidth = Math.min(width, image.naturalWidth);
                    if (variants.some(variant => variant.width === variantWidth)) continue;
                    const canvas = document.createElement('canvas');
                    canvas.width = variantWidth;
                    canvas.height = Math.max(1, Math.round(image.naturalHeight * variantWidth / image.naturalWidth));
                    const context = canvas.getContext('2d');
                    if (!context) throw new Error('No se pudo preparar la imagen para subir.');
                    context.drawImage(image, 0, 0, canvas.width, canvas.height);
                    const blob = await new Promise((blobResolve, blobReject) => {
                        canvas.toBlob(result => result ? blobResolve(result) : blobReject(new Error('No se pudo convertir la imagen a WebP.')), 'image/webp', 0.8);
                    });
                    if (blob.type !== 'image/webp' || blob.size > 1024 * 1024) {
                        throw new Error('La imagen optimizada debe ser WebP y pesar menos de 1 MB por tamaño.');
                    }
                    variants.push({ width: variantWidth, height: canvas.height, blob });
                }
                resolve(variants);
            } catch (error) {
                reject(error);
            }
        }, { once: true });
        image.src = source;
    });
}

async function uploadAdminImages(productId, images, saveButton) {
    const uploadedImages = [];
    for (const [imageIndex, image] of images.entries()) {
        const validStoredVariants = image.srcset
            && image.url.includes('firebasestorage.googleapis.com')
            && image.cropUrl?.includes('firebasestorage.googleapis.com');
        if (validStoredVariants) {
            uploadedImages.push({
                url: image.url,
                largestUrl: image.cropUrl,
                srcset: image.srcset,
                width: image.width || 800,
                height: image.height || 600
            });
            continue;
        }

        const variants = await createWebpVariants(image.url);
        const urls = [];
        for (const variant of variants) {
            if (saveButton) {
                saveButton.textContent = currentLang === 'en'
                    ? `Uploading image ${imageIndex + 1}/${images.length} · ${variant.width}px`
                    : `Subiendo imagen ${imageIndex + 1}/${images.length} · ${variant.width}px`;
            }
            const url = await dbService.uploadProductImageVariant(
                productId,
                image.id,
                variant.width,
                variant.blob,
                progress => {
                    if (!saveButton) return;
                    const percent = Math.round(progress * 100);
                    saveButton.textContent = currentLang === 'en'
                        ? `Uploading image ${imageIndex + 1}/${images.length} · ${percent}%`
                        : `Subiendo imagen ${imageIndex + 1}/${images.length} · ${percent}%`;
                }
            );
            urls.push({ width: variant.width, url });
        }
        const medium = urls.find(item => item.width === 800) || urls.at(-1);
        const largest = urls.find(item => item.width === 1600) || urls.at(-1);
        uploadedImages.push({
            url: medium.url,
            largestUrl: largest.url,
            srcset: urls.map(item => `${item.url} ${item.width}w`).join(', '),
            width: medium.width,
            height: variants.find(item => item.width === medium.width)?.height || variants.at(-1).height
        });
    }
    return uploadedImages;
}

function getProductPrice(product) {
    const basePrice = Math.max(0, Number(product?.price) || 0);
    const discountValue = Number(product?.discountValue);
    if (product?.discountType === 'percent' && discountValue > 0 && discountValue < 100) {
        return Math.round(basePrice * (1 - discountValue / 100));
    }
    if (product?.discountType === 'price' && discountValue > 0 && discountValue < basePrice) {
        return discountValue;
    }
    return basePrice;
}

function getProductRatingSummary(productId) {
    const reviews = state.reviews.filter(review => {
        const rating = Number(review.rating);
        return review.productId != null
            && productId != null
            && String(review.productId) === String(productId)
            && Number.isInteger(rating)
            && rating >= 1
            && rating <= 5;
    });
    const average = reviews.length
        ? reviews.reduce((total, review) => total + Number(review.rating), 0) / reviews.length
        : null;
    return { reviews, average };
}

function renderRatingStars(average) {
    const filledStars = average === null ? 0 : Math.round(average);
    return Array.from({ length: 5 }, (_, index) =>
        `<i class="fa-${index < filledStars ? 'solid' : 'regular'} fa-star"></i>`
    ).join('');
}

function productIsAvailable(product) {
    return product?.available !== false;
}

function getCategoryDisplayName(name) {
    const category = state.categories.find(item =>
        (typeof item === 'string' ? item : item?.name)?.toLocaleLowerCase() === String(name || '').toLocaleLowerCase()
    );
    if (currentLang === 'en' && typeof category === 'object' && category?.nameEn?.trim()) {
        return category.nameEn.trim();
    }
    return getCatLocalized(name);
}

function compareCategories(left, right) {
    const leftOrder = Number.isInteger(left.order) ? left.order : null;
    const rightOrder = Number.isInteger(right.order) ? right.order : null;
    if (leftOrder === null && rightOrder !== null) return -1;
    if (rightOrder === null && leftOrder !== null) return 1;
    return (leftOrder === null ? 0 : leftOrder - rightOrder)
        || (left.name || '').localeCompare(right.name || '', currentLang);
}

function getAllCategoryNames() {
    const names = new Map();
    const orderedCategories = state.categories
        .map(category => typeof category === 'string' ? { name: category } : category)
        .sort(compareCategories);
    [...orderedCategories.map(category => category?.name),
        ...state.products.map(product => product.category).filter(category => typeof category === 'string')
            .sort((left, right) => left.localeCompare(right, currentLang))]
        .forEach(value => {
            const name = String(value || '').trim();
            if (name && !names.has(name.toLocaleLowerCase())) names.set(name.toLocaleLowerCase(), name);
        });
    return [...names.values()];
}

function refreshProductModels(root) {
    if (product3DModule) product3DModule.renderProductModels(root);
}

function renderExperienceSkeletons(grid, count, type) {
    const skeletons = Array.from({ length: count }, (_, index) =>
        `<div class="${type}-skeleton" style="--card-index:${index}" aria-hidden="true">
            ${type === 'category'
                ? '<span class="skeleton-category-image"></span><span class="skeleton-category-copy"><i></i><i></i></span>'
                : '<span class="skeleton-product-image"></span><span class="skeleton-product-copy"><i></i><i></i><i></i></span>'}
        </div>`
    ).join('');
    const status = type === 'category' ? t('experience_categories_loading') : t('experience_products_loading');
    const statusMarkup = type === 'category'
        ? `<p class="sr-only" data-experience-categories-status role="status">${status}</p>`
        : `<p class="sr-only" role="status">${status}</p>`;
    const markup = `${skeletons}${statusMarkup}`;
    if (grid.innerHTML !== markup) grid.innerHTML = markup;
    grid.setAttribute('aria-busy', 'true');
    if (type === 'category') renderedExperienceCategories = null;
    else renderedExperienceProducts = null;
}

function revealExperienceImages(container) {
    container.querySelectorAll('img.experience-image-fade').forEach(image => {
        const reveal = () => image.classList.add('is-loaded');
        const handleError = () => {
            reveal();
            if (image.dataset.imageFallback === 'show-next' && image.nextElementSibling instanceof HTMLElement) {
                image.nextElementSibling.hidden = false;
            } else if (image.dataset.imageFallback === 'hide') {
                image.hidden = true;
            }
        };
        image.addEventListener('load', reveal, { once: true });
        image.addEventListener('error', handleError, { once: true });
        if (image.complete) {
            if (image.naturalWidth > 0) reveal();
            else handleError();
        }
    });
}

export async function activateProductModel(button) {
    const card = button.closest('.product-card-responsive, .experience-product-card');
    const canvas = card?.querySelector('canvas[data-product-model]');
    if (!canvas || !canvas.dataset.productModel) return;

    button.disabled = true;
    try {
        product3DModule ||= await import('./product-3d.js');
        if (!canvas.hidden) {
            product3DModule.deactivateProductModel(canvas);
            return;
        }
        product3DModule.renderProductModels(card);
        await product3DModule.activateProductModel(canvas);
    } catch (error) {
        console.error('[Product3D] No se pudo cargar el visor 3D:', error);
        showToast('3D', currentLang === 'en' ? 'The 3D model could not be loaded.' : 'No se pudo cargar el modelo 3D.', true);
    } finally {
        button.disabled = false;
    }
}

export async function deactivateProductModel(button) {
    const canvas = button.closest('.product-card-responsive, .experience-product-card')
        ?.querySelector('canvas[data-product-model]');
    if (!canvas || !product3DModule) return;
    product3DModule.deactivateProductModel(canvas);
}

/* ==========================================================================
   AUDIO & SOUND EFFECTS
   ========================================================================== */

let fallbackAudioContext = null;

export async function initAudioContext() {
    if (state.audioReady) return;
    if (typeof Tone !== 'undefined') {
        try {
            await Tone.start();
            state.audioReady = true;
        } catch (e) {
            console.warn('[Audio] Tone.js no pudo iniciar automáticamente:', e);
        }
    }
    if (!state.audioReady) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        fallbackAudioContext ||= new AudioCtx();
        if (fallbackAudioContext.state === 'suspended') await fallbackAudioContext.resume();
        state.audioReady = fallbackAudioContext.state === 'running';
    }
}

export function playSound(type) {
    try {
        if (!state.audioReady || typeof Tone === 'undefined') {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            const ctx = fallbackAudioContext || new AudioCtx();
            fallbackAudioContext = ctx;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);

            if (type === 'success') {
                osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
                gain.gain.setValueAtTime(0.08, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
                osc.start();
                osc.stop(ctx.currentTime + 0.3);
            } else if (type === 'error') {
                osc.frequency.setValueAtTime(130.81, ctx.currentTime); // C3
                gain.gain.setValueAtTime(0.1, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
                osc.start();
                osc.stop(ctx.currentTime + 0.3);
            } else if (type === 'bell') {
                osc.frequency.setValueAtTime(783.99, ctx.currentTime); // G5
                gain.gain.setValueAtTime(0.12, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.6);
                osc.start();
                osc.stop(ctx.currentTime + 0.6);
            }
            return;
        }

        const synth = new Tone.PolySynth(Tone.Synth).toDestination();
        if (type === 'success') synth.triggerAttackRelease(["C5", "E5"], "8n");
        else if (type === 'error') synth.triggerAttackRelease(["C3", "B2"], "8n");
        else if (type === 'bell') synth.triggerAttackRelease(["G5"], "4n");
    } catch (e) {
        // Fallback silencioso
    }
}

/* ==========================================================================
   TOAST NOTIFICATIONS
   ========================================================================== */

export function showToast(title, msg, isError = false, playNotificationSound = true) {
    const toast = document.getElementById('toast');
    const toastTitle = document.getElementById('toast-title');
    const toastMsg = document.getElementById('toast-msg');
    const toastIcon = document.getElementById('toast-icon');

    if (!toast) return;

    if (toastTitle) toastTitle.innerText = title;
    if (toastMsg) toastMsg.innerText = msg;
    if (toastIcon) {
        toastIcon.innerHTML = isError
            ? '<i class="fa-solid fa-circle-exclamation text-red-500"></i>'
            : '<i class="fa-solid fa-circle-check text-green-500"></i>';
    }

    toast.classList.remove('translate-x-[150%]', 'opacity-0');
    if (playNotificationSound) playSound(isError ? 'error' : 'success');

    setTimeout(() => {
        toast.classList.add('translate-x-[150%]', 'opacity-0');
    }, 3500);
}

/* ==========================================================================
   MODAL & VIEW MANAGEMENT (History Stack)
   ========================================================================== */

export function toggleModalElement(id, show) {
    const el = document.getElementById(id);
    if (!el) return;
    if (show) {
        if (el.classList.contains('hidden') && document.activeElement instanceof HTMLElement
            && document.activeElement !== document.body) {
            modalReturnFocus.set(id, document.activeElement);
        }
        el.classList.remove('hidden');
        el.removeAttribute('inert');
        el.setAttribute('aria-hidden', 'false');
        if (id === 'cart-modal') {
            setCartCheckoutStep(1);
            switchCartTab('items');
        }
        const dialog = el.matches('[role="dialog"]') ? el : el.querySelector('[role="dialog"]');
        if (dialog instanceof HTMLElement) {
            const initialFocus = getDialogFocusableElements(dialog)[0] || dialog;
            initialFocus.focus();
        }
    } else {
        el.classList.add('hidden');
        el.setAttribute('aria-hidden', 'true');
        el.setAttribute('inert', '');
        const returnFocus = modalReturnFocus.get(id);
        modalReturnFocus.delete(id);
        if (returnFocus?.isConnected) returnFocus.focus();
        if (id === 'detail-modal') {
            stopCarouselAutoPlay();
            deactivate3DView();
        }
    }
}

function getDialogFocusableElements(dialog) {
    return [...dialog.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter(element => element instanceof HTMLElement
        && element.getClientRects().length > 0
        && !element.closest('[inert], [aria-hidden="true"]'));
}

function getTopmostDialog() {
    return [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
        .reverse()
        .find(dialog => !dialog.classList.contains('hidden') && dialog.getAttribute('aria-hidden') !== 'true');
}

function trapDialogFocus(event) {
    const dialog = getTopmostDialog();
    if (!dialog) return false;
    const focusable = getDialogFocusableElements(dialog);
    if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return true;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!dialog.contains(document.activeElement) || document.activeElement === dialog) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
    return true;
}

export function openModal(id) {
    if (['categories-modal', 'product-modal'].includes(id) && !requireOwner()) return;
    const currentState = history.state || { view: 'menu', experienceView: activeExperienceView };
    if (currentState.modal !== id) {
        history.pushState({ ...currentState, view: currentState.view || 'menu', modal: id, experienceView: activeExperienceView }, '', '');
    }
    toggleModalElement(id, true);
}

export function closeModal(modalId) {
    if (modalId) {
        toggleModalElement(modalId, false);
    }
    if (history.state && history.state.modal === modalId) {
        history.back();
    }
}

async function loadAdminLoginView() {
    if (document.getElementById('admin-login-view')) return;
    if (adminLoginLoadPromise) return adminLoginLoadPromise;

    adminLoginLoadPromise = (async () => {
        const response = await fetch('/admin-login.html', { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`No se pudo cargar el acceso administrativo (${response.status}).`);
        const html = await response.text();
        const parsedDocument = new DOMParser().parseFromString(html, 'text/html');
        const loginView = parsedDocument.body.querySelector('#admin-login-view');
        const loginHost = document.getElementById('admin-login-host');
        if (!loginView || !loginHost || parsedDocument.body.children.length !== 1) {
            throw new Error('El recurso de acceso administrativo tiene una estructura inválida.');
        }
        loginHost.appendChild(document.importNode(loginView, true));
        updateTranslations();
    })().catch(error => {
        adminLoginLoadPromise = null;
        throw error;
    });
    return adminLoginLoadPromise;
}

async function requestKitchenWakeLock() {
    if (!navigator.wakeLock?.request) return false;
    if (kitchenWakeLock && !kitchenWakeLock.released) return true;
    try {
        kitchenWakeLock = await navigator.wakeLock.request('screen');
        kitchenWakeLock.addEventListener('release', () => {
            kitchenWakeLock = null;
        }, { once: true });
        return true;
    } catch (error) {
        console.warn('[Kitchen] No se pudo activar Wake Lock:', error);
        return false;
    }
}

async function setKitchenMode(enabled) {
    const root = document.getElementById('experience-root');
    root?.classList.toggle('kitchen-route', enabled);
    document.querySelectorAll('[data-kitchen-navigation]').forEach(link => {
        link.classList.toggle('hidden', !enabled);
    });

    if (enabled) {
        if (kitchenClockInterval === null) {
            kitchenClockInterval = window.setInterval(renderAdminOrders, 60_000);
        }
        if (!kitchenWakeLockVisibilityHandler) {
            kitchenWakeLockVisibilityHandler = () => {
                if (!document.hidden && root?.classList.contains('kitchen-route')) {
                    void requestKitchenWakeLock();
                }
            };
            document.addEventListener('visibilitychange', kitchenWakeLockVisibilityHandler);
        }
        await requestKitchenWakeLock();
        return;
    }

    if (kitchenClockInterval !== null) {
        window.clearInterval(kitchenClockInterval);
        kitchenClockInterval = null;
    }
    if (kitchenWakeLockVisibilityHandler) {
        document.removeEventListener('visibilitychange', kitchenWakeLockVisibilityHandler);
        kitchenWakeLockVisibilityHandler = null;
    }
    if (kitchenWakeLock) {
        const lock = kitchenWakeLock;
        kitchenWakeLock = null;
        try {
            await lock.release();
        } catch (error) {
            console.warn('[Kitchen] No se pudo liberar Wake Lock:', error);
        }
    }
}

export async function openAdminRoute() {
    if (window.location.pathname.replace(/\/+$/, '') !== '/admin') {
        history.pushState({ view: 'menu', modal: null, adminRoute: true }, '', '/admin');
    }
    await handleAdminRoute();
}

export async function handleAdminRoute() {
    const currentPath = window.location.pathname.replace(/\/+$/, '');
    if (!['/admin', '/cocina'].includes(currentPath)) return;
    if (state.isAdmin) {
        const kitchenRoute = currentPath === '/cocina';
        document.title = kitchenRoute
            ? (currentLang === 'en' ? 'Kitchen | KingMenu' : 'Cocina | KingMenu')
            : (currentLang === 'en' ? 'Administration | KingMenu' : 'Administración | KingMenu');
        document.getElementById('admin-login-view')?.classList.add('hidden');
        document.getElementById('experience-root')?.classList.remove('hidden');
        await setKitchenMode(kitchenRoute);
        if (kitchenRoute) openExperienceSurface('admin');
        else setView('admin');
    } else {
        await setKitchenMode(false);
        document.title = currentLang === 'en' ? 'Administrative Access | KingMenu' : 'Acceso Administrativo | KingMenu';
        document.getElementById('experience-root')?.classList.add('hidden');
        try {
            await loadAdminLoginView();
            document.getElementById('admin-login-view')?.classList.remove('hidden');
            if (dbService.isAdminMfaOptional()) {
                const securityHint = document.querySelector('#admin-login-view [data-i18n="login_security_hint"]');
                if (securityHint) {
                    securityHint.textContent = currentLang === 'en'
                        ? 'Demo mode: MFA enrollment is optional for owner accounts.'
                        : 'Modo demo: el registro MFA es opcional para cuentas owner.';
                }
            }
            document.getElementById('admin-email')?.focus();
        } catch (error) {
            console.error('[Admin] No se pudo cargar el acceso:', error);
            const loginHost = document.getElementById('admin-login-host');
            if (loginHost) {
                loginHost.textContent = currentLang === 'en'
                    ? 'Administrative sign-in is temporarily unavailable.'
                    : 'El acceso administrativo no está disponible temporalmente.';
            }
        }
    }
}

export function leaveAdminRoute() {
    document.title = publicDocumentTitle;
    document.getElementById('experience-root')?.classList.remove('hidden');
    document.getElementById('admin-login-view')?.classList.add('hidden');
    void setKitchenMode(false);
    if (isAdminMfaStep) cancelAdminMfa();
}

export function setView(view) {
    if (view === 'admin' && !state.isAdmin) {
        openAdminRoute();
        return;
    }
    if (view === 'status' && state.role === 'employee') {
        setView('admin');
        return;
    }
    if (view === 'admin') applyRoleVisibility();
    if (navigateExperience) {
        const experienceSurface = { status: 'orders', admin: 'admin', menu: 'categories' }[view];
        if (experienceSurface) {
            openExperienceSurface(experienceSurface);
            return;
        }
    }
    history.pushState({ view: view, modal: null }, '', '');
    toggleViewElement(view, true);
}

export function handleExperiencePopState(historyState) {
    const requestedDestination = historyState?.experienceView;
    const destination = state.role === 'employee' && requestedDestination === 'experience-orders'
        ? 'experience-admin'
        : requestedDestination;
    if (destination && destination !== activeExperienceView) {
        navigateExperience?.(destination, undefined, { pushHistory: false });
    }
}

export function toggleViewElement(view, shouldScroll = false) {
    if (view === 'admin' && !state.isAdmin) {
        openAdminRoute();
        return;
    }
    ['view-menu', 'view-status', 'view-admin'].forEach(v => {
        document.getElementById(v)?.classList.add('hidden');
    });

    const activeViewEl = document.getElementById(`view-${view}`);
    if (activeViewEl) {
        activeViewEl.classList.remove('hidden');
    }

    if (view === 'menu') {
        if (shouldScroll) {
            window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
        }
        if (window.__heroResume) window.__heroResume();
    } else {
        if (window.__heroPause) window.__heroPause();
        if (view === 'status') {
            renderUserOrdersDashboard();
            // ── Auto-scroll fluido directo a la sección de la comanda ──
            setTimeout(() => {
                const el = document.getElementById('view-status');
                if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }, 50);
        } else if (view === 'admin') {
            if (shouldScroll) {
                window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
            }
            recalcSales();
            renderAdminOrders();
            if (isOwner()) renderCategoriesManage();
        }
    }
}

export function confirmAction(title, msg, action) {
    const titleEl = document.getElementById('confirm-title');
    const msgEl = document.getElementById('confirm-msg');
    if (titleEl) titleEl.innerText = title;
    if (msgEl) msgEl.innerText = msg;
    state.pendingAction = action;
    openModal('confirm-modal');
}

export function executePendingConfirmAction() {
    if (state.pendingAction) {
        state.pendingAction();
        state.pendingAction = null;
    }
    closeModal('confirm-modal');
}

/* ==========================================================================
   AUTHENTICATION LOGIC (Synchronous, Clean & Reactive)
   ========================================================================== */

export async function login() {
    const emailInput = document.getElementById('admin-email');
    const pwdInput = document.getElementById('admin-password');
    const codeInput = document.getElementById('admin-mfa-code');
    try {
        let user;
        if (isAdminMfaStep) {
            user = await dbService.completeAdminMfa(codeInput?.value || '');
        } else {
            const email = emailInput?.value.trim() || '';
            const password = pwdInput?.value || '';
            if (!email || !password) {
                showToast(t('login_title'), currentLang === 'en' ? 'Enter your email and password.' : 'Ingrese su correo y contraseña.', true);
                return;
            }
            try {
                user = await dbService.loginAdmin(email, password);
            } catch (error) {
                if (!dbService.isAdminMfaRequired(error)) throw error;
                const phoneNumber = await dbService.beginAdminMfa(error);
                isAdminMfaStep = true;
                updateAdminMfaStep(phoneNumber);
                return;
            }
        }
        setAdminAuth(user, dbService.currentUserRole);
        await loadAdminPanel();
        if (emailInput) emailInput.value = '';
        if (pwdInput) pwdInput.value = '';
        if (codeInput) codeInput.value = '';
        isAdminMfaStep = false;
        updateAdminMfaStep();
        document.getElementById('admin-login-view')?.classList.add('hidden');
        document.getElementById('experience-root')?.classList.remove('hidden');
        history.replaceState({ ...(history.state || {}), modal: null }, '', '');
        setView('admin');
    } catch (error) {
        console.error('[Auth] No se pudo iniciar sesión de administrador:', error);
        const messages = {
            'auth/invalid-credential': currentLang === 'en'
                ? 'The email or password is incorrect.'
                : 'El correo o la contraseña son incorrectos.',
            'auth/invalid-login-credentials': currentLang === 'en'
                ? 'The email or password is incorrect.'
                : 'El correo o la contraseña son incorrectos.',
            'auth/wrong-password': currentLang === 'en'
                ? 'The email or password is incorrect.'
                : 'El correo o la contraseña son incorrectos.',
            'auth/user-not-found': currentLang === 'en'
                ? 'The email or password is incorrect.'
                : 'El correo o la contraseña son incorrectos.',
            'auth/invalid-email': currentLang === 'en'
                ? 'Enter a valid email address.'
                : 'Ingrese un correo electrónico válido.',
            'auth/network-request-failed': currentLang === 'en'
                ? 'The authentication service could not be reached. Check the connection and try again.'
                : 'No se pudo contactar el servicio de autenticación. Compruebe la conexión e inténtelo de nuevo.',
            'auth/admin-profile-not-configured': currentLang === 'en'
                ? 'The account signed in, but has no active owner or employee profile. Ask an owner to provision its Firestore users/{uid} profile.'
                : 'La cuenta se autenticó, pero no tiene un perfil activo de owner o employee. Solicite a un owner que configure su perfil users/{uid} en Firestore.',
            'auth/admin-profile-unavailable': currentLang === 'en'
                ? 'The admin profile could not be checked in Firestore. Check the connection and users collection permissions.'
                : 'No se pudo consultar el perfil en Firestore. Compruebe la conexión y los permisos de la colección users.',
            'auth/admin-mfa-not-enrolled': currentLang === 'en'
                ? 'This owner account must enroll a second factor before signing in.'
                : 'Esta cuenta owner debe registrar un segundo factor antes de iniciar sesión.',
            'auth/admin-mfa-verification-failed': currentLang === 'en'
                ? 'The second factor could not be verified. Try again or contact an owner.'
                : 'No se pudo validar el segundo factor. Inténtelo de nuevo o contacte a un owner.',
            'auth/too-many-requests': currentLang === 'en'
                ? 'Too many sign-in attempts. Wait before trying again.'
                : 'Hubo demasiados intentos. Espere antes de volver a intentarlo.'
        };
        const message = messages[error?.code]
            || (error?.code === 'auth/multi-factor-auth-required'
                ? (currentLang === 'en'
                    ? 'Complete the second-factor verification to continue.'
                    : 'Complete la verificación del segundo factor para continuar.')
                : currentLang === 'en'
                    ? 'Sign-in failed. Check your credentials, MFA enrollment, and administrator profile.'
                    : 'No se pudo iniciar sesión. Compruebe sus credenciales, el registro MFA y el perfil administrativo.');
        showToast(t('login_title'), message, true);
        if (isAdminMfaStep) codeInput?.focus();
        else pwdInput?.focus();
    }
}

function updateAdminMfaStep(phoneNumber = '') {
    document.getElementById('admin-primary-auth-fields')?.classList.toggle('hidden', isAdminMfaStep);
    const mfaFields = document.getElementById('admin-mfa-fields');
    mfaFields?.classList.toggle('hidden', !isAdminMfaStep);
    const emailInput = document.getElementById('admin-email');
    const passwordInput = document.getElementById('admin-password');
    const codeInput = document.getElementById('admin-mfa-code');
    if (emailInput) emailInput.disabled = isAdminMfaStep;
    if (passwordInput) passwordInput.disabled = isAdminMfaStep;
    if (emailInput) emailInput.required = !isAdminMfaStep;
    if (passwordInput) passwordInput.required = !isAdminMfaStep;
    if (codeInput) {
        codeInput.disabled = !isAdminMfaStep;
        codeInput.required = isAdminMfaStep;
        if (isAdminMfaStep) codeInput.focus();
    }
    const hint = document.getElementById('admin-mfa-hint');
    if (hint && isAdminMfaStep) {
        hint.textContent = phoneNumber
            ? (currentLang === 'en' ? `Enter the code sent to ${phoneNumber}.` : `Ingrese el código enviado a ${phoneNumber}.`)
            : (currentLang === 'en' ? 'Enter the six-digit code sent to your phone.' : 'Ingrese el código de seis dígitos enviado a su teléfono.');
    }
    const submitButton = document.querySelector('#admin-login-form button[type="submit"]');
    if (submitButton) submitButton.textContent = isAdminMfaStep
        ? (currentLang === 'en' ? 'Verify code' : 'Verificar código')
        : t('login_btn');
    const cancelButton = document.getElementById('admin-mfa-cancel');
    if (cancelButton) {
        cancelButton.disabled = !isAdminMfaStep;
        cancelButton.classList.toggle('hidden', !isAdminMfaStep);
    }
}

export function cancelAdminMfa() {
    dbService.cancelAdminMfa();
    isAdminMfaStep = false;
    const codeInput = document.getElementById('admin-mfa-code');
    if (codeInput) codeInput.value = '';
    updateAdminMfaStep();
}

export async function logout() {
    const currentPath = window.location.pathname.replace(/\/+$/, '');
    const wasAdminRoute = ['/admin', '/cocina'].includes(currentPath);
    if (wasAdminRoute) {
        history.replaceState({ view: 'menu', modal: null, experienceView: 'experience-menu' }, '', '/');
        await setKitchenMode(false);
    }
    try {
        await dbService.logoutAdmin();
    } catch (error) {
        if (wasAdminRoute) {
            history.replaceState({ view: 'admin', modal: null }, '', currentPath);
            await setKitchenMode(currentPath === '/cocina');
        }
        console.error('[Auth] No se pudo cerrar la sesión:', error);
        showToast(t('login_title'), currentLang === 'en' ? 'Could not sign out.' : 'No se pudo cerrar la sesión.', true);
        return;
    }

    state.isAdmin = false;
    state.role = null;
    unloadAdminPanel();
    state.orders = [];
    state.calls = [];
    recalcSales();
    applyRoleVisibility();
    renderMenu();
    renderExperienceProducts();
    if (isOwner()) renderCategoriesManage();
    setView('menu');
    showToast(t('login_title'), currentLang === 'en' ? 'Logged out.' : 'Sesión de administración cerrada.');
}

export function setAdminAuth(user, role) {
    const previousRole = state.role;
    state.role = user && ['owner', 'employee'].includes(role) ? role : null;
    state.isAdmin = Boolean(state.role);
    if (!state.isAdmin) unloadAdminPanel();
    if (previousRole !== state.role) {
        state.orders = [];
        state.calls = [];
        recalcSales();
    }

    if (!state.isAdmin && !document.getElementById('view-admin')?.classList.contains('hidden')) {
        setView('menu');
    }
    applyRoleVisibility();
    renderMenu();
    renderExperienceProducts();
    if (state.currentDetailId && !document.getElementById('detail-modal')?.classList.contains('hidden')) {
        renderProductReviews(state.currentDetailId);
    }
}

function ensureExperienceCategorySelection() {
    const availableCategories = getAllCategoryNames();
    const categoryNames = availableCategories.map(category => category.toLocaleLowerCase());
    if (!availableCategories.length) {
        selectedExperienceCategory = '';
        state.activeCategory = 'Todos';
        return;
    }
    const selected = selectedExperienceCategory?.trim();
    const exists = selected && categoryNames.includes(selected.toLocaleLowerCase());
    if (!exists) {
        selectedExperienceCategory = availableCategories[0];
    }
    if (!state.activeCategory || !categoryNames.includes(String(state.activeCategory).toLocaleLowerCase())) {
        state.activeCategory = selectedExperienceCategory;
    }
}

export function initializeTableAccess() {
    const tableAccess = dbService.getTableQrAccess();
    const params = new URLSearchParams(window.location.search);
    const urlTable = [params.get('mesa'), params.get('m')]
        .find(table => table && /^[0-9]{1,3}$/.test(table)) || '';
    const activeTable = tableAccess?.table || (/^[0-9]{1,3}$/.test(urlTable) ? urlTable : '');
    const tableBadge = document.getElementById('active-table-badge');
    const tableLabel = document.getElementById('active-table-label');
    if (tableBadge && tableLabel) {
        tableBadge.classList.toggle('hidden', !activeTable);
        tableLabel.textContent = activeTable
            ? `${currentLang === 'en' ? 'Table' : 'Mesa'} ${activeTable}`
            : '';
        tableBadge.setAttribute('aria-label', activeTable
            ? `${currentLang === 'en' ? 'Active table' : 'Mesa activa'} ${activeTable}`
            : '');
    }
    const waiterTableInput = document.getElementById('waiter-table-input');
    if (waiterTableInput) {
        waiterTableInput.value = tableAccess?.table || '';
        waiterTableInput.disabled = true;
        waiterTableInput.placeholder = tableAccess
            ? (currentLang === 'en' ? `Table ${tableAccess.table}` : `Mesa ${tableAccess.table}`)
            : (currentLang === 'en' ? 'Scan your table QR' : 'Escanee el QR de su mesa');
    }
    document.querySelectorAll('[data-table-access-status]').forEach(status => {
        status.textContent = tableAccess
            ? (currentLang === 'en' ? `Verified table ${tableAccess.table}` : `Mesa ${tableAccess.table} verificada`)
            : (currentLang === 'en'
                ? 'Scan the QR code assigned to your table to order or request assistance.'
                : 'Escanee el código QR asignado a su mesa para pedir o solicitar asistencia.');
    });
}

/* ==========================================================================
   HIGH-PERFORMANCE MENU RENDERING (DocumentFragment)
   ========================================================================== */

export function _buildProductCardHTML(p) {
    const localized = getProductLocalized(p);
    const desc = localized.description || '';
    const name = localized.name || 'Platillo Imperial';
    const cat = getCategoryDisplayName(p.category || 'Entradas') || localized.category;
    const modelUrl = escapeHtml(p.model3dUrl?.trim() || '');
    const available = productIsAvailable(p);
    const price = getProductPrice(p);
    const hasDiscount = price < (Number(p.price) || 0);
    const rating = getProductRatingSummary(p.id);
    const avgRating = rating.average === null ? '--' : rating.average.toFixed(1);

    const fallbackImageUrl = 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=800';
    const dataSrcAttr = localized.imageUrl ? `data-src="${escapeHtml(localized.imageUrl)}"` : '';
    const srcAttr = !localized.imageUrl ? `src="https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=800"` : '';
    const srcsetAttr = localized.imageSrcsets?.[0] ? `srcset="${escapeHtml(localized.imageSrcsets[0])}" sizes="(max-width: 768px) 50vw, 25vw"` : '';
    const imageWidth = localized.imageWidths?.[0] || 800;
    const imageHeight = localized.imageHeights?.[0] || 600;

    return `
    <div class="glass-panel rounded-2xl overflow-hidden group hover:border-king-gold/30 transition-all duration-300 flex flex-row md:flex-col min-h-[9rem] h-auto md:h-full cursor-pointer relative animate-fade-in product-card-responsive" data-action="open-detail" data-product-id="${escapeHtml(p.id)}">
        <div class="relative w-32 md:w-full h-full md:h-48 flex-shrink-0 product-model-stage">
            <img ${srcAttr} ${dataSrcAttr} ${srcsetAttr} width="${imageWidth}" height="${imageHeight}" loading="lazy" decoding="async" class="w-full h-full object-cover absolute inset-0 transition-transform duration-700 group-hover:scale-105 ${localized.imageUrl ? 'img-skeleton' : ''}" alt="${escapeHtml(name)}" ${localized.imageUrl ? `data-image-fallback-url="${fallbackImageUrl}"` : ''}>
            <div class="absolute inset-0 bg-gradient-to-t from-king-surface/90 via-transparent to-transparent"></div>
            ${modelUrl ? `<canvas hidden class="product-model-canvas" data-product-model="${modelUrl}" aria-label="Modelo 3D interactivo de ${escapeHtml(name)}"></canvas><button type="button" data-action="activate-product-model" data-toggle-product-model data-product-name="${escapeHtml(name)}" aria-pressed="false" class="absolute bottom-2 left-2 z-10 rounded-full border border-white/20 bg-black/75 px-3 py-2 text-[9px] font-bold text-white"><i class="fa-solid fa-cube text-king-gold" aria-hidden="true"></i> <span>Ver 3D</span></button>` : ''}
            ${hasDiscount ? `<span class="absolute top-2 left-2 z-10 rounded bg-red-600 px-2 py-1 text-[9px] font-bold text-white">${p.discountType === 'percent' ? `-${Math.round(Number(p.discountValue))}%` : 'OFERTA'}</span>` : ''}
            ${isOwner() ? `
            <div class="absolute top-2 right-2 flex gap-1 z-20">
                <button data-action="edit-product" data-product-id="${escapeHtml(p.id)}" class="w-7 h-7 bg-blue-600/90 rounded-full text-white flex items-center justify-center hover:scale-110 transition shadow-lg" title="Editar"><i class="fa-solid fa-pencil text-[9px]"></i></button>
                <button data-action="delete-product" data-product-id="${escapeHtml(p.id)}" data-product-name="${escapeHtml(name)}" class="w-7 h-7 bg-red-600/90 rounded-full text-white flex items-center justify-center hover:scale-110 transition shadow-lg" title="Eliminar"><i class="fa-solid fa-trash text-[9px]"></i></button>
            </div>` : ''}
        </div>
        <div class="p-3 md:p-4 flex flex-col flex-grow min-w-0 font-sans">
            <div class="flex-grow">
                <div class="flex justify-between items-center mb-1">
                    <span class="text-[8px] text-king-gold uppercase font-bold tracking-wider border border-king-gold/20 px-1.5 py-0.5 rounded bg-king-gold/5 truncate max-w-[80px] font-sans">${escapeHtml(cat)}</span>
                    <span class="text-[9px] text-gray-400 flex items-center gap-0.5" aria-label="${rating.average === null ? 'Sin reseñas' : `Calificación ${avgRating} de 5, ${rating.reviews.length} reseñas`}"><span class="text-king-gold">${renderRatingStars(rating.average)}</span> ${avgRating}<span class="text-gray-600">(${rating.reviews.length})</span></span>
                </div>
                <h3 class="text-sm md:text-base font-serif text-white font-bold leading-tight mb-1 group-hover:text-king-gold transition-colors line-clamp-1">${escapeHtml(name)}</h3>
                <p class="text-gray-400 text-[10px] md:text-xs line-clamp-2 font-light leading-relaxed mb-2">${escapeHtml(desc)}</p>
                ${available ? '' : `<span class="inline-block rounded bg-red-500/15 px-2 py-1 text-[9px] font-bold uppercase text-red-300">${t('experience_sold_out')}</span>`}
            </div>
            <div class="flex items-end justify-between pt-2 border-t border-white/5 mt-auto">
                <span class="text-sm md:text-lg text-white font-light font-mono">${hasDiscount ? `<del class="mr-1 text-xs text-gray-500">${formatPrice(p.price)}</del>` : ''}${formatPrice(price)}</span>
                <button data-action="add-product" data-product-id="${escapeHtml(p.id)}" ${available ? '' : 'disabled'} class="w-11 h-11 rounded-lg bg-king-gold md:bg-white/5 md:hover:bg-king-gold hover:text-black text-black md:text-white transition-all flex items-center justify-center shadow-lg border border-white/5 tactile-target disabled:cursor-not-allowed disabled:opacity-40" aria-label="${escapeHtml(available ? t('experience_add_to_cart_aria').replace('{name}', name) : `${name}, ${t('experience_sold_out')}`)}" title="${escapeHtml(available ? t('experience_add_to_cart_aria').replace('{name}', name) : `${name}, ${t('experience_sold_out')}`)}"><i class="fa-solid fa-plus text-xs" aria-hidden="true"></i></button>
            </div>
        </div>
    </div>`;
}

export function renderMenu() {
    const grid = document.getElementById('products-grid');
    if (!grid) return;

    const searchInput = document.getElementById('search-input');
    const term = (searchInput?.value || '').toLowerCase().trim();

    const adminControls = document.getElementById('admin-back-controls');
    if (adminControls) {
        isOwner() ? adminControls.classList.remove('hidden') : adminControls.classList.add('hidden');
    }

    const filtered = state.products.filter(p => {
        const matchesCat = state.activeCategory === 'Todos' || p.category === state.activeCategory;
        const matchesSearch = !term ||
            (p.name && p.name.toLowerCase().includes(term)) ||
            (p.nameEn && p.nameEn.toLowerCase().includes(term)) ||
            (p.description && p.description.toLowerCase().includes(term)) ||
            (p.descriptionEn && p.descriptionEn.toLowerCase().includes(term)) ||
            (p.ingredients && p.ingredients.toLowerCase().includes(term)) ||
            (p.ingredientsEn && p.ingredientsEn.toLowerCase().includes(term));
        return matchesCat && matchesSearch;
    });

    const countLabel = document.getElementById('products-count-label');
    if (countLabel) countLabel.innerText = String(filtered.length);

    const emptyState = document.getElementById('empty-state');
    const emptyStateText = document.getElementById('empty-state-text');
    const emptyStateActions = document.getElementById('empty-state-actions');

    if (state.products.length === 0) {
        if (emptyState) emptyState.classList.remove('hidden');
        if (emptyStateText) emptyStateText.innerText = state.productsReady
            ? t('experience_products_empty')
            : t('empty_syncing');
        grid.innerHTML = '';
        refreshProductModels(grid);
        return;
    } else if (filtered.length === 0) {
        if (emptyState) emptyState.classList.remove('hidden');
        if (emptyStateText) emptyStateText.innerText = t('empty_no_match');
        if (emptyStateActions) {
            emptyStateActions.innerHTML = `<button data-action="reset-search" class="text-king-gold hover:text-white font-bold text-sm underline transition-all font-sans">${t('empty_view_all')}</button>`;
        }
        grid.innerHTML = '';
        refreshProductModels(grid);
        return;
    } else {
        if (emptyState) emptyState.classList.add('hidden');
    }

    const existingCards = new Map([...grid.children]
        .filter(card => card.dataset.productId)
        .map(card => [card.dataset.productId, card]));
    const nextCards = filtered.map(product => {
        const cardContainer = document.createElement('div');
        cardContainer.innerHTML = _buildProductCardHTML(product);
        const nextCard = cardContainer.firstElementChild;
        const existingCard = existingCards.get(String(product.id));
        return existingCard && existingCard.outerHTML === nextCard.outerHTML ? existingCard : nextCard;
    });
    const currentCards = [...grid.children];
    if (currentCards.length !== nextCards.length || currentCards.some((card, index) => card !== nextCards[index])) {
        grid.replaceChildren(...nextCards);
    }
    refreshProductModels(grid);
}

export function resetSearch() {
    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.value = "";
    state.activeCategory = 'Todos';
    renderCategories();
    renderMenu();
}

/* ==========================================================================
   CATEGORIES NAVIGATION & FILTERING
   ========================================================================== */

export function renderCategories() {
    const allCats = ['Todos', ...getAllCategoryNames()];
    const container = document.getElementById('categories-container');
    if (!container) return;

    container.innerHTML = Array.from(allCats).map(catName => {
        const isActive = state.activeCategory === catName;
        const localizedName = getCategoryDisplayName(catName);
        return `
            <button data-action="filter-category" data-category="${escapeHtml(catName)}"
                class="px-5 py-2.5 rounded-full text-xs font-bold uppercase tracking-wider transition-all duration-300 flex-shrink-0 flex items-center gap-2 tactile-target ${isActive ? 'bg-king-gold text-black shadow-lg shadow-king-gold/25 font-black scale-105' : 'bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white border border-white/5'}">
                <span>${escapeHtml(localizedName)}</span>
            </button>
        `;
    }).join('');
    renderProductCategoryOptions();
}

function renderProductCategoryOptions(selected = '') {
    const input = document.getElementById('prod-cat');
    if (!input) return;
    const categories = getAllCategoryNames();
    if (selected && !categories.some(name => name.toLocaleLowerCase() === selected.toLocaleLowerCase())) {
        categories.push(selected);
    }
    input.replaceChildren(...categories.map(name => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        return option;
    }));
    input.value = selected || categories[0] || '';
}

export function filterCat(catName) {
    state.activeCategory = catName;
    renderCategories();
    renderMenu();
}

export function renderExperienceCategories() {
    ensureExperienceCategorySelection();
    const grid = document.querySelector('#experience-menu .category-grid');
    const status = document.querySelector('[data-experience-categories-status]');
    if (!grid) return;
    if (!state.productsReady && !state.products.length) {
        if (status) status.hidden = true;
        renderExperienceSkeletons(grid, 4, 'category');
        return;
    }
    grid.removeAttribute('aria-busy');

    const categoryNames = new Map();
    state.categories.forEach(category => {
        const name = typeof category === 'string' ? category : category?.name;
        if (name?.trim()) {
            const cleanName = name.trim();
            categoryNames.set(cleanName.toLocaleLowerCase(), cleanName);
        }
    });
    state.products.forEach(product => {
        if (product.category?.trim()) {
            const cleanName = product.category.trim();
            if (!categoryNames.has(cleanName.toLocaleLowerCase())) {
                categoryNames.set(cleanName.toLocaleLowerCase(), cleanName);
            }
        }
    });

    if (!categoryNames.size) {
        const emptyStatus = status || document.createElement('p');
        emptyStatus.className = 'experience-data-status col-span-full';
        emptyStatus.setAttribute('data-experience-categories-status', '');
        emptyStatus.setAttribute('role', 'status');
        grid.replaceChildren(emptyStatus);
        renderedExperienceCategories = null;
        emptyStatus.hidden = false;
        emptyStatus.textContent = state.productsReady
            ? t('experience_categories_empty')
            : t('experience_categories_loading');
        return;
    }

    if (status) status.hidden = true;
    const nextCategories = Array.from(categoryNames.values()).map((name, index) => {
        const safeName = escapeHtml(name);
        const productCount = state.products.filter(product => product.category?.trim().toLocaleLowerCase() === name.toLocaleLowerCase()).length;
        const coverProduct = state.products.find(product => product.category?.trim().toLocaleLowerCase() === name.toLocaleLowerCase());
        const category = state.categories.find(item => (typeof item === 'string' ? item : item.name)?.toLocaleLowerCase() === name.toLocaleLowerCase());
        const categoryImage = (typeof category === 'object' && category.imageUrl)
            || (coverProduct ? getProductLocalized(coverProduct).imageUrl : '');
        return `
            <button type="button" class="category-card" style="--card-index:${index}" data-category="${safeName}" aria-pressed="${selectedExperienceCategory === name}">
                <span class="category-copy">
                    <span class="category-name">${escapeHtml(getCategoryDisplayName(name))}</span>
                    <span class="category-action">${productCount} ${escapeHtml(productCount === 1 ? t('experience_products_one') : t('experience_products_count'))} <b aria-hidden="true">↗</b></span>
                </span>
                <span class="category-visual" aria-hidden="true">
                    ${categoryImage ? `<img class="category-cover-image experience-image-fade" src="${escapeHtml(categoryImage)}" alt="" loading="lazy" decoding="async" data-image-fallback="hide">` : ''}
                </span>
            </button>`;
    }).join('');
    if (renderedExperienceCategories !== nextCategories) {
        grid.innerHTML = nextCategories;
        revealExperienceImages(grid);
        renderedExperienceCategories = nextCategories;
    }
    animateExperienceItems(grid);
}

export function renderExperienceProducts() {
    ensureExperienceCategorySelection();
    const grid = document.getElementById('experience-products-grid');
    document.getElementById('experience-admin-menu-controls')?.classList.toggle('hidden', !isOwner());
    const title = document.getElementById('products-title');
    const summary = document.getElementById('experience-products-summary');
    const search = document.getElementById('experience-product-search');
    if (!grid) return;

    const category = selectedExperienceCategory;
    if (!state.productsReady && !state.products.length) {
        if (title) title.textContent = category ? getCategoryDisplayName(category) : t('experience_products_all');
        if (summary) summary.textContent = '';
        renderExperienceSkeletons(grid, 3, 'product');
        return;
    }
    grid.removeAttribute('aria-busy');
    const term = (search?.value || '').trim().toLocaleLowerCase();
    const localizedCategory = category ? getCategoryDisplayName(category) : t('experience_products_all');
    if (title) title.textContent = localizedCategory;

    const products = state.products.filter(product => {
        const matchesCategory = !category || product.category?.trim().toLocaleLowerCase() === category.toLocaleLowerCase();
        const localized = getProductLocalized(product);
        const haystack = [localized.name, localized.description, product.name, product.nameEn, product.ingredients, product.ingredientsEn]
            .filter(Boolean).join(' ').toLocaleLowerCase();
        return matchesCategory && (!term || haystack.includes(term));
    });

    if (summary) {
        summary.textContent = `${products.length} ${products.length === 1 ? t('experience_product_available_one') : t('experience_product_available_many')}${category ? ` · ${localizedCategory}` : ''}`;
    }

    if (!products.length) {
        const message = state.products.length
            ? t('experience_products_no_match')
            : state.productsReady ? t('experience_products_empty') : t('experience_products_loading');
        const emptyMarkup = `<p class="experience-data-status col-span-full" role="status">${message}</p>`;
        if (renderedExperienceProducts !== emptyMarkup) {
            grid.innerHTML = emptyMarkup;
            refreshProductModels(grid);
            renderedExperienceProducts = emptyMarkup;
        }
        return;
    }

    const nextProducts = products.map((product, index) => {
        const localized = getProductLocalized(product);
        const imageUrl = localized.imageUrl || '';
        const safeId = escapeHtml(product.id);
        const safeImage = escapeHtml(imageUrl);
        const safeSrcset = escapeHtml(localized.imageSrcsets?.[0] || '');
        const imageWidth = localized.imageWidths?.[0] || 800;
        const imageHeight = localized.imageHeights?.[0] || 600;
        const safeName = escapeHtml(localized.name || t('experience_product_fallback'));
        const safeDescription = escapeHtml(localized.description || '');
        const safeCategory = escapeHtml(localized.category || category || '');
        const safeModelUrl = escapeHtml(product.model3dUrl?.trim() || '');
        const price = getProductPrice(product);
        const available = productIsAvailable(product);
        const rating = getProductRatingSummary(product.id);
        const ratingLabel = rating.average === null
            ? t('experience_no_reviews')
            : `${rating.average.toFixed(1)} (${rating.reviews.length})`;
        const ratingAriaLabel = rating.average === null
            ? ratingLabel
            : t('experience_rating_aria')
                .replace('{rating}', rating.average.toFixed(1))
                .replace('{count}', String(rating.reviews.length));
        return `
            <article class="experience-product-card" style="--card-index:${index}">
                <button type="button" class="experience-product-photo" data-product-details="${safeId}" aria-label="${escapeHtml(t('experience_view_dish').replace('{name}', localized.name || t('experience_product_fallback')))}">
                    ${safeImage ? `<img class="experience-product-image experience-image-fade" src="${safeImage}" ${safeSrcset ? `srcset="${safeSrcset}" sizes="(max-width: 768px) 85vw, 40vw"` : ''} width="${imageWidth}" height="${imageHeight}" alt="${safeName}" loading="lazy" decoding="async" data-image-fallback="show-next"><span class="experience-photo-placeholder" aria-hidden="true" hidden><i class="fa-solid fa-utensils"></i></span>` : '<span class="experience-photo-placeholder" aria-hidden="true"><i class="fa-solid fa-utensils"></i></span>'}
                    ${safeModelUrl ? `<canvas hidden class="experience-product-model-canvas" data-product-model="${safeModelUrl}" aria-label="Modelo 3D interactivo de ${safeName}"></canvas>` : ''}
                    <span class="experience-product-photo-label">${escapeHtml(t('experience_photo_label'))} <b aria-hidden="true">↗</b></span>
                </button>
                <div class="experience-product-info">
                    <span class="experience-product-category">${safeCategory}</span>
                    <h3>${safeName}</h3>
                    <p>${safeDescription}</p>
                    <div class="experience-product-rating" aria-label="${escapeHtml(ratingAriaLabel)}">
                        <span class="experience-rating-stars" aria-hidden="true">${renderRatingStars(rating.average)}</span>
                        <span>${ratingLabel}</span>
                    </div>
                    ${isOwner() ? `<div class="experience-product-admin-actions">
                        <button type="button" data-edit-product="${safeId}" aria-label="${escapeHtml(t('experience_edit_aria').replace('{name}', localized.name || t('experience_product_fallback')))}"><i class="fa-solid fa-pencil" aria-hidden="true"></i> ${t('experience_edit')}</button>
                        <button type="button" data-delete-product="${safeId}" data-delete-name="${safeName}" aria-label="${escapeHtml(t('experience_delete_aria').replace('{name}', localized.name || t('experience_product_fallback')))}"><i class="fa-solid fa-trash" aria-hidden="true"></i> ${t('experience_delete')}</button>
                    </div>` : ''}
                    <div class="experience-product-footer">
                        <span class="experience-product-price">${price < (Number(product.price) || 0) ? `<del class="mr-1 opacity-50">${escapeHtml(formatPrice(product.price))}</del>` : ''}${escapeHtml(formatPrice(price))}</span>
                        ${!available ? `<span class="text-xs font-bold uppercase text-red-300">${t('experience_sold_out')}</span>` : ''}
                        ${safeModelUrl ? `<button type="button" data-action="activate-product-model" data-toggle-product-model data-product-name="${safeName}" class="experience-add-button" aria-label="${escapeHtml(t('experience_3d_aria').replace('{name}', localized.name || t('experience_product_fallback')))}" aria-pressed="false"><i class="fa-solid fa-cube" aria-hidden="true"></i><span>3D</span></button>` : ''}
                        <button type="button" class="experience-add-button" data-add-product="${safeId}" ${available ? '' : 'disabled'} aria-label="${escapeHtml(t('experience_add_to_cart_aria').replace('{name}', localized.name || t('experience_product_fallback')))}">
                            <i class="fa-solid fa-cart-plus" aria-hidden="true"></i><span>${t('experience_add_to_cart')}</span>
                        </button>
                    </div>
                </div>
            </article>`;
    }).join('');
    if (renderedExperienceProducts !== nextProducts) {
        grid.innerHTML = nextProducts;
        revealExperienceImages(grid);
        animateExperienceItems(grid);
        refreshProductModels(grid);
        renderedExperienceProducts = nextProducts;
    }
}

/* ==========================================================================
   PRODUCT DETAIL MODAL & CAROUSEL (3D / AR SUPPORT)
   ========================================================================== */

export function openDetail(id) {
    state.currentDetailId = id;
    state.selectedRatingValue = 0;
    resetStarSelector();

    const p = state.products.find(x => x.id === id);
    if (!p) return;

    deactivate3DView();
    const localized = getProductLocalized(p);

    state.carouselImages = localized.imageUrls;
    state.carouselImageSrcsets = localized.imageSrcsets || [];
    const carouselImageWidths = localized.imageWidths || [];
    const carouselImageHeights = localized.imageHeights || [];
    state.currentSlideIndex = 0;

    const sCont = document.getElementById('carousel-slides');
    const iCont = document.getElementById('carousel-indicators');
    const prevBtn = document.querySelector('#media-2d button[onclick*="prevSlide"]');
    const nextBtn = document.querySelector('#media-2d button[onclick*="nextSlide"]');

    if (prevBtn && nextBtn) {
        const showArrows = state.carouselImages.length > 1;
        prevBtn.style.display = showArrows ? 'flex' : 'none';
        nextBtn.style.display = showArrows ? 'flex' : 'none';
    }

    if (sCont && iCont) {
        if (state.carouselImages.length === 0) {
            sCont.innerHTML = `<div class="w-full h-full bg-king-surface flex items-center justify-center text-gray-600"><i class="fa-regular fa-image text-4xl"></i></div>`;
            iCont.innerHTML = '';
        } else {
            sCont.innerHTML = state.carouselImages.map((u, index) => `
                <div class="w-full h-full flex-shrink-0 relative flex items-center justify-center">
                    <img src="${escapeHtml(u)}" ${state.carouselImageSrcsets[index] ? `srcset="${escapeHtml(state.carouselImageSrcsets[index])}" sizes="(max-width: 768px) 90vw, 50vw"` : ''} width="${carouselImageWidths[index] || 800}" height="${carouselImageHeights[index] || 600}" loading="lazy" decoding="async" class="w-full h-full object-cover" data-image-fallback-url="https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=800">
                </div>
            `).join('');
            iCont.innerHTML = state.carouselImages.length > 1 ? state.carouselImages.map((_, i) => `
                <button data-action="go-to-slide" data-slide="${i}" class="carousel-dot h-2 rounded-full transition-all duration-300 ${i === 0 ? 'bg-king-gold w-4 shadow-[0_0_8px_#D4AF37]' : 'bg-white/40 w-2'}"></button>
            `).join('') : '';
        }
        sCont.style.transform = `translateX(0%)`;
    }

    // Keep the model URL off the viewer until the guest requests 3D or AR.
    const viewer = document.getElementById('modal-3d-viewer');
    const ctrl = document.getElementById('btn-container-3d-controls');
    if (p.model3dUrl && p.model3dUrl.trim() !== '') {
        if (viewer) {
            viewer.removeAttribute('src');
            viewer.dataset.modelSrc = p.model3dUrl.trim();
        }
        if (ctrl) ctrl.style.display = 'flex';
    } else {
        if (viewer) {
            viewer.removeAttribute('src');
            delete viewer.dataset.modelSrc;
        }
        if (ctrl) ctrl.style.display = 'none';
    }

    // Texts & Pricing
    document.getElementById('modal-title').innerText = localized.name;
    const modalPrice = document.getElementById('modal-price');
    const currentPrice = getProductPrice(p);
    if (modalPrice) {
        modalPrice.innerHTML = currentPrice < (Number(p.price) || 0)
            ? `<del class="mr-2 text-sm text-gray-500">${formatPrice(p.price)}</del>${formatPrice(currentPrice)}`
            : formatPrice(currentPrice);
    }
    document.getElementById('modal-desc').innerText = localized.description;
    document.getElementById('modal-cat').innerText = localized.category;
    document.getElementById('modal-qty').value = 1;
    const itemNotesInput = document.getElementById('detail-item-notes');
    if (itemNotesInput) itemNotesInput.value = '';

    const allergenText = currentLang === 'en'
        ? (p.allergensEn || p.allergens || '')
        : (p.allergens || p.allergensEn || '');
    const allergenContainer = document.getElementById('modal-allergens-container');
    const allergenLabel = document.getElementById('modal-allergens');
    if (allergenLabel) allergenLabel.textContent = allergenText || (currentLang === 'en' ? 'Not declared. Please ask our staff if you have an allergy.' : 'No declarados. Consulte con nuestro equipo si tiene alguna alergia.');
    if (allergenContainer) allergenContainer.classList.remove('hidden');

    // Meat cooking points toggle
    const isMainCourse = (p.category || '').toLowerCase().includes('fuerte') || (p.category || '').toLowerCase().includes('carne') || (p.categoryEn || '').toLowerCase().includes('main');
    document.getElementById('meat-prep-options')?.classList.toggle('hidden', !isMainCourse);

    // Ingredients
    const ing = localized.ingredients || '';
    const ings = ing.split(',').map(s => s.trim()).filter(Boolean);
    const ingCont = document.getElementById('modal-ingredients-container');
    const ingList = document.getElementById('modal-ingredients');
    if (ings.length > 0) {
        if (ingCont) ingCont.classList.remove('hidden');
        if (ingList) {
            ingList.innerHTML = ings.map(i => `<span class="px-2.5 py-1 rounded-full bg-white/5 text-[9px] uppercase tracking-wider text-gray-300 border border-white/5 font-sans">${escapeHtml(i)}</span>`).join('');
        }
    } else {
        if (ingCont) ingCont.classList.add('hidden');
    }

    renderProductReviews(p.id);

    const btnAddCart = document.getElementById('btn-add-cart');
    if (btnAddCart) {
        btnAddCart.disabled = !productIsAvailable(p);
        btnAddCart.classList.toggle('opacity-50', !productIsAvailable(p));
        btnAddCart.classList.toggle('cursor-not-allowed', !productIsAvailable(p));
        btnAddCart.setAttribute('aria-disabled', String(!productIsAvailable(p)));
    }

    openModal('detail-modal');
    startCarouselAutoPlay();
}

export function addCurrentDetailToCart() {
    const product = state.products.find(item => item.id === state.currentDetailId);
    if (!product) return;
    if (!productIsAvailable(product)) {
        showToast(t('cart_title'), t('cart_sold_out'), true);
        return;
    }
    const quantity = parseInt(document.getElementById('modal-qty')?.value || '1', 10);
    const notes = document.getElementById('detail-item-notes')?.value.trim() || '';
    const isMainCourse = (product.category || '').toLowerCase().includes('fuerte')
        || (product.category || '').toLowerCase().includes('carne')
        || (product.categoryEn || '').toLowerCase().includes('main');
    const cookingPoint = document.querySelector('input[name="cook-point"]:checked')?.value;
    const itemNotes = [notes, isMainCourse && cookingPoint ? `Término: ${cookingPoint}` : ''].filter(Boolean).join(' · ');
    addToCart(product.id, Number.isNaN(quantity) ? 1 : quantity, itemNotes);
    closeModal('detail-modal');
}

export function updateModalQty(delta) {
    const el = document.getElementById('modal-qty');
    if (!el) return;
    let v = parseInt(el.value, 10) + delta;
    if (isNaN(v) || v < 1) v = 1;
    el.value = v;
}

export async function activate3DView() {
    const m2d = document.getElementById('media-2d');
    const m3d = document.getElementById('media-3d');
    const viewer = document.getElementById('modal-3d-viewer');
    if (!viewer?.dataset.modelSrc) return;

    if (m3d && !m3d.classList.contains('opacity-0')) {
        deactivate3DView();
        return;
    }

    try {
        modelViewerModulePromise ||= import('https://ajax.googleapis.com/ajax/libs/model-viewer/3.4.0/model-viewer.min.js');
        await modelViewerModulePromise;
        if (!viewer.getAttribute('src')) viewer.setAttribute('src', viewer.dataset.modelSrc);
        if (m2d) m2d.classList.add('opacity-0', 'pointer-events-none');
        if (m3d) m3d.classList.remove('opacity-0', 'pointer-events-none');
    } catch (error) {
        console.error('[Product3D] No se pudo cargar el visor del detalle:', error);
        showToast('3D', currentLang === 'en' ? 'The 3D viewer could not be loaded.' : 'No se pudo cargar el visor 3D.', true);
    }
}

export function deactivate3DView() {
    const m2d = document.getElementById('media-2d');
    const m3d = document.getElementById('media-3d');
    const viewer = document.getElementById('modal-3d-viewer');
    if (viewer?.getAttribute('src')) viewer.removeAttribute('src');
    if (m2d) m2d.classList.remove('opacity-0', 'pointer-events-none');
    if (m3d) m3d.classList.add('opacity-0', 'pointer-events-none');
}

export async function launchAR() {
    const viewer = document.getElementById('modal-3d-viewer');
    if (viewer && viewer.dataset.modelSrc) {
        await activate3DView();
        await viewer.updateComplete;
        if (typeof viewer.activateAR === 'function') viewer.activateAR();
        else showToast('AR', t('toast_ar_mobile'), true);
    } else {
        showToast('AR', t('toast_ar_mobile'), true);
    }
}

/* --- Carousel Helpers --- */
export function showSlide(idx) {
    const container = document.getElementById('carousel-slides');
    if (!container || state.carouselImages.length === 0) return;

    if (idx >= state.carouselImages.length) state.currentSlideIndex = 0;
    else if (idx < 0) state.currentSlideIndex = state.carouselImages.length - 1;
    else state.currentSlideIndex = idx;

    container.style.transform = `translateX(-${state.currentSlideIndex * 100}%)`;

    document.querySelectorAll('#carousel-indicators .carousel-dot').forEach((dot, index) => {
        dot.className = index === state.currentSlideIndex
            ? "carousel-dot h-2 rounded-full transition-all duration-300 bg-king-gold w-4 shadow-[0_0_8px_#D4AF37]"
            : "carousel-dot h-2 rounded-full transition-all duration-300 bg-white/40 w-2";
    });
}

export function startCarouselAutoPlay() {
    stopCarouselAutoPlay();
    if (state.carouselImages.length <= 1) return;
    state.carouselIntervalId = setInterval(() => {
        showSlide(state.currentSlideIndex + 1);
    }, 4500);
}

export function stopCarouselAutoPlay() {
    if (state.carouselIntervalId) {
        clearInterval(state.carouselIntervalId);
        state.carouselIntervalId = null;
    }
}

export function prevSlide(e) {
    if (e) e.stopPropagation();
    showSlide(state.currentSlideIndex - 1);
    startCarouselAutoPlay();
}

export function nextSlide(e) {
    if (e) e.stopPropagation();
    showSlide(state.currentSlideIndex + 1);
    startCarouselAutoPlay();
}

export function goToSlide(idx) {
    showSlide(idx);
    startCarouselAutoPlay();
}

/* ==========================================================================
   CART & BILL SPLITTING
   ========================================================================== */

function createCartLineId() {
    return `line-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function ensureCartLineIds() {
    const seen = new Set();
    state.cart.forEach(item => {
        if (!item.cartId || seen.has(item.cartId)) item.cartId = createCartLineId();
        seen.add(item.cartId);
    });
}

function findCartLine(key) {
    return state.cart.find(item => (item.cartId || item.id) === key) || state.cart.find(item => item.id === key);
}

export function addToCart(id, qty = 1, notes = '') {
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) {
        showToast(t('cart_title'), t('cart_quantity_invalid'), true);
        return;
    }
    const product = state.products.find(item => item.id === id);
    if (!product) {
        showToast(t('cart_title'), t('cart_item_unavailable'), true);
        return;
    }
    if (!productIsAvailable(product)) {
        showToast(t('cart_title'), t('cart_sold_out'), true);
        return;
    }
    const lineNotes = String(notes || '').trim();
    const existing = state.cart.find(x => x.id === id && String(x.notes || '').trim() === lineNotes);
    if (existing) {
        if (existing.qty + qty > 20) {
            showToast(t('cart_title'), t('cart_quantity_limit'), true);
            return;
        }
        existing.qty += qty;
    } else {
        state.cart.push({ id, qty, notes: lineNotes, cartId: createCartLineId() });
    }
    ensureCartLineIds();

    // ── Animación visual táctil en FAB (móvil), badge y contenedor desktop ──
    const fabBtn = document.querySelector('#fab-cart button');
    if (fabBtn) {
        fabBtn.classList.remove('cart-item-added');
        void fabBtn.offsetWidth; // Reflow
        fabBtn.classList.add('cart-item-added');
        setTimeout(() => fabBtn.classList.remove('cart-item-added'), 650);
    }
    const deskContainer = document.getElementById('nav-cart-btn-desktop');
    if (deskContainer) {
        deskContainer.classList.remove('cart-item-added');
        void deskContainer.offsetWidth;
        deskContainer.classList.add('cart-item-added');
        setTimeout(() => deskContainer.classList.remove('cart-item-added'), 650);
    }
    const deskBadge = document.getElementById('cart-badge-desktop');
    if (deskBadge) {
        deskBadge.classList.remove('cart-item-added');
        void deskBadge.offsetWidth;
        deskBadge.classList.add('cart-item-added');
        setTimeout(() => deskBadge.classList.remove('cart-item-added'), 650);
    }
    updateCart();
    showToast(t('cart_title'), t('cart_added'));
}

export function updateItemQty(id, delta) {
    const item = findCartLine(id);
    const product = item && state.products.find(x => x.id === item.id);
    if (delta > 0 && product && !productIsAvailable(product)) {
        showToast(t('cart_title'), t('cart_sold_out'), true);
        return;
    }
    if (item) {
        if (delta > 0 && item.qty + delta > 20) {
            showToast(t('cart_title'), t('cart_quantity_limit'), true);
            return;
        }
        item.qty += delta;
        if (item.qty <= 0) removeFromCart(id);
        else updateCart();
    }
}

export function removeFromCart(id) {
    const hasLineId = state.cart.some(item => item.cartId === id);
    const removedItems = state.cart.filter(item => hasLineId ? item.cartId === id : item.id === id);
    state.cart = state.cart.filter(item => hasLineId ? item.cartId !== id : item.id !== id);
    state.diners.forEach(d => {
        if (d.assignments) removedItems.forEach(item => {
            delete d.assignments[item.id];
            delete d.assignments[item.cartId];
        });
    });
    removedItems.forEach(item => delete splitState.individualQtys[item.cartId || item.id]);
    updateCart();
}

export function updateCart() {
    ensureCartLineIds();
    const previousCount = state.cart.length;
    if (state.productsReady) {
        state.cart = state.cart.filter(item => {
            const validProduct = state.products.some(product => product.id === item.id);
            return validProduct && Number.isInteger(item.qty) && item.qty > 0 && item.qty <= 20;
        });
        if (state.cart.length < previousCount) {
            showToast(t('cart_title'), currentLang === 'en' ? 'Some saved items were removed because they are no longer available.' : 'Se retiraron algunos elementos guardados porque ya no están disponibles.', true);
        }
    }
    if (state.cart.length) {
        localStorage.setItem('kingCart', JSON.stringify({ savedAt: Date.now(), items: state.cart }));
    } else {
        localStorage.removeItem('kingCart');
    }
    const totalItems = state.cart.reduce((sum, item) => sum + item.qty, 0);
    const cartBar = document.getElementById('experience-cart-bar');
    const cartBarCount = document.getElementById('experience-cart-bar-count');
    const cartBarTotal = document.getElementById('experience-cart-bar-total');
    const hasCartItems = state.cart.length > 0;
    if (cartBar) {
        cartBar.classList.toggle('is-visible', hasCartItems);
        cartBar.setAttribute('aria-hidden', String(!hasCartItems));
        if (hasCartItems) cartBar.removeAttribute('inert');
        else cartBar.setAttribute('inert', '');
        cartBar.setAttribute('aria-label', currentLang === 'en'
            ? `View order, ${totalItems} ${totalItems === 1 ? 'item' : 'items'}, ${formatPrice(getCartTotal())}`
            : `Ver pedido, ${totalItems} ${totalItems === 1 ? 'artículo' : 'artículos'}, ${formatPrice(getCartTotal())}`);
    }
    document.getElementById('experience-root')?.classList.toggle('has-cart-items', hasCartItems);
    if (cartBarCount) cartBarCount.textContent = String(totalItems);
    if (cartBarTotal) cartBarTotal.textContent = formatPrice(getCartTotal());
    const cartAriaKey = totalItems === 1 ? 'experience_cart_count_aria_one' : 'experience_cart_count_aria_many';
    const cartAriaLabel = t(cartAriaKey).replace('{count}', String(totalItems));
    const desktopCart = document.getElementById('nav-cart-btn-desktop');
    if (desktopCart) {
        desktopCart.setAttribute('aria-label', cartAriaLabel);
    }

    const dBadge = document.getElementById('cart-badge-desktop');
    if (dBadge) {
        dBadge.innerText = String(totalItems);
        dBadge.classList.toggle('scale-0', totalItems === 0);
    }
    const mBadge = document.getElementById('cart-badge-mobile');
    if (mBadge) {
        mBadge.innerText = String(totalItems);
        mBadge.classList.toggle('scale-0', totalItems === 0);
        mBadge.classList.toggle('scale-100', totalItems > 0);
    }

    const container = document.getElementById('cart-items-list');
    const emptyView = document.getElementById('cart-empty');
    const footer = document.getElementById('cart-items-footer');

    if (state.cart.length === 0) {
        if (container) container.innerHTML = '';
        if (footer) footer.classList.add('hidden');
        if (emptyView) emptyView.classList.remove('hidden');
        hideCheckoutForm();
    } else {
        if (emptyView) emptyView.classList.add('hidden');
        if (footer) footer.classList.remove('hidden');

        let total = 0;
        if (container) {
            container.innerHTML = state.cart.map(item => {
                const p = state.products.find(x => x.id === item.id);
                if (!p) return '';
                const localized = getProductLocalized(p);
                const unitPrice = getProductPrice(p);
                const subtotal = unitPrice * item.qty;
                total += subtotal;
                const lineId = escapeHtml(item.cartId || item.id);
                const itemNotes = String(item.notes || '').trim();
                const imageUrl = localized.imageUrl ? escapeHtml(localized.imageUrl) : '';

                return `
                    <div class="flex gap-3 p-3 bg-white/5 rounded-xl border border-white/5 items-center font-sans text-xs">
                        <div class="cart-item-thumbnail">
                            ${imageUrl ? `<img src="${imageUrl}" alt="" loading="lazy" data-image-fallback="show-next">` : ''}
                            <i class="fa-solid fa-utensils" aria-hidden="true" ${imageUrl ? 'hidden' : ''}></i>
                        </div>
                        <div class="flex-grow min-w-0">
                            <div class="flex justify-between items-start">
                                <h4 class="text-white text-xs font-bold truncate pr-2">${escapeHtml(localized.name)}</h4>
                                <button data-action="remove-cart-item" data-cart-id="${lineId}" class="text-gray-500 hover:text-red-500 transition" title="${escapeHtml(t('cart_remove_item'))}" aria-label="${escapeHtml(t('cart_remove_item'))}"><i class="fa-solid fa-trash text-[10px]" aria-hidden="true"></i></button>
                            </div>
                            <p class="text-king-gold text-xs font-mono">${formatPrice(unitPrice)}${productIsAvailable(p) ? '' : `<span class="ml-2 text-red-300">${t('cart_sold_out_label')}</span>`}</p>
                            ${itemNotes ? `<p class="cart-item-notes"><i class="fa-solid fa-note-sticky" aria-hidden="true"></i> ${escapeHtml(itemNotes)}</p>` : ''}
                            <div class="flex items-center bg-black/40 rounded-lg w-max border border-white/5 mt-1">
                                <button data-action="adjust-cart-item" data-cart-id="${lineId}" data-delta="-1" class="w-10 h-10 flex items-center justify-center text-gray-400 hover:text-white transition text-sm" aria-label="${escapeHtml(t('cart_decrease_quantity'))}">-</button>
                                <span class="text-[10px] text-white px-1 font-bold w-5 text-center font-mono">${escapeHtml(item.qty)}</span>
                                <button data-action="adjust-cart-item" data-cart-id="${lineId}" data-delta="1" class="w-10 h-10 flex items-center justify-center text-gray-400 hover:text-white transition text-sm" aria-label="${escapeHtml(t('cart_increase_quantity'))}">+</button>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        }

        const sTotal = document.getElementById('cart-subtotal');
        const cTotal = document.getElementById('checkout-total');
        if (sTotal) sTotal.innerText = formatPrice(total);
        if (cTotal) cTotal.innerText = formatPrice(total);

        const btnContinue = document.getElementById('btn-continue-checkout');
        if (btnContinue) {
            btnContinue.disabled = total <= 0;
            btnContinue.innerHTML = `<span>${t('btn_checkout')}</span> <i class="fa-solid fa-arrow-right"></i>`;
        }
    }

    renderSplitBill();
}

export function switchCartTab(tab) {
    state.currentCartTab = tab;
    const itemsView = document.getElementById('cart-view-items');
    const splitView = document.getElementById('cart-view-split');
    const tabItems = document.getElementById('tab-cart-items');
    const tabSplit = document.getElementById('tab-cart-split');

    if (tab === 'items') {
        itemsView?.classList.remove('hidden');
        splitView?.classList.add('hidden');
        if (tabItems) tabItems.className = "py-3 font-bold uppercase tracking-wider text-king-gold border-b-2 border-king-gold transition";
        if (tabSplit) tabSplit.className = "py-3 font-bold uppercase tracking-wider text-gray-500 border-b-2 border-transparent hover:text-white transition flex items-center justify-center gap-2";
    } else {
        itemsView?.classList.add('hidden');
        splitView?.classList.remove('hidden');
        if (tabSplit) tabSplit.className = "py-3 font-bold uppercase tracking-wider text-king-gold border-b-2 border-king-gold transition flex items-center justify-center gap-2";
        if (tabItems) tabItems.className = "py-3 font-bold uppercase tracking-wider text-gray-500 border-b-2 border-transparent hover:text-white transition";
        renderSplitBill();
    }
}

/* ==========================================================================
   SPLIT BILL — Nueva UI Táctil de Dos Paneles
   ========================================================================== */

// Estado aislado de la calculadora de cuenta
const splitState = {
    people: 2,                // Opción 1: número de personas
    individualQtys: {}        // Opción 2: { cartLineId: qty que paga "yo" }
};

// Calcula el subtotal del carrito (reutiliza la misma fórmula que updateCart)
function _cartSubtotal() {
    return state.cart.reduce((sum, item) => {
        const p = state.products.find(x => x.id === item.id);
        return sum + (p ? getProductPrice(p) * item.qty : 0);
    }, 0);
}

export function renderSplitBill() {
    const subtotal = _cartSubtotal();
    let myTotal = 0;

    // ── PANEL 1: Partes Iguales ──────────────────────────────────────────
    const countEl  = document.getElementById('split-people-count');
    const resultEl = document.getElementById('split-equal-result');
    const minusBtn = document.getElementById('btn-split-minus');

    if (countEl)  countEl.innerText  = String(splitState.people);
    if (resultEl) resultEl.innerText = subtotal > 0
        ? formatPrice(Math.ceil(subtotal / splitState.people))
        : '$0';
    if (minusBtn) minusBtn.disabled = splitState.people <= 1;

    // ── PANEL 2: Mi Consumo Individual ──────────────────────────────────
    const listEl   = document.getElementById('split-individual-list');
    const indResEl = document.getElementById('split-individual-result');

    if (listEl) {
        if (state.cart.length === 0) {
            listEl.innerHTML = `<p class="text-center text-[10px] text-gray-500 py-6">${t('split_selection_prompt')}</p>`;
        } else {
            listEl.innerHTML = state.cart.map(item => {
                const p = state.products.find(x => x.id === item.id);
                if (!p) return '';
                const loc = getProductLocalized(p);

                // Mi cantidad de este item (0 por defecto)
                const lineId = item.cartId || item.id;
                const myQty = Math.min(splitState.individualQtys[lineId] || 0, item.qty);
                myTotal += getProductPrice(p) * myQty;

                // ¿Está seleccionado?
                const isSelected = myQty > 0;

                return `
                <div class="flex items-center gap-3 p-3 rounded-xl border transition-all duration-200 ${
                    isSelected
                        ? 'bg-emerald-500/10 border-emerald-500/30'
                        : 'bg-white/4 border-white/8 hover:border-white/15'
                }">
                    <!-- Checkbox táctil -->
                    <button
                        type="button"
                        aria-pressed="${isSelected}"
                        aria-label="${isSelected ? t('split_remove_dish') : t('split_add_dish')} ${escapeHtml(loc.name)} ${t('split_consumption_aria')}"
                        data-action="toggle-split-item" data-cart-id="${escapeHtml(lineId)}"
                        class="w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center border-2 transition-all active:scale-90 ${
                            isSelected
                                ? 'bg-emerald-500 border-emerald-500 text-white'
                                : 'bg-white/5 border-white/20 text-transparent hover:border-king-gold/50'
                        }">
                        <i class="fa-solid fa-check text-xs"></i>
                    </button>

                    <!-- Info del platillo -->
                    <div class="flex-grow min-w-0">
                        <p class="text-xs font-bold text-white truncate">${escapeHtml(loc.name)}</p>
                        <p class="text-[10px] text-king-gold font-mono">${formatPrice(getProductPrice(p))} ${t('split_unit_short')} &bull; <span class="text-gray-400">${escapeHtml(item.qty)} ${t('split_in_cart')}</span></p>
                        ${item.notes ? `<p class="cart-item-notes">${escapeHtml(item.notes)}</p>` : ''}
                    </div>

                    <!-- Stepper de cantidad (solo si está seleccionado y hay más de 1 unidad) -->
                    ${ item.qty > 1
                        ? `<div class="flex items-center gap-1 bg-black/40 rounded-xl p-1 border border-white/10 flex-shrink-0">
                                <button data-action="adjust-split-item" data-cart-id="${escapeHtml(lineId)}" data-delta="-1"
                                    class="w-8 h-8 text-white font-bold text-sm flex items-center justify-center rounded-lg hover:bg-white/10 active:scale-90 transition-all ${ !isSelected ? 'opacity-30 pointer-events-none' : '' }">−</button>
                                <span class="text-sm font-black font-mono w-5 text-center ${ isSelected ? 'text-emerald-400' : 'text-gray-600' }">${myQty}</span>
                                <button data-action="adjust-split-item" data-cart-id="${escapeHtml(lineId)}" data-delta="1"
                                    class="w-8 h-8 text-white font-bold text-sm flex items-center justify-center rounded-lg hover:bg-white/10 active:scale-90 transition-all ${ !isSelected ? 'opacity-30 pointer-events-none' : '' }">+</button>
                           </div>`
                        : ''
                    }
                </div>`;
            }).join('');

        }
    }

    if (indResEl) indResEl.innerText = formatPrice(myTotal);
}

// Aumenta/disminuye la cantidad de personas (Panel 1)
export function adjustSplitPeople(delta) {
    splitState.people = Math.max(1, splitState.people + delta);
    renderSplitBill();
}

// Activa/desactiva un platillo para "Mi Consumo" (Panel 2)
export function toggleSplitItem(lineId) {
    const item = findCartLine(lineId);
    if (!item) return;
    const key = item.cartId || item.id;
    if ((splitState.individualQtys[key] || 0) > 0) {
        // Desactiva
        delete splitState.individualQtys[key];
    } else {
        // Activa con 1 unidad por defecto
        splitState.individualQtys[key] = 1;
    }
    renderSplitBill();
}

// Ajusta cuántas unidades de ese platillo paga "yo" (Panel 2, mini stepper)
export function adjustSplitItemQty(lineId, delta) {
    const item = findCartLine(lineId);
    if (!item) return;
    const key = item.cartId || item.id;
    const current = splitState.individualQtys[key] || 0;
    const next = Math.min(item.qty, Math.max(0, current + delta));
    if (next === 0) {
        delete splitState.individualQtys[key];
    } else {
        splitState.individualQtys[key] = next;
    }
    renderSplitBill();
}

// Stubs de compatibilidad — la lógica vieja de diners ya no se usa en la UI,
// pero se mantienen para no romper referencias existentes en firebase-service.js
export function addDiner() { /* reemplazado por la nueva UI */ }
export function removeDiner() { /* reemplazado por la nueva UI */ }
export function adjustDinerItemQty() { /* reemplazado por la nueva UI */ }
export function copyDinerShare(name, total, details) {
    const text = `*KingMenu | Dividir Cuenta*\n${name}: ${formatPrice(total)}\n${details}`;
    navigator.clipboard.writeText(text).then(() => {
        showToast('OK', currentLang === 'en' ? 'Account share copied.' : 'Cuenta copiada al portapapeles.');
    }).catch(() => { showToast('OK', 'OK'); });
}


export function showCheckoutForm() {
    if (state.cart.length === 0) {
        showToast(t('cart_title'), t('cart_empty_error'), true);
        return;
    }
    const total = getCartTotal();
    if (total <= 0) {
        showToast(t('cart_title'), currentLang === 'en' ? 'Your cart is empty or has no valid amount.' : 'Su carrito está vacío o sin importe válido.', true);
        updateCart();
        return;
    }
    const unavailableDish = state.cart
        .map(item => state.products.find(product => product.id === item.id))
        .find(product => !product || !productIsAvailable(product));
    if (unavailableDish) {
        showToast(t('cart_title'), t('cart_remove_sold_out'), true);
        updateCart();
        return;
    }
    const summaryHtml = state.cart.map(item => {
        const product = state.products.find(entry => entry.id === item.id);
        if (!product) return '';
        const localized = getProductLocalized(product);
        const notes = String(item.notes || '').trim();
        return `<div class="font-sans"><div class="flex justify-between gap-3"><span>${escapeHtml(item.qty)}x ${escapeHtml(localized.name)}</span><span class="font-mono">${formatPrice(getProductPrice(product) * item.qty)}</span></div>${notes ? `<p class="cart-item-notes">${escapeHtml(notes)}</p>` : ''}</div>`;
    }).join('');
    const summaryList = document.getElementById('checkout-summary-list');
    if (summaryList) summaryList.innerHTML = summaryHtml;
    const checkoutTotal = document.getElementById('checkout-total');
    if (checkoutTotal) checkoutTotal.textContent = formatPrice(total);
    setCartCheckoutStep(2);
}

function setCartCheckoutStep(step) {
    const itemsView = document.getElementById('cart-view-items');
    const checkoutView = document.getElementById('cart-view-checkout');
    const stepLabel = document.getElementById('cart-modal-step-label');
    const stepOne = step === 1;
    itemsView?.classList.toggle('hidden', !stepOne);
    checkoutView?.classList.toggle('hidden', stepOne);
    document.getElementById('cart-step-one')?.classList.toggle('is-current', stepOne);
    document.getElementById('cart-step-two')?.classList.toggle('is-current', !stepOne);
    if (stepLabel) {
        stepLabel.textContent = stepOne
            ? (currentLang === 'en' ? 'Step 1 · Review your order' : 'Paso 1 · Revisa tu pedido')
            : (currentLang === 'en' ? 'Step 2 · Confirm at your table' : 'Paso 2 · Confirma en tu mesa');
    }
    if (stepOne) {
        document.getElementById('cart-items-list')?.scrollTo({ top: 0 });
    } else {
        document.getElementById('cart-view-checkout')?.querySelector('input, textarea')?.focus({ preventScroll: true });
    }
}

export function hideCheckoutForm() {
    setCartCheckoutStep(1);
}

// Contador de errores de validación — activa el tutorial tras 2 fallos consecutivos
let _submitValidationErrors = 0;
let isSubmitting = false;

function getCartTotal() {
    return state.cart.reduce((total, item) => {
        const product = state.products.find(entry => entry.id === item.id);
        if (!product || !productIsAvailable(product)) return total;
        return total + getProductPrice(product) * item.qty;
    }, 0);
}

export async function submitOrder() {
    if (isSubmitting) return;
    const tableAccess = dbService.getTableQrAccess();
    if (!tableAccess) {
        showToast('Mesa no verificada', currentLang === 'en'
            ? 'Scan the QR code assigned to your table before placing an order.'
            : 'Escanee el código QR asignado a su mesa antes de realizar el pedido.', true);
        return;
    }
    if (state.cart.length === 0) {
        showToast(t('cart_title'), t('cart_empty_error'), true);
        return;
    }
    const cartTotal = getCartTotal();
    if (cartTotal <= 0) {
        showToast(t('cart_title'), currentLang === 'en' ? 'Your cart is empty or has no valid amount.' : 'Su carrito está vacío o sin importe válido.', true);
        updateCart();
        return;
    }
    const unavailableDish = state.cart
        .map(item => state.products.find(product => product.id === item.id))
        .find(product => !product || !productIsAvailable(product));
    if (unavailableDish) {
        showToast(t('cart_title'), t('cart_remove_sold_out_order'), true);
        updateCart();
        return;
    }
    const nameInput = document.getElementById('order-name');
    const customerName = nameInput?.value.trim();
    const notes = document.getElementById('order-notes')?.value.trim();

    if (!customerName) {
        nameInput?.classList.add('input-error');
        showToast(
            currentLang === 'en' ? 'Required Information' : 'Información Obligatoria',
            t('validation_missing_name'),
            true
        );
        nameInput?.focus();
        setTimeout(() => {
            nameInput?.classList.remove('input-error');
        }, 3000);
        _submitValidationErrors++;
        if (_submitValidationErrors >= 2) {
            _submitValidationErrors = 0;
            setTimeout(() => openHelpModal(), 400);
        }
        return;
    }
    // Resetear contador en envío exitoso
    _submitValidationErrors = 0;

    const items = state.cart.map(item => ({
        id: item.id,
        qty: item.qty,
        notes: String(item.notes || '').trim()
    }));
    const orderId = createKitchenTicketId();
    const timestamp = Date.now();

    localStorage.setItem('kingCustomerName', customerName);

    const submitButton = document.querySelector('[data-action="submit-order"]');
    const originalButtonText = submitButton?.textContent;
    isSubmitting = true;
    if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = currentLang === 'en' ? 'Sending...' : 'Enviando...';
    }
    try {
        const docRef = await dbService.createOrder({
            customer: customerName,
            tableId: tableAccess.table,
            orderId,
            timestamp,
            status: 'pending',
            notes,
            items
        });

        // ── Guardado seguro de ID de orden aislado por dispositivo ──────────
        let deviceOrders = [];
        try {
            const raw = localStorage.getItem('kingDeviceOrders') || localStorage.getItem('kingOrderIds');
            deviceOrders = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(deviceOrders)) deviceOrders = [deviceOrders].filter(Boolean);
        } catch (e) { deviceOrders = []; }
        if (docRef && docRef.id && !deviceOrders.includes(docRef.id)) {
            deviceOrders.push(docRef.id);
        }
        if (docRef?.orderId) state.lastSubmittedOrderId = docRef.orderId.replace(/^#/, '');
        localStorage.setItem('kingDeviceOrders', JSON.stringify(deviceOrders));
        localStorage.setItem('kingOrderIds', JSON.stringify(deviceOrders));

        state.cart = [];
        const notesInput = document.getElementById('order-notes');
        if (notesInput) notesInput.value = '';
        localStorage.removeItem('cart');
        updateCart();
        closeModal('cart-modal');
        const ticketId = docRef?.orderId || orderId;
        showToast(
            t('toast_done'),
            currentLang === 'en'
                ? `Order sent to the kitchen! Ticket ${ticketId}`
                : `¡Comanda enviada a cocina! Pedido ${ticketId}`
        );
    } catch (e) {
        console.error('[Order] Error al enviar pedido:', e);
        showToast('Error', e?.message || (currentLang === 'en' ? 'Failed to submit order.' : 'Error al enviar comanda.'), true);
    } finally {
        isSubmitting = false;
        if (submitButton) {
            submitButton.disabled = false;
            submitButton.textContent = originalButtonText || t('btn_confirm');
        }
    }
}

function createKitchenTicketId() {
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const randomValues = crypto.getRandomValues(new Uint8Array(6));
    return `#${Array.from(randomValues, value => alphabet[value % alphabet.length]).join('')}`;
}

/* ==========================================================================
   USER ORDER STATUS DASHBOARD
   ========================================================================== */

function extractTimeString(o) {
    let seconds = 0;
    if (o.timestamp) {
        if (typeof o.timestamp.seconds === 'number') seconds = o.timestamp.seconds;
        else if (typeof o.timestamp.toDate === 'function') seconds = o.timestamp.toDate().getTime() / 1000;
        else if (o.timestamp instanceof Date) seconds = o.timestamp.getTime() / 1000;
        else if (typeof o.timestamp === 'number') seconds = o.timestamp > 1e11 ? o.timestamp / 1000 : o.timestamp;
    } else if (o._normalizedSeconds) {
        seconds = o._normalizedSeconds;
    }

    if (!seconds || seconds <= 0) {
        return currentLang === 'en' ? 'Recent' : 'Reciente';
    }
    return new Date(seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getOrderElapsedMinutes(order) {
    let seconds = Number.isFinite(order._normalizedSeconds) ? order._normalizedSeconds : 0;
    const timestamp = order.timestamp;
    if (!seconds && timestamp) {
        if (typeof timestamp.seconds === 'number') seconds = timestamp.seconds;
        else if (typeof timestamp.toDate === 'function') seconds = timestamp.toDate().getTime() / 1000;
        else if (timestamp instanceof Date) seconds = timestamp.getTime() / 1000;
        else if (typeof timestamp === 'number') seconds = timestamp > 1e11 ? timestamp / 1000 : timestamp;
    }
    if (seconds <= 0) return null;
    return Math.max(0, Math.floor((Date.now() - seconds * 1000) / 60_000));
}

export function renderUserOrdersDashboard() {
    const container = document.getElementById('my-orders-dashboard');
    if (!container) return;

    // ── PRIVACIDAD ABSOLUTA: solo IDs guardados en este dispositivo ──────────
    // Se eliminan los fallbacks por table/name que filtraban comandas ajenas.
    let deviceOrders = [];
    try {
        const raw = localStorage.getItem('kingDeviceOrders') || localStorage.getItem('kingOrderIds');
        deviceOrders = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(deviceOrders)) deviceOrders = [deviceOrders].filter(Boolean);
    } catch (e) { deviceOrders = []; }

    const myOrdersList = state.orders.filter(o => {
        if (['paid', 'delivered'].includes(normalizeOrderStatus(o.status))) return false;
        // Criterio 1: UID de Firebase autenticado (si el usuario inició sesión)
        if (dbService.currentUser && o.userId && o.userId === dbService.currentUser.uid) return true;
        // Criterio 2: ID guardado en el localStorage de ESTE dispositivo/navegador
        if (deviceOrders.includes(o.id)) return true;
        return false;
    });

    const navBtn = document.getElementById('nav-order-status-btn');
    if (navBtn) {
        if (myOrdersList.length > 0) {
            navBtn.classList.remove('hidden');
            navBtn.classList.add('flex');
        } else {
            navBtn.classList.remove('flex');
            navBtn.classList.add('hidden');
        }
    }

    const latestOrderId = typeof state.lastSubmittedOrderId === 'string'
        ? state.lastSubmittedOrderId
        : '';
    const confirmationHtml = latestOrderId
        ? `<section class="glass-panel p-5 mb-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 text-center" role="status" aria-live="polite">
                <h2 class="text-lg font-serif text-white mb-2">${t('order_confirmation_title')}</h2>
                <p class="text-sm font-mono text-king-gold break-all">${t('order_confirmation_number').replace('{number}', escapeHtml('#' + latestOrderId.toUpperCase()))}</p>
                <p class="text-xs text-gray-300 mt-2">${t('order_confirmation_estimate')}</p>
            </section>`
        : '';

    if (myOrdersList.length === 0) {
        container.innerHTML = `${confirmationHtml}
            <div class="glass-panel p-12 rounded-2xl text-center">
                <div class="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mx-auto mb-4 border border-white/10 text-gray-500">
                    <i class="fa-solid fa-receipt text-2xl"></i>
                </div>
                <h2 class="text-xl font-serif text-white mb-2">${currentLang === 'en' ? 'No active orders' : 'No tiene comandas activas'}</h2>
                <p class="text-xs text-gray-400 mb-6 font-sans">${currentLang === 'en' ? 'Your orders will appear here in real-time as they are prepared.' : 'Sus pedidos aparecerán aquí en tiempo real a medida que son preparados.'}</p>
                <button data-action="set-view" data-view="menu" class="btn-gold px-6 py-3 rounded-xl text-xs uppercase tracking-widest transition-all h-11">
                    ${currentLang === 'en' ? 'Explore Menu' : 'Ver Carta Imperial'}
                </button>
            </div>
        `;
        return;
    }

    container.innerHTML = confirmationHtml + myOrdersList.map(o => {
        const oid = escapeHtml(o.orderId || `#${typeof o.id === 'string' ? o.id.slice(-4).toUpperCase() : '0000'}`);
        const items = Array.isArray(o.items) ? o.items : [];
        const total = typeof o.total === 'number' && isFinite(o.total) ? o.total : 0;
        const status = normalizeOrderStatus(o.status || 'pending');
        const timeStr = extractTimeString(o);
        // ── Nombre y mesa del propietario de la comanda ──────────────────
        const ownerName  = o.customer || (currentLang === 'en' ? 'Guest' : 'Comensal');
        const ownerTable = o.tableId || o.table || '--';

        let pct = 0, idx = 0, msg = currentLang === 'en' ? "Confirming royal order..." : "Confirmando comanda...";
        if (status === 'preparing') {
            pct = 25; idx = 1;
            msg = currentLang === 'en' ? "The chef is selecting fresh ingredients..." : "El chef está seleccionando los ingredientes...";
        } else if (status === 'cooking') {
            pct = 50; idx = 2;
            msg = currentLang === 'en' ? "Cooking in our imperial kitchen..." : "Cocinando al fuego en nuestra cocina imperial...";
        } else if (status === 'ready') {
            pct = 75; idx = 3;
            msg = currentLang === 'en' ? "Ready! The server is on the way to your table..." : "¡Listo! El mesero se dirige a su mesa...";
        } else if (status === 'delivered') {
            pct = 100; idx = 4;
            msg = currentLang === 'en' ? "Delivered. Enjoy your imperial feast!" : "Comanda servida. ¡Disfrute su experiencia imperial!";
        }

        const ac = "bg-king-gold border-king-gold text-black shadow-[0_0_15px_rgba(212,175,55,0.4)]";
        const cc = "bg-king-gold border-king-gold text-black";
        const ic = "bg-king-surface border-white/10 text-gray-500";

        return `
            <div class="glass-panel p-6 md:p-8 rounded-2xl relative overflow-hidden animate-fade-in">
                <div class="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-king-gold to-transparent opacity-60"></div>

                <!-- ── Cabecera de comanda: propietario + mesa ───────────────── -->
                <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center border-b border-white/5 pb-4 mb-6 gap-2">
                    <div>
                        <span class="text-[9px] uppercase tracking-wider text-king-gold font-bold font-sans">${currentLang === 'en' ? 'Royal Order' : 'Comanda Imperial'}</span>
                        <h3 class="text-base font-serif text-white font-bold leading-none mt-1">ID: <span class="font-mono text-king-gold">${oid}</span></h3>
                        <!-- Nombre y mesa del cliente (visibilidad clara para usuarios mayores) -->
                        <div class="flex items-center gap-2 mt-1.5">
                            <span class="inline-flex items-center gap-1 text-[10px] text-gray-300 font-sans">
                                <i class="fa-solid fa-user text-king-gold text-[9px]"></i> ${escapeHtml(ownerName)}
                            </span>
                            <span class="text-gray-600">•</span>
                            <span class="inline-flex items-center gap-1 text-[10px] text-king-gold font-bold font-mono">
                                <i class="fa-solid fa-table-cells text-[9px]"></i> ${currentLang === 'en' ? 'Table' : 'Mesa'} ${escapeHtml(ownerTable)}
                            </span>
                        </div>
                    </div>
                    <div class="flex flex-col sm:text-right font-sans text-xs">
                        <span class="text-gray-400 font-mono">${currentLang === 'en' ? 'Total' : 'Total'}: <span class="text-white font-bold">${formatPrice(total)}</span></span>
                        <span class="text-[9px] text-gray-500 uppercase mt-0.5">${timeStr}</span>
                    </div>
                </div>

                <!-- Progress Steps Bar -->
                <div class="relative flex justify-between items-center mb-8 px-2 md:px-8 mt-4">
                    <div class="absolute top-4 left-0 w-full h-0.5 bg-white/5 -z-10 rounded-full"></div>
                    <div class="absolute top-4 left-0 h-0.5 bg-king-gold -z-10 transition-all duration-1000" style="width:${pct}%"></div>

                    <div class="flex flex-col items-center gap-1.5">
                        <div class="w-8 h-8 rounded-full border flex items-center justify-center transition-all duration-500 z-10 text-[10px] ${idx >= 0 ? (idx === 0 ? ac : cc) : ic}"><i class="fa-solid fa-receipt"></i></div>
                        <span class="text-[8px] uppercase tracking-wider ${idx >= 0 ? 'text-white font-bold' : 'text-gray-500'}">${t('status_rx')}</span>
                    </div>
                    <div class="flex flex-col items-center gap-1.5">
                        <div class="w-8 h-8 rounded-full border flex items-center justify-center transition-all duration-500 z-10 text-[10px] ${idx >= 1 ? (idx === 1 ? ac : cc) : ic}"><i class="fa-solid fa-mortar-pestle"></i></div>
                        <span class="text-[8px] uppercase tracking-wider ${idx >= 1 ? 'text-white font-bold' : 'text-gray-500'}">${t('status_prep')}</span>
                    </div>
                    <div class="flex flex-col items-center gap-1.5">
                        <div class="w-8 h-8 rounded-full border flex items-center justify-center transition-all duration-500 z-10 text-[10px] ${idx >= 2 ? (idx === 2 ? ac : cc) : ic}"><i class="fa-solid fa-fire-burner"></i></div>
                        <span class="text-[8px] uppercase tracking-wider ${idx >= 2 ? 'text-white font-bold' : 'text-gray-500'}">${t('status_cook')}</span>
                    </div>
                    <div class="flex flex-col items-center gap-1.5">
                        <div class="w-8 h-8 rounded-full border flex items-center justify-center transition-all duration-500 z-10 text-[10px] ${idx >= 3 ? (idx === 3 ? ac : cc) : ic}"><i class="fa-solid fa-bell-concierge"></i></div>
                        <span class="text-[8px] uppercase tracking-wider ${idx >= 3 ? 'text-white font-bold' : 'text-gray-500'}">${t('status_rdy')}</span>
                    </div>
                    <div class="flex flex-col items-center gap-1.5">
                        <div class="w-8 h-8 rounded-full border flex items-center justify-center transition-all duration-500 z-10 text-[10px] ${idx >= 4 ? (idx === 4 ? ac : cc) : ic}"><i class="fa-solid fa-utensils"></i></div>
                        <span class="text-[8px] uppercase tracking-wider ${idx >= 4 ? 'text-white font-bold' : 'text-gray-500'}">${t('status_dlv')}</span>
                    </div>
                </div>

                <div class="bg-white/5 rounded-xl p-4 border border-white/5 flex gap-3 items-center mb-4">
                    <div class="w-2 h-2 rounded-full bg-king-gold animate-pulse flex-shrink-0"></div>
                    <p class="text-xs text-gray-300 italic font-serif leading-relaxed">${msg}</p>
                </div>

                <div class="bg-black/35 border border-white/5 rounded-xl p-4 font-sans text-xs">
                    <div class="space-y-1.5">
                        ${items.map(i => {
                            const qty = typeof i.qty === 'number' ? i.qty : 1;
                            const price = typeof i.price === 'number' ? i.price : 0;
                            const name = (currentLang === 'en' && i.nameEn) ? i.nameEn : (i.name || '');
                            return `<div class="flex justify-between items-center text-gray-300"><span class="font-light">${qty}x ${escapeHtml(name)}</span><span class="font-mono text-gray-400">${formatPrice(price * qty)}</span></div>`;
                        }).join('')}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

/* ==========================================================================
   ADMIN KITCHEN MONITOR, CALLS & TELEMETRY
   ========================================================================== */

export function renderAdminOrders() {
    const list = document.getElementById('orders-list');
    if (!list) return;

    const isKitchenRoute = document.getElementById('experience-root')?.classList.contains('kitchen-route');
    const activeOrders = state.orders
        .filter(order => !['paid', 'Finalizado'].includes(normalizeOrderStatus(order.status || 'pending')))
        .filter(order => !isKitchenRoute || ['pending', 'preparing'].includes(normalizeOrderStatus(order.status || 'pending')))
        .sort((left, right) => {
            const leftTime = getOrderDate(left)?.getTime() ?? Number.POSITIVE_INFINITY;
            const rightTime = getOrderDate(right)?.getTime() ?? Number.POSITIVE_INFINITY;
            return leftTime - rightTime
                || String(left.orderId || left.id).localeCompare(String(right.orderId || right.id));
        });
    const countEl = document.getElementById('admin-orders-count');
    if (countEl) countEl.innerText = String(activeOrders.length);

    if (activeOrders.length === 0) {
        list.innerHTML = `<div class="text-center py-8 text-gray-500 text-xs font-sans">${t('kitchen_no_active')}</div>`;
        return;
    }

    const orderStatuses = [
        { key: 'pending', label: currentLang === 'en' ? 'Received' : 'Recibido', color: 'border-yellow-500/40 text-yellow-400 bg-yellow-500/10' },
        { key: 'preparing', label: currentLang === 'en' ? 'Prep' : 'Preparar', color: 'border-blue-500/40 text-blue-400 bg-blue-500/10' },
        { key: 'cooking', label: currentLang === 'en' ? 'Cook' : 'Cocina', color: 'border-purple-500/40 text-purple-400 bg-purple-500/10' },
        { key: 'ready', label: currentLang === 'en' ? 'Ready' : 'Listo', color: 'border-emerald-500/40 text-emerald-400 bg-emerald-500/10' },
        { key: 'delivered', label: currentLang === 'en' ? 'Delivered' : 'Entregado', color: 'border-king-gold/40 text-king-gold bg-king-gold/10' }
    ];
    const nextStatusByStatus = {
        pending: 'preparing',
        preparing: 'cooking',
        cooking: 'ready',
        ready: 'delivered'
    };

    list.innerHTML = activeOrders.map(o => {
        const oid = escapeHtml(o.orderId || `#${typeof o.id === 'string' ? o.id.slice(-4).toUpperCase() : '0000'}`);
        const safeOrderId = escapeHtml(o.id || '');
        const items = Array.isArray(o.items) ? o.items : [];
        const currentStatus = normalizeOrderStatus(o.status || 'pending');
        const timeStr = extractTimeString(o);
        const elapsedMinutes = getOrderElapsedMinutes(o);
        const urgencyClass = elapsedMinutes >= 15
            ? 'kitchen-order-urgent'
            : '';
        const elapsedLabel = elapsedMinutes === null
            ? timeStr
            : `${currentLang === 'en' ? 'Ago' : 'Hace'} ${elapsedMinutes} ${t('kitchen_minutes')}`;

        return `
            <details class="kitchen-order-card ${urgencyClass} bg-white/5 border border-white/10 rounded-xl font-sans hover:border-white/20 transition-all">
                <summary class="flex flex-wrap justify-between items-center gap-3 p-4 cursor-pointer list-none">
                    <div class="min-w-0">
                        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                            <span class="kitchen-ticket-table">${currentLang === 'en' ? 'TABLE' : 'MESA'} ${escapeHtml(o.tableId || o.table || 'S/M')}</span>
                            <span class="kitchen-ticket-id">${escapeHtml(oid)}</span>
                        </div>
                        <p class="text-white text-sm font-bold mt-1">${escapeHtml(o.customer || 'Comensal')}</p>
                    </div>
                    <div class="flex items-center gap-3">
                        <div class="text-right">
                            ${isOwner() ? `<span class="text-king-gold font-mono font-bold text-sm">${formatPrice(o.total || 0)}</span>` : ''}
                            <p class="text-[10px] ${elapsedMinutes >= 15 ? 'text-red-200 font-bold' : 'text-gray-500'} mt-1">${escapeHtml(elapsedLabel)} · ${items.length} ${t('kitchen_items')}</p>
                        </div>
                        <i class="fa-solid fa-chevron-down kitchen-order-chevron" aria-hidden="true"></i>
                    </div>
                </summary>

                <div class="space-y-3 px-4 pb-4">
                    ${o.notes ? `<div class="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2.5 text-xs text-rose-100"><p class="mb-1 text-[9px] font-bold uppercase tracking-wider text-rose-300"><i class="fa-solid fa-note-sticky mr-1"></i>${currentLang === 'en' ? 'Order instructions' : 'Instrucciones del pedido'}</p>${escapeHtml(o.notes)}</div>` : ''}

                    <div class="space-y-2">
                    ${items.map(i => {
                        const qty = typeof i.qty === 'number' ? i.qty : 1;
                        const name = (currentLang === 'en' && i.nameEn) ? i.nameEn : (i.name || '');
                        const allergens = (currentLang === 'en' ? (i.allergensEn || i.allergens) : (i.allergens || i.allergensEn)) || '';
                        return `<div class="rounded-lg border border-white/8 bg-black/25 p-3">
                            <div class="flex items-start justify-between gap-3 text-sm text-gray-200"><span><strong class="mr-2 font-mono text-white">${qty}x</strong>${escapeHtml(name)}</span>${isOwner() ? `<span class="shrink-0 font-mono text-gray-400">${formatPrice((Number(i.price) || 0) * qty)}</span>` : ''}</div>
                            ${i.notes ? `<p class="mt-2 rounded-md border border-rose-400/30 bg-rose-500/10 px-2.5 py-2 text-xs leading-relaxed text-rose-100"><i class="fa-solid fa-pen-to-square mr-1.5 text-rose-300" aria-hidden="true"></i>${escapeHtml(i.notes)}</p>` : ''}
                            <p class="mt-2 text-[10px] leading-relaxed ${allergens ? 'text-amber-200' : 'text-amber-100/60'}"><i class="fa-solid fa-triangle-exclamation mr-1.5" aria-hidden="true"></i>${currentLang === 'en' ? 'Declared allergens:' : 'Alérgenos declarados:'} ${escapeHtml(allergens || (currentLang === 'en' ? 'Not declared' : 'No declarados'))}</p>
                        </div>`;
                    }).join('')}
                    </div>

                    <div class="pt-3 border-t border-white/5 flex flex-wrap gap-2 items-center justify-between">
                        <div class="flex flex-wrap gap-2">
                            ${orderStatuses.map(st => {
                                const isCurrent = currentStatus === st.key;
                                return `
                                    <button data-action="update-order-status" data-order-id="${safeOrderId}" data-status="${escapeHtml(st.key)}"
                                        ${st.key !== nextStatusByStatus[currentStatus] ? 'disabled' : ''}
                                        class="min-h-10 px-3 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all active:scale-95 tactile-target disabled:cursor-not-allowed disabled:opacity-35 ${isCurrent ? st.color + ' ring-1 ring-white/40 font-black' : 'bg-black/40 text-gray-400 border border-white/5 hover:text-white'}">
                                        ${st.label}
                                    </button>
                                `;
                            }).join('')}
                        </div>
                        ${isOwner() && currentStatus === 'delivered' ? `
                            <button data-action="complete-order" data-order-id="${safeOrderId}" class="min-h-10 px-3 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 border border-emerald-500/30 text-[10px] font-bold uppercase tracking-wider transition active:scale-95 flex items-center gap-1.5 tactile-target">
                                <i class="fa-solid fa-cash-register"></i>
                                <span>${currentLang === 'en' ? 'Archive & Charge' : 'Archivar & Cobrar'}</span>
                            </button>
                        ` : ''}
                    </div>
                </div>
            </details>
        `;
    }).join('');
}

export function notifyNewOrders(orders) {
    if (!Array.isArray(orders) || orders.length === 0
        || !state.isAdmin) return;
    const message = orders.length === 1
        ? t('kitchen_new_order_message')
        : t('kitchen_new_orders_message').replace('{count}', String(orders.length));
    showToast(t('kitchen_new_order_title'), message, false, false);
    playSound('bell');
    if (typeof navigator.vibrate === 'function') navigator.vibrate([180, 80, 180]);
}

export async function enableKitchenAlerts() {
    try {
        await initAudioContext();
    } catch (error) {
        console.error('[Kitchen] No se pudo habilitar el audio:', error);
    }
    const audioEnabled = state.audioReady;
    const kitchenRoute = document.getElementById('experience-root')?.classList.contains('kitchen-route');
    const wakeLockEnabled = kitchenRoute ? await requestKitchenWakeLock() : false;
    const message = [
        audioEnabled ? t('kitchen_sound_enabled') : t('kitchen_sound_unavailable'),
        kitchenRoute
            ? (wakeLockEnabled ? t('kitchen_wake_lock_enabled') : t('kitchen_wake_lock_unavailable'))
            : t('kitchen_wake_lock_route_only')
    ].join(' ');
    showToast(t('kitchen_alerts_title'), message, !audioEnabled, false);
}

export function printKitchenOrders() {
    if (!document.getElementById('orders-list')) {
        showToast(t('kitchen_print'), t('kitchen_print_unavailable'), true);
        return;
    }
    const cleanup = () => document.body.classList.remove('kitchen-print');
    document.body.classList.add('kitchen-print');
    window.addEventListener('afterprint', cleanup, { once: true });
    window.print();
}

export async function updateOrderStatus(id, status) {
    try {
        await dbService.updateOrderStatus(id, status);
        showToast('OK', currentLang === 'en' ? `Status updated: ${status}` : `Comanda en estado: ${status}`);
    } catch (e) {
        console.error('[Kitchen] No se pudo cambiar el estado del pedido:', e);
        showToast('Error', e?.message || (currentLang === 'en' ? 'Failed to update order status' : 'Error al actualizar comanda'), true);
    }
}

export async function completeOrder(id) {
    try {
        await dbService.updateOrderStatus(id, 'paid');
        showToast(t('toast_done'), currentLang === 'en' ? 'Order archived and charged.' : 'Comanda cobrada y archivada.');
    } catch (e) {
        console.error('[Kitchen] No se pudo finalizar el pedido:', e);
        showToast('Error', e?.message || (currentLang === 'en' ? 'Failed to finalize order' : 'Error al archivar comanda'), true);
    }
}

function getOrderDate(order) {
    const timestamp = order.timestamp;
    if (timestamp?.toDate) return timestamp.toDate();
    if (timestamp instanceof Date) return timestamp;
    if (typeof timestamp === 'number') return new Date(timestamp > 1e11 ? timestamp : timestamp * 1000);
    if (typeof timestamp?.seconds === 'number') return new Date(timestamp.seconds * 1000);
    if (typeof timestamp === 'string') {
        const parsed = new Date(timestamp);
        if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    if (Number(order._normalizedSeconds) > 0) return new Date(Number(order._normalizedSeconds) * 1000);
    return null;
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

function isCompletedOrder(order) {
    return ['paid', 'delivered'].includes(normalizeOrderStatus(order.status));
}

export function recalcSales() {
    if (!isOwner()) {
        const salesEl = document.getElementById('admin-sales');
        const weekSalesEl = document.getElementById('admin-week-sales');
        const averageTicketEl = document.getElementById('admin-average-ticket');
        const completedCountEl = document.getElementById('admin-completed-count');
        if (salesEl) salesEl.innerText = formatPrice(0);
        if (weekSalesEl) weekSalesEl.innerText = formatPrice(0);
        if (averageTicketEl) averageTicketEl.innerText = formatPrice(0);
        if (completedCountEl) completedCountEl.innerText = '0';
        ['analytics-chart', 'analytics-revenue-chart', 'analytics-status-chart'].forEach(id => {
            document.getElementById(id)?.replaceChildren();
        });
        return;
    }
    const today = new Date();
    const todayKey = today.toDateString();
    const lastReset = Number(state.lastSalesReset || localStorage.getItem('kingLastSalesReset') || 0);
    const completedToday = state.orders.filter(order => {
        const date = getOrderDate(order);
        return date && date.toDateString() === todayKey && isCompletedOrder(order);
    });
    const salesToday = completedToday
        .filter(order => getOrderDate(order).getTime() > lastReset)
        .reduce((sum, order) => sum + (Number(order.total) || 0), 0);
    const lastSevenDays = state.orders.filter(order => {
        const date = getOrderDate(order);
        const daysAgo = date ? (today.setHours(0, 0, 0, 0) - new Date(date).setHours(0, 0, 0, 0)) / 86400000 : Infinity;
        return date && daysAgo >= 0 && daysAgo < 7 && isCompletedOrder(order);
    });
    const weeklySales = lastSevenDays.reduce((sum, order) => sum + (Number(order.total) || 0), 0);

    const salesEl = document.getElementById('admin-sales');
    const weekSalesEl = document.getElementById('admin-week-sales');
    const averageTicketEl = document.getElementById('admin-average-ticket');
    const completedCountEl = document.getElementById('admin-completed-count');
    if (salesEl) salesEl.innerText = formatPrice(salesToday);
    if (weekSalesEl) weekSalesEl.innerText = formatPrice(weeklySales);
    if (averageTicketEl) {
        averageTicketEl.innerText = formatPrice(completedToday.length
            ? completedToday.reduce((sum, order) => sum + (Number(order.total) || 0), 0) / completedToday.length
            : 0);
    }
    if (completedCountEl) completedCountEl.innerText = String(completedToday.length);

    renderPopularItemsChart();
    renderAnalyticsCharts();
}

export function renderPopularItemsChart() {
    const container = document.getElementById('analytics-chart');
    if (!container) return;

    const itemMap = {};
    state.orders.forEach(o => {
        if (isCompletedOrder(o) && Array.isArray(o.items)) {
            o.items.forEach(i => {
                const name = (currentLang === 'en' && i.nameEn) ? i.nameEn : (i.name || 'Platillo');
                itemMap[name] = (itemMap[name] || 0) + Math.max(0, Number(i.qty) || 0);
            });
        }
    });

    const sorted = Object.entries(itemMap).sort((a, b) => b[1] - a[1]).slice(0, 5);

    if (sorted.length === 0) {
        container.innerHTML = `<p class="text-gray-500 text-xs font-light">${currentLang === 'en' ? 'No sales telemetry registered yet.' : 'Sin telemetría de ventas aún.'}</p>`;
        return;
    }

    const maxCount = Math.max(...sorted.map(s => s[1]), 1);

    container.innerHTML = `
        <div class="w-full space-y-2.5 font-sans">
            ${sorted.map(([name, count]) => {
                const pct = Math.round((count / maxCount) * 100);
                return `
                    <div>
                        <div class="flex justify-between text-[11px] mb-1">
                            <span class="text-white truncate max-w-[70%] font-light">${escapeHtml(name)}</span>
                            <span class="text-king-gold font-mono font-bold">${count} ${currentLang === 'en' ? 'sold' : 'vendidos'}</span>
                        </div>
                        <div class="w-full h-1.5 bg-black/40 rounded-full overflow-hidden border border-white/5">
                            <div class="h-full bg-gradient-to-r from-king-goldDark to-king-gold rounded-full transition-all duration-700" style="width: ${pct}%"></div>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function renderAnalyticsCharts() {
    const revenueContainer = document.getElementById('analytics-revenue-chart');
    const statusContainer = document.getElementById('analytics-status-chart');

    if (revenueContainer) {
        const today = new Date();
        const days = Array.from({ length: 7 }, (_, index) => {
            const date = new Date(today);
            date.setHours(0, 0, 0, 0);
            date.setDate(date.getDate() - (6 - index));
            return { date, total: 0 };
        });
        state.orders.forEach(order => {
            if (!isCompletedOrder(order)) return;
            const date = getOrderDate(order);
            if (!date) return;
            const day = days.find(item => item.date.toDateString() === date.toDateString());
            if (day) day.total += Number(order.total) || 0;
        });
        const maxTotal = Math.max(1, ...days.map(day => day.total));
        revenueContainer.innerHTML = `<div class="flex h-40 items-end justify-around gap-2 border-b border-white/10 px-1">
            ${days.map(item => {
                const barHeight = item.total ? Math.max(6, Math.round(item.total / maxTotal * 100)) : 0;
                const label = item.date.toLocaleDateString(currentLang === 'en' ? 'en' : 'es', { weekday: 'short' });
                return `<div class="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-2" title="${escapeHtml(label)}: ${escapeHtml(formatPrice(item.total))}">
                    <span class="truncate text-[8px] text-gray-500">${escapeHtml(formatPrice(item.total))}</span>
                    <div class="w-full max-w-8 rounded-t bg-gradient-to-t from-king-gold/50 to-king-gold" style="height:${barHeight}%;min-height:${item.total ? '4px' : '0'}"></div>
                    <span class="text-[9px] uppercase text-gray-400">${escapeHtml(label)}</span>
                </div>`;
            }).join('')}
        </div>`;
    }

    if (statusContainer) {
        const statuses = ['pending', 'preparing', 'cooking', 'ready', 'delivered', 'paid'];
        const counts = statuses.map(status => ({
            status,
            count: state.orders.filter(order => normalizeOrderStatus(order.status) === status).length
        })).filter(entry => entry.count > 0);
        if (!counts.length) {
            statusContainer.innerHTML = `<p class="py-12 text-center text-xs text-gray-500">${currentLang === 'en' ? 'No orders yet.' : 'Aún no hay pedidos.'}</p>`;
            return;
        }
        const maxCount = Math.max(...counts.map(entry => entry.count));
        statusContainer.innerHTML = `<div class="space-y-3">${counts.map(entry => {
            const label = currentLang === 'en'
                ? ({ pending: 'Received', preparing: 'Preparing', cooking: 'Cooking', ready: 'Ready', delivered: 'Delivered', paid: 'Paid' }[entry.status])
                : ({ pending: 'Recibido', preparing: 'Preparando', cooking: 'Cocina', ready: 'Listo', delivered: 'Entregado', paid: 'Pagado' }[entry.status]);
            return `<div>
                <div class="mb-1 flex justify-between text-[10px]"><span class="text-gray-300">${label}</span><span class="font-mono text-king-gold">${entry.count}</span></div>
                <div class="h-2 overflow-hidden rounded-full bg-black/50"><div class="h-full rounded-full bg-king-gold" style="width:${Math.round(entry.count / maxCount * 100)}%"></div></div>
            </div>`;
        }).join('')}</div>`;
    }
}

export async function resetSales() {
    if (!requireOwner()) return;
    const nowMs = Date.now();
    state.lastSalesReset = nowMs;
    localStorage.setItem('kingLastSalesReset', String(nowMs));

    const salesEl = document.getElementById('admin-sales');
    if (salesEl) salesEl.innerText = formatPrice(0);

    try {
        await dbService.resetSalesConfig();
    } catch (e) {
        console.warn("[Sales] Error guardando reset en Firestore:", e);
    }

    recalcSales();
    renderPopularItemsChart();
    showToast('OK', currentLang === 'en' ? 'Today\'s sales and register successfully closed.' : 'Cierre de caja completado y ventas reiniciadas.');
}

export function renderCalls() {
    const container = document.getElementById('calls-list');
    const badgeCount = document.getElementById('admin-calls-count');
    if (badgeCount) badgeCount.innerText = String(state.calls.length);

    if (!container) return;
    if (!container.dataset.resolveCallHandlerBound) {
        container.addEventListener('click', event => {
            if (!(event.target instanceof Element)) return;
            const button = event.target.closest('[data-resolve-call]');
            if (!button || !container.contains(button)) return;
            resolveCall(button.dataset.callId);
        });
        container.dataset.resolveCallHandlerBound = 'true';
    }

    if (state.calls.length === 0) {
        container.innerHTML = `<div class="col-span-full text-center py-6 text-gray-500 text-xs font-sans">${currentLang === 'en' ? 'No pending assistance calls.' : 'Sin alertas de asistencia pendientes.'}</div>`;
        return;
    }

    container.innerHTML = state.calls.map(c => `
        <div class="bg-blue-600/10 border border-blue-500/20 p-3.5 rounded-xl flex items-center justify-between font-sans">
            <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center text-xs animate-pulse"><i class="fa-solid fa-bell"></i></div>
                <div>
                    <span class="text-white text-xs font-bold font-mono">Mesa ${escapeHtml(c.table || 'S/M')}</span>
                    <p class="text-[9px] text-gray-400">${c.time ? new Date(c.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : (currentLang === 'en' ? 'Just now' : 'Ahora mismo')}</p>
                </div>
            </div>
            <button type="button" data-resolve-call data-call-id="${escapeHtml(c.id)}" class="px-3 py-1.5 rounded-lg bg-blue-500 hover:bg-blue-600 text-white text-[10px] font-bold uppercase transition active:scale-95">
                ${currentLang === 'en' ? 'Attend' : 'Atender'}
            </button>
        </div>
    `).join('');
}

export async function resolveCall(id) {
    try {
        await dbService.resolveWaiterCall(id);
        showToast('OK', currentLang === 'en' ? 'Call attended.' : 'Llamado atendido.');
    } catch (e) {
        console.error('[Calls] Error resolviendo llamado:', e);
    }
}

export async function sendWaiterCall() {
    if (waiterCallPending) return;
    const tableAccess = dbService.getTableQrAccess();
    if (!tableAccess) {
        showToast('Mesa no verificada', currentLang === 'en'
            ? 'Scan the QR code assigned to your table to request assistance.'
            : 'Escanee el código QR asignado a su mesa para solicitar asistencia.', true);
        return;
    }
    const button = document.querySelector('[data-action="send-waiter-call"]');
    const table = tableAccess.table;
    waiterCallPending = true;
    if (button) button.disabled = true;

    try {
        await dbService.createWaiterCall(table);
        closeModal('waiter-modal');
        showToast(t('waiter_title'), t('toast_waiter_ok'));
        playSound('bell');
    } catch (e) {
        console.error('[Calls] No se pudo enviar el llamado:', e);
        showToast('Error', e?.message || (currentLang === 'en' ? 'Failed to call waiter.' : 'Error al llamar al mesero.'), true);
    } finally {
        waiterCallPending = false;
        if (button) button.disabled = false;
    }
}

export async function generateTableQr() {
    if (!requireOwner()) return;
    const input = document.getElementById('admin-qr-table');
    const output = document.getElementById('admin-qr-output');
    const table = input?.value.trim() || '';
    if (!/^[0-9]{1,3}$/.test(table)) {
        showToast('Error', currentLang === 'en'
            ? 'Enter a table number using 1 to 3 digits.'
            : 'Ingrese un número de mesa de 1 a 3 dígitos.', true);
        return;
    }
    try {
        const result = await dbService.generateTableQr(table);
        if (!output) return;
        output.replaceChildren();
        const image = document.createElement('img');
        image.src = result.qrDataUrl;
        image.alt = currentLang === 'en' ? `QR code for table ${table}` : `Código QR para la mesa ${table}`;
        image.className = 'mx-auto w-48 rounded-xl bg-white p-2';
        const link = document.createElement('a');
        link.href = result.url;
        link.textContent = result.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'block break-all text-xs text-cyan-200 underline';
        const copyButton = document.createElement('button');
        copyButton.type = 'button';
        copyButton.dataset.action = 'copy-table-qr';
        copyButton.dataset.qrUrl = result.url;
        copyButton.className = 'mt-2 rounded-lg border border-white/10 px-3 py-2 text-xs text-white hover:bg-white/10';
        copyButton.textContent = currentLang === 'en' ? 'Copy link' : 'Copiar enlace';
        output.append(image, link, copyButton);
        output.classList.remove('hidden');
    } catch (error) {
        console.error('[Table QR] No se pudo generar el código QR:', error);
        showToast('Error', error?.message || (currentLang === 'en'
            ? 'Could not generate the table QR code.'
            : 'No se pudo generar el código QR de la mesa.'), true);
    }
}

function renderStaffList() {
    const list = document.getElementById('staff-list');
    if (!list) return;
    if (!state.employees.length) {
        list.innerHTML = `<p class="text-xs text-gray-400">${t('staff_empty')}</p>`;
        return;
    }
    list.innerHTML = state.employees.map(employee => `
        <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2.5">
            <div class="min-w-0">
                <p class="break-all text-xs font-semibold text-white">${escapeHtml(employee.email || employee.uid)}</p>
                <p class="text-[10px] ${employee.disabled ? 'text-red-300' : 'text-emerald-300'}">${employee.disabled ? t('staff_disabled') : t('staff_active')}</p>
            </div>
            ${employee.disabled ? '' : `<button type="button" data-action="deactivate-staff" data-staff-uid="${escapeHtml(employee.uid)}" data-staff-email="${escapeHtml(employee.email || '')}" class="min-h-10 rounded-lg border border-red-400/30 px-3 text-[10px] font-bold text-red-200">${t('staff_deactivate')}</button>`}
        </div>
    `).join('');
}

function updateStaffPasswordFeedback(input, showEmptyError = false) {
    const valid = input.value.length >= 12 && input.value.length <= 128;
    const invalid = !valid && (input.value.length > 0 || showEmptyError);
    input.classList.toggle('input-error', invalid);
    input.setAttribute('aria-invalid', String(invalid));
    const hint = document.getElementById('staff-password-hint');
    if (hint) {
        hint.textContent = invalid ? t('staff_invalid_password') : '';
        hint.classList.toggle('hidden', !invalid);
    }
    return valid;
}

export async function refreshStaffList() {
    if (!requireOwner()) return;
    const list = document.getElementById('staff-list');
    if (list) list.textContent = t('staff_loading');
    try {
        const result = await dbService.manageStaff('list');
        state.employees = result.employees.filter(employee =>
            employee && typeof employee.uid === 'string'
            && (typeof employee.email === 'string' || employee.email === undefined)
            && typeof employee.disabled === 'boolean'
        );
        renderStaffList();
    } catch (error) {
        console.error('[Staff] No se pudo cargar la lista de empleados:', error);
        if (list) list.textContent = t('staff_load_error');
        showToast(t('staff_title'), error?.message || t('staff_load_error'), true);
    }
}

export async function createStaff() {
    if (!requireOwner()) return;
    const emailInput = document.getElementById('staff-email');
    const passwordInput = document.getElementById('staff-password');
    const email = emailInput?.value.trim().toLowerCase() || '';
    const password = passwordInput?.value || '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showToast(t('staff_title'), t('staff_invalid_email'), true);
        emailInput?.focus();
        return;
    }
    if (!passwordInput || !updateStaffPasswordFeedback(passwordInput, true)) {
        showToast(t('staff_title'), t('staff_invalid_password'), true);
        passwordInput?.focus();
        return;
    }
    try {
        await dbService.manageStaff('create', { email, password });
        if (emailInput) emailInput.value = '';
        if (passwordInput) {
            passwordInput.value = '';
            updateStaffPasswordFeedback(passwordInput);
        }
        showToast(t('staff_title'), t('staff_created'));
        await refreshStaffList();
    } catch (error) {
        console.error('[Staff] No se pudo crear el empleado:', error);
        showToast(t('staff_title'), error?.message || t('staff_create_error'), true);
    }
}

export function deactivateStaff(uid, email) {
    if (!requireOwner() || typeof uid !== 'string' || !uid) return;
    const confirmation = t('staff_deactivate_confirm').replace('{email}', email || uid);
    confirmAction(t('staff_deactivate_title'), confirmation, async () => {
        try {
            await dbService.manageStaff('deactivate', { uid });
            showToast(t('staff_title'), t('staff_deactivated'));
            await refreshStaffList();
        } catch (error) {
            console.error('[Staff] No se pudo desactivar el empleado:', error);
            showToast(t('staff_title'), error?.message || t('staff_deactivate_error'), true);
        }
    });
}

export async function copyTableQrUrl(url) {
    if (typeof url !== 'string' || !url) return;
    try {
        await navigator.clipboard.writeText(url);
        showToast('OK', currentLang === 'en' ? 'QR link copied.' : 'Enlace del QR copiado.');
    } catch (error) {
        console.error('[Table QR] No se pudo copiar el enlace:', error);
        showToast('Error', currentLang === 'en'
            ? 'Could not copy the link. Open it and copy the address manually.'
            : 'No se pudo copiar el enlace. Abra el enlace y copie la dirección manualmente.', true);
    }
}

/* ==========================================================================
   CATEGORIES & PRODUCT MANAGEMENT (ADMIN)
   ========================================================================== */

export function renderCategoriesManage() {
    const list = document.getElementById('categories-manage-list');
    if (!list) return;
    list.replaceChildren();
    if (!isOwner()) return;
    const groupedCategories = new Map();
    const entries = [
        ...state.categories.map(category => typeof category === 'string' ? { name: category } : category),
        ...getAllCategoryNames()
            .filter(name => !state.categories.some(category =>
                String(typeof category === 'string' ? category : category?.name || '').trim().toLocaleLowerCase() === name.toLocaleLowerCase()
            ))
            .map(name => ({ name, id: null }))
    ];
    entries.forEach(item => {
        const key = (item.name || '').trim().toLocaleLowerCase();
        if (!key) return;
        if (!groupedCategories.has(key)) groupedCategories.set(key, []);
        groupedCategories.get(key).push(item);
    });
    const orderedGroups = [...groupedCategories.values()].sort((left, right) => compareCategories(left[0], right[0]));
    orderedGroups.forEach((group, index) => {
        const item = group[0];
        const row = document.createElement('div');
        row.className = 'flex justify-between items-center gap-3 bg-white/5 p-3.5 rounded-lg border border-white/5 font-sans';
        const categoryProduct = state.products.find(product =>
            (product.category || '').trim().toLocaleLowerCase() === (item.name || '').trim().toLocaleLowerCase()
        );
        const previewUrl = group.find(entry => entry.imageUrl)?.imageUrl || categoryProduct?.imageUrl;
        if (previewUrl) {
            const preview = document.createElement('img');
            preview.src = previewUrl;
            preview.alt = '';
            preview.className = 'h-11 w-14 rounded-md object-cover';
            preview.dataset.imageFallback = 'hide';
            row.append(preview);
        }
        const name = document.createElement('span');
        name.className = 'flex-1 text-white text-xs font-bold';
        name.textContent = item.nameEn
            ? `${item.name || ''} / ${item.nameEn}`
            : item.name || '';
        row.append(name);
        const actions = document.createElement('div');
        actions.className = 'flex gap-2';
        const moveUpButton = document.createElement('button');
        moveUpButton.type = 'button';
        moveUpButton.className = 'text-gray-300 hover:text-white w-8 h-8 flex items-center justify-center bg-white/5 rounded-full transition disabled:opacity-30';
        moveUpButton.title = currentLang === 'en' ? 'Move category up' : 'Subir categoría';
        moveUpButton.setAttribute('aria-label', moveUpButton.title);
        moveUpButton.disabled = index === 0;
        moveUpButton.innerHTML = '<i class="fa-solid fa-arrow-up text-xs" aria-hidden="true"></i>';
        moveUpButton.addEventListener('click', () => moveCategory(item.id, -1));
        const moveDownButton = document.createElement('button');
        moveDownButton.type = 'button';
        moveDownButton.className = moveUpButton.className;
        moveDownButton.title = currentLang === 'en' ? 'Move category down' : 'Bajar categoría';
        moveDownButton.setAttribute('aria-label', moveDownButton.title);
        moveDownButton.disabled = index === orderedGroups.length - 1;
        moveDownButton.innerHTML = '<i class="fa-solid fa-arrow-down text-xs" aria-hidden="true"></i>';
        moveDownButton.addEventListener('click', () => moveCategory(item.id, 1));
        const editButton = document.createElement('button');
        editButton.type = 'button';
        editButton.className = 'text-blue-400 hover:text-blue-300 w-8 h-8 flex items-center justify-center bg-blue-500/10 rounded-full transition';
        editButton.title = currentLang === 'en' ? 'Edit category' : 'Editar categoría';
        editButton.innerHTML = '<i class="fa-solid fa-pencil text-xs" aria-hidden="true"></i>';
        editButton.addEventListener('click', () => startEditCategory(item.id, item.name));
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'text-red-400 hover:text-red-300 w-8 h-8 flex items-center justify-center bg-red-500/10 rounded-full transition';
        deleteButton.title = currentLang === 'en' ? 'Delete category' : 'Eliminar categoría';
        deleteButton.innerHTML = '<i class="fa-solid fa-trash text-xs" aria-hidden="true"></i>';
        if (group.some(entry => entry.id)) {
            deleteButton.addEventListener('click', () => confirmAction(
                t('btn_cancel'),
                currentLang === 'en' ? `Delete ${item.name}?` : `¿Borrar ${item.name}?`,
                () => deleteCategory(item.id)
            ));
            actions.append(moveUpButton, moveDownButton, editButton, deleteButton);
        } else {
            actions.append(editButton);
        }
        row.append(actions);
        list.append(row);
    });
}

export async function moveCategory(id, delta) {
    if (!requireOwner()) return;
    const groups = new Map();
    state.categories.forEach(category => {
        const key = (category.name || '').trim().toLocaleLowerCase();
        if (!key) return;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(category);
    });
    const orderedGroups = [...groups.entries()].sort(([, left], [, right]) => compareCategories(left[0], right[0]));
    const currentIndex = orderedGroups.findIndex(([, entries]) => entries.some(category => category.id === id));
    const targetIndex = currentIndex + delta;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= orderedGroups.length) return;
    [orderedGroups[currentIndex], orderedGroups[targetIndex]] = [orderedGroups[targetIndex], orderedGroups[currentIndex]];
    const orderById = {};
    orderedGroups.forEach(([, entries], order) => entries.forEach(category => {
        if (category.id) orderById[category.id] = order;
    }));
    try {
        await dbService.updateCategoryOrder(orderById);
        state.categories = state.categories.map(category => ({ ...category, order: orderById[category.id] ?? category.order }));
        renderCategoriesManage();
        renderCategories();
        renderExperienceCategories();
    } catch (error) {
        console.error('[Admin categories] No se pudo cambiar el orden:', error);
        showToast('Error', error?.message || (currentLang === 'en' ? 'Could not reorder categories.' : 'No se pudo reordenar las categorías.'), true);
    }
}

export function startEditCategory(id, name) {
    if (!requireOwner()) return;
    state.editingCategoryId = id;
    state.editingCategoryOriginalName = name;
    const categoryGroup = state.categories.filter(item => typeof item === 'object'
        && (item.name || '').trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase()
    );
    const category = categoryGroup.find(item => item.id === id) || categoryGroup[0];
    state.editingCategoryIds = categoryGroup.map(item => item.id).filter(Boolean);
    state.editingCategoryOriginalNameEn = category?.nameEn || '';
    resetAdminCategoryImages();
    const urls = [...new Set(categoryGroup.flatMap(item => [
        item.imageUrl,
        ...(Array.isArray(item.imageUrls) ? item.imageUrls : [])
    ]).filter(Boolean))];
    adminCategoryImages = urls.map((url, index) => ({
        id: crypto.randomUUID(),
        url,
        previewUrl: url,
        blob: null,
        isCover: index === 0
    }));
    renderAdminCategoryImages();
    const heading = document.getElementById('category-editor-heading');
    if (heading) heading.textContent = currentLang === 'en' ? `Editing: ${name}` : `Editando: ${name}`;
    const imageUrlInput = document.getElementById('category-image-url');
    if (imageUrlInput) imageUrlInput.value = '';
    const input = document.getElementById('new-cat-name');
    if (input) input.value = name;
    const nameEnInput = document.getElementById('new-cat-name-en');
    if (nameEnInput) nameEnInput.value = state.editingCategoryOriginalNameEn;
    renderAdminCategoryProductChoices();
    document.getElementById('btn-save-cat').innerHTML = '<i class="fa-solid fa-check"></i>';
    document.getElementById('cancel-cat-edit')?.classList.remove('hidden');
    input?.focus();
}

export function cancelCategoryEdit() {
    state.editingCategoryId = null;
    state.editingCategoryIds = [];
    state.editingCategoryOriginalName = null;
    state.editingCategoryOriginalNameEn = null;
    resetAdminCategoryImages();
    const heading = document.getElementById('category-editor-heading');
    if (heading) heading.textContent = currentLang === 'en' ? 'Category images' : 'Imágenes de categoría';
    renderAdminCategoryProductChoices();
    const imageUrlInput = document.getElementById('category-image-url');
    if (imageUrlInput) imageUrlInput.value = '';
    const input = document.getElementById('new-cat-name');
    if (input) input.value = '';
    const nameEnInput = document.getElementById('new-cat-name-en');
    if (nameEnInput) nameEnInput.value = '';
    document.getElementById('btn-save-cat').innerHTML = '<i class="fa-solid fa-plus"></i>';
    document.getElementById('cancel-cat-edit')?.classList.add('hidden');
}

export async function saveCategoryLogic() {
    if (!requireOwner()) return;
    const input = document.getElementById('new-cat-name');
    const name = input?.value.trim();
    const nameEn = document.getElementById('new-cat-name-en')?.value.trim() || '';
    if (!name) {
        showToast('Error', currentLang === 'en' ? 'Enter a category name.' : 'Escriba el nombre de la categoría.', true);
        input?.focus();
        return;
    }
    if (adminCategorySaveInProgress) return;
    const button = document.getElementById('btn-save-cat');
    adminCategorySaveInProgress = true;
    if (button) {
        button.disabled = true;
        button.textContent = currentLang === 'en' ? 'Saving...' : 'Guardando...';
    }

    try {
        const orderedImages = [
            ...adminCategoryImages.filter(image => image.isCover),
            ...adminCategoryImages.filter(image => !image.isCover)
        ];
        const imageUrls = orderedImages.map(image => image.url);
        if (button) button.textContent = currentLang === 'en' ? 'Saving category...' : 'Guardando categoría...';
        const existingCategory = state.categories.find(category => category.id === state.editingCategoryId);
        const order = existingCategory
            ? (Number.isInteger(existingCategory.order) ? existingCategory.order : null)
            : Math.max(-1, ...state.categories.map(category => Number.isInteger(category.order) ? category.order : -1)) + 1;
        const imageData = {
            nameEn,
            imageUrl: imageUrls[0] || '',
            imageUrls,
            ...(order === null ? {} : { order })
        };
        if (state.editingCategoryOriginalName !== null) {
            await withAdminOperationTimeout(
                dbService.updateCategory(
                    state.editingCategoryIds.length ? state.editingCategoryIds : state.editingCategoryId,
                    name,
                    imageData,
                    state.editingCategoryOriginalName,
                    state.editingCategoryOriginalNameEn
                ),
                'El guardado de categoría'
            );
            cancelCategoryEdit();
        } else {
            await withAdminOperationTimeout(dbService.addCategory(name, imageData), 'La creación de categoría');
            if (input) input.value = '';
            const nameEnInput = document.getElementById('new-cat-name-en');
            if (nameEnInput) nameEnInput.value = '';
            resetAdminCategoryImages();
        }
        showToast('OK', t('toast_done'));
    } catch (error) {
        console.error('[Admin categories] No se pudo guardar la categoría:', error);
        showToast('Error', error?.message || (currentLang === 'en' ? 'Failed to save category.' : 'Error guardando categoría.'), true);
    } finally {
        adminCategorySaveInProgress = false;
        if (button) {
            button.disabled = false;
            button.innerHTML = state.editingCategoryId
                ? '<i class="fa-solid fa-check"></i>'
                : '<i class="fa-solid fa-plus"></i>';
        }
    }
}

function resetAdminCategoryImages() {
    adminCategoryImages.forEach(image => {
        if (image.blob && image.previewUrl.startsWith('blob:')) URL.revokeObjectURL(image.previewUrl);
    });
    adminCategoryImages = [];
    renderAdminCategoryImages();
}

function renderAdminCategoryImages() {
    const container = document.getElementById('category-images-container');
    if (!container) return;
    container.replaceChildren();
    adminCategoryImages.forEach(image => {
        const card = document.createElement('article');
        card.className = `admin-image-card${image.isCover ? ' is-cover' : ''}`;
        const coverButton = document.createElement('button');
        coverButton.type = 'button';
        coverButton.className = 'admin-image-cover';
        coverButton.setAttribute('aria-pressed', String(image.isCover));
        const preview = document.createElement('img');
        preview.src = image.previewUrl;
        preview.alt = '';
        preview.loading = 'lazy';
        const label = document.createElement('span');
        label.textContent = image.isCover
            ? (currentLang === 'en' ? 'Cover' : 'Portada')
            : (currentLang === 'en' ? 'Choose cover' : 'Elegir portada');
        coverButton.append(preview, label);
        coverButton.addEventListener('click', () => {
            adminCategoryImages.forEach(candidate => { candidate.isCover = candidate.id === image.id; });
            renderAdminCategoryImages();
        });
        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'admin-image-remove';
        removeButton.setAttribute('aria-label', currentLang === 'en' ? 'Remove image' : 'Eliminar imagen');
        removeButton.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i>';
        removeButton.addEventListener('click', () => {
            if (image.blob && image.previewUrl.startsWith('blob:')) URL.revokeObjectURL(image.previewUrl);
            adminCategoryImages = adminCategoryImages.filter(candidate => candidate.id !== image.id);
            if (image.isCover && adminCategoryImages.length) adminCategoryImages[0].isCover = true;
            renderAdminCategoryImages();
        });
        card.append(coverButton, removeButton);
        container.append(card);
    });
}

function renderAdminCategoryProductChoices() {
    const container = document.getElementById('category-product-image-list');
    const section = document.getElementById('category-product-image-options');
    if (!container || !section) return;
    container.replaceChildren();
    const categoryName = state.editingCategoryOriginalName;
    if (!categoryName) {
        section.hidden = true;
        return;
    }
    const choices = state.products.flatMap(product => {
        if ((product.category || '').trim().toLocaleLowerCase() !== categoryName.trim().toLocaleLowerCase()) return [];
        const urls = [...new Set([
            product.imageUrl,
            ...(Array.isArray(product.imageUrls) ? product.imageUrls.map(image => getProductImageData(image)?.cropped) : [])
        ].filter(Boolean))];
        return urls.map(url => ({ url, name: product.name || categoryName }));
    });
    section.hidden = choices.length === 0;
    choices.forEach(choice => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'category-product-image-option';
        button.title = currentLang === 'en'
            ? `Use ${choice.name} photo as category cover`
            : `Usar foto de ${choice.name} como portada`;
        const image = document.createElement('img');
        image.src = choice.url;
        image.alt = '';
        image.loading = 'lazy';
        const label = document.createElement('span');
        label.textContent = currentLang === 'en' ? `Use ${choice.name}` : `Usar ${choice.name}`;
        button.append(image, label);
        button.addEventListener('click', () => addCategoryProductImage(choice.url));
        container.append(button);
    });
}

function addCategoryProductImage(url) {
    let image = adminCategoryImages.find(candidate => candidate.url === url);
    if (!image) {
        image = { id: crypto.randomUUID(), url, previewUrl: url, blob: null, isCover: false };
        adminCategoryImages.push(image);
    }
    adminCategoryImages.forEach(candidate => { candidate.isCover = candidate.id === image.id; });
    renderAdminCategoryImages();
}

export function addCategoryImageUrl() {
    if (!requireOwner()) return;
    const input = document.getElementById('category-image-url');
    const value = input?.value.trim() || '';
    let url;
    try {
        url = new URL(value);
    } catch {
        showToast('Error', currentLang === 'en' ? 'Enter a valid image URL.' : 'Ingrese una URL de imagen válida.', true);
        return;
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
        showToast('Error', currentLang === 'en' ? 'Image URLs must use HTTP or HTTPS.' : 'La URL debe usar HTTP o HTTPS.', true);
        return;
    }
    adminCategoryImages.push({ id: crypto.randomUUID(), url: value, previewUrl: value, blob: null, isCover: adminCategoryImages.length === 0 });
    input.value = '';
    renderAdminCategoryImages();
}

export function triggerCategoryImageUpload() {
    if (!requireOwner()) return;
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/jpeg,image/png,image/webp';
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            showToast('Error', currentLang === 'en' ? 'Select an image file.' : 'Seleccione un archivo de imagen.', true);
            return;
        }
        try {
            const dataUrl = await readImageAsDataUrl(file);
            adminCategoryImages.push({
                id: crypto.randomUUID(),
                url: dataUrl,
                previewUrl: dataUrl,
                blob: null,
                isCover: adminCategoryImages.length === 0
            });
            renderAdminCategoryImages();
        } catch (error) {
            console.error('[Admin categories] No se pudo convertir la imagen:', error);
            showToast('Error', error?.message || (currentLang === 'en'
                ? 'Could not read the selected image.'
                : 'No se pudo leer la imagen seleccionada.'), true);
        }
    }, { once: true });
    fileInput.click();
}

export async function deleteCategory(id) {
    if (!requireOwner()) return;
    try {
        const category = state.categories.find(item => item.id === id);
        const productUsesCategory = state.products.some(product =>
            [product.category, product.categoryEn].some(name =>
                name && [category?.name, category?.nameEn].some(categoryName =>
                    categoryName && name.trim().toLocaleLowerCase() === categoryName.trim().toLocaleLowerCase()
                )
            )
        );
        if (productUsesCategory) {
            showToast('Error', currentLang === 'en'
                ? 'Reassign or remove this category from its dishes before deleting it.'
                : 'Reasigne o quite esta categoría de sus platillos antes de eliminarla.', true);
            return;
        }
        const duplicateIds = category
            ? state.categories
                .filter(item => item.name?.trim().toLocaleLowerCase() === category.name?.trim().toLocaleLowerCase())
                .map(item => item.id)
                .filter(Boolean)
            : [id];
        await dbService.deleteCategory(duplicateIds);
        showToast('OK', t('toast_done'));
    } catch (e) {
        showToast('Error', 'Error eliminando categoría', true);
    }
}

export function newProduct() {
    if (!requireOwner()) return;
    document.getElementById('prod-id').value = '';
    document.getElementById('prod-name').value = '';
    document.getElementById('prod-name-en').value = '';
    document.getElementById('prod-price').value = '';
    document.getElementById('prod-desc').value = '';
    document.getElementById('prod-desc-en').value = '';
    renderProductCategoryOptions(state.categories[0]?.name || getAllCategoryNames()[0] || 'Entradas');
    document.getElementById('prod-ing').value = '';
    document.getElementById('prod-ing-en').value = '';
    document.getElementById('prod-allergens').value = 'No declarado';
    document.getElementById('prod-allergens-en').value = 'Not declared';
    document.getElementById('product-model3d-url').value = '';
    document.getElementById('prod-discount-type').value = 'none';
    document.getElementById('prod-discount-value').value = 0;
    document.getElementById('prod-discount-value').disabled = true;
    document.getElementById('prod-availability').value = 'true';

    resetAdminImages();
    const urlInput = document.getElementById('admin-image-url-input');
    if (urlInput) urlInput.value = '';
    openModal('product-modal');
}

export function editProduct(id) {
    if (!requireOwner()) return;
    const p = state.products.find(x => x.id === id);
    if (!p) return;

    document.getElementById('prod-id').value = id;
    document.getElementById('prod-name').value = p.name || '';
    document.getElementById('prod-name-en').value = p.nameEn || '';
    document.getElementById('prod-price').value = p.price || 0;
    document.getElementById('prod-desc').value = p.description || '';
    document.getElementById('prod-desc-en').value = p.descriptionEn || '';
    renderProductCategoryOptions(p.category || 'Entradas');
    document.getElementById('prod-ing').value = p.ingredients || '';
    document.getElementById('prod-ing-en').value = p.ingredientsEn || '';
    document.getElementById('prod-allergens').value = p.allergens || 'No declarado';
    document.getElementById('prod-allergens-en').value = p.allergensEn || 'Not declared';
    document.getElementById('product-model3d-url').value = p.model3dUrl || '';
    document.getElementById('prod-discount-type').value = p.discountType || 'none';
    document.getElementById('prod-discount-value').value = p.discountValue || 0;
    document.getElementById('prod-discount-value').disabled = !['percent', 'price'].includes(p.discountType);
    document.getElementById('prod-availability').value = String(p.available !== false);

    resetAdminImages();
    const productImages = (Array.isArray(p.imageUrls) ? p.imageUrls : [])
        .map(getProductImageData)
        .filter(Boolean);
    const coverImage = getProductImageData(p.imageUrl);
    const imageData = [...productImages];
    if (coverImage && !imageData.some(image => image.cropped === coverImage.cropped)) {
        imageData.unshift(coverImage);
    }
    adminImages = imageData.map((image, index) => ({
        id: crypto.randomUUID(),
        original: image.original,
        url: image.cropped,
        cropUrl: image.largestUrl,
        srcset: image.srcset,
        width: image.width,
        height: image.height,
        previewUrl: image.cropped,
        blob: null,
        isCover: index === 0
    }));
    renderAdminImageGallery();
    const urlInput = document.getElementById('admin-image-url-input');
    if (urlInput) urlInput.value = '';
    openModal('product-modal');
}

function resetAdminImages() {
    adminImageLoadController?.abort();
    adminImageLoadController = null;
    if (adminImageCrop?.sourceObjectUrl) URL.revokeObjectURL(adminImageCrop.sourceObjectUrl);
    adminImageCrop = null;
    document.getElementById('admin-image-cropper')?.setAttribute('hidden', '');
    adminImages.forEach(image => {
        if (image.blob && image.previewUrl.startsWith('blob:')) URL.revokeObjectURL(image.previewUrl);
    });
    adminImages = [];
    renderAdminImageGallery();
}

function renderAdminImageGallery() {
    const cont = document.getElementById('admin-images-container');
    if (!cont) return;
    cont.replaceChildren();
    adminImages.forEach(image => {
        const item = document.createElement('article');
        item.className = `admin-image-card${image.isCover ? ' is-cover' : ''}`;

        const coverButton = document.createElement('button');
        coverButton.type = 'button';
        coverButton.className = 'admin-image-cover';
        coverButton.setAttribute('aria-pressed', String(image.isCover));
        coverButton.setAttribute('aria-label', image.isCover ? 'Imagen de portada seleccionada' : 'Seleccionar como portada');
        const preview = document.createElement('img');
        preview.src = image.previewUrl;
        preview.alt = '';
        preview.loading = 'lazy';
        coverButton.append(preview);
        const coverLabel = document.createElement('span');
        coverLabel.textContent = image.isCover ? 'Portada' : 'Elegir portada';
        coverButton.append(coverLabel);
        coverButton.addEventListener('click', () => {
            adminImages.forEach(candidate => { candidate.isCover = candidate.id === image.id; });
            renderAdminImageGallery();
        });

        const editButton = document.createElement('button');
        editButton.type = 'button';
        editButton.className = 'admin-image-edit absolute left-1 top-1 z-10 flex h-7 w-7 items-center justify-center rounded-full border border-white/30 bg-black/70 text-white transition hover:bg-king-gold hover:text-black';
        editButton.setAttribute('aria-label', currentLang === 'en' ? 'Edit current crop' : 'Editar recorte actual');
        editButton.title = currentLang === 'en' ? 'Edit current crop' : 'Editar recorte actual';
        editButton.innerHTML = '<i class="fa-solid fa-crop-simple" aria-hidden="true"></i>';
        editButton.addEventListener('click', () => editAdminImage(image.id));

        const restoreButton = document.createElement('button');
        restoreButton.type = 'button';
        restoreButton.className = 'admin-image-restore absolute left-10 top-1 z-10 flex h-7 w-7 items-center justify-center rounded-full border border-white/30 bg-black/70 text-white transition hover:bg-king-gold hover:text-black';
        restoreButton.setAttribute('aria-label', currentLang === 'en' ? 'Restore original image' : 'Restaurar imagen original');
        restoreButton.title = currentLang === 'en' ? 'Restore original image' : 'Restaurar imagen original';
        restoreButton.innerHTML = '<i class="fa-solid fa-rotate-left" aria-hidden="true"></i>';
        restoreButton.addEventListener('click', () => restoreAdminImage(image.id));

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'admin-image-remove';
        removeButton.setAttribute('aria-label', 'Eliminar imagen');
        removeButton.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i>';
        removeButton.addEventListener('click', () => {
            if (image.blob && image.previewUrl.startsWith('blob:')) URL.revokeObjectURL(image.previewUrl);
            adminImages = adminImages.filter(candidate => candidate.id !== image.id);
            if (image.isCover && adminImages.length) adminImages[0].isCover = true;
            renderAdminImageGallery();
        });

        item.append(coverButton, editButton, restoreButton, removeButton);
        cont.append(item);
    });
}

async function beginAdminImageCrop(source, sourceObjectUrl = '', editingImageId = null, original = source) {
    const cropper = document.getElementById('admin-image-cropper');
    const image = document.getElementById('admin-image-cropper-image');
    const stage = document.getElementById('admin-image-cropper-stage');
    if (!cropper || !image || !stage) throw new Error('No se encontró el recortador de imágenes.');

    adminImageLoadController?.abort();
    adminImageLoadController = new AbortController();
    if (adminImageCrop?.sourceObjectUrl) URL.revokeObjectURL(adminImageCrop.sourceObjectUrl);
    adminImageCrop = { source, sourceObjectUrl, editingImageId, original, image, stage, zoom: 1, rotation: 0, offsetX: 0, offsetY: 0, pointerX: 0, pointerY: 0 };
    document.getElementById('admin-image-zoom').value = '1';
    document.getElementById('admin-image-rotation').value = '0';
    document.getElementById('admin-image-rotation-value').textContent = '0°';
    cropper.hidden = false;
    image.addEventListener('load', () => configureAdminImageCrop(), { once: true, signal: adminImageLoadController.signal });
    image.addEventListener('error', () => {
        cancelAdminImageCrop();
        showToast('Error', currentLang === 'en'
            ? 'The image could not be loaded. Check the URL and its CORS settings.'
            : 'No se pudo cargar la imagen. Verifique la URL y los permisos CORS.', true);
    }, { once: true, signal: adminImageLoadController.signal });
    if (/^https?:/i.test(source)) image.crossOrigin = 'anonymous';
    else image.removeAttribute('crossorigin');
    image.src = source;
}

async function editAdminImage(imageId) {
    const image = adminImages.find(candidate => candidate.id === imageId);
    if (!image) return;
    try {
        const original = image.cropUrl || image.original || image.url;
        await beginAdminImageCrop(original, '', image.id, original);
    } catch (error) {
        console.error('[Admin images] No se pudo abrir la imagen para editar:', error);
        showToast('Error', currentLang === 'en'
            ? 'Could not open this image for editing.'
            : 'No se pudo abrir esta imagen para editar.', true);
    }
}

async function restoreAdminImage(imageId) {
    const image = adminImages.find(candidate => candidate.id === imageId);
    if (!image) return;
    try {
        const original = image.original || image.url;
        await beginAdminImageCrop(original, '', image.id, original);
    } catch (error) {
        console.error('[Admin images] No se pudo restaurar la imagen original:', error);
        showToast('Error', currentLang === 'en'
            ? 'Could not restore the original image.'
            : 'No se pudo restaurar la imagen original.', true);
    }
}

function configureAdminImageCrop(preserveCenter = false) {
    if (!adminImageCrop) return;
    const { image, stage, rotation } = adminImageCrop;
    const stageWidth = stage.clientWidth;
    const stageHeight = stage.clientHeight;
    const centerX = preserveCenter && adminImageCrop.rotatedWidth
        ? adminImageCrop.offsetX + adminImageCrop.rotatedWidth * adminImageCrop.zoom / 2
        : stageWidth / 2;
    const centerY = preserveCenter && adminImageCrop.rotatedHeight
        ? adminImageCrop.offsetY + adminImageCrop.rotatedHeight * adminImageCrop.zoom / 2
        : stageHeight / 2;
    const radians = rotation * Math.PI / 180;
    const cosine = Math.abs(Math.cos(radians));
    const sine = Math.abs(Math.sin(radians));
    const rotatedWidth = image.naturalWidth * cosine + image.naturalHeight * sine;
    const rotatedHeight = image.naturalWidth * sine + image.naturalHeight * cosine;
    adminImageCrop.baseScale = Math.max(stageWidth / rotatedWidth, stageHeight / rotatedHeight);
    adminImageCrop.baseWidth = image.naturalWidth * adminImageCrop.baseScale;
    adminImageCrop.baseHeight = image.naturalHeight * adminImageCrop.baseScale;
    adminImageCrop.rotatedWidth = rotatedWidth * adminImageCrop.baseScale;
    adminImageCrop.rotatedHeight = rotatedHeight * adminImageCrop.baseScale;
    image.style.width = `${adminImageCrop.baseWidth}px`;
    image.style.height = `${adminImageCrop.baseHeight}px`;
    adminImageCrop.offsetX = centerX - adminImageCrop.rotatedWidth * adminImageCrop.zoom / 2;
    adminImageCrop.offsetY = centerY - adminImageCrop.rotatedHeight * adminImageCrop.zoom / 2;
    updateAdminImageCropTransform();
}

function updateAdminImageCropTransform() {
    if (!adminImageCrop?.baseScale) return;
    const { image, stage, rotatedWidth, rotatedHeight, zoom, rotation } = adminImageCrop;
    const minX = stage.clientWidth - rotatedWidth * zoom;
    const minY = stage.clientHeight - rotatedHeight * zoom;
    adminImageCrop.offsetX = Math.max(minX, Math.min(0, adminImageCrop.offsetX));
    adminImageCrop.offsetY = Math.max(minY, Math.min(0, adminImageCrop.offsetY));
    image.style.left = `${adminImageCrop.offsetX + rotatedWidth * zoom / 2}px`;
    image.style.top = `${adminImageCrop.offsetY + rotatedHeight * zoom / 2}px`;
    image.style.transform = `translate(-50%, -50%) rotate(${rotation}deg) scale(${zoom})`;
    const zoomInput = document.getElementById('admin-image-zoom');
    if (zoomInput) zoomInput.value = String(zoom);
}

export function updateAdminImageCropZoom(value) {
    if (!adminImageCrop) return;
    adminImageCrop.zoom = Math.min(3, Math.max(1, Number(value) || 1));
    updateAdminImageCropTransform();
}

export function updateAdminImageCropRotation(value) {
    if (!adminImageCrop) return;
    adminImageCrop.rotation = Math.min(180, Math.max(-180, Number(value) || 0));
    configureAdminImageCrop(true);
    const rotationInput = document.getElementById('admin-image-rotation');
    if (rotationInput) rotationInput.value = String(adminImageCrop.rotation);
    const rotationOutput = document.getElementById('admin-image-rotation-value');
    if (rotationOutput) rotationOutput.textContent = `${adminImageCrop.rotation}°`;
}

export function resetAdminImageCrop() {
    if (!adminImageCrop) return;
    adminImageCrop.zoom = 1;
    adminImageCrop.rotation = 0;
    adminImageCrop.offsetX = 0;
    adminImageCrop.offsetY = 0;
    const zoomInput = document.getElementById('admin-image-zoom');
    if (zoomInput) zoomInput.value = '1';
    const rotationInput = document.getElementById('admin-image-rotation');
    if (rotationInput) rotationInput.value = '0';
    const rotationOutput = document.getElementById('admin-image-rotation-value');
    if (rotationOutput) rotationOutput.textContent = '0°';
    configureAdminImageCrop();
}

export function startAdminImageCropPan(event) {
    if (!adminImageCrop || event.target.closest('input, button')) return;
    event.preventDefault();
    adminImageCrop.pointerX = event.clientX;
    adminImageCrop.pointerY = event.clientY;
    adminImageCrop.stage.setPointerCapture(event.pointerId);
}

export function moveAdminImageCropPan(event) {
    if (!adminImageCrop?.stage.hasPointerCapture(event.pointerId)) return;
    adminImageCrop.offsetX += event.clientX - adminImageCrop.pointerX;
    adminImageCrop.offsetY += event.clientY - adminImageCrop.pointerY;
    adminImageCrop.pointerX = event.clientX;
    adminImageCrop.pointerY = event.clientY;
    updateAdminImageCropTransform();
}

export async function applyAdminImageCrop() {
    if (!adminImageCrop?.baseScale) return;
    const crop = adminImageCrop;
    const canvas = document.createElement('canvas');
    canvas.width = 1600;
    canvas.height = 1200;
    const context = canvas.getContext('2d');
    if (!context) {
        showToast('Error', currentLang === 'en' ? 'Could not crop this image.' : 'No se pudo recortar esta imagen.', true);
        return;
    }
    const stageWidth = crop.stage.clientWidth;
    const stageHeight = crop.stage.clientHeight;

    try {
        context.scale(canvas.width / stageWidth, canvas.height / stageHeight);
        context.translate(
            crop.offsetX + crop.rotatedWidth * crop.zoom / 2,
            crop.offsetY + crop.rotatedHeight * crop.zoom / 2
        );
        context.rotate(crop.rotation * Math.PI / 180);
        context.scale(crop.baseScale * crop.zoom, crop.baseScale * crop.zoom);
        context.drawImage(crop.image, -crop.image.naturalWidth / 2, -crop.image.naturalHeight / 2);
        const dataUrl = canvas.toDataURL('image/webp', 0.82);
        if (crop.editingImageId) {
            const existingImage = adminImages.find(image => image.id === crop.editingImageId);
            if (!existingImage) throw new Error('La imagen seleccionada ya no está en la galería.');
            if (existingImage.blob && existingImage.previewUrl.startsWith('blob:')) {
                URL.revokeObjectURL(existingImage.previewUrl);
            }
            existingImage.original = '';
            existingImage.url = dataUrl;
            existingImage.cropUrl = dataUrl;
            existingImage.srcset = '';
            existingImage.width = 1600;
            existingImage.height = 1200;
            existingImage.previewUrl = dataUrl;
            existingImage.blob = null;
        } else {
            adminImages.push({ id: crypto.randomUUID(), original: '', url: dataUrl, cropUrl: dataUrl, srcset: '', width: 1600, height: 1200, previewUrl: dataUrl, blob: null, isCover: adminImages.length === 0 });
        }
        const urlInput = document.getElementById('admin-image-url-input');
        if (urlInput?.value.trim() === crop.source) urlInput.value = '';
        cancelAdminImageCrop();
        renderAdminImageGallery();
    } catch (error) {
        console.error('[Admin images] No se pudo recortar la imagen:', error);
        showToast('Error', currentLang === 'en'
            ? 'Could not crop this image. For external URLs, the server must allow CORS.'
            : 'No se pudo recortar la imagen. Para URLs externas, el servidor debe permitir CORS.', true);
    }
}

export function cancelAdminImageCrop() {
    adminImageLoadController?.abort();
    adminImageLoadController = null;
    if (adminImageCrop?.sourceObjectUrl) URL.revokeObjectURL(adminImageCrop.sourceObjectUrl);
    const cropper = document.getElementById('admin-image-cropper');
    const image = document.getElementById('admin-image-cropper-image');
    if (cropper) cropper.hidden = true;
    if (image) {
        image.removeAttribute('src');
        image.style.transform = '';
        image.style.width = '';
        image.style.height = '';
    }
    adminImageCrop = null;
}

export async function addAdminImageInput(url = '') {
    if (!requireOwner()) return;
    const urlInput = document.getElementById('admin-image-url-input');
    const imageUrl = String(url || urlInput?.value || '').trim();
    if (!imageUrl) {
        urlInput?.focus();
        return;
    }
    let parsedUrl;
    try {
        parsedUrl = new URL(imageUrl);
    } catch {
        showToast('Error', currentLang === 'en' ? 'Enter a valid image URL.' : 'Ingrese una URL de imagen válida.', true);
        return;
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        showToast('Error', currentLang === 'en' ? 'Image URLs must use HTTP or HTTPS.' : 'La URL de imagen debe usar HTTP o HTTPS.', true);
        return;
    }
    if (urlInput) urlInput.value = imageUrl;
    await beginAdminImageCrop(imageUrl);
}

export function triggerAdminImageUpload() {
    if (!requireOwner()) return;
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
            showToast('Error', currentLang === 'en'
                ? 'Select a JPEG, PNG or WebP image under 10 MB.'
                : 'Seleccione una imagen JPEG, PNG o WebP de menos de 10 MB.', true);
            return;
        }
        try {
            const original = await readImageAsDataUrl(file);
            await beginAdminImageCrop(original, '', null, original);
        } catch (error) {
            console.error('[Admin images] No se pudo abrir la imagen seleccionada:', error);
            showToast('Error', error?.message || (currentLang === 'en'
                ? 'Could not open the selected image.'
                : 'No se pudo abrir la imagen seleccionada.'), true);
        }
    }, { once: true });
    fileInput.click();
}

export async function saveProduct() {
    if (!requireOwner()) return;
    if (adminSaveInProgress) return;
    const id = document.getElementById('prod-id')?.value;
    const name = document.getElementById('prod-name')?.value.trim();
    const nameEn = document.getElementById('prod-name-en')?.value.trim();
    const price = Number(document.getElementById('prod-price')?.value);
    const desc = document.getElementById('prod-desc')?.value.trim();
    const descEn = document.getElementById('prod-desc-en')?.value.trim();
    const cat = document.getElementById('prod-cat')?.value.trim() || 'Entradas';
    const ing = document.getElementById('prod-ing')?.value.trim();
    const ingEn = document.getElementById('prod-ing-en')?.value.trim();
    const allergens = document.getElementById('prod-allergens')?.value.trim();
    const allergensEn = document.getElementById('prod-allergens-en')?.value.trim();
    const model3dUrl = document.getElementById('product-model3d-url')?.value.trim();
    const discountType = document.getElementById('prod-discount-type')?.value || 'none';
    const discountValue = Number(document.getElementById('prod-discount-value')?.value || 0);
    const available = document.getElementById('prod-availability')?.value !== 'false';

    if (!document.getElementById('admin-image-cropper')?.hidden) {
        showToast('Imagen', currentLang === 'en'
            ? 'Apply or cancel the current image crop before saving.'
            : 'Aplique o cancele el recorte de imagen antes de guardar.', true);
        return;
    }

    if (!name || !Number.isFinite(price) || price < 0) {
        showToast('Error', t('toast_incomplete'), true);
        return;
    }
    if (!allergens) {
        document.getElementById('prod-allergens')?.focus();
        showToast('Error', currentLang === 'en'
            ? 'Declare the dish allergens or enter "Not declared".'
            : 'Declare los alérgenos del platillo o escriba "No declarado".', true);
        return;
    }
    if (!['none', 'percent', 'price'].includes(discountType)) {
        showToast('Error', currentLang === 'en' ? 'Select a valid discount type.' : 'Seleccione un tipo de descuento válido.', true);
        return;
    }
    if (discountType === 'percent' && (!Number.isFinite(discountValue) || discountValue <= 0 || discountValue >= 100)) {
        showToast('Error', currentLang === 'en' ? 'Enter a discount between 1% and 99%.' : 'Ingrese un descuento entre 1% y 99%.', true);
        return;
    }
    if (discountType === 'price' && (!Number.isFinite(discountValue) || discountValue <= 0 || discountValue >= price)) {
        showToast('Error', currentLang === 'en' ? 'The sale price must be above zero and below the regular price.' : 'El precio rebajado debe ser mayor que cero y menor que el precio regular.', true);
        return;
    }

    const saveButton = document.getElementById('product-modal-save');
    const originalSaveButtonContent = saveButton?.innerHTML;
    adminSaveInProgress = true;
    if (saveButton) {
        saveButton.disabled = true;
        saveButton.textContent = currentLang === 'en' ? 'Saving...' : 'Guardando...';
    }

    try {
        const orderedImages = [
            ...adminImages.filter(image => image.isCover),
            ...adminImages.filter(image => !image.isCover)
        ];
        const productId = id || crypto.randomUUID();
        const imageUrls = await uploadAdminImages(productId, orderedImages, saveButton);
        if (saveButton) saveButton.textContent = currentLang === 'en' ? 'Saving dish...' : 'Guardando platillo...';
        const fallbackImage = 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=800';
        const imageUrl = imageUrls[0]?.url || fallbackImage;
        const payload = {
            name,
            nameEn,
            price,
            description: desc,
            descriptionEn: descEn,
            category: cat,
            ingredients: ing,
            ingredientsEn: ingEn,
            allergens,
            allergensEn,
            imageUrl,
            imageUrls: imageUrls.length > 0 ? imageUrls : [imageUrl],
            model3dUrl,
            discountType,
            discountValue: discountType === 'none' ? 0 : discountValue,
            available
        };

        if (id) {
            await withAdminOperationTimeout(dbService.updateProduct(id, payload), 'El guardado del platillo');
        } else {
            await withAdminOperationTimeout(dbService.addProduct(payload, productId), 'La creación del platillo');
        }
        resetAdminImages();
        closeModal('product-modal');
        showToast('OK', t('toast_done'));
    } catch (error) {
        console.error('[Admin products] No se pudo guardar el platillo:', error);
        const reason = error?.message || error?.code || '';
        const message = currentLang === 'en' ? 'Failed to save product.' : 'Error al guardar platillo.';
        showToast('Error', reason ? `${message} ${reason}` : message, true);
    } finally {
        adminSaveInProgress = false;
        if (saveButton) {
            saveButton.disabled = false;
            if (originalSaveButtonContent) saveButton.innerHTML = originalSaveButtonContent;
        }
    }
}

export async function deleteProduct(id) {
    if (!requireOwner()) return;
    try {
        await dbService.deleteProduct(id);
        showToast('OK', t('toast_done'));
    } catch (e) {
        showToast('Error', t('toast_delete_err'), true);
    }
}

export function generateAI() {
    const name = document.getElementById('prod-name')?.value.trim();
    if (!name) {
        showToast(currentLang === 'en' ? 'Description template' : 'Plantilla de descripción', currentLang === 'en' ? 'Enter a dish name first.' : 'Ingrese primero el nombre del platillo.', true);
        return;
    }

    const esDesc = `Magistral creación de autor elaborada a partir de ${name}, cocida con técnicas de alta gastronomía caribeña y decorada con toques florales y aromáticos de nuestra huerta imperial.`;
    const enDesc = `Authorial culinary creation featuring fresh ${name}, prepared with Caribbean haute cuisine techniques and finished with aromatic herbs from our imperial pantry.`;

    document.getElementById('prod-desc').value = esDesc;
    document.getElementById('prod-desc-en').value = enDesc;

    if (!document.getElementById('prod-name-en')?.value.trim()) {
        document.getElementById('prod-name-en').value = 'Imperial ' + name;
    }

    showToast(currentLang === 'en' ? 'Description template' : 'Plantilla de descripción', currentLang === 'en' ? 'Template filled in English and Spanish; review it before saving.' : 'Plantilla completada en español e inglés; revísela antes de guardar.');
}

/* ==========================================================================
   REVIEWS & RATINGS
   ========================================================================== */

export function setRatingValue(val) {
    if (!Number.isInteger(val) || val < 1 || val > 5) return;
    state.selectedRatingValue = val;
    const buttons = document.querySelectorAll('#star-selector .star-btn');
    buttons.forEach((btn, idx) => {
        btn.setAttribute('aria-pressed', String(idx + 1 === val));
        btn.setAttribute('aria-pressed', String(idx < val));
        if (idx < val) {
            btn.classList.add('text-king-gold');
            btn.classList.remove('text-gray-600');
        } else {
            btn.classList.remove('text-king-gold');
            btn.classList.add('text-gray-600');
        }
    });
}

export function resetStarSelector() {
    state.selectedRatingValue = 0;
    const buttons = document.querySelectorAll('#star-selector .star-btn');
    buttons.forEach(btn => {
        btn.setAttribute('aria-pressed', 'false');
        btn.classList.remove('text-king-gold');
        btn.classList.add('text-gray-600');
    });
    const commentInput = document.getElementById('review-comment-input');
    if (commentInput) commentInput.value = '';
}

export function renderProductReviews(productId) {
    const container = document.getElementById('modal-reviews-list');
    const countEl = document.getElementById('modal-reviews-count');
    const ratingAverage = document.getElementById('modal-rating-avg');
    const ratingStars = document.getElementById('modal-rating-stars');
    const ratingCount = document.getElementById('modal-rating-count');
    const rating = getProductRatingSummary(productId);
    if (ratingAverage) ratingAverage.textContent = rating.average === null ? '--' : rating.average.toFixed(1);
    if (ratingStars) {
        ratingStars.innerHTML = renderRatingStars(rating.average);
        ratingStars.setAttribute('aria-label', rating.average === null
            ? 'Sin calificaciones'
            : `Calificación ${rating.average.toFixed(1)} de 5`);
    }
    if (ratingCount) ratingCount.textContent = `(${rating.reviews.length})`;
    if (!container) return;

    const reviews = rating.reviews;
    if (countEl) countEl.innerText = String(reviews.length);

    if (reviews.length === 0) {
        container.innerHTML = `<p class="text-gray-500 text-xs italic font-light">${currentLang === 'en' ? 'Be the first to review this imperial creation.' : 'Sea el primer comensal en calificar esta creación.'}</p>`;
        return;
    }

    container.innerHTML = reviews.map(r => {
        const rating = Math.max(0, Math.min(5, Math.floor(Number(r.rating) || 0)));
        const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating);
        const date = r.timestamp?.toDate?.() || (r.date ? new Date(r.date) : null);
        const dateLabel = date && !Number.isNaN(date.getTime())
            ? date.toLocaleDateString(currentLang === 'en' ? 'en' : 'es')
            : (currentLang === 'en' ? 'Recent' : 'Reciente');
        return `
            <div class="bg-black/30 border border-white/5 p-2.5 rounded-xl space-y-1">
                <div class="flex justify-between items-center">
                    <span class="text-king-gold text-xs">${stars}</span>
                    <div class="flex items-center gap-2">
                        <span class="text-[9px] text-gray-500">${escapeHtml(dateLabel)}</span>
                        ${isOwner() ? `<button type="button" data-action="delete-review" data-review-id="${escapeHtml(r.id)}" data-product-id="${escapeHtml(productId)}" aria-label="${currentLang === 'en' ? 'Delete review' : 'Eliminar reseña'}" class="rounded-md bg-red-900/30 px-2 py-1 text-red-300 transition hover:bg-red-800/60"><i class="fa-solid fa-trash"></i></button>` : ''}
                    </div>
                </div>
                ${r.comment ? `<p class="text-gray-300 text-xs leading-relaxed font-light">${escapeHtml(r.comment)}</p>` : ''}
            </div>
        `;
    }).join('');
}

export async function deleteReview(reviewId, productId) {
    if (!requireOwner()) return;
    try {
        await dbService.deleteReview(reviewId);
        state.reviews = state.reviews.filter(review => review.id !== reviewId);
        renderProductReviews(productId);
        renderMenu();
        renderExperienceProducts();
        showToast('OK', currentLang === 'en' ? 'Review removed.' : 'Reseña eliminada.');
    } catch (error) {
        console.error('[Reviews] No se pudo eliminar la reseña:', error);
        showToast('Error', error?.message || (currentLang === 'en' ? 'Could not delete review.' : 'No se pudo eliminar la reseña.'), true);
    }
}

export async function submitProductReview() {
    if (!state.currentDetailId) return;
    if (state.selectedRatingValue === 0) {
        showToast('Opinión', currentLang === 'en' ? 'Please select a star rating.' : 'Seleccione una calificación con estrellas.', true);
        return;
    }

    const comment = (document.getElementById('review-comment-input')?.value || '').trim();
    if (comment.length > 1000) {
        showToast('Opinión', currentLang === 'en' ? 'Reviews are limited to 1,000 characters.' : 'La reseña no puede superar 1.000 caracteres.', true);
        return;
    }

    try {
        await dbService.addReview(state.currentDetailId, state.selectedRatingValue, comment);
        resetStarSelector();
        showToast(t('toast_done'), currentLang === 'en' ? 'Thank you for your imperial review!' : '¡Gracias por su valoración imperial!');
    } catch (error) {
        console.error('[Reviews] No se pudo guardar la reseña:', error);
        showToast('Error', currentLang === 'en' ? 'Failed to submit review. Please try again.' : 'No se pudo guardar la reseña. Inténtelo de nuevo.', true);
    }
}

/* ==========================================================================
   DON IMPERIAL AI SOMMELIER & CHEF CHAT
   ========================================================================== */

export function toggleChefChat(show) {
    const drawer = document.getElementById('ai-chef-drawer');
    if (drawer) {
        if (show) {
            if (drawer.classList.contains('hidden') && document.activeElement instanceof HTMLElement
                && document.activeElement !== document.body) {
                chefDrawerReturnFocus = document.activeElement;
            }
            drawer.classList.remove('hidden');
            drawer.removeAttribute('inert');
            drawer.setAttribute('aria-hidden', 'false');
            document.getElementById('chef-input')?.focus();
        } else {
            drawer.classList.add('hidden');
            drawer.setAttribute('aria-hidden', 'true');
            drawer.setAttribute('inert', '');
            if (chefDrawerReturnFocus?.isConnected) chefDrawerReturnFocus.focus();
            chefDrawerReturnFocus = null;
        }
    }
}

export function askPresetChef(question) {
    const input = document.getElementById('chef-input');
    if (input) {
        input.value = question;
        sendChefMessage();
    }
}

export function runDonImperialChatEngine(question) {
    const normalize = value => String(value || '').toLocaleLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const q = normalize(question);
    const getText = product => {
        const localized = getProductLocalized(product);
        return normalize([
            localized.name, localized.description, localized.ingredients, localized.category,
            product.name, product.nameEn, product.description, product.descriptionEn,
            product.ingredients, product.ingredientsEn, product.category, product.categoryEn,
            product.allergens, product.allergensEn
        ].filter(Boolean).join(' '));
    };
    const excludedTerms = [...q.matchAll(/(?:\bsin|\bwithout|\bno quiero|\bno deseo|\bno como|\bno consumo|\bavoid|\bdon't want|\bdo not want|\bdon't eat|\bdo not eat)\s+(?:(?:el|la|los|las|un|una|the)\s+)?([a-z0-9]+)|\b(?:ni|nor)\s+([a-z0-9]+)/g)]
        .map(match => match[1] || match[2])
        .filter(Boolean);
    const available = state.products.filter(productIsAvailable)
        .filter(product => !excludedTerms.some(term => getText(product).includes(term)));
    const tokens = q.match(/[a-z0-9]+/g)?.filter(token => token.length > 3 &&
        !['para', 'como', 'cual', 'cuales', 'quiero', 'tiene', 'tienen', 'recomienda', 'recomiendame', 'please', 'with', 'what', 'dish', 'plato', 'platillo'].includes(token)) || [];
    const matches = available.map(product => ({
        product,
        score: tokens.reduce((score, token) => score + (getText(product).includes(token) ? 1 : 0), 0)
    })).filter(entry => entry.score > 0).sort((a, b) => b.score - a.score);
    const specific = matches[0]?.score >= 1 ? matches[0].product : null;
    const isEnglish = currentLang === 'en';
    const wantsIngredients = /ingrediente|ingredient|contiene|contain|alergen|allergen/.test(q);
    const asksAllergy = /alerg|allerg|celiac|celiac|gluten|intoleran/.test(q);
    const asksPairing = /maridaje|pairing|vino|wine|bebida|drink|coctel|cocktail/.test(q);
    const asksVegan = /vegano|vegana|vegan|vegetariano|vegetarian/.test(q);
    const categoryWanted = /postre|dessert|dulce|sweet/.test(q) ? /postre|dessert/
        : /bebida|drink|vino|wine|coctel|cocktail/.test(q) ? /bebida|drink|vino|wine|coctel|cocktail/
            : /entrada|appetizer|starter/.test(q) ? /entrada|appetizer/
                : /fuerte|main course|principal/.test(q) ? /fuerte|main course|principal/ : null;
    let recommendedProducts = [];
    let response;

    if (asksAllergy) {
        if (specific) {
            const product = getProductLocalized(specific);
            const allergens = isEnglish
                ? (specific.allergensEn || specific.allergens || 'Not declared')
                : (specific.allergens || specific.allergensEn || 'No declarado');
            response = isEnglish
                ? `${product.name}. Declared allergens: ${allergens}. This does not confirm the dish is safe or free from cross-contact. Please confirm with our staff before ordering.`
                : `${product.name}. Alérgenos declarados: ${allergens}. Esto no confirma que el platillo sea seguro ni que esté libre de contacto cruzado. Confirme con el personal antes de ordenar.`;
        } else {
            response = isEnglish
                ? 'Please tell me which dish you are asking about. I cannot confirm allergy safety or cross-contact; verify the declared allergens with our staff before ordering.'
                : 'Indíqueme de qué platillo desea consultar. No puedo confirmar que sea seguro ni descartar contactos cruzados; verifique los alérgenos declarados con el personal antes de ordenar.';
        }
    } else if (specific) {
        const product = getProductLocalized(specific);
        if (wantsIngredients) {
            const allergens = isEnglish ? (specific.allergensEn || specific.allergens) : (specific.allergens || specific.allergensEn);
            response = isEnglish
                ? `${product.name}: ${product.ingredients || 'The ingredients are not listed in the menu.'}${allergens ? ` Declared allergens: ${allergens}.` : ' No allergens are declared.'}`
                : `${product.name}: ${product.ingredients || 'La carta no detalla sus ingredientes.'}${allergens ? ` Alérgenos declarados: ${allergens}.` : ' No hay alérgenos declarados.'}`;
        } else {
            response = isEnglish
                ? `${product.name}: ${product.description || ''} ${product.ingredients ? `Ingredients: ${product.ingredients}. ` : ''}Current price: ${formatPrice(getProductPrice(specific))}.`
                : `${product.name}: ${product.description || ''} ${product.ingredients ? `Ingredientes: ${product.ingredients}. ` : ''}Precio actual: ${formatPrice(getProductPrice(specific))}.`;
        }
        recommendedProducts = [specific];
    } else if (asksPairing) {
        recommendedProducts = available.filter(product => /bebida|drink|vino|wine|coctel|cocktail/.test(getText(product))).slice(0, 4);
        response = recommendedProducts.length
            ? (isEnglish ? 'From the current menu, these drinks are available. Tell me which dish you are ordering and I can narrow down the pairing.' : 'Estas bebidas sí aparecen disponibles en la carta. Dígame qué platillo piensa pedir y afino el maridaje.')
            : (isEnglish ? 'There are no drinks listed in the current menu, so I do not want to invent a pairing. Ask our staff for today’s options.' : 'La carta actual no tiene bebidas para sugerir, así que prefiero no inventar un maridaje. Consulte al equipo por las opciones del día.');
    } else if (asksVegan) {
        const avoid = /veg|vegetarian/.test(q)
            ? /carne|res |pollo|pescado|marisco|langosta|pulpo|queso|leche|mantequilla|huevo|honey|beef|chicken|fish|seafood|lobster|cheese|milk|butter|egg/
            : /carne|res |pollo|pescado|marisco|langosta|pulpo|beef|chicken|fish|seafood|lobster/;
        recommendedProducts = available.filter(product => !avoid.test(getText(product)) && (product.ingredients || product.ingredientsEn)).slice(0, 4);
        response = isEnglish
            ? 'These options do not list the usual animal ingredients in their menu descriptions. Please confirm preparation and cross-contact with our staff, especially for strict dietary needs.'
            : 'Estas opciones no mencionan ingredientes animales habituales en la descripción de la carta. Confirme la preparación y posibles contactos cruzados con el equipo, especialmente si su dieta es estricta.';
    } else if (categoryWanted) {
        recommendedProducts = available.filter(product => categoryWanted.test(normalize(`${product.category || ''} ${product.categoryEn || ''}`))).slice(0, 4);
        response = recommendedProducts.length
            ? (isEnglish ? 'Here are the available dishes in that part of our menu.' : 'Estas son las opciones disponibles de esa parte de la carta.')
            : (isEnglish ? 'I could not find an available dish in that category right now.' : 'No encontré platillos disponibles en esa categoría en este momento.');
    } else if (tokens.length) {
        recommendedProducts = matches.slice(0, 4).map(entry => entry.product);
        response = recommendedProducts.length
            ? (isEnglish ? 'I found these available menu items that match your question.' : 'Encontré estas opciones disponibles que coinciden con su consulta.')
            : (isEnglish ? 'I could not match that request to a dish in the current menu. Ask about an ingredient, category, price or preference.' : 'No pude relacionar esa consulta con un plato de la carta actual. Puede preguntarme por ingredientes, categoría, precio o preferencias.');
    } else {
        recommendedProducts = available.slice(0, 4);
        response = isEnglish ? 'Here are a few dishes currently available. Ask me about a dish, its ingredients, price or a preference.' : 'Aquí tiene algunos platillos disponibles. Pregúnteme por un plato, sus ingredientes, precio o alguna preferencia.';
    }

    return { text: response, products: recommendedProducts };
}

export function sendChefMessage() {
    const input = document.getElementById('chef-input');
    const question = input?.value.trim();
    if (!question) return;

    const container = document.getElementById('chef-messages');
    if (!container) return;
    if (!container.dataset.chefActionsBound) {
        container.dataset.chefActionsBound = 'true';
        container.addEventListener('click', event => {
            const detailButton = event.target.closest('[data-chef-detail]');
            const addButton = event.target.closest('[data-chef-add]');
            if (detailButton) openDetail(detailButton.dataset.chefDetail);
            if (addButton) addToCart(addButton.dataset.chefAdd, 1);
        });
    }

    container.innerHTML += `
        <div class="flex items-start gap-3 justify-end font-sans">
            <div class="bg-king-gold text-black p-3 rounded-2xl rounded-tr-none max-w-[85%] text-xs">
                <p class="font-bold">${currentLang === 'en' ? 'You' : 'Usted'}</p>
                <p class="font-light mt-0.5">${escapeHtml(question)}</p>
            </div>
        </div>
    `;
    if (input) input.value = '';
    container.scrollTo(0, container.scrollHeight);

    const result = runDonImperialChatEngine(question);
    let recommendationCardsHtml = '';
    if (result.products && result.products.length > 0) {
        recommendationCardsHtml = `
            <div class="mt-3 pt-3 border-t border-white/10 space-y-2 animate-fade-in font-sans">
                <p class="text-[9px] text-king-gold uppercase tracking-wider font-bold mb-1 flex items-center gap-1.5"><i class="fa-solid fa-utensils"></i> ${currentLang === 'en' ? 'Suggestions:' : 'Sugerencias:'}</p>
                ${result.products.map(p => {
                    const localized = getProductLocalized(p);
                    return `
                        <div class="flex gap-2 p-2 bg-white/5 hover:bg-white/10 rounded-xl border border-white/5 items-center transition-all">
                            <img src="${escapeHtml(localized.imageUrl || '')}" class="w-10 h-10 object-cover rounded-lg border border-white/5" alt="" loading="lazy" data-image-fallback="hide">
                            <div class="flex-grow min-w-0">
                                <h5 class="text-white text-[11px] font-bold truncate leading-tight">${escapeHtml(localized.name)}</h5>
                                <p class="text-king-gold text-[10px] font-mono">${formatPrice(getProductPrice(p))}</p>
                            </div>
                            <div class="flex gap-1 flex-shrink-0">
                                <button data-chef-detail="${escapeHtml(p.id)}" class="w-7 h-7 bg-white/5 hover:bg-white/10 text-white rounded flex items-center justify-center transition" title="Ver"><i class="fa-solid fa-eye text-[10px]"></i></button>
                                <button data-chef-add="${escapeHtml(p.id)}" class="w-7 h-7 bg-king-gold hover:bg-king-goldHover text-black rounded flex items-center justify-center transition font-bold" title="Agregar"><i class="fa-solid fa-cart-plus text-[10px]"></i></button>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>`;
    }

    container.innerHTML += `
        <div class="flex items-start gap-3 font-sans animate-fade-in">
            <div class="w-8 h-8 rounded-full bg-king-gold/15 border border-king-gold/30 flex items-center justify-center text-king-gold text-xs flex-shrink-0">DI</div>
            <div class="bg-white/5 border border-white/5 p-3.5 rounded-2xl rounded-tl-none max-w-[85%] text-xs text-gray-300 leading-relaxed font-light">
                <p>${escapeHtml(result.text)}</p>
                ${recommendationCardsHtml}
            </div>
        </div>
    `;
    container.scrollTo(0, container.scrollHeight);
}

/* ==========================================================================
   REACTIVITY & TRANSLATION UPDATES
   ========================================================================== */

export function updateTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (key === 'hero_title' || key === 'menu_section_title') {
            el.innerHTML = t(key);
        } else {
            el.innerText = t(key);
        }
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        el.setAttribute('placeholder', t(key));
    });

    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        el.setAttribute('title', t(key));
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
        const key = el.getAttribute('data-i18n-aria-label');
        el.setAttribute('aria-label', t(key));
    });
    document.querySelectorAll('#star-selector [data-rating]').forEach(button => {
        const key = button.dataset.rating === '1' ? 'rating_star_one' : 'rating_star_many';
        button.setAttribute('aria-label', t(key).replace('{count}', button.dataset.rating));
    });
    document.querySelectorAll('[data-language-indicator]').forEach(indicator => {
        indicator.textContent = currentLang.toUpperCase();
    });

    renderCategories();
    renderMenu();
    renderExperienceCategories();
    renderExperienceProducts();
    renderUserOrdersDashboard();

    if (state.currentDetailId && !document.getElementById('detail-modal')?.classList.contains('hidden')) {
        openDetail(state.currentDetailId);
    }
    if (!document.getElementById('cart-modal')?.classList.contains('hidden')) {
        updateCart();
    }
    if (state.isAdmin && !document.getElementById('view-admin')?.classList.contains('hidden')) {
        renderAdminOrders();
        renderCalls();
        recalcSales();
        if (isOwner()) renderStaffList();
    }
}

export function toggleLanguage() {
    const nextLang = currentLang === 'es' ? 'en' : 'es';
    setLanguage(nextLang);
    document.documentElement.lang = currentLang;
    updateTranslations();
    initializeTableAccess();
    ensureExperienceCategorySelection();

    // Reset the assistant welcome message in the selected language.
    const container = document.getElementById('chef-messages');
    if (container) {
        container.innerHTML = `
            <div class="flex items-start gap-3 animate-fade-in">
                <div class="w-8 h-8 rounded-full bg-king-gold/15 border border-king-gold/30 flex items-center justify-center text-king-gold text-xs flex-shrink-0">DI</div>
                <div class="bg-[#101010] border border-white/5 p-3.5 rounded-2xl rounded-tl-none max-w-[85%]">
                    <p class="text-xs text-gray-200 leading-relaxed font-sans font-light">
                        ${t('chef_welcome')}
                    </p>
                </div>
            </div>
        `;
    }
}

/* ==========================================================================
   HELP & ASSISTANCE MODAL CONTROLS
   ========================================================================== */

export function openHelpModal() {
    openModal('help-modal');
}

export function closeHelpModal() {
    closeModal('help-modal');
}

/* ==========================================================================
   IMMERSIVE EXPERIENCE FLOW
   ========================================================================== */

function mountLegacyExperienceSurfaces(root) {
    const app = document.getElementById('app');
    const ordersHost = document.getElementById('experience-orders-host');
    const adminHost = document.getElementById('experience-admin-host');
    const overlays = document.getElementById('experience-overlays');
    if (!app || !ordersHost || !adminHost || !overlays) {
        console.error('[Experience] Faltan contenedores para montar las funciones existentes.');
        return;
    }

    const ordersView = document.getElementById('view-status');
    const adminView = document.getElementById('view-admin');
    if (ordersView) ordersHost.appendChild(ordersView);
    if (adminView) adminHost.appendChild(adminView);

    const legacySurfaces = app.querySelectorAll(
        ':scope > [id$="-modal"], :scope > #toast, :scope > #fab-cart, :scope > #fab-waiter, :scope > #ai-chef-btn, :scope > #ai-chef-drawer'
    );
    legacySurfaces.forEach(surface => overlays.appendChild(surface));

    const categoryGrid = document.querySelector('#experience-menu .category-grid');
    if (!categoryGrid) console.error('[Experience] No se encontró la cuadrícula de categorías.');

    root.classList.add('experience-ready');
}

function prepareExperienceSurface(viewId) {
    if (viewId === 'experience-orders') {
        document.getElementById('view-status')?.classList.remove('hidden');
        renderUserOrdersDashboard();
    } else if (viewId === 'experience-admin') {
        document.getElementById('view-admin')?.classList.remove('hidden');
        recalcSales();
        renderAdminOrders();
        if (isOwner()) renderCategoriesManage();
    }
}

export function openExperienceSurface(surface) {
    if (surface === 'orders' && state.role === 'employee') {
        surface = 'admin';
    }
    const surfaces = {
        categories: 'experience-menu',
        products: 'experience-products',
        orders: 'experience-orders',
        admin: 'experience-admin'
    };
    const viewId = surfaces[surface];
    if (!viewId) {
        console.error(`[Experience] Vista desconocida: ${surface}`);
        return;
    }
    if (surface === 'admin' && !state.isAdmin) {
        openAdminRoute();
        return;
    }
    prepareExperienceSurface(viewId);
    navigateExperience?.(viewId);
}

function initExperienceFlow() {
    const root = document.getElementById('experience-root');
    if (!root || root.dataset.initialized === 'true') return;
    root.dataset.initialized = 'true';
    mountLegacyExperienceSurfaces(root);

    navigateExperience = (nextView, onComplete, { pushHistory = true } = {}) => {
        if (activeExperienceView === nextView) return;
        if (experienceTransitioning) {
            if (!pushHistory) queuedExperienceView = nextView;
            return;
        }
        if (pushHistory) {
            const currentState = history.state || {};
            history.pushState({ ...currentState, view: 'menu', modal: null, experienceView: nextView }, '', '');
        }
        experienceTransitioning = true;
        root.classList.add('is-transitioning');
        root.setAttribute('aria-busy', 'true');
        const previousView = activeExperienceView;
        transitionExperienceView(previousView, nextView, () => {
            activeExperienceView = nextView;
            experienceTransitioning = false;
            root.classList.remove('is-transitioning');
            root.removeAttribute('aria-busy');
            if (nextView === 'experience-products') animateExperienceItems(document.getElementById('experience-products-grid'));
            const queuedView = queuedExperienceView;
            queuedExperienceView = null;
            if (queuedView && queuedView !== activeExperienceView) {
                navigateExperience(queuedView, undefined, { pushHistory: false });
                return;
            }
            onComplete?.();
        });
    };

    root.addEventListener('click', event => {
        const target = event.target;
        if (!(target instanceof Element)) return;

        if (target.closest('[data-experience-home]')) {
            renderExperienceCategories();
            navigateExperience('experience-menu');
            return;
        }
        const navLink = target.closest('[data-experience-nav]');
        if (navLink) {
            event.preventDefault();
            if (navLink.getAttribute('data-experience-nav') === 'categories') {
                renderExperienceCategories();
                navigateExperience('experience-menu');
            }
            return;
        }
        if (target.closest('[data-experience-cart]')) {
            openModal('cart-modal');
            return;
        }
        if (target.closest('[data-experience-orders]')) {
            openExperienceSurface('orders');
            return;
        }
        if (target.closest('[data-experience-admin]')) {
            openExperienceSurface('admin');
            return;
        }
        if (target.closest('[data-experience-return]')) {
            navigateExperience('experience-menu');
            return;
        }
        if (target.closest('[data-experience-back-categories]')) {
            navigateExperience('experience-menu');
            return;
        }

        const categoryCard = target.closest('[data-category]');
        if (categoryCard) {
            const category = categoryCard.getAttribute('data-category');
            if (!category) return;
            selectedExperienceCategory = category;
            state.activeCategory = category;
            renderExperienceCategories();
            renderMenu();
            renderExperienceProducts();
            const announcement = document.getElementById('category-selection');
            if (announcement) announcement.textContent = `${t('experience_category_selected')}: ${getCategoryDisplayName(category)}`;
            navigateExperience('experience-products');
            return;
        }

        const detailButton = target.closest('[data-product-details]');
        if (detailButton) {
            openDetail(detailButton.getAttribute('data-product-details'));
            return;
        }
        const editProductButton = target.closest('[data-edit-product]');
        if (editProductButton && isOwner()) {
            editProduct(editProductButton.getAttribute('data-edit-product'));
            return;
        }
        const deleteProductButton = target.closest('[data-delete-product]');
        if (deleteProductButton && isOwner()) {
            const productId = deleteProductButton.getAttribute('data-delete-product');
            const productName = deleteProductButton.getAttribute('data-delete-name');
            confirmAction('Eliminar platillo', `¿Desea eliminar ${productName}?`, () => deleteProduct(productId));
            return;
        }
        const addButton = target.closest('[data-add-product]');
        if (addButton) {
            addToCart(addButton.getAttribute('data-add-product'), 1);
            return;
        }
        if (target.closest('[data-experience-waiter]')) {
            openModal('waiter-modal');
            return;
        }
        if (target.closest('[data-experience-chef]')) {
            toggleChefChat(true);
        }
    });

    root.addEventListener('input', event => {
        const target = event.target;
        if (target instanceof HTMLInputElement && target.id === 'staff-password') {
            updateStaffPasswordFeedback(target);
        }
    });

    document.getElementById('experience-cart-bar')?.addEventListener('click', () => {
        openModal('cart-modal');
    });

    document.getElementById('experience-product-search')?.addEventListener('input', renderExperienceProducts);

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Tab' && trapDialogFocus(event)) return;
        if (event.key !== 'Escape' || experienceTransitioning) return;
        const openDialog = getTopmostDialog();
        if (openDialog?.id === 'ai-chef-drawer') {
            event.preventDefault();
            toggleChefChat(false);
            return;
        }
        if (openDialog) {
            event.preventDefault();
            closeModal(openDialog.id);
            return;
        }
        if (activeExperienceView === 'experience-menu' || activeExperienceView === 'experience-products') {
            navigateExperience('experience-menu');
        } else if (activeExperienceView === 'experience-orders' || activeExperienceView === 'experience-admin') {
            navigateExperience('experience-menu');
        }
    });

    renderExperienceCategories();
    renderExperienceProducts();
    updateCart();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initExperienceFlow, { once: true });
} else {
    initExperienceFlow();
}
