// hook API: launch a coin hooked to a real-world asset.
// Every coin launches on the hook launchpad on Raydium LaunchLab, hooked to one asset (NVDA, TSLA, SPY, gold, BTC…) with a pull from 1x to 10x.
// 1% of every curve trade fills the coin's reserve. On a day its asset is green, the reserve spends (the asset's 24h move × the pull)% of itself,
// capped at 50%, buying the coin through Jupiter and burning what it bought, in one transaction with a memo. Once per coin per UTC day.
// GET  a=market · a=assets · a=coins · a=coin&mint= · a=hookstate&mint= · a=ledger · a=reserves · a=t (token metadata) · a=wallet · a=profiles · a=profile · a=holders · a=pad · a=bal · a=simHook · a=simLaunch
// POST a=upload · a=buildPad · a=buildLaunch · a=buildProfile · a=claim · a=buildHook · a=send   (every transaction is signed in the visitor's own wallet)
const { Connection, PublicKey, Keypair, SystemProgram, ComputeBudgetProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction, AddressLookupTableAccount } = require('@solana/web3.js');
const SPL = require('@solana/spl-token');
const BN = require('bn.js');
const R = require('@raydium-io/raydium-sdk-v2');
const CFG = require('./hook-config.json');

const RPC = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const LAUNCH_API = 'https://launch-mint-v1.raydium.io', HISTORY_API = 'https://launch-history-v1.raydium.io', JUP = 'https://lite-api.jup.ag';
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const PROGRAM = R.LAUNCHPAD_PROGRAM, RAYDIUM_PLATFORM = R.LAUNCHPAD_PLATFORM;
const CONFIG = R.getPdaLaunchpadConfigId(PROGRAM, WSOL, 0, 0).publicKey;
// fixed addresses that receive a 0 SOL transfer, so the chain itself indexes launches, profiles and the burn log
const TAG = new PublicKey(process.env.HOOK_TAG || 'BE1s33gicDg2q9hWK1ABTayk83tDLy4Aw4wS8zNjH25S');
const PTAG = new PublicKey(process.env.HOOK_PTAG || 'DpVWXnjva4Fg7rbpQumH762memMoMUHhhLLyJWY5cWXr');
const LTAG = new PublicKey(process.env.HOOK_LTAG || '4BnF8G7NhfW1ha5cg8YBpcfSAxinoJWeGwExETvvU8iT');
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const SUPPLY = new BN('1000000000000000'), DEFAULT_SELL = 793100000000000n, DEFAULT_RAISE = 85000000000n;
const PPM = 1e6;
const conn = new Connection(RPC, 'confirmed');
const PIN = { pad: process.env.HOOK_PAD || CFG.pad };
const PULL = CFG.pull, CAP = CFG.capPct, MINMOVE = CFG.minMovePct;
const ASSETS = CFG.assets, ASSET = Object.fromEntries(ASSETS.map(a => [a.sym, a]));

