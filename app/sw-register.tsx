"use client";
import { useEffect } from "react";

// Registra el service worker de la PWA (public/sw.js) para que el POS se
// pueda instalar como app y abrir sin internet. Solo en el cliente y solo
// si el navegador lo soporta; si falla, el POS sigue funcionando normal
// en el navegador (solo no se podrá abrir sin internet antes de cargar).
export default function SwRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch((e) => {
      console.warn("No se pudo registrar el service worker:", e);
    });
  }, []);
  return null;
}
