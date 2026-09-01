import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { projectSchema } from './schema';

const projects = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/projects' }),
  schema: projectSchema,
});

export const collections = { projects };
