# PROMPT MAESTRO · KingMenu Premium: plan de correcciones y mejoras

## Instrucciones para el asistente (leer primero)

Eres un desarrollador senior full-stack (Firebase, JS vanilla, seguridad web, UX).
Trabajas sobre el proyecto **KingMenu Premium** (HTML + JS modular + Tailwind + Three.js + Firebase Auth/Firestore, desplegado en Netlify).

Reglas de trabajo:
1. **Flujo de trabajo autónomo y continuo:** Ejecuta el plan de forma fluida, tarea por tarea y fase por fase, sin pausar a pedir confirmaciones manuales ni esperar aprobaciones intermedias.
2. **Cero errores y máxima precisión:** Completa cada tarea al 100% cumpliendo estrictamente sus criterios de aceptación antes de pasar a la siguiente.
3. **Resumen de cambios:** Antes de modificar un archivo, lee la función/sección indicada y genera un breve registro interno del cambio.
4. **Respeto al alcance:** No refactorices ni modifiques elementos fuera de la tarea en curso. Mantén cambios mínimos, limpios y completamente verificables.
5. **Entrega por tarea:** Al finalizar cada sub-tarea, documenta brevemente: (a) archivos modificados, (b) qué cambió, (c) cómo probarlo, (d) criterio de aceptación cumplido.
6. **Configuraciones externas:** Si una tarea requiere acciones fuera del código (consola de Firebase, Netlify, plan Blaze), indícala claramente con pasos exactos en el reporte final.

Ubicaciones útiles: `index.html`, `css/styles.css`, `js/app.js`, `js/ui.js` (~3.600 líneas), `js/firebase-service.js`, `js/i18n.js`, `js/animations.js`, `js/product-3d.js`, `js/three-scene.js`, `firestore.rules`.

---

## FASE 0 · Preparación (antes de tocar nada)

- [x] **0.1** Inicializar Git y crear `.gitignore` (excluye `.agents/`, `.trae/`, `.vscode/`, `desktop.ini`, `node_modules/` y `dist/`).
- [x] **0.2** Omitida por instrucción del usuario, quien confirma que `kingmenu-caa89` es staging. No se creó un segundo proyecto ni configuración separada por entorno.
- [x] **0.3** Omitida por instrucción del usuario al confirmar que el proyecto solo contiene datos demo. No se exportó ni generó un backup de Firestore.
- [ ] **0.4** Configuración Netlify añadida para publicar solo `index.html`, `css/` y `js/`, con rutas bloqueadas para `/.agents/`, `/.trae/`, `/models/` y `/firestore.rules`. Falta desplegar y comprobar las URLs públicas.
- [ ] **0.5** La consulta de solo lectura encontró demos en staging (incluye “Aguacate Parrillado Rey (AR Demo)” y GLB de muestra). No se borró ningún documento: falta acceso autenticado de owner/Console para limpiar los registros exactos.

**Aceptación:** repo versionado, staging funcionando, backup hecho, carpetas internas no públicas.

---

## FASE 1 · Seguridad crítica (BLOQUEANTE para vender)

### 1.1 XSS almacenado en llamados a mesero
- **Archivo:** `js/ui.js` → `renderCalls()` (~L2033).
- **Problema:** `Mesa ${c.table || 'S/M'}` se inserta sin escapar. Un anónimo puede guardar HTML/JS en `calls.table` y se ejecuta en la sesión del dueño (podría hacerse owner a sí mismo).
- [x] Escapar `c.table` con la función de escape; el ID del llamado usa atributo de datos con listener delegado.
- [x] Renombrar `experienceText` → `escapeHtml`, exportado desde `js/utils/escape.js`, y actualizar sus usos.
- [x] Auditar y escapar los datos interpolados de Firestore/cliente revisados en `innerHTML`, incluidos `ownerName`, `ownerTable`, nombres de ítems, notas, reseñas, cantidades, URLs de imágenes e ingredientes.
- **Aceptación:** [ ] Las comprobaciones estáticas pasaron; falta ejecutar la prueba de inyección especificada en navegador/emulador.

