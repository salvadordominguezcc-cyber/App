import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// La ruta corre en el runtime edge de Cloudflare Workers (Cloudflare
// Pages): sin este export, Next.js usaría el runtime Node.js y el
// despliegue en Cloudflare fallaría. Las variables de entorno del
// servidor (SUPABASE_SERVICE_ROLE_KEY y las NEXT_PUBLIC_*) se leen
// igual con process.env: Cloudflare Pages las inyecta en el runtime
// edge de next-on-pages.
export const runtime = "edge";

// Gestión de usuarios de EL RODEO — SOLO lado del servidor.
//
// La llave service_role NUNCA sale del servidor: vive en la variable de
// entorno SUPABASE_SERVICE_ROLE_KEY (sin prefijo NEXT_PUBLIC, como
// secreto en Cloudflare Pages) y solo la lee esta ruta. El navegador
// jamás la ve ni la recibe. La llave anon no puede crear ni administrar
// usuarios de Auth, por eso esta gestión no se hace desde el cliente.
//
// Seguridad: cada petición trae el access token del usuario que llama
// (header Authorization: Bearer <token>). La ruta verifica ese token con
// un cliente anon (auth.getUser) y rechaza con 403 a cualquiera que no
// sea admin: correo ADMIN_EMAIL o user_metadata.role === "admin".

const ADMIN_EMAIL = "salvadordominguezcc@gmail.com";

// Cliente con la llave service_role. null si la variable no está puesta.
function serviceAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url.startsWith("https://") || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Verifica el token Bearer del que llama y devuelve su usuario solo si es
// admin. null en cualquier otro caso (sin token, token inválido o no admin).
async function callerIsAdmin(req: NextRequest) {
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  if (!url.startsWith("https://") || !anon) return null;
  const client = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user?.email) return null;
  const role = (data.user.user_metadata as Record<string, unknown> | null)?.role;
  const isAdmin =
    data.user.email.toLowerCase() === ADMIN_EMAIL || role === "admin";
  return isAdmin ? data.user : null;
}

function forbidden() {
  return NextResponse.json(
    {
      code: "FORBIDDEN",
      message: "Solo el administrador puede gestionar usuarios.",
    },
    { status: 403 },
  );
}

function serviceKeyMissing() {
  return NextResponse.json(
    {
      code: "SERVICE_ROLE_MISSING",
      message:
        "Falta configurar SUPABASE_SERVICE_ROLE_KEY en Cloudflare Pages (Settings → Environment Variables, como secreto, ámbito Production). Sin ella no se pueden administrar usuarios desde el POS.",
    },
    { status: 503 },
  );
}

function bad(message: string, status = 400) {
  return NextResponse.json({ code: "BAD_REQUEST", message }, { status });
}

function supabaseError(message: string, status = 500) {
  return NextResponse.json(
    { code: "SUPABASE_ERROR", message },
    { status },
  );
}

function translateCreateError(message: string) {
  if (message.includes("User already registered"))
    return "Ya existe un usuario con ese correo.";
  if (message.toLowerCase().includes("password"))
    return "La contraseña no es válida: debe tener al menos 6 caracteres.";
  if (message.toLowerCase().includes("email"))
    return "El correo no es válido.";
  return "No se pudo crear el usuario: " + message;
}

type Role = "admin" | "cajero";

// Nombre de usuario: letras, números, guion bajo y punto, sin espacios,
// mínimo 3 caracteres. Se guarda en minúsculas en user_metadata.username
// para que la búsqueda no distinga mayúsculas de minúsculas.
const USERNAME_RE = /^[a-zA-Z0-9._]{3,}$/;

// Correo interno sintético: cuando un usuario se crea solo con nombre de
// usuario (sin correo real), Supabase Auth igual exige un correo, así que
// la API genera `<usuario>@elrodeo.local`. Nadie lo usa para entrar: el
// login siempre es por el nombre de usuario (la resolución por username
// lo traduce a este correo interno). Se marca en user_metadata con
// internal_email = true para distinguirlo de un correo real.
const INTERNAL_EMAIL_DOMAIN = "elrodeo.local";

function internalEmailFor(username: string): string {
  return `${normalizeUsername(username)}@${INTERNAL_EMAIL_DOMAIN}`;
}

function isInternalEmail(email: string | undefined | null): boolean {
  return !!email && email.toLowerCase().endsWith(`@${INTERNAL_EMAIL_DOMAIN}`);
}

function isInternalUser(u: {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}): boolean {
  return (
    (u.user_metadata as Record<string, unknown> | null)?.internal_email ===
      true || isInternalEmail(u.email)
  );
}

