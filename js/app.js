/**
 * ==========================================================================
 * KingMenu | Main Application Bootstrap Controller (High-Performance)
 * ==========================================================================
 */

import { t, currentLang } from "./i18n.js";
import * as dbService from "./firebase-service.js";
import * as ui from "./ui.js";
import { initScrollPosition, initScrollAnimations } from "./animations.js";

// Ensure scroll starts strictly at (0, 0)
initScrollPosition();

async function seedDemoMenu() {
    const environment = document.querySelector('meta[name="kingmenu-environment"]')?.content;
    if (environment === 'production') {
        console.error('[Menu seed] La carga del menú de demostración está desactivada en producción.');
        ui.showToast('Error', currentLang === 'en'
            ? 'Demo menu loading is disabled in production.'
            : 'La carga del menú demo está desactivada en producción.', true);
        return;
    }
    ui.showToast(currentLang === 'en' ? "Syncing" : "Sembrando", t('empty_syncing'), false);
    try {
        const { DEFAULT_CATEGORIES, DEFAULT_PRODUCTS } = await import('./seed-menu.js');
        await dbService.seedDefaultMenu(ui.state.categories, ui.state.products, DEFAULT_CATEGORIES, DEFAULT_PRODUCTS);
        ui.showToast(t('toast_done'), t('toast_sync_ok'));
    } catch (e) {
        console.error('[Menu seed] No se pudo cargar el menú de demostración:', e);
        ui.showToast("Error", t('toast_sync_err'), true);
    }
}

/* ==========================================================================
   APP INITIALIZATION & EVENT LISTENERS
   ========================================================================== */