### 1.2 Handlers inline vulnerables
- **Archivos:** `index.html`, `js/ui.js`, `js/app.js` (26 handlers inline en templates + ~120 `window.*`).
- **Problema:** `onclick="window.updateOrderStatus('${id}'...)"` y `resolveCall('${c.id}')`: el escape HTML no protege dentro de strings JS en atributos, y el ID del documento lo elige el cliente.
- [x] Reemplazar los handlers de `index.html` y las plantillas de `js/ui.js` por `data-action` / `data-*` y listeners delegados.
- [x] Eliminar los bindings globales `window.*` que solo existían para handlers inline; los eventos dinámicos de imágenes y archivos usan listeners programáticos.
- **Aceptación:** [x] No quedan atributos `onclick`, `oninput`, `onerror` u otros `on*` inline en `index.html` ni en las plantillas de `js/ui.js`. La validación estática pasó; la prueba interactiva en navegador queda pendiente.

### 1.3 Reglas de Firestore (`firestore.rules`)
- [x] **Fijar `appId`:** todos los permisos de las colecciones se limitan a `appId == 'kingmenu-caa89'`.
- [x] **`calls`:** esquema cerrado, mesa de 1–3 dígitos, UID autenticado y timestamp de servidor.
- [x] **`orders`:** estado inicial `Recibido`, esquema cerrado, 1–50 ítems, límites de nombre/mesa/notas y timestamp de servidor.
- [x] **`staffOrders`:** límites de campos y datos equivalentes; la creación del cliente debe corresponder a un pedido creado en el mismo batch. El backfill del owner se mantiene; migrar la creación exclusivamente a Cloud Function queda para 1.4.
- [x] **`reviews`:** ID determinista `{uid}_{productId}` para impedir una segunda reseña del mismo usuario por platillo; timestamp de servidor.
- [ ] Añadir y ejecutar pruebas con el **Firebase Emulator** (casos permitidos y denegados); no se ejecutaron porque Node.js/Firebase CLI y un proyecto de pruebas no están disponibles en el entorno.
- **Aceptación:** [ ] Falta validar en el emulador que los intentos inválidos y los de otro `appId` sean rechazados antes de desplegar las reglas.

### 1.4 Precios y totales calculados en el servidor
- **Archivos:** `js/ui.js` → `submitOrder()`, `js/firebase-service.js` → `createOrder()`.
- **Problema:** el cliente envía `price` y `total`; cualquiera puede mandar un pedido de $1.
- [x] Añadir Cloud Function callable `createOrder`: recibe solo IDs/cantidades/notas, lee catálogo, valida disponibilidad y calcula precios/descuentos en servidor; escribe `orders` y `staffOrders` en una transacción.
- [x] El cliente solicita solo los datos necesarios y no envía precio ni total; la callable devuelve el ID de orden y conserva una clave idempotente ante reintentos del mismo payload.
- [x] Reglas: denegar creación directa en `orders`; solo owner puede crear `staffOrders` desde cliente para backfill. Las escrituras de la callable usan Admin SDK.
- [x] Límites configurados por función: 5 pedidos por UID y 12 por mesa cada 60 segundos; máximo 50 líneas, 20 unidades por línea, campos y total acotados.
- [ ] Mover cálculo de ventas/analítica a documentos resumen (ver 3.3).
- **Aceptación:** [ ] No desplegada ni probada en emulator: falta instalar dependencias/usar Firebase CLI y confirmar plan Blaze para producción. Las comprobaciones estáticas pasaron, pero el cálculo real del total y los límites deben verificarse antes de habilitar clientes.