function normalizeUsername(v: unknown): string {
  return String(v || "").trim().toLowerCase();
}

function usernameValid(u: string): boolean {
  return USERNAME_RE.test(u);
}

// Busca un usuario por nombre de usuario (user_metadata.username) entre
// los usuarios de Auth. Recorre las páginas de listUsers (100 por página,
// hasta 5 páginas) porque la lista es paginada.
async function findUserByUsername(
  admin: NonNullable<ReturnType<typeof serviceAdmin>>,
  username: string,
) {
  const wanted = normalizeUsername(username);
  if (!wanted) return null;
  for (let page = 1; page <= 5; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw new Error(error.message);
    const hit = (data.users || []).find(
      (u) => normalizeUsername((u.user_metadata as Record<string, unknown> | null)?.username) === wanted,
    );
    if (hit) return hit;
    if ((data.users || []).length < 100) break;
  }
  return null;
}

// Límite de la resolución de usuario → correo: máximo 20 intentos por
// minuto por IP (memoria del proceso; en serverless es por instancia, pero
// frena el abuso casual de adivinar usuarios). Si se pasa, se responde el
// mismo error genérico de login, sin revelar nada.
const resolveAttempts = new Map<string, number[]>();
function resolveRateLimited(ip: string): boolean {
  const now = Date.now();
  const list = (resolveAttempts.get(ip) || []).filter((t) => now - t < 60_000);
  if (list.length >= 20) {
    resolveAttempts.set(ip, list);
    return true;
  }
  list.push(now);
  resolveAttempts.set(ip, list);
  return false;
}

// Error genérico de login: el MISMO mensaje se usa tanto si el usuario no
// existe como si la contraseña es incorrecta, para no revelar si un
// nombre de usuario (o correo) existe.
const LOGIN_GENERIC_ERROR = "Correo, nombre de usuario o contraseña incorrectos. Revisa tus datos e inténtalo de nuevo.";

function roleOf(email: string | undefined | null, metadata: unknown): Role {
  if (email?.toLowerCase() === ADMIN_EMAIL) return "admin";
  return (metadata as Record<string, unknown> | null)?.role === "admin"
    ? "admin"
    : "cajero";
}

// GET — dos usos:
// 1) ?username=<usuario> — RESOLUCIÓN pública y limitada: dado un nombre
//    de usuario, devuelve SOLO su correo, para que el login pueda entrar
//    con usuario + contraseña (Supabase Auth solo acepta correo). NO pide
//    sesión de admin. Si el usuario no existe (o el formato es inválido),
//    responde el mismo error genérico de login, sin revelar si existe.
//    No expone contraseñas, no lista usuarios y solo resuelve un usuario
//    por llamada. Usa la llave service_role del servidor.
// 2) Sin ?username — lista de usuarios (solo admin, como antes).
export async function GET(req: NextRequest) {
  const usernameParam = req.nextUrl.searchParams.get("username");
  if (usernameParam !== null) {
    // Resolución de usuario → correo (pública, limitada).
    const username = normalizeUsername(usernameParam);
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";
    if (resolveRateLimited(ip) || !usernameValid(username)) {
      return NextResponse.json(
        { code: "LOGIN_FAILED", message: LOGIN_GENERIC_ERROR },
        { status: 404 },
      );
    }
    const admin = serviceAdmin();
    if (!admin) {
      return NextResponse.json(
        { code: "LOGIN_FAILED", message: LOGIN_GENERIC_ERROR },
        { status: 404 },
      );
    }
    try {
      const hit = await findUserByUsername(admin, username);
      if (!hit?.email) {
        return NextResponse.json(
          { code: "LOGIN_FAILED", message: LOGIN_GENERIC_ERROR },
          { status: 404 },
        );
      }
      return NextResponse.json({ email: hit.email });
    } catch {
      return NextResponse.json(
        { code: "LOGIN_FAILED", message: LOGIN_GENERIC_ERROR },
        { status: 404 },
      );
    }
  }
  const caller = await callerIsAdmin(req);
  if (!caller) return forbidden();
  const admin = serviceAdmin();
  if (!admin) return serviceKeyMissing();
  try {
    const { data, error } = await admin.auth.admin.listUsers({
      page: 1,
      perPage: 100,
    });
    if (error) return supabaseError("No se pudo listar los usuarios: " + error.message);
    const users = (data.users || []).map((u) => ({
      id: u.id,
      email: u.email ?? null,
      username: normalizeUsername((u.user_metadata as Record<string, unknown> | null)?.username) || null,
      internal_email: isInternalUser(u),
      role: roleOf(u.email, u.user_metadata),
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at ?? null,
      banned_until: u.banned_until ?? null,
    }));
    return NextResponse.json({ users });
  } catch (e: any) {
    return supabaseError("No se pudo listar los usuarios: " + (e?.message || e));
  }
}

