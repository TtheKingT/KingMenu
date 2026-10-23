const { randomUUID } = require('node:crypto');
const { applicationDefault, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const sharp = require('sharp');

const APP_ID = 'kingmenu-caa89';
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const WIDTHS = [400, 800, 1600];
const applyChanges = process.argv.includes('--apply');
const bucketName = process.env.FIREBASE_STORAGE_BUCKET;

if (!bucketName) {
    throw new Error('Configure FIREBASE_STORAGE_BUCKET con el nombre exacto del bucket de Firebase Storage.');
}

initializeApp({ credential: applicationDefault(), storageBucket: bucketName });

const db = getFirestore();
const bucket = getStorage().bucket();
const productsPath = `artifacts/${APP_ID}/public/data/products`;

function sourceForImage(image) {
    if (typeof image === 'string') return image;
    if (!image || typeof image !== 'object') return '';
    return image.url || image.cropped || image.original || '';
}

function decodeDataUrl(source) {
    const match = /^data:image\/(jpeg|png|webp);base64,([a-z\d+/=\s]+)$/i.exec(source);
    if (!match) return null;
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > MAX_SOURCE_BYTES) {
        throw new Error('Imagen Base64 vacía o superior a 20 MB.');
    }
    return buffer;
}

async function uploadVariant(productId, imageIndex, width, buffer, token) {
    const variant = await sharp(buffer, { limitInputPixels: 25_000_000 })
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer({ resolveWithObject: true });
    if (variant.info.size > 1024 * 1024) {
        throw new Error(`La variante ${width}px supera 1 MB.`);
    }

    const path = `products/${APP_ID}/${productId}/migration-${imageIndex}-${variant.info.width}.webp`;
    if (!applyChanges) {
        return {
            width: variant.info.width,
            height: variant.info.height,
            url: `https://dry-run.invalid/${encodeURIComponent(path)}`
        };
    }
    const file = bucket.file(path);
    await file.save(variant.data, {
        resumable: false,
        metadata: {
            contentType: 'image/webp',
            cacheControl: 'public,max-age=31536000,immutable',
            metadata: { firebaseStorageDownloadTokens: token }
        }
    });
    const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
    return { width: variant.info.width, height: variant.info.height, url };
}

async function migrateImage(productId, imageIndex, image) {
    const source = sourceForImage(image);
    const buffer = decodeDataUrl(source);
    if (!buffer) {
        const url = typeof source === 'string' ? source : '';
        if (!url) return null;
        return {
            ...(image && typeof image === 'object' ? image : {}),
            url,
            largestUrl: image?.largestUrl || url,
            srcset: image?.srcset || '',
            width: Number(image?.width) || 0,
            height: Number(image?.height) || 0
        };
    }

    const token = randomUUID();
    const variants = [];
    const metadata = await sharp(buffer, { limitInputPixels: 25_000_000 }).metadata();
    if (!Number.isInteger(metadata.width) || !Number.isInteger(metadata.height)) {
        throw new Error(`No se pudieron leer las dimensiones de la imagen ${imageIndex} del producto ${productId}.`);
    }
    const widths = [...new Set(WIDTHS.map(width => Math.min(width, metadata.width)))];
    for (const width of widths) {
        variants.push(await uploadVariant(productId, imageIndex, width, buffer, token));
    }
    const medium = variants.find(item => item.width === 800) || variants.at(-1);
    const largest = variants.find(item => item.width === 1600) || variants.at(-1);
    return {
        url: medium.url,
        largestUrl: largest.url,
        srcset: variants.map(item => `${item.url} ${item.width}w`).join(', '),
        width: medium.width,
        height: medium.height
    };
}

async function main() {
    const snapshot = await db.collection(productsPath).get();
    let migratedCount = 0;
    for (const productDoc of snapshot.docs) {
        const product = productDoc.data();
        const storedImages = Array.isArray(product.imageUrls) && product.imageUrls.length
            ? product.imageUrls
            : [product.imageUrl].filter(Boolean);
        const sources = storedImages.map(sourceForImage);
        const mainSource = sourceForImage(product.imageUrl);
        const hasBase64 = sources.some(source => typeof source === 'string' && source.startsWith('data:image/'))
            || (typeof mainSource === 'string' && mainSource.startsWith('data:image/'));
        if (!hasBase64) continue;

        const imageUrls = [];
        for (const [index, image] of storedImages.entries()) {
            const result = await migrateImage(productDoc.id, index, image);
            if (result) imageUrls.push(result);
        }
        const productMainSource = mainSource || sources[0];
        const mainImage = productMainSource === sources[0]
            ? imageUrls[0]
            : await migrateImage(productDoc.id, storedImages.length, product.imageUrl);
        const imageUrl = mainImage?.url || imageUrls[0]?.url || '';
        const updated = { ...product, imageUrl, imageUrls };
        for (const image of updated.imageUrls) {
            delete image.original;
            delete image.cropped;
        }
        const serializedSize = Buffer.byteLength(JSON.stringify(updated));
        if (serializedSize >= 20 * 1024) {
            throw new Error(`Producto ${productDoc.id} aún supera 20 KB tras migración (${serializedSize} bytes).`);
        }

        console.log(`${applyChanges ? 'Migrando' : 'Dry run'} ${productDoc.id}: ${serializedSize} bytes`);
        if (applyChanges) await productDoc.ref.set({ imageUrl, imageUrls }, { merge: true });
        migratedCount += 1;
    }
    console.log(`${applyChanges ? 'Migrados' : 'Pendientes'}: ${migratedCount}. ${applyChanges ? '' : 'Use --apply para escribir los cambios.'}`);
}

main().catch(error => {
    console.error('[Image migration] Falló la migración:', error);
    process.exitCode = 1;
});
