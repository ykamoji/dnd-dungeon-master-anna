import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const cinzel = localFont({
  variable: "--font-cinzel",
  src: [
    { path: "../assets/fonts/Cinzel-400.ttf", weight: "400" },
    { path: "../assets/fonts/Cinzel-600.ttf", weight: "600" },
    { path: "../assets/fonts/Cinzel-700.ttf", weight: "700" },
    { path: "../assets/fonts/Cinzel-900.ttf", weight: "900" },
  ],
});
const medieval = localFont({
  variable: "--font-medieval",
  src: "../assets/fonts/MedievalSharp-400.ttf",
  weight: "400",
});
const garamond = localFont({
  variable: "--font-garamond",
  src: [
    { path: "../assets/fonts/EB-Garamond-400.ttf", weight: "400" },
    { path: "../assets/fonts/EB-Garamond-500.ttf", weight: "500" },
    { path: "../assets/fonts/EB-Garamond-600.ttf", weight: "600" },
    { path: "../assets/fonts/EB-Garamond-700.ttf", weight: "700" },
    { path: "../assets/fonts/EB-Garamond-400-italic.ttf", weight: "400", style: "italic" },
  ],
});

export const metadata: Metadata = {
  title: "D&D Dungeon Master Assistant",
  description: "An AI-powered Dungeon Master. Forge a party, choose your adventure, and play.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${cinzel.variable} ${medieval.variable} ${garamond.variable} h-full antialiased`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
