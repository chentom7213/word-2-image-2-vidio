// @ts-expect-error vitest runs this file and is not an application dependency.
import { describe, expect, it } from 'vitest';
import { loadCanvasKind, type CanvasAssetCursor } from './canvas-assets.ts';

describe('loadCanvasKind', () => {
  it('只有视频的第一页不会让图片编号停下', async () => {
    const needed = Object.freeze(['image-9']);
    const cursors: Array<CanvasAssetCursor | null> = [];
    const pages = [
      {
        items: [{ id: 'video-1' }, { id: 'video-2' }],
        nextCursor: { createdAt: 't-1', id: 'video-2' },
      },
      {
        items: [{ id: 'image-9' }, { id: 'video-3' }],
        nextCursor: { createdAt: 't-2', id: 'video-3' },
      },
      {
        items: [{ id: 'image-8' }],
        nextCursor: null,
      },
    ];
    const loaded = await loadCanvasKind(needed, async (cursor) => {
      const page = pages[cursors.length];
      cursors.push(cursor);
      if (!page) throw new Error('fetched past the image id');
      return page;
    });

    expect(cursors).toEqual([null, { createdAt: 't-1', id: 'video-2' }]);
    expect(loaded.items.map((item) => item.id)).toEqual(['video-1', 'video-2', 'image-9', 'video-3']);
    expect(loaded.nextCursor).toEqual({ createdAt: 't-2', id: 'video-3' });
    expect(needed).toEqual(['image-9']);
  });

  it('找齐后停', async () => {
    const cursors: Array<CanvasAssetCursor | null> = [];
    const loaded = await loadCanvasKind(['image-1', 'image-2'], async (cursor) => {
      cursors.push(cursor);
      if (cursors.length === 1) {
        return { items: [{ id: 'image-1' }, { id: 'video-1' }], nextCursor: { createdAt: 't-1', id: 'video-1' } };
      }
      if (cursors.length === 2) {
        return {
          items: [{ id: 'image-2' }, { id: 'image-1' }, { id: 'image-4' }],
          nextCursor: { createdAt: 't-2', id: 'image-4' },
        };
      }
      throw new Error('fetched after every needed id was found');
    });

    expect(cursors).toEqual([null, { createdAt: 't-1', id: 'video-1' }]);
    expect(loaded.items.map((item) => item.id)).toEqual(['image-1', 'video-1', 'image-2', 'image-4']);
    expect(loaded.nextCursor).toEqual({ createdAt: 't-2', id: 'image-4' });
  });

  it('没有下一页就停', async () => {
    const cursors: Array<CanvasAssetCursor | null> = [];
    const loaded = await loadCanvasKind(['image-missing'], async (cursor) => {
      cursors.push(cursor);
      if (cursors.length === 1) {
        return { items: [{ id: 'video-1' }], nextCursor: { createdAt: 't-1', id: 'video-1' } };
      }
      return { items: [{ id: 'video-2' }], nextCursor: null };
    });

    expect(cursors).toEqual([null, { createdAt: 't-1', id: 'video-1' }]);
    expect(loaded.items.map((item) => item.id)).toEqual(['video-1', 'video-2']);
    expect(loaded.nextCursor).toBeNull();
  });

  it('第 20 页仍缺编号也停', async () => {
    const cursors: Array<CanvasAssetCursor | null> = [];
    const loaded = await loadCanvasKind(['image-old'], async (cursor) => {
      cursors.push(cursor);
      if (cursors.length > 20) throw new Error('fetched past 20 pages');
      const page = cursors.length;
      return {
        items: [{ id: `video-${page}` }],
        nextCursor: { createdAt: `t-${page}`, id: `video-${page}` },
      };
    });

    expect(cursors).toHaveLength(20);
    expect(cursors[0]).toBeNull();
    for (let index = 1; index < cursors.length; index += 1) {
      expect(cursors[index]).toEqual({ createdAt: `t-${index}`, id: `video-${index}` });
    }
    expect(loaded.items.map((item) => item.id)).toEqual(Array.from({ length: 20 }, (_, index) => `video-${index + 1}`));
    expect(loaded.nextCursor).toEqual({ createdAt: 't-20', id: 'video-20' });
  });

  it('空需求只取一页', async () => {
    const cursors: Array<CanvasAssetCursor | null> = [];
    const loaded = await loadCanvasKind([], async (cursor) => {
      cursors.push(cursor);
      return {
        items: [{ id: 'image-1' }, { id: 'image-1' }],
        nextCursor: { createdAt: 't-1', id: 'image-1' },
      };
    });

    expect(cursors).toEqual([null]);
    expect(loaded.items).toEqual([{ id: 'image-1' }]);
    expect(loaded.nextCursor).toEqual({ createdAt: 't-1', id: 'image-1' });
  });

  it('同一编号只留一次', async () => {
    const first = { id: 'image-1', url: 'first' };
    const later = { id: 'image-1', url: 'later' };
    const target = { id: 'image-2', url: 'target' };
    let calls = 0;
    const loaded = await loadCanvasKind(['image-2'], async () => {
      calls += 1;
      if (calls === 1) return { items: [first, first], nextCursor: { createdAt: 't-1', id: 'image-1' } };
      return { items: [later, target, target], nextCursor: { createdAt: 't-2', id: 'image-2' } };
    });

    expect(calls).toBe(2);
    expect(loaded.items).toEqual([first, target]);
    expect(loaded.nextCursor).toEqual({ createdAt: 't-2', id: 'image-2' });
  });

  it('找齐后仍返回下一页游标', async () => {
    const loaded = await loadCanvasKind(['image-1'], async () => ({
      items: [{ id: 'image-1' }, { id: 'image-3' }],
      nextCursor: { createdAt: 't-9', id: 'image-3' },
    }));

    expect(loaded.items.map((item) => item.id)).toEqual(['image-1', 'image-3']);
    expect(loaded.nextCursor).toEqual({ createdAt: 't-9', id: 'image-3' });
  });

  it('没有下一页时游标是 null', async () => {
    const loaded = await loadCanvasKind(['image-1', 'image-2'], async () => ({
      items: [{ id: 'image-1' }, { id: 'image-2' }],
      nextCursor: null,
    }));

    expect(loaded.items.map((item) => item.id)).toEqual(['image-1', 'image-2']);
    expect(loaded.nextCursor).toBeNull();
  });

  it('空需求的第一页有游标时也返回它', async () => {
    const cursor = { createdAt: 't-4', id: 'video-4' };
    let calls = 0;
    const loaded = await loadCanvasKind([], async () => {
      calls += 1;
      return { items: [{ id: 'video-4' }, { id: 'video-4' }], nextCursor: cursor };
    });

    expect(calls).toBe(1);
    expect(loaded.items).toEqual([{ id: 'video-4' }]);
    expect(loaded.nextCursor).toBe(cursor);
  });
});
