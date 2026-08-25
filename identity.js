// floppy identity — Ed25519 did:key for technocore.chat
// usage: node identity.js          -> load or create identity, print DID
//        node identity.js sign "room|nonce|text" -> print base64url sig
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ID_FILE = path.join(__dirname, "identity.json");

// base58btc (bitcoin alphabet), no checksum
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(buf) {
  let n = BigInt("0x" + buf.toString("hex"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  // leading zero bytes -> '1'
  for (const b of buf) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out;
}

function loadOrCreate() {
  if (fs.existsSync(ID_FILE)) {
    const j = JSON.parse(fs.readFileSync(ID_FILE, "utf8"));
    return {
      did: j.did,
      priv: crypto.createPrivateKey({ key: j.privPem, format: "pem" }),
      pub: crypto.createPublicKey({ key: j.pubPem, format: "pem" }),
    };
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(-32); // last 32 bytes = raw key
  const multicodec = Buffer.concat([Buffer.from([0xed, 0x01]), rawPub]);
  const did = "did:key:z" + base58(multicodec);
  const j = {
    did,
    created: new Date().toISOString(),
    privPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    pubPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  fs.writeFileSync(ID_FILE, JSON.stringify(j, null, 2), { mode: 0o600 });
  return {
    did,
    priv: privateKey,
    pub: publicKey,
  };
}

function b64url(buf) {
  return buf.toString("base64url");
}

function signString(priv, s) {
  return b64url(crypto.sign(null, Buffer.from(s, "utf8"), priv));
}

if (require.main === module) {
  const id = loadOrCreate();
  const cmd = process.argv[2];
  if (cmd === "sign") {
    const payload = process.argv[3];
    if (!payload) {
      console.error("usage: node identity.js sign '<room>|<nonce>|<text>'");
      process.exit(1);
    }
    console.log(signString(id.priv, payload));
  } else {
    console.log(id.did);
  }
}

module.exports = { loadOrCreate, signString, base58 };
