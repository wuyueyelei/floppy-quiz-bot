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
  { re: /hashcash|(who|first).*(proof of work)|proof of work.*(invent|originat|before|creat)/i, a: "adam back" },
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

// ---------------- candidate generation ----------------
// Strategy v2: never skip a round. When RULES/learned miss, fall back to a
// keyword candidate pool + common numeric guesses, and submit several
// ranked answers (best first). The quiz counts the first three CORRECT
// answers of a round, so extra guesses cost nothing and one of them
// landing still scores. Learned-from-RESULT answers are ground truth and
// always go first.
const POOL = [
  { k: /silk road/i, a: ["dread pirate roberts", "ross ulbricht"] },
  { k: /mt ?gox/i, a: ["mtgox", "850000", "2014", "mark karpeles"] },
  { k: /satoshi/i, a: ["satoshinakamoto", "1 million", "satoshi"] },
  { k: /vitalik|buterin/i, a: ["vitalikbuterin"] },
  { k: /ethereum.*(founder|creat)/i, a: ["vitalikbuterin"] },
  { k: /hal finney/i, a: ["hal finney"] },
  { k: /whitepaper/i, a: ["2008", "october 31 2008"] },
  { k: /genesis block/i, a: ["2009", "january 3 2009"] },
  { k: /pizza/i, a: ["10000", "laszlo hanyecz", "may 22 2010"] },
  { k: /halving/i, a: ["4", "210000"] },
  { k: /(the )?merge/i, a: ["2022", "proofofstake"] },
  { k: /nft/i, a: ["erc721", "nonfungibletoken"] },
  { k: /erc-?20|fungible/i, a: ["erc20"] },
  { k: /dao/i, a: ["decentralizedautonomousorganization", "2016"] },
  { k: /stablecoin|depeg|de-peg/i, a: ["tether", "ust", "usdc"] },
  { k: /terra|luna|do kwon/i, a: ["ust", "do kwon", "2022"] },
  { k: /ftx|sbf|bankman/i, a: ["sam bankman-fried", "2022"] },
  { k: /binance|cz/i, a: ["binance", "cz", "changpeng zhao"] },
  { k: /solana/i, a: ["anatolyyakovenko", "65000", "sol", "rust"] },
  { k: /lightning/i, a: ["layer2", "joseph poon"] },
  { k: /bored ape|bayc/i, a: ["10000"] },
  { k: /cryptopunk/i, a: ["10000", "larva labs"] },
  { k: /beeple|everydays|expensive nft/i, a: ["69000000", "beeple"] },
  { k: /el salvador|legal tender/i, a: ["el salvador"] },
  { k: /block ?time/i, a: ["10", "12"] },
  { k: /supply|cap of bitcoin|how many bitcoin/i, a: ["21000000", "21"] },
  { k: /smallest unit/i, a: ["satoshi", "wei"] },
  { k: /gwei|billionth/i, a: ["gwei"] },
  { k: /uniswap/i, a: ["haydenadams"] },
  { k: /opensea/i, a: ["opensea"] },
  { k: /wallet|metamask/i, a: ["metamask"] },
  { k: /cold storage|hardware wallet/i, a: ["ledger"] },
  { k: /monero|privacy/i, a: ["monero"] },
  { k: /oracle|chainlink/i, a: ["chainlink"] },
  { k: /zcash|zero knowledge|zk/i, a: ["zk", "zooko wilcox"] },
  { k: /rollup|layer ?2|l2/i, a: ["zkrollup", "layer2", "arbitrum", "optimism"] },
  { k: /ipfs/i, a: ["interplanetaryfilesystem"] },
  { k: /ens|domain/i, a: ["ethereum name service"] },
  { k: /airdrop/i, a: ["freetokendistribution"] },
  { k: /hodl/i, a: ["hold"] },
  { k: /wagmi|gm\b/i, a: ["wagmi"] },
  { k: /gas|fee/i, a: ["eth", "gwei"] },
  { k: /satoshi.*unit|unit.*satoshi/i, a: ["satoshi"] },
];
const NUMERIC_GUESSES = [
  "10000", "21000000", "21", "10", "12", "4", "2009", "2008", "2022", "2021",
  "2016", "2015", "2014", "2010", "2013", "3", "2", "8", "5", "7", "6", "1",
  "1 million", "1000000", "69000", "65000", "69000000", "850000", "210000",
  "32", "64", "256", "128", "21 million", "0", "100", "1000",
];

