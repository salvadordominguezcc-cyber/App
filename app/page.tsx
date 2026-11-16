"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase, supabaseConfigured, fmt } from "../lib/supabase";
import { SEED_PRODUCTS, SEED_SETTINGS, Product } from "../lib/menu";
import {
  OfflineItem,
  loadQueue,
  enqueueOffline,
  removeOffline,
  isNetworkError,
} from "../lib/offline";

type Line = { product: Product; qty: number };
type Sale = { id: string; folio: number | null; total_cents: number; payment_method: string; created_at: string; pending?: boolean; sold_by_email?: string | null; sold_by_name?: string | null; items?: { product_name: string; quantity: number; subtotal_cents: number }[] };
type Cut = { id: string; opening_cents: number; expected_cents: number; counted_cents: number; difference_cents: number; created_at: string; status: string; pending?: boolean };
type AccessLog = { id: string; user_id: string | null; user_email: string | null; action: string; created_at: string };
type Expense = { id: string; description: string; amount_cents: number; category: string | null; created_at: string; pending?: boolean };
type SessionUser = { id: string; email: string; role: "admin" | "cajero"; username: string | null };
type AppUser = { id: string; email: string | null; username: string | null; role: "admin" | "cajero"; created_at: string; last_sign_in_at: string | null; banned_until: string | null };

// Evento del navegador para instalar la PWA (Chrome/Android y Edge).
// No existe en el tipado estándar, por eso se define aquí.
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

// Fecha local del negocio (America/Tijuana) en formato YYYY-MM-DD, para
// agrupar los gastos (y las ventas) "de hoy" como los ve el usuario.
function localDay(iso: string) {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Tijuana" });
}

// Cuenta admin principal: solo este correo ve las pestañas "Bitácora" y
// "Usuarios". Los usuarios se crean desde la pestaña Usuarios (o en el
// panel de Supabase Auth, Authentication → Users); la app no tiene registro.
const ADMIN_EMAIL = "salvadordominguezcc@gmail.com";

// Rol del usuario: se guarda en user_metadata.role de Supabase Auth
// ("admin" o "cajero"). El correo ADMIN_EMAIL siempre es admin aunque no
// tenga el metadata. Los usuarios nuevos se crean con rol cajero.
function roleOf(user: { user_metadata?: any } | null, email: string): "admin" | "cajero" {
  if (email.toLowerCase() === ADMIN_EMAIL) return "admin";
  return user?.user_metadata?.role === "admin" ? "admin" : "cajero";
}

// Nombre de usuario para entrar (opcional): se guarda en
// user_metadata.username. Si no tiene, el login es solo por correo.
function usernameOf(user: { user_metadata?: any } | null): string | null {
  const u = String(user?.user_metadata?.username || "").trim().toLowerCase();
  return u || null;
}

// ¿El error es porque la tabla sales aún no tiene las columnas sold_by_*?
// En ese caso la venta se reintenta sin esas columnas y NO falla.
function isMissingSellerColumn(err: any): boolean {
  const m = String(err?.message || err || "").toLowerCase();
  return err?.code === "PGRST204" || (m.includes("sold_by") && (m.includes("column") || m.includes("schema cache")));
}

// Agrupa ventas por persona (nombre de usuario o correo): total y conteo,
// ordenadas por total vendido. Las ventas viejas sin registro quedan como
// "Sin registro".
function agruparVentasPorPersona(list: Sale[]): Array<[string, { total_cents: number; count: number }]> {
  const map = new Map<string, { total_cents: number; count: number }>();
  for (const s of list) {
    const key = s.sold_by_name || s.sold_by_email || "Sin registro";
    const cur = map.get(key) || { total_cents: 0, count: 0 };
    cur.total_cents += s.total_cents;
    cur.count += 1;
    map.set(key, cur);
  }
  return [...map.entries()].sort((a, b) => b[1].total_cents - a[1].total_cents);
}

// Cajero: Ventas, Catálogo, Gastos, Corte de caja y Reportes.
// Admin: todo lo anterior + Personalizar, Bitácora y Usuarios.
const BASE_TABS = ["Ventas", "Catálogo", "Gastos", "Corte de caja", "Reportes"] as const;
const ADMIN_TABS = [...BASE_TABS, "Personalizar", "Bitácora", "Usuarios"] as const;

export default function POS() {
  const [tab, setTab] = useState("Ventas");
  const [products, setProducts] = useState<Product[]>(SEED_PRODUCTS);
  const [settings, setSettings] = useState<any>(SEED_SETTINGS);
  const [sales, setSales] = useState<Sale[]>([]);
  const [cuts, setCuts] = useState<Cut[]>([]);
  const [ticket, setTicket] = useState<Line[]>([]);
  const [pay, setPay] = useState("efectivo");
  const [cash, setCash] = useState("");
  const [customer, setCustomer] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);
  const [cajaAbierta, setCajaAbierta] = useState(false);
  const [fondo, setFondo] = useState(500);
  const [contado, setContado] = useState("");
  const [nuevo, setNuevo] = useState({ name: "", price: "", unit: "pieza", description: "" });
  const [edit, setEdit] = useState<Record<string, { name: string; price: string; unit: string; description: string }>>({});
  // Login por persona (Supabase Auth) + bitácora de accesos (solo admin).
  const [user, setUser] = useState<SessionUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [logEntries, setLogEntries] = useState<AccessLog[]>([]);
  const [logStatus, setLogStatus] = useState<"idle" | "loading" | "ok" | "missing" | "error">("idle");
  // Gestión de usuarios (solo admin, vía /api/users con service_role).
  const [appUsers, setAppUsers] = useState<AppUser[]>([]);
  const [usersStatus, setUsersStatus] = useState<"idle" | "loading" | "ok" | "no-service-key" | "error">("idle");
  const [usersError, setUsersError] = useState("");
  const [usersBusy, setUsersBusy] = useState(false);
  const [nuevoUsuario, setNuevoUsuario] = useState({ email: "", password: "", role: "cajero", username: "" });
  const [editUsername, setEditUsername] = useState<Record<string, string>>({});
  // Gastos del día (salidas de caja). Sin stock ni inventario.
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [expenseStatus, setExpenseStatus] = useState<"idle" | "loading" | "ok" | "missing" | "error">("idle");
  const [gasto, setGasto] = useState({ description: "", amount: "", category: "Insumos" });
  // Modo sin internet: la cola offline vive en localStorage (clave
  // "elrodeo_offline_queue", ver lib/offline.ts) y sobrevive al cerrar y
  // reabrir el navegador. Los registros pendientes se muestran en Ventas /
  // Gastos / Corte marcados como "pendiente de sincronizar".
  const [online, setOnline] = useState(true);
  const [queue, setQueue] = useState<OfflineItem[]>([]);
  const [syncing, setSyncing] = useState(false);
  const syncingRef = useRef(false);
  // Instalar como app (PWA): el navegador avisa con "beforeinstallprompt"
  // cuando la app se puede instalar (Chrome/Android y Edge). En iPhone no
  // hay aviso: se instala desde Compartir → "Agregar a inicio".
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState(false);
  const [installMsg, setInstallMsg] = useState("");
  // Logo del negocio (Personalizar, solo admin): imagen subida por el admin,
  // guardada en settings.logo_url como data URL. El emoji (logo_emoji) queda
  // solo como respaldo cuando no hay imagen subida.
  const [logoMsg, setLogoMsg] = useState("");

  const isAdmin = !!user && user.role === "admin";
  // Quién vendió: se guarda en cada venta (sold_by_email / sold_by_name
  // en Supabase). Nombre = @usuario si lo tiene, si no el correo.
  function soldBy(): { email: string | null; name: string | null } {
    if (!user) return { email: null, name: null };
    return { email: user.email, name: user.username ? `@${user.username}` : user.email };
  }
  const visibleTabs = (isAdmin ? ADMIN_TABS : BASE_TABS) as readonly string[];

  const total = ticket.reduce((s, l) => s + l.product.price_cents * l.qty, 0);
  const cambio = pay === "efectivo" && cash ? Math.max(0, Math.round(parseFloat(cash) * 100) - total) : 0;

  // Datos del negocio en este equipo (localStorage): así el logo y el nombre
// se siguen viendo sin internet, aunque Supabase no responda. La nube
// sigue siendo la fuente principal cuando hay señal.
const SETTINGS_CACHE_KEY = "elrodeo_settings";

function guardarSettingsLocal(s: any) {
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(s));
  } catch { /* localStorage lleno o bloqueado: el logo solo vive en la nube */ }
}

