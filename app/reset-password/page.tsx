"use client";

import { useEffect, useState } from "react";
import { supabase, supabaseConfigured } from "../../lib/supabase";

// Página pública para restablecer la contraseña con el enlace que
// Supabase manda por correo. NO pide login previo: solo sirve con un
// enlace válido de recuperación. Si el enlace expiró o es inválido,
// muestra el error y un enlace para pedir otro desde el login.
// Requiere que en Supabase Auth → URL Configuration esté agregada
// como Redirect URL la URL de reset de tu dominio actual, por ejemplo
// https://el-rodeo-pos.pages.dev/reset-password (o la de Vercel si
// sigues ahí).
export default function ResetPassword() {
  const [status, setStatus] = useState<"checking" | "ready" | "invalid" | "done">("checking");
  const [error, setError] = useState("");
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      if (!supabase || !supabaseConfigured) {
        setStatus("invalid");
        setError("Supabase no está conectado: falta la llave anon en el despliegue.");
        return;
      }
      // Flujo PKCE: el enlace trae ?code=… y se intercambia por sesión.
      const params = new URLSearchParams(window.location.search);
      const code = params.get("code");
      if (code) {
        const { data, error } = await supabase.auth.exchangeCodeForSession(code);
        if (error || !data.session) {
          setStatus("invalid");
          setError("El enlace expiró o ya no es válido. Pide otro desde la pantalla de login.");
          return;
        }
        setStatus("ready");
        return;
      }
      // Flujo implícito: el token viene en el # de la URL y supabase-js
      // ya lo detectó al crear el cliente; basta con leer la sesión.
      const { data } = await supabase.auth.getSession();
      if (data.session?.user) {
        setStatus("ready");
        return;
      }
      setStatus("invalid");
      setError("El enlace expiró o ya no es válido. Pide otro desde la pantalla de login.");
    })();
  }, []);

  async function guardar() {
    if (!supabase) return;
    if (pass.length < 6) {
      setError("La contraseña debe tener al menos 6 caracteres.");
      return;
    }
    if (pass !== confirm) {
      setError("Las contraseñas no coinciden. Escríbelas igual en los dos campos.");
      return;
    }
    setSaving(true);
    setError("");
    const { error } = await supabase.auth.updateUser({ password: pass });
    setSaving(false);
    if (error) {
      setError("No se pudo guardar la contraseña: " + error.message);
      return;
    }
    // Cierra la sesión de recuperación para que el login quede limpio.
    await supabase.auth.signOut();
    setStatus("done");
  }

  return (
    <div className="card" style={{ maxWidth: 420, margin: "80px auto" }}>
      <h1>
        <img src="/icon.svg" alt="Logo de EL RODEO" style={{ width: 48, height: 48, objectFit: "cover", borderRadius: "50%", verticalAlign: "middle", marginRight: 8 }} />
        EL RODEO
      </h1>
      <p className="muted">Restablecer tu contraseña</p>

      {status === "checking" && <p className="muted">Verificando tu enlace…</p>}

      {status === "ready" && (
        <>
          <label>Contraseña nueva</label>
          <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Mínimo 6 caracteres" onKeyDown={(e) => { if (e.key === "Enter") guardar(); }} />
          <label>Confirma la contraseña nueva</label>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Escríbela igual otra vez" onKeyDown={(e) => { if (e.key === "Enter") guardar(); }} />
          {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
          <button className="btn" style={{ width: "100%", marginTop: 12 }} disabled={saving} onClick={guardar}>
            {saving ? "Guardando…" : "Guardar contraseña nueva"}
          </button>
        </>
      )}

      {status === "invalid" && (
        <>
          <p style={{ color: "#b91c1c" }}>{error}</p>
          <p className="muted">Los enlaces de recuperación caducan y solo se pueden usar una vez.</p>
          <a href="/" className="btn" style={{ display: "block", textAlign: "center", marginTop: 12 }}>Pedir otro enlace</a>
        </>
      )}

      {status === "done" && (
        <>
          <p style={{ color: "#166534" }}>✅ Contraseña actualizada. Ya puedes entrar con tu correo o tu nombre de usuario y la contraseña nueva.</p>
          <a href="/" className="btn" style={{ display: "block", textAlign: "center", marginTop: 12 }}>Volver al login</a>
        </>
      )}
    </div>
  );
}
