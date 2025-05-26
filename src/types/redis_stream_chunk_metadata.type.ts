import {RedisStreamChunkStatus} from './redis_stream_chunk_status.type';

export interface RedisStreamChunkMetadata {
  index: number;
  size: number;
  status: RedisStreamChunkStatus;
  minio_key: string;
  hash: string;
  created_on: number;
  completed_on?: number;
}