function cargarSettingsLocal(): any | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(SETTINGS_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function load() {
    setLoading(true);
    // Sin internet, los datos del negocio (incluido el logo) se restauran
    // desde este equipo; con internet, Supabase los actualiza enseguida.
    const cachedSettings = cargarSettingsLocal();
    if (cachedSettings) setSettings({ ...SEED_SETTINGS, ...cachedSettings });
    if (supabase) {
      const { data: prods } = await supabase.from("products").select("*").order("name");
      if (prods?.length) setProducts(prods.map((p: any) => ({ ...p, stock: 0, min_stock: 0 })));
      const { data: sett } = await supabase.from("settings").select("*").limit(1).maybeSingle();
      if (sett) { setSettings({ ...SEED_SETTINGS, ...sett }); guardarSettingsLocal({ ...SEED_SETTINGS, ...sett }); }
      const { data: s } = await supabase.from("sales").select("*, sale_items(product_name, quantity, subtotal_cents)").order("created_at", { ascending: false }).limit(50);
      if (s) setSales(s.map((x: any) => ({ ...x, items: x.sale_items })));
      const { data: c } = await supabase.from("cash_cuts").select("*").order("created_at", { ascending: false }).limit(20);
      if (c) setCuts(c);
      // Gastos: tolerante si la tabla expenses aún no existe en Supabase.
      setExpenseStatus("loading");
      const { data: ex, error: exErr } = await supabase.from("expenses")
        .select("id, description, amount_cents, category, created_at")
        .order("created_at", { ascending: false }).limit(100);
      if (exErr) {
        console.warn("No se pudieron leer los gastos:", exErr.message);
        setExpenseStatus(exErr.message.includes("expenses") ? "missing" : "error");
        setExpenses([]);
      } else {
        setExpenses((ex || []) as Expense[]);
        setExpenseStatus("ok");
      }
    }
    setLoading(false);
    // Los pendientes offline se restauran encima de los datos de Supabase.
    restorePending();
    // Con internet, intenta sincronizar la cola pendiente al cargar.
    if (typeof navigator === "undefined" || navigator.onLine !== false) void syncQueue();
  }
  // --- Modo sin internet ---
  // Restaura los pendientes de la cola (localStorage) dentro del estado en
  // pantalla, para que las ventas/gastos/cortes offline se vean en Ventas,
  // Gastos y Corte aunque se haya cerrado y reabierto el navegador. Los
  // pendientes se agregan al principio y no duplican nada de Supabase (su
  // id es el tempId, distinto de cualquier uuid de Supabase).
  function restorePending() {
    const q = loadQueue();
    setQueue(q);
    if (!q.length) return;
    const pendingSales: Sale[] = q
      .filter((x): x is Extract<OfflineItem, { kind: "sale" }> => x.kind === "sale")
      .map((x) => ({
        id: x.tempId, folio: null, total_cents: x.total_cents, payment_method: x.payment_method,
        created_at: x.created_at, pending: true,
        sold_by_email: x.sold_by_email ?? null, sold_by_name: x.sold_by_name ?? null,
        items: x.items.map((i) => ({ product_name: i.product_name, quantity: i.quantity, subtotal_cents: i.subtotal_cents })),
      }));
    const pendingExpenses: Expense[] = q
      .filter((x): x is Extract<OfflineItem, { kind: "expense" }> => x.kind === "expense")
      .map((x) => ({
        id: x.tempId, description: x.description, amount_cents: x.amount_cents, category: x.category,
        created_at: x.created_at, pending: true,
      }));
    const pendingCuts: Cut[] = q
      .filter((x): x is Extract<OfflineItem, { kind: "cut" }> => x.kind === "cut")
      .map((x) => ({
        id: x.tempId, opening_cents: x.opening_cents, expected_cents: x.expected_cents, counted_cents: x.counted_cents,
        difference_cents: x.difference_cents, created_at: x.created_at, status: x.status, pending: true,
      }));
    if (pendingSales.length) setSales((s) => [...pendingSales, ...s.filter((y) => !pendingSales.some((p) => p.id === y.id))]);
    if (pendingExpenses.length) setExpenses((e) => [...pendingExpenses, ...e.filter((y) => !pendingExpenses.some((p) => p.id === y.id))]);
    if (pendingCuts.length) setCuts((c) => [...pendingCuts, ...c.filter((y) => !pendingCuts.some((p) => p.id === y.id))]);
  }
  // Sincronización: envía la cola a Supabase en orden, uno por uno. Cada
  // registro se quita de la cola SOLO cuando Supabase confirma el insert;
  // si uno falla (sigue sin internet u otro error), se queda en cola y la
  // sincronización se detiene ahí para no alterar el orden.
  // Regla de folios: la venta offline NO tiene folio en pantalla
  // ("Pendiente"); el folio definitivo se asigna AQUÍ, en el momento de
  // sincronizar, leyendo el folio máximo real de Supabase y sumando 1, y
  // se vuelve a leer antes de cada venta por si otra terminal vendió
  // mientras tanto. Así nunca chocan dos ventas con el mismo folio.
  async function syncQueue() {
    if (!supabase || syncingRef.current) return;
    const q = loadQueue();
    if (!q.length) { setQueue([]); return; }
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    syncingRef.current = true;
    setSyncing(true);
    let synced = 0;
    let failed = false;
    for (const item of q) {
      try {
        if (item.kind === "sale") {
          const { data: maxRow } = await supabase.from("sales").select("folio").order("folio", { ascending: false }).limit(1).maybeSingle();
          const folio = (maxRow?.folio || 0) + 1;
          // Quién vendió: viene en la cola offline. Si la tabla sales aún
          // no tiene las columnas sold_by_*, se reintenta sin ellas y la
          // venta igual se guarda (sin el vendedor).
          const baseSale = {
            folio, total_cents: item.total_cents, payment_method: item.payment_method,
            customer_name: item.customer_name, notes: null, status: "completada",
          };
          let ins = await supabase.from("sales").insert({
            ...baseSale, sold_by_email: item.sold_by_email ?? null, sold_by_name: item.sold_by_name ?? null,
          }).select("id").single();
          let sellerSaved = true;
          if (ins.error && isMissingSellerColumn(ins.error)) {
            sellerSaved = false;
            ins = await supabase.from("sales").insert(baseSale).select("id").single();
          }
          if (ins.error) throw ins.error;
          const saleId = ins.data.id;
          const { error: itemsErr } = await supabase.from("sale_items").insert(item.items.map((i) => ({
            sale_id: saleId, product_id: i.product_id, product_name: i.product_name,
            quantity: i.quantity, price_cents: i.price_cents, subtotal_cents: i.subtotal_cents,
          })));
          if (itemsErr) {
            // Borra la venta huérfana para que el reintento no la duplique.
            await supabase.from("sales").delete().eq("id", saleId);
            throw itemsErr;
          }
          setSales((s) => s.map((y) => (y.id === item.tempId ? { ...y, id: saleId, folio, pending: false, sold_by_email: sellerSaved ? item.sold_by_email ?? null : null, sold_by_name: sellerSaved ? item.sold_by_name ?? null : null } : y)));
        } else if (item.kind === "expense") {
          const { data, error } = await supabase.from("expenses").insert({
            description: item.description, amount_cents: item.amount_cents, category: item.category,
          }).select("id").single();
          if (error) throw error;
          setExpenses((e) => e.map((y) => (y.id === item.tempId ? { ...y, id: data.id, pending: false } : y)));
        } else {
          const { data, error } = await supabase.from("cash_cuts").insert({
            opening_cents: item.opening_cents, expected_cents: item.expected_cents, counted_cents: item.counted_cents,
            difference_cents: item.difference_cents, status: item.status, notes: null,
          }).select("id").single();
          if (error) throw error;
          setCuts((c) => c.map((y) => (y.id === item.tempId ? { ...y, id: data.id, pending: false } : y)));
        }
        setQueue(removeOffline(item.tempId));
        synced++;
      } catch (e) {
        failed = true;
        console.warn("No se pudo sincronizar un registro offline:", e);
        break;
      }
    }
    syncingRef.current = false;
    setSyncing(false);
    const remaining = loadQueue().length;
    if (synced > 0 && remaining === 0) setMsg(`✓ Se sincronizaron ${synced} ${synced === 1 ? "registro" : "registros"} pendientes: ya están guardados en Supabase.`);
    else if (synced > 0) setMsg(`Se sincronizaron ${synced} registros. Quedan ${remaining} pendientes: se reintentan solos al volver la señal.`);
    else if (failed) setMsg("No se pudo sincronizar todavía: los registros siguen guardados en este equipo y se reintentan solos al volver la señal.");
  }
  // Registra un acceso en access_log. Si la tabla aún no existe (o el insert
  // falla por cualquier motivo), NO bloquea el login/logout: solo avisa en
  // consola. La tabla se crea en Supabase con el SQL de README.md.
  async function logAccess(u: SessionUser, action: "login" | "logout") {
    if (!supabase) return;
    try {
      const { error } = await supabase.from("access_log").insert({
        user_id: u.id, user_email: u.email, action,
      });
      if (error) console.warn("Bitácora no registrada:", error.message);
    } catch (e) {
      console.warn("Bitácora no registrada:", e);
    }
  }

  async function cargarBitacora() {
    if (!supabase) return;
    setLogStatus("loading");
    const { data, error } = await supabase.from("access_log")
      .select("id, user_id, user_email, action, created_at")
      .order("created_at", { ascending: false }).limit(100);
    if (error) {
      // Tabla inexistente (PGRST205 / 42P01) u otro error de lectura.
      console.warn("No se pudo leer la bitácora:", error.message);
      setLogStatus(error.message.includes("access_log") ? "missing" : "error");
      setLogEntries([]);
    } else {
      setLogEntries((data || []) as AccessLog[]);
      setLogStatus("ok");
    }
  }

  // Gestión de usuarios vía /api/users (server-side, llave service_role).
  // El navegador nunca ve la llave: solo manda el access token de la sesión
  // como Bearer y la ruta verifica que quien llama sea admin.
  async function usersApi(method: string, body?: any) {
    if (!supabase) throw new Error("Supabase no está conectado.");
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Tu sesión expiró. Vuelve a entrar.");
    const res = await fetch("/api/users", {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err: any = new Error(json.message || json.error || "Error del servidor.");
      err.code = json.code || json.error;
      err.status = res.status;
      throw err;
    }
    return json;
  }

  async function cargarUsuarios() {
    setUsersStatus("loading");
    setUsersError("");
    try {
      const json = await usersApi("GET");
      setAppUsers((json.users || []) as AppUser[]);
      setUsersStatus("ok");
    } catch (e: any) {
      if (e.code === "SERVICE_ROLE_MISSING" || e.status === 503) setUsersStatus("no-service-key");
      else { setUsersStatus("error"); setUsersError(e.message || "No se pudieron cargar los usuarios."); }
    }
  }

  async function crearUsuario() {
    const email = nuevoUsuario.email.trim();
    if (!email || !nuevoUsuario.password) { setUsersError("Escribe el correo y la contraseña del nuevo usuario."); return; }
    const rol = nuevoUsuario.role;
    const username = nuevoUsuario.username.trim().toLowerCase();
    setUsersBusy(true); setUsersError("");
    try {
      await usersApi("POST", { email, password: nuevoUsuario.password, role: rol, username: username || undefined });
      setNuevoUsuario({ email: "", password: "", role: "cajero", username: "" });
      await cargarUsuarios();
      setMsg(`Usuario ${email} creado con rol ${rol === "admin" ? "admin" : "cajero"}${username ? ` y usuario @${username}` : ""}. Ya puede entrar al POS.`);
    } catch (e: any) {
      setUsersError(e.message || "No se pudo crear el usuario.");
    } finally { setUsersBusy(false); }
  }

  // Asigna o cambia el nombre de usuario de una cuenta (también la propia
  // y la del admin principal: es solo un alias para entrar, no un permiso).
  // Dejar el campo vacío quita el usuario y el login queda solo por correo.
  async function guardarUsuario(u: AppUser) {
    const username = (editUsername[u.id] ?? u.username ?? "").trim().toLowerCase();
    if (username && !/^[a-zA-Z0-9._]{3,}$/.test(username)) {
      setUsersError("El nombre de usuario debe tener al menos 3 caracteres y solo puede usar letras, números, guion bajo (_) y punto (.), sin espacios.");
      return;
    }
    setUsersBusy(true); setUsersError("");
    try {
      await usersApi("PATCH", { id: u.id, username });
      // Si cambió su propio usuario, el header se actualiza solo.
      if (u.id === user?.id) setUser((cur) => (cur ? { ...cur, username: username || null } : cur));
      setEditUsername((v) => { const n = { ...v }; delete n[u.id]; return n; });
      await cargarUsuarios();
      setMsg(username ? `Nombre de usuario de ${u.email} cambiado a @${username}.` : `Nombre de usuario de ${u.email} quitado: ahora entra solo con su correo.`);
    } catch (e: any) {
      setUsersError(e.message || "No se pudo cambiar el nombre de usuario.");
    } finally { setUsersBusy(false); }
  }

  async function cambiarRolUsuario(u: AppUser, role: "admin" | "cajero") {
    if (u.role === role) return;
    setUsersBusy(true); setUsersError("");
    try {
      await usersApi("PATCH", { id: u.id, role });
      await cargarUsuarios();
      setMsg(`Rol de ${u.email || "usuario"} cambiado a ${role}.`);
    } catch (e: any) {
      setUsersError(e.message || "No se pudo cambiar el rol.");
    } finally { setUsersBusy(false); }
  }

  async function toggleBloqueoUsuario(u: AppUser) {
    const bloqueado = !!u.banned_until && new Date(u.banned_until) > new Date();
    if (!window.confirm(bloqueado
      ? `¿Activar el acceso de ${u.email || "este usuario"}? Volverá a poder entrar al POS.`
      : `¿Desactivar el acceso de ${u.email || "este usuario"}? Ya no podrá entrar al POS hasta que lo actives de nuevo.`)) return;
    setUsersBusy(true); setUsersError("");
    try {
      await usersApi("PATCH", { id: u.id, banned: !bloqueado });
      await cargarUsuarios();
      setMsg(bloqueado ? `${u.email} activado.` : `${u.email} desactivado: ya no puede entrar al POS.`);
    } catch (e: any) {
      setUsersError(e.message || `No se pudo ${bloqueado ? "activar" : "desactivar"} al usuario.`);
    } finally { setUsersBusy(false); }
  }

  async function eliminarUsuario(u: AppUser) {
    if (!window.confirm(`¿Eliminar definitivamente al usuario ${u.email || ""}? Esta acción no se puede deshacer.`)) return;
    setUsersBusy(true); setUsersError("");
    try {
      await usersApi("DELETE", { id: u.id });
      await cargarUsuarios();
      setMsg(`Usuario ${u.email} eliminado.`);
    } catch (e: any) {
      setUsersError(e.message || "No se pudo eliminar el usuario.");
    } finally { setUsersBusy(false); }
  }

  // Entrar con correo o con nombre de usuario + contraseña. Si lo que se
  // escribe lleva @, se usa directo como correo. Si no, se resuelve el
  // usuario a su correo con GET /api/users?username= (la ruta devuelve
  // SOLO el correo y el mismo error genérico si no existe, para no revelar
  // si un usuario existe). La contraseña nunca viaja a esa ruta.
  async function entrar() {
    if (!supabase) { setLoginError("Supabase no está conectado: falta la llave anon en Vercel."); return; }
    if (!loginEmail.trim() || !loginPass) { setLoginError("Escribe tu correo o nombre de usuario y tu contraseña."); return; }
    setLoginLoading(true);
    setLoginError("");
    let email = loginEmail.trim();
    if (!email.includes("@")) {
      const username = email.toLowerCase();
      if (!/^[a-z0-9._]{3,}$/.test(username)) {
        setLoginLoading(false);
        setLoginError("Correo, nombre de usuario o contraseña incorrectos. Revisa tus datos e inténtalo de nuevo.");
        return;
      }
      try {
        const res = await fetch(`/api/users?username=${encodeURIComponent(username)}`);
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.email) throw new Error(json.message || "");
        email = String(json.email);
      } catch {
        setLoginLoading(false);
        setLoginError("Correo, nombre de usuario o contraseña incorrectos. Revisa tus datos e inténtalo de nuevo.");
        return;
      }
    }
    const { data, error } = await supabase.auth.signInWithPassword({
      email, password: loginPass,
    });
    setLoginLoading(false);
    if (error || !data.user?.email) {
      setLoginError(
        error?.message === "Invalid login credentials"
          ? "Correo, nombre de usuario o contraseña incorrectos. Revisa tus datos e inténtalo de nuevo."
          : error?.message === "Email not confirmed"
            ? "Tu correo aún no está confirmado. Revisa tu bandeja de entrada."
            : "No se pudo entrar: " + (error?.message || "inténtalo de nuevo."),
      );
      return;
    }
    const u: SessionUser = { id: data.user.id, email: data.user.email, role: roleOf(data.user, data.user.email), username: usernameOf(data.user) };
    setUser(u);
    setLoginPass("");
    await logAccess(u, "login");
    if (u.role === "admin") await cargarBitacora();
  }

  async function salir() {
    if (user) await logAccess(user, "logout");
    if (supabase) await supabase.auth.signOut();
    setUser(null);
    setLogEntries([]);
    setLogStatus("idle");
    setTab("Ventas");
    setTicket([]);
  }

  useEffect(() => {
    // Sesión persistente: supabase-js guarda la sesión en el navegador y
    // la restaura al volver a abrir el POS. Restaurar sesión NO registra
    // un login en la bitácora; solo el inicio de sesión explícito lo hace.
    (async () => {
      if (supabase) {
        const { data } = await supabase.auth.getSession();
        const s = data.session?.user;
        if (s?.email) {
          const u: SessionUser = { id: s.id, email: s.email, role: roleOf(s, s.email), username: usernameOf(s) };
          setUser(u);
          if (u.role === "admin") await cargarBitacora();
        }
      }
      setAuthChecked(true);
    })();
  }, []);
  useEffect(() => { if (user) load(); }, [user]);
  // Detección de conexión: navigator.onLine + eventos online/offline.
  // Al volver la señal se intenta sincronizar la cola automáticamente.
  useEffect(() => {
    if (typeof navigator !== "undefined") setOnline(navigator.onLine);
    setQueue(loadQueue());
    const onOnline = () => { setOnline(true); void syncQueue(); };
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);
  // Instalar como app (PWA): guarda el evento del navegador para ofrecer
  // "Instalar app" desde el header y desde Personalizar. Detecta si la app
  // ya está instalada (se abrió en modo standalone, sin barra del navegador).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as any).standalone === true;
    setIsStandalone(standalone);
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setIsStandalone(true);
      setInstallEvent(null);
      setInstallMsg("✅ App instalada. Ya puedes abrir el POS desde tu pantalla principal, con o sin internet.");
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function instalarApp() {
    if (!installEvent) return;
    try {
      await installEvent.prompt();
      const choice = await installEvent.userChoice;
      if (choice.outcome === "accepted") {
        setInstallMsg("Instalando app…");
      } else {
        setInstallMsg("Instalación cancelada. Puedes intentarlo de nuevo cuando quieras.");
      }
    } catch {
      setInstallMsg("No se pudo abrir la instalación. Inténtalo desde el menú del navegador: “Instalar app” o “Agregar a pantalla principal”.");
    }
    setInstallEvent(null);
  }
  // Si el usuario pierde acceso a la pestaña actual (por ejemplo, el admin
  // le cambió el rol a cajero), se le regresa a Ventas.
  useEffect(() => {
    if (!visibleTabs.includes(tab)) setTab("Ventas");
  }, [isAdmin, tab]);
  // La lista de usuarios se carga al abrir la pestaña Usuarios (solo admin).
  useEffect(() => { if (tab === "Usuarios" && isAdmin) cargarUsuarios(); }, [tab, isAdmin]);

  function addToTicket(p: Product, qty: number) {
    setTicket((t) => {
      const i = t.findIndex((l) => l.product.id === p.id);
      if (i >= 0) { const n = [...t]; n[i] = { ...n[i], qty: n[i].qty + qty }; return n; }
      return [...t, { product: p, qty }];
    });
  }

  async function cobrar() {
    if (!ticket.length) return;
    // Folio: solo de las ventas YA sincronizadas (sin pendientes, que aún
    // no tienen folio). El folio definitivo de una venta offline se asigna
    // al sincronizar (ver syncQueue).
    const syncedSales = sales.filter((s) => !s.pending);
    const folio = (syncedSales.length ? Math.max(...syncedSales.map((s) => s.folio || 0)) : 0) + 1;
    const itemsPayload = ticket.map((l) => ({
      product_id: l.product.id.startsWith("seed-") ? null : l.product.id, // uuid real o null si es semilla
      product_name: l.product.name, quantity: l.qty,
      price_cents: l.product.price_cents, subtotal_cents: Math.round(l.product.price_cents * l.qty),
    }));
    const tempId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const itemsForState = itemsPayload.map((i) => ({ product_name: i.product_name, quantity: i.quantity, subtotal_cents: i.subtotal_cents }));
    // Quién vendió: correo de la sesión y @usuario si lo tiene.
    const seller = soldBy();
    // Sin internet: la venta va a la cola offline con folio pendiente y se
    // muestra marcada como tal. Se sincroniza sola al volver la señal.
    if (supabase && (!online || (typeof navigator !== "undefined" && navigator.onLine === false))) {
      const sale: Sale = { id: tempId, folio: null, total_cents: total, payment_method: pay, created_at: createdAt, pending: true, sold_by_email: seller.email, sold_by_name: seller.name, items: itemsForState };
      setSales((s) => [sale, ...s]);
      setQueue(enqueueOffline({ kind: "sale", tempId, total_cents: total, payment_method: pay, customer_name: customer || null, created_at: createdAt, sold_by_email: seller.email, sold_by_name: seller.name, items: itemsPayload }));
      setMsg(`Venta por ${fmt(total)} guardada sin internet: queda pendiente en este equipo y se sincroniza sola al volver la señal.`);
      setTicket([]); setCash(""); setCustomer("");
      return;
    }
    const sale: Sale = { id: tempId, folio, total_cents: total, payment_method: pay, created_at: createdAt, sold_by_email: seller.email, sold_by_name: seller.name, items: itemsForState };
    setSales((s) => [sale, ...s]);
    if (supabase) {
      // Nunca se envía el id local como uuid: Supabase genera el uuid de la venta.
      // Si la tabla sales aún no tiene las columnas sold_by_*, se reintenta
      // sin ellas y la venta igual se guarda (sin el vendedor).
      const baseSale = {
        folio, total_cents: total, payment_method: pay,
        customer_name: customer || null, notes: null, status: "completada",
      };
      let ins = await supabase.from("sales").insert({
        ...baseSale, sold_by_email: seller.email, sold_by_name: seller.name,
      }).select("id").single();
      let sellerSaved = true;
      if (ins.error && isMissingSellerColumn(ins.error)) {
        sellerSaved = false;
        ins = await supabase.from("sales").insert(baseSale).select("id").single();
      }
      const { data: inserted, error } = ins;
      if (error) {
        if (isNetworkError(error)) {
          // Se cayó la red a mitad del cobro: a la cola, sin folio aún.
          setSales((s) => s.map((y) => (y.id === tempId ? { ...y, folio: null, pending: true } : y)));
          setQueue(enqueueOffline({ kind: "sale", tempId, total_cents: total, payment_method: pay, customer_name: customer || null, created_at: createdAt, sold_by_email: seller.email, sold_by_name: seller.name, items: itemsPayload }));
          setMsg(`Venta por ${fmt(total)} guardada sin internet: queda pendiente en este equipo y se sincroniza sola al volver la señal.`);
        } else {
          setMsg("Venta guardada en pantalla, pero Supabase respondió: " + error.message);
        }
      } else {
        const saleId = inserted.id; // uuid real de Supabase
        const items = itemsPayload.map((i) => ({ sale_id: saleId, ...i }));
        await supabase.from("sale_items").insert(items);
        setSales((s) => s.map((y) => (y.id === tempId ? { ...y, id: saleId, sold_by_email: sellerSaved ? seller.email : null, sold_by_name: sellerSaved ? seller.name : null } : y)));
        setMsg(`Venta #${folio} por ${fmt(total)} guardada en Supabase.`);
      }
    } else {
      setMsg(`Venta #${folio} por ${fmt(total)} registrada en pantalla. Conecta la llave anon de Supabase para guardarla en la nube.`);
    }
    setTicket([]); setCash(""); setCustomer("");
  }

  // Catálogo: agregar, editar y quitar productos del menú. Sin stock.
  async function agregarProducto() {
    const price = Math.round(parseFloat(nuevo.price || "0") * 100);
    if (!nuevo.name.trim() || !price) { setMsg("Para agregar al menú escribe el nombre y el precio."); return; }
    const prod: Product = { id: "seed-" + crypto.randomUUID(), name: nuevo.name.trim(), price_cents: price, unit: nuevo.unit, category: "", description: nuevo.description.trim(), stock: 0, min_stock: 0, active: true };
    setProducts((ps) => [...ps, prod].sort((a, b) => a.name.localeCompare(b.name)));
    setNuevo({ name: "", price: "", unit: "pieza", description: "" });
    if (supabase) {
      const { data, error } = await supabase.from("products").insert({ name: prod.name, price_cents: price, unit: prod.unit, category: "", description: prod.description, active: true }).select("id").single();
      if (error) setMsg("Se agregó en pantalla, pero Supabase respondió: " + error.message);
      else { setProducts((ps) => ps.map((p) => (p.id === prod.id ? { ...p, id: data.id } : p))); setMsg(`"${prod.name}" agregado al menú.`); }
    } else setMsg(`"${prod.name}" agregado al menú en pantalla. Conecta Supabase para guardarlo en la nube.`);
  }

  async function guardarEdicion(p: Product) {
    const e = edit[p.id]; if (!e) return;
    const price = Math.round(parseFloat(e.price || "0") * 100);
    if (!e.name.trim() || !price) { setMsg("El nombre y el precio no pueden quedar vacíos."); return; }
    const upd = { ...p, name: e.name.trim(), price_cents: price, unit: e.unit, description: e.description.trim() };
    setProducts((ps) => ps.map((x) => (x.id === p.id ? upd : x)));
    setEdit((v) => { const n = { ...v }; delete n[p.id]; return n; });
    if (supabase && !p.id.startsWith("seed-")) {
      const { error } = await supabase.from("products").update({ name: upd.name, price_cents: price, unit: upd.unit, description: upd.description }).eq("id", p.id);
      setMsg(error ? "No se pudo guardar en Supabase: " + error.message : `"${upd.name}" actualizado en el menú.`);
    } else setMsg(`"${upd.name}" actualizado en pantalla.`);
  }

  async function toggleActivo(p: Product) {
    const active = !p.active;
    setProducts((ps) => ps.map((x) => (x.id === p.id ? { ...x, active } : x)));
    if (supabase && !p.id.startsWith("seed-")) {
      const { error } = await supabase.from("products").update({ active }).eq("id", p.id);
      setMsg(error ? "No se pudo guardar en Supabase: " + error.message : active ? `"${p.name}" vuelve a estar en el menú.` : `"${p.name}" quitado del menú.`);
    } else setMsg(active ? `"${p.name}" vuelve a estar en el menú.` : `"${p.name}" quitado del menú.`);
  }

  // Gastos del día: se guardan en Supabase (tabla expenses). Si la tabla
  // aún no existe, se guardan solo en pantalla y se avisa con claridad.
  async function agregarGasto() {
    const amount = Math.round(parseFloat(gasto.amount || "0") * 100);
    if (!gasto.description.trim() || !amount || amount <= 0) { setMsg("Para registrar un gasto escribe la descripción y el monto."); return; }
    const tempId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    // Sin internet: el gasto va a la cola offline y se muestra pendiente.
    if (supabase && (!online || (typeof navigator !== "undefined" && navigator.onLine === false))) {
      const exp: Expense = { id: tempId, description: gasto.description.trim(), amount_cents: amount, category: gasto.category, created_at: createdAt, pending: true };
      setExpenses((xs) => [exp, ...xs]);
      setQueue(enqueueOffline({ kind: "expense", tempId, description: exp.description, amount_cents: amount, category: exp.category, created_at: createdAt }));
      setGasto({ description: "", amount: "", category: "Insumos" });
      setMsg(`Gasto de ${fmt(amount)} guardado sin internet: queda pendiente en este equipo y se sincroniza solo al volver la señal.`);
      return;
    }
    const exp: Expense = { id: tempId, description: gasto.description.trim(), amount_cents: amount, category: gasto.category, created_at: createdAt };
    setExpenses((xs) => [exp, ...xs]);
    setGasto({ description: "", amount: "", category: "Insumos" });
    if (supabase) {
      const { data, error } = await supabase.from("expenses").insert({ description: exp.description, amount_cents: amount, category: exp.category }).select("id").single();
      if (error) {
        if (isNetworkError(error)) {
          setExpenses((xs) => xs.map((x) => (x.id === tempId ? { ...x, pending: true } : x)));
          setQueue(enqueueOffline({ kind: "expense", tempId, description: exp.description, amount_cents: amount, category: exp.category, created_at: createdAt }));
          setMsg(`Gasto de ${fmt(amount)} guardado sin internet: queda pendiente en este equipo y se sincroniza solo al volver la señal.`);
        } else {
          setMsg("Gasto guardado en pantalla, pero Supabase respondió: " + error.message + " Crea la tabla expenses con el SQL de README.md.");
        }
      }
      else { setExpenses((xs) => xs.map((x) => (x.id === tempId ? { ...x, id: data.id } : x))); setMsg(`Gasto de ${fmt(amount)} registrado.`); }
    } else setMsg(`Gasto de ${fmt(amount)} registrado en pantalla. Conecta Supabase para guardarlo en la nube.`);
  }

  async function eliminarGasto(e: Expense) {
    if (!window.confirm(`¿Eliminar el gasto "${e.description}" por ${fmt(e.amount_cents)}?`)) return;
    setExpenses((xs) => xs.filter((x) => x.id !== e.id));
    // Si el gasto estaba pendiente en la cola offline, se quita de la cola
    // también (nunca llegó a Supabase, así que no hay nada que borrar ahí).
    if (e.pending) { setQueue(removeOffline(e.id)); setMsg("Gasto pendiente eliminado."); return; }
    // Solo se intenta borrar en Supabase si la tabla expenses existe
    // (si no, el gasto solo vivía en pantalla).
    if (supabase && expenseStatus === "ok") {
      const { error } = await supabase.from("expenses").delete().eq("id", e.id);
      setMsg(error ? "No se pudo eliminar en Supabase: " + error.message : "Gasto eliminado.");
    } else setMsg("Gasto eliminado.");
  }

  const gastosHoy = useMemo(() => expenses.filter((e) => localDay(e.created_at) === localDay(new Date().toISOString())), [expenses]);
  const totalGastosHoy = gastosHoy.reduce((s, x) => s + x.amount_cents, 0);

  const ventasHoy = useMemo(() => sales.filter((s) => s.created_at.slice(0, 10) === new Date().toISOString().slice(0, 10)), [sales]);
  const efectivoHoy = ventasHoy.filter((s) => s.payment_method === "efectivo").reduce((s, x) => s + x.total_cents, 0);
  const tarjetaHoy = ventasHoy.filter((s) => s.payment_method === "tarjeta").reduce((s, x) => s + x.total_cents, 0);
  const transfHoy = ventasHoy.filter((s) => s.payment_method === "transferencia").reduce((s, x) => s + x.total_cents, 0);
  // Efectivo esperado en caja: fondo + ventas en efectivo de hoy
  // − gastos del día (las salidas de caja). Sin gastos queda igual que antes.
  const esperado = Math.round(fondo * 100) + efectivoHoy - totalGastosHoy;
  const totalVentas = sales.reduce((s, x) => s + x.total_cents, 0);
  // Ventas por persona: quién vendió cada venta (nombre de usuario o
  // correo). Hoy y en todo el historial. El corte sigue sumando todas las
  // ventas del día sin importar quién vendió.
  const ventasPorPersonaHoy = useMemo(() => agruparVentasPorPersona(ventasHoy), [ventasHoy]);
  const ventasPorPersonaTotal = useMemo(() => agruparVentasPorPersona(sales), [sales]);
  // Cuánto de lo de hoy aún no está sincronizado (ventas/gastos offline).
  const pendientesHoy = useMemo(() => ({
    ventasEfectivo: ventasHoy.filter((s) => s.pending && s.payment_method === "efectivo").reduce((s, x) => s + x.total_cents, 0),
    gastos: gastosHoy.filter((e) => e.pending).reduce((s, x) => s + x.amount_cents, 0),
  }), [ventasHoy, gastosHoy]);

  async function cerrarCorte() {
    const counted = Math.round(parseFloat(contado || "0") * 100);
    const tempId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const cut: Cut = { id: tempId, opening_cents: Math.round(fondo * 100), expected_cents: esperado, counted_cents: counted, difference_cents: counted - esperado, created_at: createdAt, status: counted === esperado ? "cuadrado" : "con diferencia" };
    // Sin internet: el corte también va a la cola offline (su esperado ya
    // incluye las ventas y gastos pendientes del día) y se sincroniza solo.
    if (supabase && (!online || (typeof navigator !== "undefined" && navigator.onLine === false))) {
      setCuts((c) => [{ ...cut, pending: true }, ...c]);
      setQueue(enqueueOffline({ kind: "cut", tempId, opening_cents: cut.opening_cents, expected_cents: cut.expected_cents, counted_cents: cut.counted_cents, difference_cents: cut.difference_cents, status: cut.status, created_at: createdAt }));
      setMsg(`Corte cerrado sin internet: queda pendiente en este equipo y se sincroniza solo al volver la señal. Diferencia: ${fmt(cut.difference_cents)}.`);
      setCajaAbierta(false); setContado("");
      return;
    }
    setCuts((c) => [cut, ...c]);
    if (supabase) {
      const { data, error } = await supabase.from("cash_cuts").insert({ opening_cents: cut.opening_cents, expected_cents: cut.expected_cents, counted_cents: cut.counted_cents, difference_cents: cut.difference_cents, status: cut.status, notes: null }).select("id").single();
      if (error) {
        if (isNetworkError(error)) {
          setCuts((c) => c.map((y) => (y.id === tempId ? { ...y, pending: true } : y)));
          setQueue(enqueueOffline({ kind: "cut", tempId, opening_cents: cut.opening_cents, expected_cents: cut.expected_cents, counted_cents: cut.counted_cents, difference_cents: cut.difference_cents, status: cut.status, created_at: createdAt }));
          setMsg(`Corte cerrado sin internet: queda pendiente en este equipo y se sincroniza solo al volver la señal. Diferencia: ${fmt(cut.difference_cents)}.`);
        } else {
          setMsg("Corte guardado en pantalla, Supabase respondió: " + error.message);
        }
      } else {
        if (data) setCuts((c) => c.map((y) => (y.id === tempId ? { ...y, id: data.id } : y)));
        setMsg(`Corte cerrado. Diferencia: ${fmt(cut.difference_cents)} — guardado en Supabase.`);
      }
    } else setMsg(`Corte cerrado. Diferencia: ${fmt(cut.difference_cents)} (solo en pantalla, sin Supabase).`);
    setCajaAbierta(false); setContado("");
  }

  // Logo del negocio: comprime la imagen en el navegador (canvas) a un
  // máximo de 512×512 px y menos de 200 KB, y la devuelve como data URL
  // (base64) para guardarla en settings.logo_url. El fondo se pinta de
  // blanco para que los PNG con transparencia no queden con fondo negro.
  function comprimirLogo(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const draw = (maxDim: number, quality: number): string => {
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("canvas");
          ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          return canvas.toDataURL("image/jpeg", quality);
        };
        try {
          // Prueba calidades/tamaños hasta quedar en menos de 200 KB.
          const intentos: Array<[number, number]> = [[512, 0.85], [512, 0.6], [256, 0.8], [256, 0.6]];
          let data = "";
          for (const [maxDim, q] of intentos) {
            data = draw(maxDim, q);
            if (data.length <= 200 * 1024 * 1.37) break;
          }
          resolve(data);
        } catch { reject(new Error("No se pudo comprimir la imagen.")); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("No se pudo leer la imagen.")); };
      img.src = url;
    });
  }

  async function onLogoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // permite volver a elegir el mismo archivo
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setLogoMsg("Ese archivo no es una imagen JPG, PNG o WebP.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setLogoMsg("La imagen es muy pesada (máximo 10 MB antes de comprimir).");
      return;
    }
    try {
      const dataUrl = await comprimirLogo(file);
      setSettings((s: any) => ({ ...s, logo_url: dataUrl }));
      setLogoMsg("Imagen lista. Pulsa “Guardar datos del negocio” para aplicarla.");
    } catch {
      setLogoMsg("No se pudo leer esa imagen. Prueba con otra.");
    }
  }

  function quitarLogo() {
    setSettings((s: any) => ({ ...s, logo_url: "" }));
    setLogoMsg("Imagen quitada. Pulsa “Guardar datos del negocio” para aplicar el cambio.");
  }

  async function guardarSettings() {
    // El logo (y el resto de datos) queda guardado en este equipo aunque
    // no haya internet; con señal también se guarda en Supabase.
    guardarSettingsLocal(settings);
    if (supabase) {
      const { error } = await supabase.from("settings").update({
        business_name: settings.business_name, slogan: settings.slogan, logo_emoji: settings.logo_emoji,
        logo_url: settings.logo_url || null,
        main_color: settings.main_color, theme: settings.theme, address: settings.address, phone: settings.phone,
        whatsapp: settings.whatsapp, email: settings.email, rfc: settings.rfc, hours: settings.hours,
        ticket_message: settings.ticket_message, initial_cash_cents: settings.initial_cash_cents,
      }).eq("id", settings.id);
      if (error) {
        setMsg(isNetworkError(error)
          ? "Datos guardados en este equipo (sin internet). Vuelve a pulsar Guardar con internet para que queden en la nube."
          : "No se pudo guardar en Supabase: " + error.message);
      } else setMsg("Datos del negocio guardados en Supabase.");
    } else setMsg("Datos guardados en este equipo. Conecta la llave anon para guardarlos en Supabase.");
  }

  // Sin sesión no se muestra nada del POS: solo la pantalla de login.
  if (!authChecked) {
    return (<div className="card" style={{ maxWidth: 420, margin: "80px auto" }}><h1>🥩 EL RODEO</h1><p className="muted">Cargando…</p></div>);
  }
  if (!user) {
    return (
      <div className="card" style={{ maxWidth: 420, margin: "80px auto" }}>
        <h1><img src="/icon.svg" alt="Logo de EL RODEO" style={{ width: 48, height: 48, objectFit: "cover", borderRadius: "50%", verticalAlign: "middle", marginRight: 8 }} />{SEED_SETTINGS.business_name}</h1>
        <p className="muted">Punto de venta · Entra con tu correo o tu nombre de usuario y tu contraseña.</p>
        {!supabaseConfigured && (
          <p className="banner">⚠️ Supabase no está conectado: falta la llave anon en Vercel. Sin conexión no se puede iniciar sesión.</p>
        )}
        <label>Correo o nombre de usuario</label>
        <input type="text" value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} placeholder="tu@correo.com o tu usuario" onKeyDown={(e) => { if (e.key === "Enter") entrar(); }} />
        <label>Contraseña</label>
        <input type="password" value={loginPass} onChange={(e) => setLoginPass(e.target.value)} placeholder="Tu contraseña" onKeyDown={(e) => { if (e.key === "Enter") entrar(); }} />
        {loginError && <p style={{ color: "#b91c1c" }}>{loginError}</p>}
        <button className="btn" style={{ width: "100%", marginTop: 12 }} disabled={loginLoading || !supabaseConfigured} onClick={entrar}>
          {loginLoading ? "Entrando…" : "Entrar"}
        </button>
        <p className="muted" style={{ marginTop: 12 }}>Sin registro en la app: tu cuenta la crea el administrador desde la pestaña Usuarios.</p>
      </div>
    );
  }

  return (
    <div style={{ ["--accent" as any]: settings.main_color || "#c2410c" }}>
      <header>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {settings.logo_url ? (
            <img src={settings.logo_url} alt="Logo de EL RODEO" style={{ width: 48, height: 48, objectFit: "cover", borderRadius: "50%", background: "#fff", flexShrink: 0 }} />
          ) : (
            <img src="/icon.svg" alt="Logo de EL RODEO" style={{ width: 48, height: 48, objectFit: "cover", borderRadius: "50%", background: "#fff", flexShrink: 0 }} />
          )}
          <div><h1>{settings.business_name}</h1><p>{settings.slogan} · Punto de venta</p></div>
        </div>
        <div style={{ textAlign: "right" }}>
          <p>{online ? "🟢 En línea" : "🔴 Sin internet — modo offline"}{supabaseConfigured ? " · Conectado a Supabase" : " · Sin conexión a Supabase"}</p>
          <p>{loading ? "Cargando…" : `${products.length} productos · ${sales.length} ventas`}{queue.length > 0 ? ` · ⏳ ${queue.length} ${queue.length === 1 ? "pendiente" : "pendientes"} de sincronizar` : ""}</p>
          <p className="muted">{user?.username ? `@${user.username} · ` : ""}{user?.email} · {user?.role === "admin" ? "Admin" : "Cajero"}</p>
          {queue.length > 0 && online && (<button className="btn sec" onClick={() => void syncQueue()} disabled={syncing} style={{ marginRight: 8 }}>{syncing ? "Sincronizando…" : "Sincronizar ahora"}</button>)}
          {installEvent && !isStandalone && (<button className="btn sec" onClick={instalarApp} style={{ marginRight: 8 }}>Instalar app</button>)}
          <button className="btn sec" onClick={salir}>Cerrar sesión</button>
        </div>
      </header>
      {!supabaseConfigured && (
        <div className="banner">⚠️ Falta la llave anon de Supabase: el menú se muestra, pero las ventas no se guardan en la nube todavía. En Vercel agrega la variable <b>NEXT_PUBLIC_SUPABASE_ANON_KEY</b> con la llave “anon public” de Supabase (Settings → API) y vuelve a desplegar.</div>
      )}
      {supabaseConfigured && <div className="banner ok">✓ Conectado a Supabase: las ventas, los gastos y los cortes se guardan en la nube.</div>}
      {!online && (
        <div className="banner">🔴 Sin internet — modo offline: puedes seguir vendiendo y registrando gastos; todo se guarda en este equipo y se sincroniza solo al volver la señal.{queue.length > 0 ? ` Hay ${queue.length} ${queue.length === 1 ? "registro" : "registros"} pendientes de sincronizar.` : " Aún no hay registros pendientes."}</div>
      )}
      <nav>{visibleTabs.map((t) => (<button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>))}</nav>
      <main>
        {msg && <p className="card" style={{ background: "#eff6ff" }}>{msg} <button className="btn sec" onClick={() => setMsg("")}>✕</button></p>}

        {tab === "Ventas" && (
          <div className="cols">
            <div>
              <h2>Ventas</h2>
              <div className="grid">
                {products.filter((p) => p.active).map((p) => (
                  <div key={p.id} className="card prod">
                    <b>{p.name}</b>
                    <span className="price">{fmt(p.price_cents)}</span> <span className="unit">/ {p.unit}</span>
                    <div className="muted">{p.description}</div>
                    {p.unit === "kg" ? (
                      <div className="qty">
                        <button onClick={() => addToTicket(p, 0.25)}>¼ kg</button>
                        <button onClick={() => addToTicket(p, 0.5)}>½ kg</button>
                        <button onClick={() => addToTicket(p, 1)}>1 kg</button>
                      </div>
                    ) : (<div className="qty"><button onClick={() => addToTicket(p, 1)}>+ Agregar</button></div>)}
                  </div>
                ))}
              </div>
              <h2 style={{ marginTop: 20 }}>Ventas recientes</h2>
              {sales.slice(0, 10).map((s) => (
                <div key={s.id} className="row"><span>{s.folio ? `#${s.folio}` : "Pendiente"} · {s.payment_method} · {new Date(s.created_at).toLocaleString("es-MX")}{s.sold_by_name || s.sold_by_email ? ` · ${s.sold_by_name || s.sold_by_email}` : ""}{s.pending ? " · ⏳ pendiente de sincronizar" : ""}</span><b>{fmt(s.total_cents)}</b></div>
              ))}
              {!sales.length && <p className="muted">Aún no hay ventas registradas.</p>}
            </div>
            <div className="card">
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                {settings.logo_url && (
                  <img src={settings.logo_url} alt="Logo de EL RODEO" style={{ width: 40, height: 40, objectFit: "cover", borderRadius: "50%", background: "#fff" }} />
                )}
                <div><b>{settings.business_name}</b><div className="muted">{settings.slogan}</div></div>
              </div>
              <h2>Ticket</h2>
              {!ticket.length && <p className="muted">Toca un producto para agregarlo.</p>}
              {ticket.map((l, i) => (
                <div key={i} className="row">
                  <span>{l.product.name} × {l.qty} {l.product.unit}</span>
                  <span><b>{fmt(Math.round(l.product.price_cents * l.qty))}</b> <button className="btn sec" onClick={() => setTicket(ticket.filter((_, j) => j !== i))}>✕</button></span>
                </div>
              ))}
              <div className="row"><span>Total</span><span className="big">{fmt(total)}</span></div>
              <label>Cliente (opcional)</label>
              <input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Nombre del cliente" />
              <label>Método de pago</label>
              <select value={pay} onChange={(e) => setPay(e.target.value)}>
                <option value="efectivo">Efectivo</option><option value="tarjeta">Tarjeta</option><option value="transferencia">Transferencia</option>
              </select>
              {pay === "efectivo" && (<><label>Efectivo recibido ($)</label><input type="number" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="0.00" /><p>Cambio: <b>{fmt(cambio)}</b></p></>)}
              <button className="btn" style={{ width: "100%" }} disabled={!ticket.length} onClick={cobrar}>Cobrar {fmt(total)}</button>
            </div>
          </div>
        )}

        {tab === "Catálogo" && (
          <div>
            <h2>Catálogo — menú a utilizar</h2>
            <p className="muted">Agrega productos al menú o quítalos. Lo que quites deja de aparecer en Ventas, pero no borra tus ventas anteriores.</p>
            <div className="card" style={{ marginBottom: 16 }}>
              <h2>Agregar al menú</h2>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input style={{ flex: 2, minWidth: 160 }} placeholder="Nombre, ej. Taco de barbacoa" value={nuevo.name} onChange={(e) => setNuevo({ ...nuevo, name: e.target.value })} />
                <input style={{ maxWidth: 130 }} type="number" placeholder="Precio $" value={nuevo.price} onChange={(e) => setNuevo({ ...nuevo, price: e.target.value })} />
                <select style={{ maxWidth: 130 }} value={nuevo.unit} onChange={(e) => setNuevo({ ...nuevo, unit: e.target.value })}>
                  <option value="pieza">pieza</option><option value="kg">kg</option><option value="litro">litro</option><option value="orden">orden</option>
                </select>
                <input style={{ flex: 2, minWidth: 160 }} placeholder="Descripción (opcional)" value={nuevo.description} onChange={(e) => setNuevo({ ...nuevo, description: e.target.value })} />
                <button className="btn" onClick={agregarProducto}>Agregar</button>
              </div>
            </div>
            {products.map((p) => {
              const e = edit[p.id];
              return (
                <div key={p.id} className="card" style={{ marginBottom: 10, opacity: p.active ? 1 : 0.55 }}>
                  <div className="row"><span><b>{p.name}</b> · {fmt(p.price_cents)} / {p.unit}{p.active ? "" : " · fuera del menú"}</span></div>
                  {p.description && <div className="muted">{p.description}</div>}
                  {e ? (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                      <input style={{ flex: 2, minWidth: 140 }} value={e.name} onChange={(ev) => setEdit((v) => ({ ...v, [p.id]: { ...e, name: ev.target.value } }))} />
                      <input style={{ maxWidth: 120 }} type="number" value={e.price} onChange={(ev) => setEdit((v) => ({ ...v, [p.id]: { ...e, price: ev.target.value } }))} />
                      <select style={{ maxWidth: 120 }} value={e.unit} onChange={(ev) => setEdit((v) => ({ ...v, [p.id]: { ...e, unit: ev.target.value } }))}>
                        <option value="pieza">pieza</option><option value="kg">kg</option><option value="litro">litro</option><option value="orden">orden</option>
                      </select>
                      <input style={{ flex: 2, minWidth: 140 }} placeholder="Descripción" value={e.description} onChange={(ev) => setEdit((v) => ({ ...v, [p.id]: { ...e, description: ev.target.value } }))} />
                      <button className="btn" onClick={() => guardarEdicion(p)}>Guardar</button>
                      <button className="btn sec" onClick={() => setEdit((v) => { const n = { ...v }; delete n[p.id]; return n; })}>Cancelar</button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                      <button className="btn sec" onClick={() => setEdit((v) => ({ ...v, [p.id]: { name: p.name, price: String(p.price_cents / 100), unit: p.unit, description: p.description || "" } }))}>Editar</button>
                      <button className="btn sec" onClick={() => toggleActivo(p)}>{p.active ? "Quitar del menú" : "Volver al menú"}</button>
                    </div>
                  )}
                </div>
              );
            })}
            {!products.length && <p className="muted">No hay productos en el catálogo todavía.</p>}
          </div>
        )}

        {tab === "Gastos" && (
          <div>
            <h2>Gastos del día</h2>
            <p className="muted">Salidas de caja de hoy. Se descuentan del efectivo esperado en el corte de caja.</p>
            <div className="card" style={{ marginBottom: 16 }}>
              <h2>Registrar gasto</h2>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input style={{ flex: 2, minWidth: 160 }} placeholder="Descripción, ej. Gas para el comal" value={gasto.description} onChange={(e) => setGasto({ ...gasto, description: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") agregarGasto(); }} />
                <input style={{ maxWidth: 130 }} type="number" placeholder="Monto $" value={gasto.amount} onChange={(e) => setGasto({ ...gasto, amount: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") agregarGasto(); }} />
                <select style={{ maxWidth: 160 }} value={gasto.category} onChange={(e) => setGasto({ ...gasto, category: e.target.value })}>
                  <option value="Insumos">Insumos</option><option value="Servicios">Servicios</option><option value="Transporte">Transporte</option><option value="Nómina">Nómina</option><option value="Otros">Otros</option>
                </select>
                <button className="btn" onClick={agregarGasto}>Agregar gasto</button>
              </div>
            </div>
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="row"><span>Total de gastos hoy</span><span className="big">{fmt(totalGastosHoy)}</span></div>
              <div className="muted">{gastosHoy.length} {gastosHoy.length === 1 ? "gasto" : "gastos"} hoy</div>
            </div>
            {expenseStatus === "missing" && (
              <p className="card">Los gastos se guardan solo en pantalla por ahora: la tabla <b>expenses</b> aún no existe en Supabase. Créala con el SQL de README.md para que se guarden en la nube.</p>
            )}
            {expenseStatus === "error" && (
              <p className="card">No se pudieron leer los gastos de Supabase. Revisa la tabla expenses.</p>
            )}
            {expenseStatus === "loading" && <p className="muted">Cargando gastos…</p>}
            {gastosHoy.map((e) => (
              <div key={e.id} className="row">
                <span>{new Date(e.created_at).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })} · {e.description} · {e.category || "Otros"}{e.pending ? " · ⏳ pendiente de sincronizar" : ""}</span>
                <span><b>{fmt(e.amount_cents)}</b> <button className="btn sec" onClick={() => eliminarGasto(e)}>Eliminar</button></span>
              </div>
            ))}
            {!gastosHoy.length && expenseStatus !== "loading" && <p className="muted">Sin gastos registrados hoy.</p>}
          </div>
        )}

        {tab === "Corte de caja" && (
          <div>
            <h2>Corte de caja</h2>
            {!cajaAbierta ? (
              <div className="card">
                <label>Fondo inicial ($)</label>
                <input type="number" value={fondo} onChange={(e) => setFondo(parseFloat(e.target.value) || 0)} />
                <button className="btn" onClick={() => setCajaAbierta(true)}>Abrir caja</button>
              </div>
            ) : (
              <div className="card">
                <div className="row"><span>Fondo</span><b>{fmt(Math.round(fondo * 100))}</b></div>
                <div className="row"><span>Ventas en efectivo hoy</span><b>{fmt(efectivoHoy)}</b></div>
                <div className="row"><span>Gastos del día (salidas de caja)</span><b>− {fmt(totalGastosHoy)}</b></div>
                {(pendientesHoy.ventasEfectivo > 0 || pendientesHoy.gastos > 0) && (
                  <>
                    <div className="row"><span>⏳ Aún sin sincronizar (incluido en lo esperado)</span><b>efectivo {fmt(pendientesHoy.ventasEfectivo)} − gastos {fmt(pendientesHoy.gastos)}</b></div>
                    <p className="muted">El efectivo esperado ya incluye las ventas y gastos pendientes; esa parte aún no está guardada en Supabase, solo en este equipo.</p>
                  </>
                )}
                <div className="row"><span>Ventas con tarjeta hoy</span><b>{fmt(tarjetaHoy)}</b></div>
                <div className="row"><span>Ventas por transferencia hoy</span><b>{fmt(transfHoy)}</b></div>
                <div className="row"><span>Efectivo esperado</span><b>{fmt(esperado)}</b></div>
                <p className="muted">Efectivo esperado = fondo + ventas en efectivo − gastos del día.</p>
                <label>Efectivo contado ($)</label>
                <input type="number" value={contado} onChange={(e) => setContado(e.target.value)} placeholder="0.00" />
                <p>Sobrante / faltante: <b>{contado ? fmt(Math.round(parseFloat(contado) * 100) - esperado) : "—"}</b></p>
                <button className="btn" onClick={cerrarCorte}>Cerrar corte</button>
              </div>
            )}
            <h2 style={{ marginTop: 20 }}>Historial de cortes</h2>
            {cuts.map((c) => (<div key={c.id} className="row"><span>{new Date(c.created_at).toLocaleString("es-MX")} · {c.status}{c.pending ? " · ⏳ pendiente de sincronizar" : ""}</span><b>Esperado {fmt(c.expected_cents)} · Contado {fmt(c.counted_cents)} · Dif. {fmt(c.difference_cents)}</b></div>))}
            {!cuts.length && <p className="muted">Sin cortes todavía.</p>}
          </div>
        )}

        {tab === "Reportes" && (
          <div>
            <h2>Reportes</h2>
            <div className="grid">
              <div className="card"><div className="muted">Ventas totales</div><div className="big">{fmt(totalVentas)}</div></div>
              <div className="card"><div className="muted">Ventas hoy</div><div className="big">{fmt(ventasHoy.reduce((s, x) => s + x.total_cents, 0))}</div><div className="muted">{ventasHoy.length} ventas</div></div>
              <div className="card"><div className="muted">Productos activos</div><div className="big">{products.filter((p) => p.active).length}</div></div>
            </div>
            <h2 style={{ marginTop: 20 }}>Ventas por producto</h2>
            {products.map((p) => {
              const qty = sales.flatMap((s) => s.items || []).filter((i) => i.product_name === p.name).reduce((s, i) => s + Number(i.quantity), 0);
              const imp = sales.flatMap((s) => s.items || []).filter((i) => i.product_name === p.name).reduce((s, i) => s + Number(i.subtotal_cents), 0);
              return (<div key={p.id} className="row"><span>{p.name}</span><b>{qty} · {fmt(imp)}</b></div>);
            })}
            <h2 style={{ marginTop: 20 }}>Ventas por persona</h2>
            <p className="muted">Quién vendió cada venta (nombre de usuario o correo). Las ventas viejas, de antes de este cambio, aparecen como “Sin registro”.</p>
            <h3>Hoy</h3>
            {ventasPorPersonaHoy.length ? ventasPorPersonaHoy.map(([nombre, v]) => (
              <div key={nombre} className="row"><span>{nombre}</span><b>{v.count} {v.count === 1 ? "venta" : "ventas"} · {fmt(v.total_cents)}</b></div>
            )) : <p className="muted">Sin ventas hoy todavía.</p>}
            <h3>Total</h3>
            {ventasPorPersonaTotal.length ? ventasPorPersonaTotal.map(([nombre, v]) => (
              <div key={nombre} className="row"><span>{nombre}</span><b>{v.count} {v.count === 1 ? "venta" : "ventas"} · {fmt(v.total_cents)}</b></div>
            )) : <p className="muted">Sin ventas registradas todavía.</p>}
          </div>
        )}

        {tab === "Personalizar" && (
          <div className="card">
            <h2>Personalizar — {settings.business_name}</h2>
            <label>Nombre del negocio</label>
            <input value={settings.business_name} onChange={(e) => setSettings({ ...settings, business_name: e.target.value })} />
            <label>Eslogan</label>
            <input value={settings.slogan || ""} onChange={(e) => setSettings({ ...settings, slogan: e.target.value })} />
            <label>Subir imagen del logo</label>
            {settings.logo_url ? (
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                <img src={settings.logo_url} alt="Vista previa del logo" style={{ width: 72, height: 72, objectFit: "cover", borderRadius: "50%", background: "#fff", border: "1px solid #ddd" }} />
                <button className="btn sec" onClick={quitarLogo}>Quitar imagen</button>
              </div>
            ) : (
              <p className="muted">Sin imagen subida: se muestra el logo por defecto {settings.logo_emoji || "🥩"}.</p>
            )}
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={onLogoFile} />
            <p className="muted">JPG, PNG o WebP (máx. 10 MB). Se comprime a 512×512 px y menos de 200 KB. Recuerda pulsar “Guardar datos del negocio”. El icono de la app instalada en el celular no cambia desde aquí: es un archivo fijo de la app.</p>
            {logoMsg && <p>{logoMsg}</p>}
            <label>Color principal</label>
            <input type="color" value={settings.main_color || "#c2410c"} onChange={(e) => setSettings({ ...settings, main_color: e.target.value })} />
            <label>Dirección</label>
            <input value={settings.address || ""} onChange={(e) => setSettings({ ...settings, address: e.target.value })} />
            <label>Teléfono / WhatsApp</label>
            <input value={settings.phone || ""} onChange={(e) => setSettings({ ...settings, phone: e.target.value })} />
            <label>Correo</label>
            <input value={settings.email || ""} onChange={(e) => setSettings({ ...settings, email: e.target.value })} />
            <label>RFC</label>
            <input value={settings.rfc || ""} onChange={(e) => setSettings({ ...settings, rfc: e.target.value })} />
            <label>Horario</label>
            <input value={settings.hours || ""} onChange={(e) => setSettings({ ...settings, hours: e.target.value })} />
            <label>Mensaje del ticket</label>
            <input value={settings.ticket_message || ""} onChange={(e) => setSettings({ ...settings, ticket_message: e.target.value })} />
            <label>Fondo inicial de caja (centavos)</label>
            <input type="number" value={settings.initial_cash_cents ?? 50000} onChange={(e) => setSettings({ ...settings, initial_cash_cents: parseInt(e.target.value) || 0 })} />
            <button className="btn" onClick={guardarSettings}>Guardar datos del negocio</button>
            <h2 style={{ marginTop: 24 }}>Instalar como app</h2>
            <p className="muted">Instala el POS como app en el celular o la computadora para abrirlo sin internet, como una app normal, sin entrar al navegador.</p>
            {isStandalone ? (
              <p className="card" style={{ background: "#eff6ff" }}>✅ Ya estás usando la app instalada.</p>
            ) : installEvent ? (
              <button className="btn" onClick={instalarApp}>Instalar app EL RODEO</button>
            ) : (
              <div className="card" style={{ background: "#fffbeb" }}>
                <p style={{ marginTop: 0 }}><b>Para instalarla desde el navegador:</b></p>
                <p style={{ marginBottom: 4 }}>• <b>Android (Chrome):</b> menú ⋮ → “Instalar app” o “Agregar a pantalla principal”.</p>
                <p style={{ marginBottom: 4 }}>• <b>iPhone (Safari):</b> botón Compartir → “Agregar a inicio”.</p>
                <p style={{ marginBottom: 0 }}>• <b>Computadora (Chrome/Edge):</b> icono de instalar en la barra de dirección o menú → “Instalar EL RODEO POS”.</p>
              </div>
            )}
            {installMsg && <p style={{ marginTop: 8 }}>{installMsg}</p>}
            <p className="muted">La primera instalación y el primer login necesitan internet. Después, la app abre sin internet con la sesión ya iniciada y el menú cargado, y vende en modo offline.</p>
          </div>
        )}

        {tab === "Bitácora" && isAdmin && (
          <div>
            <h2>Bitácora de accesos</h2>
            <p className="muted">Últimos 100 accesos. Solo la ve la cuenta admin principal.</p>
            <button className="btn sec" onClick={cargarBitacora}>Actualizar</button>
            {logStatus === "missing" && (
              <p className="card" style={{ marginTop: 12 }}>Bitácora aún no activada en Supabase. Crea la tabla <b>access_log</b> con el SQL de README.md y recarga.</p>
            )}
            {logStatus === "error" && (
              <p className="card" style={{ marginTop: 12 }}>No se pudo leer la bitácora. Revisa la tabla access_log en Supabase.</p>
            )}
            {logStatus === "loading" && <p className="muted">Cargando bitácora…</p>}
            {logStatus === "ok" && !logEntries.length && <p className="muted">Sin accesos registrados todavía.</p>}
            {logEntries.map((l) => (
              <div key={l.id} className="row">
                <span>{new Date(l.created_at).toLocaleString("es-MX")} · {l.user_email || "—"}</span>
                <b>{l.action === "login" ? "Entrada" : l.action === "logout" ? "Salida" : l.action}</b>
              </div>
            ))}
          </div>
        )}

        {tab === "Usuarios" && isAdmin && (
          <div>
            <h2>Usuarios</h2>
            <p className="muted">Cuentas que pueden entrar al POS. Solo la ve la cuenta admin. Los usuarios nuevos entran con rol cajero por defecto.</p>
            <button className="btn sec" onClick={cargarUsuarios} disabled={usersStatus === "loading"}>Actualizar</button>
            {usersStatus === "no-service-key" && (
              <p className="card" style={{ marginTop: 12 }}>⚠️ La gestión de usuarios aún no está activada: falta la variable <b>SUPABASE_SERVICE_ROLE_KEY</b> en Vercel. Sin ella no se pueden crear ni administrar usuarios desde aquí. Pasos en README.md (sección "Usuarios y roles"). El resto del POS sigue funcionando normal.</p>
            )}
            {usersStatus === "error" && (
              <p className="card" style={{ marginTop: 12 }}>No se pudieron cargar los usuarios: {usersError || "revisa la configuración."}</p>
            )}
            {usersStatus === "loading" && <p className="muted">Cargando usuarios…</p>}
            {usersStatus === "ok" && (
              <>
                <div className="card" style={{ marginTop: 12, marginBottom: 16 }}>
                  <h2>Crear usuario</h2>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <input style={{ flex: 2, minWidth: 180 }} type="email" placeholder="Correo, ej. cajero@correo.com" value={nuevoUsuario.email} onChange={(e) => setNuevoUsuario({ ...nuevoUsuario, email: e.target.value })} />
                    <input style={{ flex: 1, minWidth: 140 }} type="password" placeholder="Contraseña (mín. 6 caracteres)" value={nuevoUsuario.password} onChange={(e) => setNuevoUsuario({ ...nuevoUsuario, password: e.target.value })} />
                    <input style={{ flex: 1, minWidth: 140 }} placeholder="Usuario (opcional), ej. cajero1" value={nuevoUsuario.username} onChange={(e) => setNuevoUsuario({ ...nuevoUsuario, username: e.target.value })} />
                    <select style={{ maxWidth: 130 }} value={nuevoUsuario.role} onChange={(e) => setNuevoUsuario({ ...nuevoUsuario, role: e.target.value })}>
                      <option value="cajero">Cajero</option>
                      <option value="admin">Admin</option>
                    </select>
                    <button className="btn" onClick={crearUsuario} disabled={usersBusy}>{usersBusy ? "Creando…" : "Crear usuario"}</button>
                  </div>
                  <p className="muted" style={{ marginBottom: 0 }}>El usuario es opcional: con él se puede entrar al POS sin escribir el correo. Solo letras, números, guion bajo (_) y punto (.), mínimo 3 caracteres, sin espacios.</p>
                  {usersError && <p style={{ color: "#b91c1c", marginTop: 8 }}>{usersError}</p>}
                </div>
                {appUsers.map((u) => {
                  const bloqueado = !!u.banned_until && new Date(u.banned_until) > new Date();
                  const esYo = u.id === user?.id;
                  const esAdminPrincipal = (u.email || "").toLowerCase() === ADMIN_EMAIL;
                  return (
                    <div key={u.id} className="card" style={{ marginBottom: 10, opacity: bloqueado ? 0.6 : 1 }}>
                      <div className="row">
                        <span><b>{u.email || "Sin correo"}</b>{u.username ? ` · @${u.username}` : " · sin usuario"} · {u.role === "admin" ? "Admin" : "Cajero"}{bloqueado ? " · ⛔ Desactivado" : ""}{esYo ? " · (tú)" : ""}</span>
                        <span className="muted">Creado: {new Date(u.created_at).toLocaleDateString("es-MX")} · Último acceso: {u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString("es-MX") : "nunca"}</span>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
                        <input style={{ maxWidth: 180 }} placeholder="Usuario, ej. cajero1" value={editUsername[u.id] ?? u.username ?? ""} onChange={(e) => setEditUsername((v) => ({ ...v, [u.id]: e.target.value }))} />
                        <button className="btn sec" disabled={usersBusy || (editUsername[u.id] ?? u.username ?? "") === (u.username ?? "")} onClick={() => guardarUsuario(u)}>Guardar usuario</button>
                        <span className="muted">Vacío = entra solo con su correo.</span>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                        <select value={u.role} disabled={usersBusy || esYo || esAdminPrincipal} onChange={(e) => cambiarRolUsuario(u, e.target.value as "admin" | "cajero")}>
                          <option value="cajero">Cajero</option>
                          <option value="admin">Admin</option>
                        </select>
                        <button className="btn sec" disabled={usersBusy || esYo || esAdminPrincipal} onClick={() => toggleBloqueoUsuario(u)}>{bloqueado ? "Activar" : "Desactivar"}</button>
                        <button className="btn sec" disabled={usersBusy || esYo || esAdminPrincipal} onClick={() => eliminarUsuario(u)}>Eliminar</button>
                      </div>
                    </div>
                  );
                })}
                {!appUsers.length && <p className="muted">Sin usuarios todavía.</p>}
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
