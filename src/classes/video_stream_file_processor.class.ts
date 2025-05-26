import {createClient as createRedisClient} from 'redis';
import {Client as MinioClient} from 'minio';
import {VideoStreamFileProcessorConfig} from '../types/video_stream_file_processor_config.type';
import chokidar from 'chokidar';
import {get_file_hash} from '../utils/get_file_hash';
import {RedisStreamMetadata} from '../types/redis_stream_metadata.type';
import {get_video_duration} from '../utils/get_video_duration';
import path from 'node:path';
import {
  active_streams,
  failed_uploads,
  retry_attempts,
  stream_processing_duration,
  total_chunks_uploaded,
  total_files_processed,
  total_storage_used
} from '../utils/prometheus';
import {minio_object_exists} from '../utils/minio_object_exists';
import {v4 as uuidv4} from 'uuid';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {RedisStreamChunkStatus} from '../types/redis_stream_chunk_status.type';
import {logger} from '../utils/logger';

/**
 * Maximum number of retry attempts for network operations
 */
const MAX_RETRIES = 10;

/**
 * Delay between retries in milliseconds (exponential backoff)
 */
const RETRY_DELAY = 1000;

/**
 * VideoStreamFileProcessor
 *
 * This class handles the core functionality of watching for video files, processing them into chunks,
 * and uploading them to MinIO storage. It implements a streaming approach where files can be processed
 * while they are still being written.
 *
 * Key features:
 * - Directory watching for new and modified MP4 files
 * - Chunk-based processing for efficient handling of large files
 * - Stream timeout mechanism to handle file completion
 * - Redis-based metadata tracking for each stream
 * - MinIO storage integration with chunked uploads
 * - Prometheus metrics for monitoring
 * - Retry mechanisms for network failures
 * - Error handling for connection issues
 */
export class VideoStreamFileProcessor {
  private readonly redis_client: ReturnType<typeof createRedisClient>;
  private readonly minio_client: MinioClient;
  private readonly config: Required<VideoStreamFileProcessorConfig>;

  /**
   * Maps file paths to their timeout handlers.
   * Used to track when a file has stopped being written to.
   */
  private file_stream_timeouts: Map<string, NodeJS.Timeout> = new Map();

  /**
   * Tracks which files have been initialized in the system.
   * Prevents duplicate processing of the same file.
   */
  private file_initialized: Map<string, boolean> = new Map();

  /**
   * Redis key used to maintain the mapping between file paths and their stream IDs
   */
  private file_mapping_key = 'file_to_stream_mapping';

