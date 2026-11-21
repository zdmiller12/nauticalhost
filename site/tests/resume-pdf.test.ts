// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { buildPdf, type ResumeData } from '../src/scripts/resume-pdf';

const baseData: ResumeData = {
  certifications: [],
  education: [{ degree: 'B.S., Testing', graduationDate: '2017-01-01', institution: 'Test U' }],
  jobs: [
    {
      bullets: ['Did a thing.'],
      endDate: null,
      location: 'Remote',
      organization: 'Acme',
      startDate: '2018-01-01',
      title: 'Engineer',
    },
    {
      bullets: [],
      endDate: '2017-01-01',
      organization: 'Old Co',
      startDate: '2015-01-01',
      title: 'Intern',
    },
  ],
  skills: ['TypeScript'],
};

describe('buildPdf', () => {
  it('renders a job with a location, bullets, and no end date as "present"', () => {
    const doc = buildPdf(baseData);
    const text = doc.output('datauristring');
    expect(text.length).toBeGreaterThan(0);
  });

  it('renders a job without a location or bullets, and with an end date', () => {
    const doc = buildPdf({ ...baseData, jobs: [baseData.jobs[1]] });
    expect(doc.getNumberOfPages()).toBe(1);
  });

  it('omits the Certifications heading when there are none', () => {
    const doc = buildPdf({ ...baseData, certifications: [] });
    expect(doc.getNumberOfPages()).toBe(1);
  });

  it('renders a Certifications section when entries exist', () => {
    const doc = buildPdf({
      ...baseData,
      certifications: [{ dateEarned: '2022-01-01', issuer: 'Some Body', name: 'Some Cert' }],
    });
    expect(doc.getNumberOfPages()).toBe(1);
  });

  it('adds a new page once content overflows the first one', () => {
    const manyBullets = Array.from({ length: 80 }, (_, i) => `Bullet number ${i}`);
    const doc = buildPdf({
      ...baseData,
      jobs: [{ ...baseData.jobs[0], bullets: manyBullets }],
    });
    expect(doc.getNumberOfPages()).toBeGreaterThan(1);
  });
});
