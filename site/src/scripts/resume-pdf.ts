import { jsPDF } from 'jspdf';

export interface Job {
  bullets: string[];
  endDate: string | null;
  location?: string;
  organization: string;
  startDate: string;
  title: string;
}

export interface Education {
  degree: string;
  graduationDate: string;
  institution: string;
}

export interface Certification {
  dateEarned: string;
  issuer: string;
  name: string;
}

export interface ResumeData {
  certifications: Certification[];
  education: Education[];
  jobs: Job[];
  skills: string[];
}

const year = (iso: string) => new Date(iso).getUTCFullYear().toString();

export function buildPdf(data: ResumeData): jsPDF {
  const doc = new jsPDF({ unit: 'pt' });
  const left = 48;
  const right = 547;
  let y = 56;

  const heading = (text: string) => {
    y += 24;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text(text, left, y);
    y += 4;
    doc.setLineWidth(0.5);
    doc.line(left, y, right, y);
    y += 14;
  };

  const body = (text: string, indent = 0) => {
    const lines = doc.splitTextToSize(text, right - left - indent);
    for (const line of lines) {
      if (y > 760) {
        doc.addPage();
        y = 56;
      }
      doc.text(line, left + indent, y);
      y += 14;
    }
  };

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text('Zack Miller', left, y);

  heading('Experience');
  doc.setFontSize(10);
  for (const job of data.jobs) {
    doc.setFont('helvetica', 'bold');
    const dates = `${year(job.startDate)}–${job.endDate ? year(job.endDate) : 'present'}`;
    body(`${job.title} — ${job.organization}${job.location ? ` (${job.location})` : ''} (${dates})`);
    doc.setFont('helvetica', 'normal');
    for (const bullet of job.bullets) {
      body(`• ${bullet}`, 12);
    }
  }

  heading('Education');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  for (const item of data.education) {
    body(`${item.degree} — ${item.institution}, ${year(item.graduationDate)}`);
  }

  if (data.certifications.length > 0) {
    heading('Certifications');
    doc.setFontSize(10);
    for (const cert of data.certifications) {
      body(`${cert.name} — ${cert.issuer}, ${year(cert.dateEarned)}`);
    }
  }

  heading('Skills');
  doc.setFontSize(10);
  body(data.skills.join(', '));

  return doc;
}

const button = document.getElementById('export-pdf');
button?.addEventListener('click', () => {
  const dataEl = document.getElementById('resume-data');
  if (!dataEl?.textContent) return;
  const data = JSON.parse(dataEl.textContent) as ResumeData;
  const doc = buildPdf(data);
  const today = new Date().toISOString().slice(0, 10);
  doc.save(`${today}_zdmiller12-resume.pdf`);
});
