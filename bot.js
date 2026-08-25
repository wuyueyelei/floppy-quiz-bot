// $FLOPPY quiz bot — listens for QUIZ rounds on technocore.chat, answers automatically.
// usage: node bot.js [--once-check]   (run with nohup/pm2 for 24/7)
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { loadOrCreate, signString } = require("./identity.js");

const ROOM = "ca-cxxphyiwazuwwxd9agjca3l6gjjj4wmxogyyjczkpump";
const BASE = "https://technocore.chat";
const LOG = (...a) => console.log(new Date().toISOString(), ...a);

// NOTE: server 500s when the default node UA is combined with long-poll wait,
// and on "accept-encoding: gzip/deflate" — pin both.
const GET_HEADERS = { "accept-encoding": "identity", "user-agent": "floppy-bot/1.0" };

const id = loadOrCreate();
const stateFile = path.join(__dirname, "bot_state.json");
const learnedFile = path.join(__dirname, "learned.json");
const unknownFile = path.join(__dirname, "unknown_questions.log");

let state = { since: null, answeredCids: {}, wins: 0, points: 0 };
if (fs.existsSync(stateFile)) state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, "utf8")) };
let learned = [];
if (fs.existsSync(learnedFile)) learned = JSON.parse(fs.readFileSync(learnedFile, "utf8"));

function saveState() { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); }

