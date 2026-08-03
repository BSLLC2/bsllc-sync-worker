import "dotenv/config";
import http from "node:http";
import { OAuth2Client } from "google-auth-library";

/**
 * One-time helper: mints a Google Ads refresh token via the OAuth loopback
 * flow, then prints it so you can paste it into .env as GOOGLE_ADS_REFRESH_TOKEN.
 *
 * RUN THIS ON A MACHINE WITH A BROWSER (your laptop), not the headless VPS —
 * it needs to open a Google consent page. The refresh token is portable: mint
 * it anywhere, use it on the VPS. Nothing here is ever transmitted to anyone
 * but Google.
 *
 * Requires GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET from your Desktop
 * OAuth client. Desktop clients permit http://localhost redirects on any port.
 */
const PORT = 4179;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPE = "https://www.googleapis.com/auth/adwords";

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing ${name} in .env`);
  return v.trim();
}

async function main() {
  const clientId = req("GOOGLE_ADS_CLIENT_ID");
  const clientSecret = req("GOOGLE_ADS_CLIENT_SECRET");
  const oauth2 = new OAuth2Client(clientId, clientSecret, REDIRECT_URI);

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline", // required to receive a refresh token
    prompt: "consent", // force a refresh token even on re-auth
    scope: [SCOPE],
  });

  const refreshToken = await new Promise<string>((resolve, reject) => {
    const server = http.createServer(async (rq, rs) => {
      try {
        if (!rq.url || !rq.url.startsWith("/oauth2callback")) {
          rs.writeHead(404).end();
          return;
        }
        const url = new URL(rq.url, REDIRECT_URI);
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        if (error) throw new Error(`Google returned error: ${error}`);
        if (!code) throw new Error("No authorization code in callback");

        const { tokens } = await oauth2.getToken(code);
        rs.writeHead(200, { "content-type": "text/plain" }).end(
          "Refresh token minted. You can close this tab and return to the terminal.",
        );
        server.close();
        if (!tokens.refresh_token) {
          reject(
            new Error(
              "No refresh_token returned. Revoke the app's access at " +
                "https://myaccount.google.com/permissions and run this again " +
                "(a refresh token is only issued on first consent).",
            ),
          );
        } else {
          resolve(tokens.refresh_token);
        }
      } catch (e) {
        server.close();
        reject(e);
      }
    });
    server.listen(PORT, () => {
      console.log("\nOpen this URL in your browser and authorize as the Google");
      console.log("account that has access to the MCC:\n");
      console.log("  " + authUrl + "\n");
      console.log(`Waiting for the callback on ${REDIRECT_URI} ...`);
    });
    server.on("error", reject);
  });

  console.log("\n─────────────────────────────────────────────────────────────");
  console.log("Refresh token (paste into .env as GOOGLE_ADS_REFRESH_TOKEN):\n");
  console.log("  " + refreshToken);
  console.log("─────────────────────────────────────────────────────────────\n");
}

main().catch((err) => {
  console.error("mint-token failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
