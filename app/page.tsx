"use client";
import { useEffect, useMemo, useState } from "react";
import { supabase, supabaseConfigured, fmt } from "../lib/supabase";
import { SEED_PRODUCTS, SEED_SETTINGS, Product } from "../lib/menu";

type Line = { product: Product; qty: number };
type Sale = { id: string; folio: number; total_cents: number; payment_method: string; created_at: string; items?: { product_name: string; quantity: number; subtotal_cents: number }[] };
type Cut = { id: string; opening_cents: number; expected_cents: number; counted_cents: number; difference_cents: number; created_at: string; status: string };
type AccessLog = { id: string; user_id: string | null; user_email: string | null; action: string; created_at: string };
type Expense = { id: string; description: string; amount_cents: number; category: string | null; created_at: string };
type SessionUser = { id: string; email: string };

// Fecha local del negocio (America/Tijuana) en formato YYYY-MM-DD, para
// agrupar los gastos (y las ventas) "de hoy" como los ve el usuario.
function localDay(iso: string) {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Tijuana" });
}

// Cuenta admin principal: solo este correo ve la pestaña "Bitácora".
// Los usuarios se crean en el panel de Supabase Auth (Authentication → Users),
// la app no tiene registro.
const ADMIN_EMAIL = "salvadordominguezcc@gmail.com";

const BASE_TABS = ["Ventas", "Catálogo", "Gastos", "Corte de caja", "Reportes", "Personalizar"] as const;
const TABS = [...BASE_TABS, "Bitácora"] as const;

