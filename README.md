# EL RODEO — Punto de Venta (Next.js + Supabase + Vercel)

POS standalone de EL RODEO para usar fuera de Muse con link público.

## Qué incluye
- Ventas: rejilla de productos, atajos de kilo ¼ / ½ / 1 kg, ticket, efectivo (con cambio) / tarjeta / transferencia, folio. Opción "Otros · Precio variable": descripción opcional, monto y cantidad; se agrega al ticket como renglón "Otros" (o "Otros: <descripción>"), se cobra como una venta normal y se guarda en `sale_items` con `product_id` null, sin agregarse al catálogo ni a `products`. Funciona también sin internet (va a la cola offline).
- Imprimir ticket: después de cobrar aparece el comprobante (logo, negocio, dirección, horario, folio o "Pendiente" si es offline, fecha y hora, quién vendió, renglones, total, pago y cambio si fue en efectivo, mensaje del ticket) con el botón "🖨️ Imprimir ticket" (window.print, CSS de impresión: solo sale el comprobante en formato angosto de 80 mm, en celular abre el diálogo de imprimir/compartir del sistema). Cada venta de "Ventas recientes" tiene su botón "🖨️ Imprimir" para reimprimirlo; si la venta no trae renglones guardados, se avisa en lugar de imprimir un ticket vacío. Imprimir o reimprimir no duplica la venta.
- Catálogo: agregar, editar y quitar productos del menú. Sin stock: las ventas ya NO descuentan stock ni crean movimientos de inventario.
- Gastos: registrar gastos del día (descripción, monto, categoría) y ver el total del día. Se descuentan del efectivo esperado en el corte de caja. Ver "Gastos" abajo.
- Login por persona (Supabase Auth, email + contraseña), bitácora de accesos (solo admin) y gestión de usuarios con roles admin / cajero (solo admin). Ver "Login y bitácora" y "Usuarios y roles" abajo.
- Modo sin internet: vender y registrar gastos sin señal; todo se guarda en el equipo y se sincroniza solo al volver la conexión. Ver "Modo sin internet" abajo.
- Corte de caja: apertura con fondo, resumen por método de pago, esperado vs. contado, sobrante/faltante, historial.
- Reportes: totales, ventas de hoy, ventas por producto y ventas por persona (quién vendió cada venta: total y número de ventas de cada usuario o correo, hoy y en total). Cada venta guarda `sold_by_email` y `sold_by_name` en la tabla `sales`; si esas columnas aún no existen, la venta se guarda igual sin el vendedor.
- Diseño oscuro elegante (como el POS de Google Sheets): fondo café casi negro, texto crema, títulos serif y acento coral; botones tipo píldora, tarjetas redondeadas. Es el tema por defecto; si el tema guardado en Personalizar es "claro", se respeta el tema claro. El ticket impreso sigue saliendo en blanco y negro sobre blanco.
- Personalizar: nombre EL RODEO, eslogan, imagen de logo (se sube en la pestaña), color, tema, datos del negocio (dirección, teléfono, correo, RFC, horario, mensaje de ticket, fondo inicial).

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

## Logo del negocio (imagen)

- En **Personalizar** (solo admin) ya no hay campo de emoji: hay **"Subir
  imagen del logo"** (JPG, PNG o WebP, máx. 10 MB antes de comprimir). Al
  elegirla, el navegador la comprime con canvas a un máximo de 512×512 px
  y menos de 200 KB, muestra una vista previa, y se guarda en
  `settings.logo_url` como data URL (base64) al pulsar **"Guardar datos
  del negocio"**. Hay botón **"Quitar imagen"** para volver al logo por
  defecto. El emoji (`logo_emoji`, 🥩) queda solo como respaldo cuando no
  hay imagen subida y ya no se edita desde Personalizar.
- La imagen se muestra en el **header del POS** (círculo de 48 px) y en el
  **ticket** de la venta (círculo de 40 px junto al nombre del negocio).
- Sin internet, el logo se sigue viendo: los datos del negocio (incluida
  la imagen) se guardan también en `localStorage` de ese equipo (clave
  `elrodeo_settings`) al cargar y al guardar. Si se guarda sin internet,
  queda en el equipo y hay que volver a pulsar Guardar con internet para
  que quede en la nube.
- El icono de la **app instalada (PWA)** no cambia desde Personalizar: es
  el archivo fijo `public/icon.svg` (hoy lleva el logo oficial de EL
  RODEO, borrego con sombrero).