const out = (res, code, body, cache) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', cache || 'no-store'); res.end(JSON.stringify(body)); };
const b64u = s => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
const host = req => process.env.HOOK_HOST || ('https://' + (req.headers['x-forwarded-host'] || req.headers.host));
const body = req => new Promise(ok => { if (req.body) return ok(typeof req.body === 'string' ? JSON.parse(req.body) : req.body); let d = ''; req.on('data', c => d += c); req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { ok({}); } }); });
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
const str = b => Buffer.from(b).toString('utf8').replace(/\0/g, '').trim();
const pk = (s, what) => { try { return new PublicKey(String(s)); } catch { throw new Error(what || 'bad address'); } };
const padIdOf = admin => R.getPdaPlatformId(PROGRAM, admin).publicKey;
const vaultOf = padId => R.getPdaPlatformVault(PROGRAM, padId, WSOL).publicKey;
const pct = n => +(+n.toString() / PPM * 100).toFixed(4);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJ(url, ms = 8000) { for (let k = 0; k < 2; k++) { const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: 'application/json' } }); if (r.status === 429 && !k) { await sleep(1200); continue; } if (!r.ok) throw new Error(url.split('/')[2] + ' ' + r.status); return r.json(); } }
const memoIx = (signer, text) => new TransactionInstruction({ programId: MEMO, keys: [{ pubkey: signer, isSigner: true, isWritable: false }], data: Buffer.from(text, 'utf8') });
const tagTo = (from, to, extra) => { const ix = SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: 0 }); if (extra) ix.keys.push({ pubkey: extra, isSigner: false, isWritable: false }); return ix; };
const ser = t => Buffer.from(t.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64');
const dayStart = (t = Date.now()) => Math.floor(t / 86400000) * 86400; // UTC midnight, in seconds
// uploaded coin images live in the project's Vercel Blob store at a fixed path, so the metadata link only carries a short key
const EXT = { p: ['png', 'image/png'], j: ['jpg', 'image/jpeg'], w: ['webp', 'image/webp'], g: ['gif', 'image/gif'] };
const blobBase = () => { const id = (process.env.BLOB_STORE_ID || '').replace(/^store_/, '') || String(process.env.BLOB_READ_WRITE_TOKEN || '').split('_')[3] || ''; return id ? `https://${id.toLowerCase()}.public.blob.vercel-storage.com` : null; };
const imageUrl = code => { const m = String(code).match(/^b([0-9a-f]{16})([pjwg])$/); const base = blobBase(); return m && base ? `${base}/hook/${m[1]}.${EXT[m[2]][0]}` : null; };
async function upload(req) { const b = await body(req); const buf = Buffer.from(String(b.data || '').replace(/^data:[^,]+,/, ''), 'base64');
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('uploads are not switched on yet. pick a preset or paste an https image link');
  if (buf.length < 100) throw new Error('no image'); if (buf.length > 750 * 1024) throw new Error('image too big: keep it under 750 KB');
  const h = buf.slice(0, 12).toString('hex'), code = h.startsWith('89504e47') ? 'p' : h.startsWith('ffd8ff') ? 'j' : h.startsWith('474946') ? 'g' : (h.startsWith('52494646') && buf.slice(8, 12).toString() === 'WEBP') ? 'w' : null;
  if (!code) throw new Error('png, jpg, webp or gif only');
  const key = require('crypto').createHash('sha256').update(buf).digest('hex').slice(0, 16), { put } = require('@vercel/blob');
  const r = await put(`hook/${key}.${EXT[code][0]}`, buf, { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: EXT[code][1], cacheControlMaxAge: 31536000 });
  return { image: 'b' + key + code, url: r.url }; }

// ---------------------------------------------------------------- the curve LaunchLab reads back from a row (every hook coin takes LaunchLab's standard curve)
function curveFromRow(sellRaw, raiseLamports) { const sold = Number(sellRaw) / 1e15, raise = Number(raiseLamports) / 1e9, mig = 1 - sold, gradSol = raise / mig, run = Math.pow(sold / mig, 2); return { run, sold, raise, gradSol, startSol: gradSol / run }; }

// ---------------------------------------------------------------- prices: every asset's token on Solana (xStocks for stocks and gold, cbBTC, wrapped ETH, SOL)
// Jupiter first (price + 24h change), Dexscreener for anything Jupiter didn't return
async function jupInfo(mints) { const o = {}; for (let i = 0; i < mints.length; i += 90) { const part = mints.slice(i, i + 90); try { const j = await getJ(`${JUP}/tokens/v2/search?query=${part.join(',')}`); for (const t of j || []) o[t.id] = { symbol: t.symbol, name: t.name, icon: t.icon, decimals: t.decimals, usd: t.usdPrice ?? null, ch24: t.stats24h ? t.stats24h.priceChange ?? null : null, mcap: t.mcap ?? t.fdv ?? null, liquidity: t.liquidity ?? null }; } catch { } } return o; }
async function dexInfo(mints) { const o = {}; for (let i = 0; i < mints.length; i += 30) { try { const j = await getJ(`https://api.dexscreener.com/tokens/v1/solana/${mints.slice(i, i + 30).join(',')}`);
    for (const m of mints.slice(i, i + 30)) { const p = (Array.isArray(j) ? j : []).filter(x => x.baseToken && x.baseToken.address === m).sort((a, b) => ((b.liquidity || {}).usd || 0) - ((a.liquidity || {}).usd || 0))[0]; if (p) o[m] = { usd: +p.priceUsd, ch24: p.priceChange ? p.priceChange.h24 ?? null : null }; } } catch { } } return o; }
let assetCache = null;
async function assets() { if (assetCache && Date.now() - assetCache.t < 30000) return assetCache.v;
  const mints = ASSETS.map(a => a.mint), J = await jupInfo(mints), miss = mints.filter(m => !J[m] || J[m].usd == null || J[m].ch24 == null), D = miss.length ? await dexInfo(miss) : {};
  const list = ASSETS.map(a => { const j = J[a.mint] || {}, d = D[a.mint] || {}, usd = j.usd ?? d.usd ?? null, ch24 = j.ch24 ?? d.ch24 ?? null; return { ...a, usd, ch24, src: j.usd != null ? 'jupiter' : d.usd != null ? 'dexscreener' : null, icon: j.icon || null }; });
  const v = { at: Date.now(), assets: list, green: list.filter(a => a.ch24 != null && a.ch24 >= MINMOVE).length, read: list.filter(a => a.ch24 != null).length };
  assetCache = { t: Date.now(), v }; return v; }
let mktCache = null;
async function market() { if (mktCache && Date.now() - mktCache.t < 30000) return mktCache.v;
  const [A, { cfg }] = await Promise.all([assets(), chain().catch(() => ({ cfg: null }))]); const sol = A.assets.find(a => a.sym === 'SOL');
  const v = { at: Date.now(), pad: PIN.pad || null, sol: sol ? { usd: sol.usd, ch24: sol.ch24 } : null, pull: PULL, capPct: CAP, minMovePct: MINMOVE, assets: A.assets, green: A.green, read: A.read, raiseSol: Number(DEFAULT_RAISE) / 1e9, minRaiseSol: cfg ? +cfg.minFundRaisingB.toString() / 1e9 : 24, tradeFeePct: cfg ? pct(cfg.tradeFeeRate) : .25 };
  mktCache = { t: Date.now(), v }; return v; }
// the hook rule: on a green day the reserve spends (move × pull)%, capped
const spendPct = (ch24, pull) => ch24 == null || ch24 < MINMOVE ? 0 : Math.min(CAP, ch24 * pull);

// ---------------------------------------------------------------- the launchpad (the p4d engine)
let chainCache = null;
async function chain() {
  if (chainCache && Date.now() - chainCache.t < 60000) return chainCache.v;
  const [ca, pa] = await conn.getMultipleAccountsInfo([CONFIG, RAYDIUM_PLATFORM]);
  if (!ca) throw new Error('LaunchLab config not found');
  const v = { cfg: R.LaunchpadConfig.decode(ca.data), ray: pa ? R.PlatformConfig.decode(pa.data) : null };
  chainCache = { t: Date.now(), v }; return v;
}
function decodePad(id, data) { const p = R.PlatformConfig.decode(data); return { id: id.toBase58(), name: str(p.name), web: str(p.web), img: str(p.img), feePct: pct(p.feeRate), creatorFeePct: pct(p.creatorFeeRate), lp: { burn: pct(p.burnScale), platform: pct(p.platformScale), creator: pct(p.creatorScale) }, claimWallet: p.platformClaimFeeWallet.toBase58() }; }
let padCache = null;
async function padInfo(idStr) { const id = pk(idStr, 'bad pad id'); if (padCache && padCache.id === idStr && Date.now() - padCache.t < 60000) return padCache.v;
  const [acc, vault] = await conn.getMultipleAccountsInfo([id, vaultOf(id)]);
  if (!acc || !acc.owner.equals(PROGRAM)) return { exists: false, id: id.toBase58() };
  let unclaimedSol = 0; if (vault && vault.data.length >= 72) unclaimedSol = Number(vault.data.readBigUInt64LE(64)) / 1e9;
  const v = { exists: true, ...decodePad(id, acc.data), vault: vaultOf(id).toBase58(), unclaimedSol }; padCache = { id: idStr, t: Date.now(), v }; return v; }
async function pad(q) { const id = q.get('id') ? pk(q.get('id'), 'bad pad id') : padIdOf(pk(q.get('admin'), 'bad wallet')); padCache = null; return padInfo(id.toBase58()); }
const fits = t => { try { t.serialize({ requireAllSignatures: false, verifySignatures: false }); return true; } catch { return false; } };
async function finish(txs, wallet, signers, tagFn, simulate) {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const mk = ixs => { const t = new Transaction(); t.add(...ixs); t.feePayer = wallet; t.recentBlockhash = blockhash; const need = signers.filter(s => t.instructions.some(ix => ix.keys.some(k => k.isSigner && k.pubkey.equals(s.publicKey)))); if (need.length) t.partialSign(...need); return t; };
  let list = txs.map((tx, i) => mk(i === 0 && tagFn ? [...tx.instructions, tagFn(false)] : tx.instructions));
  if (tagFn && !fits(list[0])) { list = txs.map(tx => mk(tx.instructions)); list.push(mk([tagFn(true)])); }
  let sim = null;
  if (simulate) sim = await Promise.all(list.slice(0, 1).map(async t => { const r = await conn.simulateTransaction(t); return { err: r.value.err, units: r.value.unitsConsumed, logs: (r.value.logs || []).slice(-16) }; }));
  return { txs: list.map(ser), sim };
}
const txsOf = m => m.transactions ? m.transactions : [{ instructions: m.transaction && m.transaction.instructions && m.transaction.instructions.length ? m.transaction.instructions : m.builder.allInstructions }];
async function sdk(owner) { const r = await R.Raydium.load({ connection: conn, owner, cluster: 'mainnet', disableLoadToken: true, disableFeatureCheck: true, blockhashCommitment: 'confirmed' }); if (module.exports._t && module.exports._t.onLoad) module.exports._t.onLoad(r); return r; }

// the hook launchpad: 1% of every curve trade goes to the wallet that created it (the reserve wallet); half the graduation LP is burned, half kept as a Raydium fee key
async function buildPad(req) {
  const b = await body(req); const wallet = pk(b.wallet, 'connect a wallet first');
  const id = padIdOf(wallet); if (await conn.getAccountInfo(id)) throw new Error(`this wallet already has a launchpad (${id.toBase58()}). one per wallet.`);
  const { ray } = await chain(); if (!ray) throw new Error('could not read Raydium’s platform settings');
  const feePct = Math.max(0, Math.min(5, +(b.feePct ?? 1))), burn = Math.round(Math.max(0, Math.min(100, +(b.burnPct ?? 50))) * 1e4);
  const raydium = await sdk(wallet);
  const made = await raydium.launchpad.createPlatformConfig({
    programId: PROGRAM, platformAdmin: wallet, platformClaimFeeWallet: wallet, platformLockNftWallet: wallet, platformVestingWallet: wallet,
    cpConfigId: ray.cpConfigId, migrateCpLockNftScale: { platformScale: new BN(PPM - burn), creatorScale: new BN(0), burnScale: new BN(burn) },
    transferFeeExtensionAuth: wallet, creatorFeeRate: new BN(0), feeRate: new BN(Math.round(feePct * 1e4)),
    name: CFG.name, web: clean(b.web || host(req), 120), img: clean(b.img || host(req) + '/icon.png', 200), txVersion: R.TxVersion.LEGACY, feePayer: wallet,
  });
  const r = await finish(txsOf(made), wallet, [], () => tagTo(wallet, TAG), !!b.simulate);
  return { pad: id.toBase58(), ...r };
}
// a launch: LaunchLab's standard curve; the asset and the pull live in the metadata link
async function buildLaunch(req) {
  const b = await body(req); const wallet = pk(b.wallet, 'connect a wallet first'), padId = pk(b.pad || PIN.pad || '', 'the hook launchpad is not open yet');
  const padAcc = await conn.getAccountInfo(padId); if (!padAcc || !padAcc.owner.equals(PROGRAM)) throw new Error('the hook launchpad is not open yet');
  const { cfg } = await chain();
  const name = clean(b.name, 32), symbol = String(b.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  if (name.length < 2) throw new Error('give your coin a name'); if (symbol.length < 2) throw new Error('give your coin a ticker (2 to 10 letters)');
  const asset = ASSET[String(b.asset || '').toUpperCase()]; if (!asset) throw new Error('pick the asset your coin is hooked to');
  const pull = Math.round(+b.pull); if (!(pull >= PULL.min && pull <= PULL.max)) throw new Error(`the pull is ${PULL.min}x to ${PULL.max}x`);
  let img = String(b.image || '1'); if (/^[1-6]$/.test(img) || /^b[0-9a-f]{16}[pjwg]$/.test(img)) img = img; else if (/^https:\/\/[^\s"'<>]{6,150}$/.test(img)) img = 'u' + b64u(img); else throw new Error('pick an image, upload one, or paste an https image link');
  const uri = host(req) + '/api/hook?a=t&n=' + encodeURIComponent(name) + '&s=' + symbol + '&x=' + asset.sym + '&p=' + pull + '&i=' + img;
  if (uri.length > 200) throw new Error('name or image link too long for on-chain metadata. use a preset image or a shorter link');
  const raise = new BN(DEFAULT_RAISE.toString()), sell = new BN(DEFAULT_SELL.toString());
  if (+raise.toString() / 1e9 < +cfg.minFundRaisingB.toString() / 1e9) throw new Error('LaunchLab’s minimum raise changed. try again later');
  const buySol = Math.max(0, +b.buySol || 0); if (buySol > 20) throw new Error('the first buy is capped at 20 SOL');
  const mint = Keypair.generate(); const raydium = await sdk(wallet);
  const { transactions, extInfo } = await raydium.launchpad.createLaunchpad({
    programId: PROGRAM, mintA: mint.publicKey, decimals: 6, name, symbol, uri, migrateType: 'cpmm', configId: CONFIG, configInfo: cfg, mintBDecimals: 9, platformId: padId,
    txVersion: R.TxVersion.LEGACY, slippage: new BN(100), buyAmount: new BN(Math.round(buySol * 1e9)), createOnly: buySol === 0,
    supply: SUPPLY, totalSellA: sell, totalFundRaisingB: raise, totalLockedAmount: new BN(0), cliffPeriod: new BN(0), unlockPeriod: new BN(0),
    extraSigners: [mint], feePayer: wallet, computeBudgetConfig: { units: 600000, microLamports: 60000 },
  });
  const r = await finish(transactions, wallet, [mint], extra => tagTo(wallet, TAG, extra ? mint.publicKey : null), !!b.simulate);
  return { mint: mint.publicKey.toBase58(), pool: extInfo?.address?.poolId?.toBase58() || R.getPdaLaunchpadPoolId(PROGRAM, mint.publicKey, WSOL).publicKey.toBase58(), uri, asset: asset.sym, pull, ...r };
}
// the token's metadata: the hook lives in the link, so anyone can read it from the chain
function tokenMeta(req, q) { const name = clean(q.get('n'), 32), symbol = clean(q.get('s'), 10), i = String(q.get('i') || '1'), a = ASSET[String(q.get('x') || '').toUpperCase()] || null, p = +q.get('p') || null;
  const image = /^[1-6]$/.test(i) ? host(req) + '/coins/' + i + '.png' : i[0] === 'u' ? unb64u(i.slice(1)) : i[0] === 'b' ? (imageUrl(i) || host(req) + '/coins/1.png') : host(req) + '/coins/1.png';
  return { name, symbol, image, description: `Launched on hook. $${symbol} is hooked to ${a ? a.name + ' (' + a.sym + ')' : 'a real-world asset'}${p ? ` with a ${p}x pull` : ''}: 1% of every trade fills its reserve, and on every green day for ${a ? a.sym : 'its asset'} the reserve spends the move${p ? ` × ${p}` : ''} (up to ${CAP}%) buying $${symbol} and burning it.`, external_url: host(req), attributes: a ? [{ trait_type: 'hooked to', value: a.sym }, { trait_type: 'pull', value: p + 'x' }] : [], createdOn: host(req) }; }

// ---------------------------------------------------------------- the burn log: every hook, read from the chain
// a hook: memo  hook:burn:<coin>:<lamports>:<asset>:<move in bps>  + 0 SOL to LTAG, signed by the reserve wallet, with a Jupiter swap and a burn in the same transaction
let ledgerCache = null;
async function ledger() {
  if (!PIN.pad) return { reserve: null, entries: [] };
  if (ledgerCache && Date.now() - ledgerCache.t < 30000) return ledgerCache.v;
  const p = await padInfo(PIN.pad); if (!p.exists) return { reserve: null, entries: [] };
  const T = p.claimWallet, sigs = [];
  let before; for (let k = 0; k < 3; k++) { const s = await conn.getSignaturesForAddress(LTAG, { limit: 1000, before }); sigs.push(...s); if (s.length < 1000) break; before = s[s.length - 1].signature; }
  const ok = sigs.filter(x => !x.err), entries = [];
  for (let i = 0; i < ok.length; i += 50) { const txs = await conn.getParsedTransactions(ok.slice(i, i + 50).map(x => x.signature), { maxSupportedTransactionVersion: 0 }).catch(() => []);
    txs.forEach((t, k) => { if (!t || !t.meta || t.meta.err) return; const keys = t.transaction.message.accountKeys, payer = (keys[0].pubkey || keys[0]).toString(); if (payer !== T) return;
      const memo = t.transaction.message.instructions.find(ix => ix.program === 'spl-memo' && typeof ix.parsed === 'string' && ix.parsed.startsWith('hook:burn:'));
      if (!memo) return; const parts = memo.parsed.split(':'), coin = parts[2]; if (!coin) return;
      let burned = 0n; const ixs = [...t.transaction.message.instructions, ...(t.meta.innerInstructions || []).flatMap(x => x.instructions)];
      for (const ix of ixs) if (ix.program === 'spl-token' && ix.parsed && /^burn/.test(ix.parsed.type) && ix.parsed.info.mint === coin) burned += BigInt(ix.parsed.info.amount || (ix.parsed.info.tokenAmount && ix.parsed.info.tokenAmount.amount) || 0);
      entries.push({ sig: ok[i + k].signature, time: t.blockTime, coin, sol: (+parts[3] || 0) / 1e9, asset: parts[4] || null, move: (+parts[5] || 0) / 100, burned: burned.toString() }); }); }
  const v = { reserve: T, entries }; ledgerCache = { t: Date.now(), v }; return v;
}

// ---------------------------------------------------------------- price history: Raydium's own LaunchLab candles (15m), Dexscreener + GeckoTerminal after graduation
const klCache = new Map();
async function candles(pool, mint) { const key = pool + ':' + (mint || ''); const c = klCache.get(key); if (c && Date.now() - c.t < 45000) return c.v;
  let rows = []; try { const j = await getJ(`${HISTORY_API}/kline?poolId=${pool}&interval=15m&limit=300`); rows = ((j && j.data && j.data.rows) || []).map(r => ({ t: r.t, o: +r.o, h: +r.h, l: +r.l, c: +r.c })).sort((a, b) => a.t - b.t); } catch { }
  let src = 'raydium';
  if (mint) { try { const d = await getJ(`https://api.dexscreener.com/tokens/v1/solana/${mint}`); const p = (Array.isArray(d) ? d : []).filter(x => x.dexId !== 'launchlab').sort((a, b) => ((b.liquidity || {}).usd || 0) - ((a.liquidity || {}).usd || 0))[0];
      if (p && p.pairAddress && p.pairAddress !== pool) { const g = await getJ(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${p.pairAddress}/ohlcv/minute?aggregate=15&limit=200&currency=token`).catch(() => null);
        const L = g && g.data && g.data.attributes && g.data.attributes.ohlcv_list; if (L && L.length) { const after = L.map(x => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4] })).sort((a, b) => a.t - b.t); rows = [...rows.filter(r => r.t < after[0].t), ...after]; src = 'raydium+gecko'; } } } catch { } }
  const v = { rows, src }; klCache.set(key, { t: Date.now(), v }); return v; }

// ---------------------------------------------------------------- coins: Raydium's launch index + the burn log + the asset prices = every coin with its hook and reserve
function hookOf(c, A) { const a = A.find(x => x.sym === c.asset) || null, ch = a ? a.ch24 : null, today = c.lastHook != null && c.lastHook >= dayStart();
  const sp = c.pull ? spendPct(ch, c.pull) : 0, spendSol = c.reserve.sol * sp / 100;
  const status = !a ? 'unhooked' : ch == null ? 'no price' : today ? 'hooked today' : ch < MINMOVE ? 'filling' : spendSol < .001 ? 'reserve too small' : 'armed';
  return { asset: a ? { sym: a.sym, name: a.name, kind: a.kind, usd: a.usd, ch24: a.ch24 } : null, spendPct: sp, spendSol, today, armed: status === 'armed', status }; }
let coinCache = null;
async function coins(force) {
  if (!PIN.pad) return { open: false, coins: [], totals: null };
  if (!force && coinCache && Date.now() - coinCache.t < 20000) return coinCache.v;
  const [j, L, M, P] = await Promise.all([getJ(`${LAUNCH_API}/get/list?sort=new&size=100&mintType=default&platformId=${PIN.pad}`).catch(() => null), ledger().catch(() => ({ entries: [] })), market(), padInfo(PIN.pad).catch(() => ({ feePct: 1 }))]);
  const rows = ((j && j.data && j.data.rows) || []).filter(r => !r.platformInfo || r.platformInfo.pubKey === PIN.pad), feeRate = (P.feePct ?? 1) / 100, solUsd = M.sol && M.sol.usd;
  const list = rows.map(r => { let x = null, p = null; try { const u = new URL(r.metadataUrl); x = String(u.searchParams.get('x') || '').toUpperCase() || null; p = +u.searchParams.get('p') || null; } catch { }
    const cv = curveFromRow(r.totalSellA, r.totalFundRaisingB), mine = L.entries.filter(e => e.coin === r.mint), spentSol = mine.reduce((s, e) => s + (e.sol || 0), 0), earnedSol = (+r.volumeB || 0) * feeRate;
    const c = { mint: r.mint, pool: r.poolId, name: r.name, symbol: r.symbol, image: r.imgUrl, created: r.createAt, creator: r.creator || null, mcapUsd: r.marketCap || null, volumeUsd: r.volumeU || 0, volumeSol: +r.volumeB || 0, progress: +r.finishingRate || 0, graduated: (+r.finishingRate || 0) >= 100,
      curve: { raise: cv.raise, gradSol: cv.gradSol, gradUsd: solUsd ? cv.gradSol * solUsd : null }, asset: ASSET[x] ? x : null, pull: p,
      reserve: { earnedSol, spentSol, sol: Math.max(0, earnedSol - spentSol), usd: solUsd ? Math.max(0, earnedSol - spentSol) * solUsd : null }, hooks: mine.length, burned: mine.reduce((s, e) => s + Number(e.burned || 0), 0) / 1e6, lastHook: mine.length ? Math.max(...mine.map(e => e.time)) : null };
    c.hook = hookOf(c, M.assets); return c; });
  const totals = { coins: list.length, reserveSol: list.reduce((s, c) => s + c.reserve.sol, 0), earnedSol: list.reduce((s, c) => s + c.reserve.earnedSol, 0), spentSol: list.reduce((s, c) => s + c.reserve.spentSol, 0), hooks: L.entries.length, burned: list.reduce((s, c) => s + c.burned, 0), graduated: list.filter(c => c.graduated).length, armed: list.filter(c => c.hook.armed).length, solUsd };
  const v = { open: true, pad: PIN.pad, reserveWallet: L.reserve || null, feePct: P.feePct ?? 1, coins: list, totals }; coinCache = { t: Date.now(), v }; return v;
}
async function hookState(mint) { const c = (await coins()).coins.find(x => x.mint === mint); if (!c) throw new Error('not a hook coin'); return { coin: c, ...c.hook }; }
// proof of reserves: the reserve wallet's SOL (plus fees still waiting in LaunchLab's vault) against the sum of every coin's reserve
async function reserves() { const c = await coins(); if (!c.open || !c.reserveWallet) return { open: c.open, wallet: null };
  const [bal, p] = await Promise.all([conn.getBalance(new PublicKey(c.reserveWallet)), padInfo(PIN.pad)]); const wallet = bal / 1e9, waiting = p.unclaimedSol || 0, owed = c.totals.reserveSol;
  return { open: true, wallet: c.reserveWallet, walletSol: wallet, vaultSol: waiting, owedSol: owed, covered: wallet + waiting >= owed }; }
async function claim(req) {
  const b = await body(req); const wallet = pk(b.wallet, 'connect a wallet first'), id = padIdOf(wallet);
  if (!(await conn.getAccountInfo(id))) throw new Error('this wallet has no launchpad');
  const raydium = await sdk(wallet);
  const made = await raydium.launchpad.claimVaultPlatformFee({ programId: PROGRAM, platformId: id, mintB: WSOL, claimFeeWallet: wallet, txVersion: R.TxVersion.LEGACY, feePayer: wallet });
  return finish(txsOf(made), wallet, [], null, !!b.simulate);
}

// ---------------------------------------------------------------- the hook: a Jupiter swap SOL → coin + a burn + the log memo, in one transaction
const toIx = i => new TransactionInstruction({ programId: new PublicKey(i.programId), keys: i.accounts.map(a => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })), data: Buffer.from(i.data, 'base64') });
async function jupTx(w, inMint, outMint, amount, memo, extra = () => [], slip = 200) {
  for (const maxAcc of [40, 30, 22]) {
    const q = await getJ(`${JUP}/swap/v1/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${slip}&maxAccounts=${maxAcc}`, 10000); if (!q.outAmount) throw new Error(q.error || 'no route right now');
    let r, j; for (let k = 0; k < 2; k++) { r = await fetch(`${JUP}/swap/v1/swap-instructions`, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteResponse: q, userPublicKey: w.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 300000, priorityLevel: 'high' } } }) }); if (r.status === 429 && !k) { await sleep(1500); continue; } break; }
    j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw new Error(j.error || (r.status === 429 ? 'Jupiter is busy, try again in a few seconds' : 'Jupiter returned no swap'));
    const altMap = j.addressesByLookupTableAddress || null; let alts;
    if (altMap) alts = Object.entries(altMap).map(([k, a]) => new AddressLookupTableAccount({ key: new PublicKey(k), state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: a.map(x => new PublicKey(x)) } }));
    else alts = (await Promise.all((j.addressLookupTableAddresses || []).map(k => conn.getAddressLookupTable(new PublicKey(k))))).map(x => x.value).filter(Boolean);
    const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(1400000, (+j.computeUnitLimit || 300000) + 90000) }); // room for the memo, the tag and the burn
    const ixs = [cu, ...(j.computeBudgetInstructions || []).filter(i => Buffer.from(i.data, 'base64')[0] !== 2).map(toIx), ...(j.setupInstructions || []).map(toIx), toIx(j.swapInstruction), ...(j.cleanupInstruction ? [toIx(j.cleanupInstruction)] : []), ...(j.otherInstructions || []).map(toIx), ...extra(q), memoIx(w, memo), tagTo(w, LTAG)];
    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: w, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alts));
    let bytes; try { bytes = tx.serialize(); } catch { continue; } if (bytes.length > 1232) continue;
    return { tx: Buffer.from(bytes).toString('base64'), quote: { in: q.inAmount, out: q.outAmount, min: q.otherAmountThreshold, impact: +q.priceImpactPct, route: (q.routePlan || []).map(x => x.swapInfo.label) } };
  }
  throw new Error('the route is too big for one transaction right now. try a different amount');
}
async function hookTx(w, coinMint, lamports, sym, moveBps) { const mint = new PublicKey(coinMint), macc = await conn.getAccountInfo(mint); if (!macc) throw new Error('mint not found'); const prog = macc.owner, ata = SPL.getAssociatedTokenAddressSync(mint, w, false, prog);
  return jupTx(w, WSOL.toBase58(), coinMint, lamports, `hook:burn:${coinMint}:${lamports}:${sym}:${moveBps}`, q => [SPL.createBurnInstruction(ata, mint, w, BigInt(q.otherAmountThreshold), [], prog)]); }
async function buildHook(req) { const b = await body(req), w = pk(b.wallet, 'connect the reserve wallet');
  if (!PIN.pad) throw new Error('the hook launchpad is not open yet'); const p = await padInfo(PIN.pad); if (!p.exists) throw new Error('launchpad not found');
  if (p.claimWallet !== w.toBase58()) throw new Error('only the reserve wallet (the one that created the launchpad) can run hooks');
  coinCache = null; ledgerCache = null; mktCache = null; assetCache = null; const s = await hookState(String(b.coin)); const c = s.coin;
  if (!s.armed) throw new Error(`$${c.symbol} is not armed: ${s.status}${s.asset && s.asset.ch24 != null ? ` (${s.asset.sym} ${s.asset.ch24 >= 0 ? '+' : ''}${s.asset.ch24.toFixed(2)}% in 24h)` : ''}`);
  const sol = Math.min(s.spendSol, c.reserve.sol); if (!(sol >= .001)) throw new Error(`$${c.symbol}'s reserve is ${c.reserve.sol.toFixed(4)} SOL. nothing to buy with yet`);
  const r = await hookTx(w, c.mint, Math.floor(sol * 1e9), s.asset.sym, Math.round(s.asset.ch24 * 100));
  return { txs: [r.tx], versioned: true, quote: r.quote, sol, move: s.asset.ch24, asset: s.asset.sym, spendPct: s.spendPct }; }

// ---------------------------------------------------------------- wallets and profiles
async function walletView(addr) { const w = pk(addr, 'bad wallet');
  const [bal, a1, a2] = await Promise.all([conn.getBalance(w), conn.getParsedTokenAccountsByOwner(w, { programId: SPL.TOKEN_PROGRAM_ID }), conn.getParsedTokenAccountsByOwner(w, { programId: SPL.TOKEN_2022_PROGRAM_ID })]);
  const held = {}; for (const x of [...a1.value, ...a2.value]) { const i = x.account.data.parsed.info, ui = +i.tokenAmount.uiAmount || 0; if (!ui) continue; held[i.mint] = (held[i.mint] || 0) + ui; }
  const mints = Object.keys(held), info = await jupInfo([WSOL.toBase58(), ...mints]), solUsd = (info[WSOL.toBase58()] || {}).usd ?? null;
  const tokens = mints.map(m => { const t = info[m] || {}; return { mint: m, amount: held[m], symbol: t.symbol || m.slice(0, 4), name: t.name || '', icon: t.icon || null, usd: t.usd != null ? t.usd * held[m] : null }; }).sort((x, y) => (y.usd || 0) - (x.usd || 0));
  const sol = bal / 1e9; return { wallet: w.toBase58(), sol, solUsd, solValue: solUsd != null ? sol * solUsd : null, tokens, totalUsd: (solUsd != null ? sol * solUsd : 0) + tokens.reduce((a, t) => a + (t.usd || 0), 0) }; }
let profCache = null;
async function profiles() { if (profCache && Date.now() - profCache.t < 30000) return profCache.v;
  const sigs = await conn.getSignaturesForAddress(PTAG, { limit: 500 }); const ok = sigs.filter(x => !x.err), map = {};
  for (let i = 0; i < ok.length; i += 50) { const txs = await conn.getParsedTransactions(ok.slice(i, i + 50).map(x => x.signature), { maxSupportedTransactionVersion: 0 }).catch(() => []);
    txs.forEach((t, k) => { if (!t || (t.meta && t.meta.err)) return; const sig = ok[i + k].signature, who = (t.transaction.message.accountKeys[0].pubkey || t.transaction.message.accountKeys[0]).toString(), time = t.blockTime;
      for (const ix of t.transaction.message.instructions) { if (ix.program !== 'spl-memo' || typeof ix.parsed !== 'string' || !ix.parsed.startsWith('hook:profile:')) continue; if (map[who] && map[who].time >= time) continue;
        try { const j = JSON.parse(ix.parsed.slice(13)); map[who] = { wallet: who, name: clean(j.n, 24), bio: clean(j.b, 140), avatar: /^https:\/\//.test(j.a || '') ? clean(j.a, 160) : '', x: clean(j.x, 16).replace(/[^A-Za-z0-9_]/g, ''), time, sig }; } catch { } } }); }
  profCache = { t: Date.now(), v: map }; return map; }
async function buildProfile(req) { const b = await body(req), w = pk(b.wallet, 'connect a wallet first');
  const j = { n: clean(b.name, 24), b: clean(b.bio, 140), a: /^https:\/\/[^\s"'<>]{6,160}$/.test(b.avatar || '') ? b.avatar : '', x: clean(b.x, 16).replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '') };
  if (j.n.length < 2) throw new Error('pick a name, at least 2 characters');
  const t = new Transaction().add(memoIx(w, 'hook:profile:' + JSON.stringify(j)), tagTo(w, PTAG));
  const { blockhash } = await conn.getLatestBlockhash('confirmed'); t.recentBlockhash = blockhash; t.feePayer = w; profCache = null;
  return { txs: [ser(t)] }; }
async function holdersOf(mintStr) { const mint = pk(mintStr, 'bad mint'), acc = await conn.getAccountInfo(mint); if (!acc) throw new Error('mint not found'); const prog = acc.owner;
  let rows = [], full = true;
  try { const r = await Promise.race([conn.getParsedProgramAccounts(prog, { filters: [...(prog.equals(SPL.TOKEN_PROGRAM_ID) ? [{ dataSize: 165 }] : []), { memcmp: { offset: 0, bytes: mint.toBase58() } }] }), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 9000))]);
    rows = r.map(x => ({ owner: x.account.data.parsed.info.owner, raw: BigInt(x.account.data.parsed.info.tokenAmount.amount) })); }
  catch (e) { full = false; const top = await conn.getTokenLargestAccounts(mint); const infos = await conn.getMultipleParsedAccounts(top.value.map(x => x.address)); rows = infos.value.map((x, i) => x ? { owner: x.data.parsed.info.owner, raw: BigInt(top.value[i].amount) } : null).filter(Boolean); }
  const by = {}; for (const r of rows) { if (r.raw <= 0n) continue; let on = false; try { on = PublicKey.isOnCurve(new PublicKey(r.owner).toBytes()); } catch { } if (!on) continue; by[r.owner] = (by[r.owner] || 0n) + r.raw; }
  return { full, count: Object.keys(by).length }; }
async function sendTxs(req) {
  const b = await body(req); if (!Array.isArray(b.txs) || !b.txs.length || b.txs.length > 6) throw new Error('nothing to send');
  const sigs = [];
  for (const t of b.txs) { const sig = await conn.sendRawTransaction(Buffer.from(t, 'base64'), { skipPreflight: false, maxRetries: 3 }); sigs.push(sig);
    for (let k = 0; k < 30; k++) { const s = (await conn.getSignatureStatuses([sig])).value[0]; if (s && s.err) throw new Error('transaction failed: ' + JSON.stringify(s.err)); if (s && /confirmed|finalized/.test(s.confirmationStatus || '')) break; await sleep(800); } }
  ledgerCache = null; coinCache = null; profCache = null; return { sigs };
}

module.exports = async (req, res) => { if (req.method === 'GET') res.setHeader('access-control-allow-origin', '*');
  const q = new URL(req.url, 'http://x').searchParams, a = q.get('a');
  try {
    if (a === 'market') return out(res, 200, await market(), 's-maxage=30, stale-while-revalidate=90');
    if (a === 'assets') return out(res, 200, await assets(), 's-maxage=30, stale-while-revalidate=90');
    if (a === 'coins') return out(res, 200, await coins(), 's-maxage=15, stale-while-revalidate=60');
    if (a === 'coin') { const c = await coins(), m = String(q.get('mint') || ''), L = await ledger().catch(() => ({ entries: [] })), coin = c.coins.find(x => x.mint === m) || null; let k = { rows: [], src: null };
      if (coin) k = await candles(coin.pool, coin.graduated ? coin.mint : null).catch(() => k);
      return out(res, 200, { coin, open: c.open, entries: L.entries.filter(e => e.coin === m), candles: k.rows, src: k.src }, 's-maxage=15'); }
    if (a === 'hookstate') return out(res, 200, await hookState(String(q.get('mint') || '')), 's-maxage=15');
    if (a === 'ledger') { const L = await ledger(); return out(res, 200, { reserve: L.reserve, entries: L.entries.slice(0, 300) }, 's-maxage=15'); }
    if (a === 'reserves') return out(res, 200, await reserves(), 's-maxage=30');
    if (a === 't') return out(res, 200, tokenMeta(req, q), 'public, max-age=31536000, immutable');
    if (a === 'wallet') return out(res, 200, await walletView(q.get('addr')));
    if (a === 'profiles') { const v = await profiles(); return out(res, 200, { profiles: Object.values(v).sort((x, y) => y.time - x.time) }, 's-maxage=20'); }
    if (a === 'profile') { const v = await profiles(); return out(res, 200, { profile: v[pk(q.get('wallet'), 'bad wallet').toBase58()] || null }); }
    if (a === 'holders') { const h = await holdersOf(q.get('mint')); return out(res, 200, h, 's-maxage=60'); }
    if (a === 'bal') { const w = pk(q.get('wallet'), 'bad wallet'), m = pk(q.get('mint'), 'bad mint'); const r = await conn.getParsedTokenAccountsByOwner(w, { mint: m }); return out(res, 200, { accounts: r.value.map(x => ({ address: x.pubkey.toBase58(), raw: x.account.data.parsed.info.tokenAmount.amount, decimals: x.account.data.parsed.info.tokenAmount.decimals })) }); }
    if (a === 'pad') return out(res, 200, await pad(q), 's-maxage=10');
    // a dry run of the hook builder for any wallet and any coin: builds the same transaction and simulates it (nothing is signed or sent)
    if (a === 'simHook') { const w = pk(q.get('wallet'), 'bad wallet'), lam = Math.floor(Math.min(1, +q.get('sol') || .01) * 1e9); const r = await hookTx(w, pk(q.get('mint'), 'bad mint').toBase58(), lam, 'NVDA', 123);
      const raw = Buffer.from(r.tx, 'base64'), s = await conn.simulateTransaction(VersionedTransaction.deserialize(raw), { sigVerify: false, replaceRecentBlockhash: true }); const vt = VersionedTransaction.deserialize(raw), keys = vt.message.staticAccountKeys.map(k => k.toBase58()); return out(res, 200, { bytes: raw.length, quote: r.quote, err: s.value.err, units: s.value.unitsConsumed, programs: vt.message.compiledInstructions.map(i => keys[i.programIdIndex] || '#' + i.programIdIndex), burnLogs: (s.value.logs || []).filter(l => /Burn/.test(l)), logs: (s.value.logs || []).filter(l => /Memo|rror|ail/.test(l)).slice(-6) }); }
    // a dry run of a launch on any launchpad: simulates the create transaction
    if (a === 'simLaunch') { const fake = { body: { wallet: q.get('wallet'), pad: q.get('pad') || RAYDIUM_PLATFORM.toBase58(), name: 'hook test', symbol: 'TEST', image: '1', asset: q.get('asset') || 'NVDA', pull: +q.get('pull') || 3, simulate: true }, headers: req.headers };
      const r = await buildLaunch(fake); return out(res, 200, { uri: r.uri, asset: r.asset, pull: r.pull, txs: r.txs.length, sim: r.sim }); }
    if (req.method === 'POST' && a === 'upload') return out(res, 200, await upload(req));
    if (a === 'img') { const u = imageUrl(String(q.get('k') || '')); if (!u) return out(res, 404, { error: 'no image' }); res.statusCode = 302; res.setHeader('location', u); res.setHeader('cache-control', 'public, max-age=31536000'); return res.end(); }
    if (req.method === 'POST' && a === 'buildPad') return out(res, 200, await buildPad(req));
    if (req.method === 'POST' && a === 'buildLaunch') return out(res, 200, await buildLaunch(req));
    if (req.method === 'POST' && a === 'buildProfile') return out(res, 200, await buildProfile(req));
    if (req.method === 'POST' && a === 'claim') return out(res, 200, await claim(req));
    if (req.method === 'POST' && a === 'buildHook') return out(res, 200, await buildHook(req));
    if (req.method === 'POST' && a === 'send') return out(res, 200, await sendTxs(req));
    return out(res, 404, { error: 'unknown action' });
  } catch (e) { return out(res, 400, { error: e.message || String(e) }); }
};
module.exports._t = { market, assets, coins, ledger, candles, curveFromRow, spendPct, hookOf, buildPad, buildLaunch, buildHook, claim, tokenMeta, conn, PIN, setChain: v => { chainCache = { t: Date.now() + 1e9, v }; }, setAssets: v => { assetCache = { t: Date.now() + 1e9, v }; } };