export default function POS() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Ventas");
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
  // Gastos del día (salidas de caja). Sin stock ni inventario.
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [expenseStatus, setExpenseStatus] = useState<"idle" | "loading" | "ok" | "missing" | "error">("idle");
  const [gasto, setGasto] = useState({ description: "", amount: "", category: "Insumos" });

  const isAdmin = !!user && user.email.toLowerCase() === ADMIN_EMAIL;
  const visibleTabs = (isAdmin ? TABS : BASE_TABS) as readonly string[];

  const total = ticket.reduce((s, l) => s + l.product.price_cents * l.qty, 0);
  const cambio = pay === "efectivo" && cash ? Math.max(0, Math.round(parseFloat(cash) * 100) - total) : 0;

  async function load() {
    setLoading(true);
    if (supabase) {
      const { data: prods } = await supabase.from("products").select("*").order("name");
      if (prods?.length) setProducts(prods.map((p: any) => ({ ...p, stock: 0, min_stock: 0 })));
      const { data: sett } = await supabase.from("settings").select("*").limit(1).maybeSingle();
      if (sett) setSettings({ ...SEED_SETTINGS, ...sett });
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

  async function entrar() {
    if (!supabase) { setLoginError("Supabase no está conectado: falta la llave anon en Vercel."); return; }
    if (!loginEmail.trim() || !loginPass) { setLoginError("Escribe tu correo y tu contraseña."); return; }
    setLoginLoading(true);
    setLoginError("");
    const { data, error } = await supabase.auth.signInWithPassword({
      email: loginEmail.trim(), password: loginPass,
    });
    setLoginLoading(false);
    if (error || !data.user?.email) {
      setLoginError(
        error?.message === "Invalid login credentials"
          ? "Correo o contraseña incorrectos. Revisa tus datos e inténtalo de nuevo."
          : error?.message === "Email not confirmed"
            ? "Tu correo aún no está confirmado. Revisa tu bandeja de entrada."
            : "No se pudo entrar: " + (error?.message || "inténtalo de nuevo."),
      );
      return;
    }
    const u: SessionUser = { id: data.user.id, email: data.user.email };
    setUser(u);
    setLoginPass("");
    await logAccess(u, "login");
    if (u.email.toLowerCase() === ADMIN_EMAIL) await cargarBitacora();
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
          const u: SessionUser = { id: s.id, email: s.email };
          setUser(u);
          if (u.email.toLowerCase() === ADMIN_EMAIL) await cargarBitacora();
        }
      }
      setAuthChecked(true);
    })();
  }, []);
  useEffect(() => { if (user) load(); }, [user]);

  function addToTicket(p: Product, qty: number) {
    setTicket((t) => {
      const i = t.findIndex((l) => l.product.id === p.id);
      if (i >= 0) { const n = [...t]; n[i] = { ...n[i], qty: n[i].qty + qty }; return n; }
      return [...t, { product: p, qty }];
    });
  }

  async function cobrar() {
    if (!ticket.length) return;
    const folio = (sales.length ? Math.max(...sales.map((s) => s.folio || 0)) : 0) + 1;
    const sale: Sale = { id: crypto.randomUUID(), folio, total_cents: total, payment_method: pay, created_at: new Date().toISOString(), items: ticket.map((l) => ({ product_name: l.product.name, quantity: l.qty, subtotal_cents: Math.round(l.product.price_cents * l.qty) })) };
    setSales((s) => [sale, ...s]);
    if (supabase) {
      // Nunca se envía el id local como uuid: Supabase genera el uuid de la venta.
      const { data: inserted, error } = await supabase.from("sales").insert({
        folio, total_cents: total, payment_method: pay,
        customer_name: customer || null, notes: null, status: "completada",
      }).select("id").single();
      if (error) { setMsg("Venta guardada en pantalla, pero Supabase respondió: " + error.message); }
      else {
        const saleId = inserted.id; // uuid real de Supabase
        const items = ticket.map((l) => ({
          sale_id: saleId,
          product_id: l.product.id.startsWith("seed-") ? null : l.product.id, // uuid real o null si es semilla
          product_name: l.product.name, quantity: l.qty,
          price_cents: l.product.price_cents, subtotal_cents: Math.round(l.product.price_cents * l.qty),
        }));
        await supabase.from("sale_items").insert(items);
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
    const exp: Expense = { id: crypto.randomUUID(), description: gasto.description.trim(), amount_cents: amount, category: gasto.category, created_at: new Date().toISOString() };
    setExpenses((xs) => [exp, ...xs]);
    setGasto({ description: "", amount: "", category: "Insumos" });
    if (supabase) {
      const { data, error } = await supabase.from("expenses").insert({ description: exp.description, amount_cents: amount, category: exp.category }).select("id").single();
      if (error) setMsg("Gasto guardado en pantalla, pero Supabase respondió: " + error.message + " Crea la tabla expenses con el SQL de README.md.");
      else { setExpenses((xs) => xs.map((x) => (x.id === exp.id ? { ...x, id: data.id } : x))); setMsg(`Gasto de ${fmt(amount)} registrado.`); }
    } else setMsg(`Gasto de ${fmt(amount)} registrado en pantalla. Conecta Supabase para guardarlo en la nube.`);
  }

  async function eliminarGasto(e: Expense) {
    if (!window.confirm(`¿Eliminar el gasto "${e.description}" por ${fmt(e.amount_cents)}?`)) return;
    setExpenses((xs) => xs.filter((x) => x.id !== e.id));
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

  async function cerrarCorte() {
    const counted = Math.round(parseFloat(contado || "0") * 100);
    const cut: Cut = { id: crypto.randomUUID(), opening_cents: Math.round(fondo * 100), expected_cents: esperado, counted_cents: counted, difference_cents: counted - esperado, created_at: new Date().toISOString(), status: counted === esperado ? "cuadrado" : "con diferencia" };
    setCuts((c) => [cut, ...c]);
    if (supabase) {
      const { error } = await supabase.from("cash_cuts").insert({ opening_cents: cut.opening_cents, expected_cents: cut.expected_cents, counted_cents: cut.counted_cents, difference_cents: cut.difference_cents, status: cut.status, notes: null });
      setMsg(error ? "Corte guardado en pantalla, Supabase respondió: " + error.message : `Corte cerrado. Diferencia: ${fmt(cut.difference_cents)} — guardado en Supabase.`);
    } else setMsg(`Corte cerrado. Diferencia: ${fmt(cut.difference_cents)} (solo en pantalla, sin Supabase).`);
    setCajaAbierta(false); setContado("");
  }

  async function guardarSettings() {
    if (supabase) {
      const { error } = await supabase.from("settings").update({
        business_name: settings.business_name, slogan: settings.slogan, logo_emoji: settings.logo_emoji,
        main_color: settings.main_color, theme: settings.theme, address: settings.address, phone: settings.phone,
        whatsapp: settings.whatsapp, email: settings.email, rfc: settings.rfc, hours: settings.hours,
        ticket_message: settings.ticket_message, initial_cash_cents: settings.initial_cash_cents,
      }).eq("id", settings.id);
      setMsg(error ? "No se pudo guardar en Supabase: " + error.message : "Datos del negocio guardados en Supabase.");
    } else setMsg("Datos guardados en pantalla. Conecta la llave anon para guardarlos en Supabase.");
  }

  // Sin sesión no se muestra nada del POS: solo la pantalla de login.
  if (!authChecked) {
    return (<div className="card" style={{ maxWidth: 420, margin: "80px auto" }}><h1>🥩 EL RODEO</h1><p className="muted">Cargando…</p></div>);
  }
  if (!user) {
    return (
      <div className="card" style={{ maxWidth: 420, margin: "80px auto" }}>
        <h1>{SEED_SETTINGS.logo_emoji} {SEED_SETTINGS.business_name}</h1>
        <p className="muted">Punto de venta · Entra con tu correo y contraseña.</p>
        {!supabaseConfigured && (
          <p className="banner">⚠️ Supabase no está conectado: falta la llave anon en Vercel. Sin conexión no se puede iniciar sesión.</p>
        )}
        <label>Correo</label>
        <input type="email" value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} placeholder="tu@correo.com" onKeyDown={(e) => { if (e.key === "Enter") entrar(); }} />
        <label>Contraseña</label>
        <input type="password" value={loginPass} onChange={(e) => setLoginPass(e.target.value)} placeholder="Tu contraseña" onKeyDown={(e) => { if (e.key === "Enter") entrar(); }} />
        {loginError && <p style={{ color: "#b91c1c" }}>{loginError}</p>}
        <button className="btn" style={{ width: "100%", marginTop: 12 }} disabled={loginLoading || !supabaseConfigured} onClick={entrar}>
          {loginLoading ? "Entrando…" : "Entrar"}
        </button>
        <p className="muted" style={{ marginTop: 12 }}>Sin registro en la app: tu cuenta la crea el administrador en Supabase Auth.</p>
      </div>
    );
  }

  return (
    <div style={{ ["--accent" as any]: settings.main_color || "#c2410c" }}>
      <header>
        <div><h1>{settings.logo_emoji} {settings.business_name}</h1><p>{settings.slogan} · Punto de venta</p></div>
        <div style={{ textAlign: "right" }}><p>{supabaseConfigured ? "● Conectado a Supabase" : "○ Sin conexión a Supabase"}</p><p>{loading ? "Cargando…" : `${products.length} productos · ${sales.length} ventas`}</p><p className="muted">{user?.email}</p><button className="btn sec" onClick={salir}>Cerrar sesión</button></div>
      </header>
      {!supabaseConfigured && (
        <div className="banner">⚠️ Falta la llave anon de Supabase: el menú se muestra, pero las ventas no se guardan en la nube todavía. En Vercel agrega la variable <b>NEXT_PUBLIC_SUPABASE_ANON_KEY</b> con la llave “anon public” de Supabase (Settings → API) y vuelve a desplegar.</div>
      )}
      {supabaseConfigured && <div className="banner ok">✓ Conectado a Supabase: las ventas, los gastos y los cortes se guardan en la nube.</div>}
      <nav>{visibleTabs.map((t) => (<button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t as any)}>{t}</button>))}</nav>
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
                <div key={s.id} className="row"><span>#{s.folio} · {s.payment_method} · {new Date(s.created_at).toLocaleString("es-MX")}</span><b>{fmt(s.total_cents)}</b></div>
              ))}
              {!sales.length && <p className="muted">Aún no hay ventas registradas.</p>}
            </div>
            <div className="card">
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
                <span>{new Date(e.created_at).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })} · {e.description} · {e.category || "Otros"}</span>
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
            {cuts.map((c) => (<div key={c.id} className="row"><span>{new Date(c.created_at).toLocaleString("es-MX")} · {c.status}</span><b>Esperado {fmt(c.expected_cents)} · Contado {fmt(c.counted_cents)} · Dif. {fmt(c.difference_cents)}</b></div>))}
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
          </div>
        )}

        {tab === "Personalizar" && (
          <div className="card">
            <h2>Personalizar — {settings.business_name}</h2>
            <label>Nombre del negocio</label>
            <input value={settings.business_name} onChange={(e) => setSettings({ ...settings, business_name: e.target.value })} />
            <label>Eslogan</label>
            <input value={settings.slogan || ""} onChange={(e) => setSettings({ ...settings, slogan: e.target.value })} />
            <label>Emoji del logo</label>
            <input value={settings.logo_emoji || ""} onChange={(e) => setSettings({ ...settings, logo_emoji: e.target.value })} />
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
      </main>
    </div>
  );
}
