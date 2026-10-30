type StillOutput = {
  kind: string;
  url: string;
  mime?: string | null;
};

export type ReferenceStill = {
  url: string;
  mime: string;
};

function hasUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && url.length > 0;
}

function stillFromOutput(output: StillOutput): ReferenceStill {
  return { url: output.url, mime: typeof output.mime === 'string' ? output.mime : '' };
}

/** 用作参考只取静帧：image，其次 poster，再 posterUrl，最后 thumbnail。 */
export function referenceStill(gen: {
  outputs: readonly StillOutput[];
  posterUrl?: string | null;
}): ReferenceStill | null {
  const outputs = gen.outputs ?? [];
  for (const kind of ['image', 'poster'] as const) {
    const match = outputs.find((output) => output.kind === kind && hasUrl(output.url));
    if (match) return stillFromOutput(match);
  }
  if (hasUrl(gen.posterUrl)) return { url: gen.posterUrl, mime: 'image/jpeg' };
  const thumbnail = outputs.find((output) => output.kind === 'thumbnail' && hasUrl(output.url));
  if (thumbnail) return stillFromOutput(thumbnail);
  return null;
}
