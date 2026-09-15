'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { NETWORKS, type StellarNetwork } from '@/lib/stellar/networks'
import { useWallet } from '@/lib/stellar/wallet'
import { createContractClient } from '@/lib/stellar/contract-client'

// ── Types ─────────────────────────────────────────────────────────────────────

type Subscription = {
  id: number
  subscriptionId: string
  ownerId: string
  network: string
  contractAddress: string
  deliveryChannel: string | null
  deliveryEndpoint: string | null
  active: boolean
  eventFilter: { eventTypes?: string[] }
  txHash?: string | null
}

type EventItem = {
  eventId: string
  eventType: string
  contractAddress: string
  network: string
  ledgerNumber: number
  transactionHash: string
  createdAt: string | Date
}

type TxStatus = 'idle' | 'simulating' | 'signing' | 'submitting' | 'confirmed' | 'error'

// ── Demo seeds (shown before API/wallet data loads) ───────────────────────────

const DEMO_SUBSCRIPTIONS: Subscription[] = [
  { id: 1, subscriptionId: 'sub_payments_01', ownerId: 'G...7KQ2', network: 'testnet', contractAddress: 'C...9X2M', deliveryChannel: 'webhook', deliveryEndpoint: 'https://api.acme.dev/hooks/stellar', active: true, eventFilter: { eventTypes: ['payment_received'] } },
  { id: 2, subscriptionId: 'sub_membership_02', ownerId: 'G...7KQ2', network: 'testnet', contractAddress: 'C...4P8R', deliveryChannel: 'slack', deliveryEndpoint: '#billing-alerts', active: true, eventFilter: { eventTypes: ['membership_renewed', 'membership_cancelled'] } },
  { id: 3, subscriptionId: 'sub_treasury_03', ownerId: 'G...7KQ2', network: 'mainnet', contractAddress: 'C...1N6V', deliveryChannel: 'email', deliveryEndpoint: 'ops@acme.dev', active: false, eventFilter: { eventTypes: ['transfer'] } },
]

const DEMO_EVENTS: EventItem[] = [
  { eventId: 'evt_1008', eventType: 'payment_received', contractAddress: 'C...9X2M', network: 'testnet', ledgerNumber: 51298402, transactionHash: 'a8f2...91c', createdAt: new Date(Date.now() - 240000) },
  { eventId: 'evt_1007', eventType: 'membership_renewed', contractAddress: 'C...4P8R', network: 'testnet', ledgerNumber: 51298377, transactionHash: '7bd1...e02', createdAt: new Date(Date.now() - 960000) },
  { eventId: 'evt_1006', eventType: 'transfer', contractAddress: 'C...1N6V', network: 'mainnet', ledgerNumber: 29412011, transactionHash: 'c31a...0af', createdAt: new Date(Date.now() - 1740000) },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function NetworkDot({ network }: { network: string }) {
  return <span className={`network-dot ${network}`} aria-label={network} />
}

function timeAgo(value: string | Date) {
  const minutes = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 60000))
  return `${minutes}m ago`
}