// POST — crear usuario: { email?, password, role?, username? }.
// El correo es OPCIONAL: basta el correo o el nombre de usuario (al
// menos uno de los dos). Si no se pone correo pero sí usuario, se genera
// un correo interno sintético `<usuario>@elrodeo.local` y se crea el
// usuario en Supabase Auth con ese correo + la contraseña +
// user_metadata { role, username, internal_email: true }. Esa persona
// entra solo con su usuario y contraseña; el correo interno nadie lo usa.
// Rol por defecto: cajero. El correo queda confirmado (email_confirm)
// para que pueda entrar de inmediato sin confirmar por correo.
// username es obligatorio cuando no hay correo; si se da, debe ser único
// entre los usuarios (se rechaza con error claro si ya está en uso) y se
// guarda en user_metadata.username para poder entrar con usuario +
// contraseña.
export async function POST(req: NextRequest) {
  const caller = await callerIsAdmin(req);
  if (!caller) return forbidden();
  const admin = serviceAdmin();
  if (!admin) return serviceKeyMissing();
  const body = await req.json().catch(() => ({}));
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const role: Role = body.role === "admin" ? "admin" : "cajero";
  const username = normalizeUsername(body.username);
  if (!email && !username)
    return bad("Escribe el correo o el nombre de usuario del nuevo usuario (al menos uno de los dos).");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return bad("Escribe un correo válido.");
  if (password.length < 6)
    return bad("La contraseña debe tener al menos 6 caracteres.");
  if (username && !usernameValid(username))
    return bad("El nombre de usuario debe tener al menos 3 caracteres y solo puede usar letras, números, guion bajo (_) y punto (.), sin espacios.");
  // Sin correo real: correo interno sintético a partir del usuario.
  const internalEmail = !email;
  const finalEmail = internalEmail ? internalEmailFor(username) : email;
  try {
    if (username) {
      const taken = await findUserByUsername(admin, username);
      if (taken)
        return bad("Ese nombre de usuario ya está en uso. Elige otro.");
    }
    const { data, error } = await admin.auth.admin.createUser({
      email: finalEmail,
      password,
      email_confirm: true,
      user_metadata: internalEmail
        ? { role, username, internal_email: true }
        : username
          ? { role, username }
          : { role },
    });
    if (error) {
      if (error.message.includes("User already registered") && internalEmail)
        return supabaseError("Ese nombre de usuario ya está en uso. Elige otro.", 400);
      return supabaseError(translateCreateError(error.message), 400);
    }
    return NextResponse.json({ ok: true, id: data.user?.id ?? null, internal_email: internalEmail });
  } catch (e: any) {
    return supabaseError("No se pudo crear el usuario: " + (e?.message || e));
  }
}

