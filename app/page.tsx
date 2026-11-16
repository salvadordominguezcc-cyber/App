"use client";
import { useEffect, useMemo, useState } from "react";
import { supabase, supabaseConfigured, fmt } from "../lib/supabase";
import { SEED_PRODUCTS, SEED_SETTINGS, Product } from "../lib/menu";

type Line = { product: Product; qty: number };
type Sale = { id: string; folio: number; total_cents: number; payment_method: string; created_at: string; items?: { product_name: string; quantity: number; subtotal_cents: number }[] };
type Movement = { id: string; product_name: string; type: string; quantity: number; reason: string; created_at: string };
type Cut = { id: string; opening_cents: number; expected_cents: number; counted_cents: number; difference_cents: number; created_at: string; status: string };

const TABS = ["Ventas", "Inventario", "Corte de caja", "Reportes", "Personalizar"] as const;

export default function POS() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Ventas");
  const [products, setProducts] = useState<Product[]>(SEED_PRODUCTS);
  const [settings, setSettings] = useState<any>(SEED_SETTINGS);
  const [sales, setSales] = useState<Sale[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
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
  const [adj, setAdj] = useState<Record<string, { qty: string; type: string; reason: string }>>({});

  const total = ticket.reduce((s, l) => s + l.product.price_cents * l.qty, 0);
  const cambio = pay === "efectivo" && cash ? Math.max(0, Math.round(parseFloat(cash) * 100) - total) : 0;

  async function load() {
    setLoading(true);
    if (supabase) {
      const { data: prods } = await supabase.from("products").select("*").eq("active", true).order("name");
      if (prods?.length) setProducts(prods.map((p: any) => ({ ...p, stock: Number(p.stock ?? 0), min_stock: Number(p.min_stock ?? 0) })));
      const { data: sett } = await supabase.from("settings").select("*").limit(1).maybeSingle();
      if (sett) setSettings({ ...SEED_SETTINGS, ...sett });
      const { data: s } = await supabase.from("sales").select("*, sale_items(product_name, quantity, subtotal_cents)").order("created_at", { ascending: false }).limit(50);
      if (s) setSales(s.map((x: any) => ({ ...x, items: x.sale_items })));
      const { data: m } = await supabase.from("inventory_movements").select("*").order("created_at", { ascending: false }).limit(50);
      if (m) setMovements(m);
      const { data: c } = await supabase.from("cash_cuts").select("*").order("created_at", { ascending: false }).limit(20);
      if (c) setCuts(c);
    }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

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
    // Descuento de inventario en pantalla
    setProducts((ps) => ps.map((p) => {
      const line = ticket.find((l) => l.product.id === p.id);
      return line ? { ...p, stock: Math.max(0, p.stock - line.qty) } : p;
    }));
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
        await supabase.from("inventory_movements").insert(ticket.map((l) => ({
          product_id: l.product.id.startsWith("seed-") ? null : l.product.id,
          product_name: l.product.name, type: "venta", quantity: -l.qty, reason: `Venta folio #${folio}`,
        })));
        for (const l of ticket) {
          if (!l.product.id.startsWith("seed-")) {
            await supabase.from("products").update({ stock: Math.max(0, l.product.stock - l.qty) }).eq("id", l.product.id);
          }
        }
        setMsg(`Venta #${folio} por ${fmt(total)} guardada en Supabase.`);
      }
    } else {
      setMsg(`Venta #${folio} por ${fmt(total)} registrada en pantalla. Conecta la llave anon de Supabase para guardarla en la nube.`);
    }
    setTicket([]); setCash(""); setCustomer("");
  }

  async function ajustar(p: Product) {
    const a = adj[p.id]; if (!a?.qty) return;
    const qty = parseFloat(a.qty); if (!qty) return;
    const delta = a.type === "merma" ? -qty : qty;
    setProducts((ps) => ps.map((x) => (x.id === p.id ? { ...x, stock: Math.max(0, x.stock + delta) } : x)));
    const mov: Movement = { id: crypto.randomUUID(), product_name: p.name, type: a.type, quantity: delta, reason: a.reason || a.type, created_at: new Date().toISOString() };
    setMovements((m) => [mov, ...m]);
    if (supabase && !p.id.startsWith("seed-")) {
      await supabase.from("products").update({ stock: Math.max(0, p.stock + delta) }).eq("id", p.id);
      await supabase.from("inventory_movements").insert({ product_id: p.id, product_name: p.name, type: a.type, quantity: delta, reason: a.reason || a.type });
    }
    setAdj((v) => ({ ...v, [p.id]: { qty: "", type: "entrada", reason: "" } }));
  }

  const ventasHoy = useMemo(() => sales.filter((s) => s.created_at.slice(0, 10) === new Date().toISOString().slice(0, 10)), [sales]);
  const efectivoHoy = ventasHoy.filter((s) => s.payment_method === "efectivo").reduce((s, x) => s + x.total_cents, 0);
  const tarjetaHoy = ventasHoy.filter((s) => s.payment_method === "tarjeta").reduce((s, x) => s + x.total_cents, 0);
  const transfHoy = ventasHoy.filter((s) => s.payment_method === "transferencia").reduce((s, x) => s + x.total_cents, 0);
  const esperado = Math.round(fondo * 100) + efectivoHoy;
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

  return (
    <div style={{ ["--accent" as any]: settings.main_color || "#c2410c" }}>
      <header>
        <div><h1>{settings.logo_emoji} {settings.business_name}</h1><p>{settings.slogan} · Punto de venta</p></div>
        <div style={{ textAlign: "right" }}><p>{supabaseConfigured ? "● Conectado a Supabase" : "○ Sin conexión a Supabase"}</p><p>{loading ? "Cargando…" : `${products.length} productos · ${sales.length} ventas`}</p></div>
      </header>
      {!supabaseConfigured && (
        <div className="banner">⚠️ Falta la llave anon de Supabase: el menú se muestra, pero las ventas no se guardan en la nube todavía. En Vercel agrega la variable <b>NEXT_PUBLIC_SUPABASE_ANON_KEY</b> con la llave “anon public” de Supabase (Settings → API) y vuelve a desplegar.</div>
      )}
      {supabaseConfigured && <div className="banner ok">✓ Conectado a Supabase: las ventas, el inventario y los cortes se guardan en la nube.</div>}
      <nav>{TABS.map((t) => (<button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>))}</nav>
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
                    <div className={p.stock <= p.min_stock ? "low" : "muted"}>Stock: {p.stock} {p.unit}</div>
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

        {tab === "Inventario" && (
          <div>
            <h2>Inventario</h2>
            {products.map((p) => (
              <div key={p.id} className="card" style={{ marginBottom: 10 }}>
                <div className="row"><span><b>{p.name}</b> · {fmt(p.price_cents)} / {p.unit}</span><span className={p.stock <= p.min_stock ? "low" : ""}>Stock: {p.stock} {p.unit}{p.stock <= p.min_stock ? " · ¡Existencia baja!" : ""}</span></div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <input style={{ maxWidth: 120 }} type="number" placeholder="Cantidad" value={adj[p.id]?.qty || ""} onChange={(e) => setAdj((v) => ({ ...v, [p.id]: { ...(v[p.id] || { type: "entrada", reason: "" }), qty: e.target.value } }))} />
                  <select style={{ maxWidth: 160 }} value={adj[p.id]?.type || "entrada"} onChange={(e) => setAdj((v) => ({ ...v, [p.id]: { ...(v[p.id] || { qty: "", reason: "" }), type: e.target.value } }))}>
                    <option value="entrada">Entrada</option><option value="merma">Merma</option><option value="ajuste">Ajuste</option>
                  </select>
                  <input style={{ flex: 1, minWidth: 140 }} placeholder="Motivo" value={adj[p.id]?.reason || ""} onChange={(e) => setAdj((v) => ({ ...v, [p.id]: { ...(v[p.id] || { qty: "", type: "entrada" }), reason: e.target.value } }))} />
                  <button className="btn" onClick={() => ajustar(p)}>Registrar</button>
                </div>
              </div>
            ))}
            <h2>Movimientos</h2>
            {movements.slice(0, 20).map((m) => (<div key={m.id} className="row"><span>{m.product_name} · {m.type} · {m.reason}</span><b>{m.quantity}</b></div>))}
            {!movements.length && <p className="muted">Sin movimientos todavía.</p>}
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
                <div className="row"><span>Ventas con tarjeta hoy</span><b>{fmt(tarjetaHoy)}</b></div>
                <div className="row"><span>Ventas por transferencia hoy</span><b>{fmt(transfHoy)}</b></div>
                <div className="row"><span>Efectivo esperado</span><b>{fmt(esperado)}</b></div>
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
      </main>
    </div>
  );
}