### 1.5 Anti-abuso
- [x] Cliente configurado para inicializar **Firebase App Check** con reCAPTCHA Enterprise usando la meta `firebase-app-check-site-key`; `createOrder`, `createWaiterCall` y `generateTableQr` exigen App Check. Falta registrar el proveedor/site key y activar enforcement en Firebase Console para Firestore y Authentication.
- [ ] Restringir la **API key** por dominio (HTTP referrers) en Google Cloud Console. Pendiente porque no se conocen/validaron aquí los dominios exactos de staging y producción.
- [x] **Mesa por QR:** menú lee `?m=<mesa>&s=<firma>`, la firma HMAC la genera la callable `generateTableQr` accesible solo a owners, la mesa ya no es editable y la firma se valida en servidor tanto para pedidos como llamados. El panel owner genera y muestra el QR/enlace.
- [x] Throttle servidor en `createWaiterCall`: una llamada por mesa cada 60 segundos; la UI impide toques repetidos mientras la solicitud está en curso. Las escrituras directas a `calls` quedan denegadas en reglas.
- [x] Moderación de reseñas: botón de eliminar visible solo para owners y operación `deleteReview` protegida también por reglas.
- [ ] **Aceptación externa pendiente:** configurar el secret `TABLE_QR_SECRET` para Cloud Functions; instalar dependencias, probar QR válido/inválido, pedidos y throttle en Emulator; registrar reCAPTCHA Enterprise y su dominio, rellenar la meta site key, activar enforcement de App Check en Firestore/Auth/Functions y restringir la API key con los dominios aprobados. No se ha desplegado ni activado enforcement desde este entorno.

**Pasos de configuración pendientes (staging/producción):**
1. Generar un secreto aleatorio de al menos 32 bytes (por ejemplo, `openssl rand -hex 32`) y configurarlo con `firebase functions:secrets:set TABLE_QR_SECRET`; no guardar el valor en el repositorio. Para Functions Emulator, definirlo en `functions/.secret.local` y no versionar ese archivo.
2. En Firebase Console → App Check, registrar la app web con reCAPTCHA Enterprise y los dominios de staging/producción aprobados. Copiar la site key pública al `content` de la meta `firebase-app-check-site-key` en `index.html`; luego activar enforcement para Cloud Firestore, Authentication y Cloud Functions.
3. En Google Cloud Console → APIs y servicios → Credenciales, restringir la API key de Firebase a los dominios HTTP referrer exactos de staging/producción y a las APIs Firebase que use la app. No activar la restricción antes de probar ambos dominios.
4. Con Node 20, npm y Firebase CLI disponibles, instalar `functions` y ejecutar pruebas en Emulator para: QR válido/alterado, llamada duplicada o dentro de 60 s, pedido sin firma y borrado de reseña como owner frente a employee. Desplegar Functions y reglas solo tras aprobar esas pruebas.

### 1.6 Acceso administrativo
- [x] Mover login a una vista propia cargada solo en `/admin`, con rewrite de Netlify; quitar el acceso por "6 toques al logo".
- [x] MFA de owner: el login soporta el segundo factor SMS y Firestore/`generateTableQr` exigen el claim de segundo factor para operaciones owner.
- [ ] Habilitar MFA en Firebase Authentication, inscribir/verificar los teléfonos de las cuentas owner y probar el flujo en el emulador/proyecto de staging.
- [x] Retirar el texto que exponía los roles de Firebase. El formulario y el panel se mantienen fuera del HTML público inicial y se cargan en rutas/sesiones administrativas; Firestore Rules siguen siendo el control de autorización, no la visibilidad del frontend.
- [x] Eliminar los accesos por `window.__app_id`, `window.__firebase_config` y `window.__initial_auth_token`; la aplicación usa la configuración Firebase explícita del servicio y autenticación anónima.
- [ ] **Aceptación pendiente:** configurar el rewrite en el hosting desplegado y probar `/admin`, empleado/owner y MFA. El archivo del panel es un recurso estático público; ocultar la UI no sustituye las reglas y controles del servidor.

**Configuración de MFA pendiente:** Firebase Console → Authentication → Sign-in method → Multi-factor authentication: habilitar SMS MFA; verificar que cada owner tiene un factor SMS inscrito. Las reglas actuales deniegan las operaciones de owner sin `firebase.sign_in_second_factor` (`phone` o `totp`), y la interfaz de login implementa el challenge SMS. Asegurar que los owners registren el segundo factor antes de desplegar las reglas actualizadas.