  constructor(config: VideoStreamFileProcessorConfig) {
    if (!config) {
      throw new Error('VideoStreamFileProcessorConfig is required');
    }

    this.config = {
      stream_timeout: config.stream_timeout || 30_000,
      watch_directory: config.watch_directory || 'test_videos',
      chunk_size: config.chunk_size || 10 * 1024 * 1024,
      bucket_name: config.bucket_name || 'videos'
    };

    logger.info(`Config: ${JSON.stringify(this.config, null, 2)}`);

    this.file_stream_timeouts = new Map();
    this.file_initialized = new Map();

    this.redis_client = createRedisClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379'
    });

    this.minio_client = new MinioClient({
      endPoint: process.env.MINIO_ENDPOINT || 'localhost',
      port: parseInt(process.env.MINIO_PORT || '9000'),
      useSSL: false,
      accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
      secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin'
    });
  }

  /**
   * Starts watching the configured directory for new and modified files.
   * Initializes Redis and MinIO connections before starting the watcher.
   */
  async start_watching() {
    logger.info(`Watching directory: ${this.config.watch_directory}`);

    await this.initialize_redis();
    await this.initialize_minio();

    const watcher = chokidar.watch(this.config.watch_directory, {
      /**
       * Ignore dotfiles
       */
      ignored: /(^|[\/\\])\../,
      persistent: true,
      usePolling: true,
      interval: 1000,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100
      }
    });

    watcher.on('add', (path) => {
      this.extend_stream_timeout(path);
      this.process_new_file(path);
    });

    watcher.on('change', (path) => {
      this.extend_stream_timeout(path);
      this.process_updated_file(path);
    });
  }

  /**
   * Extends or creates a timeout for a file stream.
   * If no changes are detected within the timeout period, the stream is considered complete.
   * @param file_path Path to the file being monitored
   */
  private extend_stream_timeout(file_path: string) {
    if (!this.file_initialized.get(file_path)) {
      logger.info(`[extend_stream_timeout] File not initialized: ${file_path}. Skipping...`);
      return;
    }

    const timeout = this.file_stream_timeouts.get(file_path);

    if (timeout) {
      clearTimeout(timeout);
    }

    this.file_stream_timeouts.set(file_path,
      setTimeout(() => this.finalize_stream(file_path), this.config.stream_timeout)
    );
  }

  /**
   * Finalizes a stream by processing any remaining data and cleaning up resources.
   * This is called when a file has stopped being written to (stream timeout).
   *
   * Process:
   * 1. Process any remaining file data
   * 2. Update stream metadata to completed status
   * 3. Generate and upload final metadata JSON
   * 4. Update metrics
   * 5. Clean up Redis entries
   *
   * @param file_path Path to the file being finalized
   */
  private async finalize_stream(file_path: string) {

    if (!this.file_initialized.get(file_path)) {
      logger.info(`[finalize_stream] File not initialized: ${file_path}. Skipping...`);
      return;
    }

    logger.info(`[finalize_stream start]: Finalizing stream for file: ${file_path}`);
    await this.process_updated_file(file_path, true);

    const stream_id = await this.get_stream_id_by_file_path(file_path);

    if (!stream_id) {
      logger.info(`[finalize_stream]: No stream mapping found for file: ${file_path}`);
      return;
    }

    await this.upsert_stream_metadata(stream_id, {
      status: 'completed',
      completed_on: Date.now()
    });

    const file_hash = await get_file_hash(file_path);

    const redis_metadata = await this.get_stream_metadata(stream_id).then((m) => {
      return m || {} as Partial<RedisStreamMetadata>;
    });

    const video_duration = await get_video_duration(file_path);

    const minio_metadata = {
      id: stream_id,
      file_name: path.basename(file_path),
      hash: file_hash,
      size: redis_metadata.file_size,
      duration: video_duration,
      chunks: (redis_metadata.chunks?.items || []).map((chunk) => {
        return {
          path: chunk.minio_key,
          size: chunk.size,
          uploaded_on: chunk.completed_on,
          hash: chunk.hash
        };
      })
    };

    const stream_process_duration = Date.now() - (redis_metadata?.created_on || Date.now());

    if (stream_process_duration) {
      stream_processing_duration.observe(stream_process_duration / 1000);
    }

    const buffer = Buffer.from(JSON.stringify(minio_metadata, null, 2), 'utf-8');

    await this.minio_client.putObject(
      this.config.bucket_name,
      `streams/${file_hash}.json`,
      buffer,
      buffer.length,
      {
        'Content-Type': 'application/json'
      }
    );

    active_streams.dec();
    total_files_processed.inc();
    total_storage_used.inc(redis_metadata.file_size || 0);

    /**
     * Since we are cleaning up the stream from Redis, above code is
     * redundant, but it is kept for future reference.
     */
    await Promise.all([
      this.redis_client.hDel(this.file_mapping_key, file_path),
      this.redis_client.del(`stream:${stream_id}:metadata`)
    ]).catch((error) => {
      logger.error('[finalize_stream error] cleaning up stream:', error);
    });

    logger.info(`[finalize_stream end]: Finalized stream for file: ${file_path}`);
  }

  /**
   * Processes a newly detected file.
   * Only processes MP4 files and checks if they already exist in storage.
   * @param file_path Path to the new file
   */
  private async process_new_file(file_path: string) {
    if (!file_path.endsWith('.mp4')) {
      return;
    }

    logger.info(`Processing new file: ${file_path}`);

    await this.initialize_stream_metadata(file_path).catch((error) => {
      logger.error('Error initializing stream metadata:', error);
    });
  }

  /**
   * Initializes metadata for a new stream.
   * Checks if the file already exists in storage to prevent duplicate processing.
   * @param file_path Path to the file being initialized
   */
  private async initialize_stream_metadata(file_path: string) {
    /**
     * Check does file with this hash already exists in S3.
     * If it does, skip uploading this file.
     */
    const file_hash = await get_file_hash(file_path);

    const exists_in_storage = await minio_object_exists(this.minio_client, this.config.bucket_name, `streams/${file_hash}.json`);

    if (exists_in_storage) {
      this.file_initialized.set(file_path, false);
      logger.info(`File already exists in storage: ${file_path}`);
      return;
    }

    this.file_initialized.set(file_path, true);

    const stream_id = await this.get_stream_id_by_file_path(file_path).then((id) => {
      if (!id) {
        logger.info(`No stream mapping found for file: ${file_path}`);
      }

      return id || uuidv4();
    });

    this.extend_stream_timeout(file_path);

    active_streams.inc();

    logger.info(`Initializing stream metadata for ${stream_id} | ${file_path}`);

    /**
     * Store file path to stream mapping so we can
     * identify which file belongs to which stream
     */
    await this.redis_client.hSet(this.file_mapping_key, file_path, stream_id);
    await this.redis_client.expire(this.file_mapping_key, 24 * 60 * 60);

    const redis_metadata = await this.get_stream_metadata(stream_id).then((metadata) => {
      return metadata || {} as Partial<RedisStreamMetadata>;
    });

    if (redis_metadata.status === 'completed') {
      logger.info(`Stream already completed: ${stream_id} | ${file_path}`);
      return;
    }

    const stats = await fs.promises.stat(file_path);

    const total_chunks = Math.ceil(stats.size / this.config.chunk_size);
    logger.info(`File size: ${stats.size} bytes | Total chunks: ${total_chunks}`);

    const processed_chunks = redis_metadata.chunks?.total || 0;

    const metadata: RedisStreamMetadata = {
      id: stream_id,
      file_path,
      file_size: stats.size,
      created_on: redis_metadata.created_on || Date.now(),
      updated_on: Date.now(),
      status: 'processing',
      chunks: {
        total: processed_chunks,
        items: redis_metadata.chunks?.items || []
      }
    };

    await this.upsert_stream_metadata(stream_id, metadata);

    if (processed_chunks < total_chunks) {
      await this.process_updated_file(file_path);
    }

    logger.info(`Stream metadata initialized`, metadata);
  }

  private async process_updated_file(file_path: string, ignore_last_chunk_size = false) {
    if (!file_path.endsWith('.mp4')) {
      return;
    }

    if (!this.file_initialized.get(file_path)) {
      logger.info(`[process_updated_file] File not initialized: ${file_path}. Skipping...`);
      return;
    }

    logger.info(`[process_updated_file start]: ${file_path}`);

    /**
     * TODO: Implement caching mechanism so we don't query Redis every time
     */
    const stream_id = await this.get_stream_id_by_file_path(file_path);

    if (!stream_id) {
      logger.error(`No stream mapping found for file: ${file_path}`);
      return;
    }

    const metadata = await this.get_stream_metadata(stream_id);

    if (!metadata) {
      logger.error(`No metadata found for stream: ${stream_id}`);
      return;
    }

    if (metadata.status === 'completed') {
      logger.info(`Stream already completed: ${stream_id} | ${file_path}`);
      return;
    }

    const stats = await fs.promises.stat(file_path);

    if (stats.size === 0) {
      logger.info(`File ${file_path} is empty, skipping processing...`);
      return;
    }

    const total_chunks = Math.ceil(stats.size / this.config.chunk_size);
    const processed_chunks = Math.floor(stats.size / this.config.chunk_size);

    if (total_chunks === metadata.chunks.total) {
      logger.info(`All chunks for file ${file_path} are already processed, skipping processing...`);
      return;
    }

    metadata.chunks.total = processed_chunks;
    metadata.file_size = stats.size;
    metadata.updated_on = Date.now();

    await this.upsert_stream_metadata(stream_id, metadata);

    for (let i = metadata.chunks.items.length; i < total_chunks; i++) {
      await this.process_chunk(stream_id, file_path, i, ignore_last_chunk_size && i === total_chunks - 1);
    }

    logger.info(`[process_updated_file end]: ${file_path}`);
  }

  /**
   * Processes a chunk of a video file.
   * Reads the specified chunk from the file and uploads it to MinIO.
   *
   * Process:
   * 1. Create a read stream for the specific chunk
   * 2. Convert stream to buffer
   * 3. Validate chunk size (unless ignored)
   * 4. Upload chunk to MinIO
   *
   * @param stream_id Unique identifier for the stream
   * @param file_path Path to the video file
   * @param chunk_index Index of the chunk to process
   * @param ignore_chunk_size Whether to ignore chunk size validation
   */
  private async process_chunk(stream_id: string, file_path: string, chunk_index: number, ignore_chunk_size = false) {
    logger.info(`Processing chunk: ${chunk_index}`);

    const file_stream = fs.createReadStream(file_path, {
      start: chunk_index * this.config.chunk_size,
      end: (chunk_index + 1) * this.config.chunk_size
    });

    /**
     * Convert file stream to buffer
     */
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      file_stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      file_stream.on('end', () => resolve(Buffer.concat(chunks)));
      file_stream.on('error', (error) => reject(error));
    });

    /**
     * Check buffer size, if less than this.config.chunk_size, skip
     */
    if (!ignore_chunk_size && buffer.length < this.config.chunk_size) {
      logger.info(`Chunk ${chunk_index} is less than ${this.config.chunk_size} bytes, skipping...`);
      return;
    }

    await this.upload_chunk(stream_id, file_path, buffer, chunk_index);
  }

  /**
   * Uploads a chunk to MinIO with retry mechanism for network failures.
   *
   * @param stream_id Unique identifier for the stream
   * @param file_path Path to the video file
   * @param chunk_data Buffer containing the chunk data
   * @param chunk_index Index of the chunk being uploaded
   * @param retry_count Current retry attempt number
   */
  private async upload_chunk_with_retry(
    stream_id: string,
    file_path: string,
    chunk_data: Buffer,
    chunk_index: number,
    retry_count = 0
  ): Promise<void> {
    try {
      const minio_key = `data/${stream_id}/${path.basename(file_path)}.chunk.${chunk_index}`;

      await this.minio_client.putObject(
        this.config.bucket_name,
        minio_key,
        chunk_data,
        chunk_data.length
      );

      logger.info(`Chunk ${chunk_index} uploaded successfully`);
      await this.update_stream_chunk_status(stream_id, chunk_index, 'completed');
    } catch (error) {
      if (retry_count < MAX_RETRIES) {
        /**
         * Increase the delay between retries exponentially
         */
        const delay = RETRY_DELAY * Math.pow(2, retry_count);
        retry_attempts.inc();
        logger.warn(`Upload failed for chunk ${chunk_index}, retrying in ${delay}ms (attempt ${retry_count + 1}/${MAX_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.upload_chunk_with_retry(stream_id, file_path, chunk_data, chunk_index, retry_count + 1);
      } else {
        failed_uploads.inc();
        logger.error(`Failed to upload chunk ${chunk_index} after ${MAX_RETRIES} attempts:`, error);
        await this.update_stream_chunk_status(stream_id, chunk_index, 'failed');
        throw error;
      }
    }
  }

  /**
   * Uploads a chunk to MinIO and updates its status in Redis.
   * Now includes retry mechanism for network failures.
   *
   * Process:
   * 1. Generate MinIO key for the chunk
   * 2. Update chunk metadata in Redis
   * 3. Upload chunk to MinIO with retry mechanism
   * 4. Update chunk status based on upload result
   *
   * @param stream_id Unique identifier for the stream
   * @param file_path Path to the video file
   * @param chunk_data Buffer containing the chunk data
   * @param chunk_index Index of the chunk being uploaded
   */
  private async upload_chunk(stream_id: string, file_path: string, chunk_data: Buffer, chunk_index: number) {
    const metadata_key = `stream:${stream_id}:metadata`;
    const metadata = await this.get_stream_metadata(stream_id);

    if (!metadata) {
      logger.error(`No metadata found for stream: ${stream_id}`);
      return;
    }

    const minio_key = `data/${stream_id}/${path.basename(file_path)}.chunk.${chunk_index}`;

    /**
     * Add chunk to metadata.chunks.items
     */
    metadata.chunks.items[chunk_index] = {
      index: chunk_index,
      size: chunk_data.length,
      hash: crypto.createHash('sha256').update(chunk_data).digest('hex'),
      minio_key,
      status: 'processing',
      created_on: Date.now()
    };

    try {
      await this.redis_client.set(metadata_key, JSON.stringify(metadata));
      await this.redis_client.expire(metadata_key, 24 * 60 * 60);

      await this.upload_chunk_with_retry(stream_id, file_path, chunk_data, chunk_index);
    } catch (error) {
      logger.error(`Error in upload_chunk for chunk ${chunk_index}:`, error);
      await this.update_stream_chunk_status(stream_id, chunk_index, 'failed');
      throw error;
    }
  }

  /**
   * Updates or inserts stream metadata in Redis.
   * Merges new metadata with existing metadata if present.
   *
   * @param stream_id Unique identifier for the stream
   * @param new_metadata New metadata to merge with existing metadata
   */
  private async upsert_stream_metadata(stream_id: string, new_metadata: Partial<RedisStreamMetadata>) {
    const metadata_key = `stream:${stream_id}:metadata`;
    const metadata = await this.get_stream_metadata(stream_id);

    if (!metadata) {
      logger.warn(`No metadata found for stream: ${stream_id}`);
    }

    const updated_metadata = {
      ...(metadata || {}),
      ...(new_metadata || {})
    };

    await this.redis_client.set(metadata_key, JSON.stringify(updated_metadata));
    await this.redis_client.expire(metadata_key, 24 * 60 * 60);
  }

  /**
   * Updates the status of a specific chunk in the stream metadata.
   * Also increments the total chunks uploaded metric.
   *
   * @param stream_id Unique identifier for the stream
   * @param chunk_index Index of the chunk to update
   * @param status New status for the chunk
   */
  private async update_stream_chunk_status(stream_id: string, chunk_index: number, status: RedisStreamChunkStatus) {
    const metadata_key = `stream:${stream_id}:metadata`;
    const metadata = await this.get_stream_metadata(stream_id);

    if (!metadata) {
      logger.error(`No metadata found for stream: ${stream_id}`);
      return;
    }

    if (!metadata.chunks.items[chunk_index]) {
      logger.error(`Chunk ${chunk_index} not found in metadata for stream: ${stream_id}`);
      return;
    }

    metadata.chunks.items[chunk_index].status = status;
    metadata.chunks.items[chunk_index].completed_on = Date.now();

    total_chunks_uploaded.inc();

    await this.redis_client.set(metadata_key, JSON.stringify(metadata));
    await this.redis_client.expire(metadata_key, 24 * 60 * 60);
  }

  /**
   * Retrieves the stream ID associated with a file path from Redis.
   * @param file_path Path to the video file
   * @returns The stream ID if found, null otherwise
   */
  private async get_stream_id_by_file_path(file_path: string) {
    return this.redis_client.hGet(this.file_mapping_key, file_path);
  }

  /**
   * Retrieves the metadata for a stream from Redis.
   * @param stream_id Unique identifier for the stream
   * @returns The stream metadata if found, null otherwise
   */
  private async get_stream_metadata(stream_id: string): Promise<RedisStreamMetadata | null> {
    const metadata_key = `stream:${stream_id}:metadata`;
    const metadata_data = await this.redis_client.get(metadata_key);
    return metadata_data
      ? JSON.parse(metadata_data) as RedisStreamMetadata
      : null;
  }

  /**
   * Initializes the Redis connection with retry mechanism.
   * Must be called before using any Redis functionality.
   */
  private async initialize_redis() {
    let retry_count = 0;
    while (retry_count < MAX_RETRIES) {
      try {
        await this.redis_client.connect();
        logger.info('Connected to Redis');
        return;
      } catch (error) {
        retry_count++;
        if (retry_count === MAX_RETRIES) {
          logger.error('Failed to connect to Redis after maximum retries:', error);
          throw error;
        }
        const delay = RETRY_DELAY * Math.pow(2, retry_count);
        logger.warn(`Redis connection failed, retrying in ${delay}ms (attempt ${retry_count}/${MAX_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Initializes the MinIO connection with retry mechanism.
   * Creates the bucket if it doesn't exist.
   */
  private async initialize_minio() {
    let retry_count = 0;
    while (retry_count < MAX_RETRIES) {
      try {
        const bucket_exists = await this.minio_client.bucketExists(this.config.bucket_name);

        if (!bucket_exists) {
          await this.minio_client.makeBucket(this.config.bucket_name);
          logger.info(`Created bucket: ${this.config.bucket_name}`);
        }
        return;
      } catch (error) {
        retry_count++;
        if (retry_count === MAX_RETRIES) {
          logger.error('Failed to initialize MinIO after maximum retries:', error);
          throw error;
        }
        const delay = RETRY_DELAY * Math.pow(2, retry_count);
        logger.warn(`MinIO initialization failed, retrying in ${delay}ms (attempt ${retry_count}/${MAX_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
}