async function bootstrapApp() {
    // 1. Restore local session data
    const savedCart = localStorage.getItem('kingCart');
    if (savedCart) {
        try {
            const saved = JSON.parse(savedCart);
            const cartAge = Date.now() - Number(saved?.savedAt);
            if (!Array.isArray(saved?.items) || !Number.isFinite(cartAge) || cartAge < 0 || cartAge > 4 * 60 * 60 * 1000) {
                throw new Error('El carrito guardado es inválido o ya venció.');
            }
            const validItems = saved.items.filter(item =>
                item
                && typeof item.id === 'string'
                && item.id.length > 0
                && item.id.length <= 128
                && Number.isInteger(item.qty)
                && item.qty >= 1
                && item.qty <= 20
                && (item.notes === undefined || (typeof item.notes === 'string' && item.notes.length <= 500))
            );
            if (validItems.length !== saved.items.length) {
                ui.showToast(t('cart_title'), currentLang === 'en'
                    ? 'Invalid saved cart items were removed.'
                    : 'Se retiraron del carrito algunos datos guardados que no eran válidos.', true);
            }
            ui.state.cart = validItems.map(item => ({
                id: item.id,
                qty: item.qty,
                notes: item.notes || '',
                ...(typeof item.cartId === 'string' && item.cartId.length <= 128 ? { cartId: item.cartId } : {})
            }));
        } catch (error) {
            console.warn('[Cart] Se descartaron datos locales inválidos o vencidos:', error);
            ui.state.cart = [];
            localStorage.removeItem('kingCart');
            ui.showToast(t('cart_title'), currentLang === 'en'
                ? 'Your saved cart was invalid or expired and has been cleared.'
                : 'El carrito guardado no era válido o había vencido y se limpió.', true);
        }
    }
    ui.updateCart();

    const savedCustomerName = localStorage.getItem('kingCustomerName');
    localStorage.removeItem('kingCustomerTable');
    if (savedCustomerName) {
        const nameInput = document.getElementById('order-name');
        if (nameInput) nameInput.value = savedCustomerName;
    }
    ui.initializeTableAccess();

    ui.renderExperienceProducts();

    const experienceHomeState = { view: 'menu', modal: null, experienceView: 'experience-menu' };
    const currentPath = window.location.pathname.replace(/\/+$/, '');
    const initialUrl = ['/admin', '/cocina'].includes(currentPath) ? currentPath : '/';
    history.replaceState(experienceHomeState, '', initialUrl);
    history.pushState({ ...experienceHomeState, experienceRoot: true }, '', initialUrl);

    // 2. Setup DOM Events
    setupEventListeners();

    // 3. Direct entry to the public menu for demo flow: no heavy intro/wait screens.
    ui.renderExperienceCategories();
    ui.renderExperienceProducts();
    ui.updateTranslations();
    await ui.handleAdminRoute();
    ui.renderExperienceCategories();
    ui.renderExperienceProducts();

    // 4. Connect Firebase Service with Fallback Callbacks
    try {
        await dbService.initFirebaseService({
            onAuth: async (user, role) => {
                ui.setAdminAuth(user, role);
                if (role) {
                    try {
                        await ui.loadAdminPanel();
                    } catch (error) {
                        console.error('[Admin] No se pudo cargar el panel:', error);
                        ui.showToast('Error', currentLang === 'en'
                            ? 'Could not load the admin panel.'
                            : 'No se pudo cargar el panel administrativo.', true);
                        return;
                    }
                }
                await ui.handleAdminRoute();
            },
            onProducts: (productsList) => {
                if (Array.isArray(productsList)) {
                    const hadLoadedProducts = ui.state.productsReady;
                    const previousProducts = ui.state.products;
                    const productsChanged = JSON.stringify(previousProducts) !== JSON.stringify(productsList);
                    const currentDetailChanged = ui.state.currentDetailId
                        && JSON.stringify(previousProducts.find(product => product.id === ui.state.currentDetailId))
                            !== JSON.stringify(productsList.find(product => product.id === ui.state.currentDetailId));
                    ui.state.products = productsList;
                    ui.state.productsReady = true;
                    if (productsChanged || !hadLoadedProducts) {
                        ui.renderMenu();
                        ui.renderExperienceCategories();
                        ui.renderExperienceProducts();
                    }
                    ui.updateCart();
                    if (currentDetailChanged && !document.getElementById('detail-modal')?.classList.contains('hidden')) {
                        if (productsList.some(product => product.id === ui.state.currentDetailId)) {
                            ui.openDetail(ui.state.currentDetailId);
                        } else {
                            ui.closeModal('detail-modal');
                        }
                    }
                }
            },
            onCategories: (categoriesList) => {
                if (Array.isArray(categoriesList)) {
                    ui.state.categories = categoriesList;
                    ui.renderCategories();
                    ui.renderExperienceCategories();
                    ui.renderCategoriesManage();
                }
            },
            onOrders: (ordersList) => {
                ui.state.orders = ordersList || [];
                ui.recalcSales();
                ui.renderAdminOrders();
                ui.renderUserOrdersDashboard();
            },
            onNewOrders: (newOrders) => ui.notifyNewOrders(newOrders),
            onReviews: (reviewsList) => {
                const nextReviews = reviewsList || [];
                if (JSON.stringify(ui.state.reviews) === JSON.stringify(nextReviews)) return;
                ui.state.reviews = nextReviews;
                ui.renderMenu();
                if (ui.state.currentDetailId && !document.getElementById('detail-modal')?.classList.contains('hidden')) {
                    ui.renderProductReviews(ui.state.currentDetailId);
                }
            },
            onCalls: (callsList) => {
                ui.state.calls = callsList || [];
                ui.renderCalls();
            },
            onError: (error) => {
                console.error('[Firebase] No se pudo cargar el catálogo:', error);
                ui.state.productsReady = true;
                ui.renderMenu();
                ui.showToast('Error', currentLang === 'en'
                    ? 'The menu could not be loaded. Check your connection and try again.'
                    : 'No se pudo cargar la carta. Compruebe su conexión e inténtelo de nuevo.', true);
            },
            onSalesConfig: (lastResetMs) => {
                if (typeof lastResetMs === 'number' && lastResetMs > 0) {
                    ui.state.lastSalesReset = lastResetMs;
                    localStorage.setItem('kingLastSalesReset', String(lastResetMs));
                    ui.recalcSales();
                }
            }
        });
    } catch (err) {
        console.error('[Firebase] Fallo conectando servicio:', err);
    }

    // 5. Initialize GSAP & Scroll Animations
    initScrollAnimations();
}

