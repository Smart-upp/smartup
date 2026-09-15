/**
 * scripts/deploy-contract.ts
 *
 * Deploys the SmartUp Subscription Registry Soroban contract to Stellar testnet or mainnet.
 *
 * Prerequisites:
 *   - Stellar CLI installed: https://developers.stellar.org/docs/tools/stellar-cli
 *   - Rust + wasm32 target: rustup target add wasm32-unknown-unknown
 *   - Environment:
 *       STELLAR_NETWORK=testnet|mainnet
 *       STELLAR_SECRET_KEY=S...  (deployer account secret key)
 *
 * Usage:
 *   pnpm tsx scripts/deploy-contract.ts
 *
 * The script will:
 *   1. Build the contract WASM via `cargo build --release --target wasm32-unknown-unknown`
 *   2. Deploy (upload + instantiate) using `stellar contract deploy`
 *   3. Print the resulting CONTRACT_ADDRESS for you to add to your .env
 */

import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const NETWORK = (process.env.STELLAR_NETWORK ?? 'testnet') as 'testnet' | 'mainnet'
const SECRET_KEY = process.env.STELLAR_SECRET_KEY

const NETWORK_RPC: Record<string, string> = {
  testnet: 'https://soroban-testnet.stellar.org',
  mainnet: 'https://soroban-rpc.stellar.org',
}
const NETWORK_PASSPHRASE: Record<string, string> = {
  testnet: 'Test SDF Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015',
}

function run(cmd: string, cwd?: string): string {
  console.log(`\n$ ${cmd}`)
  return execSync(cmd, { cwd, stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf-8' }).trim()
}

async function main() {
  if (!SECRET_KEY) {
    console.error('ERROR: STELLAR_SECRET_KEY environment variable is required.')
    console.error('  export STELLAR_SECRET_KEY=S...')
    process.exit(1)
  }

  const contractDir = path.resolve(__dirname, '../contracts/smartup_subscription_registry')
  const wasmPath = path.join(
    contractDir,
    'target/wasm32-unknown-unknown/release/smartup_subscription_registry.wasm',
  )

  // ── Step 1: Build ──────────────────────────────────────────────────────────
  console.log(`\n🔨  Building contract for wasm32-unknown-unknown (release)…`)
  run('cargo build --release --target wasm32-unknown-unknown', contractDir)

  if (!fs.existsSync(wasmPath)) {
    console.error(`ERROR: WASM file not found at ${wasmPath}`)
    process.exit(1)
  }
  console.log(`✅  Build complete: ${wasmPath}`)

  // ── Step 2: Optimise (if stellar CLI wasm optimizer is available) ──────────
  try {
    run(`stellar contract optimize --wasm ${wasmPath}`)
    console.log('✅  WASM optimised')
  } catch {
    console.warn('⚠️  stellar contract optimize not available — skipping optimisation')
  }

  // ── Step 3: Deploy ─────────────────────────────────────────────────────────
  console.log(`\n🚀  Deploying to ${NETWORK}…`)
  const contractAddress = run(
    [
      'stellar contract deploy',
      `--wasm ${wasmPath}`,
      `--source-account ${SECRET_KEY}`,
      `--rpc-url ${NETWORK_RPC[NETWORK]}`,
      `--network-passphrase "${NETWORK_PASSPHRASE[NETWORK]}"`,
    ].join(' '),
  )

  if (!contractAddress.startsWith('C')) {
    console.error('ERROR: Unexpected contract address format:', contractAddress)
    process.exit(1)
  }

  console.log(`\n🎉  Contract deployed!`)
  console.log(`    Network:  ${NETWORK}`)
  console.log(`    Address:  ${contractAddress}`)
  console.log(`\nAdd to your .env:`)
  console.log(`  NEXT_PUBLIC_CONTRACT_ADDRESS_${NETWORK.toUpperCase()}=${contractAddress}`)

  // ── Step 4: Write to .env.local for convenience ───────────────────────────
  const envLine = `NEXT_PUBLIC_CONTRACT_ADDRESS_${NETWORK.toUpperCase()}=${contractAddress}\n`
  const envFile = path.resolve(__dirname, '../.env.local')
  if (fs.existsSync(envFile)) {
    const existing = fs.readFileSync(envFile, 'utf-8')
    const key = `NEXT_PUBLIC_CONTRACT_ADDRESS_${NETWORK.toUpperCase()}`
    if (existing.includes(key)) {
      fs.writeFileSync(envFile, existing.replace(new RegExp(`${key}=.*\\n?`), envLine))
    } else {
      fs.appendFileSync(envFile, envLine)
    }
    console.log(`\n📝  Updated ${envFile}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
