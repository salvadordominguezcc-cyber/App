// Service worker del POS de EL RODEO (PWA).
//
// Qué guarda en caché:
// - El shell de la app (la página "/" y los archivos JS/CSS de /_next/static,
//   el manifiesto y los iconos) para que la app instalada abra sin internet.
// - Solo archivos de la app (mismo origen, método GET).
//
// Qué NO guarda en caché (siempre va a la red, nunca se guarda):
// - Llamadas a Supabase (https://*.supabase.co) y a la API de la app
//   (/api/*): los datos y el login no se cachean. La sincronización de
//   ventas/gastos/cortes sin internet la maneja la cola offline de
//   lib/offline.ts, no este service worker.
//
// Estrategia:
// - Navegación (páginas): network-first con fallback al caché: con internet
//   siempre se trae la versión más nueva; sin internet se sirve el shell
//   guardado y el POS arranca en modo offline con la sesión restaurada.
// - Archivos estáticos de la app (/_next/static/, iconos, manifiesto):
//   cache-first: se sirven del caché y se actualizan en segundo plano.
//
// Para actualizar el caché cuando cambie la app, sube CACHE_NAME
// (por ejemplo a "el-rodeo-pos-v2") y el service worker nuevo borra el viejo.
const CACHE_NAME = "el-rodeo-pos-v1";
const APP_SHELL = ["/", "/manifest.json", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => undefined)
  );
  // Activa el service worker nuevo sin esperar a cerrar las pestañas.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function isAppRequest(url) {
  // Solo mismo origen y GET. Fuera quedan Supabase, la API y todo lo demás.
  return url.origin === self.location.origin;
}

function isApiOrAuth(url) {
  return url.pathname.startsWith("/api/");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // POST/PUT/DELETE nunca se cachean
  const url = new URL(request.url);
  if (!isAppRequest(url) || isApiOrAuth(url)) return; // red, sin caché

  if (request.mode === "navigate") {
    // Páginas: primero la red (versión nueva), si falla, el shell guardado.
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("/", copy)).catch(() => undefined);
          return res;
        })
        .catch(() => caches.match("/"))
    );
    return;
  }

  const isStatic =
    url.pathname.startsWith("/_next/static/") ||
    url.pathname === "/manifest.json" ||
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".ico") ||
    url.pathname.endsWith(".svg");

  if (isStatic) {
    // Archivos de la app: del caché si están, y se actualizan en segundo plano.
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined);
            }
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
  // Cualquier otro GET del mismo origen (por ejemplo, chunks de /_next/):
  // red primero, caché como respaldo.
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined);
        }
        return res;
      })
      .catch(() => caches.match(request))
  );
});
