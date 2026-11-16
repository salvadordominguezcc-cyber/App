# EL RODEO — Punto de Venta (Next.js + Supabase + Vercel)

POS standalone de EL RODEO para usar fuera de Muse con link público.

## Qué incluye
- Ventas: rejilla de productos, atajos de kilo ¼ / ½ / 1 kg, ticket, efectivo (con cambio) / tarjeta / transferencia, folio.
- Catálogo: agregar, editar y quitar productos del menú. Sin stock: las ventas ya NO descuentan stock ni crean movimientos de inventario.
- Gastos: registrar gastos del día (descripción, monto, categoría) y ver el total del día. Se descuentan del efectivo esperado en el corte de caja. Ver "Gastos" abajo.
- Login por persona (Supabase Auth, email + contraseña) y bitácora de accesos (solo admin). Ver "Login y bitácora" abajo.
- Corte de caja: apertura con fondo, resumen por método de pago, esperado vs. contado, sobrante/faltante, historial.
- Reportes: totales, ventas de hoy, ventas por producto.
- Personalizar: nombre EL RODEO, eslogan, emoji de logo, color, tema, datos del negocio (dirección, teléfono, correo, RFC, horario, mensaje de ticket, fondo inicial).

## Base de datos
Supabase, proyecto `el-rodeo-pos` — https://hhrtiqdagnbdckdkoxih.supabase.co
Tablas: products (7 productos reales), sales, sale_items, inventory_movements, cash_cuts, settings, access_log, expenses.
Los ids de Supabase son uuid: la app nunca envía ids enteros como uuid (eso rompía la sincronización del POS de Muse con error 22P02); deja que Supabase genere los uuid de ventas/renglones/movimientos/cortes y usa el uuid real devuelto al insertar.

## Despliegue en Vercel
1. Crear el proyecto `el-rodeo-pos` (framework Next.js).
2. Variables de entorno (Production y Preview):
   - `NEXT_PUBLIC_SUPABASE_URL=https://hhrtiqdagnbdckdkoxih.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY=` ← la llave **"anon public"** de Supabase (Settings → API). Sin ella la app muestra el menú pero NO guarda ventas en la nube.
3. Desplegar (`npm run build` ya verificado en local).

## Gastos

- Pestaña "Gastos" (entre Catálogo y Corte de caja, visible para todos los
  usuarios con sesión): formulario con descripción, monto en $ y categoría
  (Insumos, Servicios, Transporte, Nómina, Otros), lista de gastos de hoy
  con hora, descripción, categoría y monto, total del día, y botón Eliminar
  (con confirmación).
- Los gastos se guardan en Supabase, tabla `expenses`. Al cargar, la app
  lee los últimos 100 gastos y filtra los de hoy por fecha local
  (America/Tijuana). Si la tabla aún no existe, los gastos se guardan solo
  en pantalla y la pestaña lo avisa con claridad, sin romper la app.
- Corte de caja: muestra "Gastos del día (salidas de caja)" y el efectivo
  esperado ya es **fondo inicial + ventas en efectivo de hoy − gastos del
  día**. El cierre guarda ese esperado ya descontado. Sin gastos, el corte
  queda igual que antes.

### Crear la tabla `expenses` en Supabase (SQL Editor)

```sql
create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  description text not null,
  amount_cents int not null check (amount_cents > 0),
  category text,
  created_at timestamptz not null default now()
);

-- Como el resto de tablas de este POS, sin RLS, para que la app con la
-- llave anon pueda insertar, leer y eliminar gastos:
alter table public.expenses disable row level security;
```

## Login y bitácora

- Login con Supabase Auth (email + contraseña, `supabase.auth.signInWithPassword`).
  Sin sesión, el POS muestra solo la pantalla de login. La sesión persiste
  (supabase-js la guarda en el navegador) y se restaura al volver a abrirlo.
  Botón "Cerrar sesión" en el header. **No hay registro en la app.**
- Admin principal: `Salvadordominguezcc@gmail.com`. Solo ese correo ve la
  pestaña "Bitácora".
- Bitácora: en cada login exitoso y en cada cierre de sesión la app inserta
  en `access_log` `{user_id, user_email, action: 'login'|'logout', created_at}`.
  Si la tabla no existe, el insert falla sin bloquear el login (aviso en
  consola) y la pestaña muestra "Bitácora aún no activada en Supabase".
  La pestaña lista los últimos 100 registros, más recientes primero.

### 1. Crear la tabla `access_log` en Supabase (SQL Editor)

```sql
create table if not exists public.access_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  user_email text,
  action text not null check (action in ('login', 'logout')),
  created_at timestamptz not null default now()
);

-- Como el resto de tablas de este POS, sin RLS, para que la app con la
-- llave anon pueda insertar y leer la bitácora:
alter table public.access_log disable row level security;
```

### 2. Crear usuarios en Supabase Auth

Supabase → proyecto `el-rodeo-pos` → Authentication → Users → **Add user** →
correo + contraseña → **Create user** (marca "Auto Confirm User" para que
pueda entrar sin confirmar el correo). Repite por cada persona.
El admin principal es `Salvadordominguezcc@gmail.com`; créalo igual que
los demás, con su propia contraseña (nunca la compartas por chat).

## Estado
- `npm run build` local: OK (Next.js 14.2.13, ruta `/` 71 kB).
- Despliegue en Vercel: BLOQUEADO el 2026-11-15 — la API de Vercel devuelve 403 "Not authorized" para el scope `salvadordominguezcc-7032` (team `team_vIRmW5ilBsFZoFpkpsMMMJgK`) en `list_projects`, `create_project` y `get_project`. La recuperación indicada es `authorize_team_access`, herramienta que no está disponible en este conector; refrescar el token no lo resolvió. Hace falta que el usuario apruebe el acceso del equipo en Vercel y se reintente el despliegue.