### 1.7 Cabeceras de seguridad
- [x] Configurar en `netlify.toml`: `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy` y `frame-ancestors 'none'`.
- [x] Añadir `integrity` (SRI) + `crossorigin` a Tone.js y GSAP, que están fijados por versión y sirven CORS.
- [ ] Sustituir Tailwind Play CDN por un build estático/versionado para poder aplicar SRI; el CDN actual no envía `Access-Control-Allow-Origin` y el navegador bloquea el script al usar `crossorigin`.
- [ ] Verificar las cabeceras y ausencia de bloqueos CSP en el hosting desplegado.
- **Nota:** `unsafe-eval` sigue siendo necesario mientras Tailwind se cargue desde su CDN de desarrollo; eliminarlo corresponde a Fase 6.1.

---

## FASE 2 · Integridad de datos y bugs funcionales

- [x] **2.1 Doble envío de pedido:** bloqueo de envío y botón deshabilitado durante la petición; la callable conserva el mismo ID idempotente al reintentar el mismo payload.
- [x] **2.2 Salidas silenciosas:** carrito/checkout vacío o sin total muestran explicación; al cargar catálogo se eliminan del carrito los IDs que ya no existen.
- [x] **2.3 Carrito en `localStorage`:** esquema validado, `qty` entero 1–20, ID validado contra el catálogo, caducidad de 4 h y limpieza al vaciar/enviar.
- [x] **2.4 Parpadeo de catálogo demo:** catálogo vacío hasta recibir Firestore; el módulo de datos demo se importa solo al solicitar si `kingmenu-environment=staging`.
- [x] **2.5 Resiembra automática:** eliminado el auto-seed; el botón explícito y el módulo de datos solo están disponibles en staging.
- [x] **2.6 Re-render excesivo:** grilla pública reconcilia tarjetas por ID y conserva nodos sin cambios; reseñas no repintan la experiencia y el detalle solo se actualiza si cambia ese producto.
- [x] **2.7 Categorías:** campo `order` y controles arriba/abajo; al renombrar se sincroniza `categoryEn`; no se permite borrar categorías con productos asignados.
- [x] **2.8 Estados de cocina:** transición secuencial validada en UI/servicio/reglas; se registra UID del responsable y timestamp de servidor.
- [x] **2.9 Notas visibles en cocina:** sustituidas las clases inexistentes por tonos Rose válidos de Tailwind.
- [x] **2.10 IDs rotos:** retiradas las referencias a `hero-bg-image` y `user-discovery-*`.
- [x] **2.11 Escape y foco:** Escape cierra primero modal/drawer abierto y restaura el foco al control que lo abrió.
- **Validación pendiente:** no hay Node/Firebase CLI en este entorno; probar reglas, pedidos, migraciones y transiciones en Emulator antes del despliegue.

---

## FASE 3 · Imágenes, datos y costos

### 3.1 Sacar las fotos de Firestore (prioridad alta)
- **Archivos:** `ui.js` (`readImageAsDataUrl`, `applyAdminImageCrop`, `saveProduct`), `firebase-service.js` (`normalizeProductImages`).
- [x] Subir imágenes a **Firebase Storage** con reglas de escritura solo-owner.
- [x] Redimensionar en el cliente antes de subir (máx. 1600 px, calidad ~0.8) y generar **WebP** en 2–3 tamaños (400/800/1600).
- [x] Guardar en el producto solo URLs (`imageUrl`, `imageUrls[]`); **no guardar el `original` en el documento**.
- [x] Validar tamaño/tipo antes de subir y mostrar progreso y errores claros.
- [x] Script de **migración** de los productos existentes (Base64 → Storage), con dry-run por defecto.
- [x] Usar `srcset`, `sizes`, `width`/`height` y `loading="lazy"` en tarjetas (evita CLS).
- **Aceptación pendiente:** configurar el bucket real, desplegar Storage Rules, ejecutar y verificar la migración; comprobar que cada documento queda < 20 KB y que el menú inicial descarga < 1 MB de Firestore.

