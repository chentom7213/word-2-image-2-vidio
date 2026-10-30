import { describe, expect, it } from 'vitest';
import {
  laneForPriority,
  laneStreamKeys,
  storedQueuePrioritySql,
  streamForLane,
  taskPriorityForPlan,
} from '../src/services/queue-lane.js';

describe('queue lanes', () => {
  it('puts enterprise ahead of pro and free', () => {
    expect(taskPriorityForPlan('enterprise')).toBe(1);
    expect(taskPriorityForPlan('pro')).toBe(3);
    expect(taskPriorityForPlan('free')).toBe(7);
    expect(taskPriorityForPlan('unknown')).toBe(7);
  });

  it('keeps the original stream for the default lane', () => {
    expect(laneForPriority(1)).toBe('high');
    expect(laneForPriority(3)).toBe('default');
    expect(laneForPriority(5)).toBe('default');
    expect(laneForPriority(7)).toBe('low');
    expect(laneForPriority(Number.NaN)).toBe('default');
    expect(streamForLane('gen:tasks', 'default')).toBe('gen:tasks');
    expect(laneStreamKeys('gen:tasks')).toEqual(['gen:tasks:high', 'gen:tasks', 'gen:tasks:low']);
    expect(storedQueuePrioritySql).toBe('COALESCE(priority, 5)');
  });
});
