# EL RODEO — Punto de Venta (Next.js + Supabase + Vercel)

POS standalone de EL RODEO para usar fuera de Muse con link público.

## Qué incluye
- Ventas: rejilla de productos, atajos de kilo ¼ / ½ / 1 kg, ticket, efectivo (con cambio) / tarjeta / transferencia, folio.
- Inventario: stock por producto, aviso de stock bajo, entradas / mermas / ajustes, historial de movimientos, descuento automático al vender.
- Corte de caja: apertura con fondo, resumen por método de pago, esperado vs. contado, sobrante/faltante, historial.
- Reportes: totales, ventas de hoy, ventas por producto.
- Personalizar: nombre EL RODEO, eslogan, emoji de logo, color, tema, datos del negocio (dirección, teléfono, correo, RFC, horario, mensaje de ticket, fondo inicial).

## Base de datos
Supabase, proyecto `el-rodeo-pos` — https://hhrtiqdagnbdckdkoxih.supabase.co
Tablas: products (7 productos reales), sales, sale_items, inventory_movements, cash_cuts, settings.
Los ids de Supabase son uuid: la app nunca envía ids enteros como uuid (eso rompía la sincronización del POS de Muse con error 22P02); deja que Supabase genere los uuid de ventas/renglones/movimientos/cortes y usa el uuid real devuelto al insertar.

## Despliegue en Vercel
1. Crear el proyecto `el-rodeo-pos` (framework Next.js).
2. Variables de entorno (Production y Preview):
   - `NEXT_PUBLIC_SUPABASE_URL=https://hhrtiqdagnbdckdkoxih.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY=` ← la llave **"anon public"** de Supabase (Settings → API). Sin ella la app muestra el menú pero NO guarda ventas en la nube.
3. Desplegar (`npm run build` ya verificado en local).

## Estado
- `npm run build` local: OK (Next.js 14.2.13, ruta `/` 71 kB).
- Despliegue en Vercel: BLOQUEADO el 2026-11-15 — la API de Vercel devuelve 403 "Not authorized" para el scope `salvadordominguezcc-7032` (team `team_vIRmW5ilBsFZoFpkpsMMMJgK`) en `list_projects`, `create_project` y `get_project`. La recuperación indicada es `authorize_team_access`, herramienta que no está disponible en este conector; refrescar el token no lo resolvió. Hace falta que el usuario apruebe el acceso del equipo en Vercel y se reintente el despliegue.
