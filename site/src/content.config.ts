import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { projectSchema, photoSchema } from './content/schema';

const projects = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/projects' }),
  schema: projectSchema,
});

const photos = defineCollection({
  loader: glob({ pattern: '**/*.yaml', base: './src/content/photos' }),
  schema: photoSchema,
});

export const collections = { projects, photos };