## Modo sin internet

- **Detección:** la app usa `navigator.onLine` y los eventos `online` /
  `offline` del navegador. El header muestra **"🟢 En línea"** o
  **"🔴 Sin internet — modo offline"**, más el contador de registros
  pendientes de sincronizar (`⏳ N pendientes`) y un botón **"Sincronizar
  ahora"** cuando hay pendientes y ya hay señal.
- **Cola offline:** cuando no hay internet (o se cae la red a mitad de un
  cobro/gasto/corte), la venta, el gasto o el corte se guarda en una cola
  persistente en el navegador (**localStorage**, clave
  `elrodeo_offline_queue`, ver `lib/offline.ts`) con un id temporal único
  (uuid generado en el cliente). La cola **sobrevive a cerrar y reabrir
  el navegador**. En Ventas, Gastos y Corte los pendientes se muestran
  marcados con **"⏳ pendiente de sincronizar"**.
- **Sincronización automática:** al volver la conexión (evento `online`)
  y también al cargar la app con sesión, la cola se envía a Supabase
  **en orden, uno por uno**. Cada registro se quita de la cola **solo
  cuando Supabase confirma el insert**; si uno falla, se queda en cola y
  la sincronización se detiene ahí para no alterar el orden, y se
  reintenta sola la próxima vez. Al final la app avisa cuántos se
  sincronizaron y si quedó alguno pendiente.
- **Regla de folios (sin duplicados):** una venta offline **no tiene
  folio** en pantalla (se muestra como "Pendiente"). El folio definitivo
  se asigna **al sincronizar**, leyendo el folio máximo real de la tabla
  `sales` en Supabase y sumando 1, y se vuelve a leer antes de cada
  venta por si otra terminal vendió mientras tanto. Así dos ventas
  nunca chocan con el mismo folio, aunque se hayan hecho sin internet
  en equipos distintos. Al sincronizar, la venta pendiente toma su
  folio definitivo en pantalla.
- **Corte de caja:** el efectivo esperado ya incluye las ventas en
  efectivo y los gastos **pendientes** del día (son parte de lo que hay
  en caja aunque aún no estén en Supabase). El corte muestra una línea
  "⏳ Aún sin sincronizar" con cuánto del esperado todavía vive solo en
  el equipo. Si el corte mismo se cierra sin internet, también va a la
  cola offline y se sincroniza después.
- **Con internet todo sigue igual que antes:** ventas, gastos y cortes
  van directo a Supabase como siempre; el modo offline solo entra en
  acción cuando falla la red. No toca el login, los roles ni la pestaña
  Usuarios, y no necesita la llave service_role.
- **Límites (importante):**
  - Los pendientes viven **solo en ese navegador / dispositivo** hasta
    sincronizar. Si se borra el caché o los datos del navegador (o se
    desinstala) antes de sincronizar, **los pendientes se pierden**.
  - Cada terminal tiene su propia cola: lo vendido sin internet en un
    celular no se ve en otro equipo hasta que el primero sincroniza.
  - El menú (catálogo) y los datos del negocio no se pueden cambiar sin
    internet: para vender offline el POS usa el menú y los precios ya
    cargados en ese navegador.
  - El login sí necesita internet la primera vez (la sesión se restaura
    sin internet si ya estaba iniciada en ese navegador).

## Instalar como app (PWA)

El POS es una app instalable (PWA): se instala en el celular o la
computadora y abre como una app normal, sin barra del navegador, y **abre
sin internet aunque no se haya abierto antes** (siempre que ya se haya
instalado y se haya entrado al menos una vez con internet).

- **Archivos:** `public/manifest.json` (nombre, colores, iconos),
  `public/sw.js` (service worker), `public/icon-192.png`,
  `public/icon-512.png`, `public/apple-touch-icon.png` y el registro en
  `app/sw-register.tsx` (llamado desde `app/layout.tsx`). El botón de
  instalación vive en `app/page.tsx` (header y pestaña Personalizar, solo
  admin). Para el push, los archivos nuevos en `public/` deben ir en la
  lista de archivos junto con `app/layout.tsx`, `app/page.tsx` y
  `app/sw-register.tsx`.
