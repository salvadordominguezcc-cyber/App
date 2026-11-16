import "./globals.css";
import type { Metadata, Viewport } from "next";
import SwRegister from "./sw-register";

export const metadata: Metadata = {
  title: "EL RODEO — Punto de Venta",
  description: "Punto de venta de EL RODEO: ventas, inventario y corte de caja.",
  manifest: "/manifest.json",
  icons: {
    icon: "/icon.svg",
    apple: "/icon.svg",
  },
  appleWebApp: {
    capable: true,
    title: "EL RODEO POS",
    statusBarStyle: "default",
  },
};

// En Next 14 el color del tema va en el export viewport, no en metadata.
export const viewport: Viewport = {
  themeColor: "#c2410c",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-MX">
      <body>
        <SwRegister />
        {children}
      </body>
    </html>
  );
}
