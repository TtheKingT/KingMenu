/**
 * ==========================================================================
 * KingMenu | Escena 3D Premium: "El Gran Banquete Imperial" (Three.js)
 * ==========================================================================
 * Composición Culinaria Monumental de Restaurante Gourmet & Alta Cocina:
 * 
 * 1. Base Imperial:
 *    - Gran bandeja circular de obsidiana con doble aro biselado en oro de 24K.
 * 
 * 2. Centro de Gala: "Imperial Gourmet Burger":
 *    - Pan brioche artesanal glaseado con semillas de sésamo doradas.
 *    - Medallón de carne Angus a la brasa con textura ahumada.
 *    - Fundido suntuoso de queso Paipa / Cheddar madurado.
 *    - Láminas de tocino crujiente caramelizado y rodajas de tomate jugoso.
 *    - Corona de lechuga silvestre y microbrotes caribeños.
 * 
 * 3. Guarnición de Alta Cocina:
 *    - Papas rústicas al romero con corte rústico dorado.
 *    - Aguacate Hass parrillado con flor de sal marina.
 *    - Camarón jumbo marinado al carbón de leña.
 * 
 * 4. Maridaje & Coctelería de Autor:
 *    - Copa de cristal fino con néctar imperial, rodaja de cítrico y burbujas activas.
 * 
 * 5. Decoración y Atmósfera:
 *    - Gotas de emulsión de trufa y reducción de panela.
 *    - Polvo de oro comestible de 24K y especias aromáticas en suspensión.
 *    - Iluminación cinematográfica de estudio culinario Michelin.
 * 
 * 6. Rendimiento 60 FPS:
 *    - IntersectionObserver para apagado total de GPU al salir de pantalla.
 *    - Materiales reutilizados y geometrías balanceadas para móviles y desktop.
 * ==========================================================================
 */

