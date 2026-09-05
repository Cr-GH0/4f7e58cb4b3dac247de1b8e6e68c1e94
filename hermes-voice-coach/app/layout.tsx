import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mimi · English conversation",
  description:
    "Practice English with Mimi, on your own or in a group of three. Keep a transcript for each speaker.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