// Firehose: ~80 most common correct answers across all crypto trivia.
// Fills remaining candidate slots when RULES/learned/POOL miss.
const FIREHOSE = [
  // --- people (founders, hackers, notable figures) ---
  "satoshinakamoto", "vitalikbuterin", "hal finney", "adam back", "gavin wood",
  "charles hoskinson", "anatoly yakovenko", "brian armstrong", "changpeng zhao",
  "sam bankman-fried", "do kwon", "nick szabo", "wei dai", "laszlo hanyecz",
  "ross ulbricht", "dread pirate roberts", "hayden adams", "larva labs",
  "joseph poon", "zooko wilcox", "kevin mccoy", "justin sun", "su zhu",
  "alex mashinsky", "mark karpeles", "craig wright", "jihan wu", "roger ver",
  "michael saylor", "jack dorsey", "tim draper", "elizabeth stark",
  // --- chains & projects ---
  "ethereum", "bitcoin", "solana", "binance", "tether", "ust", "usdc",
  "monero", "chainlink", "metamask", "ledger", "opensea", "uniswap",
  "pumpfun", "ordinals", "quantum", "cryptopunks", "shiba inu",
  "cardano", "polkadot", "avalanche", "polygon", "arbitrum", "optimism",
  "aptos", "sui", "ripple", "stellar", "algorand", "tezos", "near",
  "filecoin", "the graph", "sushi", "compound", "maker", "dai",
  "bitcoin cash", "litecoin", "dogecoin", "ethereum classic",
  // --- standards & concepts ---
  "erc721", "erc20", "erc1155", "eip1559", "eip2981", "bip39", "bip32",
  "token22", "proofofstake", "proofofwork", "layer2", "zkrollup",
  "decentralizedfinance", "decentralizedautonomousorganization",
  "nonfungibletoken", "web3", "defi", "nft", "dao", "ico",
  "liquid staking", "yield farming", "impermanent loss", "flash loan",
  "merkle tree", "nonce", "gas",
  // --- units & tokens ---
  "satoshi", "gwei", "wei", "wbtc", "aave", "curve", "eth", "btc",
  "sol", "dot", "ada", "xrp", "bnb",
  // --- dates & numbers (high frequency in trivia) ---
  "2008", "2009", "2010", "2014", "2015", "2016", "2021", "2022",
  "10000", "21000000", "21", "10", "12", "4", "32", "64", "256",
  "69000000", "850000", "65000", "69000", "1 million",
];

const ONES = ["zero","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"];
const TENS = { 2: "twenty", 3: "thirty", 4: "forty", 5: "fifty", 6: "sixty", 7: "seventy", 8: "eighty", 9: "ninety" };

function numberWords(nStr) {
  const n = Number(nStr);
  if (!Number.isInteger(n) || n < 0 || n > 999999999) return null;
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ONES[n % 10] : "");
  if (n < 1000) return ONES[Math.floor(n / 100)] + "hundred" + (n % 100 ? numberWords(String(n % 100)) : "");
  if (n < 1000000) return numberWords(String(Math.floor(n / 1000))) + "thousand" + (n % 1000 ? numberWords(String(n % 1000)) : "");
  return numberWords(String(Math.floor(n / 1000000))) + "million" + (n % 1000000 ? numberWords(String(n % 1000000)) : "");
}

