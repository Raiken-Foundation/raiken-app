import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers';

/**
 * Singleton embeddings generator using Transformers.js
 * 
 * Model: all-MiniLM-L6-v2 (384-dimensional embeddings)
 * Purpose: Generate semantic embeddings for code chunks
 * 
 * Features:
 * - Local inference (no API calls)
 * - Cached model (~23MB, downloads once)
 * - Fast inference (~50ms per chunk)
 * - Suitable for code + natural language
 */
export class EmbeddingsGenerator {
  private static instance: EmbeddingsGenerator;
  private model: FeatureExtractionPipeline | null = null;
  private isInitialized = false;
  private cache = new Map<string, number[]>();
  private maxCacheSize = 1000;

  private constructor() { /* empty */ }

  static getInstance(): EmbeddingsGenerator {
    if (!EmbeddingsGenerator.instance) {
      EmbeddingsGenerator.instance = new EmbeddingsGenerator();
    }
    return EmbeddingsGenerator.instance;
  }

  /**
   * Initialize the embeddings model (downloads on first run)
   * Cache location: ~/.cache/huggingface/transformers/
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    console.log('📥 Loading embeddings model (first run may download ~23MB)...');
    
    try {
      this.model = await pipeline(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2',
        {
          quantized: true, // Use quantized version for speed
        }
      );

      this.isInitialized = true;
      console.log('✅ Embeddings model ready');
    } catch (error) {
      console.error('❌ Failed to load embeddings model:', error);
      throw new Error(`Embeddings model initialization failed: ${error}`);
    }
  }

  /**
   * Generate embedding for a single text chunk
   * 
   * @param text - The text to embed (function signature, class definition, etc.)
   * @returns 384-dimensional embedding vector
   */
  async generateEmbedding(text: string): Promise<number[]> {
    // Check cache first
    const cached = this.cache.get(text);
    if (cached) {
      return cached;
    }

    // Generate if not cached
    const embedding = await this._generateUncached(text);

    // Store in cache (with LRU eviction)
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(text, embedding);

    return embedding;
  }

  /**
   * Internal method to generate embedding without cache
   */
  private async _generateUncached(text: string): Promise<number[]> {
    if (!this.model) {
      await this.initialize();
    }

    // Truncate text to max tokens (512 for this model)
    // Rough estimate: ~4 chars per token, so 2000 chars ≈ 500 tokens
    const truncated = text.slice(0, 2000);

    try {
      const output = await this.model!(truncated, {
        pooling: 'mean',
        normalize: true,
      });

      // Convert tensor to array
      return Array.from(output.data as Float32Array);
    } catch (error) {
      console.error('Error generating embedding:', error);
      throw new Error(`Embedding generation failed: ${error}`);
    }
  }

  /**
   * Generate embeddings for multiple texts in batch
   * More efficient than individual calls
   * 
   * @param texts - Array of texts to embed
   * @returns Array of embedding vectors
   */
  async generateEmbeddingsBatch(texts: string[]): Promise<number[][]> {
    if (!this.model) {
      await this.initialize();
    }

    const embeddings: number[][] = [];
    
    // Process in chunks to avoid memory issues
    const batchSize = 32;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(text => this.generateEmbedding(text))
      );
      embeddings.push(...results);
      
      // Log progress for large batches
      if (texts.length > 100 && (i + batchSize) % 100 === 0) {
        console.log(`  Processed ${Math.min(i + batchSize, texts.length)}/${texts.length} embeddings`);
      }
    }

    return embeddings;
  }

  /**
   * Calculate cosine similarity between two embeddings
   * Returns value between -1 and 1 (higher = more similar)
   * 
   * @param a - First embedding vector
   * @param b - Second embedding vector
   * @returns Cosine similarity score
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error(`Embeddings must have same length (got ${a.length} and ${b.length})`);
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    
    // Avoid division by zero
    if (denominator === 0) {
      return 0;
    }

    return dotProduct / denominator;
  }

  /**
   * Clear the embedding cache
   * Useful for freeing memory or forcing re-generation
   */
  clearCache(): void {
    this.cache.clear();
    console.log('🧹 Embedding cache cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; maxSize: number; hitRate?: number } {
    return {
      size: this.cache.size,
      maxSize: this.maxCacheSize,
    };
  }

  /**
   * Check if the model is initialized and ready
   */
  isReady(): boolean {
    return this.isInitialized && this.model !== null;
  }
}

// Export singleton instance
export const embeddingsGenerator = EmbeddingsGenerator.getInstance();