### 3.2 Caché y lecturas
- [ ] Inicializar Firestore con `persistentLocalCache` (multi-pestaña).
- [ ] **Reseñas:** dejar de escuchar toda la colección. Guardar `ratingAvg`/`ratingCount` en el producto (Cloud Function trigger) y cargar reseñas del plato solo al abrir su detalle, paginadas.
- [ ] **Pedidos del owner:** limitar a rango de fechas/`limit()` y paginar el histórico.
- [ ] Quitar `backfillStaffOrders` de cada inicio de sesión (migración única o Function).

### 3.3 Analítica en servidor
- [ ] Documentos resumen por día (`stats/{yyyy-mm-dd}`: ingresos, nº pedidos, ticket promedio, top platos) mantenidos por Cloud Function.
- [ ] El panel owner lee solo esos resúmenes (no todos los pedidos).
- [ ] Revisar el botón "reset ventas": que no destruya trazabilidad (conservar histórico).

---

## FASE 4 · Chef "IA" y alérgenos (riesgo legal)

- **Archivo:** `js/ui.js` → `runDonImperialChatEngine()` (~L3086).
- [x] **Eliminar recomendaciones por alergia/intolerancia.** Ante consultas de alergia responder solo con los **alérgenos declarados** del plato y "Confirme con el personal"; sin botón de añadir al carrito en esas respuestas.
- [x] Manejar **negaciones** ("no quiero mariscos", "sin carne") y excluir platos que contengan el término.
- [x] Hacer obligatorio el campo de alérgenos al crear un plato, con "No declarado" como valor inicial.
- [x] Renombrar a **"Asistente de carta"** y quitar la presentación como IA.
- [x] Quitar el `setTimeout` que simulaba "meditar".
- [x] Renombrar el botón de texto generado por plantilla a **"Completar plantilla"**.
- **Aceptación:** verificado en navegador con "Soy alérgico a los mariscos": muestra solo los alérgenos declarados, instruye confirmar con el personal y no ofrece tarjetas ni acciones de carrito.

---

## FASE 5 · UX, interfaz y diseño

### 5.1 Entrada directa a la carta
- [x] Eliminar la pantalla "SISTEMA DE ACCESO" y la barra falsa de 5,2 s (`runWarpSequence` en `animations.js`).
- [x] Ir directamente a categorías; al elegir una categoría, sus platillos aparecen tras un toque. No se muestra una intro intermedia.
- [x] Meta de interacción verificada en navegador local: categorías al entrar y primer listado de platillos después de un toque. El umbral de tiempo de producción aún requiere medir en staging con red real.
- [x] Quitar textos decorativos falsos ("Conexión: Estable", "Interfaz: Óptima", "Comensales: En línea").

### 5.2 Identidad visual única
- [ ] Decidir una dirección: **lujo caribeño** (negro, dorado, serif, fotografía grande) o sci-fi. Recomendado: lujo caribeño.
- [ ] Definir **design tokens** en `:root` (colores, tipografías, espaciados, radios) y usarlos en Tailwind config y `styles.css` (hoy hay colores sueltos: `#030407`, `#ff007f`, cian).
- [ ] Reescribir textos "estelares/telemetría" con el tono de la marca.
- [ ] La foto del plato debe ser la protagonista de la tarjeta.

### 5.3 Idioma
- [x] Mover el botón **ES/EN** a la cabecera visible de la experiencia.
- [x] Detectar `navigator.language` en la primera visita cuando no hay idioma guardado.
- [ ] Pasar a `t()` todo el texto fijo del landing, categorías, carrito y toasts. El landing fue retirado; el menú, las categorías y los textos principales del carrito ya usan traducciones. Se migraron a `t()` los mensajes del flujo de carrito y el calculador de cuenta; quedan textos heredados y toasts de otros flujos que todavía usan condicionales.
- [x] Sincronizar `<html lang>` al inicializar el módulo y al cambiar idioma.

