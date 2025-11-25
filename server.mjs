import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// ---------- OpenAI client (for AI risk analysis) ----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ---------- CA extraction + suffix rule (must end in doge or DUB) ----------

/**
 * Try to find a token address (EVM or Solana-style) in the given text.
 * If found, enforce suffix rule:
 *   - address must end with "doge" (any case) OR "DUB" (any case).
 * Returns { address, chainIdGuess } or null.
 */
function extractTokenAddressWithSuffix(raw) {
  if (!raw) return null;
  const text = String(raw).trim();

  // EVM: 0x + 40 hex
  const evmMatch = text.match(/0x[a-fA-F0-9]{40}/);
  if (evmMatch) {
    const addr = evmMatch[0];
    if (isAllowedSuffix(addr)) {
      return { address: addr, chainIdGuess: "ethereum" };
    }
  }

  // Solana Base58 addresses (32–44 chars)
  const solMatch = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  if (solMatch) {
    const addr = solMatch[0];
    if (isAllowedSuffix(addr)) {
      return { address: addr, chainIdGuess: "solana" };
    }
  }

  return null;
}

/**
 * Allowed suffix rule:
 * - End with "doge" (case-insensitive) OR
 * - End with "DUB" (case-insensitive).
 */
function isAllowedSuffix(address) {
  const lower = address.toLowerCase();
  const upper = address.toUpperCase();
  if (lower.endsWith("doge")) return true;
  if (upper.endsWith("DUB")) return true;
  return false;
}

// ---------- AI risk analysis ----------

async function generateRiskAnalysis(data) {
  if (!openai) {
    return {
      riskLevel: "unknown",
      text: "AI risk analysis not available (missing OPENAI_API_KEY)."
    };
  }

  const systemPrompt = `
You are DogeOS Agent, a meme-powered cyber-intel dog specialized in token risk analysis.
Your task: evaluate potential scam / honeypot risk for a token based ONLY on provided data.

Rules:
- You MUST NOT give financial advice.
- Do NOT recommend buying, selling, holding, or profiting.
- Do NOT mention price targets or gains.
- Focus ONLY on risk, safety, and red flags.
- Be concise but clear.
- Always end with a caution line like "Intel only, no financial advice."

Output format (exactly):
RISK_LEVEL: Low | Medium | High | Unknown

Then a blank line, then:
- Key red flags (bullet list)
- Positive signals (bullet list, if any)
- Honeypot likelihood (qualitative only, never 100%)
- Final caution note.

Keep slightly Doge-flavored tone but readable.
`.trim();

  const userPayload = {
    tokenName: data.name,
    symbol: data.symbol,
    chainId: data.chainId,
    address: data.tokenAddress,
    priceUsd: data.priceUsd,
    volume24h: data.volume24h,
    liquidityUsd: data.liquidityUsd,
    marketCap: data.marketCap,
    fdv: data.fdv,
    holders: data.holders,
    primaryWebsite: data.primaryWebsite,
    telegram: data.telegram,
    description: data.description
  };

  const userMessage =
    "Analyze the scam / honeypot risk for this token. Here is the data (JSON):\n\n" +
    JSON.stringify(userPayload, null, 2);

  const resp = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.4,
    max_tokens: 500,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage }
    ]
  });

  const text = resp.choices?.[0]?.message?.content?.trim() || "";
  let riskLevel = "unknown";
  const firstLine = text.split("\n")[0] || "";
  const m = firstLine.match(/RISK_LEVEL:\s*(.+)$/i);
  if (m?.[1]) {
    riskLevel = m[1].trim().toLowerCase();
  }

  return { riskLevel, text };
}

// ---------- Main API: analyze contract address ----------

app.post("/api/analyze-anoncoin", async (req, res) => {
  try {
    const input = (req.body?.input || "").trim();
    if (!input) {
      return res.status(400).json({
        error: "Missing input. Paste a contract address ending in 'doge' or 'DUB'."
      });
    }

    // Only contract addresses, with suffix rule
    const addrInfo = extractTokenAddressWithSuffix(input);
    if (!addrInfo) {
      return res.status(400).json({
        error:
          "Invalid contract. Only CAs that look valid and end in 'doge' or 'DUB' are accepted."
      });
    }

    const tokenAddress = addrInfo.address;
    const chainId = addrInfo.chainIdGuess || "solana";

    console.log("[analyze] Token:", tokenAddress, "Chain:", chainId);

    // -------- Dexscreener Request --------
    const dsUrl = `https://api.dexscreener.com/tokens/v1/${chainId}/${tokenAddress}`;
    const dsResp = await fetch(dsUrl, { headers: { Accept: "application/json" } });

    if (!dsResp.ok) {
      return res.status(502).json({ error: "Dexscreener API failed." });
    }

    const dsJson = await dsResp.json();
    if (!Array.isArray(dsJson) || dsJson.length === 0) {
      return res
        .status(404)
        .json({ error: "No pool data found for this token." });
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

    let telegram = socials.find((s) =>
      (s.platform || "").toLowerCase().includes("telegram")
    );
    telegram = telegram?.handle || telegram?.url || null;

    // -------- Holders (Solana only) --------
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
      } catch (e) {
        console.warn("Holders fetch failed:", e);
      }
    }

    const primaryWebsite = websites.find((w) => w.url)?.url || "No website";
    const description = null; // no launchpad description now

    // -------- DogeOS Intel Summary (on-chain only) --------
    const summary = [
      `=== DogeOS CA Intel ===`,
      `Contract: ${tokenAddress}`,
      `Detected chain: ${chainId}`,
      ``,
      `Token Meta:`,
      `- Name: ${name}`,
      `- Symbol: ${symbol}`,
      ``,
      `Market Data:`,
      `- Price (USD): ${priceUsd || "?"}`,
      `- Volume (24h): ${volume24h || "?"}`,
      `- Liquidity (USD): ${liquidityUsd || "?"}`,
      `- MarketCap: ${marketCap || "?"}`,
      `- FDV: ${fdv || "?"}`,
      `- Holders: ${holders || "?"}`,
      ``,
      `Links:`,
      `- Website: ${primaryWebsite}`,
      `- Telegram: ${telegram || "not listed"}`,
      `- Dexscreener: ${dexscreenerUrl || "not provided"}`,
      ``,
      `Note: Only contract addresses ending in 'doge' or 'DUB' are scanned by this console.`
    ]
      .filter(Boolean)
      .join("\n");

    // -------- AI Risk Brief --------
    let aiRiskLevel = "unknown";
    let aiRiskText =
      "AI risk analysis unavailable. Configure OPENAI_API_KEY on the server to enable DogeOS risk brief.";

    try {
      const riskInput = {
        name,
        symbol,
        chainId,
        tokenAddress,
        priceUsd,
        volume24h,
        liquidityUsd,
        marketCap,
        fdv,
        holders,
        primaryWebsite,
        telegram,
        description
      };

      const riskRes = await generateRiskAnalysis(riskInput);
      aiRiskLevel = riskRes.riskLevel;
      aiRiskText = riskRes.text;
    } catch (e) {
      console.warn("AI risk analysis failed:", e);
    }

    return res.json({
      ok: true,
      summary,
      aiRisk: aiRiskText,
      aiRiskLevel: aiRiskLevel
    });
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
  console.log(`DogeOS CA scanner running on port ${PORT}`);
});