// ---------------- knowledge base ----------------
// matched with .test(question); first hit wins. keep patterns tight.
const RULES = [
  // seen in the wild
  { re: /bored ape|bayc/i, a: "10000" },
  { re: /stand(s)? for.*nft|nft.*stand(s)? for|full name.*nft|nft.*full(y)? name|expand.*nft/i, a: "nonfungibletoken" },
  { re: /token standard.*(nft|erc)|nft.*token standard|(erc|standard).*(nft)/i, a: "erc721" },
  { re: /stablecoin.*(collaps|crash|de-?peg).*(2022|may)|terra|luna/i, a: "ust" },
  { re: /creator of uniswap|uniswap.*founder|who (created|made|founded) uniswap/i, a: "haydenadams" },
  { re: /billionth of.*(eth|ether)/i, a: "gwei" },

  // crypto fundamentals
  { re: /creator of (bitcoin|btc)|bitcoin.*creator|satoshi.*last name|who (created|invented) bitcoin/i, a: "satoshinakamoto" },
  { re: /creator of (ethereum|eth)|ethereum.*(creator|founder)|vitalik.*last|who (created|founded) ethereum/i, a: "vitalikbuterin" },
  { re: /smallest unit of (bitcoin|btc)/i, a: "satoshi" },
  { re: /max(imum)? supply of bitcoin|bitcoin.*cap.*21|how many bitcoin.*ever|total bitcoin/i, a: "21000000" },
  { re: /eth.*block time|block time.*ethereum|how (long|often).*ethereum block/i, a: "12" },
  { re: /bitcoin.*block (time|interval)|how (long|often).*bitcoin block/i, a: "10" },
  { re: /halving.*(interval|years|often)|how often.*halving/i, a: "4" },
  { re: /consensus.*(after|since) the merge|ethereum.*consensus (now|after)/i, a: "proofofstake" },
  { re: /largest stablecoin|biggest stablecoin|stablecoin.*by market cap/i, a: "tether" },
  { re: /ticker.*(tether|usdt)/i, a: "usdt" },
  { re: /dao stands|dao.*stands for|expand.*dao|autonomous organization/i, a: "decentralizedautonomousorganization" },
  { re: /defi stands|defi.*stands for/i, a: "decentralizedfinance" },
  { re: /smart contract.*platform.*first|first smart contract platform/i, a: "ethereum" },
  { re: /whitepaper.*bitcoin|bitcoin.*whitepaper.*(year|publish)/i, a: "2008" },
  { re: /genesis block|first bitcoin block/i, a: "2009" },
  { re: /pizza.*bitcoin|bitcoin.*pizza|first real.*(purchase|transaction)/i, a: "10000" },
  { re: /merge.*(year|when)|ethereum merge/i, a: "2022" },
  { re: /telegram.*coin|ton/i, a: "ton" },
  { re: /solana.*(founder|creator)|who.*solana/i, a: "anatolyyakovenko" },
  { re: /cz.*exchange|ceo of binance/i, a: "cz" },
  { re: /largest.*exchange|biggest crypto exchange/i, a: "binance" },
  { re: /binance.*chain|bnb.*(stands|smart chain)/i, a: "bnb" },
  { re: /dogecoin.*(creator|based on)|doge.*shiba/i, a: "shibainu" },
  { re: /ordinals.*(enable|bitcoin)|bitcoin nft/i, a: "ordinals" },
  { re: /lightning network.*(layer|is)/i, a: "layer2" },
  { re: /gas.*(token|fee).*ethereum|pay gas/i, a: "eth" },
  { re: /wrapped (bitcoin|ether|eth)/i, a: "wbtc" },
  { re: /aave.*(is|does)|flash loan/i, a: "aave" },
  { re: /curve.*(dex|stable)|stable.*dex/i, a: "curve" },
  { re: /opensea.*(is|marketplace)/i, a: "opensea" },
  { re: /most expensive nft|beeple|everydays/i, a: "69000000" },
  { re: /erc-?20.*(is|for)|fungible token standard/i, a: "erc20" },
  { re: /hex.*hash.*(length|bits|characters)|sha-?256.*(output|length)/i, a: "256" },
  { re: /public key.*(algorithm|crypto)|ed25519|ecdsa/i, a: "ecdsa" },
  { re: /zero knowledge.*(abbreviation|stands)/i, a: "zk" },
  { re: /rollup.*(zk|optimistic)|zk ?rollup/i, a: "zkrollup" },
  { re: /optimism.*layer|arbitrum.*layer|layer ?2.*(arbitrum|optimism)/i, a: "layer2" },
  { re: /what is.*airdrop.*(crypto)|airdrop means/i, a: "freetokendistribution" },
  { re: /hodl stands|hodl means/i, a: "hold" },
  { re: /wagmi stands|gm means/i, a: "wagmi" },
  { re: /seed phrase.*(words|length)|mnemonic.*(words)/i, a: "12" },
  { re: /bip-?39/i, a: "bip39" },
  { re: /tps.*(solana)|solana.*(tps|speed)/i, a: "65000" },
  { re: /solana.*(token standard|nft standard)/i, a: "token22" },
  { re: /pump.*fun|bonding curve.*(launch|platform)/i, a: "pumpfun" },
  { re: /mint.*(means|nft)/i, a: "mint" },
  { re: /eip-?1559|burn.*fee/i, a: "eip1559" },
  { re: /ripple.*(token|coin)/i, a: "xrp" },
  { re: /cardano.*(founder|creator)|charles hoskinson/i, a: "charleshoskinson" },
  { re: /polkadot.*(founder|creator)/i, a: "gavinwood" },
  { re: /solidity.*(is|language)/i, a: "solidity" },
  { re: /rust.*(solana|language)/i, a: "rust" },
  { re: /metamask.*(is|wallet)/i, a: "metamask" },
  { re: /ledger.*(trezor|hardware)/i, a: "ledger" },
  { re: /mt gox|mtgox/i, a: "mtgox" },
  { re: /silk road.*(operator|creator|founder|pseudonym|name|used)|operator of silk road|who.*(ran|ran|operated) silk road/i, a: "dread pirate roberts" },
  { re: /ethereum.*supply|eth burn|deflationary eth/i, a: "eip1559" },
  { re: /web3.*(stands|means|is)/i, a: "web3" },
  { re: /ipfs.*(stands|is)/i, a: "interplanetaryfilesystem" },
  { re: /nft.*(royalt|standard.* royalties)/i, a: "eip2981" },
  // ---- 补充：人物与事件 ----
  { re: /first.*bitcoin.*transaction|received.*first.*btc|first btc.*recipient/i, a: "hal finney" },
  { re: /running bitcoin/i, a: "hal finney" },
  { re: /bit gold|pre-bitcoin.*(idea|proposal)/i, a: "nick szabo" },
  { re: /hashcash|proof of work.*(invented|originated|before)/i, a: "adam back" },
  { re: /b-?money/i, a: "wei dai" },
  { re: /pizza.*(guy|man|buy|bought)|laszlo|10,?000.*pizza/i, a: "laszlo hanecz" },
  { re: /ftx.*(founder|ceo|collapse)|sam bankman|sbf/i, a: "sam bankman-fried" },
  { re: /alameda.*(research|founder)/i, a: "caroline ellison" },
  { re: /coinbase.*(founder|ceo|created)/i, a: "brian armstrong" },
  { re: /bitfinex.*(hack|stolen)/i, a: "bitfinex" },
  { re: /ronin.*(bridge|hack)/i, a: "ronin bridge" },
  { re: /poly network.*(hack|exploit)/i, a: "poly network" },
  { re: /dao hack.*(year|when|much)|the dao.*(hack|attack)/i, a: "2016" },
  { re: /crypto.*(winter).*(year|when)/i, a: "2022" },
  { re: /el salvador|first country.*(bitcoin|legal tender)/i, a: "el salvador" },
  { re: /three arrows|3ac.*(founder)/i, a: "su zhu" },
  { re: /celsius.*(collapse|ceo)/i, a: "alex mashinsky" },
  { re: /do kwon|terraform labs/i, a: "do kwon" },
  { re: /justin sun|tron.*(founder)/i, a: "justin sun" },
  { re: /cryptopunks.*(creator|made|who)/i, a: "larva labs" },
  { re: /first nft/i, a: "quantum" },
  { re: /kevin mccoy/i, a: "quantum" },
  // ---- 补充：日期与数字 ----
  { re: /whitepaper.*(date|published|released)|bitcoin whitepaper.*(date|when)/i, a: "october 31 2008" },
  { re: /genesis block.*(date|when|mined)/i, a: "january 3 2009" },
  { re: /ethereum.*(launch|mainnet|went live).*(date|year|when)/i, a: "july 30 2015" },
  { re: /pizza day|bitcoin pizza.*(date|day|year)/i, a: "may 22 2010" },
  { re: /bitcoin.*all.?time high|btc ath|ath.*bitcoin/i, a: "69000" },
  { re: /satoshi.*(btc|hold|own|mined)/i, a: "1 million" },
  { re: /satoshi.*whitepaper.*(title|called|named)/i, a: "bitcoin a peer-to-peer electronic cash system" },
  { re: /first.*bitcoin exchange/i, a: "bitcoinmarket.com" },
  { re: /smallest.*unit.*eth|wei.*(named|who)/i, a: "wei dai" },
  { re: /bip stands|bip.*(stands for)/i, a: "bitcoin improvement proposal" },
  { re: /lightning.*(paper|author|proposed)/i, a: "joseph poon" },
  { re: /blockstream|sidechain.*(company|invented)/i, a: "blockstream" },
  { re: /chainlink.*(is|oracle)/i, a: "chainlink" },
  { re: /monero|privacy coin.*(most|popular)/i, a: "monero" },
  { re: /zcash.*(founder|creator)/i, a: "zooko wilcox" },
  { re: /ens.*(stands|domain)/i, a: "ethereum name service" },
];