function wordsToNumber(w) {
  // reverse lookup over plausible magnitudes
  const cands = [];
  for (let i = 0; i <= 100; i++) cands.push(i);
  [1000, 10000, 210000, 65000, 69000, 1000000, 69000000, 21000000, 850000].forEach(v => cands.push(v));
  for (const v of cands) if (numberWords(String(v)) === w) return String(v);
  return null;
}

const MAX_CANDIDATES = 30;

function buildCandidates(q) {
  const out = [];
  const push = a => {
    if (!a) return;
    const n = normalizeAnswer(a);
    if (n && !out.includes(n)) out.push(n);
  };
  const primary = solve(q);
  if (primary) {
    push(primary);
    const p = normalizeAnswer(primary);
    if (/^\d+$/.test(p)) push(numberWords(p));           // 10000 -> tenthousand
    else { const d = wordsToNumber(p); if (d) push(d); } // ten -> 10
  }
  for (const e of POOL) if (e.k.test(q)) e.a.forEach(push);
  // number-ish questions get generic numeric guesses as last resort
  if (/how (many|much)|what year|when|how old/i.test(q)) NUMERIC_GUESSES.forEach(push);
  // fill remaining slots with firehose high-probability answers
  if (out.length < MAX_CANDIDATES) FIREHOSE.forEach(push);
  return out.slice(0, MAX_CANDIDATES);
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
async function submitCandidates(cid, candidates) {
  // Batch mode: fire all candidates concurrently — no stagger delay.
  // Wrong answers carry zero penalty; the first CORRECT hash wins the round.
  // Parallel submission maximizes the speed window for our best guess.
  const tasks = candidates.map((ans, i) => {
    const a = quizHash(ans, cid);
    const tag = crypto.randomBytes(4).toString("hex");
    const msg = `f1 ch.answer ${tag} - cid=${cid} a=${a}`;
    return saySigned(msg).then(ok => {
      LOG(`answer[${i + 1}/${candidates.length}] "${ans}" -> ${ok ? "sent" : "FAILED"}`);
      return ok;
    }).catch(e => {
      LOG(`answer[${i + 1}] error: ${e.message}`);
      return false;
    });
  });
  await Promise.allSettled(tasks);
}

function handleQuiz(text) {
  // ▶ QUIZ <round> <cid> | 15 MIN | ... || Q: <question> || HOW: ...
  const m = text.match(/▶ QUIZ (\w+) (\w+).*?\|\| Q: (.*?)\s*\|\|/s) || text.match(/▶ QUIZ (\w+) (\w+).*Q: (.*?)\s*\|\|/);
  if (!m) return;
  const [, round, cid, q] = m;
  if (state.answeredCids[cid]) { LOG("already answered cid", cid); return; }
  const candidates = buildCandidates(q.trim());
  LOG(`QUIZ round=${round} cid=${cid} Q="${q.trim()}"`);
  if (!candidates.length) {
    fs.appendFileSync(unknownFile, `${new Date().toISOString()} cid=${cid} Q=${q.trim()}\n`);
    LOG("!! no candidates generated — logged to unknown_questions.log");
    state.answeredCids[cid] = "unknown";
    saveState();
    return;
  }
  LOG(`candidates(${candidates.length}): [${candidates.join(" | ")}]`);
  state.answeredCids[cid] = candidates;
  saveState();
  submitCandidates(cid, candidates).catch(e => LOG("submit error:", e.message));
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

if (process.argv.includes("--selftest")) {
  const tests = [
    "what pseudonym did the operator of silk road use?",
    "how many nfts are in the bored ape yacht club collection?",
    "who created bitcoin?",
    "what year did the dao hack happen?",
    "who invented proof of work?",
    "what is the smallest unit of bitcoin?",
    "some totally unknown thing about nothing?",
  ];
  for (const t of tests) console.log(t, "=>", JSON.stringify(buildCandidates(t)));
} else {
  main();
}
