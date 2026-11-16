// Cola offline persistente (localStorage) para el modo sin internet.
//
// Cuando no hay conexión, las ventas, los gastos y los cortes se guardan
// en esta cola (un registro por operación, en orden) y se muestran en el
// POS marcados como "pendiente de sincronizar". Al volver la señal, la app
// los envía a Supabase uno por uno y solo los quita de la cola cuando
// Supabase confirma el insert, así no se duplican.
//
// Clave: "elrodeo_offline_queue". Los datos viven en ESTE navegador /
// dispositivo hasta sincronizar: si se borra el caché o los datos del
// navegador antes de sincronizar, los pendientes se pierden.

export const OFFLINE_QUEUE_KEY = "elrodeo_offline_queue";

export type OfflineSaleItem = {
  product_id: string | null; // uuid real de Supabase, o null si es producto semilla
  product_name: string;
  quantity: number;
  price_cents: number;
  subtotal_cents: number;
};

export type OfflineItem =
  | {
      kind: "sale";
      tempId: string; // id temporal (uuid del cliente) para seguir el registro en pantalla
      total_cents: number;
      payment_method: string;
      customer_name: string | null;
      created_at: string;
      items: OfflineSaleItem[];
    }
  | {
      kind: "expense";
      tempId: string;
      description: string;
      amount_cents: number;
      category: string | null;
      created_at: string;
    }
  | {
      kind: "cut";
      tempId: string;
      opening_cents: number;
      expected_cents: number;
      counted_cents: number;
      difference_cents: number;
      status: string;
      created_at: string;
    };

function storageAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function loadQueue(): OfflineItem[] {
  if (!storageAvailable()) return [];
  try {
    const raw = window.localStorage.getItem(OFFLINE_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x: any) => x && typeof x.tempId === "string" && (x.kind === "sale" || x.kind === "expense" || x.kind === "cut"),
    ) as OfflineItem[];
  } catch {
    return [];
  }
}

function saveQueue(queue: OfflineItem[]): void {
  if (!storageAvailable()) return;
  try {
    window.localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // localStorage lleno o bloqueado: la cola queda solo en memoria.
    console.warn("No se pudo guardar la cola offline en localStorage.");
  }
}

export function enqueueOffline(item: OfflineItem): OfflineItem[] {
  const queue = [...loadQueue(), item];
  saveQueue(queue);
  return queue;
}

export function removeOffline(tempId: string): OfflineItem[] {
  const queue = loadQueue().filter((x) => x.tempId !== tempId);
  saveQueue(queue);
  return queue;
}

// ¿El error de Supabase parece un fallo de red (sin internet)? Solo en ese
// caso tiene sentido guardar en la cola offline; un error de validación
// (datos malos) volvería a fallar al sincronizar y no se encola.
export function isNetworkError(err: any): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  const m = String(err?.message || err || "").toLowerCase();
  return (
    m.includes("failed to fetch") ||
    m.includes("fetch failed") ||
    m.includes("networkerror") ||
    m.includes("network request failed") ||
    m.includes("load failed") ||
    m.includes("timeout") ||
    m.includes("econnrefused") ||
    m.includes("enotfound")
  );
}