function solve(q) {
  const ql = q.toLowerCase();
  // learned first (exact-ish substring from past RESULTs)
  for (const l of learned) {
    if (ql.includes(l.q.toLowerCase()) || l.q.toLowerCase().includes(ql)) return l.a;
  }
  for (const r of RULES) {
    if (r.skip) continue;
    if (r.re.test(q)) return r.a;
  }
  return null;
}

// ---------------- protocol helpers ----------------
function normalizeAnswer(a) {
  return a.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function quizHash(answer, cid) {
  return crypto.createHash("sha256").update(`${answer}:${cid}:${id.did}`).digest("hex");
}

async function saySigned(text, attempt = 0) {
  const nonce = String(Date.now());
  const sig = signString(id.priv, `${ROOM}|${nonce}|${text}`);
  const url = `${BASE}/r/${ROOM}/say-signed/${encodeURIComponent(id.did)}/${encodeURIComponent(sig)}/${nonce}/${encodeURIComponent(text)}`;
  const res = await fetch(url, { headers: GET_HEADERS });
  const body = await res.text();
  if (res.status === 429) {
    const wait = (body.match(/(\d+)\s*second/i) || [, "5"])[1];
    LOG("rate limited, waiting", wait, "s");
    await new Promise(r => setTimeout(r, Number(wait) * 1000));
    return saySigned(text, attempt);
  }
  if (res.status === 500 && attempt < 10) {
    // upstream is flaky behind cloudflare — retry fast with a fresh nonce
    await new Promise(r => setTimeout(r, 800));
    return saySigned(text, attempt + 1);
  }
  LOG("write ->", res.status, body.slice(0, 120));
  return res.ok;
}

// ---------------- message handling ----------------
function handleQuiz(text) {
  // ▶ QUIZ <round> <cid> | 15 MIN | ... || Q: <question> || HOW: ...
  const m = text.match(/▶ QUIZ (\w+) (\w+).*?\|\| Q: (.*?)\s*\|\|/s) || text.match(/▶ QUIZ (\w+) (\w+).*Q: (.*?)\s*\|\|/);
  if (!m) return;
  const [, round, cid, q] = m;
  if (state.answeredCids[cid]) { LOG("already answered cid", cid); return; }
  LOG(`QUIZ round=${round} cid=${cid} Q="${q.trim()}"`);
  const raw = solve(q.trim());
  if (!raw) {
    fs.appendFileSync(unknownFile, `${new Date().toISOString()} cid=${cid} Q=${q.trim()}\n`);
    LOG("!! no answer for this question — logged to unknown_questions.log");
    // still mark so we don't re-log every poll
    state.answeredCids[cid] = "unknown";
    saveState();
    return;
  }
  const answer = normalizeAnswer(raw);
  const a = quizHash(answer, cid);
  const tag = crypto.randomBytes(4).toString("hex");
  const msg = `f1 ch.answer ${tag} - cid=${cid} a=${a}`;
  LOG(`answering: "${raw}" -> hash ${a}`);
  saySigned(msg).then(ok => {
    if (ok) {
      state.answeredCids[cid] = answer;
      saveState();
    }
  });
}

function handleResult(text) {
  // ■ RESULT <round> || ANSWER: <ans> || 1st z6Mk…XXXX Npt || ...
  const m = text.match(/■ RESULT (\w+).*?ANSWER: (.*?)\s*\|\|/);
  const am = m || text.match(/ANSWER: (.*?)\s*\|\|/) || text.match(/ANSWER: (\S+)/);
  if (!am) return;
  const answer = am[1];
  // find the quiz question for this round from recent memory
  if (state.lastQuiz && state.lastQuiz.round && !learned.some(l => l.q === state.lastQuiz.q)) {
    learned.push({ round: state.lastQuiz.round, q: state.lastQuiz.q, a: answer });
    fs.writeFileSync(learnedFile, JSON.stringify(learned, null, 2));
    LOG(`learned: "${state.lastQuiz.q}" => ${answer}`);
  }
  if (text.includes(id.did.slice(0, 20)) || /z6MkvdfNUw2p/.test(text)) {
    const pm = text.match(/z6MkvdfNUw2p\S*\s*(\d+)pt/);
    if (pm) { state.points = Number(pm[1]); LOG("*** WE SCORED", pm[1], "points ***"); }
  }
  saveState();
}

async function pollOnce() {
  const url = `${BASE}/r/${ROOM}?since=${state.since}&wait=10&n=${Date.now()}`;
  const res = await fetch(url, { headers: GET_HEADERS });
  const body = await res.text();
  if (res.status === 429) {
    const wait = (body.match(/(\d+)\s*second/i) || [, "5"])[1];
    LOG("rate limited, waiting", wait, "s");
    await new Promise(r => setTimeout(r, Number(wait) * 1000));
    return;
  }
  if (!res.ok) { await sleep(res.status === 500 ? 1500 : 5000); return; }
  const lines = body.split("\n").filter(l => /^\[\d+\]/.test(l));
  for (const line of lines) {
    const sm = line.match(/\[(\d+)\]/);
    if (!sm) continue;
    state.since = Number(sm[1]);
    if (line.includes("▶ QUIZ")) {
      state.lastQuiz = extractQuiz(line);
      handleQuiz(line);
    } else if (line.includes("■ RESULT")) {
      handleResult(line);
    }
  }
  saveState();
}

function extractQuiz(line) {
  const m = line.match(/▶ QUIZ (\w+) (\w+).*?\|\| Q: (.*?)\s*\|\|/);
  return m ? { round: m[1], cid: m[2], q: m[3].trim() } : null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  LOG("bot up. did:", id.did);
  // bootstrap: get current last seq
  if (state.since == null) {
    const res = await fetch(`${BASE}/r/${ROOM}?limit=1&n=${Date.now()}`, { headers: GET_HEADERS });
    const body = await res.text();
    const m = body.match(/\[(\d+)\]/);
    state.since = m ? Number(m[1]) : 0;
    LOG("bootstrapped at seq", state.since);
    saveState();
  }
  // say hi once on first run
  if (!state.helloed) {
    await saySigned("first signature from a fresh key. onboarded at https://floppysol.xyz. powered by $FLOPPY");
    state.helloed = true;
    saveState();
  }
  // main loop
  while (true) {
    try { await pollOnce(); }
    catch (e) { LOG("loop error:", e.message); await sleep(5000); }
  }
}

main();
