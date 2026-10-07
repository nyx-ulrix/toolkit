import type { Ctx, Tool } from '../types';
import { FFMPEG_CORE } from '../config';
import { rename } from '../ui';

let ffmpeg: Promise<import('@ffmpeg/ffmpeg').FFmpeg> | undefined;

/** One ffmpeg.wasm instance for the whole page; the ~30 MB engine downloads on first use. */
function getFfmpeg(ctx: Ctx) {
  ffmpeg ??= (async () => {
    ctx.progress(0.02, 'Downloading converter engine (first time only)…');
    const [{ FFmpeg }, { toBlobURL }] = await Promise.all([import('@ffmpeg/ffmpeg'), import('@ffmpeg/util')]);
    const ff = new FFmpeg();
    await ff.load({
      coreURL: await toBlobURL(`${FFMPEG_CORE}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${FFMPEG_CORE}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    return ff;
  })().catch((e) => ((ffmpeg = undefined), Promise.reject(e)));
  return ffmpeg;
}

async function transcode(file: File, outExt: string, args: string[], ctx: Ctx, mime: string) {
  const ff = await getFfmpeg(ctx);
  const inName = 'in.' + (file.name.split('.').pop() || 'bin'), outName = 'out.' + outExt;
  const onProgress = ({ progress }: { progress: number }) => ctx.progress(0.1 + Math.min(1, Math.max(0, progress)) * 0.85, 'Converting…');
  ff.on('progress', onProgress);
  try {
    ctx.progress(0.08, 'Loading file…');
    await ff.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
    const code = await ff.exec(['-i', inName, ...args, outName]);
    if (code !== 0) throw new Error('ffmpeg could not convert this file');
    const data = (await ff.readFile(outName)) as Uint8Array;
    return new Blob([data as BlobPart], { type: mime });
  } finally {
    ff.off('progress', onProgress);
    await ff.deleteFile(inName).catch(() => {});
    await ff.deleteFile(outName).catch(() => {});
  }
}

const AUDIO: Record<string, { codec: string[]; mime: string; lossy: boolean }> = {
  mp3: { codec: ['-c:a', 'libmp3lame'], mime: 'audio/mpeg', lossy: true },
  m4a: { codec: ['-c:a', 'aac'], mime: 'audio/mp4', lossy: true },
  ogg: { codec: ['-c:a', 'libvorbis'], mime: 'audio/ogg', lossy: true },
  opus: { codec: ['-c:a', 'libopus'], mime: 'audio/opus', lossy: true },
  wav: { codec: ['-c:a', 'pcm_s16le'], mime: 'audio/wav', lossy: false },
  flac: { codec: ['-c:a', 'flac'], mime: 'audio/flac', lossy: false },
};

export const audioConvert: Tool = {
  id: 'audio-converter', group: 'Convert', title: 'Audio converter',
  desc: 'Convert between MP3, M4A, OGG, Opus, WAV and FLAC. Also pulls the audio out of video files.',
  accept: 'audio/*,video/*,.mp3,.wav,.flac,.ogg,.opus,.m4a,.aac,.wma,.aiff',
  opts: [
    { key: 'format', label: 'Convert to', type: 'select', value: 'mp3', choices: [['mp3', 'MP3'], ['m4a', 'M4A (AAC)'], ['ogg', 'OGG Vorbis'], ['opus', 'Opus'], ['wav', 'WAV'], ['flac', 'FLAC']] },
    { key: 'bitrate', label: 'Bitrate', type: 'select', value: '192', choices: [['96', '96 kbps'], ['128', '128 kbps'], ['192', '192 kbps'], ['256', '256 kbps'], ['320', '320 kbps']], show: (o) => AUDIO[o.format].lossy },
  ],
  async run(file, o, ctx) {
    const a = AUDIO[o.format];
    const args = ['-vn', ...a.codec, ...(a.lossy ? ['-b:a', o.bitrate + 'k'] : [])];
    return [{ name: rename(file.name, o.format), blob: await transcode(file, o.format, args, ctx, a.mime) }];
  },
};

const SIZES: [string, string][] = [['0', 'Original'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['360', '360p']];

export const videoConvert: Tool = {
  id: 'video-converter', group: 'Convert', title: 'Video converter',
  desc: 'Convert between MP4, WebM, MKV, MOV and GIF, and shrink video by quality or resolution.',
  accept: 'video/*,.mp4,.mov,.mkv,.webm,.avi,.flv,.wmv,.gif',
  note: 'Runs on your CPU inside the browser, a few times slower than desktop software, and files over ~1 GB may run out of memory. For big videos use a smaller resolution.',
  opts: [
    { key: 'format', label: 'Convert to', type: 'select', value: 'mp4', choices: [['mp4', 'MP4 (H.264)'], ['webm', 'WebM (VP9)'], ['mkv', 'MKV'], ['mov', 'MOV'], ['gif', 'Animated GIF']] },
    { key: 'quality', label: 'Quality', type: 'select', value: '26', choices: [['20', 'High'], ['26', 'Balanced'], ['32', 'Small file']], show: (o) => o.format !== 'gif' },
    { key: 'height', label: 'Resolution', type: 'select', value: '0', choices: SIZES },
    { key: 'fps', label: 'GIF frames per second', type: 'range', value: 12, min: 5, max: 30, step: 1, show: (o) => o.format === 'gif' },
  ],
  async run(file, o, ctx) {
    const scale = o.height !== '0' ? `scale=-2:${o.height}` : '';
    let args: string[], mime: string;
    if (o.format === 'gif') {
      const vf = [`fps=${o.fps}`, scale || 'scale=480:-1:flags=lanczos'].join(',') + ',split[a][b];[a]palettegen[p];[b][p]paletteuse';
      (args = ['-an', '-vf', vf, '-loop', '0']), (mime = 'image/gif');
    } else if (o.format === 'webm') {
      (args = ['-c:v', 'libvpx-vp9', '-crf', String(Number(o.quality) + 6), '-b:v', '0', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-c:a', 'libopus', ...(scale ? ['-vf', scale] : [])]), (mime = 'video/webm');
    } else {
      (args = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', o.quality, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', ...(o.format === 'mp4' || o.format === 'mov' ? ['-movflags', '+faststart'] : []), ...(scale ? ['-vf', scale] : [])]),
        (mime = o.format === 'mp4' ? 'video/mp4' : o.format === 'mov' ? 'video/quicktime' : 'video/x-matroska');
    }
    return [{ name: rename(file.name, o.format), blob: await transcode(file, o.format, args, ctx, mime) }];
  },
};
