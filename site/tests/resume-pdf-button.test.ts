// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResumeData } from '../src/scripts/resume-pdf';

const instances: { save: ReturnType<typeof vi.fn> }[] = [];

vi.mock('jspdf', () => {
  class FakeDoc {
    save = vi.fn();
    constructor() {
      instances.push(this);
    }
    setFont() {
      return this;
    }
    setFontSize() {
      return this;
    }
    setLineWidth() {
      return this;
    }
    text() {
      return this;
    }
    line() {
      return this;
    }
    splitTextToSize(text: string) {
      return [text];
    }
    addPage() {
      return this;
    }
  }
  return { jsPDF: FakeDoc };
});

const resumeData: ResumeData = {
  certifications: [],
  education: [],
  jobs: [],
  skills: [],
};

describe('export-pdf button wiring', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    instances.length = 0;
    vi.resetModules();
  });

  it('does nothing when the button is missing from the page', async () => {
    await expect(import('../src/scripts/resume-pdf')).resolves.toBeDefined();
    expect(instances).toHaveLength(0);
  });

  it("builds and saves a PDF named with today's date when clicked", async () => {
    document.body.innerHTML = `
      <button id="export-pdf"></button>
      <script type="application/json" id="resume-data">${JSON.stringify(resumeData)}</script>
    `;
    await import('../src/scripts/resume-pdf');

    document.getElementById('export-pdf')!.dispatchEvent(new Event('click'));

    const today = new Date().toISOString().slice(0, 10);
    expect(instances).toHaveLength(1);
    expect(instances[0].save).toHaveBeenCalledWith(`${today}_zdmiller12-resume.pdf`);
  });

  it('does nothing when the resume-data script is missing or empty', async () => {
    document.body.innerHTML = `
      <button id="export-pdf"></button>
      <script type="application/json" id="resume-data"></script>
    `;
    await import('../src/scripts/resume-pdf');

    expect(() => document.getElementById('export-pdf')!.dispatchEvent(new Event('click'))).not.toThrow();
    expect(instances).toHaveLength(0);
  });
});
