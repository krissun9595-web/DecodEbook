
const BRAND_TEXT = 'Made with DecodEbook';
const BRAND_URL = 'https://decodebook.app';

export async function shareFile(blob: Blob, filename: string, title?: string): Promise<boolean> {
  const file = new File([blob], filename, { type: blob.type });
  const shareData: ShareData = {
    title: title || 'DecodEbook',
    text: BRAND_TEXT,
    url: BRAND_URL,
    files: [file],
  };

  if (navigator.canShare?.(shareData)) {
    await navigator.share(shareData);
    return true;
  }

  if (navigator.share) {
    await navigator.share({ title: title || 'DecodEbook', text: BRAND_TEXT, url: BRAND_URL });
    return true;
  }

  await navigator.clipboard.writeText(`${BRAND_TEXT}\n${BRAND_URL}`);
  return true;
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
