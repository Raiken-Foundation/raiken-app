import { beforeAll, describe, expect, it, vi } from "vitest";
import { EmbeddingsGenerator } from "../database/embeddings";

let modelAvailable = false;

beforeAll(async () => {
    try {
        const gen = EmbeddingsGenerator.getInstance();
        await gen.initialize();
        modelAvailable = true;
    } catch {
        console.warn("⏭️  Skipping embeddings tests — native dependency (sharp) not available");
    }
}, 60000);

describe("Embeddings Generator", () => {
    let generator: EmbeddingsGenerator;

    beforeAll(() => {
        generator = EmbeddingsGenerator.getInstance();
    });

    describe("Initialization", () => {
        it("should return singleton instance", ({ skip }) => {
            if (!modelAvailable) skip();
            const instance1 = EmbeddingsGenerator.getInstance();
            const instance2 = EmbeddingsGenerator.getInstance();
            expect(instance1).toBe(instance2);
        });

        it("should initialize model successfully", ({ skip }) => {
            if (!modelAvailable) skip();
            expect(generator.isReady()).toBe(true);
        });

        it("should handle multiple initialize calls gracefully", async ({ skip }) => {
            if (!modelAvailable) skip();
            await generator.initialize();
            await generator.initialize();
            expect(generator.isReady()).toBe(true);
        });
    });

    describe("Embedding Generation", () => {
        it("should generate embeddings with correct dimensions", async ({ skip }) => {
            if (!modelAvailable) skip();
            const text = "function sum(a, b) { return a + b; }";
            const embedding = await generator.generateEmbedding(text);

            expect(embedding).toHaveLength(384);
            expect(embedding.every((n) => typeof n === "number")).toBe(true);
            expect(embedding.every((n) => !Number.isNaN(n))).toBe(true);
        });

        it("should generate embeddings for code functions", async ({ skip }) => {
            if (!modelAvailable) skip();
            const code =
                "export function calculateTotal(items: Item[]): number { return items.reduce((sum, item) => sum + item.price, 0); }";
            const embedding = await generator.generateEmbedding(code);

            expect(embedding).toHaveLength(384);
        });

        it("should generate embeddings for class definitions", async ({ skip }) => {
            if (!modelAvailable) skip();
            const code =
                "class UserService { async getUser(id: string) { return await db.users.findById(id); } }";
            const embedding = await generator.generateEmbedding(code);

            expect(embedding).toHaveLength(384);
        });

        it("should handle empty strings", async ({ skip }) => {
            if (!modelAvailable) skip();
            const embedding = await generator.generateEmbedding("");
            expect(embedding).toHaveLength(384);
        });

        it("should handle very long text by truncating", async ({ skip }) => {
            if (!modelAvailable) skip();
            const longText = `${"function test() { ".repeat(1000)} }`;
            const embedding = await generator.generateEmbedding(longText);

            expect(embedding).toHaveLength(384);
        });
    });

    describe("Semantic Similarity", () => {
        it("should produce similar embeddings for similar code", async ({ skip }) => {
            if (!modelAvailable) skip();
            const code1 = "function add(a, b) { return a + b; }";
            const code2 = "function sum(x, y) { return x + y; }";
            const code3 = "function multiply(a, b) { return a * b; }";

            const emb1 = await generator.generateEmbedding(code1);
            const emb2 = await generator.generateEmbedding(code2);
            const emb3 = await generator.generateEmbedding(code3);

            const sim12 = generator.cosineSimilarity(emb1, emb2);
            const sim13 = generator.cosineSimilarity(emb1, emb3);

            expect(sim12).toBeGreaterThan(sim13);
            expect(sim12).toBeGreaterThan(0.65);
        });

        it("should produce similar embeddings for semantically related code", async ({ skip }) => {
            if (!modelAvailable) skip();
            const code1 =
                "function validateEmail(email: string) { return /^[^@]+@[^@]+$/.test(email); }";
            const code2 = 'function checkEmail(address: string) { return address.includes("@"); }';
            const code3 =
                "function calculateAge(birthYear: number) { return new Date().getFullYear() - birthYear; }";

            const emb1 = await generator.generateEmbedding(code1);
            const emb2 = await generator.generateEmbedding(code2);
            const emb3 = await generator.generateEmbedding(code3);

            const sim12 = generator.cosineSimilarity(emb1, emb2);
            const sim13 = generator.cosineSimilarity(emb1, emb3);

            expect(sim12).toBeGreaterThan(sim13);
        });

        it("should handle identical embeddings", async ({ skip }) => {
            if (!modelAvailable) skip();
            const code = "function test() { return true; }";
            const emb1 = await generator.generateEmbedding(code);
            const emb2 = await generator.generateEmbedding(code);

            const similarity = generator.cosineSimilarity(emb1, emb2);
            expect(similarity).toBeCloseTo(1.0, 5);
        });
    });

    describe("Batch Generation", () => {
        it("should handle batch generation", async ({ skip }) => {
            if (!modelAvailable) skip();
            const texts = ["function a() {}", "function b() {}", "function c() {}"];

            const embeddings = await generator.generateEmbeddingsBatch(texts);

            expect(embeddings).toHaveLength(3);
            expect(embeddings[0]).toHaveLength(384);
            expect(embeddings[1]).toHaveLength(384);
            expect(embeddings[2]).toHaveLength(384);
        });

        it("should handle large batches", async ({ skip }) => {
            if (!modelAvailable) skip();
            const texts = Array.from(
                { length: 50 },
                (_, i) => `function fn${i}() { return ${i}; }`,
            );

            const embeddings = await generator.generateEmbeddingsBatch(texts);

            expect(embeddings).toHaveLength(50);
            expect(embeddings.every((emb) => emb !== null && emb.length === 384)).toBe(true);
        });

        it("should handle empty batch", async ({ skip }) => {
            if (!modelAvailable) skip();
            const embeddings = await generator.generateEmbeddingsBatch([]);
            expect(embeddings).toHaveLength(0);
        });

        it("should handle single item batch", async ({ skip }) => {
            if (!modelAvailable) skip();
            const embeddings = await generator.generateEmbeddingsBatch(["function test() {}"]);
            expect(embeddings).toHaveLength(1);
            expect(embeddings[0]).toHaveLength(384);
        });

        it("isolates a single failing item instead of failing the whole batch", async () => {
            // Does not depend on the real model — verifies the fault-isolation
            // contract of generateEmbeddingsBatch() directly by making the
            // second of three calls reject.
            const gen = EmbeddingsGenerator.getInstance();
            const spy = vi
                .spyOn(gen, "generateEmbedding")
                .mockImplementation(async (text: string) => {
                    if (text === "bad") throw new Error("simulated tokenizer failure");
                    return [1, 2, 3];
                });

            try {
                const embeddings = await gen.generateEmbeddingsBatch(["good-1", "bad", "good-2"]);
                expect(embeddings).toHaveLength(3);
                expect(embeddings[0]).toEqual([1, 2, 3]);
                expect(embeddings[1]).toBeNull();
                expect(embeddings[2]).toEqual([1, 2, 3]);
            } finally {
                spy.mockRestore();
            }
        });
    });

    describe("Cosine Similarity", () => {
        it("should calculate cosine similarity correctly", ({ skip }) => {
            if (!modelAvailable) skip();
            const vec1 = [1, 0, 0];
            const vec2 = [1, 0, 0];
            const similarity = generator.cosineSimilarity(vec1, vec2);
            expect(similarity).toBeCloseTo(1.0, 5);
        });

        it("should handle orthogonal vectors", ({ skip }) => {
            if (!modelAvailable) skip();
            const vec1 = [1, 0, 0];
            const vec2 = [0, 1, 0];
            const similarity = generator.cosineSimilarity(vec1, vec2);
            expect(similarity).toBeCloseTo(0.0, 5);
        });

        it("should handle opposite vectors", ({ skip }) => {
            if (!modelAvailable) skip();
            const vec1 = [1, 0, 0];
            const vec2 = [-1, 0, 0];
            const similarity = generator.cosineSimilarity(vec1, vec2);
            expect(similarity).toBeCloseTo(-1.0, 5);
        });

        it("should throw error for mismatched dimensions", ({ skip }) => {
            if (!modelAvailable) skip();
            const vec1 = [1, 2, 3];
            const vec2 = [1, 2];
            expect(() => generator.cosineSimilarity(vec1, vec2)).toThrow();
        });

        it("should handle zero vectors", ({ skip }) => {
            if (!modelAvailable) skip();
            const vec1 = [0, 0, 0];
            const vec2 = [1, 2, 3];
            const similarity = generator.cosineSimilarity(vec1, vec2);
            expect(similarity).toBe(0);
        });
    });

    describe("Caching", () => {
        it("should cache embeddings for repeated text", async ({ skip }) => {
            if (!modelAvailable) skip();
            const text = "function cached() { return true; }";

            const start1 = Date.now();
            const emb1 = await generator.generateEmbedding(text);
            const duration1 = Date.now() - start1;

            const start2 = Date.now();
            const emb2 = await generator.generateEmbedding(text);
            const duration2 = Date.now() - start2;

            expect(emb1).toEqual(emb2);
            expect(duration2).toBeLessThan(duration1);
        });

        it("should provide cache statistics", ({ skip }) => {
            if (!modelAvailable) skip();
            const stats = generator.getCacheStats();
            expect(stats).toHaveProperty("size");
            expect(stats).toHaveProperty("maxSize");
            expect(stats.maxSize).toBe(1000);
        });

        it("should clear cache successfully", async ({ skip }) => {
            if (!modelAvailable) skip();
            await generator.generateEmbedding("function test1() {}");
            await generator.generateEmbedding("function test2() {}");

            let stats = generator.getCacheStats();
            expect(stats.size).toBeGreaterThan(0);

            generator.clearCache();

            stats = generator.getCacheStats();
            expect(stats.size).toBe(0);
        });
    });

    describe("Edge Cases", () => {
        it("should handle special characters", async ({ skip }) => {
            if (!modelAvailable) skip();
            const text = 'function test() { return "Hello, 世界! 🚀"; }';
            const embedding = await generator.generateEmbedding(text);
            expect(embedding).toHaveLength(384);
        });

        it("should handle code with syntax errors", async ({ skip }) => {
            if (!modelAvailable) skip();
            const text = "function broken( { return ; }";
            const embedding = await generator.generateEmbedding(text);
            expect(embedding).toHaveLength(384);
        });

        it("should handle HTML/JSX-like content", async ({ skip }) => {
            if (!modelAvailable) skip();
            const text = "function Component() { return <div>Hello</div>; }";
            const embedding = await generator.generateEmbedding(text);
            expect(embedding).toHaveLength(384);
        });

        it("should handle natural language descriptions", async ({ skip }) => {
            if (!modelAvailable) skip();
            const text = "This function calculates the sum of all numbers in an array";
            const embedding = await generator.generateEmbedding(text);
            expect(embedding).toHaveLength(384);
        });
    });

    describe("Performance", () => {
        it("should generate single embedding quickly", async ({ skip }) => {
            if (!modelAvailable) skip();
            const start = Date.now();
            await generator.generateEmbedding("function test() { return 42; }");
            const duration = Date.now() - start;

            expect(duration).toBeLessThan(200);
        });

        it("should handle batch generation efficiently", async ({ skip }) => {
            if (!modelAvailable) skip();
            const texts = Array.from({ length: 20 }, (_, i) => `function fn${i}() {}`);

            const start = Date.now();
            await generator.generateEmbeddingsBatch(texts);
            const duration = Date.now() - start;

            expect(duration).toBeLessThan(5000);
        });
    });
});
