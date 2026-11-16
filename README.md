# EL RODEO — Punto de Venta (Next.js + Supabase + Vercel)

POS standalone de EL RODEO para usar fuera de Muse con link público.

## Qué incluye
- Ventas: rejilla de productos, atajos de kilo ¼ / ½ / 1 kg, ticket, efectivo (con cambio) / tarjeta / transferencia, folio.
- Catálogo: agregar, editar y quitar productos del menú. Sin stock: las ventas ya NO descuentan stock ni crean movimientos de inventario.
- Gastos: registrar gastos del día (descripción, monto, categoría) y ver el total del día. Se descuentan del efectivo esperado en el corte de caja. Ver "Gastos" abajo.
- Login por persona (Supabase Auth, email + contraseña), bitácora de accesos (solo admin) y gestión de usuarios con roles admin / cajero (solo admin). Ver "Login y bitácora" y "Usuarios y roles" abajo.
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
   - `SUPABASE_SERVICE_ROLE_KEY=` ← la llave **"service_role"** de Supabase (Settings → API). Solo para la pestaña Usuarios; ver "Usuarios y roles" abajo. Sin prefijo `NEXT_PUBLIC`, tipo **Secret**, ámbito **Production**. Nunca se comparte por chat ni se pone como `NEXT_PUBLIC`.
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

### 2. Crear usuarios

La forma normal es desde la pestaña **Usuarios** (solo admin, ver
"Usuarios y roles" abajo). Como alternativa, también se pueden crear en
Supabase → proyecto `el-rodeo-pos` → Authentication → Users →
**Add user** → correo + contraseña → **Create user** (marca "Auto Confirm
User" para que pueda entrar sin confirmar el correo). Repite por cada
persona. El admin principal es `Salvadordominguezcc@gmail.com`; créalo
igual que los demás, con su propia contraseña (nunca la compartas por
chat). Los usuarios creados así, sin rol en su metadata, entran como
cajero; el admin les puede subir el rol desde la pestaña Usuarios.

## Usuarios y roles

- Roles: **admin** y **cajero**. El rol se guarda en `user_metadata.role`
  de Supabase Auth. El correo `Salvadordominguezcc@gmail.com` siempre es
  admin aunque no tenga el metadata. Los usuarios nuevos se crean con
  rol **cajero** por defecto.
- Permisos por rol:
  - **Cajero:** Ventas, Catálogo, Gastos, Corte de caja y Reportes.
  - **Admin:** todo lo anterior + Personalizar, Bitácora y Usuarios.
  - Si a un usuario le cambian el rol mientras está en una pestaña que
    ya no ve (por ejemplo, un cajero que estaba en Personalizar), la app
    lo regresa automáticamente a Ventas. El header muestra el rol junto
    al correo ("Admin" / "Cajero").
- Pestaña **Usuarios** (después de Personalizar, junto a Bitácora, solo
  admin): lista todos los usuarios con correo, rol, fecha de creación y
  último acceso. Acciones por usuario:
  - **Crear usuario:** correo + contraseña (mín. 6 caracteres) + rol.
    El correo queda confirmado de inmediato, así que el usuario ya puede
    entrar sin confirmar por correo.
  - **Cambiar rol:** selector Cajero / Admin por usuario.
  - **Desactivar / Activar:** bloquea el acceso al POS (ban) o lo
    reactiva. Un usuario desactivado no puede entrar aunque tenga su
    contraseña.
  - **Eliminar:** con confirmación; borra la cuenta de Supabase Auth.
  - No se puede modificar ni eliminar la propia cuenta ni la del admin
    principal desde la pestaña.
  - Errores en español y en claro: correo duplicado ("Ya existe un
    usuario con ese correo"), contraseña corta, sesión expirada, etc.

### Por qué hace falta la llave service_role

La llave anon del navegador **no puede** crear ni administrar usuarios
de Supabase Auth. Por eso la gestión pasa por una API route del servidor
(`app/api/users/route.ts`): el navegador solo manda su token de sesión
(`Authorization: Bearer <access_token>`) y la ruta verifica con
`supabase.auth.getUser` que quien llama sea admin (correo
`Salvadordominguezcc@gmail.com` o `user_metadata.role === "admin"`) y
rechaza con 403 a cualquiera que no lo sea. Solo entonces usa la llave
service_role, que vive **únicamente del lado del servidor** y nunca se
expone al cliente. Endpoints: `GET` lista, `POST` crear, `PATCH` cambiar
rol / activar-desactivar, `DELETE` eliminar.

### Agregar `SUPABASE_SERVICE_ROLE_KEY` en Vercel (solo el dueño)

1. Supabase → proyecto `el-rodeo-pos` → **Settings → API** → copia la
   llave **service_role** (la que dice "secret", NO la "anon public").
   ⚠️ Esta llave tiene poder total sobre el proyecto: **nunca la
   compartas por chat, correo ni capturas, y nunca la pongas como
   `NEXT_PUBLIC_`** (eso la expondría en el navegador).
2. Vercel → proyecto `el-rodeo-pos` → **Settings → Environment
   Variables** → **Add New**:
   - **Key:** `SUPABASE_SERVICE_ROLE_KEY`
   - **Value:** la llave service_role copiada en el paso 1.
   - **Type:** **Secret** (o "Sensitive").
   - **Environment:** marca **Production** (y Preview si quieres
     probarla en previews).
   - **Save**.
3. **Redeploy** el proyecto (Deployments → ⋯ → Redeploy) para que la
   variable tome efecto.
4. Entra al POS como admin y abre la pestaña **Usuarios**: ya debe
   listar los usuarios.
- Si la variable falta, la pestaña Usuarios muestra el aviso "falta la
  variable SUPABASE_SERVICE_ROLE_KEY en Vercel" y el resto del POS sigue
  funcionando normal (ventas, gastos, cortes, reportes y login no
  dependen de ella).

## Estado
- `npm run build` local: OK (Next.js 14.2.13, ruta `/` 71 kB).
- Despliegue en Vercel: BLOQUEADO el 2026-11-15 — la API de Vercel devuelve 403 "Not authorized" para el scope `salvadordominguezcc-7032` (team `team_vIRmW5ilBsFZoFpkpsMMMJgK`) en `list_projects`, `create_project` y `get_project`. La recuperación indicada es `authorize_team_access`, herramienta que no está disponible en este conector; refrescar el token no lo resolvió. Hace falta que el usuario apruebe el acceso del equipo en Vercel y se reintente el despliegue.
