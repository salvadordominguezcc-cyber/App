import { createClient, SupabaseClient } from "@supabase/supabase-js";

export const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

// La llave anon NUNCA se inventa: si falta o es un marcador, no hay cliente.
export const supabaseConfigured =
  SUPABASE_URL.startsWith("https://") &&
  ANON_KEY.length > 20 &&
  !ANON_KEY.includes("PENDING") &&
  !ANON_KEY.includes("TU_LLAVE");

export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(SUPABASE_URL, ANON_KEY)
  : null;

export const fmt = (cents: number) =>
  "$" + (cents / 100).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
