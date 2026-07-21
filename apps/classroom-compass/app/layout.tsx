import type { Metadata } from "next";
import { Manrope, Newsreader } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
});

const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:3000";
  const protocol = host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https";
  return {
    metadataBase: new URL(`${protocol}://${host}`),
    title: "Classroom Compass — Teacher-controlled Visual Bridges",
    description: "A privacy-conscious classroom assistant that turns learning obstacles into short, teacher-approved interactive representations.",
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      title: "Classroom Compass",
      description: "Teacher-approved Visual Bridges for the learning moment in front of you.",
      images: [{ url: "/og.png", width: 1536, height: 1024, alt: "Classroom Compass decimal Visual Bridge" }],
    },
    twitter: { card: "summary_large_image", title: "Classroom Compass", description: "Teacher-approved Visual Bridges", images: ["/og.png"] },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${manrope.variable} ${newsreader.variable}`}
      >
        {children}
      </body>
    </html>
  );
}
