import assert from 'node:assert/strict';
import test from 'node:test';
import { pairImageThumbnails } from './src/lib/output-thumbs.ts';

function output(kind: string, url: string) {
  return { kind, url };
}

test('one image followed by one thumbnail uses the thumbnail only as the grid src', () => {
  const image = output('image', 'https://cdn.example/a.png');
  const thumb = output('thumbnail', 'https://cdn.example/a-thumb.jpg');
  const cells = pairImageThumbnails([image, thumb]);

  assert.equal(cells.length, 1);
  assert.equal(cells[0]?.image, image);
  assert.equal(cells[0]?.image.url, 'https://cdn.example/a.png');
  assert.equal(cells[0]?.gridUrl, 'https://cdn.example/a-thumb.jpg');
});

test('four images alternating with four thumbnails keep each pair in order', () => {
  const outputs = [1, 2, 3, 4].flatMap((n) => [output('image', `img-${n}`), output('thumbnail', `thumb-${n}`)]);
  const cells = pairImageThumbnails(outputs);

  assert.equal(cells.length, 4);
  assert.deepEqual(
    cells.map((cell) => [cell.image.url, cell.gridUrl]),
    [
      ['img-1', 'thumb-1'],
      ['img-2', 'thumb-2'],
      ['img-3', 'thumb-3'],
      ['img-4', 'thumb-4'],
    ],
  );
});

test('images with no thumbnail keep the original url in the grid', () => {
  const outputs = [output('image', 'img-1'), output('image', 'img-2'), output('video', 'clip')];
  const cells = pairImageThumbnails(outputs);

  assert.equal(cells.length, 2);
  assert.deepEqual(
    cells.map((cell) => cell.image.url),
    ['img-1', 'img-2'],
  );
  assert.deepEqual(
    cells.map((cell) => cell.gridUrl),
    ['img-1', 'img-2'],
  );
});

test('a thumbnail that does not immediately follow an image is not a grid cell', () => {
  const outputs = [
    output('thumbnail', 'leading-thumb'),
    output('image', 'img-a'),
    output('poster', 'poster'),
    output('thumbnail', 'poster-thumb'),
    output('image', 'img-b'),
    output('video', 'clip'),
    output('thumbnail', 'video-thumb'),
  ];
  const cells = pairImageThumbnails(outputs);

  assert.equal(cells.length, 2);
  assert.deepEqual(
    cells.map((cell) => cell.image.url),
    ['img-a', 'img-b'],
  );
  assert.deepEqual(
    cells.map((cell) => cell.gridUrl),
    ['img-a', 'img-b'],
  );
});
