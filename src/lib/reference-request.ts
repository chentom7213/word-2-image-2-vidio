const UNUPLOADED_REFERENCE = '参考素材还没上传到素材库';

/** Library rows use a real id and a relative or https address. Previews cannot be submitted. */
export function unuploadedReferenceMessage(refs: { id: string; url: string }[]): string | null {
  const pending = refs.some((ref) => {
    const id = ref.id.trim();
    return id === '' || ref.url.startsWith('blob:') || ref.url.startsWith('data:');
  });
  return pending ? UNUPLOADED_REFERENCE : null;
}
