import ffmpeg from 'fluent-ffmpeg';

export function get_video_duration(file_path: string) {
  return new Promise<number | null>((resolve, reject) => {
    ffmpeg.ffprobe(file_path, (error, metadata) => {
      if (error) {
        return reject(error);
      }

      const duration_in_seconds = metadata?.format?.duration || null;
      resolve(duration_in_seconds);
    });
  });
}
