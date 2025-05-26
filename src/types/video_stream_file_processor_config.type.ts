export interface VideoStreamFileProcessorConfig {
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
