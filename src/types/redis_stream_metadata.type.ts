import {RedisStreamChunkStatus} from './redis_stream_chunk_status.type';
import {RedisStreamChunkMetadata} from './redis_stream_chunk_metadata.type';

export interface RedisStreamMetadata {
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
