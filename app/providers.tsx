'use client'

/**
 * app/providers.tsx
 *
 * Client-side provider tree.  This is the single 'use client' boundary that
 * wraps children in all context providers.  app/layout.tsx stays a Server
 * Component and simply renders <Providers>{children}</Providers>.
 */

import { WalletProvider } from '@/lib/stellar/wallet'

export function Providers({ children }: { children: React.ReactNode }) {
  return <WalletProvider>{children}</WalletProvider>
}
