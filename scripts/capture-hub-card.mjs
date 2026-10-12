/**
 * Capture SuperSun hub card at native iPhone 3× (390×844 → 1170×2532).
 * Source: local HTTPS preview. Crops nothing — app already owns safe areas.
 */
import { createRequire } from "module";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const HUB_IMG = "/Users/Mark/markmaga-hub/images/ss-supersun.webp";
const URL = "https://127.0.0.1:8915/";
const require = createRequire("/Users/Mark/markmaga-hub/package.json");
const puppeteer = require("puppeteer-core");

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Users/Mark/.cache/puppeteer/chrome/mac-149.0.7827.22/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((c) => existsSync(c));

async function main() {
  if (!CHROME) throw new Error("Chrome not found");
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    ignoreHTTPSErrors: true,
    args: [
      "--ignore-certificate-errors",
      "--hide-scrollbars",
      "--disable-http2",
      "--disable-features=HttpsUpgrades",
      "--use-gl=angle",
      "--enable-webgl",
    ],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    // networkidle never settles — Carrington frames keep fetching.
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(
      () => document.getElementById("sun-canvas")?.classList.contains("is-ready"),
      { timeout: 90000 }
    );
    // Park on a strong mid-loop face; stop Orbit so the card is sharp.
    await page.evaluate(async () => {
      const g = window.__sunGlobe;
      if (!g) return;
      if (g.isOrbiting?.()) g.setOrbiting(false);
      g.resetView?.();
      // Stay on a frame already in the Orbit buffer — jumping to 0.42
      // waits on a plate that has not been fetched yet.
      if (typeof g.setCyclePhase === "function") {
        g.setCyclePhase(0.12, { paint: true });
      }
    });
    await page.waitForFunction(
      () => window.__sunGlobe?.isParkedFramePainted?.() === true,
      { timeout: 20000 }
    ).catch(() => {});
    await new Promise((r) => setTimeout(r, 800));

    const pngPath = path.join(ROOT, ".hub-card-raw.png");
    await page.screenshot({ path: pngPath, type: "png" });

    // Verify native size, then write WebP lossless-ish quality.
    const { stdout } = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", pngPath]);
    const w = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);
    const h = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
    if (w < 1000 || h < 2000) {
      throw new Error(`hub card too small: ${w}×${h} (need ≥1000 wide, ~2532 tall)`);
    }
    if (w !== 1170 || h !== 2532) {
      console.warn(`size ${w}×${h} — expected 1170×2532; keeping native pixels`);
    }

    // cwebp if present; else Pillow via python.
    try {
      await execFileAsync("cwebp", ["-q", "90", pngPath, "-o", HUB_IMG]);
    } catch {
      const py = [
        "from PIL import Image",
        `im=Image.open(${JSON.stringify(pngPath)}).convert("RGB")`,
        `im.save(${JSON.stringify(HUB_IMG)}, "WEBP", quality=90, method=6)`,
        "print(im.size)",
      ].join(";");
      await execFileAsync("python3", ["-c", py]);
    }
    console.log("wrote", HUB_IMG, `${w}×${h}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
