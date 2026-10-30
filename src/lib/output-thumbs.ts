/** Fields the grid walker reads. Callers may pass a fuller output row. */
export type ThumbnailableOutput = {
  kind: string;
  url: string;
};

/** One generated still, plus the URL the result grid should display. */
export type ImageGridCell<T extends ThumbnailableOutput> = {
  /** Original image. Open-in-new-tab, lightbox, and download keep `image.url`. */
  image: T;
  /** Grid `<img>` src: the following thumbnail, or the original when none follows. */
  gridUrl: string;
};

/**
 * Walk outputs in array order and pair each image with a grid preview.
 * A thumbnail is used only when it is the immediate next item, and it is
 * never returned as its own cell.
 */
export function pairImageThumbnails<T extends ThumbnailableOutput>(outputs: readonly T[]): ImageGridCell<T>[] {
  const cells: ImageGridCell<T>[] = [];
  for (let index = 0; index < outputs.length; index += 1) {
    const image = outputs[index];
    if (image.kind !== 'image') continue;
    const next = outputs[index + 1];
    cells.push({
      image,
      gridUrl: next?.kind === 'thumbnail' ? next.url : image.url,
    });
  }
  return cells;
}