### 5.4 Accesibilidad
- [x] Quitar `maximum-scale=1.0, user-scalable=no` del viewport.
- [x] `role="dialog"`, `aria-modal="true"`, `aria-labelledby` y **focus trap** en modales/drawers; restaurar foco al cerrarlos.
- [x] Nombres accesibles para botones de solo icono, controles de calificación y campos de formulario; carrito desktop convertido a botón semántico.
- [x] Tamaño mínimo de texto regular **12 px**; contraste de grises y textos blancos de baja opacidad reforzado sobre superficies oscuras.
- [x] Áreas interactivas de botones y enlaces ≥ 44×44 px, incluidos los indicadores de carrusel.
- [ ] Confirmar Lighthouse Accesibilidad ≥ 95 y probar con lector de pantalla. Validación manual en navegador comprobó nombres, campos, diálogos, foco, tamaños y cambio ES/EN; Lighthouse/tecnología asistiva no están disponibles en este entorno y debe realizarse en staging.

### 5.5 Textos (microcopy)
- [x] "Confirmar Comanda Real" → "Enviar pedido"; retirado el botón público de sincronización; "Continuar al Despacho" → "Continuar"; "Su bandeja" → "Su pedido".
- [x] Pedir solo **nombre o apodo**; se quitó el campo/persistencia de mesa del checkout y el servicio usa la mesa del QR firmado.
- [x] Mostrar confirmación del pedido con ID y tiempo orientativo (20–30 min, sujeto a la carga de cocina); falta validar el flujo extremo a extremo en staging.

### 5.6 Cocina y personal
- [x] **Alerta sonora y vibración** para pedidos nuevos detectados con `docChanges()` (se omite el snapshot inicial) y notificación visual.
- [x] **Wake Lock** en la ruta de cocina, con reintento al volver a la pestaña y liberación al salir.
- [x] Vista de cocina separada (`/cocina`) con tarjetas grandes, minutos transcurridos y estilos de urgencia.
- [x] Impresión de comandas mediante estilos `@media print`.
- [x] **Gestión de empleados** en el panel mediante Cloud Function con Admin SDK; alta con rol employee, desactivación con revocación del rol y sesión, MFA de owner y App Check.
- **Validación/despliegue pendiente:** comprobar `/cocina`, permisos, empleados, alertas y reglas con Functions/Firestore Emulator o staging. El entorno local no tiene Node/Firebase CLI; App Check aún no tiene site key configurada. No se desplegó.

### 5.7 Contenido y AR/3D
- [ ] Reemplazar fotos de Unsplash y modelos demo por contenido real del restaurante.
- [ ] Quitar el astronauta de "Domo de Cacao" y los GLB de GitHub/modelviewer.dev.
- [ ] Posicionar 3D/AR como **función opcional premium**, no como base.
- [ ] Verificar licencias de los GLB propios; **eliminar `coca_cola_soda_can.glb`** (marca registrada) salvo permiso.

---

## FASE 6 · Rendimiento y build

- [ ] **6.1 Tailwind:** reemplazar `cdn.tailwindcss.com` por **Tailwind CLI/PostCSS** con purge (CSS final ~10–30 KB).
- [ ] **6.2 Tone.js:** eliminar (usar WebAudio nativo con un oscilador para los 3 sonidos) o cargar bajo demanda.
- [ ] **6.3 GSAP/ScrollTrigger:** `defer` o import dinámico solo donde se use.
- [ ] **6.4 Font Awesome:** reemplazar por un subconjunto de iconos SVG inline.
- [ ] **6.5 Google Fonts:** corregir URL (`wght=` → `wght@`), cargar solo pesos usados, `preload` de la fuente principal. Comprobar en DevTools → Network que `css2` devuelve 200.
- [ ] **6.6 Bundler:** añadir **Vite** (o esbuild) para empaquetar Firebase SDK (modular, tree-shaken), minificar y fingerprint de assets. Dejar de importar Firebase por URL desde gstatic.
- [ ] **6.7 Código muerto:** borrar `js/three-scene.js`, el hero 3D y `#app` heredado; eliminar `/models` no usados (35 MB); eliminar `renderMenu()` sobre la grilla oculta.
- [ ] **6.8 Dividir `ui.js`** (3.600 líneas) en módulos: `cart.js`, `orders.js`, `admin.js`, `menu.js`, `chef.js`, `modals.js`, `utils/`.
- [ ] **6.9 Eliminar trasplante de DOM** (`mountLegacyExperienceSurfaces`): una sola UI con componentes claros.
- [ ] **6.10 Metas:** Lighthouse móvil Rendimiento ≥ 90, LCP < 2,5 s, CLS < 0,1, JS inicial < 150 KB gzip.

