import { z } from 'zod';

export const projectSchema = z.object({
  title: z.string(),
  description: z.string(),
  githubUrl: z.string().url(),
  demoUrl: z.string().url().optional(),
  tags: z.array(z.string()),
  order: z.number().default(0),
});

export type Project = z.infer<typeof projectSchema>;
