/**
 * Write a detailed, shareable test-run report — including screenshots — from a
 * parsed Playwright run.
 *
 * Produces up to three artifacts under `test-reports/`:
 *   - `report-<ts>.html`  self-contained (screenshots embedded as data URIs),
 *                         videos/traces linked by relative path.
 *   - `report-<ts>.md`    Markdown summary (screenshots referenced by path).
 *   - `report-<ts>.json`  machine-readable parsed run + metadata.
 *
 * A `latest.<ext>` copy of each written format is also refreshed for easy access.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
    ParsedPlaywrightRun,
    ReportAttachment,
    ReportSummary,
    ReportTestCase,
} from "./report-parser";

export type ReportFormat = "html" | "markdown" | "json";

export interface WriteReportOptions {
    projectPath: string;
    run: ParsedPlaywrightRun;
    /** Raw Playwright stdout, appended to the report for debugging. */
    rawOutput?: string;
    /** The spec file this run targeted, if a single file. */
    testFile?: string;
    /** Report heading. Default: "Raiken Test Report". */
    title?: string;
    /** Which artifacts to write. Default: ["html"]. */
    formats?: ReportFormat[];
    /** Output directory, relative to projectPath. Default: "test-reports". */
    outputDir?: string;
    /** Embed screenshots inline in HTML (self-contained). Default: true. */
    embedScreenshots?: boolean;
}

export interface WrittenReport {
    outputDir: string;
    files: string[];
    /** The HTML report path, if written — the most useful to open. */
    htmlPath?: string;
    screenshotsEmbedded: number;
    summary: ReportSummary;
}

// Keep the HTML from ballooning: cap per-image and total embedded bytes.
const MAX_EMBED_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_EMBED_TOTAL_BYTES = 40 * 1024 * 1024;

const isImage = (att: ReportAttachment): boolean =>
    /^image\//.test(att.contentType) || /\.(png|jpe?g|webp|gif)$/i.test(att.name || att.path || "");
const isVideo = (att: ReportAttachment): boolean =>
    /^video\//.test(att.contentType) || /\.(webm|mp4)$/i.test(att.name || att.path || "");
const isTrace = (att: ReportAttachment): boolean =>
    att.name === "trace" || /\.zip$/i.test(att.path || "");

export async function writeTestRunReport(options: WriteReportOptions): Promise<WrittenReport> {
    const projectPath = path.resolve(options.projectPath);
    const outDirRel = options.outputDir ?? "test-reports";
    const outDir = path.resolve(projectPath, outDirRel);
    const formats = options.formats?.length ? options.formats : (["html"] as ReportFormat[]);
    const title = options.title ?? "Raiken Test Report";
    const embed = options.embedScreenshots !== false;

    await fs.promises.mkdir(outDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const files: string[] = [];
    let htmlPath: string | undefined;
    let screenshotsEmbedded = 0;

    // Resolve a screenshot to an inline data URI (bounded), else null.
    let embeddedTotal = 0;
    const toDataUri = async (att: ReportAttachment): Promise<string | null> => {
        try {
            if (att.body) {
                // Playwright inlined it already (base64).
                return `data:${att.contentType || "image/png"};base64,${att.body}`;
            }
            if (!att.path) return null;
            const resolved = path.resolve(projectPath, att.path);
            // Path-traversal guard: only read artifacts under the project root.
            if (resolved !== projectPath && !resolved.startsWith(projectPath + path.sep)) {
                return null;
            }
            const stat = await fs.promises.stat(resolved).catch(() => null);
            if (!stat || !stat.isFile() || stat.size > MAX_EMBED_IMAGE_BYTES) return null;
            if (embeddedTotal + stat.size > MAX_EMBED_TOTAL_BYTES) return null;
            const buf = await fs.promises.readFile(resolved);
            embeddedTotal += stat.size;
            const mime = att.contentType || guessImageMime(resolved);
            return `data:${mime};base64,${buf.toString("base64")}`;
        } catch {
            return null;
        }
    };

    if (formats.includes("html")) {
        const { html, embedded } = await renderHtml({
            title,
            run: options.run,
            rawOutput: options.rawOutput,
            testFile: options.testFile,
            outDir,
            projectPath,
            embed,
            toDataUri,
        });
        screenshotsEmbedded = embedded;
        const p = path.join(outDir, `report-${stamp}.html`);
        await fs.promises.writeFile(p, html, "utf-8");
        await fs.promises.writeFile(path.join(outDir, "latest.html"), html, "utf-8");
        files.push(p);
        htmlPath = p;
    }

    if (formats.includes("markdown")) {
        const md = renderMarkdown({
            title,
            run: options.run,
            testFile: options.testFile,
            outDir,
            projectPath,
        });
        const p = path.join(outDir, `report-${stamp}.md`);
        await fs.promises.writeFile(p, md, "utf-8");
        await fs.promises.writeFile(path.join(outDir, "latest.md"), md, "utf-8");
        files.push(p);
    }

    if (formats.includes("json")) {
        const payload = JSON.stringify(
            {
                schemaVersion: 1,
                generatedAt: new Date().toISOString(),
                title,
                testFile: options.testFile ?? null,
                summary: options.run.summary,
                tests: options.run.tests,
            },
            null,
            2,
        );
        const p = path.join(outDir, `report-${stamp}.json`);
        await fs.promises.writeFile(p, payload, "utf-8");
        await fs.promises.writeFile(path.join(outDir, "latest.json"), payload, "utf-8");
        files.push(p);
    }

    return {
        outputDir: outDir,
        files,
        htmlPath,
        screenshotsEmbedded,
        summary: options.run.summary,
    };
}

function guessImageMime(p: string): string {
    const ext = path.extname(p).toLowerCase();
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".webp") return "image/webp";
    if (ext === ".gif") return "image/gif";
    return "image/png";
}

