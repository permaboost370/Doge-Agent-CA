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

// Config
const PORT = process.env.PORT || 3000;
const BOT_PERSONA_NAME = process.env.BOT_PERSONA_NAME || "DogeOS Agent";

// ---------- Helpers ----------

function isAnoncoinUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.hostname === "anoncoin.it" || u.hostname.endsWith(".anoncoin.it");
  } catch {
    return false;
  }
}

function extractTokenAddressFromHtml(html) {
  if (!html) return null;

  // Try EVM first: 0x + 40 hex chars
  const evmMatch = html.match(/0x[a-fA-F0-9]{40}/);
  if (evmMatch) {
    return {
      address: evmMatch[0],
      chainIdGuess: "ethereum"
    };
  }

  // Try Solana-style base58 (common for launchpads)
  const solMatch = html.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  if (solMatch) {
    return {
      address: solMatch[0],
      chainIdGuess: "solana"
    };
  }

  return null;
}

function extractDescriptionFromHtml(html) {
  if (!html) return null;

  // Try meta description
  const metaDescMatch = html.match(
    /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i
  );
  if (metaDescMatch && metaDescMatch[1]) {
    return metaDescMatch[1].trim();
  }

  // Try og:description
  const ogDescMatch = html.match(
    /<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i
  );
  if (ogDescMatch && ogDescMatch[1]) {
    return ogDescMatch[1].trim();
  }

  // Fallback: try to grab some text around "Description" label
  const blockMatch = html.match(/Description[^<]{0,300}/i);
  if (blockMatch) {
    return blockMatch[0].replace(/Description[:\s-]*/i, "").trim();
  }

  return null;
}

// ---------- Token analysis route ----------