---

## FASE 7 · SEO, PWA y despliegue

- [ ] **7.1** `<title>` y `meta description`; Open Graph / Twitter Card con imagen 1200×630 (para compartir por WhatsApp).
- [ ] **7.2** Favicon, `apple-touch-icon`, `theme-color`.
- [ ] **7.3** `manifest.webmanifest` + service worker (instalable, carta disponible sin conexión).
- [ ] **7.4** `robots.txt` y `sitemap.xml`.
- [ ] **7.5** **Rutas reales** (`/menu/entradas`, `/plato/<slug>`) con `history.pushState` y URL compartible; pre-render o JSON-LD (`Restaurant`, `Menu`) para que Google vea platos.
- [ ] **7.6** Netlify: `netlify.toml` con headers, redirects SPA y caché larga para assets fingerprinted.
- [ ] **7.7** Analytics (GA4 o alternativa) respetando consentimiento.
- [ ] **7.8** Monitoreo de errores (Sentry) y alertas de presupuesto en Google Cloud.
- [ ] **7.9** Copias de seguridad programadas de Firestore.
- [ ] **7.10** CI mínimo (GitHub Actions): lint, pruebas de reglas con emulador, build y deploy a staging.

---

## FASE 8 · Legal y comercialización

- [ ] **8.1** Política de privacidad y aviso de tratamiento de datos (Ley 1581 de 2012, Colombia) + casilla de autorización al pedir nombre/reseñar. Términos y condiciones.
- [ ] **8.2** Mostrar precios con impuestos incluidos (IVA/impoconsumo) y propina sugerida voluntaria; aclarar que la app **no cobra ni factura** (o integrar pasarela: Wompi/PayU/Mercado Pago, y facturación electrónica DIAN si aplica).
- [ ] **8.3** Revisar licencias de modelos 3D, fuentes, iconos e imágenes; atribuciones necesarias.
- [ ] **8.4** Cláusula de responsabilidad sobre alérgenos (la información es del restaurante).
- [ ] **8.5** Consultar con un abogado y un contador antes del lanzamiento.

### 8.6 Modelo de negocio (decidir antes de construir)
- **Opción A · Instalación por restaurante:** config de marca (logo, colores, nombre, moneda, idioma) en un archivo/colección; script de provisión (proyecto Firebase + usuario owner + reglas); guía de instalación.
- **Opción B · SaaS multi-restaurante:** `tenantId` real en datos y reglas, subdominios por cliente, onboarding autoservicio, panel super-admin, planes y cobro de suscripción (Stripe/Wompi), límites por plan.
- [ ] Elegir A o B y definir alcance de v1.

---

## FASE 9 · Pruebas y lanzamiento

- [ ] **9.1** Pruebas de reglas (emulador) y de la Function `createOrder`.
- [ ] **9.2** Pruebas E2E (Playwright): pedir → cocina recibe → cambiar estado → cliente ve avance; llamado a mesero; reseña; login owner.
- [ ] **9.3** Prueba de carga básica: 50 pedidos simultáneos; revisar costos en Firestore.
- [ ] **9.4** Pruebas en dispositivos reales (Android gama baja, iPhone, tablet de cocina) con 4G.
- [ ] **9.5** Prueba piloto de 1–2 semanas en un restaurante real con feedback del personal.
- [ ] **9.6** Lista de verificación final: seguridad (Fase 1) ✔, imágenes (3.1) ✔, alérgenos (Fase 4) ✔, legal (Fase 8) ✔, Lighthouse ≥ 90 ✔.

---

## Orden de ejecución autonóma

1. Fase 0 → 2. Fase 1 → 3. Fase 3.1 y Fase 4 → 4. Fase 2 → 5. Fase 5.1, 5.3, 5.6 → 6. Fase 6 → 7. Fases 5 restantes, 7 → 8. Fase 8 → 9. Fase 9.

**Inicia de inmediato con la Fase 0, tarea 0.1 y avanza de forma continua según el orden establecido.**
