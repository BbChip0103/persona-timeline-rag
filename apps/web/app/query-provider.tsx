'use client';
import { useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createWebQueryClient } from '../lib/query-client';
export function QueryProvider({children}:{children:React.ReactNode}) {
  const [client]=useState(createWebQueryClient);return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
