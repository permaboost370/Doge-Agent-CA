import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// ---------- URL Checker (only allow https://anoncoin.it/<token>) ----------
function isValidAnoncoinUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return (
      u.protocol === "https:" &&
      u.hostname === "anoncoin.it" &&
      u.pathname.split("/").filter(Boolean).length === 1 // only one segment like /SHIBA2, no /board/...
    );
  } catch {
    return false;
  }
}

// ---------- Extract token address from HTML or pasted text ----------
function extractTokenAddress(raw) {
  if (!raw) return null;

  // EVM: 0x + 40 hex
  const evmMatch = raw.match(/0x[a-fA-F0-9]{40}/);
  if (evmMatch) return { address: evmMatch[0], chainIdGuess: "ethereum" };

  // Solana Base58 addresses (32–44 chars)
  const solMatch = raw.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  if (solMatch) return { address: solMatch[0], chainIdGuess: "solana" };

  return null;
}

// ---------- Get description from Anoncoin page ----------
function extractDescriptionFromHtml(html) {
  if (!html) return null;
  
  // Try meta description
  const meta = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
  if (meta?.[1]) return meta[1].trim();

  // Try "Description" text block
  const block = html.match(/Description[^<]{0,300}/i);
  if (block) return block[0].replace(/Description[:\s-]*/i, "").trim();

  return null;
}

// ---------- Main API ----------
app.post("/api/analyze-anoncoin", async (req, res) => {
  try {
    const input = (req.body?.input || "").trim();
    if (!input) {
      return res.status(400).json({ error: "Missing input: URL or contract." });
    }

    let tokenAddress = null;
    let chainId = "solana";
    let description = null;
    let sourceType = null;
    let anoncoinUrl = null;

    // Case 1: it's a valid anoncoin.it/token URL
    if (isValidAnoncoinUrl(input)) {
      sourceType = "anoncoin-url";
      anoncoinUrl = input;

      console.log("[analyze] Fetching page:", anoncoinUrl);
      const pageResp = await fetch(anoncoinUrl, { headers: { Accept: "text/html" } });
      if (!pageResp.ok) {
        return res.status(502).json({ error: "Failed to fetch Anoncoin page." });
      }

      const html = await pageResp.text();
      const addrInfo = extractTokenAddress(html);
      if (!addrInfo) {
        return res.status(404).json({ error: "No token address found on this page." });
      }

      tokenAddress = addrInfo.address;
      chainId = addrInfo.chainIdGuess;
      description = extractDescriptionFromHtml(html);
    } 
    // Case 2: direct contract address
    else {
      const addrInfo = extractTokenAddress(input);
      if (!addrInfo) {
        return res.status(400).json({
          error: "Invalid input. Must be anoncoin.it/<token> URL OR contract address."
        });
      }
      tokenAddress = addrInfo.address;
      chainId = addrInfo.chainIdGuess;
      sourceType = "address";
    }

    console.log("[analyze] Token:", tokenAddress, "Chain:", chainId);

    // -------- Dexscreener Request --------
    const dsUrl = `https://api.dexscreener.com/tokens/v1/${chainId}/${tokenAddress}`;
    const dsResp = await fetch(dsUrl, { headers: { Accept: "application/json" } });

    if (!dsResp.ok) {
      return res.status(502).json({ error: "Dexscreener API failed." });
    }

    const dsJson = await dsResp.json();
    if (!Array.isArray(dsJson) || dsJson.length === 0) {
      return res.status(404).json({ error: "No pool data found for this token." });
    }

    const bestPair = dsJson.reduce((best, p) => {
      const liq = p.liquidity?.usd || 0;
      return liq > (best?.liquidity?.usd || 0) ? p : best;
    }, null);

    const name = bestPair.baseToken?.name || "Unknown";
    const symbol = bestPair.baseToken?.symbol || "?";
    const priceUsd = bestPair.priceUsd || null;
    const volume24h = bestPair.volume?.h24 || null;
    const liquidityUsd = bestPair.liquidity?.usd || null;
    const fdv = bestPair.fdv || null;
    const marketCap = bestPair.marketCap || null;
    const websites = bestPair.info?.websites || [];
    const socials = bestPair.info?.socials || [];
    const dexscreenerUrl = bestPair.url;

    let telegram = socials.find(s => (s.platform || "").toLowerCase().includes("telegram"));
    telegram = telegram?.handle || telegram?.url || null;

    // -------- Fetch Holders (Solana only) --------
    let holders = null;
    if (chainId === "solana") {
      try {
        const hRes = await fetch(
          `https://public-api.solscan.io/token/holders?tokenAddress=${tokenAddress}&limit=1`
        );
        if (hRes.ok) {
          const hJson = await hRes.json();
          holders = hJson.total || null;
        }
      } catch {}
    }

    // -------- DogeOS Lore-style Report Text --------
    const primaryWebsite = websites.find(w => w.url)?.url || "No website";
    const descText = description
      ? description.slice(0, 240) + (description.length > 240 ? "..." : "")
      : "No description detected.";
      
    const summary = [
      `Such Anoncoin intel, operative.`,
      `Token: ${name} (${symbol})`,
      `Chain: ${chainId}`,
      `Address: ${tokenAddress}`,
      ``,
      `Market Signals:`,
      `- Price: ${priceUsd || "?"} USD`,
      `- Volume (24h): ${volume24h || "?"}`,
      `- Liquidity: ${liquidityUsd || "?"} USD`,
      `- MarketCap: ${marketCap || "?"}`,
      `- FDV: ${fdv || "?"}`,
      `- Holders: ${holders || "?"}`,
      ``,
      `Intel Links:`,
      `- Website: ${primaryWebsite}`,
      `- Telegram: ${telegram || "not listed"}`,
      `- Dexscreener: ${dexscreenerUrl || "not provided"}`,
      anoncoinUrl ? `- Anoncoin Page: ${anoncoinUrl}` : null,
      ``,
      `Anoncoin Description:`,
      descText,
      ``,
      `Intel only. No financial advice.`
    ]
      .filter(Boolean)
      .join("\n");

    return res.json({ ok: true, summary });
  } catch (err) {
    console.error("Error:", err);
    return res.status(500).json({ error: "Server failed to process request." });
  }
});

// ---------- Frontend ----------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Anoncoin Scanner running on ${PORT}`);
});
