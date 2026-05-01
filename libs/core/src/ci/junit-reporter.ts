/**
 * JUnit XML reporter for `raiken ci`.
 *
 * Produces a minimal but widely-compatible `<testsuites>` document that
 * GitHub Actions, GitLab CI, CircleCI, and the usual JUnit viewers all
 * understand. One `<testsuite>` per test file; one `<testcase>` per test.
 */

import type { TestRunResult } from "../testing/runner";
import type { CiRunReport } from "./types";

export function renderJUnitXml(run: CiRunReport): string {
    const bySuite = new Map<string, TestRunResult[]>();
    for (const t of run.tests) {
        const list = bySuite.get(t.testFile) ?? [];
        list.push(t);
        bySuite.set(t.testFile, list);
    }

    const suiteXml: string[] = [];
    for (const [testFile, tests] of bySuite) {
        suiteXml.push(renderSuite(testFile, tests));
    }

    const totals = run.summary;
    const errors = totals.errored + totals.timedOut;
    const timeSec = (run.durationMs / 1000).toFixed(3);

    return [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<testsuites name="raiken-ci" tests="${totals.total}" failures="${totals.failed}" errors="${errors}" time="${timeSec}">`,
        ...suiteXml,
        `</testsuites>`,
        "",
    ].join("\n");
}

function renderSuite(testFile: string, tests: TestRunResult[]): string {
    const totals = {
        total: tests.length,
        failed: tests.filter((t) => t.status === "failed").length,
        errored: tests.filter((t) => t.status === "error" || t.status === "timeout").length,
    };
    const timeSec = (tests.reduce((acc, t) => acc + t.duration, 0) / 1000).toFixed(3);

    const cases = tests.map((t) => renderCase(testFile, t)).join("\n");

    return [
        `  <testsuite name="${xmlAttr(testFile)}" tests="${totals.total}" failures="${totals.failed}" errors="${totals.errored}" time="${timeSec}">`,
        cases,
        `  </testsuite>`,
    ].join("\n");
}

function renderCase(testFile: string, t: TestRunResult): string {
    const classname = xmlAttr(testFile);
    const name = xmlAttr(t.testName || "unnamed test");
    const timeSec = (t.duration / 1000).toFixed(3);
    const head = `    <testcase classname="${classname}" name="${name}" time="${timeSec}">`;
    const tail = `    </testcase>`;

    if (t.status === "passed") {
        return `${head}${tail}`;
    }

    if (t.status === "failed") {
        const message = xmlAttr(t.error?.message || "Test failed");
        const body = xmlText(t.error?.stack || t.error?.message || "");
        return [
            head,
            `      <failure message="${message}"><![CDATA[${cdata(body)}]]></failure>`,
            tail,
        ].join("\n");
    }

    // error or timeout
    const kind = t.status === "timeout" ? "timeout" : "error";
    const message = xmlAttr(t.error?.message || `Test ${kind}`);
    const body = xmlText(t.error?.stack || t.error?.message || "");
    return [
        head,
        `      <error message="${message}" type="${kind}"><![CDATA[${cdata(body)}]]></error>`,
        tail,
    ].join("\n");
}

function xmlAttr(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/\r?\n/g, " ")
        .replace(/\t/g, " ");
}

function xmlText(value: string): string {
    // Used inside CDATA; only need to handle the `]]>` sequence below.
    return value;
}

function cdata(value: string): string {
    // Split any `]]>` inside the body to keep the CDATA section valid.
    return value.replace(/]]>/g, "]]]]><![CDATA[>");
}
