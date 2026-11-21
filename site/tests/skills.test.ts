import { describe, it, expect } from 'vitest';
import { skills } from '../src/data/skills';

describe('skills', () => {
  it('lists at least one non-empty skill', () => {
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      expect(skill.length).toBeGreaterThan(0);
    }
  });
});
