import { describe, it, expect } from 'vitest';
import { socialLinks } from '../src/data/social-links';

describe('socialLinks', () => {
  it('lists GitHub, LinkedIn, and Email with usable urls', () => {
    expect(socialLinks).toEqual([
      { label: 'GitHub', url: 'https://github.com/zdmiller12' },
      { label: 'iNaturalist', url: 'https://www.inaturalist.org/people/zachary_miller' },
      { label: 'LinkedIn', url: 'https://linkedin.com/in/zdmiller12' },
      { label: 'Thingiverse', url: 'https://www.thingiverse.com/zdmiller12' },
      { label: 'Email', url: 'mailto:zdmiller12@gmail.com' },
    ]);
  });

  it('gives every link a non-empty label and url', () => {
    for (const link of socialLinks) {
      expect(link.label.length).toBeGreaterThan(0);
      expect(link.url.length).toBeGreaterThan(0);
    }
  });
});
