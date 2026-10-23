/**
 * ==========================================================================
 * KingMenu | Scroll Initializer, GSAP Reveal & Lazy-Load Engine
 * ==========================================================================
 * Standard-compliant with .trae/rules/project_rules.md
 * - Smooth GSAP ScrollTrigger reveals with power3.out easing
 * - Scroll position origin normalization (0, 0)
 * - High-performance MutationObserver & IntersectionObserver image lazy loading
 * ==========================================================================
 */

/**
 * Ensures the window always loads at scroll (0,0) and disables browser
 * scroll restoration so the page never jumps to a previous position.
 */
export function initScrollPosition() {
    if ('scrollRestoration' in history) {
        history.scrollRestoration = 'manual';
    }
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    if (document.documentElement) document.documentElement.scrollTop = 0;
    if (document.body) document.body.scrollTop = 0;
}

/**
 * Main animation initializer:
 *  1. Resets scroll to (0,0)
 *  2. Registers GSAP + ScrollTrigger
 *  3. Fires hero text reveal animations
 *  4. Fires section intro scroll reveals
 *  5. Initialises aggressive lazy image loading
 */
export function initScrollAnimations() {
    try {
        // 1. Guarantee scroll starts at origin
        initScrollPosition();

        const isMobile = () => {
            if (!window.matchMedia) return window.innerWidth <= 768;
            return window.matchMedia('(max-width: 768px)').matches;
        };
        const mobile = isMobile();

        // 2. Register GSAP plugins if available
        if (typeof gsap !== 'undefined' && typeof ScrollTrigger !== 'undefined') {
            gsap.registerPlugin(ScrollTrigger);
            ScrollTrigger.config({ ignoreMobileResize: true });
            ScrollTrigger.defaults({ fastScrollEnd: true });

            // 3. Hero content text reveals (immediate, no scroll dependency)
            gsap.utils.toArray('.reveal-text').forEach((el, i) => {
                gsap.to(el, {
                    opacity: 1,
                    y: 0,
                    duration: 1.1,
                    ease: 'power3.out',
                    delay: 0.25 + i * 0.07
                });
            });

            // Hero badge & CTA entrance
            gsap.from('.hero-badge', {
                opacity: 0,
                y: -18,
                duration: 0.9,
                ease: 'power3.out',
                delay: 0.1
            });

            // Scroll indicator fade-out on first scroll
            const scrollIndicator = document.getElementById('scroll-down-indicator');
            if (scrollIndicator) {
                gsap.to(scrollIndicator, {
                    opacity: 0,
                    y: 22,
                    ease: 'power2.out',
                    scrollTrigger: {
                        trigger: '#hero-3d-section',
                        start: 'top+=' + (mobile ? 60 : 90) + ' top',
                        end: 'top+=' + (mobile ? 280 : 400) + ' top',
                        scrub: true
                    }
                });
            }

            // 4. Section intro scroll reveals
            gsap.utils.toArray('.section-intro').forEach(el => {
                gsap.to(el, {
                    opacity: 1,
                    y: 0,
                    duration: 1.15,
                    ease: 'power3.out',
                    scrollTrigger: {
                        trigger: el,
                        start: 'top 88%',
                        end: 'top 50%',
                        toggleActions: 'play none none reverse'
                    }
                });
            });

            // Clean ScrollTrigger refresh after DOM settles
            requestAnimationFrame(() => {
                ScrollTrigger.refresh();
            });
            setTimeout(() => {
                ScrollTrigger.refresh();
            }, 350);
        }

        // 5. Initialise aggressive lazy loading
        initLazyLoading();

    } catch (err) {
        console.error('[Animations] Error en initScrollAnimations:', err);
    }
}

/**
 * Aggressive Lazy Loading Engine
 * rootMargin: 300px pre-loads images well before they enter the viewport.
 * Uses MutationObserver on the product grid to catch dynamically injected cards.
 */
export function initLazyLoading() {
    const cleanSkeleton = (img) => {
        const remove = () => {
            img.classList.remove('img-skeleton');
            img.removeAttribute('data-src');
        };
        if (img.complete && img.naturalWidth > 0) {
            remove();
        } else {
            img.addEventListener('load', remove, { once: true });
            img.addEventListener('error', remove, { once: true });
        }
    };

    if ('IntersectionObserver' in window) {
        const imgObserver = new IntersectionObserver((entries, obs) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    const src = img.getAttribute('data-src');
                    if (src) {
                        img.src = src;
                        cleanSkeleton(img);
                    } else {
                        img.classList.remove('img-skeleton');
                    }
                    obs.unobserve(img);
                }
            });
        }, { rootMargin: '300px 0px', threshold: 0.01 });

        // Observe already-present images
        document.querySelectorAll('img[data-src]').forEach((img) => imgObserver.observe(img));

        // Watch the product grid for dynamically injected cards
        const grid = document.getElementById('products-grid');
        if (grid) {
            const gridObserver = new MutationObserver(() => {
                grid.querySelectorAll('img[data-src]').forEach((img) => {
                    if (!img._lazyObserved) {
                        img._lazyObserved = true;
                        imgObserver.observe(img);
                    }
                });
            });
            gridObserver.observe(grid, { childList: true, subtree: true });
        }
    } else {
        // Fallback: load all images immediately (no IntersectionObserver support)
        document.querySelectorAll('img[data-src]').forEach((img) => {
            const src = img.getAttribute('data-src');
            if (src) {
                img.src = src;
                cleanSkeleton(img);
            }
        });
    }
}

const experienceTransitions = new Map();

export function transitionExperienceView(fromId, toId, onComplete) {
    const from = document.getElementById(fromId);
    const to = document.getElementById(toId);
    if (!to) {
        console.error(`[Experience] No se encontró la vista destino: ${toId}`);
        return;
    }

    const gsapInstance = window.gsap;
    const previousTransition = experienceTransitions.get(fromId);
    if (previousTransition) {
        previousTransition.kill();
        experienceTransitions.delete(fromId);
    }

    const showDestination = () => {
        if (from) {
            from.classList.add('hidden');
            from.setAttribute('aria-hidden', 'true');
            from.style.removeProperty('opacity');
            from.style.removeProperty('transform');
        }
        to.classList.remove('hidden');
        to.setAttribute('aria-hidden', 'false');
        if (gsapInstance && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            gsapInstance.fromTo(to, { opacity: 0, y: 16 }, {
                opacity: 1,
                y: 0,
                duration: 0.65,
                ease: 'power3.out',
                onComplete
            });
        } else {
            onComplete?.();
        }
    };

    if (from && !from.classList.contains('hidden') && gsapInstance && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const transition = gsapInstance.to(from, {
            opacity: 0,
            y: -12,
            duration: 0.28,
            ease: 'power2.in',
            onComplete: () => {
                experienceTransitions.delete(fromId);
                showDestination();
            }
        });
        experienceTransitions.set(fromId, transition);
    } else {
        showDestination();
    }
}

export function animateExperienceItems(container) {
    const grid = typeof container === 'string' ? document.querySelector(container) : container;
    if (!grid || !window.gsap || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const items = grid.querySelectorAll('.category-card, .experience-product-card');
    if (!items.length) return;
    window.gsap.fromTo(items, {
        opacity: 0,
        y: 16
    }, {
        opacity: 1,
        y: 0,
        duration: 0.45,
        stagger: 0.055,
        ease: 'power2.out',
        overwrite: 'auto'
    });
}
