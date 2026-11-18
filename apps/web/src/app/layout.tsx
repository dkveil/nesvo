import '@fontsource-variable/inter';
import './globals.css';

import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { siteMetadata } from './site-metadata';

export const metadata: Metadata = siteMetadata;

export const viewport: Viewport = {
  themeColor: '#000000',
  colorScheme: 'dark',
};

type RootLayoutProps = {
  children: ReactNode;
};

const RootLayout = ({ children }: RootLayoutProps) => (
  <html lang="en">
    <body>{children}</body>
  </html>
);

export default RootLayout;
