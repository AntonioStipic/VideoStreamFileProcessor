import crypto from 'node:crypto';
import fs from 'fs';

export function get_file_hash(file_path: string, algorithm = 'sha256') {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(file_path);

    stream.on('data', (chunk) => {
      hash.update(chunk)
    });
    stream.on('error', (error) => {
      reject(error);
    });
    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
}
