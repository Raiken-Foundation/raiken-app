import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findFreePort, staticSpaTarget, waitForHttp } from "../targets";

async function fetchText(url: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = "";
            res.on("data", (chunk) => {
                body += chunk;
            });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        }).on("error", reject);
    });
}

describe("staticSpaTarget", () => {
    let distDir: string;

    beforeEach(() => {
        distDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-eval-dist-"));
        fs.writeFileSync(path.join(distDir, "index.html"), "<html><body>SPA</body></html>");
        fs.mkdirSync(path.join(distDir, "assets"));
        fs.writeFileSync(path.join(distDir, "assets", "app.js"), "console.log(1)");
    });

    afterEach(() => {
        fs.rmSync(distDir, { recursive: true, force: true });
    });

    it("serves files and falls back to index.html for SPA routes", async () => {
        const target = staticSpaTarget({ name: "t", distDir });
        const { baseUrl } = await target.start();
        try {
            const index = await fetchText(`${baseUrl}/`);
            expect(index.body).toContain("SPA");

            const asset = await fetchText(`${baseUrl}/assets/app.js`);
            expect(asset.body).toContain("console.log");

            // History-API fallback: unknown routes render the app shell.
            const deepLink = await fetchText(`${baseUrl}/dashboard/settings`);
            expect(deepLink.status).toBe(200);
            expect(deepLink.body).toContain("SPA");

            // Path traversal stays inside the dist dir.
            const traversal = await fetchText(`${baseUrl}/..%2f..%2fetc%2fpasswd`);
            expect(traversal.body).toContain("SPA");

            const siblingDir = `${distDir}-private`;
            fs.mkdirSync(siblingDir);
            fs.writeFileSync(path.join(siblingDir, "secret.txt"), "DO NOT SERVE");
            try {
                const siblingTraversal = await fetchText(
                    `${baseUrl}/..%2f${path.basename(siblingDir)}%2fsecret.txt`,
                );
                expect(siblingTraversal.body).toContain("SPA");
                expect(siblingTraversal.body).not.toContain("DO NOT SERVE");
            } finally {
                fs.rmSync(siblingDir, { recursive: true, force: true });
            }
        } finally {
            await target.stop();
        }
    });

    it("refuses to start without a built index.html", async () => {
        const target = staticSpaTarget({ name: "t", distDir: path.join(distDir, "missing") });
        await expect(target.start()).rejects.toThrow(/no index\.html/);
    });
});

describe("waitForHttp / findFreePort", () => {
    it("resolves once a server starts answering", async () => {
        const port = await findFreePort();
        const server = http.createServer((_req, res) => res.end("ok"));
        // Start listening only after a short delay so waitForHttp has to poll.
        setTimeout(() => server.listen(port, "127.0.0.1"), 300);
        try {
            await waitForHttp(`http://127.0.0.1:${port}`, 5000);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("times out with a clear error when nothing answers", async () => {
        const port = await findFreePort();
        await expect(waitForHttp(`http://127.0.0.1:${port}`, 600)).rejects.toThrow(
            /did not answer/,
        );
    });
});