app.post("/api/analyze-anoncoin", async (req, res) => {
  try {
    const rawUrl = (req.body?.url || "").toString().trim();

    if (!rawUrl) {
      return res.status(400).json({ error: "Missing URL." });
    }

    if (!isAnoncoinUrl(rawUrl)) {
      return res.status(400).json({
        error: "Only anoncoin.it URLs are allowed for this scanner."
      });
    }

    console.log("[analyze] Fetching Anoncoin page:", rawUrl);

    // Fetch launchpad page
    const pageResp = await fetch(rawUrl, { headers: { Accept: "text/html" } });
    if (!pageResp.ok) {
      const t = await pageResp.text().catch(() => "");
      console.error("Anoncoin fetch error:", pageResp.status, t.slice(0, 200));
      return res.status(502).json({
        error: "Failed to fetch Anoncoin page."
      });
    }
    const html = await pageResp.text();

    // Extract token address from HTML
    const addrInfo = extractTokenAddressFromHtml(html);
    if (!addrInfo) {
      return res.status(404).json({
        error: "Could not detect a token contract address on this Anoncoin page."
      });
    }

    const tokenAddress = addrInfo.address;
    // Best guess: use solana for Anoncoin; if you know it’s EVM, change this to "ethereum"
    const chainId = addrInfo.chainIdGuess || "solana";

    console.log(`[analyze] Found token address: ${tokenAddress} (chain guess: ${chainId})`);

    // Extract human description from the page
    const description = extractDescriptionFromHtml(html);

    // 1) Dexscreener: /tokens/v1/{chainId}/{tokenAddress}
    const dsUrl = `https://api.dexscreener.com/tokens/v1/${encodeURIComponent(
      chainId
    )}/${encodeURIComponent(tokenAddress)}`;

    const dsResp = await fetch(dsUrl, {
      headers: { Accept: "application/json" }
    });

    if (!dsResp.ok) {
      const txt = await dsResp.text().catch(() => "");
      console.error("Dexscreener error:", dsResp.status, txt.slice(0, 200));
      return res.status(502).json({
        error: "Failed to fetch DEX data for this token."
      });
    }

    const dsJson = await dsResp.json();

    if (!Array.isArray(dsJson) || dsJson.length === 0) {
      return res.status(404).json({
        error: "No DEX pairs found for this token (maybe not yet live).",
        tokenAddress,
        chainId
      });
    }

    // Pick pair with highest liquidity
    const bestPair = dsJson.reduce((best, p) => {
      if (!best) return p;
      const curLiq = (p.liquidity && p.liquidity.usd) || 0;
      const bestLiq = (best.liquidity && best.liquidity.usd) || 0;
      return curLiq > bestLiq ? p : best;
    }, null);

    const base = bestPair.baseToken || {};
    const info = bestPair.info || {};
    const volume = bestPair.volume || {};
    const priceChange = bestPair.priceChange || {};

    const name = base.name || "Unknown";
    const symbol = base.symbol || "?";
    const priceUsd = bestPair.priceUsd || null;
    const priceNative = bestPair.priceNative || null;
    const volume24h = volume.h24 || null;
    const liquidityUsd = bestPair.liquidity?.usd || null;
    const fdv = bestPair.fdv || null;
    const marketCap = bestPair.marketCap || null;
    const websites = info.websites || [];
    const socials = info.socials || [];
    const dexscreenerUrl = bestPair.url;

    // Pull Telegram handle if Dexscreener has it
    let telegram = null;
    for (const s of socials) {
      if (!s || !s.platform) continue;
      if (s.platform.toLowerCase().includes("telegram")) {
        telegram = s.handle || s.url || null;
        break;
      }
    }

    // 2) Holders (Solana example via Solscan; adjust if different chain)
    let holders = null;
    if (chainId === "solana") {
      try {
        const solscanUrl = `https://public-api.solscan.io/token/holders?tokenAddress=${encodeURIComponent(
          tokenAddress
        )}&limit=1&offset=0`;

        const hResp = await fetch(solscanUrl, {
          headers: { accept: "application/json" }
        });

        if (hResp.ok) {
          const hJson = await hResp.json();
          holders = hJson.total ?? hJson.data?.total ?? null;
        } else {
          console.warn("Solscan holders request failed:", hResp.status);
        }
      } catch (e) {
        console.warn("Error fetching holders:", e);
      }
    }

    // Lore-styled DogeOS summary (no emojis)
    const primaryWebsite =
      websites.find((w) => w.url)?.url || "no website listed";
    const tgLine = telegram
      ? `Intel channel (Telegram): ${telegram}`
      : "Intel channel (Telegram): none detected";

    const descSnippet = description
      ? `Anoncoin description snippet: ${description.slice(0, 240)}${
          description.length > 240 ? "..." : ""
        }`
      : "No clear description found on Anoncoin page.";

    const summaryLines = [
      `Such token brief, operative.`,
      `Name: ${name} (${symbol}) on ${chainId}.`,
      `Contract: ${tokenAddress}`,
      ``,
      `Market intel:`,
      `- Price (USD): ${priceUsd ?? "unknown"}`,
      `- 24h volume: ${volume24h ?? "unknown"}`,
      `- Liquidity (USD): ${liquidityUsd ?? "unknown"}`,
      `- FDV: ${fdv ?? "unknown"}`,
      `- Market cap: ${marketCap ?? "unknown"}`,
      `- Holders (approx): ${holders ?? "unknown"}`,
      ``,
      `Links:`,
      `- Primary website: ${primaryWebsite}`,
      `- ${tgLine}`,
      `- Dexscreener scan: ${dexscreenerUrl || "not available"}`,
      ``,
      descSnippet,
      ``,
      `Such intel only, no financial advice. Very analysis, much caution.`
    ];

    const summary = summaryLines.join("\n");

    return res.json({
      ok: true,
      chainId,
      tokenAddress,
      name,
      symbol,
      priceUsd,
      priceNative,
      volume: {
        h24: volume24h,
        m5: volume.m5,
        h1: volume.h1,
        h6: volume.h6
      },
      priceChange,
      liquidityUsd,
      fdv,
      marketCap,
      holders,
      websites,
      socials,
      telegram,
      dexscreenerUrl,
      description,
      summary
    });
  } catch (err) {
    console.error("Token analysis error:", err);
    return res.status(500).json({ error: "Failed to analyze token." });
  }
});

// ---------- Frontend ----------

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Anoncoin DogeOS scanner listening on port ${PORT}`);
});
