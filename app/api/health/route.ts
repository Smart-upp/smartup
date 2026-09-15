export async function GET() {
  return Response.json({ status: 'ok', database: Boolean(process.env.DATABASE_URL), networks: ['testnet', 'mainnet'], timestamp: new Date().toISOString() })
}