- **Qué hace el service worker (`public/sw.js`, caché
  `el-rodeo-pos-v1`):** en la primera visita con internet guarda el shell
  de la app (la página `/`, el manifiesto, los iconos y los archivos
  JS/CSS de `/_next/static/`). Después, sin internet, sirve ese shell
  guardado y el POS arranca en modo offline con la sesión restaurada y
  la cola de pendientes. Con internet, las páginas se traen siempre de
  la red primero (versión nueva) y el caché solo es respaldo. **Nunca
  guarda en caché** llamadas a Supabase ni a `/api/*` (datos y login no
  se cachean); eso lo maneja la cola offline de `lib/offline.ts`. Para
  forzar a todos los equipos a tomar una versión nueva del shell, sube
  `CACHE_NAME` (por ejemplo a `el-rodeo-pos-v2`).
- **Cómo se instala:**
  - **Android (Chrome):** abre el POS, toca el botón **"📲 Instalar
    app"** del header (o de Personalizar) o menú ⋮ → "Instalar app" /
    "Agregar a pantalla principal".
  - **iPhone (Safari):** no hay botón automático: botón Compartir →
    "Agregar a inicio". (En iPhone el service worker y el modo offline
    funcionan desde Safari; la instalación es solo un acceso directo a
    pantalla principal.)
  - **Computadora (Chrome/Edge):** icono de instalar en la barra de
    dirección o menú → "Instalar EL RODEO POS".
  - Si el navegador no ofrece el botón, la app igual queda guardada en
    caché al visitarla y se puede abrir desde el historial, pero para
    abrir sin internet desde cero conviene instalarla.
- **Límites (importante):**
  - La **primera instalación y el primer login necesitan internet** (la
    app y la sesión tienen que bajar al equipo al menos una vez).
  - El menú y los datos del negocio que se ven sin internet son los que
    ya se habían cargado en ese equipo; los cambios de catálogo y de
    Personalizar necesitan internet.
  - Si se desinstala la app o se borran los datos del navegador, hay que
    volver a instalarla y entrar con internet, y los pendientes sin
    sincronizar se pierden (igual que en el modo sin internet).
  - Cada equipo instala su propia copia: hay que instalarla en cada
    celular/computadora que la vaya a usar.

## Login y bitácora

