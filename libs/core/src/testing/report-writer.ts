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
import { resolvePathWithinProject } from "../config/store";
import { writeFileAtomic } from "../io/atomic-write";
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
    const outDir = resolvePathWithinProject(projectPath, outDirRel);
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
                // Playwright inlined it already (base64). Defensive validation:
                // `contentType`/`body` originate from JSON that may come from
                // `--from <file>` (arbitrary user-supplied JSON, not just live
                // Playwright output), so a malformed value could otherwise break
                // out of the `src="..."` attribute it's embedded into below.
                const mime = isSafeMimeType(att.contentType) ? att.contentType : "image/png";
                const body = isLikelyBase64(att.body) ? att.body : null;
                return body ? `data:${mime};base64,${body}` : null;
            }
            if (!att.path) return null;
            const resolved = resolvePathWithinProject(projectPath, att.path);
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
        await writeFileAtomic(p, html);
        await writeFileAtomic(path.join(outDir, "latest.html"), html);
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
        await writeFileAtomic(p, md);
        await writeFileAtomic(path.join(outDir, "latest.md"), md);
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
        await writeFileAtomic(p, payload);
        await writeFileAtomic(path.join(outDir, "latest.json"), payload);
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

// `contentType`/`body` land straight in a `data:` URI inside `src="..."` in
// the generated HTML. Both fields can originate from arbitrary user-supplied
// JSON (`--from <file>`), so validate their shape before trusting them rather
// than relying solely on `esc()` at the call site.
const SAFE_MIME_RE = /^[a-z0-9]+\/[a-z0-9.+-]+$/i;
function isSafeMimeType(value: string | undefined): value is string {
    return typeof value === "string" && SAFE_MIME_RE.test(value);
}
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function isLikelyBase64(value: string): boolean {
    return value.length > 0 && value.length % 4 === 0 && BASE64_RE.test(value);
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

// Markdown-safe escaping for values that land in prose (titles, suite/test
// names, paths) rather than inside fenced code blocks. Neutralizes raw HTML
// (renderers embedded in GitHub/IDEs treat Markdown as HTML-permissive) and
// backslash-escapes characters that would otherwise reinterpret a test/suite
// name as Markdown structure (e.g. a test named "* not a bullet").
const MD_STRUCTURAL_RE = /[<>&*_`[\]|]/g;
const MD_ESCAPES: Record<string, string> = {
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "*": "\\*",
    _: "\\_",
    "`": "\\`",
    "[": "\\[",
    "]": "\\]",
    "|": "\\|",
};
function escMd(s: string | undefined): string {
    return stripAnsi(s).replace(MD_STRUCTURAL_RE, (ch) => MD_ESCAPES[ch] ?? ch);
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

    const suiteBlocks: string[] = [];
    for (const [suite, cases] of groupBySuite(tests)) {
        const rows: string[] = [];
        for (const t of cases) {
            const sev =
                t.status === "passed"
                    ? `<span class="sev sev--pass">PASS</span>`
                    : t.status === "failed"
                      ? `<span class="sev sev--fail">FAIL</span>`
                      : `<span class="sev sev--skip">SKIP</span>`;

            let details = "";
            if (t.error) {
                const loc = t.error.location
                    ? `<div class="t-loc">${esc(t.error.location.file)}:${t.error.location.line}</div>`
                    : "";
                details += `<div class="t-error">${loc}<pre>${esc(t.error.message)}</pre>${
                    t.error.snippet ? `<pre class="t-snippet">${esc(t.error.snippet)}</pre>` : ""
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
                            `<figure><img loading="lazy" src="${esc(uri)}" alt="${esc(att.name)}"/><figcaption>${esc(att.name)}</figcaption></figure>`,
                        );
                        continue;
                    }
                }
                if (att.path) {
                    const rel = path.relative(outDir, path.resolve(args.projectPath, att.path));
                    const kind = isVideo(att)
                        ? "video"
                        : isTrace(att)
                          ? "trace"
                          : att.name || "file";
                    links.push(`<a class="t-link" href="${esc(rel)}">${esc(kind)}</a>`);
                }
            }
            if (shots.length > 0) details += `<div class="t-shots">${shots.join("")}</div>`;
            if (links.length > 0)
                details += `<div class="t-artifacts">artifacts: ${links.join(" · ")}</div>`;

            rows.push(
                `<div class="t-row t-row--${t.status}"><div class="t-row-head">${sev}<span class="t-name">${esc(
                    t.name,
                )}</span><span class="t-dur">${fmtDuration(t.duration)}</span></div>${details}</div>`,
            );
        }
        suiteBlocks.push(
            `<section class="suite"><h2 class="suite-head">${esc(suite)}</h2>${rows.join("")}</section>`,
        );
    }

    const rawBlock = args.rawOutput
        ? `<details class="raw"><summary>raw playwright output</summary><pre>${esc(
              args.rawOutput.slice(-20000),
          )}</pre></details>`
        : "";

    // Tri-color proportional segment bar (pass/fail/skip), matching the
    // dashboard's flat hairline-bordered progress indicators — no rounded
    // pill, no single fail-colored track with a pass overlay.
    const passSegPct = total > 0 ? (passed / total) * 100 : 0;
    const failSegPct = total > 0 ? (failed / total) * 100 : 0;
    const skipSegPct = total > 0 ? (skipped / total) * 100 : 0;

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(args.title)}</title>
<style>
  :root {
    color-scheme: dark;
    --bg:#0a0a0a; --bg-elev:#111111; --bg-bar:#0d0d0d; --bg-hover:#181818;
    --hair:#1c1c1c; --hair-strong:#2a2a2a;
    --ink:#d4d4d4; --ink-strong:#f0f0f0; --ink-dim:#8a8a8a; --ink-faint:#5a5a5a;
    --accent:#a78bfa; --accent-dim:rgba(167,139,250,.18); --accent-soft:rgba(167,139,250,.09);
    --pass:#6fb86f; --warn:#d9a441; --fail:#d75c5c;
    --pass-soft:rgba(111,184,111,.1); --warn-soft:rgba(217,164,65,.1); --fail-soft:rgba(215,92,92,.1);
    --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    --sans:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg:#f7f7f7; --bg-elev:#ffffff; --bg-bar:#f0f0f0; --bg-hover:#ececec;
      --hair:#dddddd; --hair-strong:#c4c4c4;
      --ink:#26262a; --ink-strong:#0a0a0a; --ink-dim:#6b6b6b; --ink-faint:#9a9a9a;
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.6 var(--sans); }
  .wrap { max-width:920px; margin:0 auto; padding:2.5rem 1.25rem 5rem; }
  header { display:flex; align-items:center; gap:.75rem; margin-bottom:.375rem; }
  .brand-mark { flex-shrink:0; image-rendering:pixelated; display:block; }
  h1 { margin:0; font-family:var(--mono); font-size:16px; font-weight:500; color:var(--ink-strong); letter-spacing:-.01em; }
  .meta { color:var(--ink-faint); font-family:var(--mono); font-size:11px; margin:.375rem 0 1.25rem; letter-spacing:.02em; }
  .stat-strip { display:flex; flex-wrap:wrap; margin:0 0 .875rem; border-top:1px solid var(--hair); border-bottom:1px solid var(--hair); font-family:var(--mono); font-size:11px; }
  .stat-item { display:inline-flex; align-items:baseline; gap:.375rem; padding:.4375rem .75rem; border-right:1px solid var(--hair); font-variant-numeric:tabular-nums; }
  .stat-val { color:var(--ink); font-weight:500; font-size:14px; } .stat-label { color:var(--ink-faint); text-transform:lowercase; }
  .stat-item--pass .stat-val { color:var(--pass); } .stat-item--fail .stat-val { color:var(--fail); } .stat-item--skip .stat-val { color:var(--ink-dim); }
  .seg-bar { display:flex; height:6px; border:1px solid var(--hair); overflow:hidden; margin:0 0 1.75rem; background:var(--bg-elev); }
  .seg-bar > i { display:block; height:100%; }
  .seg-bar .seg-pass { background:var(--pass); width:${passSegPct}%; }
  .seg-bar .seg-fail { background:var(--fail); width:${failSegPct}%; }
  .seg-bar .seg-skip { background:var(--ink-faint); width:${skipSegPct}%; }
  .suite { margin-bottom:1.5rem; }
  .suite-head { font-family:var(--mono); font-size:11px; font-weight:500; margin:0 0 .625rem; padding-bottom:.375rem; border-bottom:1px solid var(--hair); color:var(--ink-faint); letter-spacing:.04em; text-transform:lowercase; }
  .suite-head::before { content:"─ "; color:var(--ink-faint); }
  .t-row { background:var(--bg-elev); border:1px solid var(--hair); border-left-width:3px; padding:.625rem .75rem; margin-bottom:.5rem; }
  .t-row--passed { border-left-color:var(--pass); } .t-row--failed { border-left-color:var(--fail); } .t-row--skipped { border-left-color:var(--ink-faint); }
  .t-row-head { display:flex; align-items:center; gap:.625rem; }
  .t-name { flex:1; font-family:var(--mono); font-size:12.5px; color:var(--ink); }
  .t-dur { color:var(--ink-faint); font-family:var(--mono); font-size:11px; font-variant-numeric:tabular-nums; }
  .sev { font-family:var(--mono); font-size:10px; font-weight:700; letter-spacing:.08em; padding:1px 5px; line-height:1.4; flex-shrink:0; }
  .sev--pass { color:var(--pass); background:var(--pass-soft); }
  .sev--fail { color:var(--fail); background:var(--fail-soft); }
  .sev--skip { color:var(--ink-dim); background:var(--bg-bar); }
  .t-error { margin-top:.625rem; }
  .t-loc { color:var(--ink-faint); font-family:var(--mono); font-size:11px; margin-bottom:.25rem; }
  pre { background:var(--bg-bar); border:1px solid var(--hair); padding:.625rem .75rem; overflow:auto; font:11.5px/1.55 var(--mono); white-space:pre-wrap; word-break:break-word; margin:0 0 .5rem; color:var(--ink); }
  pre.t-snippet { color:var(--ink-dim); }
  .t-shots { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:.625rem; margin-top:.625rem; }
  figure { margin:0; } figure img { width:100%; border:1px solid var(--hair); cursor:zoom-in; display:block; }
  figcaption { color:var(--ink-faint); font-family:var(--mono); font-size:10.5px; margin-top:.25rem; }
  .t-artifacts { margin-top:.5rem; font-family:var(--mono); font-size:11.5px; color:var(--ink-faint); }
  .t-link, a.q-link, .t-loc a { color:var(--accent); text-decoration:none; }
  .t-link:hover { text-decoration:underline; }
  details.raw { margin-top:2rem; border:1px solid var(--hair); background:var(--bg-elev); }
  details.raw summary { cursor:pointer; color:var(--ink-faint); font-family:var(--mono); font-size:11px; padding:.5rem .75rem; letter-spacing:.02em; }
  details.raw pre { margin:0; border:0; border-top:1px solid var(--hair); }
  .empty { color:var(--ink-faint); font-family:var(--mono); font-size:12px; }
  /* Lightbox */
  #lb { position:fixed; inset:0; background:#000c; display:none; align-items:center; justify-content:center; padding:1.5rem; z-index:50; }
  #lb.on { display:flex; } #lb img { max-width:100%; max-height:100%; border:1px solid var(--hair-strong); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <svg class="brand-mark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="24" height="24" role="img" aria-label="Raiken">
      <rect width="64" height="64" fill="#a78bfa"/>
      <g fill="#0a0a0a">
        <rect x="4" y="4" width="8" height="4"/><rect x="4" y="8" width="4" height="28"/><rect x="4" y="36" width="8" height="4"/>
        <rect x="40" y="4" width="8" height="4"/><rect x="44" y="8" width="4" height="28"/><rect x="40" y="36" width="8" height="4"/>
        <rect x="16" y="12" width="20" height="4"/><rect x="16" y="16" width="4" height="4"/><rect x="32" y="16" width="4" height="4"/>
        <rect x="16" y="20" width="20" height="4"/><rect x="16" y="24" width="4" height="4"/><rect x="28" y="24" width="4" height="4"/>
        <rect x="16" y="28" width="4" height="4"/><rect x="32" y="28" width="4" height="4"/>
      </g>
    </svg>
    <h1>${esc(args.title)}</h1>
  </header>
  <div class="meta">generated ${new Date().toLocaleString()}${
      args.testFile ? ` · ${esc(args.testFile)}` : ""
  } · ${fmtDuration(summary.timeSeconds * 1000)} total</div>
  <div class="stat-strip">
    <div class="stat-item"><span class="stat-val">${total}</span><span class="stat-label">total</span></div>
    <div class="stat-item stat-item--pass"><span class="stat-val">${passed}</span><span class="stat-label">passed</span></div>
    <div class="stat-item stat-item--fail"><span class="stat-val">${failed}</span><span class="stat-label">failed</span></div>
    <div class="stat-item stat-item--skip"><span class="stat-val">${skipped}</span><span class="stat-label">skipped</span></div>
  </div>
  <div class="seg-bar"><i class="seg-pass"></i><i class="seg-fail"></i><i class="seg-skip"></i></div>
  ${suiteBlocks.join("\n") || '<p class="empty">no tests found in this run.</p>'}
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
    lines.push(`# ${escMd(args.title)}`);
    lines.push("");
    lines.push(
        `_Generated ${new Date().toISOString()}${
            args.testFile ? ` · ${escMd(args.testFile)}` : ""
        }_`,
    );
    lines.push("");
    lines.push(
        `**${passed}/${total} passed** · ${failed} failed · ${skipped} skipped · ${fmtDuration(summary.timeSeconds * 1000)} total`,
    );
    lines.push("");

    for (const [suite, cases] of groupBySuite(tests)) {
        lines.push(`## ${escMd(suite)}`);
        lines.push("");
        for (const t of cases) {
            const icon = t.status === "passed" ? "✅" : t.status === "failed" ? "❌" : "⚪️";
            lines.push(`- ${icon} **${escMd(t.name)}** _(${fmtDuration(t.duration)})_`);
            if (t.error?.message) {
                // Fenced code blocks are literal — no Markdown escaping needed
                // inside, only ANSI stripping (a stray ``` in the message could
                // still break the fence, but that's pre-existing Playwright
                // output we don't control and is exceedingly rare in practice).
                const first = stripAnsi(t.error.message).split("\n").slice(0, 4).join("\n");
                lines.push("");
                lines.push("  ```");
                for (const l of first.split("\n")) lines.push(`  ${l}`);
                lines.push("  ```");
            }
            for (const att of t.attachments ?? []) {
                if (!att.path) continue;
                const rel = path.relative(outDir, path.resolve(args.projectPath, att.path));
                const name = escMd(att.name);
                if (isImage(att)) lines.push(`  ![${name}](${rel})`);
                else lines.push(`  - [${name || "artifact"}](${rel})`);
            }
            lines.push("");
        }
    }

    return `${lines.join("\n").trim()}\n`;
}
