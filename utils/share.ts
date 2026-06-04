
import { trackShare } from './analytics';

const BRAND_TEXT = 'Made with DecodEbook';
const BRAND_URL = 'https://decodebook.app';

export type ShareAction = 'native' | 'copy' | 'download';

export async function shareFile(blob: Blob, filename: string, title?: string): Promise<boolean> {
  try {
    const file = new File([blob], filename, { type: blob.type });

    const fileData: ShareData = {
      title: title || 'DecodEbook',
      text: `${BRAND_TEXT}\n${BRAND_URL}`,
      files: [file],
    };

    if (navigator.canShare?.(fileData)) {
      await navigator.share(fileData);
      trackShare('share_file', { file_type: blob.type, method: 'native', filename });
      return true;
    }

    if (navigator.share) {
      await navigator.share({ title: title || 'DecodEbook', text: BRAND_TEXT, url: BRAND_URL });
      trackShare('share_file', { file_type: blob.type, method: 'native_link', filename });
      return true;
    }
  } catch (e: any) {
    if (e.name === 'AbortError') return false;
  }

  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    trackShare('share_file', { file_type: blob.type, method: 'download', filename });
    return true;
  } catch {
    return false;
  }
}

export async function copyImageToClipboard(blob: Blob): Promise<boolean> {
  try {
    let pngBlob = blob;
    if (blob.type !== 'image/png') {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = reject;
        img.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d')!.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      pngBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(b => b ? resolve(b) : reject(), 'image/png');
      });
    }
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': pngBlob })
    ]);
    return true;
  } catch {
    return false;
  }
}

export function canCopyImages(): boolean {
  return !!navigator.clipboard?.write && !!window.ClipboardItem;
}

export function canNativeShare(): boolean {
  return !!navigator.share;
}

export function canShareFiles(): boolean {
  if (!navigator.canShare) return false;
  try {
    const testFile = new File(['test'], 'test.txt', { type: 'text/plain' });
    return navigator.canShare({ files: [testFile] });
  } catch {
    return false;
  }
}

export function isImageFile(filename: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(filename);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