(function () {
    'use strict';

    if (typeof THREE === 'undefined') {
        console.warn('[ThreeScene] Three.js no está disponible.');
        return;
    }

    const isMobile = () => {
        if (!window.matchMedia) return window.innerWidth <= 768;
        return window.matchMedia('(max-width: 768px)').matches;
    };

    const isLowEndDevice = () => {
        const cores = navigator.hardwareConcurrency || 2;
        const mem = navigator.deviceMemory || 8;
        return cores <= 4 || mem <= 4;
    };

    let renderer = null;
    let scene = null;
    let camera = null;
    let rafId = 0;
    let isRunning = false;
    let heroVisible = true;
    let viewActive = true;

    // Grupos y Objetos de la Composición
    let feastMasterGroup = null;
    let burgerGroup = null;
    let friesGroup = null;
    let avocadoGroup = null;
    let shrimpGroup = null;
    let cocktailGroup = null;
    let sauceDropsGroup = null;
    let bubbles = [];

    // Partículas de atmósfera
    let goldDustPoints = null;
    let goldDustGeo = null;
    let goldDustSpeeds = null;
    let goldDustPhases = null;

    // Luces
    let keyLight = null;
    let goldRimLight = null;
    let underGlow = null;
    let hemiLight = null;

    const scrollState = { progress: 0 };
    const clock = new THREE.Clock();
    let lastTime = performance.now();

    function initScene() {
        const canvas = document.getElementById('three-canvas');
        const heroSection = document.getElementById('hero-3d-section');
        if (!canvas || !heroSection) return;

        const mobile = isMobile();
        const lowEnd = mobile && isLowEndDevice();

        const getWidth = () => heroSection.clientWidth || window.innerWidth;
        const getHeight = () => heroSection.clientHeight || window.innerHeight;

        // 1. Escena y Atmósfera
        scene = new THREE.Scene();
        scene.fog = new THREE.FogExp2(0x100d08, mobile ? 0.035 : 0.03);

        // 2. Cámara
        const fov = mobile ? 48 : 38;
        camera = new THREE.PerspectiveCamera(fov, getWidth() / getHeight(), 0.1, 100);
        const camY = mobile ? 2.3 : 1.9;
        const camZ = mobile ? 4.8 : 5.4;
        camera.position.set(0, camY, camZ);
        camera.lookAt(0, 0.45, 0);

        // 2b. Liberación total del scroll táctil nativo
        // pointer-events:none  → el canvas no captura ningún toque
        // touch-action:none    → le dice al browser que NO intente hacer pan/zoom en el canvas
        //                        (el scroll queda 100% en manos del thread del compositor)
        // will-change:transform → promueve el canvas a su propia capa GPU compuesta
        canvas.style.cssText += '; pointer-events: none !important; touch-action: none; will-change: transform;';

        // 3. WebGL Renderer – antialias desactivado en móvil para máximo rendimiento
        renderer = new THREE.WebGLRenderer({
            canvas,
            antialias: false,          // Desactivado globalmente en móvil; desktop lo recibirá optimizado
            alpha: true,
            powerPreference: mobile ? 'low-power' : 'high-performance',
            stencil: false,
            depth: true
        });

        // pixelRatio capado: 0.75 en gama baja, 1.0 en móvil, 1.75 en desktop
        const pixelRatio = Math.min(
            window.devicePixelRatio || 1,
            lowEnd ? 0.75 : (mobile ? 1.0 : 1.75)
        );
        renderer.setPixelRatio(pixelRatio);
        renderer.setSize(getWidth(), getHeight());
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = mobile ? 1.45 : 1.35;
        if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;

        // 4. Iluminación de Estudio Gastronómico
        const ambient = new THREE.AmbientLight(0xfff3db, mobile ? 0.85 : 0.7);
        scene.add(ambient);

        hemiLight = new THREE.HemisphereLight(0xffdf99, 0x2b1a0b, mobile ? 0.8 : 0.7);
        scene.add(hemiLight);

        keyLight = new THREE.DirectionalLight(0xffeed1, mobile ? 3.2 : 2.7);
        keyLight.position.set(3.8, 5.5, 3.5);
        scene.add(keyLight);

        const softFill = new THREE.DirectionalLight(0x7fb5f5, 0.35);
        softFill.position.set(-4.5, 3.0, -2.5);
        scene.add(softFill);

        goldRimLight = new THREE.PointLight(0xd4af37, mobile ? 4.8 : 4.0, 15, 1.8);
        goldRimLight.position.set(-1.6, 3.0, -2.2);
        scene.add(goldRimLight);

        underGlow = new THREE.PointLight(0xff7711, mobile ? 3.0 : 2.4, 8, 2);
        underGlow.position.set(0.2, -0.4, 0.6);
        scene.add(underGlow);

        if (!mobile) {
            const topSpot = new THREE.SpotLight(0xffe89e, 1.8, 14, Math.PI / 4.5, 0.45, 1.2);
            topSpot.position.set(0, 6.5, 1.8);
            topSpot.target.position.set(0, 0.45, 0);
            scene.add(topSpot);
            scene.add(topSpot.target);
        }

        // 5. Paleta de Materiales Culinarios de Lujo
        const gold24kMat = new THREE.MeshStandardMaterial({
            color: 0xf3ca52,
            roughness: 0.15,
            metalness: 0.96,
            emissive: 0x241703,
            emissiveIntensity: 0.08
        });

        const obsidianMat = new THREE.MeshStandardMaterial({
            color: 0x090909,
            roughness: 0.18,
            metalness: 0.25
        });

        // Pan Brioche Dorado Glaseado
        const bunMat = new THREE.MeshStandardMaterial({
            color: 0xc97a2e,
            roughness: 0.32,
            metalness: 0.08,
            emissive: 0x3d1c04,
            emissiveIntensity: 0.12
        });

        const sesameMat = new THREE.MeshStandardMaterial({
            color: 0xf5ecc6,
            roughness: 0.25,
            metalness: 0.3
        });

        // Carne Angus a la Brasa
        const pattyMat = new THREE.MeshStandardMaterial({
            color: 0x2b1509,
            roughness: 0.75,
            metalness: 0.15
        });

        // Queso Cheddar / Paipa Fundido Brillante
        const cheeseMat = new THREE.MeshStandardMaterial({
            color: 0xf5a418,
            roughness: 0.18,
            metalness: 0.12,
            emissive: 0x542d02,
            emissiveIntensity: 0.18
        });

        // Tomate Rojo Carmesí Fresco
        const tomatoMat = new THREE.MeshStandardMaterial({
            color: 0xd9231e,
            roughness: 0.15,
            metalness: 0.15
        });

        // Lechuga / Microgreens Verde Vibrante
        const lettuceMat = new THREE.MeshStandardMaterial({
            color: 0x3da32b,
            roughness: 0.45,
            metalness: 0.05,
            emissive: 0x0e3b08,
            emissiveIntensity: 0.1
        });

        // Tocino Crujiente Caramelizado
        const baconMat = new THREE.MeshStandardMaterial({
            color: 0x731a0e,
            roughness: 0.28,
            metalness: 0.25
        });

        // Papas Rústicas Doradas
        const fryMat = new THREE.MeshStandardMaterial({
            color: 0xde9b2a,
            roughness: 0.4,
            metalness: 0.08
        });

        // Aguacate Fresco
        const avocadoSkinMat = new THREE.MeshStandardMaterial({ color: 0x1b2e11, roughness: 0.7, metalness: 0.1 });
        const avocadoFleshMat = new THREE.MeshStandardMaterial({ color: 0x9ec736, roughness: 0.35, metalness: 0.05 });
        const avocadoPitMat = new THREE.MeshStandardMaterial({ color: 0x4a2810, roughness: 0.5, metalness: 0.1 });

        // Camarón Parrillado
        const shrimpMat = new THREE.MeshStandardMaterial({
            color: 0xf76d43,
            roughness: 0.3,
            metalness: 0.18,
            emissive: 0x421204,
            emissiveIntensity: 0.1
        });

        // Cristal y Líquido Cóctel
        const glassMat = !lowEnd
            ? new THREE.MeshPhysicalMaterial({
                color: 0xf5fcff, roughness: 0.03, transmission: 0.95, thickness: 0.45, ior: 1.5, transparent: true, opacity: 0.92
            })
            : new THREE.MeshStandardMaterial({ color: 0xe5f2ff, roughness: 0.1, transparent: true, opacity: 0.5 });

        const cocktailLiquidMat = new THREE.MeshStandardMaterial({
            color: 0xfcb034,
            roughness: 0.1,
            metalness: 0.15,
            transparent: true,
            opacity: 0.85,
            emissive: 0x543202,
            emissiveIntensity: 0.15
        });

        // 6. Construcción del Gran Banquete Master Group
        feastMasterGroup = new THREE.Group();
        scene.add(feastMasterGroup);

        // Segmentos optimizados para móvil/gama baja – ahorra GPU sin alterar la forma
        const radialSeg = lowEnd ? 20 : (mobile ? 36 : 80);
        const torusSeg  = lowEnd ? 6  : (mobile ? 9  : 20);

        // ----------------------------------------------------
        // A. GRAN BANDEJA DE BANQUETE (Obsidiana + Oro 24k)
        // ----------------------------------------------------
        const platterGroup = new THREE.Group();
        const baseGeo = new THREE.CylinderGeometry(2.1, 2.3, 0.14, radialSeg);
        const baseMesh = new THREE.Mesh(baseGeo, obsidianMat);
        baseMesh.position.y = -0.07;
        platterGroup.add(baseMesh);

        // Bisel de Oro 24K Exterior
        const outerGoldGeo = new THREE.TorusGeometry(2.12, 0.036, torusSeg, radialSeg);
        const outerGold = new THREE.Mesh(outerGoldGeo, gold24kMat);
        outerGold.rotation.x = -Math.PI / 2;
        outerGold.position.y = 0.005;
        platterGroup.add(outerGold);

        // Aro de Oro Interior
        const innerGoldGeo = new THREE.TorusGeometry(1.65, 0.024, torusSeg, radialSeg);
        const innerGold = new THREE.Mesh(innerGoldGeo, gold24kMat);
        innerGold.rotation.x = -Math.PI / 2;
        innerGold.position.y = 0.01;
        platterGroup.add(innerGold);

        feastMasterGroup.add(platterGroup);

        // ----------------------------------------------------
        // B. PLATO PRINCIPAL: IMPERIAL GOURMET BURGER
        // ----------------------------------------------------
        burgerGroup = new THREE.Group();
        const burgerSeg = lowEnd ? 12 : (mobile ? 20 : 28);

        // 1. Pan Inferior (Bottom Bun)
        const bottomBunGeo = new THREE.CylinderGeometry(0.55, 0.5, 0.16, burgerSeg);
        const bottomBun = new THREE.Mesh(bottomBunGeo, bunMat);
        bottomBun.position.y = 0.08;
        burgerGroup.add(bottomBun);

        // 2. Hoja de Lechuga Silvestre Rizada (Base)
        const lettuceGeo = new THREE.CylinderGeometry(0.68, 0.62, 0.04, burgerSeg);
        const lettuce = new THREE.Mesh(lettuceGeo, lettuceMat);
        lettuce.position.y = 0.17;
        lettuce.rotation.y = 0.3;
        burgerGroup.add(lettuce);

        // 3. Medallón Angus a la Parrilla (Thick Patty)
        const pattyGeo = new THREE.CylinderGeometry(0.58, 0.58, 0.22, burgerSeg);
        const patty = new THREE.Mesh(pattyGeo, pattyMat);
        patty.position.y = 0.29;
        burgerGroup.add(patty);

        // 4. Queso Cheddar/Paipa Fundido con Esquinas Onduladas
        const cheeseGeo = new THREE.BoxGeometry(0.92, 0.04, 0.92);
        const cheese = new THREE.Mesh(cheeseGeo, cheeseMat);
        cheese.position.y = 0.41;
        cheese.rotation.y = Math.PI / 4;
        burgerGroup.add(cheese);

        // 5. Tiras de Tocino Crujiente
        const baconGeo = new THREE.BoxGeometry(0.85, 0.03, 0.22);
        const bacon1 = new THREE.Mesh(baconGeo, baconMat);
        bacon1.position.set(0, 0.44, 0);
        bacon1.rotation.y = 0.35;
        burgerGroup.add(bacon1);

        const bacon2 = new THREE.Mesh(baconGeo, baconMat);
        bacon2.position.set(0, 0.45, 0);
        bacon2.rotation.y = -0.55;
        burgerGroup.add(bacon2);

        // 6. Rodajas de Tomate Fresco
        const tomatoGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.06, 16);
        const tomato1 = new THREE.Mesh(tomatoGeo, tomatoMat);
        tomato1.position.set(-0.16, 0.49, 0.12);
        tomato1.rotation.z = 0.05;
        burgerGroup.add(tomato1);

        const tomato2 = new THREE.Mesh(tomatoGeo, tomatoMat);
        tomato2.position.set(0.18, 0.50, -0.1);
        tomato2.rotation.z = -0.05;
        burgerGroup.add(tomato2);

        // 7. Pan Superior Glaseado (Top Brioche Bun)
        const topBunGeo = new THREE.SphereGeometry(0.58, burgerSeg, burgerSeg, 0, Math.PI * 2, 0, Math.PI / 2);
        const topBun = new THREE.Mesh(topBunGeo, bunMat);
        topBun.position.y = 0.54;
        topBun.scale.set(1, 0.65, 1);
        burgerGroup.add(topBun);

        // 8. Semillas de Sésamo Doradas en el Pan Superior
        const seedGeo = new THREE.ConeGeometry(0.016, 0.035, 5);
        const numSeeds = lowEnd ? 12 : 30;
        for (let s = 0; s < numSeeds; s++) {
            const seed = new THREE.Mesh(seedGeo, sesameMat);
            const theta = Math.random() * Math.PI * 2;
            const phi = 0.2 + Math.random() * 0.9;
            const r = 0.585;
            seed.position.set(
                r * Math.sin(phi) * Math.cos(theta),
                0.54 + r * Math.cos(phi) * 0.65,
                r * Math.sin(phi) * Math.sin(theta)
            );
            seed.lookAt(0, 0.54, 0);
            seed.rotation.x += Math.PI;
            burgerGroup.add(seed);
        }

        burgerGroup.position.set(-0.25, 0.0, -0.05);
        burgerGroup.rotation.y = 0.2;
        feastMasterGroup.add(burgerGroup);

        // ----------------------------------------------------
        // C. GUARNICIÓN: PAPAS RÚSTICAS DORADAS (Fries Stack)
        // ----------------------------------------------------
        friesGroup = new THREE.Group();
        const fryCount = lowEnd ? 8 : 16;
        for (let f = 0; f < fryCount; f++) {
            const len = 0.45 + Math.random() * 0.25;
            const singleFryGeo = new THREE.BoxGeometry(0.07, len, 0.07);
            const fry = new THREE.Mesh(singleFryGeo, fryMat);
            const angle = (f / fryCount) * Math.PI * 1.8;
            fry.position.set(
                Math.cos(angle) * 0.18 + (Math.random() - 0.5) * 0.08,
                len * 0.45,
                Math.sin(angle) * 0.18 + (Math.random() - 0.5) * 0.08
            );
            fry.rotation.set((Math.random() - 0.5) * 0.4, Math.random() * Math.PI, (Math.random() - 0.5) * 0.4);
            friesGroup.add(fry);
        }
        friesGroup.position.set(0.95, 0.0, -0.65);
        feastMasterGroup.add(friesGroup);

        // ----------------------------------------------------
        // D. AGUACATE HASS SEÑORIAL PARRILLADO
        // ----------------------------------------------------
        avocadoGroup = new THREE.Group();
        const avoOuterGeo = new THREE.SphereGeometry(0.38, 16, 16, 0, Math.PI * 2, 0, Math.PI / 2);
        avoOuterGeo.scale(0.85, 1.25, 0.65);
        const avoSkin = new THREE.Mesh(avoOuterGeo, avocadoSkinMat);
        avoSkin.rotation.x = Math.PI;
        avocadoGroup.add(avoSkin);

        const avoFleshGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.04, 16);
        avoFleshGeo.scale(0.85, 1, 1.25);
        const avoFlesh = new THREE.Mesh(avoFleshGeo, avocadoFleshMat);
        avoFlesh.position.y = 0.01;
        avocadoGroup.add(avoFlesh);

        // Semilla / Hueso de Aguacate
        const pitGeo = new THREE.SphereGeometry(0.14, 12, 12);
        const pit = new THREE.Mesh(pitGeo, avocadoPitMat);
        pit.position.set(0, 0.06, 0.1);
        pit.scale.set(0.9, 1.1, 0.9);
        avocadoGroup.add(pit);

        avocadoGroup.position.set(-0.95, 0.06, 0.7);
        avocadoGroup.rotation.set(-0.25, 0.8, 0.35);
        feastMasterGroup.add(avocadoGroup);

        // ----------------------------------------------------
        // E. CAMARÓN JUMBO MARINADO AL CARBÓN
        // ----------------------------------------------------
        shrimpGroup = new THREE.Group();
        const shrimpCurve = new THREE.CatmullRomCurve3([
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(0.18, 0.15, 0),
            new THREE.Vector3(0.32, 0.08, 0),
            new THREE.Vector3(0.28, -0.12, 0)
        ]);
        const shrimpGeo = new THREE.TubeGeometry(shrimpCurve, 18, 0.065, 8, false);
        const shrimp = new THREE.Mesh(shrimpGeo, shrimpMat);
        shrimpGroup.add(shrimp);

        const shrimpTailGeo = new THREE.ConeGeometry(0.08, 0.16, 4);
        const shrimpTail = new THREE.Mesh(shrimpTailGeo, shrimpMat);
        shrimpTail.position.set(0.28, -0.18, 0);
        shrimpTail.rotation.z = Math.PI * 0.8;
        shrimpGroup.add(shrimpTail);

        shrimpGroup.position.set(0.55, 0.15, 0.75);
        shrimpGroup.rotation.set(0.4, -0.5, 0.2);
        feastMasterGroup.add(shrimpGroup);

        // ----------------------------------------------------
        // F. CÓCTEL IMPERIAL DE GALA CON BURBUJAS ACTIVAS
        // ----------------------------------------------------
        cocktailGroup = new THREE.Group();

        // Copa de Cristal
        const glassBowlGeo = new THREE.CylinderGeometry(0.26, 0.12, 0.45, 18, 1, true);
        const glassBowl = new THREE.Mesh(glassBowlGeo, glassMat);
        glassBowl.position.y = 0.55;
        cocktailGroup.add(glassBowl);

        // Líquido Ámbar / Frutal
        const liquidGeo = new THREE.CylinderGeometry(0.24, 0.13, 0.38, 16);
        const liquid = new THREE.Mesh(liquidGeo, cocktailLiquidMat);
        liquid.position.y = 0.52;
        cocktailGroup.add(liquid);

        // Tallo y Base de Cristal
        const stemGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.32, 8);
        const stem = new THREE.Mesh(stemGeo, glassMat);
        stem.position.y = 0.22;
        cocktailGroup.add(stem);

        const footGeo = new THREE.CylinderGeometry(0.18, 0.19, 0.03, 16);
        const foot = new THREE.Mesh(footGeo, glassMat);
        foot.position.y = 0.04;
        cocktailGroup.add(foot);

        // Rodaja de Cítrico / Naranja en el Borde
        const citrusGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.02, 12);
        const citrus = new THREE.Mesh(citrusGeo, gold24kMat);
        citrus.position.set(0.24, 0.78, 0);
        citrus.rotation.z = Math.PI / 3;
        cocktailGroup.add(citrus);

        // Burbujas efervescentes
        bubbles = [];
        const bubbleGeo = new THREE.SphereGeometry(0.015, 5, 4);
        const bubbleMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.1, transparent: true, opacity: 0.75 });
        const numBubbles = lowEnd ? 5 : 12;
        for (let b = 0; b < numBubbles; b++) {
            const bub = new THREE.Mesh(bubbleGeo, bubbleMat);
            bub.userData = {
                radius: Math.random() * 0.14,
                angle: Math.random() * Math.PI * 2,
                speed: 0.3 + Math.random() * 0.6,
                phase: Math.random() * Math.PI * 2
            };
            bubbles.push(bub);
            cocktailGroup.add(bub);
        }

        cocktailGroup.position.set(1.05, 0.0, 0.25);
        feastMasterGroup.add(cocktailGroup);

        // ----------------------------------------------------
        // G. GOTAS DE SALSA GOURMET & CAVIAR DECORATIVO
        // ----------------------------------------------------
        sauceDropsGroup = new THREE.Group();
        const dropGeo = new THREE.SphereGeometry(0.038, 8, 8);
        const dropMat = new THREE.MeshStandardMaterial({ color: 0x3d0b04, roughness: 0.1, metalness: 0.3 });
        for (let d = 0; d < 8; d++) {
            const drop = new THREE.Mesh(dropGeo, d % 2 === 0 ? dropMat : gold24kMat);
            const a = (d / 8) * Math.PI * 2;
            const rad = 1.35 + (d % 3) * 0.12;
            drop.position.set(Math.cos(a) * rad, 0.025, Math.sin(a) * rad);
            drop.scale.set(1.2, 0.3, 1.2);
            sauceDropsGroup.add(drop);
        }
        feastMasterGroup.add(sauceDropsGroup);

        // ----------------------------------------------------
        // H. POLVO DE ORO & ESPECIAS FLOTANTES
        // ----------------------------------------------------
        const dustCount = lowEnd ? 15 : (mobile ? 30 : 90);
        goldDustGeo = new THREE.BufferGeometry();
        const dustPositions = new Float32Array(dustCount * 3);
        goldDustSpeeds = new Float32Array(dustCount);
        goldDustPhases = new Float32Array(dustCount);

        const spreadX = mobile ? 5.5 : 8.5;
        const spreadZ = mobile ? 4.5 : 7.0;

        for (let i = 0; i < dustCount; i++) {
            dustPositions[i * 3] = (Math.random() - 0.5) * spreadX;
            dustPositions[i * 3 + 1] = Math.random() * 5.0;
            dustPositions[i * 3 + 2] = (Math.random() - 0.5) * spreadZ;
            goldDustSpeeds[i] = 0.002 + Math.random() * 0.004;
            goldDustPhases[i] = Math.random() * Math.PI * 2;
        }

        goldDustGeo.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
        const dustMat = new THREE.PointsMaterial({
            color: 0xf7d268,
            size: lowEnd ? 0.06 : (mobile ? 0.05 : 0.038),
            transparent: true,
            opacity: 0.75,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            sizeAttenuation: true
        });
        goldDustPoints = new THREE.Points(goldDustGeo, dustMat);
        scene.add(goldDustPoints);

        // Suelo reflectivo oscuro
        const groundGeo = new THREE.CircleGeometry(mobile ? 14 : 18, lowEnd ? 16 : 32);
        const groundMat = new THREE.MeshStandardMaterial({ color: 0x030303, roughness: 0.98, metalness: 0.02 });
        const ground = new THREE.Mesh(groundGeo, groundMat);
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = -0.42;
        scene.add(ground);

        feastMasterGroup.position.set(0, 0.05, 0);
        feastMasterGroup.rotation.y = -0.55;

        // 7. Observers y Ciclo de Vida GPU
        setupObservers(heroSection, canvas);
        resumeLoop();
    }

    function computeRawScroll() {
        const heroSection = document.getElementById('hero-3d-section');
        const heroH = heroSection ? heroSection.offsetHeight : window.innerHeight;
        const y = window.scrollY || window.pageYOffset || 0;
        if (heroH <= 0) return 0;
        return Math.max(0, Math.min(1, y / heroH));
    }

    // Flag para disparar sceneLoaded solo una vez al primer frame renderizado
    let _firstFrameFired = false;

    function animate() {
        if (!isRunning) return;

        rafId = requestAnimationFrame(animate);

        // Si el Hero no está visible en pantalla o la vista no es el menú, no renderizar
        if (!heroVisible || !viewActive) return;

        const now = performance.now();
        const dt = Math.min((now - lastTime) / 1000, 0.05);
        lastTime = now;

        const mobile = isMobile();
        const rawScroll = computeRawScroll();

        // ─── CORRECCIÓN C: Lerp de scroll ───────────────────────────────────
        // En móvil usamos smoothFactor = 1.0 (mapeo directo 1:1).
        // Esto elimina el lag matemático acumulativo: el objeto sigue al dedo
        // en tiempo real aunque el deslizamiento sea lento o corto.
        // En desktop mantenemos 0.55 para suavizado cinético de rueda de ratón.
        const smoothFactor = mobile ? 1.0 : 0.55;
        scrollState.progress += (rawScroll - scrollState.progress) * smoothFactor;
        const s = scrollState.progress;
        const elapsed = clock.getElapsedTime();

        // ─── CORRECCIÓN B: Sensibilidad extrema ─────────────────────────────
        // Y ×18  → giro drástico con poco scroll (era 4.5)
        // X ×0.85 → inclinación muy notoria       (era 0.45)
        // posZ ×1.2 → parallax profundo inmediato  (era 0.60)
        if (feastMasterGroup) {
            feastMasterGroup.rotation.y = -0.55 + s * 18 + elapsed * (mobile ? 0.10 : 0.075);
            feastMasterGroup.rotation.x = s * 0.85;
            feastMasterGroup.position.y = 0.05 + Math.sin(elapsed * 1.1) * 0.035 - s * 0.30;
            feastMasterGroup.position.z = s * 1.2;
        }

        // 2. Micro-animaciones de apetito en elementos culinarios
        if (burgerGroup) {
            burgerGroup.position.y = Math.sin(elapsed * 1.4) * 0.015;
            burgerGroup.rotation.y = 0.2 + Math.sin(elapsed * 0.8) * 0.03;
        }

        if (cocktailGroup) {
            cocktailGroup.position.y = Math.sin(elapsed * 1.2 + 0.5) * 0.02;
            for (let i = 0; i < bubbles.length; i++) {
                const b = bubbles[i];
                const t = (elapsed * b.userData.speed + i * 0.3) % 1;
                const angle = b.userData.angle + t * 0.3;
                b.position.set(
                    Math.cos(angle) * b.userData.radius,
                    0.35 + t * 0.35,
                    Math.sin(angle) * b.userData.radius
                );
                b.scale.setScalar(0.5 + t * 0.7);
            }
        }

        if (shrimpGroup) {
            shrimpGroup.position.y = 0.15 + Math.sin(elapsed * 1.3 + 1.0) * 0.015;
        }

        if (avocadoGroup) {
            avocadoGroup.position.y = 0.06 + Math.sin(elapsed * 1.1 + 0.8) * 0.015;
        }

        // 3. Modulación de Iluminación de Estudio
        if (goldRimLight) goldRimLight.intensity = (mobile ? 4.8 : 4.0) + Math.sin(elapsed * 1.5) * 0.5;
        if (underGlow) underGlow.intensity = (mobile ? 3.0 : 2.4) + Math.sin(elapsed * 1.2) * 0.4;
        if (hemiLight) hemiLight.intensity = 0.55 + Math.sin(elapsed * 0.8) * 0.05;

        // 4. Polvo de Oro & Especias Flotantes
        if (goldDustPoints && goldDustGeo) {
            const pos = goldDustGeo.attributes.position.array;
            const spreadX = mobile ? 5.5 : 8.5;
            const spreadZ = mobile ? 4.5 : 7.0;
            for (let i = 0; i < goldDustSpeeds.length; i++) {
                const idx = i * 3;
                pos[idx + 1] += goldDustSpeeds[i];
                pos[idx] += Math.sin(elapsed * 0.45 + goldDustPhases[i]) * 0.0012;
                pos[idx + 2] += Math.cos(elapsed * 0.35 + goldDustPhases[i]) * 0.0010;
                if (pos[idx + 1] > 5.0) {
                    pos[idx + 1] = -0.2;
                    pos[idx] = (Math.random() - 0.5) * spreadX;
                    pos[idx + 2] = (Math.random() - 0.5) * spreadZ;
                }
            }
            goldDustGeo.attributes.position.needsUpdate = true;
        }

        // 5. Interpolación Suave de Cámara
        if (camera) {
            const baseCamY = mobile ? 2.3 : 1.9;
            const baseCamZ = mobile ? 4.8 : 5.4;
            const targetCamX = -s * (mobile ? 0.6 : 0.9);
            const targetCamY = baseCamY + s * (mobile ? 0.7 : 1.0);
            const targetCamZ = baseCamZ + s * (mobile ? 1.4 : 1.8);
            camera.position.x += (targetCamX - camera.position.x) * 0.14;
            camera.position.y += (targetCamY - camera.position.y) * 0.14;
            camera.position.z += (targetCamZ - camera.position.z) * 0.14;
            camera.lookAt(0, 0.45 - s * 0.10, 0);
        }

        if (renderer && scene && camera) {
            renderer.render(scene, camera);

            // Punto 1: dispara sceneLoaded en el PRIMER frame renderizado exitosamente
            if (!_firstFrameFired) {
                _firstFrameFired = true;
                window.dispatchEvent(new Event('sceneLoaded'));
            }
        }
    }

    function pauseLoop() {
        if (!isRunning) return;
        isRunning = false;
        cancelAnimationFrame(rafId);
    }

    function resumeLoop() {
        if (isRunning) return;
        isRunning = true;
        lastTime = performance.now();
        rafId = requestAnimationFrame(animate);
    }

    function setupObservers(heroSection, canvas) {
        // 1. IntersectionObserver para CERO consumo de GPU al hacer scroll fuera del Hero
        if ('IntersectionObserver' in window) {
            const heroObserver = new IntersectionObserver((entries) => {
                entries.forEach((entry) => {
                    heroVisible = entry.isIntersecting;
                    if (heroVisible && viewActive) {
                        resumeLoop();
                    } else {
                        pauseLoop();
                    }
                });
            }, { threshold: 0, rootMargin: '60px' });
            heroObserver.observe(heroSection);
        }

        // 2. Redimensionamiento del Viewport
        let resizeRAF;
        const onResize = () => {
            cancelAnimationFrame(resizeRAF);
            resizeRAF = requestAnimationFrame(() => {
                if (!camera || !renderer || !heroSection) return;
                const w = heroSection.clientWidth || window.innerWidth;
                const h = heroSection.clientHeight || window.innerHeight;
                camera.aspect = w / h;
                camera.updateProjectionMatrix();
                renderer.setSize(w, h);
            });
        };
        window.addEventListener('resize', onResize, { passive: true });
        window.addEventListener('orientationchange', onResize, { passive: true });

        // 3. Tab Visibility (Ahorro de batería y recursos)
        if (typeof document.visibilityState !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible' && heroVisible && viewActive) {
                    clock.start();
                    lastTime = performance.now();
                    resumeLoop();
                } else {
                    pauseLoop();
                }
            }, { passive: true });
        }

        // 4. Liberación de Recursos GPU
        window.addEventListener('pagehide', () => {
            pauseLoop();
            if (renderer) renderer.dispose();
            if (scene) {
                scene.traverse(obj => {
                    if (obj.isMesh) {
                        if (obj.geometry) obj.geometry.dispose();
                        if (obj.material) {
                            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                            mats.forEach(m => m.dispose && m.dispose());
                        }
                    }
                });
            }
        }, { once: true });
    }

    // Ganchos Globales para Ciclo de Vida en ui.js / setView
    window.__heroPause = function () {
        viewActive = false;
        pauseLoop();
    };

    window.__heroResume = function () {
        viewActive = true;
        if (heroVisible) {
            clock.start();
            lastTime = performance.now();
            resumeLoop();
        }
    };

    // Inicialización al cargar el DOM
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initScene);
    } else {
        initScene();
    }

})();