- Login con Supabase Auth (correo o nombre de usuario + contraseña,
  `supabase.auth.signInWithPassword`). Sin sesión, el POS muestra solo
  la pantalla de login. La sesión persiste
  (supabase-js la guarda en el navegador) y se restaura al volver a abrirlo.
  Botón "Cerrar sesión" en el header. **No hay registro en la app.**
  Ver "Entrar con nombre de usuario" en la sección "Usuarios y roles".
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
  - **Crear usuario:** correo (opcional) + nombre de usuario
    (obligatorio si no hay correo) + contraseña (mín. 6 caracteres) +
    rol. Si no se pone correo, la API genera un correo interno
    sintético `<usuario>@elrodeo.local` (marcado en
    `user_metadata.internal_email`) que nadie usa: esa persona entra
    solo con su usuario y contraseña. El correo queda confirmado de
    inmediato, así que el usuario ya puede entrar sin confirmar por
    correo.
  - **Cambiar rol:** selector Cajero / Admin por usuario.
  - **Desactivar / Activar:** bloquea el acceso al POS (ban) o lo
    reactiva. Un usuario desactivado no puede entrar aunque tenga su
    contraseña.
  - **Restablecer contraseña:** botón por usuario (excepto la propia
    cuenta y la del admin principal): pide la contraseña nueva (mín. 6
    caracteres, con confirmación) y la guarda con
    `admin.updateUserById`. El usuario entra de inmediato con su usuario
    o correo y la contraseña nueva, sin confirmar nada por correo. Sirve
    para cuentas con correo real y para las de solo usuario (correo
    interno `@elrodeo.local`). Restablecer la contraseña NO reactiva a
    un usuario desactivado. La contraseña de la propia cuenta y la del
    admin principal se cambia desde Supabase (Authentication → Users).
  - **Eliminar:** con confirmación; borra la cuenta de Supabase Auth.
  - No se puede cambiar el rol, desactivar, eliminar ni restablecer la
    contraseña de la propia cuenta ni la del admin principal desde la
    pestaña. El nombre de usuario SÍ se puede asignar o cambiar en
    cualquier cuenta (incluida la propia y la del admin principal),
    porque es solo un alias para entrar, no un permiso.
  - Errores en español y en claro: correo duplicado ("Ya existe un
    usuario con ese correo"), contraseña corta, sesión expirada, etc.

### Entrar con nombre de usuario

- Además del correo, cada cuenta puede tener un **nombre de usuario**
  (opcional): letras, números, guion bajo (_) y punto (.), mínimo 3
  caracteres, sin espacios. Se guarda en `user_metadata.username` de
  Supabase Auth, en minúsculas.
- Se asigna al crear el usuario (campo "Usuario") o después,
  en la lista de Usuarios: cada cuenta muestra su usuario actual (o
  "sin usuario") y un campo para cambiarlo con el botón "Guardar
  usuario". Dejar el campo vacío quita el usuario y el login queda solo
  por correo. El header muestra `@usuario · correo · rol` cuando la
  cuenta tiene usuario.
- **Correo opcional al crear:** basta el correo o el nombre de usuario
  (al menos uno de los dos). Sin correo, el acceso se crea solo con
  usuario + contraseña y un correo interno `<usuario>@elrodeo.local`
  que nadie usa (marcado con `user_metadata.internal_email`). En la
  lista, esas cuentas muestran `@usuario` en negrita y el texto
  "correo interno, solo entra con su usuario" en lugar de un correo
  real. Si se le cambia el usuario a una cuenta con correo interno, su
  correo interno cambia con él; no se le puede quitar el usuario,
  porque quedaría sin forma de entrar. La cuenta admin principal
  (`Salvadordominguezcc@gmail.com`) conserva su correo real y nunca
  lleva correo interno.
- La pantalla de login tiene un solo campo: **"Correo o nombre de
  usuario"**. Si lo que se escribe lleva @, entra directo con ese
  correo. Si no lleva @, la app lo resuelve a su correo con
  `GET /api/users?username=<usuario>` y luego entra con
  `signInWithPassword` como siempre. La contraseña nunca viaja a esa
  ruta.
- La resolución es pública y limitada: devuelve **SOLO el correo**
  asociado (un usuario por llamada), no expone contraseñas ni lista
  usuarios, y si el usuario no existe responde el mismo error genérico
  de login ("Correo, nombre de usuario o contraseña incorrectos"), sin
  revelar si existe. Además tiene límite de 20 intentos por minuto por
  IP. La búsqueda usa la llave service_role del servidor, y la
  unicidad del usuario se verifica al crearlo y al cambiarlo: si ya
  está en uso, el error es "Ese nombre de usuario ya está en uso.
  Elige otro."

### Recuperar contraseña por correo

- En la pantalla de login, debajo de "Entrar", el enlace
  **"¿Olvidaste tu contraseña?"** abre un formulario donde se escribe
  el correo y se pulsa "Enviar enlace de recuperación". Usa
  `resetPasswordForEmail` con redirección a
  `https://el-rodeo-pos.vercel.app/reset-password` (esa URL debe estar
  agregada en Supabase Auth → URL Configuration → Redirect URLs).
- El mensaje de éxito es genérico a propósito ("Si ese correo tiene
  cuenta, te enviamos un enlace…") y no revela si el correo existe.
- La página **`/reset-password`** es pública y solo sirve con un
  enlace válido: intercambia el `?code=` de la URL (o lee la sesión
  del enlace implícito) y muestra el formulario de contraseña nueva
  (mín. 6 caracteres, con confirmación). Al guardar usa
  `updateUser({ password })`, cierra la sesión de recuperación y
  redirige al login. Si el enlace expiró o es inválido, muestra el
  error y un enlace para pedir otro.
- Los usuarios que entran solo con nombre de usuario (correo interno
  `@elrodeo.local`) no reciben correo: el formulario lo aclara y les
  dice que pidan su nueva contraseña al admin (restablecer desde la
  pestaña Usuarios).

### Por qué hace falta la llave service_role

La llave anon del navegador **no puede** crear ni administrar usuarios
de Supabase Auth. Por eso la gestión pasa por una API route del servidor
(`app/api/users/route.ts`): el navegador solo manda su token de sesión
(`Authorization: Bearer <access_token>`) y la ruta verifica con
`supabase.auth.getUser` que quien llama sea admin (correo
`Salvadordominguezcc@gmail.com` o `user_metadata.role === "admin"`) y
rechaza con 403 a cualquiera que no lo sea. Solo entonces usa la llave
service_role, que vive **únicamente del lado del servidor** y nunca se
expone al cliente. Endpoints: `GET` lista (admin), `GET ?username=`
resuelve un usuario a su correo (público, limitado), `POST` crear,
`PATCH` cambiar rol / activar-desactivar / nombre de usuario,
`DELETE` eliminar.

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
