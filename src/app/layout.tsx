import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "IgzPatch",
  description: "Auditable GitHub issue-to-draft-PR agent",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

