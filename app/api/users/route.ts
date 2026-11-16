import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Gestión de usuarios de EL RODEO — SOLO lado del servidor.
//
// La llave service_role NUNCA sale del servidor: vive en la variable de
// entorno SUPABASE_SERVICE_ROLE_KEY (sin prefijo NEXT_PUBLIC, tipo Secret
// en Vercel) y solo la lee esta ruta. El navegador jamás la ve ni la
// recibe. La llave anon no puede crear ni administrar usuarios de Auth,
// por eso esta gestión no se hace desde el cliente.
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
        "Falta configurar SUPABASE_SERVICE_ROLE_KEY en Vercel (Settings → Environment Variables, tipo Secret, ámbito Production). Sin ella no se pueden administrar usuarios desde el POS.",
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

function roleOf(email: string | undefined | null, metadata: unknown): Role {
  if (email?.toLowerCase() === ADMIN_EMAIL) return "admin";
  return (metadata as Record<string, unknown> | null)?.role === "admin"
    ? "admin"
    : "cajero";
}

// GET — lista de usuarios: correo, rol, fecha de creación, último acceso
// y si está desactivado (banned_until en el futuro).
export async function GET(req: NextRequest) {
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

// POST — crear usuario: { email, password, role? }.
// Rol por defecto: cajero. El correo queda confirmado (email_confirm)
// para que pueda entrar de inmediato sin confirmar por correo.
export async function POST(req: NextRequest) {
  const caller = await callerIsAdmin(req);
  if (!caller) return forbidden();
  const admin = serviceAdmin();
  if (!admin) return serviceKeyMissing();
  const body = await req.json().catch(() => ({}));
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const role: Role = body.role === "admin" ? "admin" : "cajero";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return bad("Escribe un correo válido.");
  if (password.length < 6)
    return bad("La contraseña debe tener al menos 6 caracteres.");
  try {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { role },
    });
    if (error) return supabaseError(translateCreateError(error.message), 400);
    return NextResponse.json({ ok: true, id: data.user?.id ?? null });
  } catch (e: any) {
    return supabaseError("No se pudo crear el usuario: " + (e?.message || e));
  }
}

// PATCH — cambiar rol y/o activar-desactivar: { id, role?, banned? }.
// banned true desactiva el acceso (ban de 10 años); false lo reactiva.
// No se puede modificar la propia cuenta ni la del admin principal.
export async function PATCH(req: NextRequest) {
  const caller = await callerIsAdmin(req);
  if (!caller) return forbidden();
  const admin = serviceAdmin();
  if (!admin) return serviceKeyMissing();
  const body = await req.json().catch(() => ({}));
  const id = String(body.id || "");
  if (!id) return bad("Falta el id del usuario.");
  if (id === caller.id)
    return bad("No puedes cambiar tu propia cuenta desde aquí.");
  try {
    const { data: target, error: getErr } = await admin.auth.admin.getUserById(id);
    if (getErr || !target.user) return bad("Usuario no encontrado.", 404);
    if (target.user.email?.toLowerCase() === ADMIN_EMAIL)
      return bad("La cuenta admin principal no se puede modificar desde aquí.");
    if (typeof body.role === "string") {
      const role: Role = body.role === "admin" ? "admin" : "cajero";
      const merged = { ...(target.user.user_metadata || {}), role };
      const { error } = await admin.auth.admin.updateUserById(id, {
        user_metadata: merged,
      });
      if (error) return supabaseError("No se pudo cambiar el rol: " + error.message);
    }
    if (typeof body.banned === "boolean") {
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
