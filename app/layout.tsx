import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "EL RODEO — Punto de Venta",
  description: "Punto de venta de EL RODEO: ventas, inventario y corte de caja.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-MX">
      <body>{children}</body>
    </html>
  );
}
