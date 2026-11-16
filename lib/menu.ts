export type Product = {
  id: string; // uuid de Supabase cuando viene de la base; id local solo para el menú semilla
  name: string;
  price_cents: number;
  unit: string;
  category: string;
  description: string;
  stock: number;
  min_stock: number;
  active: boolean;
};

// Menú real de EL RODEO (foto del menú, 2026-11-15). Se usa solo como
// respaldo visible mientras Supabase no está conectado; los precios
// reales viven en la tabla products de Supabase.
export const SEED_PRODUCTS: Product[] = [
  { id: "seed-barbacoa", name: "Barbacoa por kilo", price_cents: 75000, unit: "kg", category: "Barbacoa", description: "Precio de inauguración", stock: 20, min_stock: 5, active: true },
  { id: "seed-taco", name: "Taco de barbacoa", price_cents: 5000, unit: "pieza", category: "Barbacoa", description: "", stock: 50, min_stock: 10, active: true },
  { id: "seed-consome-litro", name: "Litro de consomé", price_cents: 6500, unit: "litro", category: "Consomé", description: "", stock: 30, min_stock: 5, active: true },
  { id: "seed-consome-plato", name: "Plato de consomé", price_cents: 3500, unit: "pieza", category: "Consomé", description: "", stock: 30, min_stock: 5, active: true },
  { id: "seed-tlacoyos", name: "Tlacoyos (4 pzs)", price_cents: 5000, unit: "orden", category: "Antojitos", description: "", stock: 20, min_stock: 5, active: true },
  { id: "seed-refresco", name: "Refresco", price_cents: 3500, unit: "pieza", category: "Bebidas", description: "", stock: 48, min_stock: 12, active: true },
  { id: "seed-cafe", name: "Café de olla", price_cents: 3500, unit: "pieza", category: "Bebidas", description: "Refill gratis en local", stock: 40, min_stock: 10, active: true },
];

export const SEED_SETTINGS = {
  business_name: "EL RODEO",
  slogan: "Barbacoa",
  logo_emoji: "🥩",
  main_color: "#c2410c",
  theme: "claro",
  address: "",
  phone: "",
  whatsapp: "",
  email: "",
  rfc: "",
  hours: "",
  ticket_message: "¡Gracias por su visita!",
  initial_cash_cents: 50000,
};
