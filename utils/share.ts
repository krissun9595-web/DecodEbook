
const BRAND_TEXT = 'Made with DecodEbook';
const BRAND_URL = 'https://decodebook.app';

export async function shareFile(blob: Blob, filename: string, title?: string): Promise<boolean> {
  try {
    const file = new File([blob], filename, { type: blob.type });

    // Try sharing with file (no url — mixing url+files is unsupported on most browsers)
    const fileData: ShareData = {
      title: title || 'DecodEbook',
      text: `${BRAND_TEXT}\n${BRAND_URL}`,
      files: [file],
    };

    if (navigator.canShare?.(fileData)) {
      await navigator.share(fileData);
      return true;
    }

    // Fallback: share link only
    if (navigator.share) {
      await navigator.share({ title: title || 'DecodEbook', text: BRAND_TEXT, url: BRAND_URL });
      return true;
    }
  } catch (e: any) {
    if (e.name === 'AbortError') return false;
  }

  // Final fallback: trigger download
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
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
