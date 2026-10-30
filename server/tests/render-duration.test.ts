import { describe, expect, it } from 'vitest';
import { renderDuration } from '../src/lib/render-duration.js';

describe('render duration', () => {
  it('keeps a positive duration and a zero image duration', () => {
    expect(renderDuration('image', 0)).toBe(0);
    expect(renderDuration('video', 6)).toBe(6);
    expect(renderDuration('image', '4')).toBe(4);
  });

  it('renders a non-positive video duration as 5 seconds', () => {
    expect(renderDuration('video', 0)).toBe(5);
    expect(renderDuration('video', null)).toBe(5);
    expect(renderDuration('image', null)).toBe(0);
  });
});
