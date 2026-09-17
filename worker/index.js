// Cloudflare Worker: serves frontend/ as static assets and a small read-only JSON-RPC relay at /rpc/<chainId>.
// Arc's public RPC endpoints are on *.arc.io, which common ad-block lists block in browsers. The page tries the
// public RPC first and falls back to this same-origin relay, which only forwards read methods (wallets send
// transactions through their own RPC).
const UPSTREAMS = {
  // Blockdaemon first: the default endpoint rate-limits batched calls from shared Cloudflare egress addresses,
  // and dRPC's free plan rejects batches larger than three calls.
  5042: ['https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.mainnet.arc.io'],
  5042002: ['https://rpc.blockdaemon.testnet.arc.io', 'https://rpc.testnet.arc.io'],
};
const READ_METHODS = new Set([
  'eth_chainId', 'net_version', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_call', 'eth_estimateGas',
  'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getLogs', 'eth_getTransactionCount',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_feeHistory', 'eth_gasPrice', 'eth_maxPriorityFeePerGas',
]);
const MAX_BODY_BYTES = 256_000;
const MAX_BATCH = 100; // ethers JsonRpcProvider batches up to 100 calls by default

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const rpcError = (message, status) => json({ jsonrpc: '2.0', id: null, error: { code: -32600, message } }, status);

async function relay(request, chainId) {
  const upstreams = UPSTREAMS[chainId];
  if (!upstreams) return rpcError('Unknown chain', 404);
  if (request.method !== 'POST') return rpcError('POST a JSON-RPC request', 405);
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return rpcError('Request too large', 413);
  let body;
  try { body = JSON.parse(text); } catch { return rpcError('Invalid JSON', 400); }
  const calls = Array.isArray(body) ? body : [body];
  if (!calls.length || calls.length > MAX_BATCH) return rpcError(`Send 1 to ${MAX_BATCH} calls`, 400);
  if (calls.some((call) => !call || typeof call.method !== 'string' || !READ_METHODS.has(call.method))) {
    return rpcError('Only read methods are relayed', 403);
  }
  let fallback = null;
  for (const upstream of upstreams) {
    try {
      const response = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
      if (!response.ok) continue;
      const answer = await response.text();
      // A rate-limited member fails the whole page read, so try the next endpoint for the batch.
      if (/rate limit|-32005/i.test(answer)) { fallback = answer; continue; }
      return new Response(answer, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    } catch { /* try the next endpoint */ }
  }
  return fallback === null
    ? rpcError('All upstream RPC endpoints failed', 502)
    : new Response(fallback, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

export default {
  async fetch(request, env) {
    const match = new URL(request.url).pathname.match(/^\/rpc\/(\d+)$/);
    return match ? relay(request, Number(match[1])) : env.ASSETS.fetch(request);
  },
};
