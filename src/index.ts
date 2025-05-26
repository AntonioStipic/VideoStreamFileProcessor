import pino from 'pino';
import {createClient as createRedisClient} from 'redis';
import {Client as MinioClient} from 'minio';
import chokidar from 'chokidar';
import {v4 as uuidv4} from 'uuid';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {get_file_hash} from './utils/get_file_hash';
import {get_video_duration} from './utils/get_video_duration';
import {minio_object_exists} from './utils/minio_object_exists';

type RedisStreamChunkStatus = 'processing' | 'completed' | 'failed';

interface RedisStreamChunkMetadata {
  index: number;
  size: number;
  status: RedisStreamChunkStatus;
  minio_key: string;
  hash: string;
  created_on: number;
  completed_on?: number;
}

interface RedisStreamMetadata {
  id: string;
  file_path: string;
  file_size: number;
  created_on: number;
  updated_on: number;
  completed_on?: number;
  status: RedisStreamChunkStatus;
  chunks: {
    total: number;
    items: RedisStreamChunkMetadata[];
  };
}

const logger = pino({
  transport: {
    target: 'pino-pretty'
  }
});

interface VideoStreamFileProcessorConfig {
  /**
   * @description Directory to watch for video stream files
   * @default 'test_videos'
   */
  watch_directory?: string;
  /**
   * @description Timeout after which the stream is considered finished (in milliseconds)
   * @default 30_000
   */
  stream_timeout?: number;
  /**
   * @description Chunk size in bytes for each chunk of the video stream
   * @default 10 * 1024 * 1024 (10MB)
   */
  chunk_size?: number;
  /**
   * @description S3 bucket name
   */
  bucket_name?: string;
}


export class VideoStreamFileProcessor {
  private redis_client: ReturnType<typeof createRedisClient>;
  private minio_client: MinioClient;
  private config: Required<VideoStreamFileProcessorConfig>;

  private file_stream_timeouts: Map<string, NodeJS.Timeout> = new Map();

  private file_initialized: Map<string, boolean> = new Map();

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

  private extend_stream_timeout(file_path: string) {
    const timeout = this.file_stream_timeouts.get(file_path);

    if (timeout) {
      clearTimeout(timeout);
    }

    this.file_stream_timeouts.set(file_path,
      setTimeout(() => this.finalize_stream(file_path), this.config.stream_timeout)
    );
  }

  private async finalize_stream(file_path: string) {
    await this.process_updated_file(file_path, true);

    const stream_id = await this.get_stream_id_by_file_path(file_path);

    if (!stream_id) {
      logger.info(`[FINAL]: No stream mapping found for file: ${file_path}`);
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

    await Promise.all([
      this.redis_client.hDel(this.file_mapping_key, file_path),
      this.redis_client.del(`stream:${stream_id}:metadata`)
    ]);
  }

  private async process_new_file(file_path: string) {
    if (!file_path.endsWith('.mp4')) {
      return;
    }

    logger.info(`Processing new file: ${file_path}`);

    await this.initialize_stream_metadata(file_path).catch((error) => {
      logger.error('Error initializing stream metadata:', error);
    });
  }

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
      return;
    }

    logger.info(`Processing updated file: ${file_path}`);

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

    logger.info(`Processed updated file: ${file_path}`);
  }

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

  private async upload_chunk(stream_id: string, file_path: string, chunk_data: Buffer, chunk_index: number) {
    const metadata_key = `stream:${stream_id}:metadata`;
    const metadata = await this.get_stream_metadata(stream_id);

    if (!metadata) {
      logger.error(`No metadata found for stream: ${stream_id}`);
      return;
    }

    const minio_key = `data/${stream_id}/${path.basename(file_path)}.chunk.${chunk_index}`

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

    await this.redis_client.set(metadata_key, JSON.stringify(metadata));
    await this.redis_client.expire(metadata_key, 24 * 60 * 60);

    await this.minio_client.putObject(
      this.config.bucket_name,
      minio_key,
      chunk_data,
      chunk_data.length
    ).then(() => {
      logger.info(`Chunk ${chunk_index} uploaded successfully`);

      return this.update_stream_chunk_status(stream_id, chunk_index, 'completed');
    }).catch((error) => {
      logger.error(`Error uploading chunk ${chunk_index}:`, error);

      return this.update_stream_chunk_status(stream_id, chunk_index, 'failed');
    });
  }

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

  private async update_stream_chunk_status(stream_id: string, chunk_index: number, status: RedisStreamChunkStatus) {
    const metadata_key = `stream:${stream_id}:metadata`;
    const metadata = await this.get_stream_metadata(stream_id);

    if (!metadata) {
      logger.error(`No metadata found for stream: ${stream_id}`);
      return;
    }

    metadata.chunks.items[chunk_index].status = status;
    metadata.chunks.items[chunk_index].completed_on = Date.now();

    await this.redis_client.set(metadata_key, JSON.stringify(metadata));
    await this.redis_client.expire(metadata_key, 24 * 60 * 60);
  }

  private async get_stream_id_by_file_path(file_path: string) {
    return this.redis_client.hGet(this.file_mapping_key, file_path);
  }

  private async get_stream_metadata(stream_id: string): Promise<RedisStreamMetadata | null> {
    const metadata_key = `stream:${stream_id}:metadata`;
    const metadata_data = await this.redis_client.get(metadata_key);
    return metadata_data
      ? JSON.parse(metadata_data) as RedisStreamMetadata
      : null;
  }

  private async initialize_redis() {
    await this.redis_client.connect();
    logger.info('Connected to Redis');
  }

  private async initialize_minio() {
    const bucket_exists = await this.minio_client.bucketExists(this.config.bucket_name);

    if (!bucket_exists) {
      await this.minio_client.makeBucket(this.config.bucket_name);
      logger.info(`Created bucket: ${this.config.bucket_name}`);
    }
  }
}

const processor = new VideoStreamFileProcessor({
  watch_directory: 'test_videos',
  stream_timeout: 30_000,
  chunk_size: 128 * 1024
});
processor.start_watching();
