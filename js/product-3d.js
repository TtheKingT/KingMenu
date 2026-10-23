import * as THREE from "three";
import { GLTFLoader } from "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js";

const loader = new GLTFLoader();
const viewers = new Map();
const visibleViewers = new Set();
const trackedCanvases = new Set();

const intersectionObserver = typeof IntersectionObserver === "undefined"
    ? null
    : new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            const viewer = viewers.get(entry.target);
            if (!viewer) return;
            if (entry.isIntersecting) {
                visibleViewers.add(viewer);
                viewer.render();
            } else {
                visibleViewers.delete(viewer);
            }
        });
    }, { rootMargin: "120px" });

function showModelFallback(canvas) {
    canvas.hidden = true;
    canvas.style.opacity = "";
    const card = canvas.closest(".product-card-responsive, .experience-product-card");
    const loadButton = card?.querySelector("[data-load-product-model]");
    const photoButton = card?.querySelector("[data-hide-product-model]");
    if (loadButton) loadButton.hidden = false;
    if (photoButton) photoButton.hidden = true;
    setProductModelButtonState(card, false);
}

function setProductModelButtonState(card, isActive) {
    const toggleButton = card?.querySelector("[data-toggle-product-model]");
    if (!toggleButton) return;
    const name = toggleButton.dataset.productName || "";
    toggleButton.innerHTML = isActive
        ? '<i class="fa-solid fa-image" aria-hidden="true"></i><span>Foto</span>'
        : '<i class="fa-solid fa-cube" aria-hidden="true"></i><span>3D</span>';
    toggleButton.setAttribute("aria-label", isActive ? `Volver a la foto de ${name}` : `Ver modelo 3D de ${name}`);
    toggleButton.setAttribute("aria-pressed", String(isActive));
}

function setModelVisible(canvas) {
    const photo = canvas.closest(".experience-product-photo");
    const image = photo?.querySelector("img") || canvas.parentElement?.querySelector("img");
    const placeholder = photo?.querySelector(".experience-photo-placeholder");
    if (image) image.hidden = true;
    if (placeholder) placeholder.hidden = true;
    canvas.style.opacity = "1";
    const card = canvas.closest(".product-card-responsive, .experience-product-card");
    const loadButton = card?.querySelector("[data-load-product-model]");
    const photoButton = card?.querySelector("[data-hide-product-model]");
    if (loadButton) loadButton.hidden = true;
    if (photoButton) photoButton.hidden = false;
    setProductModelButtonState(card, true);
}

function disposeModel(root) {
    root.traverse(object => {
        if (!object.isMesh) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach(material => {
            Object.values(material).forEach(value => {
                if (value?.isTexture) value.dispose();
            });
            material.dispose();
        });
    });
}

function disposeViewer(canvas, viewer) {
    intersectionObserver?.unobserve(canvas);
    trackedCanvases.delete(canvas);
    visibleViewers.delete(viewer);
    cancelAnimationFrame(viewer.frameId);
    viewer.controls.dispose();
    disposeModel(viewer.scene);
    viewer.renderer.dispose();
    viewers.delete(canvas);
}

function fitModel(model, camera, controls) {
    const bounds = new THREE.Box3().setFromObject(model);
    if (bounds.isEmpty()) {
        throw new Error("El archivo 3D no contiene geometría visible.");
    }

    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    model.position.sub(center);
    const maxDimension = Math.max(size.x, size.y, size.z);
    const distance = maxDimension / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.35;
    camera.position.set(distance * 0.8, distance * 0.55, distance);
    camera.near = Math.max(distance / 100, 0.01);
    camera.far = distance * 100;
    camera.updateProjectionMatrix();
    controls.minDistance = distance * 0.55;
    controls.maxDistance = distance * 3;
    controls.target.set(0, 0, 0);
    controls.update();
}

function createViewer(canvas) {
    const renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        powerPreference: "low-power"
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x4b3520, 2));
    const keyLight = new THREE.DirectionalLight(0xffe8b0, 2.5);
    keyLight.position.set(3, 5, 4);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xffffff, 1.2);
    fillLight.position.set(-4, 2, -3);
    scene.add(fillLight);

    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 1.1;
    controls.addEventListener("start", () => { controls.autoRotate = false; });
    controls.addEventListener("end", () => { controls.autoRotate = true; });

    const viewer = {
        renderer,
        scene,
        camera,
        controls,
        frameId: 0,
        render() {
            if (!canvas.isConnected || canvas.hidden) return;
            const width = canvas.clientWidth;
            const height = canvas.clientHeight;
            if (!width || !height) {
                viewer.frameId = requestAnimationFrame(viewer.render);
                return;
            }
            renderer.setSize(width, height, false);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
            controls.update();
            renderer.render(scene, camera);
            if (visibleViewers.has(viewer)) {
                viewer.frameId = requestAnimationFrame(viewer.render);
            }
        }
    };

    return viewer;
}