function truncate(s: string, n = 18) {
  return s.length > n ? `${s.slice(0, 6)}…${s.slice(-4)}` : s
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Page() {
  const wallet = useWallet()

  const [network, setNetwork] = useState<StellarNetwork>('testnet')
  const [activeView, setActiveView] = useState('Overview')
  const [subscriptions, setSubscriptions] = useState(DEMO_SUBSCRIPTIONS)
  const [events, setEvents] = useState(DEMO_EVENTS)
  const [showForm, setShowForm] = useState(false)
  const [notice, setNotice] = useState('')
  const [txStatus, setTxStatus] = useState<TxStatus>('idle')
  const [txHash, setTxHash] = useState<string | null>(null)
  const [form, setForm] = useState({
    subscriptionId: '',
    contractAddress: '',
    eventType: 'payment_received',
    channel: 'webhook',
    endpoint: '',
  })

  // ── Data fetching ──────────────────────────────────────────────────────────

  useEffect(() => {
    Promise.all([
      fetch(`/api/subscriptions?network=${network}`).then((r) => r.json()),
      fetch(`/api/events?network=${network}`).then((r) => r.json()),
    ])
      .then(([subRes, evtRes]) => {
        if (subRes.data?.length) setSubscriptions(subRes.data)
        if (evtRes.data?.length) setEvents(evtRes.data)
      })
      .catch(() => setNotice('Showing demo data while the API is unavailable.'))
  }, [network])

  const filteredEvents = useMemo(
    () => events.filter((e) => e.network === network),
    [events, network],
  )
  const visibleSubscriptions = useMemo(
    () => subscriptions.filter((s) => s.network === network),
    [subscriptions, network],
  )

  // ── Wallet connect ─────────────────────────────────────────────────────────

  const handleConnectWallet = useCallback(async () => {
    if (wallet.isConnected) {
      wallet.disconnect()
      return
    }
    if (!wallet.isAvailable) {
      setNotice('Freighter wallet extension is not installed. Visit https://freighter.app to install it.')
      return
    }
    await wallet.connect()
    if (wallet.error) setNotice(wallet.error)
  }, [wallet])

  // ── Create subscription ────────────────────────────────────────────────────

  const handleCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setTxHash(null)

      const subId = form.subscriptionId || `sub_${network}_${Date.now()}`
      const contractAddr = form.contractAddress || 'C...NEW1'
      const endpoint = form.endpoint || 'https://example.com/hook'

      const payload = {
        subscriptionId: subId,
        ownerId: wallet.publicKey ?? 'G...DEMO',
        network,
        contractAddress: contractAddr,
        deliveryChannel: form.channel,
        deliveryEndpoint: endpoint,
        eventFilter: { eventTypes: [form.eventType] },
      }

      // ── Step 1: Persist off-chain ──────────────────────────────────────────
      let offChainOk = false
      try {
        const res = await fetch('/api/subscriptions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const result = await res.json()
        if (!res.ok) throw new Error(result.error ?? 'API error')
        setSubscriptions((prev) => [result.data as Subscription, ...prev])
        offChainOk = true
      } catch {
        // Fallback: stage locally
        setSubscriptions((prev) => [
          { id: Date.now(), ...payload, active: true } as Subscription,
          ...prev,
        ])
      }

      setShowForm(false)
      setForm({ subscriptionId: '', contractAddress: '', eventType: 'payment_received', channel: 'webhook', endpoint: '' })

      // ── Step 2: Register on-chain (only when wallet connected) ─────────────
      if (!wallet.isConnected || !wallet.publicKey) {
        setNotice(
          offChainOk
            ? 'Subscription saved. Connect your wallet to register it on Soroban.'
            : 'Subscription staged locally. Connect your wallet to register it on Soroban.',
        )
        return
      }

      try {
        setTxStatus('simulating')
        setNotice('Simulating transaction…')

        const client = createContractClient(network, wallet.publicKey, wallet.signXdr)

        setTxStatus('signing')
        setNotice('Check Freighter — waiting for your signature…')

        const hash = await client.register({
          id: subId,
          contract: contractAddr,
          eventFilter: form.eventType,
          destination: endpoint,
        })

        setTxStatus('confirmed')
        setTxHash(hash)
        setNotice(`✓ Registered on Soroban! Tx: ${hash}`)

        // Patch the local record with the tx hash
        setSubscriptions((prev) =>
          prev.map((s) =>
            s.subscriptionId === subId ? { ...s, txHash: hash } : s,
          ),
        )
      } catch (err) {
        setTxStatus('error')
        setNotice(
          `On-chain registration failed: ${err instanceof Error ? err.message : 'Unknown error'}. Subscription saved off-chain.`,
        )
      } finally {
        setTxStatus('idle')
      }
    },
    [form, network, wallet],
  )

  // ── Toggle subscription active state ──────────────────────────────────────

  const handleToggle = useCallback(
    async (sub: Subscription) => {
      const newActive = !sub.active

      // Optimistic update
      setSubscriptions((prev) =>
        prev.map((s) => (s.id === sub.id ? { ...s, active: newActive } : s)),
      )

      // Off-chain
      try {
        await fetch(`/api/subscriptions/${sub.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: newActive }),
        })
      } catch {
        // revert
        setSubscriptions((prev) =>
          prev.map((s) => (s.id === sub.id ? { ...s, active: sub.active } : s)),
        )
        setNotice('Failed to update subscription status.')
        return
      }

      // On-chain (only when wallet connected)
      if (!wallet.isConnected || !wallet.publicKey) return
      try {
        const client = createContractClient(network, wallet.publicKey, wallet.signXdr)
        const hash = await client.setActive(sub.subscriptionId, newActive)
        setNotice(`Status updated on-chain. Tx: ${hash}`)
      } catch (err) {
        setNotice(
          `On-chain update failed: ${err instanceof Error ? err.message : 'Unknown error'}. Off-chain state updated.`,
        )
      }
    },
    [network, wallet],
  )

  // ── Delete subscription ────────────────────────────────────────────────────

  const handleDelete = useCallback(
    async (sub: Subscription) => {
      setSubscriptions((prev) => prev.filter((s) => s.id !== sub.id))

      try {
        await fetch(`/api/subscriptions/${sub.id}`, { method: 'DELETE' })
      } catch {
        setSubscriptions((prev) => [sub, ...prev])
        setNotice('Failed to delete subscription.')
        return
      }

      if (!wallet.isConnected || !wallet.publicKey) return
      try {
        const client = createContractClient(network, wallet.publicKey, wallet.signXdr)
        const hash = await client.remove(sub.subscriptionId)
        setNotice(`Removed on-chain. Tx: ${hash}`)
      } catch (err) {
        setNotice(
          `On-chain removal failed: ${err instanceof Error ? err.message : 'Unknown error'}. Removed off-chain.`,
        )
      }
    },
    [network, wallet],
  )

  // ── Wallet button label ────────────────────────────────────────────────────

  const walletLabel = wallet.loading
    ? 'Connecting…'
    : wallet.isConnected && wallet.publicKey
      ? truncate(wallet.publicKey)
      : 'Connect wallet'

  const walletExplorerUrl = wallet.publicKey
    ? `${NETWORKS[network].explorerUrl}/account/${wallet.publicKey}`
    : undefined

  // ── Tx status pill ─────────────────────────────────────────────────────────

  const txPillLabel: Record<TxStatus, string> = {
    idle: '',
    simulating: '⟳ Simulating…',
    signing: '✎ Waiting for signature…',
    submitting: '↗ Submitting…',
    confirmed: '✓ Confirmed',
    error: '✕ Failed',
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <main className="app-shell">
      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">S</div>
          <div><strong>SmartUp</strong><span>Developer console</span></div>
        </div>
        <div className="workspace-label">Workspace</div>
        <nav className="nav-list" aria-label="Primary navigation">
          {['Overview', 'Subscriptions', 'Event stream', 'Delivery channels'].map((item) => (
            <button
              key={item}
              className={activeView === item ? 'nav-item active' : 'nav-item'}
              onClick={() => setActiveView(item)}
            >
              <span className="nav-icon">
                {item === 'Overview' ? '⌂' : item === 'Subscriptions' ? '◈' : item === 'Event stream' ? '≋' : '◌'}
              </span>
              {item}
              <span className="nav-arrow">›</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button className="nav-item" onClick={() => setActiveView('Settings')}>
            <span className="nav-icon">⚙</span>Settings<span className="nav-arrow">›</span>
          </button>
          <div className="account-card">
            <div className="avatar">
              {wallet.isConnected && wallet.publicKey
                ? wallet.publicKey.slice(1, 3).toUpperCase()
                : 'JD'}
            </div>
            <div>
              <strong>{wallet.isConnected && wallet.publicKey ? truncate(wallet.publicKey, 14) : 'Jordan Davis'}</strong>
              <span>{wallet.isConnected ? 'Wallet connected' : 'jordan@acme.dev'}</span>
            </div>
            <span className="more">•••</span>
          </div>
        </div>
      </aside>

      {/* ── Main content ────────────────────────────────────────────────── */}
      <section className="content-area">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span><b>/</b><strong>{activeView}</strong>
          </div>
          <div className="top-actions">
            <label className="network-select">
              <NetworkDot network={network} />
              <select
                value={network}
                onChange={(e) => setNetwork(e.target.value as StellarNetwork)}
                aria-label="Select Stellar network"
              >
                <option value="testnet">Testnet</option>
                <option value="mainnet">Mainnet</option>
              </select>
              <span>⌄</span>
            </label>

            {/* Wallet button — links to explorer when connected */}
            {wallet.isConnected && walletExplorerUrl ? (
              <div className="wallet-connected-row">
                <a
                  href={walletExplorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="wallet-button connected"
                  title={wallet.publicKey ?? ''}
                >
                  {walletLabel} <span>↗</span>
                </a>
                <button
                  className="wallet-disconnect"
                  onClick={() => wallet.disconnect()}
                  aria-label="Disconnect wallet"
                  title="Disconnect"
                >
                  ×
                </button>
              </div>
            ) : (
              <button
                className="wallet-button"
                onClick={handleConnectWallet}
                disabled={wallet.loading}
              >
                {walletLabel} <span>↗</span>
              </button>
            )}
          </div>
        </header>

        <div className="page-content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">SUBSCRIPTION REGISTRY</p>
              <h1>{activeView === 'Overview' ? 'Good morning, Jordan.' : activeView}</h1>
              <p className="subtitle">Monitor contract events and deliver them where your product needs them.</p>
            </div>
            <button className="primary-button" onClick={() => setShowForm(true)}>
              <span>＋</span> New subscription
            </button>
          </div>

          {/* Notice bar */}
          {notice && (
            <div className="notice" role="status">
              {notice}
              {txHash && (
                <a
                  href={`${NETWORKS[network].explorerUrl}/tx/${txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="notice-link"
                >
                  View on Explorer ↗
                </a>
              )}
              <button onClick={() => { setNotice(''); setTxHash(null) }} aria-label="Dismiss notice">×</button>
            </div>
          )}

          {/* Tx status pill */}
          {txStatus !== 'idle' && (
            <div className={`tx-pill tx-pill--${txStatus}`} role="status" aria-live="polite">
              {txPillLabel[txStatus]}
            </div>
          )}

          {/* Wallet warning */}
          {!wallet.isAvailable && (
            <div className="notice notice--warn" role="alert">
              Freighter wallet extension not detected.{' '}
              <a href="https://freighter.app" target="_blank" rel="noreferrer">Install Freighter ↗</a>
              {' '}to sign on-chain transactions.
            </div>
          )}

          {/* Metrics */}
          <div className="metric-grid">
            <article className="metric-card">
              <div className="metric-top"><span>Active subscriptions</span><span className="metric-icon indigo">◈</span></div>
              <strong>{subscriptions.filter((s) => s.active).length}</strong>
              <small><span className="positive">↑ 12%</span> vs last month</small>
            </article>
            <article className="metric-card">
              <div className="metric-top"><span>Events indexed</span><span className="metric-icon teal">≋</span></div>
              <strong>24,892</strong>
              <small><span className="positive">↑ 8.4%</span> vs last month</small>
            </article>
            <article className="metric-card">
              <div className="metric-top"><span>Delivery success</span><span className="metric-icon green">✓</span></div>
              <strong>99.8%</strong>
              <small><span className="positive">↑ 0.3%</span> vs last month</small>
            </article>
            <article className="metric-card">
              <div className="metric-top"><span>Avg. indexing lag</span><span className="metric-icon amber">◷</span></div>
              <strong>1.2s</strong>
              <small><span className="positive">↓ 0.4s</span> vs last month</small>
            </article>
          </div>

          {/* Subscriptions table + delivery health */}
          <div className="section-grid">
            <section className="panel subscriptions-panel">
              <div className="panel-heading">
                <div>
                  <h2>Subscriptions</h2>
                  <p>Registry activity on <NetworkDot network={network} /> {NETWORKS[network].name}</p>
                </div>
                <button className="text-button" onClick={() => setActiveView('Subscriptions')}>
                  View all <span>→</span>
                </button>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Subscription</th>
                      <th>Contract</th>
                      <th>Events</th>
                      <th>Channel</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleSubscriptions.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <strong>{item.subscriptionId}</strong>
                          <span>{truncate(item.ownerId, 14)}</span>
                          {item.txHash && (
                            <a
                              href={`${NETWORKS[network].explorerUrl}/tx/${item.txHash}`}
                              target="_blank"
                              rel="noreferrer"
                              className="tx-badge"
                              title={item.txHash}
                            >
                              on-chain ↗
                            </a>
                          )}
                        </td>
                        <td><code>{item.contractAddress}</code></td>
                        <td>
                          <div className="event-tags">
                            {item.eventFilter.eventTypes?.map((t) => (
                              <span key={t}>{t.replaceAll('_', ' ')}</span>
                            ))}
                          </div>
                        </td>
                        <td><span className="channel">{item.deliveryChannel}</span></td>
                        <td>
                          <span className={item.active ? 'status active' : 'status paused'}>
                            <i />{item.active ? 'Active' : 'Paused'}
                          </span>
                        </td>
                        <td>
                          <div className="row-actions">
                            <button
                              className="row-action-btn"
                              title={item.active ? 'Pause' : 'Resume'}
                              onClick={() => handleToggle(item)}
                            >
                              {item.active ? '⏸' : '▶'}
                            </button>
                            <button
                              className="row-action-btn row-action-btn--danger"
                              title="Delete"
                              onClick={() => handleDelete(item)}
                            >
                              ✕
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="panel health-panel">
              <div className="panel-heading">
                <div><h2>Delivery health</h2><p>Last 24 hours</p></div>
                <span className="health-pill"><i /> Healthy</span>
              </div>
              <div className="health-score">
                <div className="score-ring"><span>99.8<small>%</small></span></div>
                <div>
                  <strong>Excellent</strong>
                  <span>1,204 deliveries</span>
                  <span className="positive">↑ 0.3% from yesterday</span>
                </div>
              </div>
              <div className="mini-bars">
                {[48, 62, 54, 73, 68, 82, 70, 89, 76, 92, 83, 96, 88, 94, 100, 93, 98, 100, 95, 100].map((h, i) => (
                  <i key={i} style={{ height: `${h}%` }} />
                ))}
              </div>
              <div className="health-legend">
                <span><i className="legend-green" />Delivered 1,202</span>
                <span><i className="legend-red" />Failed 2</span>
              </div>
            </section>
          </div>

          {/* Event stream */}
          <section className="panel event-panel">
            <div className="panel-heading">
              <div>
                <h2>Recent event stream</h2>
                <p>Live events from your subscribed contracts</p>
              </div>
              <button className="live-pill"><i /> Live</button>
            </div>
            <div className="events-list">
              {filteredEvents.map((event) => (
                <div className="event-row" key={event.eventId}>
                  <div className="event-type-icon">↗</div>
                  <div className="event-copy">
                    <strong>{event.eventType.replaceAll('_', ' ')}</strong>
                    <span>{event.contractAddress} <b>·</b> Ledger {event.ledgerNumber.toLocaleString()}</span>
                  </div>
                  <a
                    href={`${NETWORKS[network].explorerUrl}/tx/${event.transactionHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="event-hash"
                    title={event.transactionHash}
                  >
                    <code>{event.transactionHash}</code>
                  </a>
                  <time>{timeAgo(event.createdAt)}</time>
                </div>
              ))}
            </div>
          </section>

          <div className="footer-note">
            <span className="chain-mark">✦</span> Powered by Soroban{' '}
            <span>·</span>{' '}
            <a href={NETWORKS[network].explorerUrl} target="_blank" rel="noreferrer">
              View on Stellar Expert ↗
            </a>
            <span className="footer-right">API status <i /></span>
          </div>
        </div>
      </section>

      {/* ── New subscription modal ───────────────────────────────────────── */}
      {showForm && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => e.target === e.currentTarget && setShowForm(false)}
        >
          <form className="modal" onSubmit={handleCreate}>
            <div className="modal-heading">
              <div>
                <p className="eyebrow">{network.toUpperCase()}</p>
                <h2>New subscription</h2>
                <p>Register an event listener for a Soroban contract.</p>
              </div>
              <button type="button" className="close-button" onClick={() => setShowForm(false)}>×</button>
            </div>

            <label>
              Subscription ID
              <input
                value={form.subscriptionId}
                onChange={(e) => setForm({ ...form, subscriptionId: e.target.value })}
                placeholder="sub_billing_04"
              />
            </label>
            <label>
              Contract address
              <input
                value={form.contractAddress}
                onChange={(e) => setForm({ ...form, contractAddress: e.target.value })}
                placeholder="C..."
                required
              />
            </label>
            <div className="form-row">
              <label>
                Event type
                <input
                  value={form.eventType}
                  onChange={(e) => setForm({ ...form, eventType: e.target.value })}
                  placeholder="payment_received"
                  required
                />
              </label>
              <label>
                Delivery channel
                <select
                  value={form.channel}
                  onChange={(e) => setForm({ ...form, channel: e.target.value })}
                >
                  <option>webhook</option>
                  <option>slack</option>
                  <option>email</option>
                </select>
              </label>
            </div>
            <label>
              Delivery endpoint
              <input
                value={form.endpoint}
                onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
                placeholder="https://example.com/hook"
                required
              />
            </label>

            {!wallet.isConnected && (
              <p className="modal-wallet-warning">
                ⚠ Connect your wallet to register this subscription on Soroban.
                It will be saved off-chain only if you continue without one.
              </p>
            )}

            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setShowForm(false)}
              >
                Cancel
              </button>
              <button className="primary-button" type="submit" disabled={txStatus !== 'idle'}>
                {txStatus !== 'idle' ? txPillLabel[txStatus] : 'Create subscription'}
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  )
}