// PATCH — cambiar rol, activar-desactivar, nombre de usuario y
// restablecer contraseña:
// { id, role?, banned?, username? } o { id, action: "reset_password", password }.
// banned true desactiva el acceso (ban de 10 años); false lo reactiva.
// Restablecer la contraseña pone la contraseña nueva con
// admin.updateUserById: el usuario entra de inmediato con ella, sin
// confirmar nada por correo, y NO reactiva a un usuario desactivado.
// No se puede cambiar el rol, desactivar, eliminar ni restablecer la
// contraseña de la propia cuenta ni la del admin principal (esa se
// cambia desde Supabase, Authentication → Users). El nombre de usuario
// SÍ se puede asignar o cambiar en cualquier cuenta (incluida la propia
// y la del admin principal), porque es solo un alias para entrar, no un
// permiso.
export async function PATCH(req: NextRequest) {
  const caller = await callerIsAdmin(req);
  if (!caller) return forbidden();
  const admin = serviceAdmin();
  if (!admin) return serviceKeyMissing();
  const body = await req.json().catch(() => ({}));
  const id = String(body.id || "");
  if (!id) return bad("Falta el id del usuario.");
  // Restablecer contraseña: { id, action: "reset_password", password }.
  if (body.action === "reset_password") {
    const password = String(body.password || "");
    if (password.length < 6)
      return bad("La nueva contraseña debe tener al menos 6 caracteres.");
    if (id === caller.id)
      return bad("Tu propia contraseña no se puede restablecer desde aquí: cámbiala desde Supabase (Authentication → Users).");
    try {
      const { data: target, error: getErr } = await admin.auth.admin.getUserById(id);
      if (getErr || !target.user) return bad("Usuario no encontrado.", 404);
      if (target.user.email?.toLowerCase() === ADMIN_EMAIL)
        return bad("La contraseña de la cuenta admin principal no se puede restablecer desde aquí: cámbiala desde Supabase (Authentication → Users).");
      const { error } = await admin.auth.admin.updateUserById(id, { password });
      if (error) {
        if (error.message.toLowerCase().includes("password"))
          return supabaseError("La contraseña no es válida: debe tener al menos 6 caracteres.", 400);
        return supabaseError("No se pudo restablecer la contraseña: " + error.message);
      }
      return NextResponse.json({ ok: true });
    } catch (e: any) {
      return supabaseError("No se pudo restablecer la contraseña: " + (e?.message || e));
    }
  }
  const hasRole = typeof body.role === "string";
  const hasBanned = typeof body.banned === "boolean";
  const hasUsername = typeof body.username === "string";
  if (!hasRole && !hasBanned && !hasUsername)
    return bad("No hay nada que cambiar.");
  const isSelf = id === caller.id;
  // Rol y bloqueo: protegidos para la propia cuenta y el admin principal.
  if ((hasRole || hasBanned) && isSelf)
    return bad("No puedes cambiar tu propia cuenta desde aquí.");
  try {
    const { data: target, error: getErr } = await admin.auth.admin.getUserById(id);
    if (getErr || !target.user) return bad("Usuario no encontrado.", 404);
    const isAdminPrincipal = target.user.email?.toLowerCase() === ADMIN_EMAIL;
    if ((hasRole || hasBanned) && isAdminPrincipal)
      return bad("La cuenta admin principal no se puede modificar desde aquí.");
    // Cuenta con correo interno: su correo sintético sigue a su usuario.
    const targetInternal = isInternalUser(target.user);
    // Se acumulan los cambios de metadata en un solo objeto para que el
    // cambio de usuario y el de rol no se pisen entre sí.
    const meta: Record<string, unknown> = { ...(target.user.user_metadata || {}) };
    let newInternalEmail: string | null = null;
    if (hasUsername) {
      const username = normalizeUsername(body.username);
      if (username && !usernameValid(username))
        return bad("El nombre de usuario debe tener al menos 3 caracteres y solo puede usar letras, números, guion bajo (_) y punto (.), sin espacios.");
      if (!username && targetInternal)
        return bad("Esta cuenta no tiene correo real: necesita un nombre de usuario para entrar. Ponle un usuario en lugar de quitarlo.");
      if (username) {
        const taken = await findUserByUsername(admin, username);
        if (taken && taken.id !== id)
          return bad("Ese nombre de usuario ya está en uso. Elige otro.");
        if (targetInternal) newInternalEmail = internalEmailFor(username);
      }
      meta.username = username || null;
    }
    if (hasRole) {
      meta.role = body.role === "admin" ? "admin" : "cajero";
    }
    if (hasUsername || hasRole) {
      const { error } = await admin.auth.admin.updateUserById(id, {
        user_metadata: meta,
        ...(newInternalEmail ? { email: newInternalEmail } : {}),
      });
      if (error) return supabaseError("No se pudo actualizar el usuario: " + error.message);
    }
    if (hasBanned) {
      const { error } = await admin.auth.admin.updateUserById(id, {
        ban_duration: body.banned ? "87600h" : "none",
      });
      if (error)
        return supabaseError(
          "No se pudo " + (body.banned ? "desactivar" : "activar") + " al usuario: " + error.message,
        );
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return supabaseError("No se pudo actualizar el usuario: " + (e?.message || e));
  }
}

// DELETE — eliminar usuario: { id } en el cuerpo (o ?id= en la URL).
// No se puede eliminar la propia cuenta ni la del admin principal.
export async function DELETE(req: NextRequest) {
  const caller = await callerIsAdmin(req);
  if (!caller) return forbidden();
  const admin = serviceAdmin();
  if (!admin) return serviceKeyMissing();
  const body = await req.json().catch(() => ({}));
  const id = String(body.id || req.nextUrl.searchParams.get("id") || "");
  if (!id) return bad("Falta el id del usuario.");
  if (id === caller.id) return bad("No puedes eliminar tu propia cuenta.");
  try {
    const { data: target } = await admin.auth.admin.getUserById(id);
    if (target.user?.email?.toLowerCase() === ADMIN_EMAIL)
      return bad("La cuenta admin principal no se puede eliminar.");
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) return supabaseError("No se pudo eliminar el usuario: " + error.message);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return supabaseError("No se pudo eliminar el usuario: " + (e?.message || e));
  }
}