function loadViewer(canvas) {
    if (!canvas.dataset.productModel || !canvas.isConnected) {
        return Promise.reject(new Error("El modelo 3D no está disponible."));
    }
    let viewer;
    try {
        canvas.hidden = false;
        canvas.style.opacity = "0";
        viewer = createViewer(canvas);
    } catch (error) {
        console.error("[Product3D] No se pudo inicializar el visor WebGL:", error);
        showModelFallback(canvas);
        return Promise.reject(error);
    }
    viewers.set(canvas, viewer);
    return new Promise((resolve, reject) => loader.load(
        canvas.dataset.productModel,
        ({ scene: model }) => {
            if (viewers.get(canvas) !== viewer) {
                disposeModel(model);
                reject(new Error("El visor 3D dejó de estar activo."));
                return;
            }
            if (!canvas.isConnected) {
                disposeModel(model);
                disposeViewer(canvas, viewer);
                reject(new Error("El producto se retiró del menú."));
                return;
            }
            try {
                fitModel(model, viewer.camera, viewer.controls);
                viewer.scene.add(model);
                setModelVisible(canvas);
                if (intersectionObserver) intersectionObserver.observe(canvas);
                else {
                    visibleViewers.add(viewer);
                    viewer.render();
                }
                resolve();
            } catch (error) {
                console.error(`[Product3D] No se pudo preparar el modelo ${canvas.dataset.productModel}:`, error);
                disposeModel(model);
                disposeViewer(canvas, viewer);
                showModelFallback(canvas);
                reject(error);
            }
        },
        undefined,
        error => {
            console.error(`[Product3D] No se pudo cargar el modelo ${canvas.dataset.productModel}:`, error);
            if (viewers.get(canvas) === viewer) disposeViewer(canvas, viewer);
            showModelFallback(canvas);
            reject(error);
        }
    ));
}

export function renderProductModels(root = document) {
    const canvases = new Set(root.querySelectorAll("canvas[data-product-model]"));
    trackedCanvases.forEach(canvas => {
        if (document.contains(canvas)) return;
        const viewer = viewers.get(canvas);
        if (viewer) disposeViewer(canvas, viewer);
        else {
            trackedCanvases.delete(canvas);
        }
    });

    canvases.forEach(canvas => {
        trackedCanvases.add(canvas);
    });
}

export function activateProductModel(canvas) {
    if (!canvas.dataset.clickPropagationStopped) {
        canvas.addEventListener("click", event => event.stopPropagation());
        canvas.dataset.clickPropagationStopped = "true";
    }
    if (viewers.has(canvas)) {
        const viewer = viewers.get(canvas);
        canvas.hidden = false;
        visibleViewers.add(viewer);
        viewer.render();
        setModelVisible(canvas);
        return Promise.resolve();
    }
    trackedCanvases.add(canvas);
    return loadViewer(canvas);
}

export function deactivateProductModel(canvas) {
    const viewer = viewers.get(canvas);
    if (viewer) {
        visibleViewers.delete(viewer);
        cancelAnimationFrame(viewer.frameId);
    }
    canvas.hidden = true;
    const photo = canvas.closest(".experience-product-photo");
    const image = photo?.querySelector("img") || canvas.parentElement?.querySelector("img");
    const placeholder = photo?.querySelector(".experience-photo-placeholder");
    const imageAvailable = image && image.dataset.imageFailed !== "true";
    if (image) image.hidden = !imageAvailable;
    if (placeholder) placeholder.hidden = Boolean(imageAvailable);
    const card = canvas.closest(".product-card-responsive, .experience-product-card");
    const loadButton = card?.querySelector("[data-load-product-model]");
    const photoButton = card?.querySelector("[data-hide-product-model]");
    if (loadButton) loadButton.hidden = false;
    if (photoButton) photoButton.hidden = true;
    setProductModelButtonState(card, false);
}
