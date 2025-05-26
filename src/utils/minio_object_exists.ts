import {Client as MinioClient} from 'minio';

export async function minio_object_exists(minio_client: MinioClient, bucket_name: string, object_name: string) {
  try {
    await minio_client.statObject(bucket_name, object_name);
    return true;
  } catch (error) {
    if (is_node_error(error)) {
      if (error.code === 'NoSuchKey' || error.code === 'NotFound') {
        return false;
      }
    }

    throw error;
  }
}

function is_node_error(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