function setupEventListeners() {
    document.addEventListener('click', event => {
        if (!(event.target instanceof Element)) return;
        const button = event.target.closest('[data-action]');
        if (!button) return;

        const { action } = button.dataset;
        switch (action) {
            case 'set-view': ui.setView(button.dataset.view); break;
            case 'open-modal': ui.openModal(button.dataset.modal); break;
            case 'close-modal': ui.closeModal(button.dataset.modal); break;
            case 'open-qr-modal': ui.openQrModal(); break;
            case 'close-qr-modal': ui.closeQrModal(); break;
            case 'open-staff-modal': ui.openStaffModal(); break;
            case 'close-staff-modal': ui.closeStaffModal(); break;
            case 'open-help': ui.openHelpModal(); break;
            case 'toggle-language': ui.toggleLanguage(); break;
            case 'logout': ui.logout(); break;
            case 'new-product': ui.newProduct(); break;
            case 'seed-demo': seedDemoMenu(); break;
            case 'go-to-menu-admin': ui.setView('menu'); break;
            case 'reset-sales':
                ui.confirmAction(t('kpi_sales_reset_t'), t('kpi_sales_reset_m'), ui.resetSales);
                break;
            case 'toggle-chef': ui.toggleChefChat(button.dataset.open === 'true'); break;
            case 'chef-preset': ui.askPresetChef(t(button.dataset.translationKey)); break;
            case 'send-chef-message': ui.sendChefMessage(); break;
            case 'carousel-previous': ui.prevSlide(event); break;
            case 'carousel-next': ui.nextSlide(event); break;
            case 'activate-3d': ui.activate3DView(); break;
            case 'open-detail': ui.openDetail(button.dataset.productId); break;
            case 'add-current-detail': ui.addCurrentDetailToCart(); break;
            case 'launch-ar': ui.launchAR(); break;
            case 'set-rating': ui.setRatingValue(Number(button.dataset.rating)); break;
            case 'submit-review': ui.submitProductReview(); break;
            case 'cancel-admin-mfa': ui.cancelAdminMfa(); break;
            case 'delete-review':
                ui.confirmAction(
                    currentLang === 'en' ? 'Delete review' : 'Eliminar reseña',
                    currentLang === 'en' ? 'Remove this review from the public menu?' : '¿Eliminar esta reseña del menú público?',
                    () => ui.deleteReview(button.dataset.reviewId, button.dataset.productId)
                );
                break;
            case 'update-modal-qty': ui.updateModalQty(Number(button.dataset.delta)); break;
            case 'cart-tab': ui.switchCartTab(button.dataset.tab); break;
            case 'show-checkout': ui.showCheckoutForm(); break;
            case 'hide-checkout': ui.hideCheckoutForm(); break;
            case 'submit-order': ui.submitOrder(); break;
            case 'send-waiter-call': ui.sendWaiterCall(); break;
            case 'generate-table-qr': ui.generateTableQr(); break;
            case 'toggle-saved-qr': ui.toggleSavedTableQr(button.dataset.qrTable); break;
            case 'delete-saved-qr': ui.deleteSavedTableQr(button.dataset.qrTable); break;
            case 'reload-staff': ui.refreshStaffList(); break;
            case 'create-staff': ui.createStaff(); break;
            case 'deactivate-staff': ui.deactivateStaff(button.dataset.staffUid, button.dataset.staffEmail); break;
            case 'copy-table-qr': ui.copyTableQrUrl(button.dataset.qrUrl); break;
            case 'cancel-category-edit': ui.cancelCategoryEdit(); break;
            case 'save-category': ui.saveCategoryLogic(); break;
            case 'trigger-category-upload': ui.triggerCategoryImageUpload(); break;
            case 'add-category-image': ui.addCategoryImageUrl(); break;
            case 'generate-product-copy': ui.generateAI(); break;
            case 'trigger-admin-upload': ui.triggerAdminImageUpload(); break;
            case 'add-admin-image-input': ui.addAdminImageInput(); break;
            case 'reset-admin-crop': ui.resetAdminImageCrop(); break;
            case 'cancel-admin-crop': ui.cancelAdminImageCrop(); break;
            case 'apply-admin-crop': ui.applyAdminImageCrop(); break;
            case 'save-product': ui.saveProduct(); break;
            case 'scroll-products':
                document.getElementById('products-grid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                break;
            case 'adjust-split-people': ui.adjustSplitPeople(Number(button.dataset.delta)); break;
            case 'adjust-cart-item': ui.updateItemQty(button.dataset.cartId, Number(button.dataset.delta)); break;
            case 'remove-cart-item': ui.removeFromCart(button.dataset.cartId); break;
            case 'toggle-split-item': ui.toggleSplitItem(button.dataset.cartId); break;
            case 'adjust-split-item': ui.adjustSplitItemQty(button.dataset.cartId, Number(button.dataset.delta)); break;
            case 'resolve-call': ui.resolveCall(button.dataset.callId); break;
            case 'enable-kitchen-alerts': ui.enableKitchenAlerts(); break;
            case 'print-kitchen': ui.printKitchenOrders(); break;
            case 'update-order-status': ui.updateOrderStatus(button.dataset.orderId, button.dataset.status); break;
            case 'complete-order': ui.completeOrder(button.dataset.orderId); break;
            case 'go-to-slide': ui.goToSlide(Number(button.dataset.slide)); break;
            case 'activate-product-model': ui.activateProductModel(button); break;
            case 'edit-product': ui.editProduct(button.dataset.productId); break;
            case 'delete-product':
                ui.confirmAction('Eliminar platillo', `¿Desea eliminar ${button.dataset.productName}?`, () => ui.deleteProduct(button.dataset.productId));
                break;
            case 'add-product': ui.addToCart(button.dataset.productId, 1); break;
            case 'filter-category': ui.filterCat(button.dataset.category); break;
            case 'reset-search': ui.resetSearch(); break;
            case 'remove-product': ui.deleteProduct(button.dataset.productId); break;
            case 'edit-category': ui.startEditCategory(button.dataset.categoryId, button.dataset.categoryName); break;
            case 'delete-category':
                ui.confirmAction('Eliminar categoría', `¿Desea eliminar ${button.dataset.categoryName}?`, () => ui.deleteCategory(button.dataset.categoryId));
                break;
            case 'move-category':
                ui.moveCategory(button.dataset.categoryId, Number(button.dataset.delta));
                break;
            case 'confirm-delete-product':
                ui.confirmAction(t('btn_cancel'), currentLang === 'en' ? 'Delete dish?' : '¿Borrar platillo?', () => ui.deleteProduct(button.dataset.productId));
                break;
            case 'close-help': ui.closeHelpModal(); break;
            case 'dismiss-help-modal': ui.closeModal('help-modal'); break;
            case 'chef-enter':
            case 'crop-zoom':
            case 'crop-rotation':
                break;
            default:
                console.warn(`[UI] Acción no reconocida: ${action}`);
        }
    });

    document.addEventListener('input', event => {
        if (!(event.target instanceof HTMLInputElement)) return;
        const input = event.target;
        if (input.dataset.action === 'crop-zoom') ui.updateAdminImageCropZoom(input.value);
        if (input.dataset.action === 'crop-rotation') ui.updateAdminImageCropRotation(input.value);
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement
            && event.target.dataset.action === 'chef-enter') {
            event.preventDefault();
            ui.sendChefMessage();
        }
    });
    document.addEventListener('error', event => {
        if (!(event.target instanceof HTMLImageElement)) return;
        const image = event.target;
        if (image.dataset.imageFallbackUrl && !image.dataset.imageFallbackAttempted) {
            image.dataset.imageFallbackAttempted = 'true';
            image.src = image.dataset.imageFallbackUrl;
            return;
        }
        if (image.dataset.imageFallback === 'show-next') {
            image.hidden = true;
            image.nextElementSibling?.removeAttribute('hidden');
            return;
        }
        if (image.dataset.imageFallback === 'hide' || image.dataset.imageFallbackUrl) image.hidden = true;
    }, true);
    document.body?.addEventListener('pointerdown', () => ui.initAudioContext(), { once: true, passive: true });

    document.addEventListener('submit', event => {
        if (!(event.target instanceof HTMLFormElement) || event.target.id !== 'admin-login-form') return;
        event.preventDefault();
        ui.login();
    });

    const discountTypeInput = document.getElementById('prod-discount-type');
    const discountValueInput = document.getElementById('prod-discount-value');
    discountTypeInput?.addEventListener('change', () => {
        if (!discountValueInput) return;
        const hasDiscount = discountTypeInput.value === 'percent' || discountTypeInput.value === 'price';
        discountValueInput.disabled = !hasDiscount;
        discountValueInput.min = discountTypeInput.value === 'percent' ? '1' : '0';
        discountValueInput.max = discountTypeInput.value === 'percent' ? '99' : '';
        discountValueInput.step = discountTypeInput.value === 'percent' ? '1' : '100';
        if (!hasDiscount) discountValueInput.value = '0';
    });

    const cropStage = document.getElementById('admin-image-cropper-stage');
    cropStage?.addEventListener('pointerdown', ui.startAdminImageCropPan);
    cropStage?.addEventListener('pointermove', ui.moveAdminImageCropPan);

    // Live search input filtering
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            ui.renderMenu();
        });
    }

    // Dynamic error state clearance for checkout inputs
    const orderNameInput = document.getElementById('order-name');
    if (orderNameInput) {
        orderNameInput.addEventListener('input', () => {
            orderNameInput.classList.remove('input-error');
        });
    }
    // Confirm modal action button
    const confirmBtnAction = document.getElementById('confirm-btn-action');
    if (confirmBtnAction) {
        confirmBtnAction.addEventListener('click', ui.executePendingConfirmAction);
    }

    // Carousel swipe gestures
    const slidesEl = document.getElementById('carousel-slides');
    if (slidesEl) {
        slidesEl.addEventListener('touchstart', e => {
            ui.state.touchStartX = e.changedTouches[0].screenX;
        }, { passive: true });

        slidesEl.addEventListener('touchend', e => {
            ui.state.touchEndX = e.changedTouches[0].screenX;
            const threshold = 45;
            if (ui.state.touchStartX - ui.state.touchEndX > threshold) ui.nextSlide();
            else if (ui.state.touchEndX - ui.state.touchStartX > threshold) ui.prevSlide();
        }, { passive: true });
    }

    // Popstate handling (Back button closes modals / views cleanly without scroll jump)
    window.addEventListener('popstate', (e) => {
        const s = e.state || { view: 'menu', modal: null };
        if (['/admin', '/cocina'].includes(window.location.pathname.replace(/\/+$/, ''))) {
            ui.handleAdminRoute();
            return;
        }
        ui.leaveAdminRoute();
        document.querySelectorAll('[id$="-modal"]').forEach(el => {
            if (!el.classList.contains('hidden')) ui.toggleModalElement(el.id, false);
        });
        const chefDrawer = document.getElementById('ai-chef-drawer');
        if (chefDrawer && !chefDrawer.classList.contains('hidden')) ui.toggleChefChat(false);
        ui.stopCarouselAutoPlay();
        if (s.modal) {
            ui.toggleModalElement(s.modal, true);
        }
        if (s.experienceView) {
            ui.handleExperiencePopState(s);
            return;
        }

        const currentActiveViewEl = ['view-menu', 'view-status', 'view-admin'].find(id => {
            const el = document.getElementById(id);
            return el && !el.classList.contains('hidden');
        });
        const targetViewId = `view-${s.view || 'menu'}`;
        if (currentActiveViewEl !== targetViewId) {
            ui.toggleViewElement(s.view || 'menu', false);
        }
    });
}

// Boot application
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrapApp);
} else {
    bootstrapApp();
}