// Playwright embeds ANSI SGR color codes in error messages/snippets even with
// FORCE_COLOR=0; strip them so reports read cleanly. The ESC (\u001b) prefix is
// sometimes lost in transit (leaving orphaned "[22m"/"[39m"), so match it
// optionally — requiring at least one digit keeps false positives negligible.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching ANSI escapes
const ANSI_RE = /\u001b?\[[0-9;]+m/g;
function stripAnsi(s: string | undefined): string {
    return (s ?? "").replace(ANSI_RE, "");
}

function esc(s: string | undefined): string {
    return stripAnsi(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function fmtDuration(ms?: number): string {
    if (ms === undefined) return "—";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

function groupBySuite(tests: ReportTestCase[]): Map<string, ReportTestCase[]> {
    const map = new Map<string, ReportTestCase[]>();
    for (const t of tests) {
        const arr = map.get(t.suite) ?? [];
        arr.push(t);
        map.set(t.suite, arr);
    }
    return map;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

async function renderHtml(args: {
    title: string;
    run: ParsedPlaywrightRun;
    rawOutput?: string;
    testFile?: string;
    outDir: string;
    projectPath: string;
    embed: boolean;
    toDataUri: (att: ReportAttachment) => Promise<string | null>;
}): Promise<{ html: string; embedded: number }> {
    const { run, outDir } = args;
    const { tests, summary } = run;
    let embedded = 0;

    const passed = summary.tests.passed;
    const failed = summary.tests.failed;
    const total = summary.tests.total || tests.length;
    const skipped = Math.max(0, total - passed - failed);
    const passPct = total > 0 ? Math.round((passed / total) * 100) : 0;

    const suiteBlocks: string[] = [];
    for (const [suite, cases] of groupBySuite(tests)) {
        const rows: string[] = [];
        for (const t of cases) {
            const badge =
                t.status === "passed"
                    ? `<span class="badge pass">PASS</span>`
                    : t.status === "failed"
                      ? `<span class="badge fail">FAIL</span>`
                      : `<span class="badge skip">SKIP</span>`;

            let details = "";
            if (t.error) {
                const loc = t.error.location
                    ? `<div class="loc">${esc(t.error.location.file)}:${t.error.location.line}</div>`
                    : "";
                details += `<div class="error">${loc}<pre>${esc(t.error.message)}</pre>${
                    t.error.snippet ? `<pre class="snippet">${esc(t.error.snippet)}</pre>` : ""
                }</div>`;
            }

            const shots: string[] = [];
            const links: string[] = [];
            for (const att of t.attachments ?? []) {
                if (isImage(att) && args.embed) {
                    const uri = await args.toDataUri(att);
                    if (uri) {
                        embedded++;
                        shots.push(
                            `<figure><img loading="lazy" src="${uri}" alt="${esc(att.name)}"/><figcaption>${esc(att.name)}</figcaption></figure>`,
                        );
                        continue;
                    }
                }
                if (att.path) {
                    const rel = path.relative(outDir, path.resolve(args.projectPath, att.path));
                    const kind = isVideo(att) ? "video" : isTrace(att) ? "trace" : att.name || "file";
                    links.push(`<a href="${esc(rel)}">${esc(kind)}</a>`);
                }
            }
            if (shots.length > 0) details += `<div class="shots">${shots.join("")}</div>`;
            if (links.length > 0) details += `<div class="links">Artifacts: ${links.join(" · ")}</div>`;

            rows.push(
                `<div class="test ${t.status}"><div class="test-head">${badge}<span class="tname">${esc(
                    t.name,
                )}</span><span class="tdur">${fmtDuration(t.duration)}</span></div>${details}</div>`,
            );
        }
        suiteBlocks.push(`<section class="suite"><h2>${esc(suite)}</h2>${rows.join("")}</section>`);
    }

    const rawBlock = args.rawOutput
        ? `<details class="raw"><summary>Raw Playwright output</summary><pre>${esc(
              args.rawOutput.slice(-20000),
          )}</pre></details>`
        : "";

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(args.title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#0b0f14; --card:#131a22; --fg:#e6edf3; --muted:#8b99a6;
    --pass:#2ea043; --fail:#f85149; --skip:#9e6a03; --line:#20293380; --accent:#2f81f7; }
  @media (prefers-color-scheme: light){ :root{ --bg:#f6f8fa; --card:#fff; --fg:#1f2328; --muted:#59636e; --line:#d0d7de; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width:980px; margin:0 auto; padding:32px 20px 80px; }
  header h1 { margin:0 0 4px; font-size:22px; }
  .meta { color:var(--muted); font-size:13px; margin-bottom:20px; }
  .cards { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:16px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .stat .n { font-size:24px; font-weight:700; }
  .stat .l { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .stat.pass .n { color:var(--pass); } .stat.fail .n { color:var(--fail); } .stat.skip .n { color:var(--skip); }
  .bar { height:8px; border-radius:99px; background:var(--fail); overflow:hidden; margin-bottom:28px; border:1px solid var(--line); }
  .bar > i { display:block; height:100%; width:${passPct}%; background:var(--pass); }
  .suite { margin-bottom:26px; }
  .suite h2 { font-size:15px; margin:0 0 10px; padding-bottom:6px; border-bottom:1px solid var(--line); color:var(--muted); }
  .test { background:var(--card); border:1px solid var(--line); border-left-width:4px; border-radius:8px; padding:12px 14px; margin-bottom:8px; }
  .test.passed { border-left-color:var(--pass); } .test.failed { border-left-color:var(--fail); } .test.skipped { border-left-color:var(--skip); }
  .test-head { display:flex; align-items:center; gap:10px; }
  .tname { flex:1; font-weight:600; } .tdur { color:var(--muted); font-variant-numeric:tabular-nums; }
  .badge { font-size:11px; font-weight:700; padding:2px 7px; border-radius:5px; letter-spacing:.03em; }
  .badge.pass { background:#2ea04322; color:var(--pass); } .badge.fail { background:#f8514922; color:var(--fail); } .badge.skip { background:#9e6a0322; color:var(--skip); }
  .error { margin-top:10px; }
  .error .loc { color:var(--muted); font-size:12px; margin-bottom:4px; }
  pre { background:#00000022; border:1px solid var(--line); border-radius:6px; padding:10px 12px; overflow:auto; font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; word-break:break-word; margin:0 0 8px; }
  pre.snippet { color:var(--muted); }
  .shots { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:10px; margin-top:10px; }
  figure { margin:0; } figure img { width:100%; border:1px solid var(--line); border-radius:6px; cursor:zoom-in; display:block; }
  figcaption { color:var(--muted); font-size:11px; margin-top:4px; }
  .links { margin-top:8px; font-size:13px; } .links a, .loc a { color:var(--accent); }
  details.raw { margin-top:24px; } details.raw summary { cursor:pointer; color:var(--muted); }
  /* Lightbox */
  #lb { position:fixed; inset:0; background:#000c; display:none; align-items:center; justify-content:center; padding:24px; z-index:50; }
  #lb.on { display:flex; } #lb img { max-width:100%; max-height:100%; border-radius:8px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${esc(args.title)}</h1>
    <div class="meta">Generated ${new Date().toLocaleString()}${
        args.testFile ? ` · ${esc(args.testFile)}` : ""
    } · ${fmtDuration(summary.timeSeconds * 1000)} total</div>
  </header>
  <div class="cards">
    <div class="stat"><div class="n">${total}</div><div class="l">Total</div></div>
    <div class="stat pass"><div class="n">${passed}</div><div class="l">Passed</div></div>
    <div class="stat fail"><div class="n">${failed}</div><div class="l">Failed</div></div>
    <div class="stat skip"><div class="n">${skipped}</div><div class="l">Skipped</div></div>
  </div>
  <div class="bar"><i></i></div>
  ${suiteBlocks.join("\n") || '<p class="meta">No tests found in this run.</p>'}
  ${rawBlock}
</div>
<div id="lb"><img alt=""/></div>
<script>
  (function(){
    var lb=document.getElementById('lb'), img=lb.querySelector('img');
    document.addEventListener('click',function(e){
      var t=e.target;
      if(t.tagName==='IMG' && t.closest('figure')){ img.src=t.src; lb.classList.add('on'); }
      else if(lb.classList.contains('on')){ lb.classList.remove('on'); img.src=''; }
    });
  })();
</script>
</body>
</html>`;

    return { html, embedded };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function renderMarkdown(args: {
    title: string;
    run: ParsedPlaywrightRun;
    testFile?: string;
    outDir: string;
    projectPath: string;
}): string {
    const { run, outDir } = args;
    const { tests, summary } = run;
    const passed = summary.tests.passed;
    const failed = summary.tests.failed;
    const total = summary.tests.total || tests.length;
    const skipped = Math.max(0, total - passed - failed);

    const lines: string[] = [];
    lines.push(`# ${args.title}`);
    lines.push("");
    lines.push(`_Generated ${new Date().toISOString()}${args.testFile ? ` · ${args.testFile}` : ""}_`);
    lines.push("");
    lines.push(`**${passed}/${total} passed** · ${failed} failed · ${skipped} skipped · ${fmtDuration(summary.timeSeconds * 1000)} total`);
    lines.push("");

    for (const [suite, cases] of groupBySuite(tests)) {
        lines.push(`## ${suite}`);
        lines.push("");
        for (const t of cases) {
            const icon = t.status === "passed" ? "✅" : t.status === "failed" ? "❌" : "⚪️";
            lines.push(`- ${icon} **${t.name}** _(${fmtDuration(t.duration)})_`);
            if (t.error?.message) {
                const first = stripAnsi(t.error.message).split("\n").slice(0, 4).join("\n");
                lines.push("");
                lines.push("  ```");
                for (const l of first.split("\n")) lines.push(`  ${l}`);
                lines.push("  ```");
            }
            for (const att of t.attachments ?? []) {
                if (!att.path) continue;
                const rel = path.relative(outDir, path.resolve(args.projectPath, att.path));
                if (isImage(att)) lines.push(`  ![${att.name}](${rel})`);
                else lines.push(`  - [${att.name || "artifact"}](${rel})`);
            }
            lines.push("");
        }
    }

    return `${lines.join("\n").trim()}\n`;
}
