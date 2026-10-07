import type { Tool } from '../types';
import { bgRemove } from './bgremove';
import { mountBgEditor } from './bgeditor';
import { dotMatrix, pixelArt } from './art';
import { docConvert } from './docs';
import { ebookConvert } from './ebook';
import { fontConvert } from './font';
import { compressJpg, compressPng, imageConvert, vectorConvert } from './image';
import { audioConvert, videoConvert } from './media';
import { pdfCompress, pdfOcr } from './pdf';

// Heavy engines are imported inside each tool's run(), so this list stays light.
export const tools: Tool[] = [
  { ...bgRemove, mount: (root) => mountBgEditor(root, bgRemove) },
  imageConvert, vectorConvert, docConvert, ebookConvert, fontConvert, audioConvert, videoConvert,
  compressPng, compressJpg, pdfCompress, pdfOcr,
  pixelArt, dotMatrix,
];

export const groups = ['Image', 'Convert', 'Optimize', 'Create'];
